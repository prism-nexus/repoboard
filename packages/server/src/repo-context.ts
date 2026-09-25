/**
 * RCB-43 slice 1: everything `startServer` (`http.ts`) used to close over per-root — the scan,
 * the repo watcher, the eight `store.on(...)` → broadcast hooks, `onClientMessage`, `handleApi`,
 * this root's `wss`, and `close()` — moved out mechanically (same names, same bodies, same
 * comments) so a process can hold more than one of them. `startServer` keeps only what is truly
 * shared: `findWebDir`/`serveStatic`, the one `http.Server`, its `upgrade` event, and `listen`.
 *
 * `RepoRegistry` is the lazy, keyed table over the `--root` list (K12 "map on demand"): only the
 * primary is opened eagerly (by `startServer`, via `setOpened`); every other root opens on its
 * first `openRepo(key)`, memoised as a `Promise` so two concurrent first callers open exactly one
 * context. See `.repoboard/local/briefs/RCB-43-MULTIROOT-BRIEF.md` §Slice 1.
 */

import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, join, relative, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import {
  boardDisplayName,
  type Card,
  type CardPatch,
  type Column,
  type CreateCardInput,
  type DecisionOption,
  isOwnerTask,
  mergeSiblings,
  needsDecision,
  type Priority,
  planSystemsMap,
  renderState,
  resolveOlderThan,
  type Sibling,
  type Size,
  type StateSectionName,
  staleLeases,
  toIso,
} from '@repoboard/core';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { type WebSocket, WebSocketServer } from 'ws';
import { applySyncPlan, computeSyncPlan } from './issues.js';
import { resolveCardRefs, resolveRefSpec } from './refs.js';
import { repoDashboard } from './repo-health.js';
import { isGitRepo, type ScanResult, scanRepo } from './scanner.js';
import { type CardStore, openStore } from './store.js';
import { runDetect } from './systems-detect.js';
import { systemTests } from './systems-tests.js';
import { buildRepoWatchIgnore, EMPTY_IGNORED, gitIgnoredPaths } from './watch-ignore.js';

const MAX_BODY = 1024 * 1024;
const PATCH_FIELDS: ReadonlySet<string> = new Set([
  'status',
  'title',
  'assignee',
  'priority',
  'size',
  'labels',
  'files',
  'refs',
  'parent',
  'phase',
  'gate',
  'body',
  'actor',
]);
const CREATE_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'status',
  'assignee',
  'priority',
  'size',
  'labels',
  'files',
  'refs',
  'parent',
  'phase',
  'gate',
  'body',
  'actor',
]);
const PRIORITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);
const SIZES: ReadonlySet<string> = new Set(['S', 'M', 'L', 'XL']);
const ASK_FIELDS: ReadonlySet<string> = new Set([
  'question',
  'options',
  'replace',
  'kind',
  'actor',
]);
const DECIDE_FIELDS: ReadonlySet<string> = new Set(['letter', 'words', 'actor']);
/** RCB-70: `POST /api/cards/:id/notes` — a durable, attributed remark under `## Notes`. */
const NOTES_FIELDS: ReadonlySet<string> = new Set(['text', 'actor']);
const TAKE_LEASE_FIELDS: ReadonlySet<string> = new Set([
  'resource',
  'until',
  'note',
  'force',
  'actor',
]);
const RELEASE_LEASE_FIELDS: ReadonlySet<string> = new Set(['resource', 'force', 'actor']);
const ADD_WINDOW_FIELDS: ReadonlySet<string> = new Set([
  'resource',
  'start',
  'end',
  'name',
  'actor',
]);
const SET_STATE_FIELDS: ReadonlySet<string> = new Set(['section', 'body', 'actor']);
/** RCB-34/P7.3: `PATCH /api/board` — `columns` is the WHOLE new list (a replace), like PATCH_FIELDS. */
const SET_COLUMNS_FIELDS: ReadonlySet<string> = new Set(['columns', 'actor']);
const APPEND_LOG_FIELDS: ReadonlySet<string> = new Set(['seat', 'title', 'text']);
const ARCHIVE_FIELDS: ReadonlySet<string> = new Set(['olderThan', 'dryRun', 'actor']);
const SYNC_ISSUES_FIELDS: ReadonlySet<string> = new Set([
  'path',
  'heading',
  'status',
  'label',
  'dryRun',
  'actor',
]);
const SECTION_NAMES: ReadonlySet<string> = new Set(['LIVE', 'LAST-LANDINGS', 'SEATS']);
const SECTION_KEY_OF: Record<string, StateSectionName> = {
  LIVE: 'live',
  'LAST-LANDINGS': 'lastLandings',
  SEATS: 'seats',
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

function isPlainObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function optString(body: Json, key: string): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new HttpError(400, `${key} must be a string`);
  return v;
}

/** `undefined` = absent, `null` = clear, else must pass `check`. */
function nullable<T>(body: Json, key: string, check: (v: unknown) => v is T, what: string) {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!check(v)) throw new HttpError(400, `${key} must be ${what}`);
  return v;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isPriority = (v: unknown): v is Priority => typeof v === 'string' && PRIORITIES.has(v);
const isSize = (v: unknown): v is Size => typeof v === 'string' && SIZES.has(v);

function rejectUnknown(body: Json, allowed: ReadonlySet<string>): void {
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) throw new HttpError(400, `unknown field "${k}"`);
  }
}

function toCreateInput(body: Json): CreateCardInput {
  rejectUnknown(body, CREATE_FIELDS);
  const title = body.title;
  if (typeof title !== 'string' || title.length === 0) {
    throw new HttpError(400, 'title is required');
  }
  const input: CreateCardInput = { title };
  const status = optString(body, 'status');
  if (status !== undefined) input.status = status;
  const assignee = optString(body, 'assignee');
  if (assignee !== undefined) input.assignee = assignee;
  const bodyText = optString(body, 'body');
  if (bodyText !== undefined) input.body = bodyText;
  if (body.priority !== undefined) {
    if (!isPriority(body.priority)) throw new HttpError(400, 'priority must be high|medium|low');
    input.priority = body.priority;
  }
  if (body.size !== undefined) {
    if (!isSize(body.size)) throw new HttpError(400, 'size must be S|M|L|XL');
    input.size = body.size;
  }
  if (body.labels !== undefined) {
    if (!isStringArray(body.labels)) throw new HttpError(400, 'labels must be string[]');
    input.labels = body.labels;
  }
  if (body.files !== undefined) {
    if (!isStringArray(body.files)) throw new HttpError(400, 'files must be string[]');
    input.files = body.files;
  }
  if (body.refs !== undefined) {
    if (!isStringArray(body.refs)) throw new HttpError(400, 'refs must be string[]');
    input.refs = body.refs;
  }
  const parent = optString(body, 'parent');
  if (parent !== undefined) input.parent = parent;
  const phase = optString(body, 'phase');
  if (phase !== undefined) input.phase = phase;
  const gate = optString(body, 'gate');
  if (gate !== undefined) input.gate = gate;
  return input;
}

