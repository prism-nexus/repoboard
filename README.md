# repoboard

A Kanban board that lives in your repo as markdown files, and a local dashboard that shows the
board next to a map of the code — so you can see what your agents are doing, and where.

![board](docs/board.png)

![map](docs/map.png)

## Try it

<!-- npm:omit -->Once `repoboard` is on npm (it is not yet — see Status):<!-- /npm:omit -->

```sh
npx repoboard init && npx repoboard serve --open
```

`init` writes `.repoboard/board.yml` and a first card `RB-1`; `serve` opens the dashboard on
`http://127.0.0.1:4242`. From a checkout today: `pnpm install && pnpm build`, then
`node packages/server/dist/cli.js serve --open`.

The repo is at https://github.com/prism-nexus/repoboard; contributions go through
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## The idea

Plain files are the database: a card is one markdown file with YAML frontmatter in
`.repoboard/cards/<id>.md`, and the columns are `.repoboard/board.yml`. Git is the history —
there is no other store, no sync, and nothing leaves the machine (the server binds `127.0.0.1`).
Any agent that can edit a file can move a card: change `status:` and a filesystem watcher pushes
the new card to every open browser — 282 ms from `sed` to board, measured 2026-09-03. The server
re-reads the file on every change and never trusts its own memory. No LLM sits in the product's
path; the agents bring the intelligence, and the board only shows it.

## For agents

Three surfaces write the same files through the same core code. Use them in this order — the
ranking is by tokens; per-operation costs measured 2026-09-03 on the built binary, standing costs
and list sizes re-measured 2026-09-07 on 31 cards, standing costs re-measured 2026-09-22 (RCB-100)
(bytes on the wire, ≈4 bytes per token; plan §11 O3):

| Surface | Standing cost | Per move | Per list |
|---|---|---|---|
| **CLI** — `repoboard card move RB-12 doing --as claude/dev` | [`docs/AGENTS.md`](docs/AGENTS.md) read once: 20.9 KB | ~40 B in, 33 B out | table 2,529 B; `--json` 7,639 B; `--json --full` 20,758 B |
| **MCP** — `claude mcp add repoboard -- npx repoboard mcp` | tool schema 22.2 KB (25 tools, 2026-09-24, RCB-137) per turn where the harness loads it | ~80 B call, ~200 B result | 7,638 B — the same formatter, to the byte |
| **File edit** — `sed -i 's/^status: todo$/status: doing/' .repoboard/cards/RB-12.md` | same AGENTS.md | ~60 B, but a correct move also bumps `updated` and appends a `## Log` line | n/a |

The systems model adds a 66 B `seat` line and `.repoboard/systems.yml` (2,693 B here) to the cold
read; `repoboard systems` is 631 B; `systems show <id>` resolves pointers and can run to tens of
KB — [`docs/REFERENCE.md`](docs/REFERENCE.md) §7.

A card can also carry a `decision:` block (P8.1) — `repoboard card ask RB-12 "Ship it?" --option
"A ship now" --option "B wait"` and `repoboard card decide RB-12 A` (or `--words "<verbatim>"`),
mirrored as MCP `ask_owner`/`record_decision` and HTTP `POST /api/cards/:id/ask|decide`. A DECIDED
card is authority: `decision.chosen`/`decision.words` are the answer, not a chat relay. See
[`docs/REFERENCE.md`](docs/REFERENCE.md) §1 for the bytes and the wire shapes.

A sibling file, `.repoboard/leases.yml` (P8.2), tracks who holds a named resource and the time
windows during which one is claimed — `repoboard lease take vitest-lock --until +90m`,
`repoboard window check vitest-lock` (exit 0 clear / 1 blocked, so a lock shim can call it before
starting a test run), mirrored as MCP `take_lease`/`release_lease`/`list_leases`/`add_window`/
`check_window` and HTTP `GET /api/leases`, `POST /api/leases/take|release|windows`. A lease past
`until` reads STALE, never silently held. See [`docs/REFERENCE.md`](docs/REFERENCE.md) §2.

Two more plain files round out the practices program (P8.3): `.repoboard/STATE.md` — one page,
rewritten in place, never appended, with an OWNER QUEUE generated fresh from cards that need a
decision every time it's read (never stored) — and `.repoboard/log/YYYY-MM-DD.md`, one file per
day that every seat appends its own `##### <SEAT> <ts>: <title>` block to. `repoboard state
--set-section LIVE "Tree is dev."`, `repoboard log --as claude/ops "armed the fires"`, and
`repoboard check` (exit 0 `ok`, or 1 naming what's wrong: a stale STATE stamp, a stale lease, a
card working with no lease held) round-trip through MCP `get_state`/`set_state_section`/
`append_repo_log`/`check` and HTTP `GET /api/state`, `PUT /api/state/section`, `GET/POST
/api/log`, `GET /api/check` the same way. `repoboard init --practices` scaffolds all of it (plus a
root `NEXT-AGENT-PROMPT.md`), never overwriting a file that already exists. See [`docs/AGENTS.md`](docs/AGENTS.md)
§10.

