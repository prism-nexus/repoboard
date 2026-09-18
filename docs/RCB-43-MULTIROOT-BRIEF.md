# Brief — RCB-43 multi-repo switcher, in three slices (2026-09-18)

One card, three commits, one agent per slice, serially. The builder verifies, gates, commits,
pushes, reports each sha. Baseline on `main` @ f9a2f46: 714 passed | 2 skipped (716), 44 files;
typecheck 0; lint 127 files clean.

**Standing constraints (plan §11 O7, the card):** pointing at a directory is a read-only act —
nothing is written into a root that has no `.repoboard/` (K10 guard in `writeCard`/`appendEvent`,
tests prove it). **MCP stays single-root per session** — an agent must never write to the wrong
board; `repoboard mcp` is not touched by any slice. **Map on demand per root** (K12): a root that
nobody has looked at is never scanned and never watched. **Do not replace the two running servers
(:4242 this repo, :4243 fpj)** — the dogfood happens on a third port the builder picks.

## Slice 1 — one process, repeated `--root`, lazy per-root store, map on demand

### What exists

`startServer(opts)` (`packages/server/src/http.ts:680`) takes ONE `store` and closes over it for
~470 lines: `mergedSiblings`, `boardPayload`/`leasesPayload`/`statePayload`, `broadcast` to one
`wss`, the repo scan (`repo`, `doScan`, `rescan`, `scheduleRescan`, `repoWatcher` + the K12 cap),
the eight `store.on(...)` → broadcast hooks, `onClientMessage`, `handleApi`, the static server,
the `upgrade` handler, and `close()`. `cmdServe` (`cli.ts:~1185`) parses ONE `--root`, opens ONE
store, calls `startServer` once. `--sibling` flags are per-process (RCB-42).

### Design

**1. `RepoContext`** (new file `packages/server/src/repo-context.ts`): everything in the closure
that is per-root, moved out mechanically — same names, same bodies, same comments (move them, do
not rewrite them). Shape:

```ts
export interface RepoContextOptions {
  store: CardStore;            // already opened
  fun: boolean; scan: boolean; watchRepo: boolean; rescanDebounceMs: number;
  watchCap: number; warn: (m: string) => void; siblingsFlag: Sibling[];
  now?: () => Date;            // whatever the store already uses; do not add a second clock
}
export interface RepoContext {
  readonly key: string;        // registry key, see 2
  readonly root: string;
  readonly store: CardStore;
  readonly wss: WebSocketServer;          // THIS root's clients only
  handleApi(method, url, req, res): Promise<void>;   // the existing function, unchanged routes
  handleUpgrade(req, socket, head): void;
  repo(): ScanResult | null; rescan(): Promise<void>;
  watchedPaths(): string[]; scanCount(): number;     // K12 test surface, unchanged
  ensureScanned(): Promise<void>;                    // map on demand, see 3
  close(): Promise<void>;
}
export async function openRepoContext(key: string, opts: RepoContextOptions): Promise<RepoContext>
```
`startServer` keeps: `findWebDir`, `serveStatic`, the `createServer` callback, the `upgrade`
handler, `listen`, and `RunningServer`. It becomes a router over a registry.

**2. Registry** (inside `startServer`, or a small `RepoRegistry` class in the same new file —
agent's call, say which): `Map<key, RepoContext | Promise<RepoContext>>`. Keys: the root's
folder name (`basename`), lower-cased; on collision append `-2`, `-3` in `--root` order. The
FIRST root is the **primary**. `ServerOptions` grows `roots?: string[]` (absolute paths, in
order) — **`store` stays and stays required-compatible**: when `roots` is absent the existing
single-store behaviour is exactly today's (every existing test calls `startServer({store,…})`
and must pass unchanged). When `roots` is present, `store` is the primary's already-open store
and `roots[0]` must equal `store.root` (throw otherwise — a contract, not a guess).

