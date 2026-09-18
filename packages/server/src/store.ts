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
  type AddWindowInput,
  addWindow,
  appendLogBlock,
  appendLogLine,
  askDecision,
  type BoardConfig,
  type Card,
  type CardPatch,
  type CheckResourceResult,
  type CostReport,
  type CreateCardInput,
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
  formatLogBlock,
  formatLogLine,
  initialStateText,
  type LeasesDoc,
  type LogBlock,
  type LogFileInfo,
  lastBlockFor,
  moveCard,
  parseBoard,
  parseCard,
  parseLeases,
  parseLogBlocks,
  parseState,
  pruneWindows,
  type ReleaseLeaseInput,
  releaseLease,
  type SeatBundle,
  type StateDoc,
  type StateSectionName,
  seatBundle as seatBundleCore,
  selectArchivable as selectArchivableCore,
  serializeCard,
  serializeLeases,
  setStateSection as setStateSectionCore,
  type TakeLeaseInput,
  takeLease,
  toIso,
  updateCard,
} from '@repoboard/core';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { type ArchiveMoveMethod, archiveMoveFile } from './archive.js';
import { gatherCost } from './cost.js';

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
}

export interface OpenStoreOptions {
  /** Start the chokidar watcher. CLI one-shots pass false so the process can exit. */
  watch?: boolean;
  /** Clock, for tests. */
  now?: () => Date;
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

/** P8.3: `appendRepoLog` outcome. */
export type AppendRepoLogOutcome =
  | { ok: true; date: string; text: string; block: LogBlock }
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
  readonly leasesPath: string;
  readonly statePath: string;
  readonly logDir: string;

