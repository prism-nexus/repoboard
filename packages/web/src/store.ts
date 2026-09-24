/**
 * The store: one plain object, `useSyncExternalStore` on the React side, no redux.
 * Holds what the wire gives us (config, cards, repo, events, connected) plus UI state.
 * Optimistic moves/updates snap back if the server's `card` echo does not arrive in time.
 */
import {
  type BoardConfig,
  blockedReason,
  boardDisplayName,
  type Card,
  type CardPatch,
  type Column,
  type Event,
  type RepoSnapshot,
  rollup,
  type Sibling,
  type Size,
  stepsOf,
} from '@repoboard/core';
import { apiPath, locationForRepo, wsPath } from './repo-key.js';
import type {
  ClientMessage,
  LeasesPayload,
  LogPayload,
  ReposPayload,
  ServerMessage,
  StatePayload,
  SystemsPayload,
  Transport,
  TransportFactory,
} from './wire.js';

export type Theme = 'dark' | 'light';
export type View = 'board' | 'map' | 'flow' | 'dashboard';
/** RCB-98: the Flow view's env switch (plan §3.4); default `'both'`. */
export type FlowEnv = 'dev' | 'prod' | 'both';

export interface Toast {
  id: number;
  text: string;
}

export interface State {
  /** RCB-43 slice 3: this page's own key (`?repo=<key>` at load), or `null` for the primary.
   * Set once from `StoreOptions.repoKey` and never changed — switching repos is a real
   * navigation (`locationForRepo` + `window.location.assign`), not an in-place update. */
  repoKey: string | null;
  /** RCB-43 slice 3: `GET /api/repos`, fetched once when the store starts (`connect()`); `null`
   * until that fetch lands. Feeds the top bar's selector. */
  repos: ReposPayload | null;
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
  /** RCB-98: `.repoboard/systems.yml`, or `null` before the first snapshot (the Flow view's
   * "loading" state — distinct from `exists: false`, which is a real, inert answer). */
  systems: SystemsPayload | null;
  /** RCB-98: the Flow view's env switch (plan §3.4); default `'both'`, not persisted — a fresh
   * load always starts at the safest read of "both stories". */
  flowEnv: FlowEnv;
  events: Event[];
  connected: boolean;
  /** False until the first snapshot; the disconnected banner only shows after that. */
  everConnected: boolean;
  /** RCB-138: true once `UNREACHABLE_AFTER_MS` has elapsed since `connect()` with no snapshot yet
   * (the server never answered at all, as opposed to `everConnected && !connected`, which is a
   * drop after it did). A snapshot always clears it; `connect()` (re)arms the timer. */
  unreachable: boolean;
  fun: boolean;
  theme: Theme;
  view: View;
  selectedId: string | null;
  /** P4.3: cards whose files stay highlighted on the map (click a card's avatar). */
  pinned: string[];
  /** P4.3: the card under the pointer (board or map rail); its files light up on the map. */
  hoverId: string | null;
  toasts: Toast[];
  /** RCB-67: sizes the board is filtered to; empty = show everything (an unconfigured rule is
   * inert, never "nothing"). Does NOT persist across reloads — a card hidden by a stale filter
   * after a reload is a trap. */
  sizeFilter: Size[];
  /** RCB-67: sort order for the un-parented lane. Persists like `theme`. */
  sortBy: SortBy;
}

export type SortBy = 'updated' | 'size';

export interface StoreOptions {
  /** How long to wait for the `card` echo before snapping back (brief: 3 s). */
  echoTimeoutMs?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  prefersDark?: boolean;
  now?: () => number;
  /** RCB-43 slice 3: see `State.repoKey`. Defaults to `null` (today's single-repo behaviour). */
  repoKey?: string | null;
}

export const EVENTS_KEPT = 50;
export const STORAGE_FUN = 'repoboard.fun';
export const STORAGE_THEME = 'repoboard.theme';
export const STORAGE_SORT = 'repoboard.sort';
/** RCB-138: how long `connect()` waits for a first snapshot before showing the "can't reach the
 * server" alert. Exported for the test. */