function toPatch(body: Json): CardPatch {
  const patch: CardPatch = {};
  const title = optString(body, 'title');
  if (title !== undefined) patch.title = title;
  const bodyText = optString(body, 'body');
  if (bodyText !== undefined) patch.body = bodyText;
  const assignee = nullable(body, 'assignee', isString, 'a string');
  if (assignee !== undefined) patch.assignee = assignee;
  const priority = nullable(body, 'priority', isPriority, 'high|medium|low');
  if (priority !== undefined) patch.priority = priority;
  const size = nullable(body, 'size', isSize, 'S|M|L|XL');
  if (size !== undefined) patch.size = size;
  const labels = nullable(body, 'labels', isStringArray, 'string[]');
  if (labels !== undefined) patch.labels = labels;
  const files = nullable(body, 'files', isStringArray, 'string[]');
  if (files !== undefined) patch.files = files;
  const refs = nullable(body, 'refs', isStringArray, 'string[]');
  if (refs !== undefined) patch.refs = refs;
  const parent = nullable(body, 'parent', isString, 'a string');
  if (parent !== undefined) patch.parent = parent;
  const phase = nullable(body, 'phase', isString, 'a string');
  if (phase !== undefined) patch.phase = phase;
  const gate = nullable(body, 'gate', isString, 'a string');
  if (gate !== undefined) patch.gate = gate;
  return patch;
}

/**
 * K10: one place turns a store failure into a status. `readOnly` (the served root has no
 * `.repoboard/`) is 409 — the request was well formed and the state of the target forbids it;
 * `notFound` stays 404 and everything else stays 400.
 */
function failureStatus(res: { notFound?: boolean; readOnly?: boolean }): number {
  if (res.readOnly === true) return 409;
  return res.notFound === true ? 404 : 400;
}

/**
 * P8.1: like `failureStatus`, plus 409 when the request conflicts with the decision's own state
 * — nothing open to decide, or one already open to ask again without `replace`. Everything else
 * (an unknown letter, an empty question, a duplicate option) is a 400: the request itself is bad,
 * not just untimely.
 */
const DECISION_CONFLICT = /no decision is open on|already has an open decision/;
function decisionFailureStatus(res: {
  notFound?: boolean;
  readOnly?: boolean;
  error: string;
}): number {
  if (res.readOnly === true) return 409;
  if (res.notFound === true) return 404;
  return DECISION_CONFLICT.test(res.error) ? 409 : 400;
}

/**
 * P8.2: like `decisionFailureStatus` — `readOnly` (map-only) is 409; a request that conflicts
 * with who currently holds the resource ("is held by …") is also 409 (well-formed, untimely);
 * everything else (an empty resource, `end` not after `start`) is 400.
 */
const LEASE_CONFLICT = /is held by|no lease is held on/;
function leaseFailureStatus(res: { readOnly?: boolean; error: string }): number {
  if (res.readOnly === true) return 409;
  return LEASE_CONFLICT.test(res.error) ? 409 : 400;
}

interface TakeLeaseHttpInput {
  resource: string;
  until?: string;
  note?: string;
  force?: boolean;
}

function toTakeLeaseInput(body: Json): TakeLeaseHttpInput {
  rejectUnknown(body, TAKE_LEASE_FIELDS);
  const resource = body.resource;
  if (typeof resource !== 'string' || resource.trim().length === 0) {
    throw new HttpError(400, 'resource is required');
  }
  const input: TakeLeaseHttpInput = { resource };
  const until = optString(body, 'until');
  if (until !== undefined) input.until = until;
  const note = optString(body, 'note');
  if (note !== undefined) input.note = note;
  if (body.force !== undefined) {
    if (typeof body.force !== 'boolean') throw new HttpError(400, 'force must be a boolean');
    input.force = body.force;
  }
  return input;
}

interface ReleaseLeaseHttpInput {
  resource: string;
  force?: boolean;
}

function toReleaseLeaseInput(body: Json): ReleaseLeaseHttpInput {
  rejectUnknown(body, RELEASE_LEASE_FIELDS);
  const resource = body.resource;
  if (typeof resource !== 'string' || resource.trim().length === 0) {
    throw new HttpError(400, 'resource is required');
  }
  const input: ReleaseLeaseHttpInput = { resource };
  if (body.force !== undefined) {
    if (typeof body.force !== 'boolean') throw new HttpError(400, 'force must be a boolean');
    input.force = body.force;
  }
  return input;
}

interface AddWindowHttpInput {
  resource: string;
  start: string;
  end: string;
  name: string;
}

function toAddWindowInput(body: Json): AddWindowHttpInput {
  rejectUnknown(body, ADD_WINDOW_FIELDS);
  const resource = optString(body, 'resource');
  const start = optString(body, 'start');
  const end = optString(body, 'end');
  const name = optString(body, 'name');
  if (!resource) throw new HttpError(400, 'resource is required');
  if (!start) throw new HttpError(400, 'start is required');
  if (!end) throw new HttpError(400, 'end is required');
  if (!name) throw new HttpError(400, 'name is required');
  return { resource, start, end, name };
}

interface SetStateHttpInput {
  section: StateSectionName;
  body: string;
}

function toSetStateInput(body: Json): SetStateHttpInput {
  rejectUnknown(body, SET_STATE_FIELDS);
  const section = body.section;
  if (typeof section !== 'string' || !SECTION_NAMES.has(section)) {
    throw new HttpError(400, 'section must be one of LIVE, LAST-LANDINGS, SEATS');
  }
  const text = body.body;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new HttpError(400, 'body is required');
  }
  const key = SECTION_KEY_OF[section];
  if (!key) throw new HttpError(400, 'section must be one of LIVE, LAST-LANDINGS, SEATS');
  return { section: key, body: text };
}

/**
 * RCB-34/P7.3: shape-check only — is `columns` an array of plain objects at all? The real
 * validation (≥1 column, unique ids, `id`/`wip` types, etc.) is `store.setColumns`'s
 * `parseBoard(serializeBoard(next))` round trip, the same schema a hand edit of `board.yml`
 * would get. This just keeps a malformed body (not an array, or an array of non-objects) from
 * reaching `serializeBoard` and throwing instead of producing a clean 400.
 */
function toSetColumnsInput(body: Json): Column[] {
  rejectUnknown(body, SET_COLUMNS_FIELDS);
  const columns = body.columns;
  if (!Array.isArray(columns) || !columns.every(isPlainObject)) {
    throw new HttpError(400, 'columns must be an array of objects');
  }
  return columns as Column[];
}

