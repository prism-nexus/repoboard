/**
 * P2.3 HTTP + WebSocket per BUILD-PLAN §3. Node `http` + `ws`, no framework.
 * Binds 127.0.0.1 only (§0.2). Every mutation goes through the store (and so through core);
 * the watcher echoes the result back to every client.
 *
 * RCB-43 slice 1: everything that used to be per-root here (the scan, the repo watcher, the
 * store→client broadcast hooks, `handleApi`, one root's `wss`, `close()`) moved to
 * `repo-context.ts` — see that file's header. This file keeps what is genuinely shared across
 * roots in one process: `findWebDir`/`serveStatic`, the one `http.Server`, its `upgrade` event,
 * and `listen`. `startServer` is now a thin router over a `RepoRegistry`.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardDisplayName, type Sibling } from '@repoboard/core';
import {
  HttpError,
  hasBoardDir,
  openRepoContext,
  type RepoContext,
  RepoRegistry,
  sendJson,
} from './repo-context.js';
import type { ScanResult } from './scanner.js';
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
  /**
   * RCB-43 slice 1: repeated `--root`, absolute paths, in `--root` order. `roots[0]` MUST equal
   * `store.root` (`store` is always the primary's already-open store) — a thrown contract, not a
   * guess. Absent (or empty), the single-root shape from before this slice: one root, `store.root`,
   * the primary. Every root after the first opens lazily, on its first `openRepo(key)` (slice 2).
   */
  roots?: string[];
  /**
   * Clock passed to `openStore` for every root THIS process opens lazily after the primary
   * (`RepoRegistry.openRepo`) — the same one the primary's `store` was already opened with, so a
   * multi-root test or process has exactly one notion of "now". Default `() => new Date()`
   * (`openStore`'s own default).
   */
  now?: () => Date;
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
  /** RCB-43 slice 1: currently OPEN (resolved) repo contexts, in `--root` order — not every
   * registered root, just the ones something has already opened. Test surface. */
  repos(): RepoContext[];
  /** RCB-43 slice 1: a resolved context for `key`, or `undefined` if it is unopened. Test surface. */
  context(key: string): RepoContext | undefined;
  /** RCB-43 slice 1: open (or return the in-flight open of) the context for `key`, memoised.
   * Used by slice 2's per-root routes; exposed here for tests. */
  openRepo(key: string): Promise<RepoContext>;
  close(): Promise<void>;
}

const DEFAULT_PORT = 4242;

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

interface RepoEntry {
  key: string;
  root: string;
  name: string;
  hasBoard: boolean;
  open: boolean;
  scanned: boolean;
}

/** One entry of `GET /api/repos`, shared with the single-repo lookup (`GET /api/repos/<key>`,
 * slice 2) so the two never drift: unopened, `config`/`name` come from `null` (the folder name
 * is the honest answer, per `boardDisplayName`) and `hasBoard` from a stat (`hasBoardDir`),
 * never an open. */
function repoEntry(registry: RepoRegistry, key: string, root: string): RepoEntry {
  const ctx = registry.context(key);
  const config = ctx ? ctx.store.config : null;
  return {
    key,
    root,
    name: boardDisplayName(config, root),
    hasBoard: ctx ? ctx.store.hasBoard : hasBoardDir(root),
    open: ctx !== undefined,
    scanned: ctx ? ctx.scanCount() > 0 : false,
  };
}

/**
 * RCB-43 slice 1: `GET /api/repos` — lists every `--root`, in order, without opening any of them.
 */
function reposPayload(registry: RepoRegistry): { primary: string; repos: RepoEntry[] } {
  return {
    primary: registry.primaryKey,
    repos: registry.roots.map(({ key, root }) => repoEntry(registry, key, root)),
  };
}

/** RCB-43 slice 2: `GET /api/repos/<key>(/…)?` — one path segment for the key, the rest (`''` for
 * an exact or trailing-slash match) forwarded to that root's own `handleApi` after a rewrite to
 * `/api<rest>`. `handleApi` is never edited to know about this prefix. */
const REPOS_SCOPED = /^\/api\/repos\/([^/]+)(\/.*)?$/;

/** RCB-43 slice 2: the per-root WS, `/api/repos/<key>/ws` — matched only in the `upgrade`
 * handler, never by `REPOS_SCOPED` (a WS request never reaches `createServer`'s callback). */
const REPOS_WS = /^\/api\/repos\/([^/]+)\/ws$/;

function unknownKeyError(registry: RepoRegistry, key: string): HttpError {
  const known = registry.roots.map((r) => r.key).join(', ');
  return new HttpError(404, `unknown repo key "${key}" (known: ${known})`);
}

