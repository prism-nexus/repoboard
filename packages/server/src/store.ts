/**
 * P2.2 Card store. The in-memory map is a cache of `.repoboard/` on disk, never the other way
 * around (D6): every mutation goes through @repoboard/core, is written atomically (tmp + rename),
 * and the chokidar watcher re-reads whatever changes on disk — including our own writes,
 * which it recognises by content hash and does not double-report.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import {
  appendLogLine,
  type BoardConfig,
  type Card,
  type CardPatch,
  type CreateCardInput,
  createCard,
  defaultBoardConfig,
  type Event,
  formatLogLine,
  moveCard,
  parseBoard,
  parseCard,
  serializeCard,
  toIso,
  updateCard,
} from '@repoboard/core';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';

/** One line of `.repoboard/events.jsonl`: core's `Event` (K2). Kept as a name for the package index. */
export type StoreEvent = Event;

/** A card file that failed to parse. Reported, never thrown; the UI shows it red. */
export interface InvalidCard {
  path: string;
  error: string;
}

export interface StoreEvents {
  card: [card: Card];
  'card:removed': [id: string];
  config: [config: BoardConfig];
  invalid: [invalid: InvalidCard[]];
  event: [event: Event];
  warning: [message: string];
}

export interface OpenStoreOptions {
  /** Start the chokidar watcher. CLI one-shots pass false so the process can exit. */
  watch?: boolean;
  /** Clock, for tests. */
  now?: () => Date;
}

export type CreateOutcome = { ok: true; card: Card; event: Event } | { ok: false; error: string };

export type MoveOutcome =
  | { ok: true; card: Card; event: Event; warnings: string[] }
  | { ok: false; error: string; notFound?: boolean };

export type UpdateOutcome =
  | { ok: true; card: Card; event: Event }
  | { ok: false; error: string; notFound?: boolean };