interface AppendLogHttpInput {
  seat: string;
  title?: string;
  text: string;
}

function toAppendLogInput(body: Json): AppendLogHttpInput {
  rejectUnknown(body, APPEND_LOG_FIELDS);
  const seat = body.seat;
  if (typeof seat !== 'string' || seat.trim().length === 0) {
    throw new HttpError(400, 'seat is required');
  }
  const text = body.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new HttpError(400, 'text is required');
  }
  const input: AppendLogHttpInput = { seat, text };
  const title = optString(body, 'title');
  if (title !== undefined) input.title = title;
  return input;
}

function isOptionArray(v: unknown): v is DecisionOption[] {
  return (
    Array.isArray(v) &&
    v.every(
      (o) =>
        isPlainObject(o) &&
        typeof o.letter === 'string' &&
        o.letter.length > 0 &&
        typeof o.text === 'string',
    )
  );
}

interface AskInput {
  question: string;
  options?: DecisionOption[];
  replace?: boolean;
  kind?: 'task';
}

function toAskInput(body: Json): AskInput {
  rejectUnknown(body, ASK_FIELDS);
  const question = body.question;
  if (typeof question !== 'string' || question.trim().length === 0) {
    throw new HttpError(400, 'question is required');
  }
  const input: AskInput = { question };
  if (body.options !== undefined) {
    if (!isOptionArray(body.options)) {
      throw new HttpError(400, 'options must be [{letter, text}]');
    }
    input.options = body.options;
  }
  if (body.replace !== undefined) {
    if (typeof body.replace !== 'boolean') throw new HttpError(400, 'replace must be a boolean');
    input.replace = body.replace;
  }
  if (body.kind !== undefined) {
    if (body.kind !== 'task') throw new HttpError(400, 'kind must be "task"');
    input.kind = 'task';
  }
  return input;
}

interface DecideInput {
  letter?: string;
  words?: string;
}

function toDecideInput(body: Json): DecideInput {
  rejectUnknown(body, DECIDE_FIELDS);
  const input: DecideInput = {};
  const letter = optString(body, 'letter');
  if (letter !== undefined) input.letter = letter;
  const words = optString(body, 'words');
  if (words !== undefined) input.words = words;
  return input;
}

/** RCB-70: `text` is required (a note with no words is not a note); `actor` defaults to `'web'`. */
function toNoteText(body: Json): string {
  rejectUnknown(body, NOTES_FIELDS);
  const text = body.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new HttpError(400, 'text is required');
  }
  return text;
}

/**
 * Apply a PATCH-shaped body: a `status` change goes through `move`, everything else through
 * `update`. Used by `PATCH /api/cards/:id` and both WS client messages.
 */
async function applyPatch(
  store: CardStore,
  id: string,
  body: Json,
  defaultActor: string,
): Promise<{ card: Card; warnings: string[] }> {
  // P8.1: `decision` is never a PATCH field (it is not in PATCH_FIELDS), but it gets its own
  // message rather than the generic "unknown field" — a silent path around /ask and /decide is
  // how a decision would stop being authority (locked decision 7's own words).
  if ('decision' in body) {
    throw new HttpError(400, 'decision cannot be set via PATCH; use /ask and /decide');
  }
  rejectUnknown(body, PATCH_FIELDS);
  const current = store.get(id);
  if (!current) throw new HttpError(404, `unknown card "${id}"`);
  const actor = optString(body, 'actor') ?? defaultActor;
  const status = optString(body, 'status');
  const patch = toPatch(body);
  const warnings: string[] = [];
  if (status !== undefined && status !== current.status) {
    const res = await store.move(id, status, actor);
    if (!res.ok) throw new HttpError(failureStatus(res), res.error);
    warnings.push(...res.warnings);
  }
  if (Object.keys(patch).length > 0) {
    const res = await store.update(id, patch, actor);
    if (!res.ok) throw new HttpError(failureStatus(res), res.error);
  }
  const card = store.get(id);
  if (!card) throw new HttpError(404, `card "${id}" disappeared during update`);
  return { card, warnings };
}

function readBody(req: IncomingMessage): Promise<Json> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        rej(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim().length === 0) return res({});
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return rej(new HttpError(400, 'body is not valid JSON'));
      }
      if (!isPlainObject(parsed)) return rej(new HttpError(400, 'body must be a JSON object'));
      res(parsed);
    });
    req.on('error', rej);
  });
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function fingerprint(snap: ScanResult): string {
  return JSON.stringify({ head: snap.head, files: snap.files, truncated: snap.truncated });
}

/**
 * K12: what the repo watcher currently holds — one entry per watched directory, plus one per
 * entry chokidar reports inside it (`getWatched()`'s own shape). This is the number that diverges
 * from the scan's file count exactly when the ignore rule is wrong (a gitignored tree the scanner
 * never lists but the watcher still walks), which is why the cap counts THIS and not the scan.
 */
function flattenWatchedPaths(watcher: FSWatcher, root: string): string[] {
  const watched = watcher.getWatched();
  const out: string[] = [];
  for (const [dir, entries] of Object.entries(watched)) {
    const relDir = relative(root, dir).split(sep).join('/');
    out.push(relDir === '' ? '.' : relDir);
    for (const entry of entries) out.push(relDir === '' ? entry : `${relDir}/${entry}`);
  }
  return out;
}

/** RCB-43 slice 1: does `root` have a `.repoboard/` at all — a stat, never an open. Used by
 * `GET /api/repos` for a root nobody has opened yet, and by `serve`'s per-root startup line. */
export function hasBoardDir(root: string): boolean {
  return existsSync(join(root, '.repoboard'));
}

export interface RepoContextOptions {
  store: CardStore;
  fun: boolean;
  scan: boolean;
  watchRepo: boolean;
  rescanDebounceMs: number;
  watchCap: number;
  warn: (m: string) => void;
  siblingsFlag: Sibling[];
  /** Whatever the store already uses; do not add a second clock. Only needed to open OTHER
   * roots' stores the same way (`RepoRegistry.openRepo`) — a context never calls this itself. */
  now?: () => Date;
  /** RCB-125 test seam only: fires once the initial scan has resolved but before the repo
   * watcher is created — the exact gap K16 names. Production callers never set this. */
  afterInitialScan?: () => Promise<void> | void;
}