**Lazy**: only the primary's context is opened at start. Any other root's context is opened on
its first request (`/api/repos/<key>/…`, slice 2). This slice opens nothing but the primary over
HTTP; `GET /api/repos` only LISTS, and `RunningServer.openRepo(key)` is the programmatic way
(tests, slice 2). The open is
memoised as a Promise so two concurrent first requests open one context. `openStore(root, {watch:
true})` per root (the `.repoboard/` watcher is cheap: one small dir); the REPO watcher and the
scan are NOT started at open — see 3.

**3. Map on demand** (K12): `ensureScanned()` starts the initial scan (and, if `watchRepo`, the
repo watcher with the K12 cap) the first time it is called and memoises. For the **primary**,
`startServer` calls it at start when `scan` is true — exactly today's behaviour. For a non-primary
context (slice 2 will call it from `GET /api/repos/<key>/repo` and the WS connection), nothing
is scanned until asked. A test proves it: open a server with two roots, `scanCount()` of the
second is 0 and `watchedPaths()` is `[]` until `ensureScanned()`.

**4. `GET /api/repos`** (new, the only new route this slice): `{ primary: key, repos: [{ key,
root, name, hasBoard, open, scanned }] }` in `--root` order. `name` = `boardDisplayName(config
| null, root)` — for an unopened root, `config` is null (do not open it to answer; the folder
name is the honest answer). `hasBoard` for an unopened root = `existsSync(join(root,
'.repoboard'))` — a stat, not an open. `open`/`scanned` are booleans from the registry.

**5. CLI**: `--root` becomes repeatable (`{ type: 'string', multiple: true }`); zero roots keeps
today's `findRoot(cwd)`; each root goes through the existing `serveRoot` check (must be a
directory). `serve` prints one line per root at start: `  <key>  <root>  (board|map-only)`,
primary first, marked. `--sibling` stays per-process. Help text updated in `cli.ts`'s usage
block. `repoboard mcp` untouched.

**6. Behaviour that must NOT change** (the existing 714 tests are the proof): every route, every
WS message, `close()` ordering, the K12 cap and `watchedPaths()`, the K8 event path, the K10
guard. `RunningServer` keeps its fields; add `repos(): RepoContext[]` and `context(key):
RepoContext | undefined` for tests, and `openRepo(key): Promise<RepoContext>` (used by slice 2).

### Owns (slice 1)
`packages/server/src/repo-context.ts` (new), `packages/server/src/http.ts`,
`packages/server/src/cli.ts` (`cmdServe`, `serveRoot`, usage text), `packages/server/src/index.ts`
(exports only, if it re-exports http), `packages/server/test/http.test.ts`,
`packages/server/test/multiroot.test.ts` (new), `packages/server/test/cli.test.ts` (serve
argument parsing only), `docs/AGENTS.md` §2 table row for `serve` if it lists flags (say if not),
`README.md` the `serve` line(s) under Try it / Config (one sentence: `--root` repeats; the first
is primary; others open lazily).

### Tests (slice 1)
`multiroot.test.ts`, each on temp repos from `helpers.ts`:
1. `startServer({store, roots:[a,b]})`: `GET /api/repos` lists both, `primary` = a's key, b
   `open:false, scanned:false, hasBoard` correct without opening (assert `repos().length === 1`).
2. Key collision: two roots both named `proj` → `proj`, `proj-2` in order.
3. `roots[0] !== store.root` → throws at `startServer` (message names both paths).
4. Map on demand: `openRepo(bKey)` then `scanCount()===0`, `watchedPaths()` `[]`; after
   `ensureScanned()` scanCount 1. Concurrent `openRepo(bKey)` ×2 resolves to the SAME object.
5. Read-only: `b` has no `.repoboard/`; after open + ensureScanned, `b/.repoboard` still absent
   and `git status` (if you init a git repo there) clean.
6. Single-root regression: `startServer({store})` with no `roots` → `GET /api/repos` lists one,
   primary; everything else is the existing http.test.ts, unchanged.
`cli.test.ts`: `serve --root a --root b` parses to two roots in order; `--root` once and zero
times unchanged.
Control: remove the memoisation in `openRepo` (open twice) → test 4's identity assertion fails;
paste it; restore by edit.

