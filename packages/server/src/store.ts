/**
 * P2.2 Card store. The in-memory map is a cache of `.repoboard/` on disk, never the other way
 * around (D6): every mutation goes through @repoboard/core, is written atomically (tmp + rename),
 * and the chokidar watcher re-reads whatever changes on disk — including our own writes,
 * which it recognises by content hash and does not double-report.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  type AddWindowInput,
  addNote as addNoteCore,
  addWindow,
  appendLogBlock,
  appendLogLine,
  askDecision,
  type BoardConfig,
  type Card,
  type CardPatch,
  type CheckResourceResult,
  type Column,
  type CostReport,
  type CreateCardInput,
  checkFieldCounts,
  checkFindings,
  checkResource,
  closeSyncedCard,
  createCard,
  DEFAULT_CLAUDE_MD_BUDGET_BYTES,
  type DecisionOption,
  dailyLogHeader,
  decide as decideCard,
  defaultBoardConfig,
  type Event,
  exitCodeForFindings,
  type Finding,
  findSeatLine,
  formatLogBlock,
  formatLogLine,
  formatSeatBullet,
  initialStateText,
  type LeaseMutationResult,
  type LeasesDoc,
  type LogBlock,
  type LogFileInfo,
  lastBlockFor,
  moveCard,
  parseBoard,
  parseCard,
  parseLeases,
  parseLogBlocks,
  parseSeatStamp,
  parseState,
  parseSystems,
  pruneWindows,
  type ReleaseLeaseInput,
  releaseLease,
  replaceSeatBullet,
  rewriteSeatBulletBody,
  type SeatBundle,
  type StateDoc,
  type StateSectionName,
  type SystemsDoc,
  seatBulletTexts,
  seatBundle as seatBundleCore,
  selectArchivable as selectArchivableCore,
  serializeBoard,
  serializeCard,
  serializeLeases,
  setStateSection as setStateSectionCore,
  staleDetected,
  systemsSummary,
  type TakeLeaseInput,
  takeLease,
  toIso,
  updateCard,
  wipCountsForMove,
} from '@repoboard/core';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { type ArchiveMoveMethod, archiveMoveFile } from './archive.js';
import { gatherCost } from './cost.js';
import { withFileLock } from './file-lock.js';
import { localDir, localStatus } from './local.js';
import { detectSystems } from './systems-detect.js';

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
  /** P8.2: `.repoboard/leases.yml` changed, by a mutation here or by an external edit. */
  leases: [doc: LeasesDoc];
  /** P8.3: `.repoboard/STATE.md` changed, by a mutation here or by an external edit. */
  state: [doc: StateDoc | null];
  /** P8.3: a `.repoboard/log/<date>.md` file changed — an append here, or an external edit. */
  log: [payload: { date: string; text: string }];
  /** RCB-97: `.repoboard/systems.yml` changed — an external edit or its creation/removal. */
  systems: [payload: { doc: SystemsDoc | null; errors: string[]; exists: boolean }];
}

export interface OpenStoreOptions {
  /** Start the chokidar watcher. CLI one-shots pass false so the process can exit. */
  watch?: boolean;
  /** Clock, for tests. */
  now?: () => Date;
  /**
   * K8: a writer touches a card file, then appends its `events.jsonl` claim — two separate
   * writes, not one. When the watcher's `refreshCard('watch')` sees the file change before the
   * claim lands (the gap can exceed chokidar's own 100ms `awaitWriteFinish`), synthesising a
   * `file` event right away produces two entries for one mutation (K8). This is how long the
   * watcher waits, after an `updated` timestamp moves, for that claim to show up before it gives
   * up and synthesises one itself. Default `1000`ms. `0` reproduces today's un-graced behaviour
   * exactly (the control) — a hand edit that leaves `updated` unchanged is never delayed, grace
   * or not (see `refreshCard`).
   */
  claimGraceMs?: number;
}

/**
 * K10: `readOnly` marks the one refusal that is not about the request at all — the served root
 * has no `.repoboard/`, so there is nothing to write to and repoboard will not invent one. HTTP
 * maps it to 409; every other `{ok:false}` keeps the status it had.
 */
export type CreateOutcome =
  | { ok: true; card: Card; event: Event }
  | { ok: false; error: string; readOnly?: boolean };

export type MoveOutcome =
  | { ok: true; card: Card; event: Event; warnings: string[] }
  | { ok: false; error: string; notFound?: boolean; readOnly?: boolean };

export type UpdateOutcome =
  | { ok: true; card: Card; event: Event }
  | { ok: false; error: string; notFound?: boolean; readOnly?: boolean };

/** P8.1: `ask` input. `options` may be empty (a yes/no or free-text question). */
export interface AskInput {
  question: string;
  options?: DecisionOption[];
  replace?: boolean;
  /** RCB-52: an owner WORK item, same queue. Must have no options. */
  kind?: 'task';
}

/** P8.1: `decide` input. At least one of `letter`/`words` is required (enforced by core). */
export interface DecideInput {
  letter?: string;
  words?: string;
}

export type AskOutcome =
  | { ok: true; card: Card; event: Event; warnings: string[] }
  | { ok: false; error: string; notFound?: boolean; readOnly?: boolean };

export type DecideOutcome =
  | { ok: true; card: Card; event: Event; warnings: string[] }
  | { ok: false; error: string; notFound?: boolean; readOnly?: boolean };

/** P8.5: `store.closeSynced` outcome (`sync-issues`'s own close, custom log line). */
export type CloseSyncedOutcome =
  | { ok: true; card: Card; event: Event; warnings: string[] }
  | { ok: false; error: string; notFound?: boolean; readOnly?: boolean };

/** P8.5: `store.archiveCards` outcome. `method` is which OS-level move each archived id used. */
export type ArchiveOutcome =
  | { ok: true; archived: string[]; method: Record<string, ArchiveMoveMethod> }
  | { ok: false; error: string; readOnly?: boolean };

/** P8.2: `takeLease`/`releaseLease`/`addWindow` outcomes. `readOnly` is the map-only refusal (K10). */
export type LeaseOutcome =
  | { ok: true; doc: LeasesDoc; event: Event; warnings: string[] }
  | { ok: false; error: string; readOnly?: boolean };

/** P8.3: `setStateSection` outcome. */
export type SetStateOutcome =
  | { ok: true; doc: StateDoc; text: string }
  | { ok: false; error: string; readOnly?: boolean };

/** RCB-88: `updateSeatBullet` outcome — `SetStateOutcome`'s ok branch plus the rewrite's own
 * `status`/`stamp` (the ones KEPT, not restamped), so the CLI can echo them without re-parsing
 * the bullet it just got back. */
export type UpdateSeatOutcome =
  | { ok: true; doc: StateDoc; text: string; status: 'UP' | 'DOWN'; stamp: string }
  | { ok: false; error: string; readOnly?: boolean };

/**
 * RCB-34/P7.3: `setColumns` outcome. `config` is the board config exactly as re-parsed from the
 * file just written (`parseBoard(serializeBoard(next))`'s result), the same object `GET /api/board`
 * would now return — not merely the request's columns echoed back.
 */
export type SetColumnsOutcome =
  | { ok: true; config: BoardConfig }
  | { ok: false; error: string; readOnly?: boolean };

/** P8.3: `appendRepoLog` outcome. */
export type AppendRepoLogOutcome =
  | { ok: true; date: string; text: string; block: LogBlock }
  | { ok: false; error: string; readOnly?: boolean };

/** RCB-127: `appendSeatLog` outcome — `AppendRepoLogOutcome`'s ok branch plus whether STATE.md
 * got restamped (only when `seat` had an UP bullet in SEATS at the moment of the call). */
export type AppendSeatLogOutcome =
  | { ok: true; date: string; text: string; block: LogBlock; restamped: boolean }
  | { ok: false; error: string; readOnly?: boolean };

/** RCB-132: `state --trim-landings --archive <path>` outcome — `path` is relative to `root`. */
export type AppendArchiveOutcome =
  | { ok: true; path: string; block: LogBlock }
  | { ok: false; error: string; readOnly?: boolean };

/** P8.3: one `.repoboard/log/<date>.md` file, read fresh from disk (never cached). */
export interface LogFile {
  date: string;
  text: string;
  blocks: LogBlock[];
}

/** P8.3: `repoboard check`'s result — the store gathers the facts, core's `checkFindings` decides. */
export interface CheckOutcome {
  findings: Finding[];
  exitCode: 0 | 1;
}

/** The refusal text, in one place: the CLI, HTTP and MCP all surface this string. */
export const MAP_ONLY_ERROR =
  'this repo has no .repoboard/ — repoboard is serving it map-only and will not create one. ' +
  'Run `repoboard init` in it yourself, then restart the server.';

