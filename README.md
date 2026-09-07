# repoboard

A Kanban board that lives in your repo as markdown files, and a local dashboard that shows the
board next to a map of the code — so you can see what your agents are doing, and where.

![board](docs/board.png)

![map](docs/map.png)

## Try it

Once `repoboard` is on npm (it is not yet — see Status):

```sh
npx repoboard init && npx repoboard serve --open
```

`init` writes `.repoboard/board.yml` and a first card `RB-1`; `serve` opens the dashboard on
`http://127.0.0.1:4242`. From a checkout today: `pnpm install && pnpm build`, then
`node packages/server/dist/cli.js serve --open`.

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
ranking is by tokens, measured 2026-09-03 on the built binary (bytes on the wire, ≈4 bytes per
token; plan §11 O3):

| Surface | Standing cost | Per move | Per list |
|---|---|---|---|
| **CLI** — `repoboard card move RB-12 doing --as claude/dev` | `docs/AGENTS.md` read once: 5.2 KB | ~40 B in, 33 B out | table 2.1 KB; `--json` 6.4 KB; `--json --full` 16.8 KB (27 cards) |
| **MCP** — `claude mcp add repoboard -- npx repoboard mcp` | tool schema 7.8 KB per turn where the harness loads it | ~80 B call, ~200 B result | same as the table |
| **File edit** — `sed -i 's/^status: todo$/status: doing/' .repoboard/cards/RB-12.md` | same AGENTS.md | ~60 B, but a correct move also bumps `updated` and appends a `## Log` line | n/a |

The CLI is the cheapest per operation and has no standing cost. MCP pays off when the agent has
no shell or its harness loads tool schemas on demand. Editing the file is the escape hatch: it
always works, and the watcher synthesizes the event (`actor: file`). `docs/AGENTS.md` is the one
page an agent needs, including a paragraph to paste into a `CLAUDE.md`.

## What it shows

- **Board** — one column per `board.yml` entry with its card count and WIP limit; each card
  shows its assignee as an avatar (emoji and color hashed from the `assignee` string), labels,
  and how many files and refs it names. Drag and drop writes the card file. A card's `refs:`
  (`docs/BUILD-PLAN.md@P6.2`, `README.md#Known issues`, `src/x.ts:L10-L20`) render in the
  drawer as the referenced lines, read from the file on every open — point, don't paste.
- **Map** — a treemap of the repo (files by size, colored by language; this repo: 127 files,
  layout under 1.2 ms on every run recorded in `docs/HANDOFF.md`), heat modes for churn over 30 and 90 days and for
  recent edits, an import graph for JS/TS (117 edges here), and *who is where*: files named on
  cards in an active column, updated within `activeWindowMinutes`, glow in the assignee's color.
- **Ticker** — the events in `.repoboard/events.jsonl`, newest first, including moves made by
  hand-editing a file.

## Config

`.repoboard/board.yml` (plan §2; `init` writes this):

```yaml
prefix: RB
activeWindowMinutes: 30
columns:
  - id: backlog
    title: Backlog
  - id: todo
    title: To do
  - id: doing
    title: Doing
    active: true
    wip: 3
  - id: review
    title: Review
    active: true
  - id: done
    title: Done
    done: true
```

`status:` on a card is a column `id`. `active: true` marks the columns whose cards count as
"in progress" for the map; `wip` is a soft limit — a move past it warns and still moves.

## Develop

```sh
pnpm install
pnpm test        # vitest (191 tests) + a gzipped-bundle size check (134.6 KB JS, limit 600 KB)
pnpm typecheck && pnpm lint
pnpm dev         # server + web with hot reload
pnpm build       # packages/server/dist/cli.js, self-contained with the built web app
```

`packages/core` (domain, no I/O), `packages/server` (CLI, HTTP, WebSocket, watcher, MCP),
`packages/web` (Vite, React, d3). The plan and every settled decision: `docs/BUILD-PLAN.md`;
the running record: `docs/HANDOFF.md`.

## Status

Pre-1.0. `repoboard@0.1.0` packs to a 267 KB tarball of 8 files and runs from `npx` in a foreign
repo (2026-09-03), but it is not published yet. `@repoboard/core` is internal for v0.1 (plan §11
O4): it ships TypeScript source only and does not publish; depend on `repoboard`. No GitHub
repo until after v1 (O2).

