/**
 * P2.2 Card store. The in-memory map is a cache of `.repoboard/` on disk, never the other way
 * around (D6): every mutation goes through @repoboard/core, is written atomically (tmp + rename),
 * and the chokidar watcher re-reads whatever changes on disk — including our own writes,
 * which it recognises by content hash and does not double-report.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Stats } from 'node:fs';
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  type AddWindowInput,
  addNote as addNoteCore,
  addWindow,
  appendLogBlock,
  appendLogLine,
  askDecision,
  type BoardConfig,
  boardDisplayName,
  boardShortName,
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
  decideSeatClaim,
  decideSeatWrite,
  defaultBoardConfig,
  type Event,
  exitCodeForFindings,
  type Finding,
  findSeatLine,
  formatHolder,
  formatLogBlock,
  formatLogLine,
  formatSeatBullet,
  type GateMemberFacts,
  holderLabel,
  holderLiveness,
  homeSeatRows,
  initialStateText,
  type LeaseMutationResult,
  type LeasesDoc,
  type LogBlock,
  type LogFileInfo,
  lastBlockFor,
  moveCard,
  NO_PANE_TAG,
  normalizeSeatName,
  paneTag,
  parseBoard,
  parseCard,
  parseHolder,
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
  type SeatCheckHome,
  type SeatClaimInput,
  type SeatHolder,
  type SeatHolderInfo,
  type SeatLeaseView,
  type SeatListRow,
  type SeatNameResult,
  type SeatSighting,
  type SeatWriteDecision,
  type SeatWriteVerb,
  type StateDoc,
  type StateSectionName,
  type SystemsDoc,
  sameHolder,
  seatBulletTexts,
  seatBundle as seatBundleCore,
  seatCheckFindings,
  seatHolderInfos,
  seatMovedText,
  seatSightings as seatSightingsCore,
  seatUpConflict,
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
import { probeHolder, writeSeatsFile } from './holder.js';
import { excludeSeatsFromLocalGit, localDir, localStatus } from './local.js';
import { detectSystems } from './systems-detect.js';
import { getWatchDiag } from './watch-diag.js';
import { resolveMemberRoot } from './workspace.js';

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

/**
 * RCB-184: this board's HOME (`board.yml`'s `workspace:`), read READ-ONLY by `CardStore.readHome`.
 * `ok: true` — `name` is the home's `boardDisplayName`, `rows` are its OWN seats (`homeSeatRows`,
 * named `[<name>] <seat>`; `[]` only when its SEATS section has no seat bullet), `holderError` is
 * its `seats.yml`'s read error (`null` when read: the rows' holder columns are then `null`, like
 * `seat list`'s own), `listsMember` whether its `repos:` has a root resolving to THIS repo.
 * `ok: false` — the home could not be read, `error` says why (no `.repoboard/`, no STATE.md,
 * a board.yml or STATE.md that does not parse); never an empty `rows` standing for that.
 * `configured` is the `workspace:` text as written — what a message names, never a resolved path.
 */
export type HomeRead =
  | {
      ok: true;
      configured: string;
      name: string;
      rows: SeatListRow[];
      holderError: string | null;
      listsMember: boolean;
    }
  | { ok: false; configured: string; error: string };

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
  /**
   * RCB-164: `writeFile` is `open(O_TRUNC)` then a separate `write` — a gap between the two lets
   * the watcher (or the reconcile sweep) read a 0-byte card file that is mid-write, not removed.
   * This is how long `refreshCard` holds a 0-byte read of a path that already maps to a card
   * before re-checking it, instead of treating it as a real removal right away. Default `1000`ms.
   * `<= 0` reproduces today's un-held behaviour exactly (the control): a 0-byte read of a known
   * card is `card:removed` + `invalid` immediately (see `refreshCard`).
   */
  emptyGraceMs?: number;
  /**
   * RCB-157D: on macOS, chokidar sometimes delivers no fs event at all for a write under
   * `.repoboard/` (measured, RCB-157B: 65/1080 trials, 0/1080 on Linux) — a board can silently
   * stop showing an external edit until the next restart. This is how often, in ms, a periodic
   * sweep re-stats the tracked files and routes anything `seen` says the watcher never reported.
   * Default `2000` when `watch` is true, else `0`. `<= 0` turns it off. It reconciles what the
   * watcher lost; it is not a poller the board depends on — every mutation this store makes is
   * still reported by the watcher (or, one-shot, not at all), and the sweep only ever routes a
   * change nobody has already routed (see `CardStore.seen`).
   */
  reconcileMs?: number;
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

/**
 * RCB-197: `setSeatBullet` outcome. `refused` marks the one failure that is a DECISION, not a
 * fault: an `--up` the claim rule turned down (another live holder, this pane already holds
 * another seat, a bad `--from`), or (RCB-198) a `--down` by a pane that does not hold the seat —
 * nothing was written and `error` is the exact text to show the caller. Every other `{ok:false}`
 * is a fault or a bad request (an unparseable STATE.md or seats.yml, a log the audit could not be
 * appended to, a foreign board's prefix). `released` is the seat the same write stood DOWN
 * (`--from`), `audit` the title of the log block written before the takeover (RCB-198: before a
 * `--force` over another holder's `--down`); `null` when there was none.
 */
export type SetSeatOutcome =
  | { ok: true; doc: StateDoc; text: string; released: string | null; audit: string | null }
  | { ok: false; error: string; readOnly?: boolean; refused?: boolean };

/** RCB-197: what a caller may ask of `setSeatBullet` beyond the bullet — `--force` and `--from <seat>`. */
export interface SeatBulletOptions {
  force?: boolean;
  from?: string;
}

/**
 * RCB-198: what a caller may ask of `updateSeatBullet` and `appendSeatLog` beyond the write —
 * `--force` (MCP `force: true`, HTTP `force: true`) writes a seat another pane holds, audited in
 * the log. It overrides another holder, never a seat nobody holds (that needs no override).
 */
export interface SeatWriteOptions {
  force?: boolean;
}

/**
 * RCB-198: a write the holder-only rule (`decideSeatWrite`) turned down, or a `seats.yml` that
 * does not parse — the ok:false shape `withSeatWriteGuard` hands back before `body` runs. `refused`
 * is true for the DECISION (nothing written, `error` is the exact text to show the caller); it is
 * absent for the fault.
 */
interface SeatWriteFailure {
  ok: false;
  error: string;
  refused?: true;
}

/** RCB-88: `updateSeatBullet` outcome — `SetStateOutcome`'s ok branch plus the rewrite's own
 * `status`/`stamp` (the ones KEPT, not restamped), so the CLI can echo them without re-parsing
 * the bullet it just got back. RCB-198: `refused` marks the holder-only refusal, as in `SetSeatOutcome`. */
export type UpdateSeatOutcome =
  | { ok: true; doc: StateDoc; text: string; status: 'UP' | 'DOWN'; stamp: string }
  | { ok: false; error: string; readOnly?: boolean; refused?: boolean };

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
 * got restamped (only when `seat` had an UP bullet in SEATS at the moment of the call). RCB-198:
 * `refused` marks the holder-only refusal, as in `SetSeatOutcome`. */
export type AppendSeatLogOutcome =
  | { ok: true; date: string; text: string; block: LogBlock; restamped: boolean }
  | { ok: false; error: string; readOnly?: boolean; refused?: boolean };

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

/**
 * RCB-171: thrown by `writeState`/`writeLog` — the only two ways STATE.md or a log file reaches
 * disk — in exactly one situation: the write would CREATE a STATE.md (or a log directory) while
 * the repo root's `.gitignore` ignores `.repoboard/local/` and that directory is absent here.
 * That is a checkout whose private layer is missing (a git worktree, a fresh clone — gitignored
 * files do not travel): creating the record then would put private STATE/log into TRACKED
 * paths. Everywhere else the store still scaffolds on first write (`PUT /api/state/section`,
 * `set_state_section`, `log`, `seat --up` on a bare board). `mutate` converts it to
 * `{ok:false, error}` (the CLI exits 1 through its ordinary `UserError` mapping; MCP/HTTP surface
 * the same string). Same shape as `MapOnlyError`, for the same reason: a check the caller has to
 * remember is a check the caller eventually forgets.
 */
export class RefusedCreateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusedCreateError';
  }
}

/**
 * RCB-196: thrown by `refuseLinkedWorktree` — the ONE way a seat verb or a log append is stopped
 * in a linked git worktree (`git worktree add`), where the nearest `.repoboard/` is the worktree's
 * OWN tracked copy and a write there forks the board's record instead of updating it. Same shape
 * as `RefusedCreateError`, converted by `mutate` to `{ok:false, error}` (the CLI exits 1 through
 * its ordinary `UserError` mapping; MCP/HTTP surface the same string).
 */
export class LinkedWorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkedWorktreeError';
  }
}

const execFileP = promisify(execFile);

/** RCB-196: git's own "where am I" variables — inherited from a hook, they would make
 * `git -C <root>` answer about some OTHER repository than the one at `<root>`. */
const GIT_LOCATION_ENV: ReadonlySet<string> = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
]);

/** `git` is a local, instant read; a hung one must not hang a seat verb. */
const GIT_TIMEOUT_MS = 5000;

/**
 * RCB-196: when `root` sits in a LINKED git worktree, the main checkout's directory that
 * corresponds to it — `null` when it does not (a plain checkout, a submodule), AND when that
 * cannot be told (no `git`, not a repository, git older than `--path-format`, a timeout, output of
 * an unexpected shape): an unconfigured rule is inert, the write proceeds as it did before this
 * check existed. Linked iff the worktree's own git dir differs from the repository's common dir
 * (compared through `realpath`, so a symlinked tmpdir never makes a checkout look linked). The main
 * directory is `<common dir's parent>/<root's path below the worktree's top level>` when the common
 * dir is a `.git`; a bare repository's worktree has no main checkout, so the common dir itself is
 * named. `root` is realpath'd before `relative` (macOS: `/var` is `/private/var`).
 */
async function mainCheckoutOfLinkedWorktree(root: string): Promise<string | null> {
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !GIT_LOCATION_ENV.has(key)),
    );
    const { stdout } = await execFileP(
      'git',
      [
        '-C',
        root,
        'rev-parse',
        '--path-format=absolute',
        '--git-dir',
        '--git-common-dir',
        '--show-toplevel',
      ],
      { env, encoding: 'utf8', timeout: GIT_TIMEOUT_MS },
    );
    const lines = stdout.split('\n').filter((l) => l.length > 0);
    const [gitDir, commonDir, topLevel] = lines;
    if (
      lines.length !== 3 ||
      gitDir === undefined ||
      commonDir === undefined ||
      topLevel === undefined ||
      !lines.every((l) => isAbsolute(l))
    ) {
      return null;
    }
    const [gitReal, commonReal] = await Promise.all([realpath(gitDir), realpath(commonDir)]);
    if (gitReal === commonReal) return null;
    if (basename(commonReal) !== '.git') return commonReal;
    const below = relative(await realpath(topLevel), await realpath(root));
    return join(dirname(commonReal), below);
  } catch {
    return null;
  }
}

/**
 * RCB-196: the refusal for `setStateSection('seats', …)` without `force`, in one place — the CLI,
 * HTTP and MCP all surface this string, so it names each surface's spelling of the override.
 */
const SEATS_BY_SEAT_VERBS_ERROR =
  'SEATS is written by seat verbs: run `repoboard seat <name> --up|--down|--update "<text>"` ' +
  '(one bullet, re-read under the lock). Replacing the whole section from your copy can revert ' +
  "another seat's bullet; if you mean it, pass --force (MCP: force: true, HTTP: force: true).";

/**
 * RCB-207: the audit block of a `--force`d whole-SEATS rewrite (`setStateSection('seats', …,
 * {force: true})`) — the same `{title, text}` shape and `; written by <who>` tail as RCB-198's
 * `decideSeatWrite` audits, appended through the same `doAppendRepoLog`. It carries the actor the
 * call carries and nothing local: no pid, host or session (the log is git-tracked).
 */
function forcedSeatsAudit(actor: string): { title: string; text: string } {
  return {
    title: 'state --set-section SEATS --force over any holder',
    text: `SEATS rewritten whole with force, bypassing seat holders; written by ${actor}`,
  };
}

/** RCB-171: a `.gitignore` line (already trimmed) that ignores the local layer. */
const LOCAL_LAYER_GITIGNORE_LINE = /^\/?\.repoboard\/local\/?$/;

const CARD_FILE = /^[^/\\]+\.md$/;

/** RCB-157D: reconcile's stand-in for chokidar's `awaitWriteFinish` — a file modified less than
 * this long ago may be mid-write (a half-appended events.jsonl line would be read, skipped past,
 * and lost), so the sweep leaves it for the next tick. */
