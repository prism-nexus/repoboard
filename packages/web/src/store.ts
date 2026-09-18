/**
 * The store: one plain object, `useSyncExternalStore` on the React side, no redux.
 * Holds what the wire gives us (config, cards, repo, events, connected) plus UI state.
 * Optimistic moves/updates snap back if the server's `card` echo does not arrive in time.
 */
import {
  type BoardConfig,
  boardDisplayName,
  type Card,
  type CardPatch,
  type Event,
  type RepoSnapshot,
  type Sibling,
} from '@repoboard/core';
import type {
  ClientMessage,
  LeasesPayload,
  LogPayload,
  ServerMessage,
  StatePayload,
  Transport,
  TransportFactory,
} from './wire.js';

export type Theme = 'dark' | 'light';
export type View = 'board' | 'map';

export interface Toast {
  id: number;
  text: string;
}

export interface State {
  config: BoardConfig | null;
  /**
   * P7.2: false when the served repo has no `.repoboard/` — map-only. `config` is then the
   * server's default board standing in for one that does not exist, so this flag is the only
   * thing that tells the two apart. True until a snapshot says otherwise.
   */
  hasBoard: boolean;
  cards: Card[];
  /** RCB-42: the merged list of other running boards (board.yml's `siblings:` + this process's
   * `--sibling` flags) — the server already merged it; the store only stores what it is given. */
  siblings: Sibling[];
  repo: RepoSnapshot | null;
  /** P8.2: `.repoboard/leases.yml`, or null before the first snapshot (the Now strip's quiet line). */
  leases: LeasesPayload | null;
  /** P8.3: `.repoboard/STATE.md`, or null before the first snapshot / before it exists. */
  state: StatePayload | null;
  /** P8.3: today's `.repoboard/log/<date>.md`, or null before the first snapshot / before it exists. */
  log: LogPayload | null;
  events: Event[];
  connected: boolean;
  /** False until the first snapshot; the disconnected banner only shows after that. */
  everConnected: boolean;
  fun: boolean;
  theme: Theme;
  view: View;
  selectedId: string | null;
  /** P4.3: cards whose files stay highlighted on the map (click a card's avatar). */
  pinned: string[];
  /** P4.3: the card under the pointer (board or map rail); its files light up on the map. */
  hoverId: string | null;
  toasts: Toast[];
}

export interface StoreOptions {
  /** How long to wait for the `card` echo before snapping back (brief: 3 s). */
  echoTimeoutMs?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  prefersDark?: boolean;
  now?: () => number;
}

export const EVENTS_KEPT = 50;
export const STORAGE_FUN = 'repoboard.fun';
export const STORAGE_THEME = 'repoboard.theme';

type Listener = () => void;

export interface Store {
  getState(): State;
  subscribe(listener: Listener): () => void;
  /** Apply a server message. Exported so tests can drive the store without a socket. */
  dispatch(msg: ServerMessage): void;
  /** Optimistic move + `card:move` on the wire; snaps back without an echo. */
  moveCard(id: string, status: string): void;
  /** Optimistic patch + `card:update` on the wire; snaps back without an echo. */
  updateCard(id: string, patch: CardPatch): void;
  /**
   * P8.1: answer the open decision via `POST /api/cards/:id/decide` (PATCH refuses the field —
   * this is not `updateCard`). Not optimistic: the drawer shows the result once the request
   * returns, and a failure toasts rather than guessing at the new state.
   */
  decideCard(id: string, input: { letter?: string; words?: string }): Promise<void>;
  /**
   * P8.5: the done column's "archive older than 14d" action — `POST /api/archive`. Archived
   * cards disappear from the board via the ordinary `card:removed` broadcast (the server emits
   * it from `archiveCards` exactly like any other removal); this only fires the request and
   * toasts the count.
   */
  archiveDone(): Promise<void>;
  select(id: string | null): void;
  setView(view: View): void;
  togglePin(id: string): void;
  setHover(id: string | null): void;
  setFun(fun: boolean): void;
  setTheme(theme: Theme): void;
  dismissToast(id: number): void;
  /** Open the transport. Returns a disposer. */
  connect(): () => void;
  /** Messages handed to the transport, for tests and debugging. */
  readonly sent: ClientMessage[];
}

interface Pending {
  before: Card;
  timer: ReturnType<typeof setTimeout>;
}