## Known issues
(numbered `K1` upward; a commit that closes one says `Closes K<n>` and edits this list)
- ~~**K1** A card whose `title:` contains a colon (`P3.1 Board view: columns`) is invalid YAML
  unless quoted, and an agent writing frontmatter by hand will do this. Found on 7 of the first 24
  cards written by the orchestrator (2026-09-02).~~ Closed 2026-09-06 with all three options:
  (a) `AGENTS.md` says quote it; (c) every surface quotes on serialize, so a recovered card
  self-heals on its first write; and now (b) — after `YAML.parse` throws, `parseCard` retries
  **once** with only the `title:` value quoted (by the YAML writer, not by concatenating quotes),
  and returns the **original** error if that also fails, since the reader never wrote the rewrite.
  It never runs on a document that parsed, so no valid file changes meaning; it declines values
  starting `| > & * ! # { [ " '` and any rewrite that would span lines. What it cannot do is read
  minds: a trailing `# comment` on an unquoted title line is folded into the title. Measured:
  parse outcome differs on 0 of this repo's 30 cards; tests 197 → 210.
- ~~**K2** `Event.type` narrow in core; server carried its own superset.~~ Closed: core widened to
  `'move' | 'update' | 'create'` with `from: string | null`; server type deleted.
- ~~**K3** `lines` reported `0` for binary and >2 MB files.~~ Closed: `number | null` in core,
  scanner emits null (1 file in this repo), map shows "—".
- ~~**K4** `createCard` throws on an unknown status.~~ Closed: returns `{ok:false, error}` like
  `moveCard`; CLI and HTTP use the result.
- **K5** `@repoboard/core` exports TS source only. The server bundles core with tsup, so this only
  bites a third party importing `@repoboard/core` on plain Node. Owner decided 2026-09-03: leave it for
  v0.1 (core stays private, only `repoboard` publishes); **must be resolved before the GitHub
  repo goes public** (plan §11 O4). Gate on P6.3.
- ~~**K6** `repoboard card list --json` is 14.1 KB against 1.9 KB for the table (2026-09-03, 24 cards)
  because it includes every body.~~ Closed: `--json` is compact by default (id, title, status,
  assignee, priority, labels, files, updated; one row per line), `--full` adds bodies; MCP
  `list_cards` uses the same rows and formatter, with `full: true` for bodies. Measured on this
  repo's 27 cards, bytes: CLI `--json` 18,290 → 6,433; `--json --full` 16,240; table 2,149;
  MCP `list_cards` result 8,506 → 6,432 (`full: true` 16,239).
- ~~**K7** A card that points at a doc section (`Task P6.2 in docs/BUILD-PLAN.md §5`) shows only
  the pointer; the reader has to leave the board to learn what the task is.~~ Closed (plan §11
  O5, 2026-09-03): cards carry `refs:` (`path#Heading`, `path@Token`, `path:L10-L20`, `path`;
  `docs/AGENTS.md` §4) and the drawer, `card show --resolve` and MCP `get_card`
  (`resolveRefs: true`) render the lines live from the file through `GET /api/cards/:id/refs`,
  never cached; caps 200 lines / 16 KB per ref; an unresolvable ref is `text: null` plus an
  error. One path guard (`resolveRepoPath`) rejects absolute, `..`, `.git/` and symlinks out of
  the repo. Measured: RCB-22..26 converted from quoted blocks to refs, 5,306 → 3,895 body-file
  bytes (12 refs); tests 145 → 191.
- ~~**K8** A CLI `card move` while `serve` runs puts two entries in the ticker.~~ Closed
  (2026-09-06). The recorded trigger was wrong twice over: the hand edit is incidental — a CLI
  mutation alone is enough, because the CLI is a second process and the watcher sees both the card
  file and `events.jsonl` — and the duplicate had two modes, because the two watcher deliveries
  race. In the `cards/*.md`-first mode the ticker showed `file` twice and **the CLI's own event was
  never emitted**: `appendEvent` added its own line's length to `eventsBytes`, a read offset, so a
  foreign line appended since the last read left the offset short by exactly that much and the next
  read sliced mid-line. Fix: `appendEvent` catches up before appending, and the watcher synthesises
  only for a change nobody claimed — a claim being an event with `ts === card.updated`, counted
  only when `updated` actually moved. That freshness test is load-bearing: without it a later `sed`
  on `status:` alone matches a spent claim and the `file` event goes silent, which is the product's
  headline behaviour. Measured on the built binary, events on the ticker per mutation:
  `card add` 2 → 1, `card move` 2 → 1, `sed` after a CLI move 1 → 1, `sed` bumping `updated`
  1 → 1; tests 191 → 197.