const RECONCILE_SETTLE_MS = 250;

/** RCB-132: `appendArchiveText`'s header, written once, the first time `<path>` is created. */
const ARCHIVE_HEADER = '# LAST LANDINGS archive';

/** RCB-198: why a log block cannot be appended for this `seat` and `text` — `null` when it can. The
 * ONE spelling of these two refusals: `doAppendRepoLog` makes them, and `appendSeatLog` makes them
 * BEFORE it writes an audit block, so a `--force` never leaves an audit for a block that then fails. */
function logInputError(seat: string, text: string): string | null {
  if (seat.trim().length === 0) return 'seat must not be empty';
  if (text.trim().length === 0) return 'text must not be empty';
  return null;
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** RCB-195: a `seats.yml` lease resource is `seat:<name>` — the ONE spelling of that prefix. */
const SEAT_LEASE_PREFIX = 'seat:';

/** RCB-197: the holder of a caller that has none (no `holderFromEnv` — an HTTP door, a test). */
const NO_HOLDER: SeatHolder = { pane: null, session: null, start: null, host: null, pid: null };

/** RCB-197: what one `setSeatBullet` call asks for, after the seat door and before any lock. */
interface SeatBulletRequest {
  name: string;
  status: 'UP' | 'DOWN';
  text: string;
  /** Who is running the command; `null` = nobody (no `holderFromEnv`). */
  holder: SeatHolder | null;
  force: boolean;
  /** `--from`, already through `seatName`; `null` = none given. */
  from: string | null;
}

/** RCB-198: what `checkSeatWrite` decides on — one seat's write by `seat --down`, `--update` or `log --as`. */
interface SeatWriteRequest {
  /** The seat being written, bare (`builder`). */
  seat: string;
  verb: SeatWriteVerb;
  /** Who is running the command; `null` = nobody (serve's HTTP door, a test) — shown as `web`. */
  holder: SeatHolder | null;
  force: boolean;
}

/** RCB-197: one SEATS bullet to write, in the order `planSeatBullet` applies them. */
interface SeatBulletEdit {
  name: string;
  status: 'UP' | 'DOWN';
  text: string;
  label: string | null;
}

/** RCB-197: `seats.yml` as `setSeatBulletHeld` read it under its lock, with each seat lease's liveness. */
interface SeatLeasesRead {
  doc: LeasesDoc;
  views: readonly SeatLeaseView[];
  holder: SeatHolder;
}

/**
 * RCB-197: what `planSeatWrite` decided — the bullets, the `seats.yml` to write (`null` = leave it
 * alone), the seat stood DOWN by `--from`, and the audit block to append before any of it.
 */
interface SeatWritePlan {
  edits: SeatBulletEdit[];
  leases: LeasesDoc | null;
  released: string | null;
  audit: { title: string; text: string } | null;
  /**
   * RCB-217: the pane tag of the pane that ran this write — what the `seat` events it appends carry
   * as `resource`. `null` (the events say no pane) when no holder is recorded: a board with no local
   * layer, a caller with no holder (serve's HTTP door), or a holder with no pane.
   */
  tag: string | null;
}

/**
 * RCB-195: what `seats.yml` looks like after `seat` goes UP or DOWN — pure, no I/O, no clock.
 *
 * - UP: the lease `seat:<seat>` becomes `{holder: formatHolder(holder), since}`, REPLACING whatever
 *   lease that seat had (whether it MAY is `decideSeatClaim`'s call, made before this runs). The
 *   bullet label is `<tag> · <shortName> <seat>` when the holder has a pane — `paneTag` widens the
 *   tag from 4 to 6 characters only when ANOTHER seat's pane shares its first four — and `null`
 *   (no label, the lease still recorded) when it has none. RCB-197: a lease whose resource is in
 *   `dead` (its process is gone, `holderLiveness`) is not a live holder and never widens the tag.
 * - DOWN: the lease is removed; no label. `changed` is false when there was no lease to remove, so
 *   a DOWN on a board that never recorded a holder does not create the file.
 *
 * Every other lease, every window and every unknown key is kept as it was.
 */
function seatHolderLeases(
  doc: LeasesDoc,
  input: {
    seat: string;
    status: 'UP' | 'DOWN';
    holder: SeatHolder;
    since: string;
    shortName: string;
    /** Resources (`seat:<name>`) whose recorded holder is dead — required, so a caller that has
     *  measured nothing says so with an empty set and every lease counts, as before RCB-197. */
    dead: ReadonlySet<string>;
  },
): { doc: LeasesDoc; label: string | null; changed: boolean } {
  const resource = `${SEAT_LEASE_PREFIX}${input.seat}`;
  const others = doc.leases.filter((l) => l.resource !== resource);
  if (input.status === 'DOWN') {
    return {
      doc: { ...doc, leases: others },
      label: null,
      changed: others.length !== doc.leases.length,
    };
  }
  const otherPanes = others
    .filter((l) => l.resource.startsWith(SEAT_LEASE_PREFIX) && !input.dead.has(l.resource))
    .flatMap((l) => {
      const pane = parseHolder(l.holder).pane;
      return pane === null ? [] : [pane];
    });
  const lease = { resource, holder: formatHolder(input.holder), since: input.since };
  return {
    doc: { ...doc, leases: [...others, lease] },
    label:
      input.holder.pane === null
        ? null
        : holderLabel(paneTag(input.holder.pane, otherPanes), input.shortName, input.seat),
    changed: true,
  };
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
  /** RCB-195: `.repoboard/local/seats.yml` — who holds each seat (pane, session, pid, host). Beside
   * STATE.md, never in anything git-tracked (this repo is public), with its own file lock. */
  readonly seatsPath: string;
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

  /** RCB-196: `refuseLinkedWorktree`'s memoized answer — a root does not move between worktrees
   * while a store is open, so `git` is asked once per store. */
  private linkedWorktreeCheck: Promise<void> | null = null;

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
  /** RCB-164: how long `refreshCard` holds a 0-byte read of a known card before re-checking it —
   * see `OpenStoreOptions.emptyGraceMs`. */
  private readonly emptyGraceMs: number;
  /** RCB-164: one outstanding empty-read grace timer per absolute card path — see `refreshCard`'s
   * own doc comment on the hold this backs. Keyed by path alone (one timer per path: a second
   * empty read for a path already holding one schedules nothing — see the caller). Cleared
   * entirely by `close()`, like `pendingClaims`. */
  private readonly pendingEmptyReads = new Map<string, ReturnType<typeof setTimeout>>();
  /** RCB-83: does `.repoboard/local/` exist? Decided once, in `load()` — see `hasBoard`'s own
   * doc comment for why this is not re-derived while the server runs. */
  private hasLocalLayer = false;
  /** RCB-93: does `.repoboard/local/log/` exist? Precomputed once in `load()` (alongside
   * `hasLocalLayer`) so `resolveLogDir()` can stay synchronous — see its own doc comment. */
  private hasLocalLog = false;
  /**
   * RCB-157D: the last `${mtimeMs}:${size}` this store has ROUTED for each absolute path under
   * `.repoboard/` it tracks — updated at the START of every routed task (`routeChange`'s own
   * `updateSeen`), whether the route came from chokidar or from `reconcile()` itself. This is
   * the one piece of state that lets the sweep tell "nobody has reported this change yet" from
   * "the watcher already handled it": a path whose current stat matches its `seen` entry is
   * never routed twice.
   */
  private readonly seen = new Map<string, string>();
  /**
   * RCB-157E: which source (`'watch'` or `'reconcile'`) last recorded the path's CURRENT `seen`
   * key — set by `updateSeen` in lockstep with `seen` itself (same set/delete points), never
   * written anywhere else. Lets `routeChange`'s task tell "the other source already routed this
   * exact change" (cross-source repeat: skip it) from "this source is seeing its own change
   * again" (same-source repeat: never skip — see the skip rule's own doc comment).
   */
  private readonly seenVia = new Map<string, 'watch' | 'reconcile'>();
  /** RCB-157D: routed-but-not-yet-run tasks per resolved absolute path. `seen` only updates when
   * a task RUNS, so without this a sweep in the gap between enqueue and run would route the same
   * change twice (cards hide it behind `refreshCard`'s hash; systems/leases/state/log would emit
   * twice). `reconcile()` skips any path with a count > 0. */
  private readonly routing = new Map<string, number>();
  /** RCB-157D: `reconcile()`'s own reentrancy guard — an interval tick that fires while the
   * previous sweep is still stat-ing the tracked set is simply skipped; the next tick tries
   * again. */
  private reconciling = false;
  /** RCB-157D: `setInterval` handle for the reconcile sweep, `null` when `reconcileMs <= 0`.
   * `unref()`d so it never keeps the process alive; cleared by `close()` before the watcher
   * closes. */
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  /** RCB-193: the promise of the reconcile sweep that is (or last was) in flight, so `close()` can
   * wait for a sweep caught mid-`stat` instead of letting it settle after `close()` resolved.
   * Only the tick that STARTS a sweep records its promise — a tick that finds one still running
   * bails at once (`reconciling`) and its instantly-resolved promise must never displace the
   * running sweep's. Never rejects: `reconcile()` catches everything itself. */
  private sweeping: Promise<void> = Promise.resolve();
  /** RCB-193: set first thing by `close()`. The two timer arms a still-running queued task can
   * reach AFTER `close()` has cleared the timers — `schedulePendingClaim` (K8) and
   * `scheduleEmptyRecheck` (RCB-164) — read it and arm nothing, or the new timer would fire, and
   * write or emit, on a closed store. */
  private closed = false;
  /** RCB-157D: `OpenStoreOptions.reconcileMs` as given, before `load()` applies its
   * watch-dependent default — see `OpenStoreOptions.reconcileMs`'s own doc comment. */
  private readonly reconcileMsOpt: number | undefined;

  constructor(root: string, opts: OpenStoreOptions = {}) {
    super();
    this.root = resolve(root);
    this.repoboardDir = join(this.root, '.repoboard');
    this.cardsDir = join(this.repoboardDir, 'cards');
    this.boardPath = join(this.repoboardDir, 'board.yml');
    this.eventsPath = join(this.repoboardDir, 'events.jsonl');
    this.leasesPath = join(this.repoboardDir, 'leases.yml');
    this.seatsPath = join(localDir(this.root), 'seats.yml');
    this.systemsPath = join(this.repoboardDir, 'systems.yml');
    this.statePath = join(this.repoboardDir, 'STATE.md');
    this.logDir = join(this.repoboardDir, 'log');
    this.now = opts.now ?? (() => new Date());
    this.claimGraceMs = opts.claimGraceMs ?? 1000;
    this.emptyGraceMs = opts.emptyGraceMs ?? 1000;
    this.reconcileMsOpt = opts.reconcileMs;
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
    const reconcileMs = this.reconcileMsOpt ?? (watch ? 2000 : 0);
    if (reconcileMs > 0) {
      // RCB-157D: seed `seen` for the tracked set AFTER the watcher is ready (if any) — whichever
      // of chokidar's own backlog or this fill runs second still finds the same disk state the
      // first one just read, so nothing here is ever mistaken for a "lost" change. No routing: a
      // file that already existed when this store opened is not a change reconcile ever reports.
      // Only when the sweep is on — a CLI one-shot never stats every card for nothing.
      await this.fillSeenBaseline();
      this.reconcileTimer = setInterval(() => {
        // RCB-193: keep the promise of the sweep this tick STARTS (see `sweeping`) — `reconciling`
        // is read before the call because `reconcile()` sets it synchronously on a real start.
        const startsSweep = !this.reconciling;
        const run = this.reconcile();
        if (startsSweep) this.sweeping = run;
      }, reconcileMs);
      this.reconcileTimer.unref();
      // RCB-157E1: opt-in trace, off unless the recorder is on — records that the sweep is armed
      // and at what period, so a DIAG dump can tell "the sweep never ran" from "it ran and saw
      // nothing" (see `reconcile()`'s own `'sweep'` row below).
      getWatchDiag()?.record(this.root, 'reconcile-on', reconcileMs);
    }
  }

  /**
   * RCB-193: once `close()` resolves, this store writes and emits nothing more for work that was
   * started before it — no queued `refreshCard` appending its `file:move`, no sweep tick still
   * mid-`stat`, no grace timer firing. Order: stop the sweep interval, cancel the grace timers,
   * close the watcher, wait for a sweep already in flight, then drain `this.queue` until it stops
   * changing (a task can enqueue another). The watcher closes before the drain so nothing new is
   * routed into a queue being emptied, and `closed` (set first) stops a task that is still
   * running from arming a fresh grace timer after the clears below have already run. Mutations
   * called AFTER `close()` are out of scope: they still run through the queue, exactly as before.
   * A second `close()` is a harmless no-op (the tests' `afterEach` closes every store again).
   */
  async close(): Promise<void> {
    this.closed = true;
    // RCB-157D: stop the sweep first — before the watcher closes and before any grace timer is
    // cancelled — so a tick that is already mid-flight cannot route a change through a watcher
    // that is (or is about to be) gone.
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    // K8: cancel every outstanding grace timer first — none may fire (and so emit or append)
    // once close() has been called.
    for (const pending of this.pendingClaims.values()) clearTimeout(pending.timer);
    this.pendingClaims.clear();
    // RCB-164: same rule — no empty-read recheck may fire once close() has been called.
    for (const timer of this.pendingEmptyReads.values()) clearTimeout(timer);
    this.pendingEmptyReads.clear();
    const w = this.watcher;
    this.watcher = null;
    if (w) await w.close();
    // RCB-193: a sweep caught mid-`stat` sees `reconcileTimer === null` and routes nothing more,
    // but it is still running — let it finish before the drain, so anything it managed to route
    // is already on the queue when the drain looks.
    await this.sweeping;
    // RCB-193: `queue` never rejects (`enqueue` swallows into it), so this cannot throw. A task
    // that enqueues another replaces `this.queue` while it runs — loop until the promise awaited
    // is still the current tail.
    let tail: Promise<unknown>;
    do {
      tail = this.queue;
      await tail;
    } while (tail !== this.queue);
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
   * command that rewrites it. The one exception (RCB-171): `writeState` refuses to create it when
   * the root's `.gitignore` ignores `.repoboard/local/` and that directory is missing (a worktree).
   *
   * RCB-196: `'seats'` is written by the seat verbs (`setSeatBullet`/`updateSeatBullet`, one
   * bullet at a time, re-read under the lock). Replacing the WHOLE section from the caller's own
   * copy reverted another seat's UP on 2026-09-27, so without `opts.force` it is `{ok:false}` with
   * NOTHING written. `force` is a property of the request, not of the store: the CLI passes it for
   * `--force`, MCP for `force: true`, HTTP only when the body says `force: true`.
   *
   * RCB-207: a forced SEATS write appends ONE audit block (`forcedSeatsAudit`, by `actor`) before
   * it writes, the way RCB-198 audits every other forced seat write; any other section: none.
   */
  setStateSection(
    section: StateSectionName,
    body: string,
    actor: string,
    opts: { force?: boolean } = {},
  ): Promise<SetStateOutcome> {
    return this.mutate(async () => {
      // RCB-206: refused from a linked worktree before anything else, like every seat verb.
      await this.refuseLinkedWorktree();
      this.refuseWriteWithoutBoard();
      if (section === 'seats' && opts.force !== true) {
        return { ok: false as const, error: SEATS_BY_SEAT_VERBS_ERROR };
      }
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
        // RCB-207: a forced SEATS rewrite is audited like every other forced seat write since
        // RCB-198. The block goes FIRST, after the only refusal that can happen above, so a
        // failure there stops the write (a `--force` never leaves an unaudited SEATS) and a
        // refused write leaves no audit. `doAppendRepoLog`, not `appendRepoLog`: this runs inside
        // `mutate`. Lock order STATE.md, then the log's own — as `runSeatUpdate`.
        if (section === 'seats' && opts.force === true) {
          const audit = forcedSeatsAudit(actor);
          const audited = await this.doAppendRepoLog(actor, audit.text, audit.title);
          if (!audited.ok) return { ok: false as const, error: audited.error };
        }
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
   * `setStateSection` (and refused in the same one RCB-171 case).
   *
   * RCB-195: `holder` (who is running the command, `holderFromEnv` at the CLI entry) is recorded
   * in `.repoboard/local/seats.yml`, never in anything git-tracked. `null` — or a board with no
   * local layer (`hasLocalLayer`, the RCB-171 rule: nothing private has anywhere to live) — is
   * exactly the write this method made before RCB-195: STATE.md under its own lock, no holder, no
   * label, seats.yml untouched.
   *
   * RCB-197: UP is a CLAIM, and it is decided HERE, inside the locks, on every path — the CLI no
   * longer decides. It used to, on the STATE.md it loaded at open, outside any lock: two panes both
   * read "DOWN" and both wrote UP (RCB-194). Now `decideSeatClaim` (core) makes the call from what
   * is read under the locks — STATE.md's fresh bullet, the newest log block, and (holder + local
   * layer) each recorded holder in seats.yml with its pid probed (`probeHolder`) — and a refusal is
   * `{ok:false, refused:true}` with NOTHING written. On an ok it writes, in this order: the audit
   * block when the takeover needs one (`doAppendRepoLog` — a failure stops everything after it),
   * then ONE STATE.md write (this seat UP and, for `opts.from`, the seat the pane leaves DOWN),
   * then seats.yml. `opts.from` needs a local layer: without one no holder is recorded, so there is
   * nothing to move.
   *
   * RCB-198: DOWN is guarded now — a seat is stood down by the pane that holds it. With a local
   * layer EVERY DOWN (a `holder` of `null` too: serve's HTTP door, "web") takes seats.yml's lock,
   * then STATE.md's, and `checkSeatWrite` decides on the lease read under them: a pane that is not
   * the recorded holder is `{ok:false, refused:true}` with NOTHING written, unless `opts.force`,
   * which writes and audits it (the audit block first, as for an UP takeover). Every DOWN drops the
   * seat's lease. A seat with no lease (a legacy bullet) is stood down by anyone, and a board with
   * no local layer is exactly the write it was before RCB-198.
   */
  setSeatBullet(
    typedName: string,
    status: 'UP' | 'DOWN',
    text: string,
    holder: SeatHolder | null = null,
    opts: SeatBulletOptions = {},
  ): Promise<SetSeatOutcome> {
    return this.mutate(async () => {
      // RCB-188: the seat door, first and unconditionally — see `seatName`.
      const named = this.seatName(typedName);
      if (!named.ok) return { ok: false as const, error: named.error };
      const name = named.name;
      // RCB-196: refused from a linked worktree before any lock or write (seats.yml included).
      await this.refuseLinkedWorktree();
      this.refuseWriteWithoutBoard();
      // RCB-197: `--from` names a seat too, so it goes through the same door.
      let from: string | null = null;
      if (opts.from !== undefined) {
        if (status === 'DOWN') {
          return { ok: false as const, error: 'seat: --from is only valid with --up' };
        }
        const movedFrom = this.seatName(opts.from);
        if (!movedFrom.ok) return { ok: false as const, error: movedFrom.error };
        from = movedFrom.name;
      }
      const req: SeatBulletRequest = {
        name,
        status,
        text,
        holder,
        force: opts.force === true,
        from,
      };
      if (this.hasLocalLayer && (holder !== null || status === 'DOWN')) {
        return this.setSeatBulletHeld(req, holder);
      }
      return withFileLock(this.statePath, () => this.runSeatWrite(req, null));
    });
  }

  /**
   * RCB-195: `setSeatBullet` with a holder — the ONE function that touches both `seats.yml` and
   * STATE.md, and the ONE place their lock order is written: `seats.yml` first, then STATE.md
   * (RCB-194 P3; nothing takes them the other way round, so two seats can never deadlock; the log's
   * own lock, taken by the RCB-197 audit block, comes last). Both files are READ inside their
   * locks, so a concurrent seat's write is never overwritten by a stale copy (the `mutateLeases`
   * pattern), and both are parsed and the new STATE.md text built BEFORE either is written: a
   * `seats.yml` or STATE.md that does not parse is `{ok:false}` with NOTHING written. STATE.md is
   * written first, `seats.yml` second — if the second write fails, the bullet says what happened
   * and seats.yml is merely behind (a seat with no recorded holder, today's behaviour), never
   * ahead of it. `excludeSeatsFromLocalGit` runs before any of it, so the file is never on disk
   * unexcluded; if that throws, nothing is written. No holder reaches `events.jsonl`:
   * `appendSeatEvents` (RCB-217) writes the status change and the pane TAG, never the holder.
   *
   * RCB-197: an UP probes every recorded holder once, here under `seats.yml`'s lock (nothing can
   * change them meanwhile), before STATE.md's is taken; a DOWN needs no liveness and probes nobody.
   *
   * RCB-198: a DOWN comes here with a `holder` of `null` too (no pane to record, but the lease it
   * would drop is somebody's): `runSeatWrite` then decides it against the lease read here.
   */
  private async setSeatBulletHeld(
    req: SeatBulletRequest,
    holder: SeatHolder | null,
  ): Promise<SetSeatOutcome> {
    await excludeSeatsFromLocalGit(this.root);
    return withFileLock(this.seatsPath, async () => {
      const read = await this.readSeatsDoc();
      if (!read.ok) return { ok: false as const, error: `${read.error}; nothing was written` };
      const views = req.status === 'UP' ? await this.probeSeatLeases(read.doc) : [];
      return withFileLock(this.statePath, () =>
        this.runSeatWrite(req, { doc: read.doc, views, holder: holder ?? NO_HOLDER }),
      );
    });
  }

  /**
   * RCB-195/RCB-198: `seats.yml` read and parsed — the caller holds its lock, so nothing can change
   * it between this read and whatever is decided on it. An absent file is an empty doc; one that
   * does not parse, or that cannot be read (EACCES, EISDIR — RCB-206), is `{ok:false}`, and every
   * WRITE caller writes NOTHING then (a hand edit is never overwritten, and a lease that cannot be
   * read is never treated as absent). The error is bare: the write callers append `; nothing was
   * written`, `seatHolders` (a read) does not.
   */
  private async readSeatsDoc(): Promise<
    { ok: true; doc: LeasesDoc } | { ok: false; error: string }
  > {
    const rel = this.relToRoot(this.seatsPath);
    let existing = '';
    try {
      existing = await readFile(this.seatsPath, 'utf8');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        return { ok: false, error: `${rel}: cannot read: ${err.code ?? err.message}` };
      }
    }
    const parsed = parseLeases(existing, 'seats.yml');
    if (!parsed.ok) return { ok: false, error: `${rel}: ${parsed.error}` };
    return { ok: true, doc: parsed.doc };
  }

  /**
   * RCB-198: `seat`'s recorded lease in `doc`, or `null`. The seat is matched the way its bullet is
   * (`findSeatLine`: case-insensitive), so a stand-down typed `Builder` cannot slip past the lease
   * `seat:builder` that an UP typed `builder` recorded. `seat` in the answer is the lease's OWN
   * spelling — what a refusal, an audit and the lease's removal must use.
   */
  private seatLeaseOf(
    doc: LeasesDoc,
    seat: string,
  ): { seat: string; holder: SeatHolder; since: string } | null {
    const wanted = `${SEAT_LEASE_PREFIX}${seat}`.toLowerCase();
    const lease = doc.leases.find((l) => l.resource.toLowerCase() === wanted);
    if (lease === undefined) return null;
    return {
      seat: lease.resource.slice(SEAT_LEASE_PREFIX.length),
      holder: parseHolder(lease.holder),
      since: lease.since,
    };
  }

  /**
   * RCB-198 (RCB-194: a pane wrote another pane's seat): THE holder-only check, the one place a
   * seat's stand-down, its `--update` and `log --as <seat>` are decided — `decideSeatWrite` (core)
   * over the lease `seat:<name>` in `doc`, which the caller read under `seats.yml`'s lock. No
   * liveness is measured (a dead holder is still the holder: it is freed only by `--up`'s takeover
   * or its own stand-down), so the labels are built as `planSeatWrite` builds them, minus the dead
   * filter: a pane tag widens from 4 to 6 characters when ANOTHER recorded holder — or the caller —
   * shares its first four, and a holder with no pane is `(no pane)`. A `holder` of `null` (serve's
   * HTTP door) is `web` and never matches a lease, so it needs `force`. Pure: reads nothing,
   * writes nothing; the caller acts on the answer.
   */
  private checkSeatWrite(doc: LeasesDoc, req: SeatWriteRequest): SeatWriteDecision {
    const own = this.seatLeaseOf(doc, req.seat);
    const caller = req.holder ?? NO_HOLDER;
    const shortName = boardShortName(this.cfg);
    const tagPanes = [
      ...doc.leases
        .filter((l) => l.resource.startsWith(SEAT_LEASE_PREFIX))
        .map((l) => parseHolder(l.holder).pane),
      caller.pane,
    ].filter((p): p is string => p !== null);
    const tagOf = (pane: string | null): string =>
      pane === null ? NO_PANE_TAG : paneTag(pane, tagPanes);
    return decideSeatWrite({
      seat: own?.seat ?? req.seat,
      verb: req.verb,
      callerLabel: req.holder === null ? 'web' : `${tagOf(caller.pane)} · ${shortName}`,
      caller,
      lease:
        own === null
          ? null
          : {
              holder: own.holder,
              since: own.since,
              label: holderLabel(tagOf(own.holder.pane), shortName, own.seat),
            },
      force: req.force,
    });
  }

  /**
   * RCB-198: run `body` — the write half of a seat's `--update` or of `log --as` — under the
   * holder-only rule. With a local layer: the write is refused from a linked worktree or a root
   * with no board first (before any lock is created), `seats.yml` is kept out of the local repo
   * (its lock file lives beside it), its lock is taken, the file is read under it and
   * `checkSeatWrite` decides. A refusal (or a file that does not parse) comes back with NOTHING
   * written; on an ok `body` runs INSIDE the lock, handed the audit block to append (`null` =
   * none) before its own write. Nothing here writes seats.yml — these verbs only READ the lease.
   * Without a local layer no holder is recorded, so there is nothing to check and `body(null)`
   * runs as it did before RCB-198. Lock order: seats.yml, then whatever `body` takes.
   */
  private async withSeatWriteGuard<T extends { ok: boolean }>(
    req: SeatWriteRequest,
    body: (audit: { title: string; text: string } | null) => Promise<T>,
  ): Promise<T | SeatWriteFailure> {
    if (!this.hasLocalLayer) return body(null);
    await this.refuseLinkedWorktree();
    this.refuseWriteWithoutBoard();
    await excludeSeatsFromLocalGit(this.root);
    return withFileLock(this.seatsPath, async () => {
      const read = await this.readSeatsDoc();
      if (!read.ok) return { ok: false as const, error: `${read.error}; nothing was written` };
      const decision = this.checkSeatWrite(read.doc, req);
      if (!decision.ok) {
        return { ok: false as const, error: decision.error, refused: true as const };
      }
      return body(decision.audit);
    });
  }

  /**
   * RCB-197: every `seat:<name>` lease in `doc`, its holder parsed back and its process probed
   * (`probeHolder`, then core's `holderLiveness` decides) — all probed at once, in `doc`'s order.
   */
  private probeSeatLeases(doc: LeasesDoc): Promise<SeatLeaseView[]> {
    return Promise.all(
      doc.leases
        .filter((l) => l.resource.startsWith(SEAT_LEASE_PREFIX))
        .map(async (l) => {
          const holder = parseHolder(l.holder);
          return {
            seat: l.resource.slice(SEAT_LEASE_PREFIX.length),
            holder,
            since: l.since,
            liveness: holderLiveness(holder, await probeHolder(holder)),
          };
        }),
    );
  }

  /**
   * RCB-197: the write half of `setSeatBullet`, run with STATE.md's lock held (and `seats.yml`'s,
   * when `seats` is non-null — `seats.doc` is the file as read under it). STATE.md is read FRESH
   * here, decided on, and every text that will be written is built before the first byte is: a
   * refusal, or a text that does not parse, writes nothing. Then the audit block (`doAppendRepoLog`,
   * not `appendRepoLog` — that would queue behind the `mutate` turn this runs in and deadlock; a
   * failure returns before anything else is written), then STATE.md, then `seats.yml`.
   */
  private async runSeatWrite(
    req: SeatBulletRequest,
    seats: SeatLeasesRead | null,
  ): Promise<SetSeatOutcome> {
    const state = await this.readSeatState(req.name);
    if (!state.ok) return { ok: false as const, error: state.error };
    const decided = await this.planSeatWrite(req, state.doc, seats);
    if (!decided.ok) return decided;
    const { plan } = decided;
    const planned = this.planSeatBullet(state, req.name, plan.edits);
    if (!planned.ok) return { ok: false as const, error: planned.error };
    if (plan.audit !== null) {
      const audit = await this.doAppendRepoLog(req.name, plan.audit.text, plan.audit.title);
      if (!audit.ok) return { ok: false as const, error: audit.error };
    }
    const res = await this.commitSeatBullet(planned.text);
    if (plan.leases !== null) await writeSeatsFile(this.seatsPath, serializeLeases(plan.leases));
    await this.appendSeatEvents(state.doc.sections.seats, plan);
    return { ...res, released: plan.released, audit: plan.audit?.title ?? null };
  }

  /**
   * RCB-217: one `seat` event per SEATS bullet whose status this write CHANGED — `seatsBefore` is
   * the section as `runSeatWrite` read it under the locks, so `from` is what the bullet said
   * (`findSeatLine` + `parseSeatStamp`, the way `planSeatWrite` reads it), `null` when the seat had
   * no bullet. A restamp of the status a seat already has changes nothing and appends nothing. The
   * event's `actor` is the seat's name (`SeatBulletEdit.name`, what `seat list` will show) and its
   * `resource` the pane tag the plan decided (`SeatWritePlan.tag`), left out when there is none.
   * Appended LAST — after STATE.md and `seats.yml` — so a watcher that sees the event finds both
   * files already written. The seat a pane leaves (`--from`) is edits[1]; it stands down BEFORE the
   * new seat is taken, so the ticker, which lists newest first, reads "took the seat" on top.
   *
   * The pane tag is the one value here that names a holder. `seats.yml` keeps holders out of git
   * because it lives under `.repoboard/local/`; `events.jsonl` is the board's own file (this repo
   * ignores it, plan §2: "safe to gitignore") and the tag is only the short label `seat list`
   * prints — never the pane id, session, pid or host.
   */
  private async appendSeatEvents(seatsBefore: string, plan: SeatWritePlan): Promise<void> {
    const ts = toIso(this.now());
    for (const edit of [...plan.edits].reverse()) {
      const bullet = findSeatLine(seatsBefore, edit.name);
      const from = bullet === null ? null : (parseSeatStamp(bullet)?.status ?? null);
      if (from === edit.status) continue;
      const event: Event = {
        ts,
        actor: edit.name,
        type: 'seat',
        cardId: null,
        from,
        to: edit.status,
      };
      if (plan.tag !== null) event.resource = plan.tag;
      await this.appendEvent(event);
    }
  }

  /**
   * RCB-217: the pane tag of `caller` as `seat list` would print it next to the recorded holders in
   * `doc` — `paneTag` widened against every recorded seat holder's pane — or `null` when the caller
   * has no pane. The same pane set `checkSeatWrite` widens a DOWN's labels against.
   */
  private callerSeatTag(doc: LeasesDoc, caller: SeatHolder): string | null {
    if (caller.pane === null) return null;
    const panes = [
      ...doc.leases
        .filter((l) => l.resource.startsWith(SEAT_LEASE_PREFIX))
        .map((l) => parseHolder(l.holder).pane),
      caller.pane,
    ].filter((p): p is string => p !== null);
    return paneTag(caller.pane, panes);
  }

  /**
   * RCB-197: what `runSeatWrite` writes, decided — pure over what it is handed, except that the
   * newest log block (a sighting of the seat) is read fresh from disk when the legacy window rule
   * needs it. DOWN (RCB-198): `checkSeatWrite` over the lease in `seats.doc` — refused for a pane
   * that is not the holder unless `force` (audited) — then the seat's bullet and its lease removed;
   * with `seats === null` (no local layer) there is no lease and nobody to ask. UP: `decideSeatClaim`, fed
   *
   * - `bulletStatus` from `state`'s OWN bullet (`findSeatLine` + `parseSeatStamp`), never the copy
   *   this store loaded at open;
   * - `lease`, when the seat has one: its holder, `since`, liveness and label (`holderLabel`, its
   *   pane tag widened against every LIVE holder AND the caller, so two panes whose ids share their
   *   first four characters are never both `A7B2` in one refusal — a `dead` lease widens nothing);
   * - `callerHolds`, the OTHER seats whose lease is `sameHolder` as the caller;
   * - `legacy`, only for an UP bullet with NO lease (a seat that came up before holders were
   *   recorded, or on a board with no local layer): `seatUpConflict` over the bullet, the newest
   *   log block and `state`'s own stamp — today's window rule, unchanged.
   *
   * A pane label is `(no pane)` when the holder has none. `seats === null` (no holder, or no local
   * layer) is `lease: null`, `callerHolds: []` — and `--from`, which needs holders, is refused.
   */
  private async planSeatWrite(
    req: SeatBulletRequest,
    state: StateDoc,
    seats: SeatLeasesRead | null,
  ): Promise<{ ok: true; plan: SeatWritePlan } | { ok: false; error: string; refused: true }> {
    const now = this.now();
    const since = toIso(now);
    const shortName = boardShortName(this.cfg);
    const edit: SeatBulletEdit = {
      name: req.name,
      status: req.status,
      text: req.text,
      label: null,
    };
    const refuse = (error: string) => ({ ok: false as const, error, refused: true as const });
    if (req.status === 'DOWN') {
      // RCB-198: a DOWN is the holder's (or `force`d, audited). No local layer = no lease = free.
      if (seats === null) {
        return {
          ok: true,
          plan: { edits: [edit], leases: null, released: null, audit: null, tag: null },
        };
      }
      const decision = this.checkSeatWrite(seats.doc, {
        seat: req.name,
        verb: 'down',
        holder: req.holder,
        force: req.force,
      });
      if (!decision.ok) return refuse(decision.error);
      // The lease goes by ITS spelling of the seat (`Builder` stands `seat:builder` down).
      const down = seatHolderLeases(seats.doc, {
        seat: this.seatLeaseOf(seats.doc, req.name)?.seat ?? req.name,
        status: 'DOWN',
        holder: seats.holder,
        since,
        shortName,
        dead: new Set(),
      });
      return {
        ok: true,
        plan: {
          edits: [edit],
          leases: down.changed ? down.doc : null,
          released: null,
          audit: decision.audit,
          tag: this.callerSeatTag(seats.doc, seats.holder),
        },
      };
    }
    if (seats === null && req.from !== null) {
      return refuse('seat: --from needs a local layer (.repoboard/local/)');
    }

    const caller = req.holder ?? NO_HOLDER;
    const views = seats?.views ?? [];
    const alive = views.filter((v) => v.liveness.state !== 'dead');
    const dead = new Set(
      views.filter((v) => v.liveness.state === 'dead').map((v) => `${SEAT_LEASE_PREFIX}${v.seat}`),
    );
    const tagPanes = [...alive.map((v) => v.holder.pane), caller.pane].filter(
      (p): p is string => p !== null,
    );
    const tagOf = (pane: string | null): string =>
      pane === null ? NO_PANE_TAG : paneTag(pane, tagPanes);

    const bullet = findSeatLine(state.sections.seats, req.name);
    const bulletStatus = bullet === null ? null : (parseSeatStamp(bullet)?.status ?? null);
    // RCB-206: matched the way `seatLeaseOf` and the bullet are, so a claim typed `Builder` finds
    // the lease `seat:builder`.
    const wantedSeat = req.name.toLowerCase();
    const own = views.find((v) => v.seat.toLowerCase() === wantedSeat);
    const lease: SeatClaimInput['lease'] =
      own === undefined
        ? null
        : {
            holder: own.holder,
            since: own.since,
            liveness: own.liveness,
            label: holderLabel(tagOf(own.holder.pane), shortName, own.seat),
          };
    const callerHolds = views
      .filter((v) => v.seat.toLowerCase() !== wantedSeat && sameHolder(v.holder, caller))
      .map((v) => v.seat);
    // `--from Builder` names the seat the lease calls `builder`: match it the way the bullet is.
    const wanted = req.from;
    const from =
      wanted === null
        ? null
        : (callerHolds.find((h) => h.toLowerCase() === wanted.toLowerCase()) ?? wanted);

    let legacy: SeatClaimInput['legacy'] = null;
    if (bulletStatus === 'UP' && own === undefined) {
      const conflict = seatUpConflict(
        bullet,
        now,
        this.cfg.activeWindowMinutes,
        await this.sightingsFrom(req.name, { stamp: state.stamp, actor: state.actor }),
      );
      if (conflict !== null) {
        legacy = {
          conflict,
          windowMinutes: this.cfg.activeWindowMinutes,
          bullet: bullet ?? '',
        };
      }
    }

    const claim = decideSeatClaim({
      seat: req.name,
      callerLabel: `${tagOf(caller.pane)} · ${shortName}`,
      caller,
      bulletStatus,
      lease,
      legacy,
      callerHolds,
      from,
      force: req.force,
    });
    if (!claim.ok) return refuse(claim.error);
    if (seats === null) {
      return {
        ok: true,
        plan: {
          edits: [edit],
          leases: null,
          released: claim.release,
          audit: claim.audit,
          tag: null,
        },
      };
    }
    // The seat the pane leaves goes DOWN and loses its lease in this same write; this seat's
    // lease is then REPLACED (`seatHolderLeases`), whatever it held.
    const left =
      claim.release === null
        ? seats.doc
        : seatHolderLeases(seats.doc, {
            seat: claim.release,
            status: 'DOWN',
            holder: caller,
            since,
            shortName,
            dead,
          }).doc;
    // RCB-206: the lease keeps ITS spelling of the seat (as the DOWN path does), so a claim typed
    // `Builder` renews `seat:builder` instead of recording a second lease `seat:Builder` beside it.
    const up = seatHolderLeases(left, {
      seat: own?.seat ?? req.name,
      status: 'UP',
      holder: caller,
      since,
      shortName,
      dead,
    });
    const edits: SeatBulletEdit[] = [{ ...edit, label: up.label }];
    if (claim.release !== null) {
      edits.push({
        name: claim.release,
        status: 'DOWN',
        text: seatMovedText(req.name),
        label: null,
      });
    }
    return {
      ok: true,
      plan: {
        edits,
        leases: up.doc,
        released: claim.release,
        audit: claim.audit,
        tag: caller.pane === null ? null : tagOf(caller.pane),
      },
    };
  }

  /**
   * RCB-58/RCB-197: STATE.md read (scaffolded when absent) and parsed — never written. Caller
   * holds STATE.md's file lock. `{ok:false}` when it does not parse.
   */
  private async readSeatState(
    actor: string,
  ): Promise<{ ok: true; raw: string; doc: StateDoc } | { ok: false; error: string }> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      raw = initialStateText({ now: this.now(), actor });
    }
    const parsed = parseState(raw);
    return parsed.ok ? { ok: true, raw, doc: parsed.doc } : { ok: false, error: parsed.error };
  }

  /**
   * RCB-58/RCB-195/RCB-197: `edits` applied to `state`'s SEATS section in order — each seat's own
   * bullet replaced, every other byte kept — and the result restamped as `actor` through
   * `setStateSectionCore`; the new text, NOT written. `{ok:false}` when that does not parse.
   */
  private planSeatBullet(
    state: { raw: string; doc: StateDoc },
    actor: string,
    edits: readonly SeatBulletEdit[],
  ): { ok: true; text: string } | { ok: false; error: string } {
    const now = this.now();
    const repo = boardDisplayName(this.cfg, this.root);
    let seatsSection = state.doc.sections.seats;
    for (const e of edits) {
      seatsSection = replaceSeatBullet(
        seatsSection,
        e.name,
        formatSeatBullet(e.name, e.status, e.text, now, repo, e.label),
      );
    }
    const res = setStateSectionCore(state.raw, 'seats', seatsSection, { now, actor });
    return res.ok ? { ok: true, text: res.text } : { ok: false, error: res.error };
  }

  /** RCB-58/RCB-195: write `planSeatBullet`'s text and hand back the reparsed doc. Caller holds STATE.md's lock. */
  private async commitSeatBullet(text: string): Promise<{ ok: true; doc: StateDoc; text: string }> {
    await this.writeState(text);
    const reparsed = parseState(text);
    if (!reparsed.ok) throw new Error(`setSeatBullet produced unparseable text: ${reparsed.error}`);
    return { ok: true as const, doc: reparsed.doc, text };
  }

  /**
   * RCB-88: rewrite ONLY `name`'s own SEATS bullet's BODY — the standing label/status/stamp are
   * kept byte-for-byte (`rewriteSeatBulletBody`, no restamp), while STATE.md's own line-3 stamp
   * IS restamped as `name`, same as every other STATE write (this is what keeps `check` green
   * after a mid-session log block — see `setStateSection`). Unlike `setSeatBullet`, a missing
   * STATE.md or a missing/unparseable bullet is REFUSED, not scaffolded or appended — there is
   * nothing to keep in either case.
   *
   * RCB-198: a seat's bullet is rewritten by the pane that holds it. With a local layer the lease
   * `seat:<name>` in seats.yml is READ under its lock (`withSeatWriteGuard`, then STATE.md's) and
   * `checkSeatWrite` decides: a `holder` that is not the recorded one is `{ok:false, refused:true}`
   * with NOTHING written, unless `opts.force`, which writes and audits it (the audit block goes
   * first, once the rewrite is known to be good). seats.yml is never written and the lease is kept.
   * No lease, or no local layer: as before RCB-198.
   */
  updateSeatBullet(
    typedName: string,
    text: string,
    holder: SeatHolder | null = null,
    opts: SeatWriteOptions = {},
  ): Promise<UpdateSeatOutcome> {
    return this.mutate(async () => {
      // RCB-188: the seat door, first and unconditionally — see `seatName`.
      const named = this.seatName(typedName);
      if (!named.ok) return { ok: false as const, error: named.error };
      const name = named.name;
      // RCB-196: refused from a linked worktree before any lock or write.
      await this.refuseLinkedWorktree();
      this.refuseWriteWithoutBoard();
      const req: SeatWriteRequest = {
        seat: name,
        verb: 'update',
        holder,
        force: opts.force === true,
      };
      return this.withSeatWriteGuard(req, (audit) =>
        withFileLock(this.statePath, () => this.runSeatUpdate(name, text, audit)),
      );
    });
  }

  /**
   * RCB-88/RCB-198: `updateSeatBullet`'s write half, run with STATE.md's lock held (and seats.yml's,
   * when there is a local layer). STATE.md is read fresh, the rewrite is built and checked, THEN the
   * audit block (`audit`, from `checkSeatWrite`; `null` = none) is appended — a failure there
   * returns before STATE.md is touched — and only then is STATE.md written.
   */
  private async runSeatUpdate(
    name: string,
    text: string,
    audit: { title: string; text: string } | null,
  ): Promise<UpdateSeatOutcome> {
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
    const rewrite = rewriteSeatBulletBody(line, text, boardDisplayName(this.cfg, this.root));
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
    if (audit !== null) {
      const audited = await this.doAppendRepoLog(name, audit.text, audit.title);
      if (!audited.ok) return { ok: false as const, error: audited.error };
    }
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
  }

  /**
   * P8.3: append one block to today's `<this.logDir>/<date>.md`, creating the file (with its
   * `# Log — <date>` header) if this is the first entry of the day. Append-only: there is no
   * store method that rewrites a log file. RCB-71 A: `this.logDir` is `board.yml`'s `logDir` when
   * set — see `resolveLogDir()`. RCB-171: `writeLog` refuses to create a missing log directory in
   * the one worktree case (see `RefusedCreateError`).
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
    const invalid = logInputError(seat, text);
    if (invalid !== null) return { ok: false as const, error: invalid };
    const line = text.trim();
    // RCB-196: refused from a linked worktree before any lock or write.
    await this.refuseLinkedWorktree();
    this.refuseWriteWithoutBoard();
    const now = this.now();
    const date = toIso(now).slice(0, 10);
    const ts = toIso(now);
    const repo = boardDisplayName(this.cfg, this.root);
    const block = formatLogBlock({ seat, ts, title, text: line, repo });
    // RCB-196: the day's file is READ inside `writeLog`'s cross-process lock, so a block another
    // process appended a moment ago is never overwritten by a stale copy read out here.
    const next = await this.writeLog(date, (existing) =>
      appendLogBlock(existing.length > 0 ? existing : `${dailyLogHeader(date)}\n\n`, block),
    );
    const parsedBlocks = parseLogBlocks(next);
    const parsedBlock = parsedBlocks[parsedBlocks.length - 1];
    return {
      ok: true as const,
      date,
      text: next,
      block: parsedBlock ?? {
        seat: seat.toUpperCase(),
        ts,
        title: title ?? line,
        text: line,
        repo,
      },
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
   *
   * RCB-198: a seat's log is written by the pane that holds it. With a local layer the WHOLE body
   * runs inside seats.yml's lock (`withSeatWriteGuard`): the lease `seat:<seat>` is read under it
   * and `checkSeatWrite` decides — a `holder` that is not the recorded one is `{ok:false,
   * refused:true}` with NOTHING written (no block, no restamp), unless `opts.force`, which appends
   * an audit block FIRST (a failure there stops everything after it) and then the block asked for.
   * An empty `seat`/`text` is refused before the check, so no audit is written for a block that
   * would fail. seats.yml is never written. No lease, or no local layer: as before RCB-198.
   */
  appendSeatLog(
    typedSeat: string,
    text: string,
    title: string | undefined,
    holder: SeatHolder | null = null,
    opts: SeatWriteOptions = {},
  ): Promise<AppendSeatLogOutcome> {
    return this.mutate(async () => {
      // RCB-188: the seat door, first and unconditionally — see `seatName`. Nothing is written
      // (no log block, no restamp) for a name it refuses.
      const named = this.seatName(typedSeat);
      if (!named.ok) return { ok: false as const, error: named.error };
      const seat = named.name;
      const invalid = logInputError(seat, text);
      if (invalid !== null) return { ok: false as const, error: invalid };
      const req: SeatWriteRequest = { seat, verb: 'log', holder, force: opts.force === true };
      return this.withSeatWriteGuard(req, (audit) => this.runSeatLog(seat, text, title, audit));
    });
  }

  /**
   * RCB-127/RCB-198: `appendSeatLog`'s write half — the audit block first when there is one (its
   * failure returns before anything else is written), then the block asked for, then the STATE.md
   * restamp (`restamped`) under STATE.md's own lock.
   */
  private async runSeatLog(
    seat: string,
    text: string,
    title: string | undefined,
    audit: { title: string; text: string } | null,
  ): Promise<AppendSeatLogOutcome> {
    if (audit !== null) {
      const audited = await this.doAppendRepoLog(seat, audit.text, audit.title);
      if (!audited.ok) return audited;
    }
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
      // RCB-206: refused from a linked worktree before anything else, like every seat verb.
      await this.refuseLinkedWorktree();
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
      const repo = boardDisplayName(this.cfg, this.root);
      const block = formatLogBlock({ seat, ts, title, text: line, repo });
      const next = await this.writeArchive(path, (existing) =>
        appendLogBlock(existing.length > 0 ? existing : `${ARCHIVE_HEADER}\n\n`, block),
      );
      const parsedBlocks = parseLogBlocks(next);
      const parsedBlock = parsedBlocks[parsedBlocks.length - 1];
      return {
        ok: true as const,
        path: relative(this.root, path),
        block: parsedBlock ?? {
          seat: seat.toUpperCase(),
          ts,
          title: title ?? line,
          text: line,
          repo,
        },
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
   * RCB-217: the log the Board's snapshot opens with — today's (`log()`, by this store's clock) when
   * it has at least one block, else the newest EARLIER day within `maxDaysBack` days (UTC dates,
   * yesterday first) that has one, else today's own answer: `null` when no file exists for today,
   * or a file with no block in it. A day's file that exists but holds no block (a header only) is
   * not "a day with entries". Each day is `log()`'s own read — merged across every log dir, fresh
   * from disk, never cached — so this can never name a different day's text than `GET /api/log`.
   */
  async newestLog(maxDaysBack: number): Promise<LogFile | null> {
    const today = toIso(this.now()).slice(0, 10);
    const first = await this.log(today);
    if (first !== null && first.blocks.length > 0) return first;
    const midnight = Date.parse(`${today}T00:00:00Z`);
    for (let back = 1; back <= maxDaysBack; back++) {
      const day = new Date(midnight - back * 86_400_000).toISOString().slice(0, 10);
      const earlier = await this.log(day);
      if (earlier !== null && earlier.blocks.length > 0) return earlier;
    }
    return first;
  }

  /**
   * RCB-47: the newest block `seat` wrote, searching back across every day in `.repoboard/log/`
   * AND, when configured, `board.yml`'s `logDir` (reads merge both regardless of which one is the
   * WRITE target — RCB-71 A reversed the WRITE side of P8.6 decision 1, see `resolveLogDir()`;
   * this read merge is unaffected).
   * RCB-54: the original doc comment here argued OWN-dir-only was correct by definition ("a
   * seat's own last block is one it wrote with `repoboard log`") — false in the field, because a
   * seat can also write its blocks by hand straight into the configured `logDir` (as a member's seats
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
   * RCB-172: the ONE door a typed seat name goes through before it reaches SEATS or the log —
   * `normalizeSeatName` against THIS board's `boardDisplayName`, the value every producer here
   * already writes as the `[<board>] ` prefix (RCB-160), so a `[repoboard] builder` or `repoboard
   * builder` typed on the repoboard board is the seat `builder`, and another board's prefix is an
   * error. Synchronous and read only. RCB-188: `appendSeatLog`, `setSeatBullet` and
   * `updateSeatBullet` call it themselves, first, on every call and with no way to skip it, so
   * no caller (CLI, MCP, HTTP, the next one) can hand them a name this door has not seen; the
   * callers that already normalize (CLI `seatNameFor`, MCP) still do, to print `label`.
   */
  seatName(raw: string): SeatNameResult {
    return normalizeSeatName(raw, boardDisplayName(this.cfg, this.root));
  }

  /**
   * RCB-169: every moment OTHER than the bullet's own UP stamp at which `seat` was seen alive —
   * this seat's newest log block on this board (`lastRepoLogBlock`, the same read `seat`/`log
   * --last` use) and STATE.md's `Written <iso> by <actor>` stamp when `<actor>` is this seat —
   * for `seatUpConflict`. A read only: fresh log from disk, nothing written. The board name (for
   * a `[<board>] ` prefix on the actor) is `boardDisplayName` — the SAME value every producer here
   * writes as the bullet/log prefix, never a second source.
   *
   * RCB-197: `state` is HANDED IN — the stamp of the STATE.md the caller read under its lock. This
   * used to read `this.stateDoc`, the copy loaded when the store opened, which is exactly the stale
   * read the claim moved inside the lock to get rid of; it is private, so nothing can go back.
   */
  private async sightingsFrom(
    seat: string,
    state: { stamp: string; actor: string } | null,
  ): Promise<SeatSighting[]> {
    const last = await this.lastRepoLogBlock(seat);
    return seatSightingsCore({
      seat,
      boardName: boardDisplayName(this.cfg, this.root),
      lastLogTs: last?.block.ts ?? null,
      state,
    });
  }

  /**
   * RCB-48: `repoboard seat <name>` — the cold-start bundle, packaging the RCB-47 rule (STATE.md
   * → your own last block → the coordinator's → `card list --status todo` → open decisions) as
   * one read. Read-only: nothing is written, no event, works with no STATE.md (`seatsSection`
   * `null`). The coordinator's own block is fetched unconditionally — core's `seatBundle` is what
   * forces it `null` when `name` IS the coordinator, same as everywhere else that guarantee lives.
   *
   * RCB-154: `members` is REQUIRED (never defaulted here) — the same workspace gate-member facts
   * `card list`/`show`/`move` already pass to `blockedReason`, now forwarded to core's
   * `seatBundle` too, so a step's `gate:` naming a card on another board resolves the same way
   * everywhere. A caller with no workspace passes `[]`, never omits the argument.
   */
  async seatBundle(name: string, members: readonly GateMemberFacts[]): Promise<SeatBundle> {
    const [ownBlock, coordinatorBlock, rig, holders] = await Promise.all([
      this.lastRepoLogBlock(name),
      this.lastRepoLogBlock('coordinator'),
      this.readRigText(),
      this.seatHolders(),
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
      members,
      // RCB-160: automatic from the board — never typed, so a `seat <name>` bundle carries the
      // SAME repo prefix `setSeatBullet`/`doAppendRepoLog` are now writing into SEATS/the log.
      repo: boardDisplayName(this.cfg, this.root),
      // RCB-199: who holds each seat, from `seats.yml` — `holderError` says so when it cannot be read.
      holders: holders.holders,
      holderError: holders.error,
    });
  }

  /**
   * RCB-199: every recorded `seat:<name>` holder with its pane tag, label and liveness — what
   * `seat whoami`, `seat list` and the `seat <name>` bundle show. A READ: `seats.yml` is read with
   * NO lock (every writer replaces it by an atomic rename, so a reader sees the old file or the new
   * one, never half of either) and no file or lock is created. Each holder's process is probed once
   * (`probeSeatLeases`). No local layer means nothing private has anywhere to live (RCB-171), so no
   * holder was ever recorded: `{holders: [], error: null}`. A `seats.yml` that does not parse is
   * `{holders: [], error}` — never an empty list that reads as "nobody holds anything".
   */
  async seatHolders(): Promise<{ holders: SeatHolderInfo[]; error: string | null }> {
    if (!this.hasLocalLayer) return { holders: [], error: null };
    const read = await this.readSeatsDoc();
    if (!read.ok) return { holders: [], error: read.error };
    return {
      holders: seatHolderInfos(await this.probeSeatLeases(read.doc), boardShortName(this.cfg)),
      error: null,
    };
  }

  /**
   * RCB-184: the board named by `workspace:` — its display name, its OWN seats and whether it
   * lists this repo as a member — or `null` when the key is absent (every caller then does exactly
   * what it did before). STRICTLY READ-ONLY and never watching: the home is opened with
   * `load(false)`, which only reads (`board.yml`, `leases.yml`, `systems.yml`, STATE.md, the card
   * files, `events.jsonl`; no mkdir, no write, no watcher, no sweep timer — the same open
   * `Workspace.open` gives a member), then `seatHolders()` reads its `seats.yml` lock-free. Never
   * throws: whatever cannot be read is `{ok:false, error}`. Reads ONE hop — the home's own
   * `workspace:` is not followed.
   */
  async readHome(): Promise<HomeRead | null> {
    const configured = this.cfg.workspace;
    if (configured === undefined) return null;
    const fail = (error: string): HomeRead => ({ ok: false, configured, error });
    const homeRoot = resolveMemberRoot(this.root, configured);
    const home = new CardStore(homeRoot, { now: this.now });
    // `load()` keeps the last good config/state when a file does not parse and only EMITS a
    // warning (`<path>: <error>`, relative to the home) — listen BEFORE it runs, so a home whose
    // board.yml or STATE.md is broken is `unreadable`, not a folder-named board with no seats.
    const warnings: string[] = [];
    home.on('warning', (w: string) => warnings.push(w));
    try {
      await home.load(false);
      if (!home.hasBoard) return fail('no .repoboard/ there');
      const own = [home.boardPath, home.statePath].map((p) => relative(home.root, p));
      const broken = warnings.find((w) => own.some((p) => w.startsWith(`${p}:`)));
      if (broken !== undefined) return fail(broken);
      const state = home.state();
      if (state === null) return fail(`${relative(home.root, home.statePath)}: not found`);
      const name = boardDisplayName(home.config, home.root);
      const held = await home.seatHolders();
      const listed = await Promise.all(
        (home.config.repos ?? []).map((r) =>
          sameDirectory(resolveMemberRoot(home.root, r.root), this.root),
        ),
      );
      return {
        ok: true,
        configured,
        name,
        rows: homeSeatRows(state.sections.seats, held.holders, name),
        holderError: held.error,
        listsMember: listed.some(Boolean),
      };
    } catch (e) {
      return fail(`cannot be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    } finally {
      await home.close();
    }
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
   *
   * RCB-154: `members` is REQUIRED (never defaulted here) — the same workspace gate-member facts
   * `card list`/`show`/`move` already pass to `blockedReason`, now forwarded into the
   * `gated-steps` count too, so a step's `gate:` naming a card on another board is not
   * double-counted as gated once it actually clears. A caller with no workspace passes `[]`.
   */
  async check(strict: boolean, members: readonly GateMemberFacts[]): Promise<CheckOutcome> {
    const now = this.now();
    const logs = await this.loadAllLogInfo();
    // P8.4: read-only, so a check never fails to gather it; a read error (e.g. a permissions
    // problem on a linked path) yields `null` and `costFinding` reports nothing rather than
    // throwing `check` itself.
    const cost = await this.cost().catch(() => null);
    // RCB-83: same "never fails to gather" rule as cost — a read error yields `null` and the
    // local findings report nothing rather than throwing `check` itself.
    const local = await localStatus(this.root).catch(() => null);
    // RCB-200: who is recorded as holding each seat, for the SEATS findings. `null` — the holder
    // checks then say NOTHING — when there is no local layer (no holder was ever recorded, so a
    // labelled UP bullet has no lease to disagree with) or `seats.yml` cannot be read (a lease
    // file that does not parse is unknown, never an empty list); same "gather never fails" rule as
    // `cost`/`local` above, so a read error here is `null` too and `check` still answers.
    const held = this.hasLocalLayer ? await this.seatHolders().catch(() => null) : null;
    // RCB-184: `workspace:` — the home read once (read-only), shared by the SEATS findings and
    // `stale-state` (which ignores the home's own log blocks). `null` without the key.
    const home = await this.readHome();
    const homeFacts: SeatCheckHome | null =
      home === null
        ? null
        : home.ok
          ? {
              ok: true,
              configured: home.configured,
              name: home.name,
              listsMember: home.listsMember,
            }
          : home;
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
      publicDenylist: await this.gatherPublicDenylist().catch(() => null),
      // RCB-130: every SEATS bullet's name + text, split the SAME way `repoboard seat`/`seat list`
      // split it (`seatBulletTexts`, core's own `bulletSpans` — no second splitter here) — pure,
      // so gathering it is just reading the section already on `this.stateDoc`.
      seatBullets: seatBulletTexts(this.stateDoc?.sections.seats ?? ''),
      // RCB-200: the SEATS section against the recorded holders and the SAME `logs` and `now`
      // above — computed here (I/O), judged in core (`seatCheckFindings`), passed through verbatim.
      seatFindings: seatCheckFindings({
        seatsSection: this.stateDoc?.sections.seats ?? null,
        boardName: boardDisplayName(this.cfg, this.root),
        holders: held === null || held.error !== null ? null : held.holders,
        logs,
        now,
        home: homeFacts,
      }),
      members,
      homeBoard: home?.ok === true ? home.name : null,
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
   * RCB-209: `check`'s `publicDenylist` input — `.repoboard/local/public-denylist.txt` (one ERE
   * per line, matched case-insensitively; lines blank after trimming, and `#` lines, are ignored —
   * an empty pattern would match every line) run over the tracked files with one `git grep`, cwd =
   * `this.root`. `null` when there is no local layer (nothing private has anywhere to live,
   * RCB-171) or `this.root` is not a git repo / git cannot be spawned — the same "gather never
   * fails, unconfigured is inert" rule as `gatherUntrackedCards`. A missing file is
   * `{present: false}`; a file with no patterns never spawns git (a `git grep` with no pattern
   * would fail, and an empty one would hit everything). `git grep` exit 1 is zero hits, exit 0 is
   * parsed, anything else is `error` (git's first line: a pattern it cannot compile, most
   * likely) — an unreadable file is `error` too, never a silent "no hits". `-z` so a path with a
   * colon or a quote-worthy byte comes back verbatim; the matched text is discarded here, only
   * `{path, line}` leaves. Lockfiles at any depth are skipped: integrity hashes false-positive.
   */
  private async gatherPublicDenylist(): Promise<{
    present: boolean;
    hits: { path: string; line: number }[];
    error: string | null;
  } | null> {
    if (!this.hasLocalLayer) return null;
    let text: string;
    try {
      text = await readFile(join(localDir(this.root), 'public-denylist.txt'), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { present: false, hits: [], error: null };
      }
      return { present: true, hits: [], error: `cannot read it: ${(e as Error).message}` };
    }
    const patterns = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    if (patterns.length === 0) return { present: true, hits: [], error: null };

    const git = (args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string } | null>((res) => {
        const child = spawn('git', ['-C', this.root, ...args]);
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('error', () => res(null));
        child.on('close', (code) => res({ code: code ?? 1, stdout, stderr }));
      });

    const inside = await git(['rev-parse', '--is-inside-work-tree']);
    if (inside === null || inside.code !== 0) return null;
    const grep = await git([
      'grep',
      '-n',
      '-z',
      '-I',
      '-i',
      '-E',
      ...patterns.flatMap((p) => ['-e', p]),
      '--',
      '.',
      ':(exclude,glob)**/pnpm-lock.yaml',
      ':(exclude,glob)**/package-lock.json',
      ':(exclude,glob)**/yarn.lock',
    ]);
    if (grep === null) return null;
    if (grep.code === 1) return { present: true, hits: [], error: null };
    if (grep.code !== 0) {
      const first = grep.stderr.split('\n').find((l) => l.trim().length > 0);
      return { present: true, hits: [], error: first?.trim() ?? `git grep exited ${grep.code}` };
    }
    // `git grep -n -z` prints `path NUL line NUL text NL`: keep the first two fields.
    const hits: { path: string; line: number }[] = [];
    for (const record of grep.stdout.split('\n')) {
      const a = record.indexOf('\0');
      const b = a < 0 ? -1 : record.indexOf('\0', a + 1);
      if (b < 0) continue;
      const line = Number.parseInt(record.slice(a + 1, b), 10);
      if (Number.isInteger(line)) hits.push({ path: record.slice(0, a), line });
    }
    return { present: true, hits, error: null };
  }

  /**
   * RCB-97: `check`'s `systems` input — `null` when there is no `systems.yml` at all (§3.1:
   * unconfigured is inert). Otherwise `{ errors, stale, doc }`: `stale` is only ever computed
   * when `doc` parsed AND has at least one `source.detected` row (an invalid file has no rows to
   * stale-check); a detection failure yields `stale: []` — a `check` call must never throw over
   * this (mirrors `cost`'s and `local`'s own "gather never fails" rule above). RCB-161 slice 1:
   * `doc` is forwarded unchanged (`null` on a parse failure) so `checkFindings` can also run
   * `systemsUnblockerFindings` without a second gather.
   */
  private async gatherSystemsCheck(): Promise<{
    errors: readonly string[];
    stale: readonly string[];
    doc: SystemsDoc | null;
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
    return { errors, stale, doc };
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
  ): Promise<T | { ok: false; error: string; readOnly?: true }> {
    return this.enqueue(async () => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof MapOnlyError) {
          return { ok: false as const, error: e.message, readOnly: true as const };
        }
        // RCB-171: a refusal to create STATE.md / a log directory is about the repo's setup, not
        // the request and not map-only mode — no `readOnly` flag.
        if (e instanceof RefusedCreateError) return { ok: false as const, error: e.message };
        // RCB-196: a seat/log write from a linked git worktree — same shape, same reason.
        if (e instanceof LinkedWorktreeError) return { ok: false as const, error: e.message };
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
   * RCB-196: the ONE guarantee — throws `LinkedWorktreeError` iff this store's root sits in a
   * linked git worktree, naming both this root and the main checkout's directory. A seat verb or
   * log append run there would write the worktree's own `.repoboard/` (a tracked STATE.md that
   * forks from the board's record), so it is refused before any lock or write — `seats.yml`
   * included — and the caller is told where to run it instead. Takes no argument that could weaken
   * it; asked once per store (memoized). Inert when git cannot say (see
   * `mainCheckoutOfLinkedWorktree`): no git, not a repository, or an old git writes as before.
   */
  private refuseLinkedWorktree(): Promise<void> {
    this.linkedWorktreeCheck ??= mainCheckoutOfLinkedWorktree(this.root).then((main) => {
      if (main === null) return;
      throw new LinkedWorktreeError(
        `refused: ${this.root} is a linked git worktree, and a seat or log write here would fork ` +
          `its own .repoboard/ from the board's record; run it from the main checkout: ${main}`,
      );
    });
    return this.linkedWorktreeCheck;
  }

  /** RCB-171: `p` as a `/`-separated path relative to the served root, for a refusal message. */
  private relToRoot(p: string): string {
    return relative(this.root, p).split(sep).join('/');
  }

  /**
   * RCB-171: does the repo root's own `.gitignore` carry a line that ignores the local layer —
   * `.repoboard/local`, `.repoboard/local/` or `/.repoboard/local/` (`repoboard local init` writes
   * the middle form)? The file is read directly (no git subprocess); blank lines and `#` comments
   * never match; no `.gitignore`, or no such line, is `false` — an unconfigured rule is inert.
   */
  private async gitignoreExpectsLocalLayer(): Promise<boolean> {
    let text: string;
    try {
      text = await readFile(join(this.root, '.gitignore'), 'utf8');
    } catch {
      return false;
    }
    return text.split(/\r?\n/).some((line) => LOCAL_LAYER_GITIGNORE_LINE.test(line.trim()));
  }

  /**
   * RCB-171: the ONE guarantee — throws `RefusedCreateError` iff creating `what` here would put a
   * private record into a tracked path: the root's `.gitignore` says the local layer is private
   * (`gitignoreExpectsLocalLayer`) AND `.repoboard/local/` is absent (checked fresh, not from the
   * load-time `hasLocalLayer`). Called only by `writeState`/`writeLog`, and only when the write
   * would CREATE the file/directory — an existing top-level STATE.md or log dir (a board that
   * tracks them on purpose) is written as before. Takes no argument that could weaken it.
   */
  private async refuseCreateWithoutPrivateLayer(what: string): Promise<void> {
    if (await isDirectory(localDir(this.root))) return;
    if (!(await this.gitignoreExpectsLocalLayer())) return;
    throw new RefusedCreateError(
      `.repoboard/local/ is missing here, but .gitignore ignores it — this looks like a git ` +
        `worktree or a fresh clone, and creating ${what} would put private state into a tracked ` +
        'path; run from the main checkout, or `repoboard local init`',
    );
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
    // RCB-171: the ONE place STATE.md reaches disk, so the ONE place that refuses to CREATE it
    // in a checkout whose gitignored local layer is missing.
    if (!(await exists(this.statePath))) {
      await this.refuseCreateWithoutPrivateLayer(this.relToRoot(this.statePath));
    }
    await mkdir(this.repoboardDir, { recursive: true });
    const tmp = tmpName(this.statePath);
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, this.statePath);
    const parsed = parseState(text);
    this.stateDoc = parsed.ok ? parsed.doc : null;
    this.emit('state', this.stateDoc);
  }

  /**
   * RCB-196: the ONE write of a repo-log file. Read-modify-write under `withFileLock` on the day's
   * file — the same cross-process guard `writeArchive` and `setStateSection` use, and the only way
   * two processes appending at once (two seats, or a CLI next to `serve`) cannot drop each other's
   * block: `next` maps the file's text AS READ INSIDE THE LOCK (`''` when absent) to the new text,
   * which is written to a unique `tmpName` (never a fixed `<file>.tmp` two writers could share) and
   * renamed over the day's file, then returned. The directory is made before the lock, because the
   * lock file sits next to `path`.
   */
  private async writeLog(date: string, next: (existing: string) => string): Promise<string> {
    this.refuseWriteWithoutBoard();
    const path = join(this.logDir, `${date}.md`);
    // RCB-171: the ONE place a log file reaches disk, so the ONE place that refuses to create the
    // log DIRECTORY in a checkout whose gitignored local layer is missing (a new day's FILE inside
    // an existing directory is the normal case). A `board.yml` `logDir` wins over the local layer
    // (RCB-71 A) — the owner named that directory, so it is never this guard's business.
    if (!this.cfg.logDir && !(await isDirectory(this.logDir))) {
      await this.refuseCreateWithoutPrivateLayer(`${this.relToRoot(this.logDir)}/`);
    }
    await mkdir(this.logDir, { recursive: true });
    const text = await withFileLock(path, async () => {
      let existing = '';
      try {
        existing = await readFile(path, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      const written = next(existing);
      const tmp = tmpName(path);
      await writeFile(tmp, written, 'utf8');
      await rename(tmp, path);
      return written;
    });
    this.emit('log', { date, text });
    return text;
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
   * from what we last saw, synthesise an `actor: "file"` event from the status diff. `recheck` is
   * set only by `scheduleEmptyRecheck`'s own timer (RCB-164) — it skips the empty-read hold below
   * so the recheck itself can never be held again.
   */
  private async refreshCard(
    path: string,
    origin: 'load' | 'watch',
    recheck = false,
  ): Promise<void> {
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
    // RCB-157: opt-in watcher trace (REPOBOARD_WATCH_DIAG=1) — no-op when off.
    getWatchDiag()?.record(
      this.root,
      'refresh',
      origin,
      path,
      text.length,
      prev ? prev.hash === hash : 'noprev',
    );
    if (prev && prev.hash === hash) return; // our own write echoing back, or a no-op touch

    // RCB-164: `writeFile` is `open(O_TRUNC)` then a separate `write` — a watcher (or the
    // reconcile sweep) can land in the gap and read 0 bytes for content that is about to
    // reappear. Only a path that ALREADY MAPS TO A CARD (`prev?.id`) gets this hold: a genuinely
    // new, empty file has no `prev` and still falls straight through to the invalid path below —
    // it was never mid-write from this store's point of view. The hold changes nothing (byPath,
    // cards, invalid all stay exactly as they are) and parks ONE re-read of this path
    // (`scheduleEmptyRecheck`) instead of deciding right now. `recheck` — true only on that
    // re-read's own call — skips this block, so a card that really IS empty (the content never
    // lands) still ends up `card:removed` + `invalid`, just after `emptyGraceMs` instead of
    // immediately; and `emptyGraceMs <= 0` is the control that reproduces today's un-held
    // behaviour exactly.
    if (origin === 'watch' && text.length === 0 && prev?.id && this.emptyGraceMs > 0 && !recheck) {
      const rel = relative(this.root, path);
      getWatchDiag()?.record(this.root, 'empty-hold', rel);
      if (!this.pendingEmptyReads.has(path)) this.scheduleEmptyRecheck(path);
      return;
    }

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
    // RCB-193: a task still running when `close()` cleared the timers must not arm a new one.
    if (this.closed) return;
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

  /**
   * RCB-164: fires `emptyGraceMs` after `refreshCard` first held a 0-byte read of `path`. Re-runs
   * `refreshCard(path, 'watch', true)` — the `true` skips the hold, so this call either finds the
   * hash already matches (some other route already refreshed it: no-op) or decides for real: real
   * content landed meanwhile (routes normally, as a move) or the file is still empty (the invalid
   * path runs and the removal becomes real). Runs through the store's serial `enqueue` queue, like
   * every other watcher task, so it can never race a mutation or another routed change.
   */
  private scheduleEmptyRecheck(path: string): void {
    // RCB-193: same rule as `schedulePendingClaim` — no timer is armed on a closed store.
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.pendingEmptyReads.delete(path);
      this.enqueue(() => this.refreshCard(path, 'watch', true)).catch((e: unknown) => {
        this.emit('warning', `empty-grace: ${path}: ${(e as Error).message}`);
      });
    }, this.emptyGraceMs);
    this.pendingEmptyReads.set(path, timer);
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

  /**
   * RCB-157D: one router for every change this store notices under `.repoboard/` — chokidar's
   * own `all` event (`via: 'watch'`) and `reconcile()`'s periodic sweep (`via: 'reconcile'`)
   * both funnel through here, so a change is handled identically no matter which one saw it
   * first. `via: 'watch'`'s behaviour, DIAG rows included, is byte-for-byte what the old inline
   * `all` handler did; `via: 'reconcile'` additionally records its own DIAG row (`'reconcile'`)
   * so a trace can tell which path routed a given change. `absPath` need not already be resolved
   * — `resolve()` here is idempotent either way.
   */
  private routeChange(
    event: 'add' | 'change' | 'unlink',
    absPath: string,
    via: 'watch' | 'reconcile',
  ): void {
    const d = getWatchDiag();
    const path = resolve(absPath);
    const rel = relative(this.repoboardDir, path).split(sep).join('/');
    // RCB-83: `this.statePath` moves to `local/STATE.md` when a local layer exists (set once,
    // in `load()`, before the watcher ever starts) — compare against ITS relative name, not
    // the hardcoded root-level one, so a local-layer repo's STATE.md is still watched.
    const stateRel = relative(this.repoboardDir, this.statePath).split(sep).join('/');
    const logRel = relative(this.repoboardDir, this.logDir).split(sep).join('/');
    const task = async (): Promise<void> => {
      // RCB-157D: first statement — this route is no longer pending, whatever happens below.
      this.releaseRoute(path);
      d?.record(this.root, 'run', rel);
      // RCB-157D: opt-in trace, off unless via === 'reconcile' — a 'watch'-routed task records
      // exactly the rows it always has.
      if (via === 'reconcile') d?.record(this.root, 'reconcile', rel, event);
      // RCB-157E: captured BEFORE `updateSeen` overwrites them — what this path's `seen` key and
      // recording source were the moment before THIS task's own bookkeeping runs, so the skip
      // rule below can compare "what just got recorded" against "what was already there".
      const prevKey = this.seen.get(path);
      const prevVia = this.seenVia.get(path);
      // RCB-157D: last-seen bookkeeping, BEFORE any read — see `updateSeen`'s own doc comment.
      const newKey = await this.updateSeen(path, event, via);
      // RCB-157E: cross-source dedupe. `updateSeen` just recorded the same key some OTHER source
      // already recorded (`prevVia !== via`) for this exact stat (`newKey === prevKey`) — the
      // watcher and the sweep both saw one write and are about to route it twice. Skip it. This
      // is deliberately cross-source ONLY (`prevVia !== undefined` excludes a fresh baseline,
      // which counts as neither source): on a filesystem with 1 s mtime resolution, two distinct
      // same-size edits from the SAME source within one second share a key too, and today's
      // behaviour — the watcher still reports the second one — must not change, or a real second
      // edit goes unrouted. `event !== 'unlink'` excludes deletes, which `updateSeen` reports via
      // `newKey === null` regardless of source and must always route.
      if (event !== 'unlink' && newKey === prevKey && prevVia !== via && prevVia !== undefined) {
        d?.record(this.root, 'dedupe', rel, via);
        return;
      }
      if (rel === 'board.yml') {
        // RCB-34: `setColumns` already emitted `config` synchronously; skip the echo (see
        // `loadConfig`'s hash check) so one `setColumns` call produces exactly one emit.
        const { changed } = await this.loadConfig();
        if (changed) {
          // RCB-71 A: a `logDir` added, changed, or removed in `board.yml` while `serve`
          // runs takes effect immediately — no restart needed for the WRITE target to move.
          this.logDir = this.resolveLogDir();
          this.emit('config', this.cfg);
        }
        return;
      }
      if (rel === 'events.jsonl') {
        await this.loadEvents();
        return;
      }
      if (rel === 'leases.yml') {
        await this.loadLeases();
        this.emit('leases', this.leasesDoc);
        return;
      }
      if (rel === 'systems.yml') {
        await this.loadSystems();
        this.emit('systems', this.systems());
        return;
      }
      if (rel === stateRel) {
        if (event === 'unlink') {
          this.stateDoc = null;
          this.emit('state', null);
          return;
        }
        await this.loadState();
        this.emit('state', this.stateDoc);
        return;
      }
      // RCB-83: the log WRITE dir moves with the local layer; the panel follows `this.logDir`.
      const logMatch =
        rel.startsWith(`${logRel}/`) && rel.endsWith('.md')
          ? /^([^/]+)\.md$/.exec(rel.slice(logRel.length + 1))
          : null;
      if (logMatch?.[1] !== undefined) {
        if (event === 'unlink') return;
        const text = await readFile(path, 'utf8');
        this.emit('log', { date: logMatch[1] as string, text });
        return;
      }
      if (/^cards\/[^/]+\.md$/.test(rel)) {
        if (event === 'unlink') {
          this.removeCardFile(path);
          return;
        }
        if (event === 'add' || event === 'change') await this.refreshCard(path, 'watch');
      }
    };
    d?.record(this.root, 'enq', rel);
    // RCB-157D: pending until `task` runs. `enqueue` chains `this.queue.then(fn, fn)` on a queue
    // that never rejects, so `task` always runs and its first statement releases this count; a
    // rejection of the returned promise can only come from inside `task`, after that release.
    this.routing.set(path, (this.routing.get(path) ?? 0) + 1);
    this.enqueue(task).catch((e: unknown) => {
      this.emit('warning', `watcher: ${rel}: ${(e as Error).message}`);
    });
  }

  /** RCB-157D: one routed task for `path` has started — decrement `routing`, deleting at 0. */
  private releaseRoute(path: string): void {
    const n = (this.routing.get(path) ?? 0) - 1;
    if (n > 0) this.routing.set(path, n);
    else this.routing.delete(path);
  }

  /**
   * RCB-157D: `routeChange`'s own last-seen bookkeeping — runs at the START of every routed
   * task, before any read, so `reconcile()`'s next sweep always compares against what THIS task
   * is about to do, not what it saw before. `event === 'unlink'` deletes the entry outright (no
   * stat to take — the path is gone). Otherwise: ENOENT (the path vanished between the watcher
   * noticing and this task running) also deletes it; any OTHER stat error leaves the entry as it
   * was — a transient failure here must never make `reconcile()` think a file that still exists
   * was deleted. RCB-157E: `seenVia` moves in lockstep with `seen` — set to `via` wherever `seen`
   * is set, deleted wherever `seen` is deleted, untouched wherever `seen` is left untouched — and
   * this returns the resulting `seen` key (`null` on unlink/ENOENT, the unchanged old key on any
   * other stat error) so the caller can compare it against what it was before this call.
   */
  private async updateSeen(
    path: string,
    event: 'add' | 'change' | 'unlink',
    via: 'watch' | 'reconcile',
  ): Promise<string | null> {
    if (event === 'unlink') {
      this.seen.delete(path);
      this.seenVia.delete(path);
      return null;
    }
    try {
      const st = await stat(path);
      const key = `${st.mtimeMs}:${st.size}`;
      this.seen.set(path, key);
      this.seenVia.set(path, via);
      return key;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.seen.delete(path);
        this.seenVia.delete(path);
        return null;
      }
      // any other stat error: leave both entries untouched.
      return this.seen.get(path) ?? null;
    }
  }

  /**
   * RCB-157D: `reconcile()`'s tracked set — `board.yml`, `events.jsonl`, `leases.yml`,
   * `systems.yml`, `this.statePath`, and every `*.md` in `cardsDir`/`this.logDir`. A missing
   * directory reads as no entries (mirrors `load()`'s own card-directory listing), never an
   * error — the fixed single files are listed regardless of whether they currently exist, so a
   * later stat's ENOENT is what reports their absence.
   */
  private async trackedPaths(): Promise<string[]> {
    const fixed = [
      this.boardPath,
      this.eventsPath,
      this.leasesPath,
      this.systemsPath,
      this.statePath,
    ];
    const cardFiles = await this.listMdFiles(this.cardsDir);
    const logFiles = await this.listMdFiles(this.logDir);
    return [...fixed, ...cardFiles, ...logFiles];
  }

  /** Every `<dir>/*.md` absolute path; a missing `dir` reads as empty, never an error. */
  private async listMdFiles(dir: string): Promise<string[]> {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return [];
    }
    return names.filter((n) => n.endsWith('.md')).map((n) => join(dir, n));
  }

  /**
   * RCB-157D: seed `seen` for the tracked set with NO routing — called once, at the end of
   * `load()`. A stat error other than ENOENT propagates (mirrors `load()`'s own card-directory
   * listing, which does the same); ENOENT just means that tracked path does not exist yet, so it
   * gets no baseline entry. RCB-157E: deliberately sets no `seenVia` — a baseline is neither
   * source, so the first route any path takes after load is never skipped by the cross-source
   * dedupe rule in `routeChange`.
   */
  private async fillSeenBaseline(): Promise<void> {
    for (const path of await this.trackedPaths()) {
      try {
        const st = await stat(path);
        this.seen.set(path, `${st.mtimeMs}:${st.size}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  }

  /**
   * RCB-157D: is `path` inside `reconcile()`'s own tracked DIRECTORY set (cards or the log dir),
   * or one of its fixed single files? Guards the "gone from the listing entirely" branch in
   * `reconcile()` below — `seen` can hold paths OUTSIDE the tracked set too (`updateSeen` runs
   * for every routed task, tracked or not), and those must never be reported as a reconcile
   * unlink just because they are absent from a listing that was never about them.
   */
  private inTrackedDomain(path: string): boolean {
    if (
      path === this.boardPath ||
      path === this.eventsPath ||
      path === this.leasesPath ||
      path === this.systemsPath ||
      path === this.statePath
    ) {
      return true;
    }
    return (
      (dirname(path) === this.cardsDir || dirname(path) === this.logDir) && path.endsWith('.md')
    );
  }

  /** RCB-157E1: the same `rel` `routeChange` computes for a DIAG row — relative to
   * `this.repoboardDir`, `/`-separated regardless of platform — factored out so `reconcile()`'s
   * own `'sweep'` row names a path exactly the way `routeChange`'s `'enq'`/`'run'` rows do. */
  private diagRel(path: string): string {
    return relative(this.repoboardDir, path).split(sep).join('/');
  }

  /**
   * RCB-157D: what the watcher lost, found. Stats the tracked set and compares each path's key
   * against `seen`: a path whose key differs (or that isn't in `seen` at all) is routed —
   * `change` when it WAS already known (had a `seen` entry), `add` when it was not; a path in
   * `seen` that has fallen out of the tracked set entirely (deleted) is routed `unlink`. Every
   * route goes through `routeChange('reconcile', ...)`, so it is reported exactly the way a
   * chokidar event would be — same DIAG rows (plus its own `'reconcile'` row), same card/event
   * emits, same K8 claim-grace handling; a change the watcher already routed updated `seen`
   * itself (or is still pending in `routing`), so this never re-reports it. An add/change
   * younger than RECONCILE_SETTLE_MS waits for a later sweep; a sweep still running when
   * `close()` nulls the timer routes nothing more. Never overlaps itself (`reconciling`); never
   * throws — a failure becomes the store's existing `warning` emit, the same "gather never
   * fails" rule `cost`/`local`/systems detection already follow. RCB-157E1: `reconcile()` records
   * nothing unless it routes, so — opt-in trace only — every exit now also writes ONE `'sweep'`
   * DIAG row (`finally`), and a `this.reconciling` bail writes its own `'sweep-busy'` row, so a
   * dump can tell whether the sweep ran at all and, if so, exactly what it saw.
   */
  private async reconcile(): Promise<void> {
    const d = getWatchDiag();
    if (this.reconciling) {
      d?.record(this.root, 'sweep-busy');
      return;
    }
    this.reconciling = true;
    let trackedCount = 0;
    let sameKey = 0;
    let missing = 0;
    const routed: string[] = [];
    const settle: string[] = [];
    const busy: string[] = [];
    let closed = false;
    let errorMessage: string | undefined;
    try {
      const tracked = await this.trackedPaths();
      trackedCount = tracked.length;
      const trackedSet = new Set(tracked);
      for (const path of tracked) {
        // A route already enqueued for this path will update `seen` when it runs — routing it
        // again from here would report the same change twice.
        if ((this.routing.get(path) ?? 0) > 0) {
          busy.push(this.diagRel(path));
          continue;
        }
        let st: Stats | null;
        try {
          st = await stat(path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            this.emit(
              'warning',
              `reconcile: ${relative(this.root, path)}: ${(e as Error).message}`,
            );
            continue;
          }
          st = null;
        }
        const prevKey = this.seen.get(path);
        if (st === null) {
          if (prevKey === undefined) {
            missing += 1;
            continue;
          }
          if (this.reconcileTimer === null) {
            closed = true;
            return; // close() ran mid-sweep: route nothing more.
          }
          this.routeChange('unlink', path, 'reconcile');
          routed.push(`${this.diagRel(path)}:unlink`);
          continue;
        }
        const key = `${st.mtimeMs}:${st.size}`;
        if (prevKey === key) {
          sameKey += 1;
          continue;
        }
        // Settle guard: possibly mid-write — leave `seen` alone so the next sweep retries.
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs < RECONCILE_SETTLE_MS) {
          settle.push(`${this.diagRel(path)}:${Math.round(ageMs)}`);
          continue;
        }
        if (this.reconcileTimer === null) {
          closed = true;
          return;
        }
        const event = prevKey === undefined ? 'add' : 'change';
        this.routeChange(event, path, 'reconcile');
        routed.push(`${this.diagRel(path)}:${event}`);
      }
      for (const path of [...this.seen.keys()]) {
        if (trackedSet.has(path) || !this.inTrackedDomain(path)) continue;
        if ((this.routing.get(path) ?? 0) > 0) {
          busy.push(this.diagRel(path));
          continue;
        }
        if (this.reconcileTimer === null) {
          closed = true;
          return;
        }
        this.routeChange('unlink', path, 'reconcile');
        routed.push(`${this.diagRel(path)}:unlink`);
      }
    } catch (e) {
      errorMessage = (e as Error).message;
      this.emit('warning', `reconcile: ${errorMessage}`);
    } finally {
      this.reconciling = false;
      d?.record(this.root, 'sweep', {
        tracked: trackedCount,
        sameKey,
        missing,
        routed,
        settle,
        busy,
        ...(closed ? { closed: true } : {}),
        ...(errorMessage === undefined ? {} : { error: errorMessage }),
      });
    }
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
    // RCB-157: opt-in watcher trace (REPOBOARD_WATCH_DIAG=1) — `d` is `null` off, so every use
    // below is a no-op and behaviour is unchanged.
    const d = getWatchDiag();
    if (d) {
      watcher.on('raw', (ev, p, details) => {
        d.record(
          this.root,
          'raw',
          ev,
          p,
          (details as { watchedPath?: string } | undefined)?.watchedPath,
        );
      });
    }
    watcher.on('all', (event, rawPath) => {
      d?.record(this.root, 'all', event, rawPath);
      // RCB-157D: `routeChange` only knows file events — `addDir`/`unlinkDir` (and anything else
      // chokidar's `EventName` admits) never matched a `rel` branch anyway (none names a
      // directory), so no emit changes. One trace difference: dir events still write their `all`
      // DIAG row but no longer write `enq`/`run` rows (they used to queue a no-op task).
      if (event === 'add' || event === 'change' || event === 'unlink') {
        this.routeChange(event, rawPath, 'watch');
      }
    });
    watcher.on('error', (e) => {
      d?.record(this.root, 'error', (e as Error).message);
      this.emit('warning', `watcher: ${(e as Error).message}`);
    });
    await new Promise<void>((res) =>
      watcher.once('ready', () => {
        d?.record(this.root, 'ready');
        res();
      }),
    );
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
  'seat',
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

/** RCB-184: do two paths name one directory? Symlinks resolved when they can be (`realpath`), the
 * resolved path itself when one does not exist — so a missing path equals only the same spelling. */
async function sameDirectory(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([
    realpath(a).catch(() => resolve(a)),
    realpath(b).catch(() => resolve(b)),
  ]);
  return ra === rb;
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