export function createStore(factory: TransportFactory, opts: StoreOptions = {}): Store {
  const echoTimeoutMs = opts.echoTimeoutMs ?? 3000;
  const storage = opts.storage === undefined ? safeLocalStorage() : opts.storage;
  const storedFun = storage?.getItem(STORAGE_FUN);
  const storedTheme = storage?.getItem(STORAGE_THEME);

  let state: State = {
    config: null,
    hasBoard: true,
    cards: [],
    siblings: [],
    repo: null,
    leases: null,
    state: null,
    log: null,
    events: [],
    connected: false,
    everConnected: false,
    fun: storedFun === null || storedFun === undefined ? true : storedFun === '1',
    theme:
      storedTheme === 'light' || storedTheme === 'dark'
        ? storedTheme
        : opts.prefersDark
          ? 'dark'
          : 'light',
    view: 'board',
    selectedId: null,
    pinned: [],
    hoverId: null,
    toasts: [],
  };
  const listeners = new Set<Listener>();
  const pending = new Map<string, Pending>();
  const sent: ClientMessage[] = [];
  let transport: Transport | null = null;
  let toastSeq = 0;

  const set = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };

  const replaceCard = (card: Card) =>
    state.cards.some((c) => c.id === card.id)
      ? state.cards.map((c) => (c.id === card.id ? card : c))
      : [...state.cards, card];

  const toast = (text: string) => {
    const id = ++toastSeq;
    set({ toasts: [...state.toasts, { id, text }] });
    setTimeout(() => store.dismissToast(id), 6000);
  };

  const settle = (id: string) => {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
  };

  /** Apply an optimistic version of `card`, send `msg`, and arm the snap-back timer. */
  const optimistic = (before: Card, after: Card, msg: ClientMessage, what: string) => {
    settle(before.id);
    set({ cards: replaceCard(after) });
    sent.push(msg);
    transport?.send(msg);
    const timer = setTimeout(() => {
      if (!pending.has(before.id)) return;
      pending.delete(before.id);
      set({ cards: replaceCard(before) });
      toast(`${what} of ${before.id} did not reach disk — snapped back`);
    }, echoTimeoutMs);
    pending.set(before.id, { before, timer });
  };

  const store: Store = {
    sent,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(msg) {
      switch (msg.type) {
        case 'snapshot': {
          for (const id of pending.keys()) settle(id);
          const config = msg.board.config;
          // The fun flag comes from config unless the user has chosen in this browser.
          const funFromConfig = (config as { fun?: unknown }).fun !== false;
          const chosen = storage?.getItem(STORAGE_FUN);
          // P7.2: absent means "there is a board" — see wire.ts.
          const hasBoard = msg.board.hasBoard !== false;
          set({
            config,
            hasBoard,
            cards: msg.board.cards,
            siblings: msg.board.siblings ?? [],
            repo: msg.repo,
            leases: msg.leases ?? null,
            state: msg.state ?? null,
            log: msg.log ?? null,
            everConnected: true,
            fun: chosen === null || chosen === undefined ? funFromConfig : chosen === '1',
            // Map is the default tab in map-only mode, but only on the FIRST snapshot: a
            // reconnect must not yank the user off a tab they chose themselves.
            view: !hasBoard && !state.everConnected ? 'map' : state.view,
          });
          applyDocumentTitle(config, msg.repo);
          break;
        }
        case 'config':
          set({ config: msg.config, siblings: msg.siblings ?? state.siblings });
          applyDocumentTitle(msg.config, state.repo);
          break;
        case 'card':
          settle(msg.card.id);
          set({ cards: replaceCard(msg.card) });
          break;
        case 'card:removed':
          settle(msg.id);
          set({
            cards: state.cards.filter((c) => c.id !== msg.id),
            selectedId: state.selectedId === msg.id ? null : state.selectedId,
            pinned: state.pinned.filter((id) => id !== msg.id),
            hoverId: state.hoverId === msg.id ? null : state.hoverId,
          });
          break;
        case 'repo':
          set({ repo: msg.repo });
          break;
        case 'event':
          set({ events: [...state.events, msg.event].slice(-EVENTS_KEPT) });
          break;
        case 'leases':
          set({ leases: msg.leases });
          break;
        case 'state':
          set({ state: msg.state });
          break;
        case 'log':
          set({ log: { date: msg.date, text: msg.text } });
          break;
      }
    },
    moveCard(id, status) {
      const before = state.cards.find((c) => c.id === id);
      if (!before || before.status === status) return;
      const after: Card = {
        ...before,
        status,
        updated: new Date(opts.now?.() ?? Date.now()).toISOString(),
      };
      optimistic(before, after, { type: 'card:move', id, status }, 'Move');
    },
    updateCard(id, patch) {
      const before = state.cards.find((c) => c.id === id);
      if (!before) return;
      const after: Card = { ...before };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete after[k];
        else if (v !== undefined) after[k] = v;
      }
      optimistic(before, after, { type: 'card:update', id, patch }, 'Update');
    },
    async decideCard(id, input) {
      if (typeof fetch !== 'function') return;
      let res: Response;
      try {
        res = await fetch(`/api/cards/${encodeURIComponent(id)}/decide`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...input, actor: 'web' }),
        });
      } catch (e) {
        toast(`Decide of ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const message =
          body && typeof body === 'object' && 'error' in body ? String(body.error) : res.status;
        toast(`Decide of ${id} failed: ${message}`);
        return;
      }
      const card = (await res.json()) as Card;
      set({ cards: replaceCard(card) });
    },
    async archiveDone() {
      if (typeof fetch !== 'function') return;
      let res: Response;
      try {
        res = await fetch('/api/archive', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ olderThan: '14d', actor: 'web' }),
        });
      } catch (e) {
        toast(`Archive failed: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const message =
          body && typeof body === 'object' && 'error' in body ? String(body.error) : res.status;
        toast(`Archive failed: ${message}`);
        return;
      }
      const data = (await res.json()) as { archived: string[] };
      const n = data.archived.length;
      toast(n === 0 ? 'Nothing to archive' : `Archived ${n} card${n === 1 ? '' : 's'}`);
    },
    select: (selectedId) => set({ selectedId }),
    setView: (view) => set({ view }),
    togglePin: (id) =>
      set({
        pinned: state.pinned.includes(id)
          ? state.pinned.filter((p) => p !== id)
          : [...state.pinned, id],
      }),
    setHover(id) {
      if (state.hoverId !== id) set({ hoverId: id });
    },
    setFun(fun) {
      storage?.setItem(STORAGE_FUN, fun ? '1' : '0');
      set({ fun });
    },
    setTheme(theme) {
      storage?.setItem(STORAGE_THEME, theme);
      set({ theme });
    },
    dismissToast: (id) => set({ toasts: state.toasts.filter((t) => t.id !== id) }),
    connect() {
      transport?.close();
      transport = factory({
        onMessage: (msg) => store.dispatch(msg),
        onConnected: (connected) => set({ connected }),
      });
      return () => {
        transport?.close();
        transport = null;
      };
    },
  };
  return store;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * RCB-41: `<name> · repoboard` in the browser tab, once a repo is known. Before any snapshot the
 * title stays `index.html`'s constant (`repoboard`) — this is only ever called from `dispatch`,
 * which only runs after a message has arrived. `repo` is null only in a test dispatching a
 * `config` message with no prior snapshot, which does not happen over the real wire.
 */