export interface RepoContext {
  readonly key: string;
  readonly root: string;
  readonly store: CardStore;
  /** THIS root's clients only. */
  readonly wss: WebSocketServer;
  /**
   * RCB-43 slice 2: reached two ways now — unprefixed (`/api/...`), only for the primary; or via
   * `startServer`'s router stripping `/api/repos/<key>` once and handing this the same shape of
   * URL (`/api/...`) it always understood. This function does not know which happened and does
   * not need to — its route matching is unchanged.
   */
  handleApi(method: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void>;
  /**
   * RCB-43 slice 2: accepts a WS upgrade unconditionally — the caller (`startServer`'s `upgrade`
   * handler) has already decided this request belongs to THIS context (`/ws` for the primary,
   * `/api/repos/<key>/ws` for any other root) and does not re-check the path here.
   */
  acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  repo(): ScanResult | null;
  rescan(): Promise<void>;
  /** K12 test surface, unchanged in meaning from the old `RunningServer.watchedPaths()`. */
  watchedPaths(): string[];
  /** K12 test surface, unchanged in meaning from the old `RunningServer.scanCount()`. */
  scanCount(): number;
  /** K12 "map on demand": starts the initial scan (and, if `watchRepo`, the repo watcher) the
   * first time it is called, and memoises. A no-op (but still memoised) when `scan` is false. */
  ensureScanned(): Promise<void>;
  close(): Promise<void>;
}

export async function openRepoContext(key: string, opts: RepoContextOptions): Promise<RepoContext> {
  const { store, fun, scan, watchRepo, watchCap, warn, siblingsFlag } = opts;
  const debounceMs = opts.rescanDebounceMs;
  const root = store.root;

  // RCB-42: recomputed on every call, never cached — `store.config.siblings` can change on a
  // live board.yml edit, `siblingsFlag` cannot (it is fixed for the life of this process).
  const mergedSiblings = (): Sibling[] => mergeSiblings(store.config.siblings ?? [], siblingsFlag);

  let repo: ScanResult | null = null;
  let repoFingerprint = '';
  let scanCount = 0;
  const wss = new WebSocketServer({ noServer: true });

  // §3: one payload for `GET /api/board` and the `board` half of the WS snapshot, so `hasBoard`
  // cannot be true on one and absent on the other.
  // RCB-42: `siblings` sits NEXT TO `config`, not inside it — `config` is board.yml's own
  // content (plus the existing `fun` precedent already living inside it), and a `--sibling` flag
  // is not in the file. Keeping it a sibling key here is what keeps `config` honest about what
  // the file actually says.
  const boardPayload = () => ({
    config: { ...store.config, fun },
    cards: store.list(),
    invalid: store.invalid,
    hasBoard: store.hasBoard,
    siblings: mergedSiblings(),
  });

  // P8.2: one payload for `GET /api/leases` and the `leases` half of the WS snapshot — same
  // reasoning as `boardPayload`. `now` travels with it so a client can render staleness without
  // trusting its own clock; `stale` is resource names, since one lease per resource is unique.
  const leasesPayload = () => {
    const doc = store.leases();
    const nowDate = new Date();
    return {
      leases: doc.leases,
      windows: doc.windows,
      stale: staleLeases(doc, nowDate).map((l) => l.resource),
      now: toIso(nowDate),
    };
  };

  // RCB-97 (plan §3.3): one payload for `GET /api/systems` and the `systems` half of the WS
  // snapshot — same reasoning as `leasesPayload`. Always 200/present: an invalid file is a
  // well-formed answer (`errors` non-empty), like `/api/cost`'s `over: true`.
  const systemsPayload = () => store.systems();

  // P8.3: one payload for `GET /api/state` and the `state` half of the WS snapshot. OWNER QUEUE
  // is generated fresh from cards that need a decision on every call (P8.1) — the doc's own
  // recorded `stamp`/`actor` are reused as the render clock so a READ never looks like a rewrite
  // (only `setStateSection` produces a stamp that reflects the real "now").
  const statePayload = () => {
    const doc = store.state();
    if (!doc) return { stamp: null, actor: null, sections: null, ownerQueue: [], text: null };
    const openCards = store.list().filter((c) => needsDecision(c));
    const ownerQueue = openCards.map((c) => ({
      id: c.id,
      question: c.decision?.question ?? '',
      options: c.decision?.options ?? [],
      ...(isOwnerTask(c) ? { kind: 'task' as const } : {}),
    }));
    const text = renderState(doc.sections, openCards, {
      now: new Date(Date.parse(doc.stamp)),
      actor: doc.actor,
    });
    return { stamp: doc.stamp, actor: doc.actor, sections: doc.sections, ownerQueue, text };
  };

  // P8.3: today's log, by the server's own clock — the WS snapshot's `log` half.
  const todayLogPayload = async () => {
    const log = await store.log();
    return log ?? { date: toIso(store.clock).slice(0, 10), text: '', blocks: [] };
  };

  function broadcast(msg: unknown): void {
    const text = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(text);
    }
  }

  // ---- repo scan + debounced rescan ---------------------------------------------------
  let scanning: Promise<void> | null = null;
  let rescanQueued = false;
  let timer: NodeJS.Timeout | null = null;

  async function doScan(initial: boolean): Promise<void> {
    try {
      const next = await scanRepo(root);
      const fp = fingerprint(next);
      const changed = fp !== repoFingerprint;
      repo = next;
      repoFingerprint = fp;
      scanCount++;
      if (!initial && changed) broadcast({ type: 'repo', repo });
    } catch {
      // A failed rescan keeps the last snapshot; the next change tries again.
    }
  }

  function rescan(): Promise<void> {
    if (scanning) {
      rescanQueued = true;
      return scanning;
    }
    scanning = doScan(false).finally(() => {
      scanning = null;
      if (rescanQueued) {
        rescanQueued = false;
        scheduleRescan();
      }
    });
    return scanning;
  }