`repoboard cost [--root <dir>] [--budget <bytes>]` (P8.4) answers what a COLD agent loads before
it does anything: bytes (and ≈tokens at 4 B/token) of `CLAUDE.md` and its variants, `AGENTS.md`
and its variants, every repo-relative path `CLAUDE.md` names in backticks that exists, and the
NAMES of any `.mcp.json` MCP servers. Exit 1 when `CLAUDE.md` exceeds its budget (default 8192 B,
or `board.yml`'s `claudeMdBudgetBytes:`) — the same check `repoboard check`'s `cost-over-budget`
finding makes error-grade. `--root` measures ANY directory, board or no board — the motivating
measurement was freshpickedjobs' own `CLAUDE.md`, which reached 32,620 B before anyone measured
it. MCP `cost`, HTTP `GET /api/cost`, and a tile on the Map view. See [`docs/REFERENCE.md`](docs/REFERENCE.md) §4.

`.repoboard/systems.yml` (RCB-95–99) is the one architecture model: systems with kind/layer/env
and pointers into the repo, connections between them, both dev and prod environments, provenance
on every row. `repoboard systems [--json]` lists it, `repoboard systems show <id> [--json]`
resolves a row's pointers, `repoboard systems detect [--apply]` proposes rows from the files
already on disk (dry-run by default, a hand row always wins, provenance stamped on every merge).
`repoboard seat <name>` prints one Systems line, `repoboard check` gains `systems-invalid` and
`systems-stale`, and the Flow view draws it. This repo's own file is 5 systems, 3 connections,
prod none. See [`docs/REFERENCE.md`](docs/REFERENCE.md) §7, §8.

`repoboard archive [--older-than 14d] [--dry-run]` (P8.5) moves `done` cards older than the
cutoff to `.repoboard/archive/` — `git mv` when tracked, else a rename, always byte-identical; the
board's own `done` column header has an "archive older than 14d" button that does the same thing.
`repoboard sync-issues <path>#<heading> [--dry-run] [--root <dir>]` turns a README's `## Known
issues` list into cards without copying a word of it: a card for every open `- **K<n>` entry, a
move to done for every one that's struck or gone, idempotent by `refs: [<path>@K<n>]`, and it
**never writes the source file** — measured read-only against freshpickedjobs's own 3,300+ line
README three times as the file moved under this task (64 create / 0 close / 0 malformed each
time; `git status --short` unchanged before and after every run). MCP `archive_cards`/
`sync_issues`, HTTP `POST /api/archive`/`POST /api/sync-issues`. See [`docs/REFERENCE.md`](docs/REFERENCE.md) §5.

`repoboard local init [--remote <url>]` (RCB-83) makes `.repoboard/local/` — a second, gitignored
git repo nested inside this one, for the machine facts a public repo must not ship: `RIG.md`
(build, ports, locks, seat names, other repos on this machine). `--remote` points it at a private
backup that needs no extra step; `repoboard local sync`/`local status` commit-and-push and report
drift, and `seat`/`log` sync it automatically after every write. `repoboard check`'s
`local-unsynced`/`local-no-remote` findings watch it the same way `stale-lease` watches leases. The
running record follows the layer: `local init` moves an existing `STATE.md` and `log/` into it,
and from then on `seat`/`log` read and write them there (old log entries left at the top level
are still read).

The CLI is the cheapest per operation and has no standing cost. MCP pays off when the agent has
no shell or its harness loads tool schemas on demand. Editing the file is the escape hatch: it
always works, and the watcher synthesizes the event (`actor: file`). [`docs/AGENTS.md`](docs/AGENTS.md) is the one
page an agent needs, including a paragraph to paste into a `CLAUDE.md`.

## What it shows

- **Board** — one column per `board.yml` entry with its card count and WIP limit; each card
  shows its assignee as an avatar (emoji and color hashed from the `assignee` string), labels,
  and how many files and refs it names. Drag and drop writes the card file. A card's `refs:`
  (`docs/BUILD-PLAN.md@P6.2`, `README.md#Known issues`, `src/x.ts:L10-L20`) render in the
  drawer as the referenced lines, read from the file on every open — point, don't paste.
- **Map** — a treemap of the repo (files by size, colored by language; this repo: 141 files,
  layout under 1.2 ms on every recorded run), heat modes for churn over 30 and 90 days and for
  recent edits, an import graph for JS/TS (131 edges here), and *who is where*: files named on
  cards in an active column, updated within `activeWindowMinutes`, glow in the assignee's color.
- **Flow** — the systems diagram from `.repoboard/systems.yml` (rows by layer, a dev/prod/both
  switch, one-env systems dashed), with a drawer for each box's fields, live pointers, and
  backlinks (see [`docs/REFERENCE.md`](docs/REFERENCE.md) §8).
- **Ticker** — the events in `.repoboard/events.jsonl`, newest first, including moves made by
  hand-editing a file. One entry per mutation, whichever surface made it: a CLI or MCP move is
  reported under its own actor, a hand edit as `file`, and neither is reported twice (K8).

## Config

`.repoboard/board.yml` (plan §2; `init` writes this):

```yaml
name: My Project
siblings:
  - name: another-board
    url: http://localhost:4243
prefix: RB
activeWindowMinutes: 30
columns:
  - id: backlog
    title: Backlog
  - id: decide
    title: Needs decision
    decision: true
  - id: todo
    title: To do
  - id: doing
    title: Doing
    active: true
    wip: 3
  - id: done
    title: Done
    done: true
```

`status:` on a card is a column `id`. `active: true` marks the columns whose cards count as
"in progress" for the map; `wip` is a soft limit — a move past it warns and still moves; and
`decision: true` (O11) marks the column `ask` moves a card into and `decide` moves it back out of.
`name` (RCB-41) is optional — absent means the top bar and tab title show the served folder's
name instead. `siblings` (RCB-42) is optional too — other running boards, shown as plain top-bar
links; `serve --sibling <name>=<url>` (repeatable) adds more for that process only, and on a name
collision the flag wins. `serve --root <dir>` is repeatable too (RCB-43) — the first is the
primary and opens immediately, every later one is just registered and opens lazily, on first
request. Every route also exists per root, at `/api/repos/<key>/…` — unprefixed paths still mean
the primary, so nothing already served changes. The web (RCB-43 slice 3) shows a repo picker in
the top bar once 2+ roots are served — picking one navigates to `?repo=<key>` (or back to the
plain URL for the primary), which survives a reload. `logDir` (P8.6) is optional too — a repo-root-relative path to an
additional directory of daily `<YYYY-MM-DD>.md` files (e.g. `docs/log`) that `repoboard check`
reads alongside `.repoboard/log/`; `repoboard log` never writes there, and an absent or
nonexistent `logDir` behaves exactly like today. `columns` (RCB-34/P7.3, plan §11 O6) is also
editable from the app itself (`PATCH /api/board`) — saving there rewrites this whole file through
the same serializer `init` uses, so every other key survives but hand-written YAML comments do
not; cards already on disk are never touched, and one in a column you remove still shows, marked
"not in board.yml".

## Develop

```sh
pnpm install
pnpm test        # vitest (687 passed, 2 skipped) + a gzipped-bundle size check (140.3 KB JS, limit 600 KB) — measured 2026-09-18
pnpm typecheck && pnpm lint
pnpm dev         # server + web with hot reload
pnpm build       # packages/server/dist/cli.js, self-contained with the built web app
```

`packages/core` (domain, no I/O), `packages/server` (CLI, HTTP, WebSocket, watcher, MCP),
`packages/web` (Vite, React, d3). The plan and every settled decision: [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md);
how this repo dispatches subagents: [`docs/SUBAGENTS.md`](docs/SUBAGENTS.md); the running record:
`.repoboard/local/docs/HANDOFF.md` (the local layer, RCB-83).

## Status

Pre-1.0, at 0.2.0. Public at https://github.com/prism-nexus/repoboard since 2026-09-18. <!-- npm:omit -->Not on
npm yet — publish waits on the owner's npm account (RCB-51); once it lands, install via `npx
repoboard`.<!-- /npm:omit --> `repoboard@0.2.0` packs to a 339.7 kB tarball of 8 files (measured 2026-09-24, after RCB-141, with
`npm pack --dry-run` in `packages/server` after `pnpm build`). `@repoboard/core` is internal: not
published, bundled into the CLI (`packages/server/tsup.config.ts`'s `noExternal`) — depend on
`repoboard`.

Install-time weight, not tarball weight: installing `repoboard` resolves 98 production transitive packages for
`packages/server` (`pnpm-lock.yaml`, measured 2026-09-24); 93 exist only because of the SDK's HTTP/OAuth
transport (express, hono, ajv, jose, eventsource, and their own deps) — about 23.8 MB of `node_modules/.pnpm`
(the SDK package itself is 5.9 MB of that). `mcp.ts` imports only `McpServer` and `StdioServerTransport`, the
stdio transport; a dependency-free stdio implementation removing this weight is planned (`.repoboard/cards/RCB-152.md`).

## Known issues
(numbered `K1` upward; a commit that closes one says `Closes K<n>` and edits this list)
- ~~**K1** A card whose `title:` contains a colon is invalid YAML unless quoted~~ Closed
  2026-09-06; `parseCard` retries once with the title quoted after a parse failure.
- ~~**K2** `Event.type` narrow in core; server carried its own superset~~ Closed; core widened to
  the full union, `from: string | null`; the server's duplicate type deleted.
- ~~**K3** `lines` reported `0` for binary and >2 MB files~~ Closed; `number | null` in core,
  scanner emits null, map shows "—".
- ~~**K4** `createCard` throws on an unknown status~~ Closed; returns `{ok:false, error}` like
  `moveCard`; CLI and HTTP use the result.
- ~~**K5** `@repoboard/core` is not published.~~ Closed 2026-09-24 (RCB-126, plan §11 O4):
  internal by owner decision — only `repoboard` publishes; `@repoboard/core` stays `private`,
  bundled into the CLI by `packages/server/tsup.config.ts`'s `noExternal`. The packaging half
  from 2026-09-06 stays in place should it ever publish: a `publishConfig` block maps
  `main`/`types`/`exports` to `./dist`, a `prepack` script builds it first, and `pnpm pack`
  produced 23,896 bytes / 38 entries with 0 `src/` entries, importable by bare specifier on plain
  Node (not re-measured here).
- ~~**K6** `repoboard card list --json` is 14.1 KB against 1.9 KB for the table~~ Closed;
  `--json` is compact by default, `--full` adds bodies; JSON shrank ~65% on this repo's cards.
- ~~**K7** A card that points at a doc section shows only the pointer~~ Closed (plan §11 O5,
  2026-09-03); cards carry `refs:`, resolved live by the drawer, `card show`, and MCP `get_card`.
- ~~**K8** A CLI `card move` while `serve` runs puts two entries in the ticker~~ Closed
  2026-09-06; `appendEvent` catches up before appending, watcher synthesises only unclaimed changes.
- ~~**K10** Map-only mode (P7.2) is read-only in practice but not by construction~~ Closed
  2026-09-07 (RCB-35); `writeCard`/`appendEvent` throw `MapOnlyError` before any write, HTTP maps it to 409.
- ~~**K9** There is no way to set a card's `assignee` after `card add`~~ Closed 2026-09-07
  (RCB-31, plan §11 O8); added `card update` with repeatable flags and `--clear` for nulls.
- ~~**K11** `store.test.ts` watcher test timed out intermittently under load~~ Closed
  2026-09-18 (`Closes K11`); test now pre-creates its file, starting from a `change` not an `add`.
- ~~**K12** `serve --root <large repo>` in map-only mode ran at 141% CPU with RSS 2.9 GB~~ Closed
  2026-09-17; watcher now honours `.gitignore` plus a watch cap; RSS 2.9 GB → 169 MB.
- ~~**K13** `check` reported `stale-state` when STATE.md's stamp equals the newest log header second~~
  Closed 2026-09-24 (RCB-122): the comparison is already strict `<`; 0 of 10 same-second pairs went
  stale; two tests now pin the equal-second and one-second-after cases.
- ~~**K14** Flow view: an edge between two boxes two rows apart in one column ran through the box
  between~~ Closed 2026-09-24 (RCB-124): a blocked vertical run detours down a lane right of the
  column (+0.25); unblocked edges keep their exact old path.
- ~~**K15** `systems detect` proposed `env: [dev, prod]` even when `environments.prod` is `none`~~
  Closed 2026-09-24 (RCB-123): `applyDetected` drops a `none` env from systems and connections;
  a list that would become empty is kept as detected.
- **K16** `serve`'s repo watcher can drop a file change that lands right after chokidar's `ready`
  (macOS fs.watch; RCB-117 measured it in the K12 T4 test: 2 of 8 full-suite runs, watcher alive,
  scanCount unchanged for 8000 ms, a later write rescanned normally). The initial scan also runs
  before the watcher starts, so a file created in that gap waits for the next change. Harmless on
  a live repo (the next save rescans); a one-shot rescan after `ready` in `repo-context.ts` would
  close the scan→watch gap but not a dropped event. Filed 2026-09-23.