function applyDocumentTitle(config: BoardConfig | null, repo: RepoSnapshot | null): void {
  if (!repo) return;
  try {
    if (typeof document === 'undefined') return;
    document.title = `${boardDisplayName(config, repo.root)} · repoboard`;
  } catch {
    // Same defensiveness as safeLocalStorage: a hostile or unusual `document` must not crash dispatch.
  }
}

// ---- selectors --------------------------------------------------------------------------------

export interface ColumnCards {
  id: string;
  title: string;
  active: boolean;
  done: boolean;
  wip: number | undefined;
  /** True for a status seen on a card that board.yml does not configure. */
  unconfigured: boolean;
  cards: Card[];
}

/** Columns in config order, cards sorted by `updated` desc. Unknown statuses get a trailing column. */
export function columnsWithCards(config: BoardConfig | null, cards: Card[]): ColumnCards[] {
  const columns = config?.columns ?? [];
  const byStatus = new Map<string, Card[]>();
  for (const c of cards) {
    const list = byStatus.get(c.status) ?? [];
    list.push(c);
    byStatus.set(c.status, list);
  }
  const sortDesc = (list: Card[]) =>
    [...list].sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
  const out: ColumnCards[] = columns.map((col) => ({
    id: col.id,
    title: col.title ?? col.id,
    active: col.active === true,
    done: col.done === true,
    wip: col.wip,
    unconfigured: false,
    cards: sortDesc(byStatus.get(col.id) ?? []),
  }));
  const known = new Set(columns.map((c) => c.id));
  for (const [status, list] of byStatus) {
    if (known.has(status)) continue;
    out.push({
      id: status,
      title: status,
      active: false,
      done: false,
      wip: undefined,
      unconfigured: true,
      cards: sortDesc(list),
    });
  }
  return out;
}