/**
 * RCB-43 slice 2: the one prefix strip, one registry lookup, then the same `handleApi` — see
 * this file's header and `docs/RCB-43-MULTIROOT-BRIEF.md` §Slice 2. `rest === ''` or `'/'` on a
 * `GET` answers from `reposPayload`'s per-entry shape WITHOUT opening the root (mirrors
 * `GET /api/repos` itself); anything else opens the root (404 on an unknown key, naming every
 * known key) and delegates. `GET .../repo` awaits `ensureScanned()` first — map on demand.
 */
async function handleScopedApi(
  registry: RepoRegistry,
  method: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
  rest: string,
): Promise<void> {
  if (method === 'GET' && (rest === '' || rest === '/')) {
    const entry = registry.roots.find((r) => r.key === key);
    if (!entry) throw unknownKeyError(registry, key);
    return sendJson(res, 200, repoEntry(registry, entry.key, entry.root));
  }
  if (!registry.roots.some((r) => r.key === key)) throw unknownKeyError(registry, key);
  const ctx = await registry.openRepo(key);
  if (method === 'GET' && rest === '/repo') await ctx.ensureScanned();
  const scopedUrl = new URL(`/api${rest}`, 'http://localhost');
  scopedUrl.search = url.search;
  return ctx.handleApi(method, scopedUrl, req, res);
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
  const webDir = await findWebDir(opts.webDir);

  // RCB-43 slice 1: absent (or empty) `roots` is exactly today's single-root shape — one root,
  // `store.root`, the primary. `roots[0]` must equal `store.root` (a contract, not a guess): the
  // caller always opens the primary's store itself and hands it in as `store`.
  const roots = opts.roots && opts.roots.length > 0 ? opts.roots : [store.root];
  if (roots[0] !== store.root) {
    throw new Error(`ServerOptions.roots[0] (${roots[0]}) must equal store.root (${store.root})`);
  }

  const registry = new RepoRegistry(roots, {
    fun,
    scan,
    watchRepo,
    rescanDebounceMs: debounceMs,
    watchCap,
    warn,
    siblingsFlag,
    now: opts.now,
  });
  const primary = await openRepoContext(registry.primaryKey, {
    store,
    fun,
    scan,
    watchRepo,
    rescanDebounceMs: debounceMs,
    watchCap,
    warn,
    siblingsFlag,
    now: opts.now,
  });
  registry.setOpened(registry.primaryKey, primary);
  // K12 "map on demand": only the primary is scanned/watched at start, and only when `scan` is
  // true — exactly today's behaviour. Every other root stays unscanned until slice 2 asks.
  if (scan) await primary.ensureScanned();

  const server: Server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const scopedMatch = REPOS_SCOPED.exec(url.pathname);
    const work =
      method === 'GET' && url.pathname === '/api/repos'
        ? Promise.resolve(sendJson(res, 200, reposPayload(registry)))
        : scopedMatch
          ? handleScopedApi(
              registry,
              method,
              url,
              req,
              res,
              decodeURIComponent(scopedMatch[1] ?? ''),
              scopedMatch[2] ?? '',
            )
          : url.pathname.startsWith('/api/')
            ? primary.handleApi(method, url, req, res)
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
    // Unprefixed `/ws` always means the primary — unchanged from slice 1. `RepoContext.
    // acceptUpgrade` no longer checks the path itself (slice 2): this router is the one place
    // that decides which context a WS upgrade belongs to.
    if (url.pathname === '/ws') {
      primary.acceptUpgrade(req, socket, head);
      return;
    }
    const wsMatch = REPOS_WS.exec(url.pathname);
    const key = wsMatch ? decodeURIComponent(wsMatch[1] ?? '') : null;
    if (!key || !registry.roots.some((r) => r.key === key)) {
      socket.destroy();
      return;
    }
    registry.openRepo(key).then(
      (ctx) => {
        ctx.acceptUpgrade(req, socket, head);
        // K12 map on demand: kicked, not awaited — the snapshot goes out immediately (repo:
        // null until the scan lands, exactly the primary's own initial-scan → broadcast path).
        void ctx.ensureScanned();
      },
      () => socket.destroy(),
    );
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
    repo: () => primary.repo(),
    rescan: () => primary.rescan(),
    watchedPaths: () => primary.watchedPaths(),
    scanCount: () => primary.scanCount(),
    repos: () => registry.openedContexts(),
    context: (key) => registry.context(key),
    openRepo: (key) => registry.openRepo(key),
    async close() {
      if (closed) return;
      closed = true;
      await registry.closeAll();
      server.closeAllConnections();
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}