/**
 * Thrown by `writeCard`/`appendEvent` when the served root has no board, and converted to
 * `{ok:false, error, readOnly:true}` by `mutate`. It is an exception rather than a return value
 * on purpose: the two functions it guards are the *only* way a byte of this store reaches disk,
 * they return `void`, and a fifth mutating method added later cannot write without going through
 * one of them. A check the caller has to remember is a check the caller eventually forgets.
 */
export class MapOnlyError extends Error {
  constructor() {
    super(MAP_ONLY_ERROR);
    this.name = 'MapOnlyError';
  }
}

const CARD_FILE = /^[^/\\]+\.md$/;

/** RCB-132: `appendArchiveText`'s header, written once, the first time `<path>` is created. */
const ARCHIVE_HEADER = '# LAST LANDINGS archive';

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * RCB-133: `<file>.<pid>.<random>.tmp`, not a fixed `<file>.tmp` — `writeLeases`/`writeState` now
 * run under a cross-process file lock, but the tmp file itself is written BEFORE the atomic
 * rename, so a name shared by every writer (same pid across restarts, or any writer that reaches
 * this path outside the lock) is still one collision waiting to happen. Cheap insurance, not a
 * second lock.
 */
function tmpName(target: string): string {
  return `${target}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
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
  readonly leasesPath: string;
  /** RCB-97: `.repoboard/systems.yml`. */
  readonly systemsPath: string;
  /** RCB-83: `local/STATE.md` when `.repoboard/local/` exists, else `.repoboard/STATE.md` — set
   * in `load()`, so not ctor-`readonly` (see `hasLocalLayer`). */
  statePath: string;
  /** RCB-71 A: the WRITE target — `board.yml`'s `logDir` (resolved against `this.root`) when
   * set, else `local/log/` when `.repoboard/local/` exists, else `.repoboard/log/`. Computed by
   * `resolveLogDir()`, which needs `this.cfg`, so this is set AFTER `loadConfig()`, not in the
   * constructor. Reads merge more sources; see `logReadDirs`. */
  logDir: string;

  private cfg: BoardConfig = defaultBoardConfig();
  private leasesDoc: LeasesDoc = { leases: [], windows: [] };
  private stateDoc: StateDoc | null = null;
  /** RCB-97: `.repoboard/systems.yml`'s parsed doc, `null` when absent OR invalid — an invalid
   * file is `doc: null` + `systemsErrors`, never the last good doc (unlike `leasesDoc`): `check`
   * must see the breakage, not a stale copy. */
  private systemsDoc: SystemsDoc | null = null;
  private systemsErrors: string[] = [];
  private systemsExists = false;
  private board = false;
  private readonly cards = new Map<string, Card>();
  /** Per file: the card id it currently holds (null when invalid) and the content hash. */
  private readonly byPath = new Map<string, { id: string | null; hash: string }>();
  private readonly invalidByPath = new Map<string, InvalidCard>();
  /**
   * RCB-34/P7.3: the content hash of `board.yml` as last read or written, the same idea as
   * `byPath` for cards — lets `loadConfig` tell "our own write echoing back through the watcher"
   * (hash unchanged) from a real external edit (hash changed), so `setColumns` emits `config`
   * exactly once per write instead of once directly and again when the watcher notices the
   * rename.
   */
  private boardHash: string | null = null;
  private eventLog: Event[] = [];
  private eventsBytes = 0;
  private watcher: FSWatcher | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  /** K8: how long `refreshCard`'s watch branch waits for a writer's own claim before synthesising
   * one itself — see `OpenStoreOptions.claimGraceMs`. */
  private readonly claimGraceMs: number;
  /**
   * K8: one outstanding grace timer per (card id, `updated`) pair, keyed by `${id}\0${updated}` —
   * NOT by id alone. Two watch events for the same card in quick succession (RB-1 todo→doing,
   * then RB-1 doing→review before the first's grace fires) are two distinct claims to wait for;
   * keying by id alone and cancelling the older timer would drop the first mutation's event
   * entirely whenever it was never claimed — an undercount, and a K8 break in the other
   * direction. Each entry checks only its own `updated` on fire (see `schedulePendingClaim`), so
   * entries never need to interact with one another. Cleared entirely by `close()`.
   */
  private readonly pendingClaims = new Map<
    string,
    { updated: string; event: Omit<Event, 'ts'>; timer: ReturnType<typeof setTimeout> }
  >();
  /** RCB-83: does `.repoboard/local/` exist? Decided once, in `load()` — see `hasBoard`'s own
   * doc comment for why this is not re-derived while the server runs. */
  private hasLocalLayer = false;
  /** RCB-93: does `.repoboard/local/log/` exist? Precomputed once in `load()` (alongside
   * `hasLocalLayer`) so `resolveLogDir()` can stay synchronous — see its own doc comment. */
  private hasLocalLog = false;

  constructor(root: string, opts: OpenStoreOptions = {}) {
    super();
    this.root = resolve(root);
    this.repoboardDir = join(this.root, '.repoboard');
    this.cardsDir = join(this.repoboardDir, 'cards');
    this.boardPath = join(this.repoboardDir, 'board.yml');
    this.eventsPath = join(this.repoboardDir, 'events.jsonl');
    this.leasesPath = join(this.repoboardDir, 'leases.yml');
    this.systemsPath = join(this.repoboardDir, 'systems.yml');
    this.statePath = join(this.repoboardDir, 'STATE.md');
    this.logDir = join(this.repoboardDir, 'log');
    this.now = opts.now ?? (() => new Date());
    this.claimGraceMs = opts.claimGraceMs ?? 1000;
  }

  get config(): BoardConfig {
    return this.cfg;
  }

  /**
   * P7.2: does this root actually have a `.repoboard/` directory? False means map-only — the
   * config above is `defaultBoardConfig()` standing in for a board that does not exist, and
   * nothing distinguishes it from a real board with the default columns. Read from disk in
   * `load()`, the one code path every store goes through, so no caller can forget to set it.
   *
   * Deliberately NOT re-derived while the server runs (plan §5 P7.2, brief §3): a `.repoboard/`
   * that appears later needs a restart, and the UI says so.
   */
  get hasBoard(): boolean {
    return this.board;
  }

  /** P8.3: the store's own clock — the real one, or a test's override. HTTP's "today" fallback. */
  get clock(): Date {
    return this.now();
  }

  get invalid(): InvalidCard[] {
    return [...this.invalidByPath.values()];
  }

  /**
   * P8.2: the current `.repoboard/leases.yml` doc. A read, never a write — windows are pruned
   * only on the next mutation (locked decision 2), so a leftover expired window can still show up
   * here between mutations; that is the documented behaviour, not a bug.
   */
  leases(): LeasesDoc {
    return this.leasesDoc;
  }

  /**
   * RCB-97 (plan §3.3): the current `.repoboard/systems.yml` — `exists: false` means no such
   * file (`doc: null`, `errors: []`, inert per §3.1); `exists: true` with `doc: null` means the
   * file is there but failed to parse (`errors` non-empty) — worse than none, never the last
   * good doc.
   */
  systems(): { doc: SystemsDoc | null; errors: string[]; exists: boolean } {
    return { doc: this.systemsDoc, errors: this.systemsErrors, exists: this.systemsExists };
  }

  /** P8.3: the current parsed `.repoboard/STATE.md`, or `null` when it does not exist. */
  state(): StateDoc | null {
    return this.stateDoc;
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
    this.board = await isDirectory(this.repoboardDir);
    // RCB-93: the record lives where it already is — the local layer OWNS STATE.md/log only when
    // the top level has none. Existence, never git: the store makes no git calls, so a tracked
    // top-level file reads exactly like an untracked one, and only the DIRECTORY's presence plus
    // the top-level file's absence redirects to `local/`. Reads still merge the old location too
    // (see `logReadDirs`); no local dir at all is byte-for-byte today's behaviour.
    this.hasLocalLayer = await isDirectory(localDir(this.root));
    const topStateExists = await exists(join(this.repoboardDir, 'STATE.md'));
    this.statePath =
      this.hasLocalLayer && !topStateExists
        ? join(localDir(this.root), 'STATE.md')
        : join(this.repoboardDir, 'STATE.md');
    this.hasLocalLog = this.hasLocalLayer && (await isDirectory(join(localDir(this.root), 'log')));
    // RCB-71 A: `resolveLogDir()` reads `this.cfg`, so this must come AFTER `loadConfig()`.
    await this.loadConfig();
    this.logDir = this.resolveLogDir();
    await this.loadLeases();
    await this.loadSystems();
    await this.loadState();
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
    // K8: cancel every outstanding grace timer first — none may fire (and so emit or append)
    // once close() has been called.
    for (const pending of this.pendingClaims.values()) clearTimeout(pending.timer);
    this.pendingClaims.clear();
    const w = this.watcher;
    this.watcher = null;
    if (w) await w.close();
  }

  // ---- mutations (each one funnels through @repoboard/core and is serialised) ---------------

  /** Never throws on user input (K4): a bad status or title is `{ok:false, error}`. */
  create(input: CreateCardInput, actor: string): Promise<CreateOutcome> {
    return this.mutate(async () => {
      const existingIds = [
        ...this.cards.keys(),
        ...[...this.invalidByPath.keys()].map((p) => basename(p, '.md')),
      ];
      const res = createCard(input, { existingIds, now: this.now(), config: this.cfg });
      if (!res.ok) return { ok: false, error: res.error };
      const card = res.card;
      const parentCheck = this.checkParent(card.parent);
      if (!parentCheck.ok) return { ok: false, error: parentCheck.error };
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
    return this.mutate(async () => {
      const card = this.cards.get(id);
      if (!card) return { ok: false, error: `unknown card "${id}"`, notFound: true };
      // RCB-108: `undefined` when `card` is itself an uncounted plan parent (it adds 0 to any
      // column, so it cannot breach a limit) — else per-status counts over every other card.
      const columnCounts = wipCountsForMove(card, [...this.cards.values()]);
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
    return this.mutate(async () => {
      const card = this.cards.get(id);
      if (!card) return { ok: false, error: `unknown card "${id}"`, notFound: true };
      const parentCheck = this.checkParent(patch.parent);
      if (!parentCheck.ok) return { ok: false, error: parentCheck.error };
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
   * P8.1: open a decision on a card, or replace one already open (`--replace`). O11: when the
   * board has a `decision: true` column, this also moves the card there through core's
   * `askDecision` (same funnel: one write, one event, computed the same way `move` computes
   * `columnCounts` for the WIP check).
   */
  ask(id: string, input: AskInput, actor: string): Promise<AskOutcome> {
    return this.mutate(async () => {
      const card = this.cards.get(id);
      if (!card) return { ok: false, error: `unknown card "${id}"`, notFound: true };
      // RCB-108: `undefined` when `card` is itself an uncounted plan parent (it adds 0 to any
      // column, so it cannot breach a limit) — else per-status counts over every other card.
      const columnCounts = wipCountsForMove(card, [...this.cards.values()]);
      const res = askDecision(card, {
        question: input.question,
        options: input.options,
        replace: input.replace,
        kind: input.kind,
        actor,
        now: this.now(),
        config: this.cfg,
        columnCounts,
      });
      if (!res.ok) return { ok: false, error: res.error };
      await this.writeCard(res.card);
      await this.appendEvent(res.event);
      return { ok: true, card: res.card, event: res.event, warnings: res.warnings };
    });
  }

  /**
   * P8.1: answer the open decision. O11: when it recorded a `returnTo` column that still
   * exists, this moves the card back through core's `decide`, same funnel as `ask`/`move`.
   */
  decide(id: string, input: DecideInput, actor: string): Promise<DecideOutcome> {
    return this.mutate(async () => {
      const card = this.cards.get(id);
      if (!card) return { ok: false, error: `unknown card "${id}"`, notFound: true };
      // RCB-108: `undefined` when `card` is itself an uncounted plan parent (it adds 0 to any
      // column, so it cannot breach a limit) — else per-status counts over every other card.
      const columnCounts = wipCountsForMove(card, [...this.cards.values()]);
      const res = decideCard(card, {
        letter: input.letter,
        words: input.words,
        actor,
        now: this.now(),
        config: this.cfg,
        columnCounts,
      });
      if (!res.ok) return { ok: false, error: res.error };
      await this.writeCard(res.card);
      await this.appendEvent(res.event);
      return { ok: true, card: res.card, event: res.event, warnings: res.warnings };
    });
  }

  /**
   * P8.2: take a resource, or renew it (same holder), or refuse/force past another holder's live
   * lease (`releaseLease` and `addWindow` follow the same shape). Every successful mutation prunes
   * expired windows before writing (locked decision 2: prune on write, never on read).
   */
  takeLease(input: TakeLeaseInput, actor: string): Promise<LeaseOutcome> {
    return this.mutateLeases((doc, now) => takeLease(doc, input, { actor, now }));
  }

  releaseLease(input: ReleaseLeaseInput, actor: string): Promise<LeaseOutcome> {
    return this.mutateLeases((doc, now) => releaseLease(doc, input, { actor, now }));
  }

  addWindow(input: AddWindowInput, actor: string): Promise<LeaseOutcome> {
    return this.mutateLeases((doc, now) => addWindow(doc, input, { actor, now }));
  }

  /** P8.2: pure read of the in-memory doc — no write, so it works in map-only mode too. */
  checkResource(resource: string, at?: Date): CheckResourceResult {
    return checkResource(this.leasesDoc, resource, at ?? this.now());
  }

  /**
   * P8.4: read-only (`gatherCost` only `stat`/`readFile`s), so it works in map-only mode too.
   * `budget` overrides board.yml's `claudeMdBudgetBytes`, which overrides
   * `DEFAULT_CLAUDE_MD_BUDGET_BYTES` — the same precedence the CLI flag documents.
   */
  cost(budget?: number): Promise<CostReport> {
    return gatherCost(
      this.root,
      budget ?? this.cfg.claudeMdBudgetBytes ?? DEFAULT_CLAUDE_MD_BUDGET_BYTES,
    );
  }

  /**
   * P8.3: replace one STATE.md section and restamp. A missing STATE.md is scaffolded fresh first
   * (`initialStateText`) rather than refused — a hand-deleted STATE.md should not brick the one
   * command that rewrites it.
   */
  setStateSection(
    section: StateSectionName,
    body: string,
    actor: string,
  ): Promise<SetStateOutcome> {
    return this.mutate(async () => {
      this.refuseWriteWithoutBoard();
      return withFileLock(this.statePath, async () => {
        let text: string;
        try {
          text = await readFile(this.statePath, 'utf8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          text = initialStateText({ now: this.now(), actor });
        }
        const res = setStateSectionCore(text, section, body, { now: this.now(), actor });
        if (!res.ok) return { ok: false as const, error: res.error };
        await this.writeState(res.text);
        const parsed = parseState(res.text);
        if (!parsed.ok)
          throw new Error(`setStateSection produced unparseable text: ${parsed.error}`);
        return { ok: true as const, doc: parsed.doc, text: res.text };
      });
    });
  }

  /**
   * RCB-58: replace ONLY `name`'s own SEATS bullet and restamp — a seat's own terminal can make
   * this ONE write to shared STATE.md without touching another seat's line. The bullet is found
   * the SAME way `repoboard seat <name>` finds it (`replaceSeatBullet` is `findSeatLine`'s own
   * two-pass match, RCB-58), and the restamp goes through `setStateSectionCore` — the SAME code
   * path `setStateSection`/`state --set-section` uses — so the byte-preservation of every other
   * section is one guarantee, not two. Missing STATE.md is scaffolded first, exactly like
   * `setStateSection`.
   */
  setSeatBullet(name: string, status: 'UP' | 'DOWN', text: string): Promise<SetStateOutcome> {
    return this.mutate(async () => {
      this.refuseWriteWithoutBoard();
      return withFileLock(this.statePath, async () => {
        let raw: string;
        try {
          raw = await readFile(this.statePath, 'utf8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          raw = initialStateText({ now: this.now(), actor: name });
        }
        const parsed = parseState(raw);
        if (!parsed.ok) return { ok: false as const, error: parsed.error };
        const now = this.now();
        const newSeats = replaceSeatBullet(
          parsed.doc.sections.seats,
          name,
          formatSeatBullet(name, status, text, now),
        );
        const res = setStateSectionCore(raw, 'seats', newSeats, { now, actor: name });
        if (!res.ok) return { ok: false as const, error: res.error };
        await this.writeState(res.text);
        const reparsed = parseState(res.text);
        if (!reparsed.ok)
          throw new Error(`setSeatBullet produced unparseable text: ${reparsed.error}`);
        return { ok: true as const, doc: reparsed.doc, text: res.text };
      });
    });
  }

  /**
   * RCB-88: rewrite ONLY `name`'s own SEATS bullet's BODY — the standing label/status/stamp are
   * kept byte-for-byte (`rewriteSeatBulletBody`, no restamp), while STATE.md's own line-3 stamp
   * IS restamped as `name`, same as every other STATE write (this is what keeps `check` green
   * after a mid-session log block — see `setStateSection`). Unlike `setSeatBullet`, a missing
   * STATE.md or a missing/unparseable bullet is REFUSED, not scaffolded or appended — there is
   * nothing to keep in either case.
   */
  updateSeatBullet(name: string, text: string): Promise<UpdateSeatOutcome> {
    return this.mutate(async () => {
      this.refuseWriteWithoutBoard();
      return withFileLock(this.statePath, async () => {
        let raw: string;
        try {
          raw = await readFile(this.statePath, 'utf8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          return {
            ok: false as const,
            error: `seat ${name} has no standing bullet to update; use --up or --down`,
          };
        }
        const parsed = parseState(raw);
        if (!parsed.ok) return { ok: false as const, error: parsed.error };
        const line = findSeatLine(parsed.doc.sections.seats, name);
        if (line === null) {
          return {
            ok: false as const,
            error: `seat ${name} has no standing bullet to update; use --up or --down`,
          };
        }
        // RCB-130: --update has no PRESENCE guard of its own (RCB-88, deliberate: a bullet with
        // neither field yet may still be updated) but shares the COUNT guard `--down` uses —
        // `checkFieldCounts`, the same function, so the rule can never drift between the two.
        const countErr = checkFieldCounts(text);
        if (countErr) return { ok: false as const, error: countErr };
        const rewrite = rewriteSeatBulletBody(line, text);
        if (rewrite === null) {
          return {
            ok: false as const,
            error: `seat ${name}'s bullet has no UP|DOWN stamp to keep; use --up or --down`,
          };
        }
        const now = this.now();
        const newSeats = replaceSeatBullet(parsed.doc.sections.seats, name, rewrite.bullet);
        const res = setStateSectionCore(raw, 'seats', newSeats, { now, actor: name });
        if (!res.ok) return { ok: false as const, error: res.error };
        await this.writeState(res.text);
        const reparsed = parseState(res.text);
        if (!reparsed.ok)
          throw new Error(`updateSeatBullet produced unparseable text: ${reparsed.error}`);
        return {
          ok: true as const,
          doc: reparsed.doc,
          text: res.text,
          status: rewrite.status,
          stamp: rewrite.stamp,
        };
      });
    });
  }

  /**
   * P8.3: append one block to today's `<this.logDir>/<date>.md`, creating the file (with its
   * `# Log — <date>` header) if this is the first entry of the day. Append-only: there is no
   * store method that rewrites a log file. RCB-71 A: `this.logDir` is `board.yml`'s `logDir` when
   * set — see `resolveLogDir()`.
   */
  appendRepoLog(
    seat: string,
    text: string,
    title: string | undefined,
  ): Promise<AppendRepoLogOutcome> {
    return this.mutate(() => this.doAppendRepoLog(seat, text, title));
  }

  /**
   * RCB-127: `appendRepoLog`'s own body, factored out so `appendSeatLog` can run it and then,
   * still inside the SAME `mutate` turn, restamp STATE.md. `appendSeatLog` cannot call the public
   * `appendRepoLog` above to get this: that would be a second `mutate`/`enqueue` call made from
   * inside the first's still-running callback, which chains onto `this.queue` (the first call's
   * own in-flight promise) and deadlocks — the outer call would then be awaiting a promise that
   * can only resolve once the outer call itself returns. Not wrapped in `mutate` itself; every
   * caller must already be inside one.
   */
  private async doAppendRepoLog(
    seat: string,
    text: string,
    title: string | undefined,
  ): Promise<AppendRepoLogOutcome> {
    if (seat.trim().length === 0) return { ok: false as const, error: 'seat must not be empty' };
    const line = text.trim();
    if (line.length === 0) return { ok: false as const, error: 'text must not be empty' };
    this.refuseWriteWithoutBoard();
    const now = this.now();
    const date = toIso(now).slice(0, 10);
    const path = join(this.logDir, `${date}.md`);
    let existing = '';
    try {
      existing = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const base = existing.length > 0 ? existing : `${dailyLogHeader(date)}\n\n`;
    const ts = toIso(now);
    const block = formatLogBlock({ seat, ts, title, text: line });
    const next = appendLogBlock(base, block);
    await this.writeLog(date, next);
    const parsedBlocks = parseLogBlocks(next);
    const parsedBlock = parsedBlocks[parsedBlocks.length - 1];
    return {
      ok: true as const,
      date,
      text: next,
      block: parsedBlock ?? { seat: seat.toUpperCase(), ts, title: title ?? line, text: line },
    };
  }

  /**
   * RCB-127 (owner decision 2026-09-25): `log --as <seat>` — the CLI and MCP entry point for a
   * mid-session log block. Runs `doAppendRepoLog`, then, under `this.statePath`'s cross-process
   * file lock, restamps STATE.md's own line-3 stamp/actor line iff `seat` has an UP bullet in
   * SEATS right now — the SAME restamp `updateSeatBullet` performs (`setStateSectionCore` on
   * `seats`, with the UNCHANGED seats body, actor = `seat`): every section byte-identical, only
   * the stamp/actor line changes. This is what keeps `check`'s stale-state finding from firing
   * just because an UP seat logged mid-session, without that seat having to also run
   * `seat --update`. A DOWN seat, an unknown seat (no bullet at all), a STATE.md that does not
   * exist, or one that fails to parse all get the log append with `restamped: false` — stale-state
   * still fires for them until `seat --update` (or `--up`/`--down`) runs. Seat matching is
   * `findSeatLine`'s own two-pass rule (RCB-58) — no new matcher, so this can never disagree with
   * `check`/`seat --update`/`seat --up` about who is UP.
   */
  appendSeatLog(
    seat: string,
    text: string,
    title: string | undefined,
  ): Promise<AppendSeatLogOutcome> {
    return this.mutate(async () => {
      const appended = await this.doAppendRepoLog(seat, text, title);
      if (!appended.ok) return appended;
      const restamped = await withFileLock(this.statePath, async () => {
        let raw: string;
        try {
          raw = await readFile(this.statePath, 'utf8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          return false;
        }
        const parsed = parseState(raw);
        if (!parsed.ok) return false;
        const line = findSeatLine(parsed.doc.sections.seats, seat);
        if (line === null || parseSeatStamp(line)?.status !== 'UP') return false;
        const res = setStateSectionCore(raw, 'seats', parsed.doc.sections.seats, {
          now: this.now(),
          actor: seat,
        });
        if (!res.ok) return false;
        await this.writeState(res.text);
        return true;
      });
      return { ...appended, restamped };
    });
  }

  /**
   * RCB-132: `state --trim-landings --archive <path>` — the SAME block shape as `appendRepoLog`
   * (`formatLogBlock`/`appendLogBlock`, its own `now()` for `ts`), but written to
   * `<root>/<relPath>` instead of the log, and never through `this.logDir`. `relPath`'s file is
   * created with `ARCHIVE_HEADER` first if it does not exist, and — like the log — never
   * rewritten, only appended to. `withFileLock` on the resolved path is the SAME guard
   * `setStateSection` uses on `statePath`, so two seats archiving into the same file at once
   * do not race each other.
   */
  appendArchiveText(
    relPath: string,
    seat: string,
    text: string,
    title: string | undefined,
  ): Promise<AppendArchiveOutcome> {
    return this.mutate(async () => {
      if (seat.trim().length === 0) return { ok: false as const, error: 'seat must not be empty' };
      const line = text.trim();
      if (line.length === 0) return { ok: false as const, error: 'text must not be empty' };
      this.refuseWriteWithoutBoard();
      const path = resolve(this.root, relPath);
      // RCB-132 (seat): the archive is a file IN this repo — a path that resolves outside the root
      // (`../x`, an absolute path elsewhere) is refused before anything is created.
      const inRoot = relative(this.root, path);
      if (inRoot === '' || inRoot === '..' || inRoot.startsWith(`..${sep}`)) {
        return {
          ok: false as const,
          error: `--archive must name a file inside the repo (got "${relPath}")`,
        };
      }
      const ts = toIso(this.now());
      const block = formatLogBlock({ seat, ts, title, text: line });
      const next = await this.writeArchive(path, (existing) =>
        appendLogBlock(existing.length > 0 ? existing : `${ARCHIVE_HEADER}\n\n`, block),
      );
      const parsedBlocks = parseLogBlocks(next);
      const parsedBlock = parsedBlocks[parsedBlocks.length - 1];
      return {
        ok: true as const,
        path: relative(this.root, path),
        block: parsedBlock ?? { seat: seat.toUpperCase(), ts, title: title ?? line, text: line },
      };
    });
  }

  /**
   * RCB-71 A: the log WRITE target, precedence high to low — `board.yml`'s `cfg.logDir`
   * (resolved against `this.root`) when set, then `.repoboard/local/log/` when a local layer
   * exists, else `.repoboard/log/`. Called from `load()` (after `loadConfig()`) and from the
   * watcher's `board.yml` handler, so a `logDir` added or removed while `serve` runs takes effect
   * on the next `board.yml` change without a restart. Reversed from P8.6 decision 1, which had
   * `logDir` as an additional READ-only source; reads are unaffected, see `logReadDirs()`.
   *
   * RCB-93: `hasLocalLog` (precomputed once in `load()`, alongside `hasLocalLayer`) is true only
   * when `.repoboard/local/log/` itself already exists as a directory — never re-derived here, so
   * this stays synchronous (a `board.yml` `logDir` change re-runs this from the watcher). A
   * tracked top-level `log/` that `local init` left in place never gets a `local/log/` directory
   * in the first place (see `moveIntoLocal`), so it keeps writing `.repoboard/log/` here too — the
   * record lives where it already is.
   */
  private resolveLogDir(): string {
    if (this.cfg.logDir) return resolve(this.root, this.cfg.logDir);
    return this.hasLocalLog ? join(localDir(this.root), 'log') : join(this.repoboardDir, 'log');
  }

  /**
   * RCB-83/RCB-71 A: every directory a log READ merges, in order — `.repoboard/log/` (the legacy
   * location, always read so entries written before a local layer existed are never lost),
   * `.repoboard/local/log/` (only when `hasLocalLayer`), then `board.yml`'s configured `logDir`
   * when set. Unchanged by RCB-71 A: reads still merge all three regardless of which one is the
   * WRITE target. Shared by `log()`, `loadAllLogInfo`, and — through it — `lastRepoLogBlock`,
   * so every reader of "the log" agrees on what it is. WRITES never merge: `appendRepoLog` always
   * targets `this.logDir` alone — see `resolveLogDir()` for that precedence.
   */
  private logReadDirs(): string[] {
    const dirs = [join(this.repoboardDir, 'log')];
    if (this.hasLocalLayer) dirs.push(join(localDir(this.root), 'log'));
    if (this.cfg.logDir) dirs.push(resolve(this.root, this.cfg.logDir));
    return dirs;
  }

  /**
   * P8.3: read one day's log fresh from disk (never cached). Defaults to today.
   *
   * RCB-62/RCB-83: merged across every `logReadDirs()` source. Each dir's text (when the file for
   * `day` exists there) is joined by a blank line, in `logReadDirs()` order; `blocks` is reparsed
   * from the merged text. `null` only when NO source has the file. When exactly one source has
   * it, that source's exact bytes are returned untouched (in particular: no local layer and no
   * `cfg.logDir` → `.repoboard/log/`'s text, byte for byte, exactly as before RCB-62/RCB-83).
   * `repoboard log`/`appendRepoLog` are unaffected: they still only ever WRITE `this.logDir` —
   * this merge is a read, never a write, exactly like `loadAllLogInfo`. RCB-71 A: `this.logDir`
   * itself now prefers `cfg.logDir` as the WRITE target (`resolveLogDir()`); this read-side merge
   * is unchanged.
   */
  async log(date?: string): Promise<LogFile | null> {
    const day = date ?? toIso(this.now()).slice(0, 10);
    const texts: string[] = [];
    for (const dir of this.logReadDirs()) {
      const text = await this.readLogDay(dir, day);
      if (text !== null) texts.push(text);
    }
    if (texts.length === 0) return null;
    const text = texts
      .map((t, i) => (i < texts.length - 1 ? t.replace(/\s+$/, '') : t))
      .join('\n\n');
    return { date: day, text, blocks: parseLogBlocks(text) };
  }

  /**
   * RCB-47: the newest block `seat` wrote, searching back across every day in `.repoboard/log/`
   * AND, when configured, `board.yml`'s `logDir` (reads merge both regardless of which one is the
   * WRITE target — RCB-71 A reversed the WRITE side of P8.6 decision 1, see `resolveLogDir()`;
   * this read merge is unaffected).
   * RCB-54: the original doc comment here argued OWN-dir-only was correct by definition ("a
   * seat's own last block is one it wrote with `repoboard log`") — false in the field, because a
   * seat can also write its blocks by hand straight into the configured `logDir` (as fpj's seats
   * do). `check` (`loadAllLogInfo`) already read both dirs; `seat`/`log --last` must agree with
   * it on what "the log" is, so this now reads the same merged set. Two files with the same date
   * (one per dir) both contribute — `lastBlockFor` sorts by date desc and, within a day, takes
   * the LAST block in (own-dir-then-extra-dir) file-list order; this is not deduped, and ties are
   * file-list order, not a "newest wins" comparison (see `store.test.ts`, P8.6 describe block).
   * Fresh from disk each call, never cached, like `log()`.
   */
  async lastRepoLogBlock(seat: string): Promise<{ date: string; block: LogBlock } | null> {
    const infos = await this.loadAllLogInfo();
    return lastBlockFor(seat, infos);
  }

  /**
   * RCB-48: `repoboard seat <name>` — the cold-start bundle, packaging the RCB-47 rule (STATE.md
   * → your own last block → the coordinator's → `card list --status todo` → open decisions) as
   * one read. Read-only: nothing is written, no event, works with no STATE.md (`seatsSection`
   * `null`). The coordinator's own block is fetched unconditionally — core's `seatBundle` is what
   * forces it `null` when `name` IS the coordinator, same as everywhere else that guarantee lives.
   */
  async seatBundle(name: string): Promise<SeatBundle> {
    const [ownBlock, coordinatorBlock, rig] = await Promise.all([
      this.lastRepoLogBlock(name),
      this.lastRepoLogBlock('coordinator'),
      this.readRigText(),
    ]);
    return seatBundleCore({
      name,
      now: this.now(),
      seatsSection: this.stateDoc?.sections.seats ?? null,
      ownBlock,
      coordinatorBlock,
      cards: this.list(),
      rig,
      config: this.config,
      // RCB-97 (plan §3.3): the seat ALWAYS gets exactly one Systems line — `systemsSummary`
      // itself renders the "no systems.yml yet" line when both args are the absent-file shape,
      // which is exactly `this.systemsDoc`/`this.systemsErrors` when there is no file.
      systems: systemsSummary(this.systemsDoc, this.systemsErrors),
      // RCB-131: `.repoboard/leases.yml`'s doc — `seatBundleCore` keeps only the live ones.
      leases: this.leasesDoc,
    });
  }

  /** RCB-83: `.repoboard/local/RIG.md`'s text, `null` when there is no local layer or no RIG.md. */
  private async readRigText(): Promise<string | null> {
    try {
      return await readFile(join(localDir(this.root), 'RIG.md'), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return null;
    }
  }

  /**
   * P8.3: `repoboard check` — gather the facts (state, every log file's mtime and blocks, cards,
   * config, leases) and hand them to core's pure `checkFindings`. A read, so it works even in
   * map-only mode (with no cards, no leases, and `state: null`, which is itself a stale-state
   * finding only when a log exists to compare against).
   */
  async check(strict: boolean): Promise<CheckOutcome> {
    const now = this.now();
    const logs = await this.loadAllLogInfo();
    // P8.4: read-only, so a check never fails to gather it; a read error (e.g. a permissions
    // problem on a linked path) yields `null` and `costFinding` reports nothing rather than
    // throwing `check` itself.
    const cost = await this.cost().catch(() => null);
    // RCB-83: same "never fails to gather" rule as cost — a read error yields `null` and the
    // local findings report nothing rather than throwing `check` itself.
    const local = await localStatus(this.root).catch(() => null);
    const findings = checkFindings({
      state: this.stateDoc,
      logs,
      cards: this.list(),
      config: this.cfg,
      leases: this.leasesDoc,
      now,
      cost,
      local,
      systems: await this.gatherSystemsCheck(),
      untrackedCards: await this.gatherUntrackedCards().catch(() => null),
      // RCB-130: every SEATS bullet's name + text, split the SAME way `repoboard seat`/`seat list`
      // split it (`seatBulletTexts`, core's own `bulletSpans` — no second splitter here) — pure,
      // so gathering it is just reading the section already on `this.stateDoc`.
      seatBullets: seatBulletTexts(this.stateDoc?.sections.seats ?? ''),
    });
    return { findings, exitCode: exitCodeForFindings(findings, strict) };
  }

  /**
   * RCB-119: card files git does not track — `repoboard check`'s `untracked-cards` finding. One
   * git spawn, cwd = `this.root`: `ls-files --others --exclude-standard` scoped to the cards dir,
   * so an untracked write elsewhere in the tree never shows up here. `null` when `this.root` is
   * not a git repo (or the spawn otherwise fails) — same "gather never fails, unconfigured is
   * inert" rule as `local`/`systems` above. Each id's `actor` is the NEWEST `create` event's
   * actor for that id in this store's already-loaded event log, or `null` when there is none.
   */
  private async gatherUntrackedCards(): Promise<
    readonly { id: string; actor: string | null }[] | null
  > {
    const result = await new Promise<{ code: number; stdout: string } | null>((res) => {
      const child = spawn('git', [
        '-C',
        this.root,
        'ls-files',
        '--others',
        '--exclude-standard',
        '--',
        this.cardsDir,
      ]);
      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.on('error', () => res(null));
      child.on('close', (code) => res({ code: code ?? 1, stdout }));
    });
    if (result === null || result.code !== 0) return null;
    const lines = result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const found: { id: string; actor: string | null }[] = [];
    for (const line of lines) {
      const name = basename(line);
      if (!CARD_FILE.test(name)) continue;
      const id = basename(name, '.md');
      let actor: string | null = null;
      // Append order = chronological, so the last matching `create` event is the newest one.
      for (const e of this.eventLog) {
        if (e.type === 'create' && e.cardId === id) actor = e.actor;
      }
      found.push({ id, actor });
    }
    return found;
  }

  /**
   * RCB-97: `check`'s `systems` input — `null` when there is no `systems.yml` at all (§3.1:
   * unconfigured is inert). Otherwise `{ errors, stale }`: `stale` is only ever computed when
   * `doc` parsed AND has at least one `source.detected` row (an invalid file has no rows to
   * stale-check); a detection failure yields `stale: []` — a `check` call must never throw over
   * this (mirrors `cost`'s and `local`'s own "gather never fails" rule above).
   */
  private async gatherSystemsCheck(): Promise<{
    errors: readonly string[];
    stale: readonly string[];
  } | null> {
    const { doc, errors, exists } = this.systems();
    if (!exists) return null;
    let stale: string[] = [];
    if (doc?.systems.some((s) => 'detected' in s.source)) {
      try {
        const { candidates } = await detectSystems(this.root);
        stale = staleDetected(doc, candidates);
      } catch {
        stale = [];
      }
    }
    return { errors, stale };
  }

  /**
   * Append one `- <ts> <actor> — <text>` bullet under `## Log` and bump `updated`. Unlike
   * `update({body})` this writes exactly one log line. Newlines in `text` collapse to spaces
   * so the bullet stays one line.
   */
  appendLog(id: string, text: string, actor: string): Promise<UpdateOutcome> {
    return this.mutate(async () => {
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

  /**
   * RCB-70: append one dated, attributed remark under `## Notes` (created before `## Log` if
   * missing — core's `addNote`/`appendNoteLine`) and bump `updated`. Unlike `appendLog`, this
   * writes NO `## Log` line — the note is itself dated and attributed.
   */
  addNote(id: string, text: string, actor: string): Promise<UpdateOutcome> {
    return this.mutate(async () => {
      const card = this.cards.get(id);
      if (!card) return { ok: false, error: `unknown card "${id}"`, notFound: true };
      const res = addNoteCore(card, { text, actor, now: this.now() });
      if (!res.ok) return { ok: false, error: res.error };
      await this.writeCard(res.card);
      await this.appendEvent(res.event);
      return { ok: true, card: res.card, event: res.event };
    });
  }

  /**
   * P8.5: `sync-issues`'s own close — moves a card to the first `done: true` column with a log
   * line naming the cause (`synced: entry closed in <path>`) instead of `moveCard`'s generic
   * line. Same funnel shape as `move`/`ask`/`decide`: one write, one event.
   */
  closeSynced(id: string, path: string, actor: string): Promise<CloseSyncedOutcome> {
    return this.mutate(async () => {
      const card = this.cards.get(id);
      if (!card) return { ok: false, error: `unknown card "${id}"`, notFound: true };
      // RCB-108: `undefined` when `card` is itself an uncounted plan parent (it adds 0 to any
      // column, so it cannot breach a limit) — else per-status counts over every other card.
      const columnCounts = wipCountsForMove(card, [...this.cards.values()]);
      const res = closeSyncedCard(card, {
        actor,
        now: this.now(),
        config: this.cfg,
        path,
        columnCounts,
      });
      if (!res.ok) return { ok: false, error: res.error };
      await this.writeCard(res.card);
      await this.appendEvent(res.event);
      return { ok: true, card: res.card, event: res.event, warnings: res.warnings };
    });
  }

  /**
   * P8.5: pure read (no I/O beyond what `list()`/`config` already hold in memory) — which cards
   * WOULD be archived at `cutoff`. Safe to call in map-only mode and for `--dry-run` (it never
   * writes); `archiveCards` is the writer.
   */
  selectArchivable(cutoff: Date): string[] {
    return selectArchivableCore(this.list(), this.cfg, cutoff);
  }

  /**
   * P8.5: move each id's card file to `.repoboard/archive/` — `git mv` when tracked, else
   * `fs.rename` (`archive.ts`). BYTE-IDENTICAL: this never routes a card through `serializeCard`,
   * unlike every other mutation here (C3's own control: doing so is exactly what must make the
   * hash test fail). One `type: 'archive'` event per card actually moved; an id already gone from
   * the in-memory map (unknown, or archived by a concurrent call) is skipped, not an error.
   */
  archiveCards(ids: readonly string[], actor: string): Promise<ArchiveOutcome> {
    return this.mutate(async () => {
      this.refuseWriteWithoutBoard();
      const archiveDir = join(this.repoboardDir, 'archive');
      const archived: string[] = [];
      const method: Record<string, ArchiveMoveMethod> = {};
      for (const id of ids) {
        const card = this.cards.get(id);
        if (!card) continue;
        const src = this.filePath(id);
        const dst = join(archiveDir, `${id}.md`);
        const relSrc = relative(this.root, src);
        const relDst = relative(this.root, dst);
        method[id] = await archiveMoveFile(this.root, relSrc, relDst);
        this.byPath.delete(src);
        this.cards.delete(id);
        this.emit('card:removed', id);
        const ts = toIso(this.now());
        const event: Event = {
          ts,
          actor,
          type: 'archive',
          cardId: id,
          from: card.status,
          to: 'archive',
        };
        await this.appendEvent(event);
        archived.push(id);
      }
      return { ok: true as const, archived, method };
    });
  }

  /**
   * RCB-34/P7.3: replace the WHOLE column set in `board.yml` (a replace, like every list in
   * `CardPatch`) — the plan §11 O6 mechanism for a per-user column set. `next` keeps every other
   * top-level key of the current config untouched, then one validated round trip through the
   * only two functions that define the file, `parseBoard(serializeBoard(next))` — the exact
   * check a hand edit of `board.yml` would get, so a duplicate id or an empty list is refused
   * with the schema's own message and nothing is written. YAML COMMENTS ARE LOST on a successful
   * write: `serializeBoard` cannot round-trip them (this repo's own `board.yml` has none).
   *
   * The write and the guard are inline here, not delegated to a private `writeXxx` (unlike
   * `writeCard`/`writeLeases`/`writeState`/`writeLog`): this is the one mutation whose only
   * caller is this method, so `this.refuseWriteWithoutBoard()` on the line below is the entire
   * difference between "readOnly" and a `.repoboard/board.yml` materialising on a map-only root
   * — store.test.ts's K10 control removes exactly this line to prove it.
   */
  setColumns(columns: Column[], actor: string): Promise<SetColumnsOutcome> {
    return this.mutate(async () => {
      this.refuseWriteWithoutBoard();
      const next: BoardConfig = { ...this.cfg, columns };
      const parsed = parseBoard(serializeBoard(next));
      if (!parsed.ok) return { ok: false as const, error: parsed.error };
      const text = serializeBoard(parsed.config);
      const from = this.cfg.columns.map((c) => c.id).join(',');
      const to = parsed.config.columns.map((c) => c.id).join(',');
      await mkdir(this.repoboardDir, { recursive: true });
      const tmp = `${this.boardPath}.tmp`;
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, this.boardPath);
      this.cfg = parsed.config;
      this.boardHash = sha1(text);
      this.emit('config', this.cfg);
      const event: Event = {
        ts: toIso(this.now()),
        actor,
        type: 'columns',
        cardId: null,
        from,
        to,
      };
      await this.appendEvent(event);
      return { ok: true as const, config: parsed.config };
    });
  }

  // ---- internals ----------------------------------------------------------------------

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * K10: the funnel for every mutation. It is `enqueue` plus the one thing a mutation needs that
   * the watcher's queued reads must not have — turning `MapOnlyError` into K4's
   * `{ok:false, error}` instead of a throw. `enqueue` itself cannot carry the guard: the watcher
   * queues `loadConfig`, `loadEvents`, `refreshCard` and `removeCardFile` through it too, and
   * those must keep working in map-only mode (they are how the map stays live).
   */
  private mutate<T extends { ok: boolean }>(
    fn: () => Promise<T>,
  ): Promise<T | { ok: false; error: string; readOnly: true }> {
    return this.enqueue(async () => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof MapOnlyError) {
          return { ok: false as const, error: e.message, readOnly: true as const };
        }
        throw e;
      }
    });
  }

  /**
   * RCB-133: the ONE path by which `takeLease`/`releaseLease`/`addWindow` touch leases.yml.
   * `this.leasesDoc` is a load-time cache — two processes (two CLI one-shots, or a CLI next to
   * `serve`) each start from their own copy, so computing from it and writing back can silently
   * drop the other process's write. `withFileLock` makes the read-modify-write span exclusive
   * ACROSS processes, not just within this one (`mutate`/`enqueue` only ever did the latter); `fn`
   * is handed the doc as re-read from disk the instant the lock is held, never the stale cache.
   * `refuseWriteWithoutBoard()` runs before the lock is even taken (mirrors K10 / plan §11 O7:
   * a refused mutation must leave the target — and here, the directory the lock file would sit
   * in — byte-identical, so map-only mode never creates `.repoboard/`). A leases.yml that fails
   * to parse returns `{ok:false, error}` with NO write, so a bad hand edit is never overwritten;
   * `writeLeases` still prunes-on-write and appends the event, exactly as before RCB-133.
   */
  private mutateLeases(
    fn: (doc: LeasesDoc, now: Date) => LeaseMutationResult,
  ): Promise<LeaseOutcome> {
    return this.mutate(async () => {
      this.refuseWriteWithoutBoard();
      return withFileLock(this.leasesPath, async () => {
        let doc: LeasesDoc;
        try {
          const text = await readFile(this.leasesPath, 'utf8');
          const parsed = parseLeases(text);
          if (!parsed.ok) return { ok: false as const, error: parsed.error };
          doc = parsed.doc;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          doc = { leases: [], windows: [] };
        }
        const res = fn(doc, this.now());
        if (!res.ok) return { ok: false as const, error: res.error };
        const pruned = pruneWindows(res.doc, this.now());
        await this.writeLeases(pruned);
        await this.appendEvent(res.event);
        return { ok: true as const, doc: pruned, event: res.event, warnings: res.warnings };
      });
    });
  }

  /**
   * K10 / plan §11 O7: pointing at a directory is a read-only act. Called first in both writers,
   * before any directory is created, so a refused mutation leaves the target byte-identical.
   */
  private refuseWriteWithoutBoard(): void {
    if (!this.board) throw new MapOnlyError();
  }

  /**
   * RCB-68: `parent` names a card that exists ON THIS BOARD. Core cannot know the ids on an
   * `update` (it only ever sees the one card being patched), so the store is where this
   * guarantee lives — both `create` and `update` call this one function. `undefined`/`null`
   * (absent, or a `--clear`) is always ok; core's own checks (self-parent, empty string) already
   * ran by the time this is called.
   */
  private checkParent(
    parent: string | null | undefined,
  ): { ok: true } | { ok: false; error: string } {
    if (parent === undefined || parent === null) return { ok: true };
    if (!this.cards.has(parent)) {
      return { ok: false, error: `parent: unknown card "${parent}" (card list shows the ids)` };
    }
    return { ok: true };
  }

  /** Atomic: write `<file>.tmp`, rename over the target, then update the cache. */
  private async writeCard(card: Card): Promise<void> {
    this.refuseWriteWithoutBoard();
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
    this.refuseWriteWithoutBoard();
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

  /** Atomic: write `<file>.tmp`, rename over the target, then update the cache (mirrors `writeCard`). */
  private async writeLeases(doc: LeasesDoc): Promise<void> {
    this.refuseWriteWithoutBoard();
    const text = serializeLeases(doc);
    await mkdir(this.repoboardDir, { recursive: true });
    const tmp = tmpName(this.leasesPath);
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, this.leasesPath);
    this.leasesDoc = doc;
    this.emit('leases', doc);
  }

  /** Atomic: write `<file>.tmp`, rename over the target, then update the cache (mirrors `writeLeases`). */
  private async writeState(text: string): Promise<void> {
    this.refuseWriteWithoutBoard();
    await mkdir(this.repoboardDir, { recursive: true });
    const tmp = tmpName(this.statePath);
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, this.statePath);
    const parsed = parseState(text);
    this.stateDoc = parsed.ok ? parsed.doc : null;
    this.emit('state', this.stateDoc);
  }

  /** Atomic: write `<file>.tmp`, rename over the target (mirrors `writeCard`/`writeLeases`/`writeState`). */
  private async writeLog(date: string, text: string): Promise<void> {
    this.refuseWriteWithoutBoard();
    const path = join(this.logDir, `${date}.md`);
    await mkdir(this.logDir, { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
    this.emit('log', { date, text });
  }

  /**
   * RCB-132: the `--archive` file's one write site (K10: every disk write lives in a private
   * `writeXxx`). Read-modify-write under `withFileLock` on `path` — the same guard
   * `setStateSection` uses — then tmp + rename like `writeLog`. `next` maps the current text
   * (`''` when the file is absent) to the new one, which is returned. The directory is made
   * before the lock, because the lock file sits next to `path`.
   */
  private async writeArchive(path: string, next: (existing: string) => string): Promise<string> {
    this.refuseWriteWithoutBoard();
    await mkdir(dirname(path), { recursive: true });
    return withFileLock(path, async () => {
      let existing = '';
      try {
        existing = await readFile(path, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      const text = next(existing);
      const tmp = `${path}.tmp`;
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, path);
      return text;
    });
  }

  private async loadState(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.statePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.stateDoc = null;
      return;
    }
    const res = parseState(text);
    if (res.ok) {
      this.stateDoc = res.doc;
    } else {
      // Keep the last good doc rather than losing the page to a bad hand edit.
      this.emit('warning', `${relative(this.root, this.statePath)}: ${res.error}`);
    }
  }

  /**
   * RCB-62: one `<dir>/<day>.md` file's raw text, or `null` when it does not exist (any other
   * read error still throws). The sibling of `loadLogInfoFrom` for `log()`'s single-day merge —
   * `loadLogInfoFrom` reads every file in a dir for `check`; this reads exactly one file by name.
   */
  private async readLogDay(dir: string, day: string): Promise<string | null> {
    try {
      return await readFile(join(dir, `${day}.md`), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return null;
    }
  }

  /** Every `<dir>/*.md` file's date, mtime and parsed blocks. A missing `dir` reads as empty,
   * never an error — shared by `.repoboard/log/` and P8.6's configured `logDir`. */
  private async loadLogInfoFrom(dir: string): Promise<LogFileInfo[]> {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return [];
    }
    const out: LogFileInfo[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const path = join(dir, name);
      const [text, st] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      out.push({ date: name.slice(0, -3), mtimeMs: st.mtimeMs, blocks: parseLogBlocks(text) });
    }
    return out;
  }

  /**
   * Every file's date, mtime and parsed blocks across `logReadDirs()` — `.repoboard/log/`,
   * `.repoboard/local/log/` (RCB-83, when a local layer exists) and `board.yml`'s `logDir` when
   * configured — read here regardless of which one is `this.logDir`, the WRITE target (RCB-71 A,
   * see `resolveLogDir()`). `check`'s pure input.
   */
  private async loadAllLogInfo(): Promise<LogFileInfo[]> {
    const perDir = await Promise.all(this.logReadDirs().map((dir) => this.loadLogInfoFrom(dir)));
    return perDir.flat();
  }

  private async loadLeases(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.leasesPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.leasesDoc = { leases: [], windows: [] };
      return;
    }
    const res = parseLeases(text);
    if (res.ok) {
      this.leasesDoc = res.doc;
    } else {
      // Keep the last good doc rather than losing every lease/window to a bad hand edit.
      this.emit('warning', `${relative(this.root, this.leasesPath)}: ${res.error}`);
    }
  }

  /**
   * RCB-97: unlike `loadLeases`, an invalid `systems.yml` does NOT keep the last good doc — it
   * becomes `doc: null` + `errors` (§3.2: "a file that will not parse is worse than none"),
   * because `check`'s `systems-invalid` finding must see the breakage, not a stale copy.
   */
  private async loadSystems(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.systemsPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.systemsDoc = null;
      this.systemsErrors = [];
      this.systemsExists = false;
      return;
    }
    this.systemsExists = true;
    const res = parseSystems(text);
    if (res.ok) {
      this.systemsDoc = res.doc;
      this.systemsErrors = [];
    } else {
      this.systemsDoc = null;
      this.systemsErrors = res.errors;
    }
  }

  /**
   * Read `board.yml`. Returns `changed: false` — and touches neither `cfg` nor `boardHash` —
   * when the bytes on disk are exactly the hash already recorded (RCB-34: `setColumns` records
   * its own write's hash before the watcher ever sees the rename, so that echo is a no-op here).
   * The caller decides whether to emit `'config'` from `changed`.
   */
  private async loadConfig(): Promise<{ changed: boolean }> {
    let text: string;
    try {
      text = await readFile(this.boardPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.cfg = defaultBoardConfig();
      this.boardHash = null;
      return { changed: true };
    }
    const hash = sha1(text);
    if (hash === this.boardHash) return { changed: false };
    this.boardHash = hash;
    const res = parseBoard(text);
    if (res.ok) {
      this.cfg = res.config;
    } else {
      // Keep the last good config rather than turning the board into nothing.
      this.emit('warning', `${relative(this.root, this.boardPath)}: ${res.error}`);
    }
    return { changed: true };
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
      const event: Omit<Event, 'ts'> = prevCard
        ? prevCard.status !== card.status
          ? { actor: 'file', type: 'move', cardId: card.id, from: prevCard.status, to: card.status }
          : { actor: 'file', type: 'update', cardId: card.id, from: card.status, to: card.status }
        : { actor: 'file', type: 'create', cardId: card.id, from: null, to: card.status };

      // K8: a writer's card-file write and its `events.jsonl` claim are two separate writes.
      // `updated` moving (a real mutation, not a hand edit of `status:` alone — see `isClaimed`)
      // means a claim may simply not have landed yet, so give it `claimGraceMs` before deciding
      // no one is coming. `claimGraceMs <= 0` is the control: synthesise now, exactly as before
      // this task. A hand edit (updated unchanged) is never delayed — that path is the product's
      // headline behaviour and must not get slower (§0.3).
      const updatedMoved = !prevCard || prevCard.updated !== card.updated;
      if (!updatedMoved || this.claimGraceMs <= 0) {
        const ts = toIso(this.now());
        await this.appendEvent({ ...event, ts });
        return;
      }
      this.schedulePendingClaim(card.id, card.updated, event);
    }
  }

  /**
   * K8: park the "no claim yet" synthesis for `claimGraceMs` instead of writing it immediately.
   * Keyed by `${id}\0${updated}` (see `pendingClaims`'s own doc comment) — a later watch event
   * for the same card but a DIFFERENT `updated` gets its own entry and its own timer; it never
   * cancels this one, so an earlier mutation that never gets claimed still gets reported. On
   * fire, re-checks for the claim — through the same serial `enqueue` queue every watcher task
   * uses — before writing, so a claim that lands during the grace window still wins and only one
   * event is ever written for that `updated`.
   */
  private schedulePendingClaim(id: string, updated: string, event: Omit<Event, 'ts'>): void {
    const key = `${id}\0${updated}`;
    const timer = setTimeout(() => {
      this.pendingClaims.delete(key);
      this.enqueue(async () => {
        await this.loadEvents();
        if (this.eventLog.some((e) => e.cardId === id && e.ts === updated)) return;
        const ts = toIso(this.now());
        await this.appendEvent({ ...event, ts });
      }).catch((e: unknown) => {
        this.emit('warning', `claim-grace: ${id}: ${(e as Error).message}`);
      });
    }, this.claimGraceMs);
    this.pendingClaims.set(key, { updated, event, timer });
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
    // RCB-71 A: `this.logDir` can now be `board.yml`'s `cfg.logDir`, resolved anywhere under
    // `this.root` — not necessarily under `this.repoboardDir`. chokidar takes an array of paths;
    // a missing dir is fine (it just watches nothing there yet). `logRel`/`logMatch` below
    // already key off `relative(this.repoboardDir, this.logDir)`, so a `logDir` outside
    // `this.repoboardDir` (e.g. `../docs/log`) still matches once its own path is watched too.
    const logDirOutside = relative(this.repoboardDir, this.logDir).startsWith('..');
    const watchPaths = logDirOutside ? [this.repoboardDir, this.logDir] : this.repoboardDir;
    const watcher = chokidarWatch(watchPaths, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
      // RCB-83: `.repoboard/local/` is its own git repo — its `.git/` churns on every sync and
      // holds nothing the board reads. RCB-133: `.lock` files (leases.yml.lock, STATE.md.lock)
      // are created and unlinked around every mutation now — without this they would queue a
      // no-op task on this store's OWN `enqueue` (the same queue every mutation serializes
      // through) for every lock/unlock, on top of never being anything the board reads.
      ignored: (p) => p.endsWith('.tmp') || p.endsWith('.lock') || p.split(sep).includes('.git'),
    });
    this.watcher = watcher;
    watcher.on('all', (event, rawPath) => {
      const path = resolve(rawPath);
      const rel = relative(this.repoboardDir, path).split(sep).join('/');
      // RCB-83: `this.statePath` moves to `local/STATE.md` when a local layer exists (set once,
      // in `load()`, before the watcher ever starts) — compare against ITS relative name, not
      // the hardcoded root-level one, so a local-layer repo's STATE.md is still watched.
      const stateRel = relative(this.repoboardDir, this.statePath).split(sep).join('/');
      const logRel = relative(this.repoboardDir, this.logDir).split(sep).join('/');
      const task = (): Promise<void> => {
        if (rel === 'board.yml') {
          // RCB-34: `setColumns` already emitted `config` synchronously; skip the echo (see
          // `loadConfig`'s hash check) so one `setColumns` call produces exactly one emit.
          return this.loadConfig().then(({ changed }) => {
            if (changed) {
              // RCB-71 A: a `logDir` added, changed, or removed in `board.yml` while `serve`
              // runs takes effect immediately — no restart needed for the WRITE target to move.
              this.logDir = this.resolveLogDir();
              this.emit('config', this.cfg);
            }
          });
        }
        if (rel === 'events.jsonl') return this.loadEvents();
        if (rel === 'leases.yml') {
          return this.loadLeases().then(() => {
            this.emit('leases', this.leasesDoc);
          });
        }
        if (rel === 'systems.yml') {
          return this.loadSystems().then(() => {
            this.emit('systems', this.systems());
          });
        }
        if (rel === stateRel) {
          if (event === 'unlink') {
            this.stateDoc = null;
            this.emit('state', null);
            return Promise.resolve();
          }
          return this.loadState().then(() => {
            this.emit('state', this.stateDoc);
          });
        }
        // RCB-83: the log WRITE dir moves with the local layer; the panel follows `this.logDir`.
        const logMatch =
          rel.startsWith(`${logRel}/`) && rel.endsWith('.md')
            ? /^([^/]+)\.md$/.exec(rel.slice(logRel.length + 1))
            : null;
        if (logMatch?.[1] !== undefined) {
          if (event === 'unlink') return Promise.resolve();
          return readFile(path, 'utf8').then((text) => {
            this.emit('log', { date: logMatch[1] as string, text });
          });
        }
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

/**
 * P8.2 correction (§7): this set was `['move', 'update', 'create']` only, silently dropping every
 * P8.1 `ask`/`decide` line on a read from disk (initial `load()`, or catching up on a line another
 * process appended) — in-memory it was fine, because `appendEvent` pushes the event object it was
 * given directly, bypassing this filter entirely; only a REREAD ever ran an ask/decide line
 * through it. Measured by writing an `ask` line, restarting a store against the same
 * `.repoboard/`, and finding `store.events()` come back without it. Widened here to the full set,
 * P8.2's `lease`/`window` included.
 */
const EVENT_TYPES: ReadonlySet<string> = new Set([
  'move',
  'update',
  'create',
  'ask',
  'decide',
  'lease',
  'window',
  'archive',
  'columns',
  'note',
]);

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
    if (typeof o.ts !== 'string') continue;
    // P8.2: `cardId` is `null` on a `lease`/`window` event (it is not about a card).
    if (typeof o.cardId !== 'string' && o.cardId !== null) continue;
    if (typeof o.type !== 'string' || !EVENT_TYPES.has(o.type)) continue;
    const event: Event = {
      ts: o.ts,
      actor: typeof o.actor === 'string' ? o.actor : 'unknown',
      type: o.type as Event['type'],
      cardId: o.cardId,
      from: typeof o.from === 'string' ? o.from : null,
      to: typeof o.to === 'string' ? o.to : '',
    };
    if (typeof o.resource === 'string') event.resource = o.resource;
    if (typeof o.letter === 'string') event.letter = o.letter;
    out.push(event);
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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
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