  function scheduleRescan(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void rescan();
    }, debounceMs);
  }

  let repoWatcher: FSWatcher | null = null;

  // RCB-43 slice 1 (K12 "map on demand"): the initial scan and the repo watcher used to start
  // unconditionally here at open. They now start the first time anything calls `ensureScanned()`
  // — for the primary, `startServer` still calls it right away when `scan` is true, which is
  // exactly today's behaviour; a non-primary context (opened via `RepoRegistry.openRepo`) is not
  // scanned or watched until something asks (slice 2's `GET /api/repos/<key>/repo` and its WS).
  let scanStarted: Promise<void> | null = null;
  function ensureScanned(): Promise<void> {
    if (scanStarted) return scanStarted;
    scanStarted = (async () => {
      if (scan) await doScan(true);
      await opts.afterInitialScan?.();

      // K12: the watcher's ignore rule must agree with the scanner's idea of "the repo" — see
      // watch-ignore.ts's own header for the measured cause. `gitIgnoredPaths` is empty (not
      // thrown) on a non-git root, which reduces this to exactly the pre-K12 segment-only rule.
      if (scan && watchRepo) {
        const inGit = await isGitRepo(root);
        const ignored = inGit ? await gitIgnoredPaths(root) : EMPTY_IGNORED;
        const watcher = chokidarWatch(root, {
          ignoreInitial: true,
          ignored: buildRepoWatchIgnore(root, ignored),
        });
        repoWatcher = watcher;

        let shutOffOnce = false;
        const shutOff = (reason: string): void => {
          if (shutOffOnce) return;
          shutOffOnce = true;
          warn(`repo watcher off: ${reason} (rescans now only on request)`);
          repoWatcher = null;
          void watcher.close();
        };

        watcher.on('all', () => scheduleRescan());
        // Previously swallowed silently (species 7-shaped: an EMFILE here left the watcher wedged
        // with no signal at all). Now it closes the watcher and says so, once.
        watcher.on('error', (e: unknown) => {
          const code = (e as NodeJS.ErrnoException | undefined)?.code;
          const message = e instanceof Error ? e.message : String(e);
          shutOff(code ? `${code}: ${message}` : message);
        });

        // Wait for the watcher to settle before counting what it holds — an error before `ready`
        // (e.g. an EMFILE mid-walk) must not hang startup either.
        // RCB-125 (K16, half 1): a file created between the initial scan (above) and this
        // `ready` is invisible to the snapshot until the next change. One rescan — the same
        // debounced path a real change takes (`rescan()`, above) — closes that gap. It is fired
        // here but NOT awaited: `ensureScanned()` still resolves the moment `ready` does, exactly
        // as it did before this change (the parked patch awaited it and pushed a second full scan
        // in front of the first map load; that regression is why this fires-and-forgets instead).
        // `rescan()` -> `doScan(false)` already swallows its own errors, so this can never turn
        // into a rejection nobody is watching for.
        await new Promise<void>((res) => {
          watcher.once('ready', () => {
            void rescan();
            res();
          });
          watcher.once('error', () => res());
        });
        if (repoWatcher) {
          const n = flattenWatchedPaths(watcher, root).length;
          if (n > watchCap) shutOff(`${n} watched paths > cap ${watchCap}`);
        }
      }
    })();
    return scanStarted;
  }

  // ---- store → clients ----------------------------------------------------------------
  const onCard = (card: Card) => broadcast({ type: 'card', card });
  const onRemoved = (id: string) => broadcast({ type: 'card:removed', id });
  const onEvent = (event: unknown) => broadcast({ type: 'event', event });
  const onConfig = () =>
    broadcast({ type: 'config', config: { ...store.config, fun }, siblings: mergedSiblings() });
  const onInvalid = (invalid: unknown) => broadcast({ type: 'invalid', invalid });
  const onLeases = () => broadcast({ type: 'leases', leases: leasesPayload() });
  const onSystems = () => broadcast({ type: 'systems', ...systemsPayload() });
  const onState = () => broadcast({ type: 'state', state: statePayload() });
  const onLog = (payload: { date: string; text: string }) =>
    broadcast({ type: 'log', date: payload.date, text: payload.text });
  store.on('card', onCard);
  store.on('card:removed', onRemoved);
  store.on('event', onEvent);
  store.on('config', onConfig);
  store.on('invalid', onInvalid);
  store.on('leases', onLeases);
  store.on('systems', onSystems);
  store.on('state', onState);
  store.on('log', onLog);

  // ---- clients → store ----------------------------------------------------------------
  async function onClientMessage(ws: WebSocket, raw: unknown): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'message is not valid JSON' }));
      return;
    }
    if (!isPlainObject(msg) || typeof msg.type !== 'string') {
      ws.send(JSON.stringify({ type: 'error', message: 'message needs a string "type"' }));
      return;
    }
    const id = typeof msg.id === 'string' ? msg.id : '';
    const actor = typeof msg.actor === 'string' ? msg.actor : 'web';
    try {
      if (msg.type === 'card:move') {
        if (!id || typeof msg.status !== 'string') {
          throw new HttpError(400, 'card:move needs string "id" and "status"');
        }
        const { warnings } = await applyPatch(store, id, { status: msg.status }, actor);
        for (const w of warnings) ws.send(JSON.stringify({ type: 'warning', id, message: w }));
      } else if (msg.type === 'card:update') {
        if (!id || !isPlainObject(msg.patch)) {
          throw new HttpError(400, 'card:update needs string "id" and object "patch"');
        }
        const { warnings } = await applyPatch(store, id, msg.patch, actor);
        for (const w of warnings) ws.send(JSON.stringify({ type: 'warning', id, message: w }));
      } else {
        throw new HttpError(400, `unknown message type "${msg.type}"`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ws.send(JSON.stringify({ type: 'error', id, message }));
    }
  }

  wss.on('connection', (ws) => {
    void todayLogPayload().then((log) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(
        JSON.stringify({
          type: 'snapshot',
          board: boardPayload(),
          repo,
          leases: leasesPayload(),
          systems: systemsPayload(),
          state: statePayload(),
          log,
        }),
      );
    });
    ws.on('message', (data) => void onClientMessage(ws, data));
    ws.on('error', () => undefined);
  });

  // ---- HTTP ---------------------------------------------------------------------------
  async function handleApi(
    method: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const path = url.pathname;
    if (method === 'GET' && path === '/api/board') return sendJson(res, 200, boardPayload());
    // RCB-34/P7.3: the column set, editable from the app (plan §11 O6). `columns` replaces the
    // WHOLE list, like every list in `CardPatch`. Success emits `config` from inside
    // `store.setColumns` itself (see its doc comment) — the WS `{type:'config'}` broadcast
    // already wired at `store.on('config', ...)` below reaches every client from that one emit.
    if (method === 'PATCH' && path === '/api/board') {
      const body = await readBody(req);
      const actor = optString(body, 'actor') ?? 'web';
      const columns = toSetColumnsInput(body);
      const outcome = await store.setColumns(columns, actor);
      if (!outcome.ok) throw new HttpError(failureStatus(outcome), outcome.error);
      return sendJson(res, 200, boardPayload());
    }
    // P8.2: leases/windows. `check` is a pure read (never 400/409 for "blocked" — that is what
    // `clear:false` means), so it stays 200 either way; the others follow the ask/decide shape.
    if (method === 'GET' && path === '/api/leases') return sendJson(res, 200, leasesPayload());
    const checkMatch = /^\/api\/leases\/check\/([^/]+)$/.exec(path);
    if (method === 'GET' && checkMatch?.[1] !== undefined) {
      const resource = decodeURIComponent(checkMatch[1]);
      const atParam = url.searchParams.get('at');
      let at: Date | undefined;
      if (atParam !== null) {
        at = new Date(atParam);
        if (Number.isNaN(at.getTime())) throw new HttpError(400, 'at must be an ISO-8601 datetime');
      }
      return sendJson(res, 200, store.checkResource(resource, at));
    }
    if (method === 'POST' && path === '/api/leases/take') {
      const body = await readBody(req);
      const actor = optString(body, 'actor') ?? 'web';
      const input = toTakeLeaseInput(body);
      const outcome = await store.takeLease(input, actor);
      if (!outcome.ok) throw new HttpError(leaseFailureStatus(outcome), outcome.error);
      if (outcome.warnings.length > 0) {
        res.setHeader('x-repoboard-warnings', JSON.stringify(outcome.warnings));
      }
      return sendJson(res, 200, leasesPayload());
    }
    if (method === 'POST' && path === '/api/leases/release') {
      const body = await readBody(req);
      const actor = optString(body, 'actor') ?? 'web';
      const input = toReleaseLeaseInput(body);
      const outcome = await store.releaseLease(input, actor);
      if (!outcome.ok) throw new HttpError(leaseFailureStatus(outcome), outcome.error);
      if (outcome.warnings.length > 0) {
        res.setHeader('x-repoboard-warnings', JSON.stringify(outcome.warnings));
      }
      return sendJson(res, 200, leasesPayload());
    }
    if (method === 'POST' && path === '/api/leases/windows') {
      const body = await readBody(req);
      const actor = optString(body, 'actor') ?? 'web';
      const input = toAddWindowInput(body);
      const outcome = await store.addWindow(input, actor);
      if (!outcome.ok) throw new HttpError(leaseFailureStatus(outcome), outcome.error);
      return sendJson(res, 200, leasesPayload());
    }
    // P8.3: state / log / check.
    if (method === 'GET' && path === '/api/state') return sendJson(res, 200, statePayload());
    if (method === 'PUT' && path === '/api/state/section') {
      const body = await readBody(req);
      const actor = optString(body, 'actor') ?? 'web';
      const input = toSetStateInput(body);
      const outcome = await store.setStateSection(input.section, input.body, actor);
      if (!outcome.ok) throw new HttpError(outcome.readOnly ? 409 : 400, outcome.error);
      return sendJson(res, 200, statePayload());
    }
    if (method === 'GET' && path === '/api/log') {
      const date = url.searchParams.get('date') ?? undefined;
      const log = await store.log(date);
      if (!log) throw new HttpError(404, `no log for ${date ?? 'today'}`);
      return sendJson(res, 200, log);
    }
    if (method === 'POST' && path === '/api/log') {
      const body = await readBody(req);
      const input = toAppendLogInput(body);
      // RCB-127: the same `appendSeatLog` CLI `log --as` and MCP `append_repo_log` call — one
      // guarantee on every surface: an UP seat's block also restamps STATE.md.
      const outcome = await store.appendSeatLog(input.seat, input.text, input.title);
      if (!outcome.ok) throw new HttpError(outcome.readOnly ? 409 : 400, outcome.error);
      return sendJson(res, 200, {
        date: outcome.date,
        text: outcome.text,
        block: outcome.block,
        restamped: outcome.restamped,
      });
    }
    if (method === 'GET' && path === '/api/check') {
      const strict =
        url.searchParams.get('strict') === '1' || url.searchParams.get('strict') === 'true';
      const outcome = await store.check(strict);
      return sendJson(res, 200, outcome);
    }
    // P8.4: a pure read, always 200 — `over: true` is a well-formed answer, not a failed request
    // (same reasoning as `GET /api/leases/check/:resource`).
    if (method === 'GET' && path === '/api/cost') {
      const budgetParam = url.searchParams.get('budget');
      let budget: number | undefined;
      if (budgetParam !== null) {
        budget = Number.parseInt(budgetParam, 10);
        if (!Number.isInteger(budget) || budget <= 0) {
          throw new HttpError(400, 'budget must be a positive integer');
        }
      }
      return sendJson(res, 200, await store.cost(budget));
    }
    // RCB-97 (plan §3.3): a pure read, always 200 — an invalid systems.yml is a well-formed
    // answer (`errors` non-empty), same reasoning as `/api/cost`'s `over: true`.
    if (method === 'GET' && path === '/api/systems') return sendJson(res, 200, systemsPayload());
    // RCB-111: the Flow view's "Plan the systems map" button — a dry-run `systems detect`
    // (never `--apply`; the only writes here are the four `store.create` calls below) turned
    // into a parent card plus three PH.1..PH.3 steps. 409 when there is nothing to plan onto
    // (no board) or nothing to plan (systems.yml already exists) — read-only otherwise.
    if (method === 'POST' && path === '/api/systems/plan') {
      const body = await readBody(req);
      const actor = optString(body, 'actor') ?? 'web';
      if (!store.hasBoard) {
        throw new HttpError(409, 'no .repoboard/ here — map-only; run repoboard init first');
      }
      if (store.systems().exists) throw new HttpError(409, 'systems.yml already exists');
      const run = await runDetect(root, { apply: false, now: store.clock });
      if (run.errors.length > 0) throw new HttpError(400, run.errors.join('; '));
      const counts = {
        systems: run.candidates.systems.length,
        connections: run.candidates.connections.length,
        unclassified: run.candidates.unclassified.length,
      };
      const repoName = boardDisplayName(store.config, root);
      const plan = planSystemsMap({ repoName, counts });
      const parentResult = await store.create(plan.parent, actor);
      if (!parentResult.ok) throw new HttpError(failureStatus(parentResult), parentResult.error);
      const steps: Card[] = [];
      for (const step of plan.steps) {
        const stepResult = await store.create({ ...step, parent: parentResult.card.id }, actor);
        if (!stepResult.ok) throw new HttpError(failureStatus(stepResult), stepResult.error);
        steps.push(stepResult.card);
      }
      return sendJson(res, 201, { parent: parentResult.card, steps });
    }
    // RCB-98 (plan §3.4): a system's `pointers` resolved live, the same resolver
    // `cmdSystemsShow` uses — the drawer's References section for a system, not a card.
    const systemRefsMatch = /^\/api\/systems\/([^/]+)\/refs$/.exec(path);
    if (method === 'GET' && systemRefsMatch?.[1] !== undefined) {
      const id = decodeURIComponent(systemRefsMatch[1]);
      const { doc } = systemsPayload();
      const system = doc?.systems.find((s) => s.id === id);
      if (!doc || !system) throw new HttpError(404, `unknown system "${id}"`);
      return sendJson(
        res,
        200,
        await Promise.all(system.pointers.map((p) => resolveRefSpec(root, p))),
      );
    }
    // RCB-110: which test files import or name each of a system's pointers — static, live,
    // same 404 shape as /refs above.
    const systemTestsMatch = /^\/api\/systems\/([^/]+)\/tests$/.exec(path);
    if (method === 'GET' && systemTestsMatch?.[1] !== undefined) {
      const id = decodeURIComponent(systemTestsMatch[1]);
      const { doc } = systemsPayload();
      const system = doc?.systems.find((s) => s.id === id);
      if (!doc || !system) throw new HttpError(404, `unknown system "${id}"`);
      return sendJson(res, 200, await systemTests(root, system.pointers));
    }
    // RCB-112 A: health (a recorded gate ledger, never re-run) + commits (git, live) + coverage
    // (RCB-110's per-system line, corpus loaded once) — always 200, same "well-formed answer even
    // when everything is null" reasoning as `/api/cost` and `/api/systems`.
    if (method === 'GET' && path === '/api/dashboard') {
      const { doc } = systemsPayload();
      const now = new Date();
      return sendJson(res, 200, await repoDashboard(root, doc, now));
    }
    // P8.5: archive/sync-issues. Both are POST-only (they can write) and both accept a `dryRun`
    // that never calls a store writer at all — the same "pure read, always 200" reasoning as
    // `/api/leases/check/:resource` and `/api/cost` does not apply here (a real run DOES write),
    // so only the dry-run half stays unconditionally 200.
    if (method === 'POST' && path === '/api/archive') {
      const body = await readBody(req);
      rejectUnknown(body, ARCHIVE_FIELDS);
      const olderThanRaw = optString(body, 'olderThan') ?? '14d';
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
        throw new HttpError(400, 'dryRun must be a boolean');
      }
      const dryRun = body.dryRun === true;
      const actor = optString(body, 'actor') ?? 'web';
      const older = resolveOlderThan(olderThanRaw, store.clock);
      if (!older.ok) throw new HttpError(400, older.error);
      const ids = store.selectArchivable(older.cutoff);
      if (dryRun) return sendJson(res, 200, { dryRun: true, ids });
      if (ids.length === 0) return sendJson(res, 200, { dryRun: false, archived: [] });
      const outcome = await store.archiveCards(ids, actor);
      if (!outcome.ok) throw new HttpError(outcome.readOnly === true ? 409 : 400, outcome.error);
      return sendJson(res, 200, { dryRun: false, archived: outcome.archived });
    }
    if (method === 'POST' && path === '/api/sync-issues') {
      const body = await readBody(req);
      rejectUnknown(body, SYNC_ISSUES_FIELDS);
      const p = optString(body, 'path');
      const heading = optString(body, 'heading');
      if (!p) throw new HttpError(400, 'path is required');
      if (!heading) throw new HttpError(400, 'heading is required');
      const status = optString(body, 'status') ?? 'todo';
      const label = optString(body, 'label') ?? 'issue';
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
        throw new HttpError(400, 'dryRun must be a boolean');
      }
      const dryRun = body.dryRun === true;
      const actor = optString(body, 'actor') ?? 'web';
      const input = { path: p, heading, status, label };
      const outcome = await computeSyncPlan(store, input);
      if (!outcome.ok) throw new HttpError(400, outcome.error);
      const { plan, malformed } = outcome;
      if (dryRun) {
        return sendJson(res, 200, {
          dryRun: true,
          create: plan.create,
          close: plan.close,
          malformed,
          unchanged: plan.unchanged,
        });
      }
      const applied = await applySyncPlan(store, input, plan, actor);
      return sendJson(res, 200, {
        dryRun: false,
        created: applied.created,
        closed: applied.closed,
        malformed,
        errors: applied.errors,
      });
    }
    if (method === 'GET' && path === '/api/repo') {
      if (!repo) throw new HttpError(404, 'repo scanning is disabled');
      return sendJson(res, 200, repo);
    }
    if (method === 'GET' && path === '/api/events') {
      const since = url.searchParams.get('since') ?? undefined;
      return sendJson(res, 200, store.events(since));
    }
    if (method === 'POST' && path === '/api/cards') {
      const body = await readBody(req);
      const actor = optString(body, 'actor') ?? 'web';
      const input = toCreateInput(body);
      const created = await store.create(input, actor);
      if (!created.ok) throw new HttpError(failureStatus(created), created.error);
      return sendJson(res, 201, created.card);
    }
    // K7: the referenced lines, read from the files on every request (never cached). The only
    // path from a spec to the filesystem is resolveRepoPath, inside resolveCardRefs.
    const refsMatch = /^\/api\/cards\/([^/]+)\/refs$/.exec(path);
    if (method === 'GET' && refsMatch?.[1] !== undefined) {
      const id = decodeURIComponent(refsMatch[1]);
      const card = store.get(id);
      if (!card) throw new HttpError(404, `unknown card "${id}"`);
      return sendJson(res, 200, await resolveCardRefs(root, card));
    }
    // P8.1: ask/decide are the only writers of `decision` — PATCH refuses the field above.
    const askMatch = /^\/api\/cards\/([^/]+)\/ask$/.exec(path);
    if (method === 'POST' && askMatch?.[1] !== undefined) {
      const id = decodeURIComponent(askMatch[1]);
      const body = await readBody(req);
      const actor = optString(body, 'actor') ?? 'web';
      const input = toAskInput(body);
      const outcome = await store.ask(id, input, actor);
      if (!outcome.ok) throw new HttpError(decisionFailureStatus(outcome), outcome.error);
      if (outcome.warnings.length > 0) {
        res.setHeader('x-repoboard-warnings', JSON.stringify(outcome.warnings));
      }
      return sendJson(res, 200, outcome.card);
    }
    const decideMatch = /^\/api\/cards\/([^/]+)\/decide$/.exec(path);
    if (method === 'POST' && decideMatch?.[1] !== undefined) {
      const id = decodeURIComponent(decideMatch[1]);
      const body = await readBody(req);
      const actor = optString(body, 'actor') ?? 'web';
      const input = toDecideInput(body);
      const outcome = await store.decide(id, input, actor);
      if (!outcome.ok) throw new HttpError(decisionFailureStatus(outcome), outcome.error);
      if (outcome.warnings.length > 0) {
        res.setHeader('x-repoboard-warnings', JSON.stringify(outcome.warnings));
      }
      return sendJson(res, 200, outcome.card);
    }
    // RCB-70: a durable, attributed remark under `## Notes` — the drawer's notes box and the CLI
    // `card note` / MCP `add_note` all funnel through `store.addNote`.
    const notesMatch = /^\/api\/cards\/([^/]+)\/notes$/.exec(path);
    if (method === 'POST' && notesMatch?.[1] !== undefined) {
      const id = decodeURIComponent(notesMatch[1]);
      const body = await readBody(req);
      const actor = optString(body, 'actor') ?? 'web';
      const text = toNoteText(body);
      const outcome = await store.addNote(id, text, actor);
      if (!outcome.ok) throw new HttpError(failureStatus(outcome), outcome.error);
      return sendJson(res, 200, outcome.card);
    }
    const m = /^\/api\/cards\/([^/]+)$/.exec(path);
    if (m?.[1] !== undefined) {
      const id = decodeURIComponent(m[1]);
      if (method === 'GET') {
        const card = store.get(id);
        if (!card) throw new HttpError(404, `unknown card "${id}"`);
        return sendJson(res, 200, card);
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        const { card, warnings } = await applyPatch(store, id, body, 'web');
        if (warnings.length > 0) res.setHeader('x-repoboard-warnings', JSON.stringify(warnings));
        return sendJson(res, 200, card);
      }
    }
    throw new HttpError(404, `no route for ${method} ${path}`);
  }

  function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }

  let closed = false;
  return {
    key,
    root,
    store,
    wss,
    handleApi,
    acceptUpgrade,
    repo: () => repo,
    rescan,
    watchedPaths: () => (repoWatcher ? flattenWatchedPaths(repoWatcher, root) : []),
    scanCount: () => scanCount,
    ensureScanned,
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      store.off('card', onCard);
      store.off('card:removed', onRemoved);
      store.off('event', onEvent);
      store.off('config', onConfig);
      store.off('invalid', onInvalid);
      store.off('leases', onLeases);
      store.off('systems', onSystems);
      store.off('state', onState);
      store.off('log', onLog);
      if (repoWatcher) await repoWatcher.close();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
    },
  };
}

