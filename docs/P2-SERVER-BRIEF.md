# Brief: P2 Server (`packages/server`)

You are implementing P2.1–P2.4 of `docs/BUILD-PLAN.md` in `packages/server`. Do NOT commit. Do NOT
edit `packages/core` or `packages/web` — if core lacks something you need, write it down in your
report and work around it in server; the orchestrator will route the fix. Read `CLAUDE.md`, the
plan (§0–§6), and `packages/core/src/index.ts` before writing code.

**Every card mutation goes through `@rcb/core`** (`moveCard`, `createCard`, `updateCard`,
`serializeCard`). The server never builds frontmatter by hand.

## P2.2 Card store — do this first, everything else sits on it
`src/store.ts`: `openStore(root: string)` → `{ config, list(), get(id), create(input, actor),
move(id, status, actor), update(id, patch, actor), close(), on(event, fn) }`.
- Reads `.rcb/board.yml` (fallback `defaultBoardConfig()` if absent) and `.rcb/cards/*.md`.
- A parse failure in one card must not break the store: keep it in `invalid: {path, error}[]`
  and emit an event so the UI can show a red card.
- Writes are atomic: write `<file>.tmp` then `rename`. Set `updated` via core.
- chokidar watcher on `.rcb/` with `awaitWriteFinish: {stabilityThreshold: 100}`; on any change
  re-read that file from disk and emit `card` / `card:removed`. The in-memory map is a cache of
  disk, never the other way around. A change to `board.yml` reloads config and emits `config`.
- Appends to `.rcb/events.jsonl` on every CLI/HTTP/MCP mutation. When the watcher sees a card
  change that the store did not itself write (compare a per-file "last written content" hash),
  synthesize an event `{actor: 'file', type: 'move' | 'update', ...}` from the diff in `status`.
- Tests: use `fs.mkdtemp` under `os.tmpdir()` — never the repo's own `.rcb`. Cover: load, create
  allocates next id, move writes file and appends event, external `sed`-style edit is picked up
  (write the file with `fs.writeFile` in the test and await the emitted event with a timeout),
  invalid card is reported not thrown.

## P2.4 Repo scanner
`src/scanner.ts`: `scanRepo(root) → RepoSnapshot` per plan §4.
- File list: `git ls-files -z` if `.git` exists (spawn once), else walk skipping `node_modules`,
  `.git`, `dist`. Cap 20,000 files, set a `truncated: true` flag if you hit it (add that field
  to the returned object; it is additive to the §4 type).
- `bytes` from stat; `lines` by counting `\n` in a streamed read, but skip line-counting for
  files > 2 MB and for binary extensions (png, jpg, gif, woff, pdf, zip, lock files — a short
  list is fine). `lang` from extension map (~30 common ones, `other` fallback).
- Git activity: ONE `git log --since=90.days --name-only --format=%H%x00%cI` spawn; parse into
  per-file `commits30d`, `commits90d`, `lastCommitAt`. Not one spawn per file.
- `edges`: leave as `[]` in P2 (P4.4 fills it). `head` from `git rev-parse`.
- Must finish in < 3 s on this repo; measure and report the number.
- Test against a temp dir you `git init` and commit into.

## P2.3 HTTP + WS
`src/http.ts`: Node `http` + `ws` package (no express). Routes exactly per plan §3. Bind
`127.0.0.1`. WS on `/ws`: send `snapshot` on connect; forward store events; `repo` message on
scanner refresh, debounced 2 s; handle `card:move` / `card:update` by calling the store. Serve
static files from `../web/dist` if it exists at `packages/server/dist/web` OR
`packages/web/dist` (dev), else a plain HTML page saying "web not built". Content-type by ext.
Test: start on port 0, GET /api/board returns the temp-dir cards; PATCH moves one; WS receives
a `card` message after a direct file write.

## P2.1 CLI
`src/cli.ts` with `bin: { rcb: ./dist/cli.js }` in package.json. Use `node:util.parseArgs`,
no commander. Commands:
- `rcb init` — creates `.rcb/board.yml` (default) and `RCB-1` "Welcome" card; refuses if
  `.rcb` exists.
- `rcb card add "<title>" [--status s] [--assignee a] [--priority p] [--label l]...`
- `rcb card move <id> <status> [--as <actor>]` (actor default `$RCB_ACTOR` or `$USER` or `cli`)
- `rcb card list [--status s]` — table: id, status, assignee, title. `--json` for agents.
- `rcb card show <id>` — prints the file.
- `rcb serve [--port 4242] [--open] [--no-fun]` — starts http, prints the URL, `--open` runs
  `open`/`xdg-open`. `--no-fun` is passed to the web via `GET /api/board` → `config.fun=false`.
- `rcb --help`. Exit codes: 0 ok, 1 user error with a one-line message, 2 crash.
Test the CLI by importing its `run(argv, {cwd, stdout})` function, not by spawning.

## Build
`tsup` or plain `tsc` to `dist/`; `pnpm build` at root must produce a runnable `dist/cli.js`
with a shebang. Add `"files"` to package.json. Root `pnpm dev` should run `rcb serve` against
this repo's own `.rcb`.

## Definition of done
`pnpm test`, `pnpm typecheck`, `pnpm lint` exit 0 at root. Then, from the repo root, run
`pnpm build && node packages/server/dist/cli.js card list` and paste the table. Then start
`serve` on a spare port, `curl /api/board | head -c 300`, and stop it. Paste all outputs.
Report: file list, command outputs, scanner timing, and anything core was missing.