### Rules — every slice
Same as every brief: no commit; no `pnpm test` (builder holds the lock; run only
`pnpm --filter repoboard exec vitest run test/http.test.ts test/multiroot.test.ts test/cli.test.ts
test/repo-watch.test.ts`); typecheck 0 after every save, no `any`; biome clean from the repo
root; stay in Owns; never write outside this repo; never touch :4242/:4243/:5173/:8787; controls
verified the CLAUDE.md way; report numbers, `git diff --stat`, the control's failing assertion,
and what you found and did not fix. **This is a move, not a rewrite**: `git diff --stat` on
http.ts should be dominated by deletions that reappear in repo-context.ts; if you find yourself
improving a moved function, stop and report it instead.

## Slice 2 — repo-scoped API and WS (briefed after slice 1 lands)
`/api/repos/<key>/…` mirrors every `/api/…` route on that root's context (one prefix strip, one
registry lookup, then the same `handleApi`); `/ws?repo=<key>` (or `/repos/<key>/ws`) attaches to
that context's `wss`; unprefixed paths keep meaning the primary (backward compatible, the
existing web keeps working). `GET /api/repos/<key>/repo` and the WS connection call
`ensureScanned()` — that is where "map on demand" is triggered. Unknown key → 404 with the known
keys in the message. Per-root `mergedSiblings` unchanged.

## Slice 3 — UI switcher (briefed after slice 2 lands)
The top bar gets a repo selector fed by `GET /api/repos`; the web store takes a `repoKey` and
prefixes fetches/WS; the URL carries it (`?repo=<key>` or `#/<key>`), so a link to a specific
board survives reload; the sibling links (RCB-42) stay for boards served by OTHER processes.
Dogfood: the builder starts one process on a third port with `--root <this repo> --root
<fpj>` and looks at both boards in the browser; :4242/:4243 keep running until the coordinator
says otherwise.

---

## Slice 2 — detailed brief (written after slice 1 landed 820b52f)

Baseline on `main` @ 820b52f: 723 passed | 2 skipped (725), 45 files; typecheck 0; lint 129 clean.

### What exists after slice 1
`startServer` (`http.ts`) routes: `/api/repos` → `reposPayload(registry)`; every other `/api/*`
→ `primary.handleApi(method, url, req, res)`; `upgrade` → `primary.handleUpgrade(...)`, which
accepts only `pathname === '/ws'`. `handleApi` computes `const path = url.pathname` once
(`repo-context.ts:819`) and matches against `/api/...` literals below it. `RepoRegistry.openRepo(key)`
opens lazily; `RepoContext.ensureScanned()` is the map-on-demand trigger; nothing calls it for a
non-primary root yet.

### Design
**1. Prefix strip, once, in the router — not in `handleApi`.** In `startServer`'s `createServer`
callback: if `url.pathname` matches `^/api/repos/([^/]+)(/.*)?$`:
- key = decodeURIComponent(m[1]); rest = m[2] ?? '' — `rest` must start with `/` or be empty.
- `rest === ''` or `rest === '/'` → **`GET /api/repos/<key>`**: one repo's entry from
  `reposPayload` (same shape as a list item), 404 for an unknown key. Does NOT open the repo.
- otherwise: `registry.openRepo(key)` (404 on unknown key — message lists the known keys), then
  call `ctx.handleApi(method, scopedUrl, req, res)` where `scopedUrl` is a NEW `URL` whose
  pathname is `'/api' + rest` and whose search is the original's. `handleApi` itself is **not
  edited** — it keeps matching `/api/...` literals; the router presents it a URL it already
  understands. (This is the "one prefix strip, one registry lookup, then the same handleApi" the
  slice-2 outline promised.)
- `rest === '/repo'` (and `GET /api/repos/<key>/repo` only): `await ctx.ensureScanned()` BEFORE
  delegating, so the first map request scans (K12 map on demand). The primary's `/api/repo` is
  unchanged (already scanned at start when `scan` is true).
