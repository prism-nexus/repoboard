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
import type { Card, CardPatch, CreateCardInput, Priority } from '@repoboard/core';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { type WebSocket, WebSocketServer } from 'ws';
import { resolveCardRefs } from './refs.js';
import { type ScanResult, scanRepo } from './scanner.js';
import type { CardStore } from './store.js';

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
}

export interface RunningServer {
  host: string;
  port: number;
  url: string;
  /** Directory the UI is served from, or null when "web not built". */
  webDir: string | null;
  repo(): ScanResult | null;
  rescan(): Promise<void>;
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
 * Apply a PATCH-shaped body: a `status` change goes through `move`, everything else through
 * `update`. Used by `PATCH /api/cards/:id` and both WS client messages.
 */
async function applyPatch(
  store: CardStore,
  id: string,
  body: Json,
  defaultActor: string,
): Promise<{ card: Card; warnings: string[] }> {
  rejectUnknown(body, PATCH_FIELDS);
  const current = store.get(id);
  if (!current) throw new HttpError(404, `unknown card "${id}"`);
  const actor = optString(body, 'actor') ?? defaultActor;
  const status = optString(body, 'status');
  const patch = toPatch(body);
  const warnings: string[] = [];
  if (status !== undefined && status !== current.status) {
    const res = await store.move(id, status, actor);
    if (!res.ok) throw new HttpError(res.notFound ? 404 : 400, res.error);
    warnings.push(...res.warnings);
  }
  if (Object.keys(patch).length > 0) {
    const res = await store.update(id, patch, actor);
    if (!res.ok) throw new HttpError(res.notFound ? 404 : 400, res.error);
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

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { store } = opts;
  const host = opts.host ?? '127.0.0.1';
  const fun = opts.fun ?? true;
  const scan = opts.scan ?? true;
  const watchRepo = opts.watchRepo ?? scan;
  const debounceMs = opts.rescanDebounceMs ?? 2000;
  const root = store.root;
  const webDir = await findWebDir(opts.webDir);

  let repo: ScanResult | null = null;
  let repoFingerprint = '';
  const wss = new WebSocketServer({ noServer: true });

  // §3: one payload for `GET /api/board` and the `board` half of the WS snapshot, so `hasBoard`
  // cannot be true on one and absent on the other.
  const boardPayload = () => ({
    config: { ...store.config, fun },
    cards: store.list(),
    invalid: store.invalid,
    hasBoard: store.hasBoard,
  });

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

  let repoWatcher: FSWatcher | null = null;
  if (scan && watchRepo) {
    const gitAllowed = new Set(['.git', '.git/HEAD', '.git/logs', '.git/logs/HEAD']);
    repoWatcher = chokidarWatch(root, {
      ignoreInitial: true,
      ignored: (p) => {
        const rel = relative(root, p).split(sep).join('/');
        if (rel === '' || rel.startsWith('..')) return false;
        const parts = rel.split('/');
        if (parts[0] === '.git') return !gitAllowed.has(rel);
        if (parts[0] === '.repoboard') return true; // the store watches that
        return parts.some((seg) => seg === 'node_modules' || seg === 'dist');
      },
    });
    repoWatcher.on('all', () => scheduleRescan());
    repoWatcher.on('error', () => undefined);
  }

  // ---- store → clients ----------------------------------------------------------------
  const onCard = (card: Card) => broadcast({ type: 'card', card });
  const onRemoved = (id: string) => broadcast({ type: 'card:removed', id });
  const onEvent = (event: unknown) => broadcast({ type: 'event', event });
  const onConfig = () => broadcast({ type: 'config', config: { ...store.config, fun } });
  const onInvalid = (invalid: unknown) => broadcast({ type: 'invalid', invalid });
  store.on('card', onCard);
  store.on('card:removed', onRemoved);
  store.on('event', onEvent);
  store.on('config', onConfig);
  store.on('invalid', onInvalid);

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
    ws.send(JSON.stringify({ type: 'snapshot', board: boardPayload(), repo }));
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
      if (!created.ok) throw new HttpError(400, created.error);
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
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      store.off('card', onCard);
      store.off('card:removed', onRemoved);
      store.off('event', onEvent);
      store.off('config', onConfig);
      store.off('invalid', onInvalid);
      if (repoWatcher) await repoWatcher.close();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
      server.closeAllConnections();
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}
