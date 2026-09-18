/**
 * P2.3 HTTP + WebSocket per BUILD-PLAN §3. Node `http` + `ws`, no framework.
 * Binds 127.0.0.1 only (§0.2). Every mutation goes through the store (and so through core);
 * the watcher echoes the result back to every client.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Card,
  type CardPatch,
  type CreateCardInput,
  type DecisionOption,
  mergeSiblings,
  needsDecision,
  type Priority,
  renderState,
  resolveOlderThan,
  type Sibling,
  type StateSectionName,
  staleLeases,
  toIso,
} from '@repoboard/core';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { type WebSocket, WebSocketServer } from 'ws';
import { applySyncPlan, computeSyncPlan } from './issues.js';
import { resolveCardRefs } from './refs.js';
import { isGitRepo, type ScanResult, scanRepo } from './scanner.js';
import type { CardStore } from './store.js';
import { buildRepoWatchIgnore, EMPTY_IGNORED, gitIgnoredPaths } from './watch-ignore.js';

export interface ServerOptions {
  store: CardStore;
  /** Default 4242. 0 picks a free port (tests). */
  port?: number;
  /** Default 127.0.0.1. Never a public interface (§0.2). */
  host?: string;
  /** D9: passed to the web as `config.fun`. Default true. */
  fun?: boolean;
  /** Scan the repo at start and on changes. Default true. */
  scan?: boolean;
  /** Watch the repo (not `.repoboard/`) and rescan, debounced. Default = `scan`. */
  watchRepo?: boolean;
  /** Debounce for rescans and `repo` broadcasts. Default 2000 ms (§3: ≤ 1 per 2 s). */
  rescanDebounceMs?: number;
  /** Static directory override; otherwise dist/web then ../web/dist. */
  webDir?: string;
  /**
   * K12: hard cap on watched paths (directories + entries, `getWatched()`-counted) checked once
   * the repo watcher is ready. Over cap — or an EMFILE/ENFILE from the watcher itself — closes it
   * and serves from the last scan only; a rescan then happens only on request. Default 20,000
   * (`DEFAULT_WATCH_CAP`); CLI `--watch-cap <n>`.
   */
  watchCap?: number;
  /** One-line warnings (repo watcher capped or closed by an EMFILE/ENFILE). Default a no-op. */
  warn?: (message: string) => void;
  /**
   * RCB-42: `serve --sibling <name>=<url>` flags, already parsed and validated by the CLI.
   * Per-process, additive on top of `board.yml`'s `siblings:` list — merged here (`mergeSiblings`)
   * into the one list the web renders, so the merge happens exactly once and the web never does
   * it. Default `[]`.
   */
  siblingsFlag?: Sibling[];
}

/** K12 default for `ServerOptions.watchCap`. */
export const DEFAULT_WATCH_CAP = 20_000;

export interface RunningServer {
  host: string;
  port: number;
  url: string;
  /** Directory the UI is served from, or null when "web not built". */
  webDir: string | null;
  repo(): ScanResult | null;
  rescan(): Promise<void>;
  /**
   * K12 test surface: the repo watcher's currently watched paths (a directory plus each entry
   * name chokidar reports inside it, repo-relative posix), or `[]` when scanning/watching is off,
   * the cap tripped, or an EMFILE/ENFILE closed it. Production code has no reason to call this.
   */
  watchedPaths(): string[];
  /** K12 test surface: how many times `doScan` has completed (initial + rescans). */
  scanCount(): number;
  close(): Promise<void>;
}

const DEFAULT_PORT = 4242;
const MAX_BODY = 1024 * 1024;
const PATCH_FIELDS: ReadonlySet<string> = new Set([
  'status',
  'title',
  'assignee',
  'priority',
  'labels',
  'files',
  'refs',
  'body',
  'actor',
]);
const CREATE_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'status',
  'assignee',
  'priority',
  'labels',
  'files',
  'refs',
  'body',
  'actor',
]);
const PRIORITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);
const ASK_FIELDS: ReadonlySet<string> = new Set(['question', 'options', 'replace', 'actor']);
const DECIDE_FIELDS: ReadonlySet<string> = new Set(['letter', 'words', 'actor']);
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

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