/** RCB-43 slice 1: one entry in the `--root` list, key-assigned in `--root` order. */
export interface RootEntry {
  readonly key: string;
  readonly root: string;
}

/**
 * Keys: the root's folder name (`basename`), lower-cased; on collision append `-2`, `-3` in
 * `--root` order. The one place this is computed — `RepoRegistry` and `serve`'s startup line
 * both call it, so a key never means two different things in the same process.
 */
export function assignRepoKeys(roots: string[]): RootEntry[] {
  const counts = new Map<string, number>();
  // RCB-43 slice 2: `repos` is reserved — `GET /api/repos` is the list route, so a root whose
  // folder is literally `repos` must not collide with it. Seeding the count as if one `repos`
  // already exists makes the first real one `repos-2`, same as any other name collision.
  counts.set('repos', 1);
  return roots.map((root) => {
    const base = basename(root).toLowerCase();
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    return { key: n === 1 ? base : `${base}-${n}`, root };
  });
}

/** The per-process settings every context this registry opens (never the primary) is opened with. */
type RegistryTemplate = Omit<RepoContextOptions, 'store'>;

/**
 * RCB-153 W6: a plain `string[]` still goes through `assignRepoKeys` exactly as before (the
 * byte-identical `--root` path); a pre-keyed `RootEntry[]` — the workspace's own basename key plus
 * each member's CONFIGURED `repos[].key` (`cli.ts`'s `workspaceServeRoots`) — is used as given.
 * One key function (`assignRepoKeys`) still exists; this only decides whether to call it, so a
 * configured key is never re-derived from the folder name.
 */