const CARD_FILE = /^[^/\\]+\.md$/;

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Sort `<PREFIX>-<n>` numerically within a prefix, then by id text. */
export function compareCardIds(a: string, b: string): number {
  const ma = /^(.*)-(\d+)$/.exec(a);
  const mb = /^(.*)-(\d+)$/.exec(b);
  if (ma && mb && ma[1] === mb[1]) {
    return Number.parseInt(ma[2] ?? '0', 10) - Number.parseInt(mb[2] ?? '0', 10);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export class CardStore extends EventEmitter<StoreEvents> {
  readonly root: string;
  readonly repoboardDir: string;
  readonly cardsDir: string;
  readonly boardPath: string;
  readonly eventsPath: string;

  private cfg: BoardConfig = defaultBoardConfig();
  private readonly cards = new Map<string, Card>();
  /** Per file: the card id it currently holds (null when invalid) and the content hash. */
  private readonly byPath = new Map<string, { id: string | null; hash: string }>();
  private readonly invalidByPath = new Map<string, InvalidCard>();
  private eventLog: Event[] = [];
  private eventsBytes = 0;
  private watcher: FSWatcher | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  constructor(root: string, opts: OpenStoreOptions = {}) {
    super();
    this.root = resolve(root);
    this.repoboardDir = join(this.root, '.repoboard');
    this.cardsDir = join(this.repoboardDir, 'cards');
    this.boardPath = join(this.repoboardDir, 'board.yml');
    this.eventsPath = join(this.repoboardDir, 'events.jsonl');
    this.now = opts.now ?? (() => new Date());
  }

  get config(): BoardConfig {
    return this.cfg;
  }

  get invalid(): InvalidCard[] {
    return [...this.invalidByPath.values()];
  }

  list(): Card[] {
    return [...this.cards.values()].sort((a, b) => compareCardIds(a.id, b.id));
  }

  get(id: string): Card | undefined {
    return this.cards.get(id);
  }

  filePath(id: string): string {
    return join(this.cardsDir, `${id}.md`);
  }

  /** Events with `ts` strictly after `since` (all events when omitted). */
  events(since?: string): Event[] {
    if (since === undefined) return [...this.eventLog];
    const cutoff = Date.parse(since);
    if (Number.isNaN(cutoff)) return [...this.eventLog];
    return this.eventLog.filter((e) => Date.parse(e.ts) > cutoff);
  }

  // ---- lifecycle ----------------------------------------------------------------------

  /** Read board.yml, every card, and the event log. Then optionally start watching. */
  async load(watch: boolean): Promise<void> {
    await this.loadConfig();
    let names: string[] = [];
    try {
      names = await readdir(this.cardsDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    for (const name of names.sort()) {
      if (CARD_FILE.test(name)) await this.refreshCard(join(this.cardsDir, name), 'load');
    }
    await this.loadEvents(true);
    if (watch) await this.startWatcher();
  }

  async close(): Promise<void> {
    const w = this.watcher;
    this.watcher = null;
    if (w) await w.close();
  }

  // ---- mutations (each one funnels through @repoboard/core and is serialised) ---------------

  /** Never throws on user input (K4): a bad status or title is `{ok:false, error}`. */
  create(input: CreateCardInput, actor: string): Promise<CreateOutcome> {
    return this.enqueue(async () => {
      const existingIds = [
        ...this.cards.keys(),
        ...[...this.invalidByPath.keys()].map((p) => basename(p, '.md')),
      ];
      const res = createCard(input, { existingIds, now: this.now(), config: this.cfg });
      if (!res.ok) return { ok: false, error: res.error };
      const card = res.card;
      const path = this.filePath(card.id);
      if (await exists(path)) {
        return {
          ok: false,
          error: `refusing to overwrite existing file ${relative(this.root, path)}`,
        };
      }
      await this.writeCard(card);
      const event: Event = {
        ts: card.created,
        actor,
        type: 'create',
        cardId: card.id,
        from: null,
        to: card.status,
      };
      await this.appendEvent(event);
      return { ok: true, card, event };
    });
  }

  move(id: string, status: string, actor: string): Promise<MoveOutcome> {
    return this.enqueue(async () => {
      const card = this.cards.get(id);
      if (!card) return { ok: false, error: `unknown card "${id}"`, notFound: true };
      const columnCounts: Record<string, number> = {};
      for (const c of this.cards.values()) {
        if (c.id !== id) columnCounts[c.status] = (columnCounts[c.status] ?? 0) + 1;
      }
      const res = moveCard(card, status, {
        actor,
        now: this.now(),
        config: this.cfg,
        columnCounts,
      });
      if (!res.ok) return { ok: false, error: res.error };
      await this.writeCard(res.card);
      const event: Event = res.event;
      await this.appendEvent(event);
      return { ok: true, card: res.card, event, warnings: res.warnings };
    });
  }

  update(id: string, patch: CardPatch, actor: string): Promise<UpdateOutcome> {
    return this.enqueue(async () => {
      const card = this.cards.get(id);
      if (!card) return { ok: false, error: `unknown card "${id}"`, notFound: true };
      const res = updateCard(card, patch, { actor, now: this.now() });
      if (!res.ok) return { ok: false, error: res.error };
      await this.writeCard(res.card);
      const event: Event = {
        ts: res.card.updated,
        actor,
        type: 'update',
        cardId: id,
        from: card.status,
        to: res.card.status,
      };
      await this.appendEvent(event);
      return { ok: true, card: res.card, event };
    });
  }

  /**
   * Append one `- <ts> <actor> — <text>` bullet under `## Log` and bump `updated`. Unlike
   * `update({body})` this writes exactly one log line. Newlines in `text` collapse to spaces
   * so the bullet stays one line.
   */
  appendLog(id: string, text: string, actor: string): Promise<UpdateOutcome> {
    return this.enqueue(async () => {
      const card = this.cards.get(id);
      if (!card) return { ok: false, error: `unknown card "${id}"`, notFound: true };
      const line = text.replace(/\s+/g, ' ').trim();
      if (line.length === 0) return { ok: false, error: 'text must not be empty' };
      const ts = toIso(this.now());
      const next: Card = {
        ...card,
        updated: ts,
        body: appendLogLine(card.body, formatLogLine(ts, actor, line)),
      };
      await this.writeCard(next);
      const event: Event = {
        ts,
        actor,
        type: 'update',
        cardId: id,
        from: card.status,
        to: card.status,
      };
      await this.appendEvent(event);
      return { ok: true, card: next, event };
    });
  }

  // ---- internals ----------------------------------------------------------------------

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Atomic: write `<file>.tmp`, rename over the target, then update the cache. */
  private async writeCard(card: Card): Promise<void> {
    const path = this.filePath(card.id);
    const text = serializeCard(card);
    await mkdir(this.cardsDir, { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
    this.byPath.set(path, { id: card.id, hash: sha1(text) });
    this.cards.set(card.id, card);
    if (this.invalidByPath.delete(path)) this.emit('invalid', this.invalid);
    this.emit('card', card);
  }

  private async appendEvent(event: Event): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    await mkdir(this.repoboardDir, { recursive: true });
    // Catch up first (K8). `eventsBytes` must be the true file length before we add our own
    // line to it: if another process appended since our last read, `+= line.length` leaves the
    // offset short by exactly that much, and the next read then starts mid-line — dropping the
    // other process's event and re-emitting our own. Measured: a CLI `card move` while `serve`
    // ran emitted ["file","file"] and never the CLI's own event.
    await this.loadEvents();
    await appendFile(this.eventsPath, line, 'utf8');
    this.eventsBytes += Buffer.byteLength(line);
    this.eventLog.push(event);
    this.emit('event', event);
  }

  /**
   * Has some process already said, in `events.jsonl`, that it made this card's current state?
   * Every mutation writes the card and appends an event with `ts === card.updated`
   * (`moveCard`, `updateCard`, `appendLog` and `createCard` all set them from one clock), so
   * `(cardId, ts) === (card.id, card.updated)` identifies that claim exactly.
   *
   * The `updated` comparison is what keeps the guarantee narrow: a claim only counts when
   * `updated` actually moved. Without it, a hand edit of `status:` alone — which by definition
   * leaves `updated` at the value the card's *previous* mutation set, and that mutation's event
   * is still in the log — would be silently swallowed. That path is the product's headline
   * behaviour, so it gets a check that cannot be argued away.
   */
  private isClaimed(card: Card, prevCard: Card | undefined): boolean {
    if (prevCard && prevCard.updated === card.updated) return false;
    return this.eventLog.some((e) => e.cardId === card.id && e.ts === card.updated);
  }

  private async loadConfig(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.boardPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.cfg = defaultBoardConfig();
      return;
    }
    const res = parseBoard(text);
    if (res.ok) {
      this.cfg = res.config;
    } else {
      // Keep the last good config rather than turning the board into nothing.
      this.emit('warning', `${relative(this.root, this.boardPath)}: ${res.error}`);
    }
  }

  /**
   * Read `events.jsonl`. Only the bytes past the last known offset are new (another process,
   * e.g. the CLI, appended them); those are emitted. A shorter file means it was truncated or
   * deleted, so the log is rebuilt from disk without emitting.
   */
  private async loadEvents(initial = false): Promise<void> {
    let buf: Buffer;
    try {
      buf = await readFile(this.eventsPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.eventLog = [];
      this.eventsBytes = 0;
      return;
    }
    if (buf.length >= this.eventsBytes) {
      const added = parseEventLines(buf.subarray(this.eventsBytes).toString('utf8'));
      for (const e of added) {
        this.eventLog.push(e);
        if (!initial) this.emit('event', e);
      }
    } else {
      this.eventLog = parseEventLines(buf.toString('utf8'));
    }
    this.eventsBytes = buf.length;
  }

  /**
   * Re-read one card file from disk and reconcile the cache.
   * `origin: 'watch'` means the change came from outside this store; when the content differs
   * from what we last saw, synthesise an `actor: "file"` event from the status diff.
   */
  private async refreshCard(path: string, origin: 'load' | 'watch'): Promise<void> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.removeCardFile(path);
        return;
      }
      throw e;
    }
    const hash = sha1(text);
    const prev = this.byPath.get(path);
    if (prev && prev.hash === hash) return; // our own write echoing back, or a no-op touch
    const prevCard = prev?.id ? this.cards.get(prev.id) : undefined;

    const res = parseCard(text);
    if (!res.ok) {
      this.byPath.set(path, { id: null, hash });
      if (prev?.id) {
        this.cards.delete(prev.id);
        this.emit('card:removed', prev.id);
      }
      this.invalidByPath.set(path, { path: relative(this.root, path), error: res.error });
      this.emit('invalid', this.invalid);
      return;
    }
    const card = res.card;
    if (prev?.id && prev.id !== card.id) {
      this.cards.delete(prev.id);
      this.emit('card:removed', prev.id);
    }
    this.byPath.set(path, { id: card.id, hash });
    this.cards.set(card.id, card);
    if (this.invalidByPath.delete(path)) this.emit('invalid', this.invalid);
    this.emit('card', card);

    if (origin === 'watch') {
      // Read the log before deciding (K8). Whoever made this change states so in
      // `events.jsonl`; the watcher's own `events.jsonl` task may not have run yet — the
      // ordering of the two chokidar deliveries is not guaranteed, and both orderings were
      // observed. `loadEvents` is offset-based, so running it here and again from the watcher
      // emits nothing twice, and both run on the same serial `enqueue` queue.
      await this.loadEvents();
      if (this.isClaimed(card, prevCard)) return;
      const ts = toIso(this.now());
      const event: Event = prevCard
        ? prevCard.status !== card.status
          ? {
              ts,
              actor: 'file',
              type: 'move',
              cardId: card.id,
              from: prevCard.status,
              to: card.status,
            }
          : {
              ts,
              actor: 'file',
              type: 'update',
              cardId: card.id,
              from: card.status,
              to: card.status,
            }
        : { ts, actor: 'file', type: 'create', cardId: card.id, from: null, to: card.status };
      await this.appendEvent(event);
    }
  }

  private removeCardFile(path: string): void {
    const prev = this.byPath.get(path);
    this.byPath.delete(path);
    if (prev?.id) {
      this.cards.delete(prev.id);
      this.emit('card:removed', prev.id);
    }
    if (this.invalidByPath.delete(path)) this.emit('invalid', this.invalid);
  }

  private async startWatcher(): Promise<void> {
    const watcher = chokidarWatch(this.repoboardDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
      ignored: (p) => p.endsWith('.tmp'),
    });
    this.watcher = watcher;
    watcher.on('all', (event, rawPath) => {
      const path = resolve(rawPath);
      const rel = relative(this.repoboardDir, path).split(sep).join('/');
      const task = (): Promise<void> => {
        if (rel === 'board.yml') {
          return this.loadConfig()
            .then(() => this.emit('config', this.cfg))
            .then(() => undefined);
        }
        if (rel === 'events.jsonl') return this.loadEvents();
        if (/^cards\/[^/]+\.md$/.test(rel)) {
          if (event === 'unlink') {
            this.removeCardFile(path);
            return Promise.resolve();
          }
          if (event === 'add' || event === 'change') return this.refreshCard(path, 'watch');
        }
        return Promise.resolve();
      };
      this.enqueue(task).catch((e: unknown) => {
        this.emit('warning', `watcher: ${rel}: ${(e as Error).message}`);
      });
    });
    watcher.on('error', (e) => this.emit('warning', `watcher: ${(e as Error).message}`));
    await new Promise<void>((res) => watcher.once('ready', () => res()));
  }
}

const EVENT_TYPES: ReadonlySet<string> = new Set(['move', 'update', 'create']);

function parseEventLines(text: string): Event[] {
  const out: Event[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // a corrupt line is skipped, not fatal: the log is optional (§2)
    }
    if (typeof obj !== 'object' || obj === null) continue;
    const o = obj as Record<string, unknown>;
    if (typeof o.ts !== 'string' || typeof o.cardId !== 'string') continue;
    if (typeof o.type !== 'string' || !EVENT_TYPES.has(o.type)) continue;
    out.push({
      ts: o.ts,
      actor: typeof o.actor === 'string' ? o.actor : 'unknown',
      type: o.type as Event['type'],
      cardId: o.cardId,
      from: typeof o.from === 'string' ? o.from : null,
      to: typeof o.to === 'string' ? o.to : '',
    });
  }
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Open the store at `<root>/.repoboard`. Watches by default; pass `{watch:false}` for one-shots. */
export async function openStore(root: string, opts: OpenStoreOptions = {}): Promise<CardStore> {
  const store = new CardStore(root, opts);
  await store.load(opts.watch ?? true);
  return store;
}