class HttpError extends Error {
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
  const labels = nullable(body, 'labels', isStringArray, 'string[]');
  if (labels !== undefined) patch.labels = labels;
  const files = nullable(body, 'files', isStringArray, 'string[]');
  if (files !== undefined) patch.files = files;
  const refs = nullable(body, 'refs', isStringArray, 'string[]');
  if (refs !== undefined) patch.refs = refs;
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

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

const NOT_BUILT_HTML = `<!doctype html>
<meta charset="utf-8">
<title>repoboard — web not built</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40em;margin:4em auto;padding:0 1em}code{background:#eee;padding:.1em .3em}</style>
<h1>repoboard: web not built</h1>
<p>The server is running, but no UI bundle was found. Build it with <code>pnpm build</code>
at the repo root, then reload.</p>
<p>Meanwhile the API works: <a href="/api/board">/api/board</a>, <a href="/api/repo">/api/repo</a>,
<a href="/api/events">/api/events</a>.</p>
`;

function packageDir(): string {
  // src/http.ts and dist/http.js (or a dist chunk) both sit one level under the package.
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function findWebDir(override?: string): Promise<string | null> {
  const pkg = packageDir();
  const candidates = [override, join(pkg, 'dist', 'web'), join(pkg, '..', 'web', 'dist')];
  for (const dir of candidates) {
    if (dir && (await isFile(join(dir, 'index.html')))) return resolve(dir);
  }
  return null;
}

async function serveStatic(
  webDir: string | null,
  pathname: string,
  res: ServerResponse,
  headOnly: boolean,
): Promise<void> {
  if (!webDir) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(headOnly ? undefined : NOT_BUILT_HTML);
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (decoded.split(/[\\/]/).includes('..')) {
    res.writeHead(403).end();
    return;
  }
  const rel = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  let target = join(webDir, rel);
  if (relative(webDir, target).startsWith('..')) {
    res.writeHead(403).end();
    return;
  }
  if (target.endsWith(sep) || decoded.endsWith('/')) target = join(target, 'index.html');
  let exists = await isFile(target);
  if (!exists && extname(target) === '') {
    // SPA fallback: a client-side route gets index.html.
    target = join(webDir, 'index.html');
    exists = await isFile(target);
  }
  if (!exists) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
  const size = (await stat(target)).size;
  res.writeHead(200, {
    'content-type': type,
    'content-length': size,
    'cache-control': extname(target) === '.html' ? 'no-cache' : 'max-age=3600',
  });
  if (headOnly) {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
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

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { store } = opts;
  const host = opts.host ?? '127.0.0.1';
  const fun = opts.fun ?? true;
  const scan = opts.scan ?? true;
  const watchRepo = opts.watchRepo ?? scan;
  const debounceMs = opts.rescanDebounceMs ?? 2000;
  const watchCap = opts.watchCap ?? DEFAULT_WATCH_CAP;
  const warn = opts.warn ?? ((): void => undefined);
  const siblingsFlag = opts.siblingsFlag ?? [];
  const root = store.root;
  const webDir = await findWebDir(opts.webDir);

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

  if (scan) await doScan(true);

  // K12: the watcher's ignore rule must agree with the scanner's idea of "the repo" — see
  // watch-ignore.ts's own header for the measured cause. `gitIgnoredPaths` is empty (not thrown)
  // on a non-git root, which reduces this to exactly the pre-K12 segment-only rule.
  let repoWatcher: FSWatcher | null = null;
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
    await new Promise<void>((res) => {
      watcher.once('ready', res);
      watcher.once('error', () => res());
    });
    if (repoWatcher) {
      const n = flattenWatchedPaths(watcher, root).length;
      if (n > watchCap) shutOff(`${n} watched paths > cap ${watchCap}`);
    }
  }

  // ---- store → clients ----------------------------------------------------------------
  const onCard = (card: Card) => broadcast({ type: 'card', card });
  const onRemoved = (id: string) => broadcast({ type: 'card:removed', id });
  const onEvent = (event: unknown) => broadcast({ type: 'event', event });
  const onConfig = () =>
    broadcast({ type: 'config', config: { ...store.config, fun }, siblings: mergedSiblings() });
  const onInvalid = (invalid: unknown) => broadcast({ type: 'invalid', invalid });
  const onLeases = () => broadcast({ type: 'leases', leases: leasesPayload() });
  const onState = () => broadcast({ type: 'state', state: statePayload() });
  const onLog = (payload: { date: string; text: string }) =>
    broadcast({ type: 'log', date: payload.date, text: payload.text });
  store.on('card', onCard);
  store.on('card:removed', onRemoved);
  store.on('event', onEvent);
  store.on('config', onConfig);
  store.on('invalid', onInvalid);
  store.on('leases', onLeases);
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
      const outcome = await store.appendRepoLog(input.seat, input.text, input.title);
      if (!outcome.ok) throw new HttpError(outcome.readOnly ? 409 : 400, outcome.error);
      return sendJson(res, 200, { date: outcome.date, text: outcome.text, block: outcome.block });
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

  const server: Server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const work = url.pathname.startsWith('/api/')
      ? handleApi(method, url, req, res)
      : method === 'GET' || method === 'HEAD'
        ? serveStatic(webDir, url.pathname, res, method === 'HEAD')
        : Promise.reject(new HttpError(405, 'method not allowed'));
    work.catch((e: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(opts.port ?? DEFAULT_PORT, host, () => {
      server.off('error', rej);
      res();
    });
  });
  const port = (server.address() as AddressInfo).port;

  let closed = false;
  return {
    host,
    port,
    url: `http://${host}:${port}/`,
    webDir,
    repo: () => repo,
    rescan,
    watchedPaths: () => (repoWatcher ? flattenWatchedPaths(repoWatcher, root) : []),
    scanCount: () => scanCount,
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
      store.off('state', onState);
      store.off('log', onLog);
      if (repoWatcher) await repoWatcher.close();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
      server.closeAllConnections();
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}