function isKeyedRoots(
  roots: readonly string[] | readonly RootEntry[],
): roots is readonly RootEntry[] {
  return roots.length > 0 && typeof roots[0] !== 'string';
}

/**
 * RCB-43 slice 1: a lazy, keyed table of `RepoContext`s over the `--root` list (K12 "map on
 * demand"). The primary is opened eagerly by `startServer`, which hands it to `setOpened` —
 * this class never opens it and never closes its store. Every other root opens on its first
 * `openRepo(key)`, memoised as a `Promise` so two concurrent first callers (slice 2's
 * `GET /api/repos/<key>/…` and its WS upgrade) open exactly one context.
 */
export class RepoRegistry {
  readonly roots: RootEntry[];
  private readonly template: RegistryTemplate;
  private readonly opened = new Map<string, RepoContext | Promise<RepoContext>>();
  /** Roots THIS registry opened (and so must close, store included) — never the primary. */
  private readonly ownedStores = new Map<string, CardStore>();

  constructor(roots: readonly string[] | readonly RootEntry[], template: RegistryTemplate) {
    if (isKeyedRoots(roots)) {
      this.roots = [...roots];
    } else {
      this.roots = assignRepoKeys([...roots]);
    }
    this.template = template;
  }

  get primaryKey(): string {
    const first = this.roots[0];
    if (!first) throw new Error('RepoRegistry: no roots');
    return first.key;
  }