  private cfg: BoardConfig = defaultBoardConfig();
  private leasesDoc: LeasesDoc = { leases: [], windows: [] };
  private stateDoc: StateDoc | null = null;
  private board = false;
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
    this.leasesPath = join(this.repoboardDir, 'leases.yml');
    this.statePath = join(this.repoboardDir, 'STATE.md');
    this.logDir = join(this.repoboardDir, 'log');
    this.now = opts.now ?? (() => new Date());
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
    await this.loadConfig();
    await this.loadLeases();
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
    return this.mutate(async () => {
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
   * P8.1: open a decision on a card, or replace one already open (`--replace`). O11: when the
   * board has a `decision: true` column, this also moves the card there through core's
   * `askDecision` (same funnel: one write, one event, computed the same way `move` computes
   * `columnCounts` for the WIP check).
   */
  ask(id: string, input: AskInput, actor: string): Promise<AskOutcome> {
    return this.mutate(async () => {
      const card = this.cards.get(id);
      if (!card) return { ok: false, error: `unknown card "${id}"`, notFound: true };
      const columnCounts: Record<string, number> = {};
      for (const c of this.cards.values()) {
        if (c.id !== id) columnCounts[c.status] = (columnCounts[c.status] ?? 0) + 1;
      }
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
      const columnCounts: Record<string, number> = {};
      for (const c of this.cards.values()) {
        if (c.id !== id) columnCounts[c.status] = (columnCounts[c.status] ?? 0) + 1;
      }
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
    return this.mutate(async () => {
      const res = takeLease(this.leasesDoc, input, { actor, now: this.now() });
      if (!res.ok) return { ok: false, error: res.error };
      const doc = pruneWindows(res.doc, this.now());
      await this.writeLeases(doc);
      await this.appendEvent(res.event);
      return { ok: true, doc, event: res.event, warnings: res.warnings };
    });
  }

  releaseLease(input: ReleaseLeaseInput, actor: string): Promise<LeaseOutcome> {
    return this.mutate(async () => {
      const res = releaseLease(this.leasesDoc, input, { actor, now: this.now() });
      if (!res.ok) return { ok: false, error: res.error };
      const doc = pruneWindows(res.doc, this.now());
      await this.writeLeases(doc);
      await this.appendEvent(res.event);
      return { ok: true, doc, event: res.event, warnings: res.warnings };
    });
  }

  addWindow(input: AddWindowInput, actor: string): Promise<LeaseOutcome> {
    return this.mutate(async () => {
      const res = addWindow(this.leasesDoc, input, { actor, now: this.now() });
      if (!res.ok) return { ok: false, error: res.error };
      const doc = pruneWindows(res.doc, this.now());
      await this.writeLeases(doc);
      await this.appendEvent(res.event);
      return { ok: true, doc, event: res.event, warnings: res.warnings };
    });
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
      if (!parsed.ok) throw new Error(`setStateSection produced unparseable text: ${parsed.error}`);
      return { ok: true as const, doc: parsed.doc, text: res.text };
    });
  }

  /**
   * P8.3: append one block to today's `.repoboard/log/<date>.md`, creating the file (with its
   * `# Log — <date>` header) if this is the first entry of the day. Append-only: there is no
   * store method that rewrites a log file.
   */
  appendRepoLog(
    seat: string,
    text: string,
    title: string | undefined,
  ): Promise<AppendRepoLogOutcome> {
    return this.mutate(async () => {
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
    });
  }

  /** P8.3: read one day's log fresh from disk (never cached). Defaults to today. */
  async log(date?: string): Promise<LogFile | null> {
    const day = date ?? toIso(this.now()).slice(0, 10);
    const path = join(this.logDir, `${day}.md`);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return null;
    }
    return { date: day, text, blocks: parseLogBlocks(text) };
  }

  /**
   * RCB-47: the newest block `seat` wrote, searching back across every day in `.repoboard/log/`
   * (OWN dir only — not `cfg.logDir`, which `check` reads as an additional read-only source; a
   * seat's own last block is by definition one it wrote with `repoboard log`, which only ever
   * writes `.repoboard/log/`). Fresh from disk each call, never cached, like `log()`.
   */
  async lastRepoLogBlock(seat: string): Promise<{ date: string; block: LogBlock } | null> {
    const infos = await this.loadLogInfoFrom(this.logDir);
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
    const [ownBlock, coordinatorBlock] = await Promise.all([
      this.lastRepoLogBlock(name),
      this.lastRepoLogBlock('coordinator'),
    ]);
    return seatBundleCore({
      name,
      now: this.now(),
      seatsSection: this.stateDoc?.sections.seats ?? null,
      ownBlock,
      coordinatorBlock,
      cards: this.list(),
    });
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
    const findings = checkFindings({
      state: this.stateDoc,
      logs,
      cards: this.list(),
      config: this.cfg,
      leases: this.leasesDoc,
      now,
      cost,
    });
    return { findings, exitCode: exitCodeForFindings(findings, strict) };
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
   * P8.5: `sync-issues`'s own close — moves a card to the first `done: true` column with a log
   * line naming the cause (`synced: entry closed in <path>`) instead of `moveCard`'s generic
   * line. Same funnel shape as `move`/`ask`/`decide`: one write, one event.
   */
  closeSynced(id: string, path: string, actor: string): Promise<CloseSyncedOutcome> {
    return this.mutate(async () => {
      const card = this.cards.get(id);
      if (!card) return { ok: false, error: `unknown card "${id}"`, notFound: true };
      const columnCounts: Record<string, number> = {};
      for (const c of this.cards.values()) {
        if (c.id !== id) columnCounts[c.status] = (columnCounts[c.status] ?? 0) + 1;
      }
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
   * K10 / plan §11 O7: pointing at a directory is a read-only act. Called first in both writers,
   * before any directory is created, so a refused mutation leaves the target byte-identical.
   */
  private refuseWriteWithoutBoard(): void {
    if (!this.board) throw new MapOnlyError();
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
    const tmp = `${this.leasesPath}.tmp`;
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, this.leasesPath);
    this.leasesDoc = doc;
    this.emit('leases', doc);
  }

  /** Atomic: write `<file>.tmp`, rename over the target, then update the cache (mirrors `writeLeases`). */
  private async writeState(text: string): Promise<void> {
    this.refuseWriteWithoutBoard();
    await mkdir(this.repoboardDir, { recursive: true });
    const tmp = `${this.statePath}.tmp`;
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
   * Every `.repoboard/log/*.md` file's date, mtime and parsed blocks, merged with `board.yml`'s
   * `logDir` (P8.6, locked decision 1) when configured — an ADDITIONAL read-only source `check`
   * looks at, resolved relative to `this.root`. `repoboard log` never writes there; only
   * `.repoboard/log/` is ever written by this store. `check`'s pure input.
   */
  private async loadAllLogInfo(): Promise<LogFileInfo[]> {
    const own = await this.loadLogInfoFrom(this.logDir);
    const extra = this.cfg.logDir
      ? await this.loadLogInfoFrom(resolve(this.root, this.cfg.logDir))
      : [];
    return [...own, ...extra];
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
        if (rel === 'leases.yml') {
          return this.loadLeases().then(() => {
            this.emit('leases', this.leasesDoc);
          });
        }
        if (rel === 'STATE.md') {
          if (event === 'unlink') {
            this.stateDoc = null;
            this.emit('state', null);
            return Promise.resolve();
          }
          return this.loadState().then(() => {
            this.emit('state', this.stateDoc);
          });
        }
        const logMatch = /^log\/([^/]+)\.md$/.exec(rel);
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