- Everything unprefixed keeps meaning the primary. `GET /api/repos` (list, exact match) is tried
  before the prefixed form. A root whose folder is literally `repos` would still be addressable
  as `/api/repos/repos/...`, but to keep keys unambiguous `assignRepoKeys` treats `repos` as
  reserved: such a root gets `repos-2` as if it had collided. One line, one test.

**2. Per-root WS.** `upgrade`: `pathname === '/ws'` → primary (unchanged). `pathname` matching
`^/api/repos/([^/]+)/ws$` → `registry.openRepo(key)` then `ctx.handleUpgrade` — but `handleUpgrade`
checks `pathname !== '/ws'`; give `RepoContext.handleUpgrade` an already-parsed decision instead:
change its signature to `handleUpgrade(req, socket, head)` → `acceptUpgrade(req, socket, head)` that
does NOT re-check the path (the router already did), and keep the old `/ws`-checking behaviour in
the router for the primary. On WS connection for a non-primary root, `ensureScanned()` is kicked
(not awaited — the snapshot goes out as today, the `repo` message follows when the scan lands,
exactly like the primary's initial-scan → broadcast path). Unknown key or a promise rejection →
`socket.destroy()`.

**3. `reposPayload` gains nothing new**; `open`/`scanned` already flip as slice 2 exercises them.

**4. Static files** unchanged: a request for `/api/repos/<key>/…` that is not an API route (e.g.
`/api/repos/x/index.html`) is a 404 from `handleApi`, not a static hit — say so in a test.

### Owns (slice 2)
`packages/server/src/http.ts`, `packages/server/src/repo-context.ts` (only `handleUpgrade` →
`acceptUpgrade`, the doc comment on `handleApi` saying it may be reached via a scoped URL, and
the reserved-key line in `assignRepoKeys`), `packages/server/test/multiroot.test.ts`,
`packages/server/test/http.test.ts` (only if a helper is needed), `docs/AGENTS.md` (§3 or wherever
HTTP routes are listed per topic: one paragraph "repo-scoped routes"), `README.md` (one sentence
next to the slice-1 sentence).

### Tests (slice 2), `multiroot.test.ts`
1. Two roots a (board) + b (board): the scoped path is `/api/repos/<b>/board` (rest `/board` →
   `/api/board` inside handleApi). Assert it returns b's cards, not a's; `GET /api/board` still
   returns a's.
2. Scoped write: `POST /api/repos/<b>/cards` creates a card in b's `.repoboard/cards/` and NOT
   in a's; b's `events.jsonl` gets the line, a's does not.
3. Unknown key → 404 whose message contains every known key. `GET /api/repos/<b>` (no rest) →
   the one entry, and `repos()` shows b still unopened afterwards.
4. Map on demand over HTTP: after `GET /api/repos/<b>/board`, b `scanCount()===0`; after
   `GET /api/repos/<b>/repo`, `scanCount()===1` and the response has `files`.
5. Per-root WS: connect to `/api/repos/<b>/ws`, receive a snapshot whose `board.cards` are b's;
   a `card:move` sent on that socket moves b's card (file on disk) and a's file is untouched;
   a client on `/ws` receives NO message for it, a client on b's WS receives `card`.
6. Reserved key: a root whose folder is `repos` gets key `repos-2`; `GET /api/repos` still lists.
7. Boardless b: `POST /api/repos/<b>/cards` → 409, `b/.repoboard` still absent (O7 held through
   the scoped path).
Control: drop the `ensureScanned()` await on `/repo` → test 4 fails (paste); restore. Second
control: route the scoped request to `primary.handleApi` instead of `ctx.handleApi` → test 1
fails with a's cards; restore.

### Rules
As every slice (no commit; no `pnpm test`; targeted `vitest run test/multiroot.test.ts
test/http.test.ts test/repo-watch.test.ts`; typecheck 0 per save; no `any`; biome from root;
stay in Owns; ports 0 only; never touch :4242/:4243/:5173/:8787; controls the CLAUDE.md way;
`packages/web` untouched — slice 3 is the web).