  private rootFor(key: string): string | undefined {
    return this.roots.find((r) => r.key === key)?.root;
  }

  /** Register an already-open context — used once, for the primary, by `startServer`. */
  setOpened(key: string, ctx: RepoContext): void {
    this.opened.set(key, ctx);
  }

  /** Currently open (resolved) contexts, in `--root` order. Slice-1 test surface (`repos()`). */
  openedContexts(): RepoContext[] {
    const out: RepoContext[] = [];
    for (const { key } of this.roots) {
      const ctx = this.context(key);
      if (ctx) out.push(ctx);
    }
    return out;
  }

  /** A resolved context, or `undefined` if `key` is unknown, still opening, or unopened. */
  context(key: string): RepoContext | undefined {
    const v = this.opened.get(key);
    return v instanceof Promise ? undefined : v;
  }

  /** Open (or return the in-flight/already-open) context for `key`, memoised. */
  openRepo(key: string): Promise<RepoContext> {
    const existing = this.opened.get(key);
    if (existing) return Promise.resolve(existing);
    const root = this.rootFor(key);
    if (!root) return Promise.reject(new Error(`unknown repo key "${key}"`));
    const opening = (async (): Promise<RepoContext> => {
      const store = await openStore(root, { watch: true, now: this.template.now });
      this.ownedStores.set(key, store);
      const ctx = await openRepoContext(key, { store, ...this.template });
      this.opened.set(key, ctx);
      return ctx;
    })();
    this.opened.set(key, opening);
    // A failed open must not be memoised: the next request retries instead of replaying the
    // same rejection for the life of the process (a root that was unreadable once may not be
    // unreadable forever). The store opened before the failure, if any, is closed by closeAll().
    opening.catch(() => {
      if (this.opened.get(key) === opening) this.opened.delete(key);
    });
    return opening;
  }

  /** Close every opened context, and the store this registry itself opened for it. */
  async closeAll(): Promise<void> {
    for (const { key } of this.roots) {
      const v = this.opened.get(key);
      if (!v) continue;
      const ctx = await v;
      await ctx.close();
      const owned = this.ownedStores.get(key);
      if (owned) await owned.close();
    }
  }
}