export const UNREACHABLE_AFTER_MS = 5000;

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
   * RCB-70: append a durable, attributed remark via `POST /api/cards/:id/notes`. Not optimistic,
   * same reasoning as `decideCard`: the drawer shows the result once the request returns, and a
   * failure toasts. Unlike `decideCard`, this resolves to whether it succeeded (`saveColumns`'
   * shape) — never a rejection — so the drawer clears the drafted text on success only and keeps
   * it on failure, for the owner to retry.
   */
  addNote(id: string, text: string, actor: string): Promise<boolean>;
  /**
   * P8.5: the done column's "archive older than 14d" action — `POST /api/archive`. Archived
   * cards disappear from the board via the ordinary `card:removed` broadcast (the server emits
   * it from `archiveCards` exactly like any other removal); this only fires the request and
   * toasts the count.
   */
  archiveDone(): Promise<void>;
  /**
   * RCB-111: the Flow view's "Plan the systems map" confirm — `POST /api/systems/plan`. Shaped
   * like `archiveDone`: toasts on failure with the server's `error`. On success (201) selects the
   * new parent card and switches to the board, so the owner lands on what was just created;
   * never resolves to a rejection.
   */
  planSystemsMap(): Promise<boolean>;
  /**
   * RCB-34/P7.3: `PATCH /api/board` with the WHOLE new column list (a replace, like every list
   * in `CardPatch`). Modelled on `archiveDone`: toasts on failure, and on success does NOT set
   * `config` from the response — the WS `config` broadcast the write triggers is the only thing
   * that updates the board, so the UI shows what the server actually has. Returns whether the
   * request succeeded, so the caller (the column editor) knows whether to close the panel; it
   * never resolves to a rejection.
   */
  saveColumns(columns: Column[]): Promise<boolean>;
  select(id: string | null): void;
  setView(view: View): void;
  /** RCB-98: the Flow view's env switch. */
  setFlowEnv(env: FlowEnv): void;
  togglePin(id: string): void;
  setHover(id: string | null): void;
  setFun(fun: boolean): void;
  setTheme(theme: Theme): void;
  dismissToast(id: number): void;
  /** RCB-67: add/remove one size from the filter. */
  toggleSize(size: Size): void;
  /** RCB-67: back to showing every size. */
  clearSizeFilter(): void;
  /** RCB-67: persists to `STORAGE_SORT`. */
  setSortBy(sortBy: SortBy): void;
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
  const storedSort = storage?.getItem(STORAGE_SORT);
  const repoKey = opts.repoKey ?? null;

  let state: State = {
    repoKey,
    repos: null,
    config: null,
    hasBoard: true,
    cards: [],
    siblings: [],
    repo: null,
    leases: null,
    state: null,
    log: null,
    systems: null,
    flowEnv: 'both',
    events: [],
    connected: false,
    everConnected: false,
    unreachable: false,
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
    sizeFilter: [],
    sortBy: storedSort === 'size' ? 'size' : 'updated',
  };
  const listeners = new Set<Listener>();
  const pending = new Map<string, Pending>();
  const sent: ClientMessage[] = [];
  let transport: Transport | null = null;
  let toastSeq = 0;
  let unreachableTimer: ReturnType<typeof setTimeout> | null = null;

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

  /**
   * RCB-43 slice 3: `GET /api/repos` — always unprefixed, fetched once when the store starts
   * (`connect()`). An unknown `repoKey` (a stale or mistyped `?repo=` in the URL) toasts and
   * navigates to the primary rather than spinning forever — every scoped fetch would 404 and the
   * scoped WS upgrade is destroyed by the server, so there is nothing to wait for.
   */
  const loadRepos = async (): Promise<void> => {
    if (typeof fetch !== 'function') return;
    let res: Response;
    try {
      res = await fetch('/api/repos');
    } catch {
      return;
    }
    if (!res.ok) return;
    const payload = (await res.json()) as ReposPayload;
    set({ repos: payload });
    if (repoKey !== null && !payload.repos.some((r) => r.key === repoKey)) {
      toast(`unknown repo '${repoKey}' — showing ${payload.primary}`);
      if (typeof window !== 'undefined') {
        window.location.assign(locationForRepo(null, payload.primary));
      }
    }
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
            systems: msg.systems ?? null,
            state: msg.state ?? null,
            log: msg.log ?? null,
            everConnected: true,
            unreachable: false,
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
        case 'systems':
          set({ systems: { doc: msg.doc, errors: msg.errors, exists: msg.exists } });
          break;
        case 'state':
          set({ state: msg.state });
          break;
        case 'log':
          set({ log: { date: msg.date, text: msg.text } });
          break;
        case 'error': {
          // RCB-69: a refused card:move/card:update — snap back immediately rather than waiting
          // for the echo timeout, and show the server's own sentence rather than the generic
          // "did not reach disk" toast.
          const p = pending.get(msg.id);
          if (p) {
            settle(msg.id);
            set({ cards: replaceCard(p.before) });
          }
          toast(msg.message);
          break;
        }
        case 'warning':
          // RCB-69: a warned (but allowed) card:move/card:update — the optimistic update already
          // applied and the echo will confirm it; just surface why.
          toast(msg.message);
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
        res = await fetch(apiPath(`/api/cards/${encodeURIComponent(id)}/decide`, repoKey), {
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
    async addNote(id, text, actor) {
      if (typeof fetch !== 'function') return false;
      let res: Response;
      try {
        res = await fetch(apiPath(`/api/cards/${encodeURIComponent(id)}/notes`, repoKey), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, actor }),
        });
      } catch (e) {
        toast(`Note on ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const message =
          body && typeof body === 'object' && 'error' in body ? String(body.error) : res.status;
        toast(`Note on ${id} failed: ${message}`);
        return false;
      }
      const card = (await res.json()) as Card;
      set({ cards: replaceCard(card) });
      return true;
    },
    async archiveDone() {
      if (typeof fetch !== 'function') return;
      let res: Response;
      try {
        res = await fetch(apiPath('/api/archive', repoKey), {
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
    async planSystemsMap() {
      if (typeof fetch !== 'function') return false;
      let res: Response;
      try {
        res = await fetch(apiPath('/api/systems/plan', repoKey), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actor: 'web' }),
        });
      } catch (e) {
        toast(`Plan systems map failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const message =
          body && typeof body === 'object' && 'error' in body ? String(body.error) : res.status;
        toast(`Plan systems map failed: ${message}`);
        return false;
      }
      const data = (await res.json()) as { parent: Card; steps: Card[] };
      toast(`Created ${data.parent.id} + 3 steps`);
      set({ selectedId: data.parent.id, view: 'board' });
      return true;
    },
    async saveColumns(columns) {
      if (typeof fetch !== 'function') return false;
      let res: Response;
      try {
        res = await fetch(apiPath('/api/board', repoKey), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ columns, actor: 'web' }),
        });
      } catch (e) {
        toast(`Save columns failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const message =
          body && typeof body === 'object' && 'error' in body ? String(body.error) : res.status;
        toast(`Save columns failed: ${message}`);
        return false;
      }
      // Success: the write's `config` broadcast will arrive over the WS and update the store —
      // deliberately not read or applied here (see the interface doc comment).
      return true;
    },
    select: (selectedId) => set({ selectedId }),
    setView: (view) => set({ view }),
    setFlowEnv: (flowEnv) => set({ flowEnv }),
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
    toggleSize(size) {
      set({
        sizeFilter: state.sizeFilter.includes(size)
          ? state.sizeFilter.filter((s) => s !== size)
          : [...state.sizeFilter, size],
      });
    },
    clearSizeFilter: () => set({ sizeFilter: [] }),
    setSortBy(sortBy) {
      storage?.setItem(STORAGE_SORT, sortBy);
      set({ sortBy });
    },
    connect() {
      transport?.close();
      if (unreachableTimer !== null) clearTimeout(unreachableTimer);
      unreachableTimer = setTimeout(() => {
        unreachableTimer = null;
        if (!state.everConnected) set({ unreachable: true });
      }, UNREACHABLE_AFTER_MS);
      transport = factory(
        {
          onMessage: (msg) => store.dispatch(msg),
          onConnected: (connected) => set({ connected }),
        },
        wsPath(repoKey),
      );
      void loadRepos();
      return () => {
        if (unreachableTimer !== null) clearTimeout(unreachableTimer);
        unreachableTimer = null;
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

/**
 * RCB-67: `[]` returns `cards` unchanged (same order, every card) — an unconfigured filter is
 * inert, never "nothing". Otherwise only cards whose `size` is in the filter; unsized cards are
 * hidden by any non-empty filter.
 */
export function visibleCards(cards: readonly Card[], sizeFilter: readonly Size[]): Card[] {
  if (sizeFilter.length === 0) return [...cards];
  return cards.filter((c) => c.size !== undefined && sizeFilter.includes(c.size));
}

const SIZE_RANK: Record<Size, number> = { S: 0, M: 1, L: 2, XL: 3 };

/**
 * Columns in config order. `sortBy` (RCB-67, default `'updated'` so every existing caller and
 * test stays byte-identical) orders cards within each column: `'updated'` is today's desc order;
 * `'size'` is S, M, L, XL, then unsized, ties broken by `updated` desc. Unknown statuses get a
 * trailing column.
 */
export function columnsWithCards(
  config: BoardConfig | null,
  cards: Card[],
  sortBy: SortBy = 'updated',
): ColumnCards[] {
  const columns = config?.columns ?? [];
  const byStatus = new Map<string, Card[]>();
  for (const c of cards) {
    const list = byStatus.get(c.status) ?? [];
    list.push(c);
    byStatus.set(c.status, list);
  }
  const byUpdatedDesc = (a: Card, b: Card) => Date.parse(b.updated) - Date.parse(a.updated);
  const sortDesc = (list: Card[]) =>
    sortBy === 'size'
      ? [...list].sort((a, b) => {
          const rank = (c: Card) => (c.size === undefined ? 4 : SIZE_RANK[c.size]);
          return rank(a) - rank(b) || byUpdatedDesc(a, b);
        })
      : [...list].sort(byUpdatedDesc);
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

/**
 * RCB-68: a thin wrap of core's `blockedReason`/`rollup` for `CardItem`'s chips. `null` when the
 * card has none of phase/gate/children — the DOM of such a card is then byte-identical to today
 * (`CardItem` renders nothing extra when `phase` is absent).
 */
export interface PhaseInfo {
  phase: string | null;
  blocked: string | null;
  rollup: { total: number; done: number; blockedOn: string | null } | null;
}

export function phaseInfoFor(
  card: Card,
  cards: readonly Card[],
  config: BoardConfig | null,
): PhaseInfo | null {
  if (!config) return null;
  const phase = card.phase ?? null;
  const blocked = blockedReason(card, cards, config);
  const cardRollup = rollup(card, cards, config);
  if (phase === null && blocked === null && cardRollup === null) return null;
  return { phase, blocked, rollup: cardRollup };
}

/**
 * RCB-68: swimlanes within a column. `parent: null` is always the first lane — either the
 * column's un-parented cards (the common case, in `columnsWithCards`' own updated-desc order,
 * unchanged), or, when nothing in the column HAS a parent, the whole column (the one-lane case
 * `Board.tsx` renders with no `.lane__head` at all — DOM byte-identical to today). Later lanes are
 * one per distinct parent id, in natural id order; a parent not present in `all` (deleted) still
 * gets a lane — `parent: null` there too, distinguished from the first lane by its cards having a
 * `parent` field at all (`Board.tsx` reads the id off `cards[0]`).
 */
export interface Lane {
  parent: Card | null;
  cards: Card[];
}

/** RCB-68: the short text after `blocked on `/`blocked: ` in a `blockedReason` string — used by
 * a short chip (or lane head) whose `title` carries the whole reason. */
export function gateChipText(reason: string): string {
  if (reason.startsWith('blocked on ')) return reason.slice('blocked on '.length);
  if (reason.startsWith('blocked: ')) return reason.slice('blocked: '.length);
  return reason;
}

export function lanesFor(columnCards: Card[], all: readonly Card[]): Lane[] {
  const noParent = columnCards.filter((c) => c.parent === undefined);
  const parentIds = [
    ...new Set(
      columnCards
        .filter((c): c is Card & { parent: string } => c.parent !== undefined)
        .map((c) => c.parent),
    ),
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  if (parentIds.length === 0) return [{ parent: null, cards: noParent }];
  const lanes: Lane[] = [{ parent: null, cards: noParent }];
  for (const parentId of parentIds) {
    const parentCard = all.find((c) => c.id === parentId) ?? null;
    lanes.push({ parent: parentCard, cards: stepsOf(parentId, columnCards) });
  }
  return lanes;
}
