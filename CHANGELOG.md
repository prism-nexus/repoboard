# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Highlights

- **Workspace: one board that coordinates several (RCB-153).** A `board.yml` with `repos:` (each
  `{key, root, writes?}`) makes a board a workspace over member boards. At its root: `state` and
  `check` aggregate every member (`[<key>]`-prefixed; a missing member is a
  `workspace-member-missing` finding, not a crash); card ids resolve by prefix across boards
  (`<key>:<id>` when two share one); `card list --repo <key>|all`, `card add --repo <key>`; a
  workspace card's `gate:` may name a member card; `serve` with no `--root` serves the workspace
  and every member under their configured keys (any `--root` turns that off); `init --workspace
  --repo <key>=<path>` scaffolds one; `mcp` gives the same verbs an optional `repo` argument
  (tool count unchanged, and a board without `repos:` sees a byte-identical `tools/list`).
  Members are read-only unless listed with `writes: cards`, and even then a write touches only
  that member's card file and its `events.jsonl`.

## [0.2.0] — 2026-09-25

### Highlights

What changed since 0.1.0, card ids in parentheses point at `.repoboard/cards/<id>.md`:

- **The systems map (Flow view).** The `systems.yml` model and layout (RCB-95); `systems detect
  [--root] [--apply] [--json]` — dry-run default, provenance stamped, hand rows win, and a
  `none` environment is now dropped from systems and connections instead of proposed (RCB-96;
  RCB-123 closes K15); `systems` / `systems show`, MCP `list_systems`/`get_system`, `GET
  /api/systems` (RCB-97); the Flow view — rows by layer, dev/prod/both, one-env dashes, a
  none-note, drawer readable at a glance with pointers collapsed by default and backlinks
  (RCB-98, RCB-109); "Plan the systems map" creates the detect → hand-correct → connect step
  cards when a repo has no `systems.yml` (RCB-111); which test files exercise a system, static
  and live (RCB-110); per-pointer test coverage read from the gate's coverage report (RCB-113);
  a Flow edge between two boxes two rows apart in one column no longer runs through the box
  between (RCB-124 closes K14).
- **The repo dashboard.** A "Repo" tab per served repo — health (last recorded gate per check),
  commits (HEAD + origin/main, 14-day cadence, per author), systems + coverage; `GET
  /api/dashboard`; `repoboard gate record|show`, where a same-second ledger tie now goes to the
  later line and `gate record --tests` without `--failed` is exit 1, nothing written (RCB-112,
  RCB-116).
- **Plan-ux gaps.** `card list --parent <id> [--unblocked]` and `card show --steps` in phase
  order (RCB-104); `card show --resolve` merges overlapping spans of one file instead of
  repeating them (RCB-106); `card ask`/`decide` write a `## Decision` body section that survives
  every re-ask (RCB-107); a gate on a DONE card is history and no longer blocks it (RCB-105);
  lane phase chain across columns, plan parents not counted against WIP by default (RCB-108);
  `seat <name>` Next card follows a parent's next unblocked step (RCB-103).
- **The practices layer, hardened.** `seat --up` refuses a second UP inside the active window,
  `--down` requires `in-flight:`/`owes:` lines, `--update` rewrites the bullet body, `seat list`
  (RCB-87, RCB-88, RCB-89); `repoboard log` refuses a missing seat and writes to `board.yml`'s
  `logDir` when set (RCB-71); `state --trim-landings <n>` archives older LAST LANDINGS entries
  verbatim (RCB-92); `cost` bills a FROZEN-linked file separately and leaves it out of the total
  (RCB-91); `check` reports a future-stamp and no longer flags a STATE stamp equal to the newest
  log header second (RCB-90; RCB-122 closes K13), and warns on card files git does not track,
  naming each id and its creator (RCB-119); local `init` keeps a tracked STATE.md/log in place
  (RCB-93); `seat` says why Next card is empty (RCB-118); `leases.yml` and `STATE.md` writes
  serialize under one cross-process lock, an O_EXCL steal once the holder is dead or the lock is
  older than 30 s (RCB-133); a log block from an UP seat restamps STATE.md, so `check` stays
  green mid-session (RCB-127); `local init --remote none` acks a local layer with no backup and
  `check`'s local-no-remote goes quiet (RCB-128); `repoboard decisions` / MCP `list_decisions` —
  answered, not acknowledged (RCB-129); `check` flags a hand-typed OWNER QUEUE that drifts from
  the generated one (RCB-130); live leases surfaced in `seat <name>`, `state` and `check`
  (RCB-131); `log show --since/--tail`, `state --trim-landings --archive <path>` (RCB-132);
  `seat` prints one line instead of six empty sections on a solo board (RCB-140); `--json` on
  `card show`, `log show` and `state` (RCB-144).
- **MCP parity.** `CARD_INTRO` lives once, in the server instructions, instead of spliced into
  every tool description — the schema drops 31,301 → 22,769 B across 25 tools (RCB-137); four
  tools mirror their CLI counterparts — `get_log`, `get_seat`, `record_gate`, `get_gate` — and
  `list_cards` gains `size`/`parent`/`unblocked` (RCB-146); 29 tools, 26,155 B measured over stdio at
  RCB-146; `list_decisions` makes 30 (RCB-129); MCP now speaks
  stdio JSON-RPC without `@modelcontextprotocol/sdk` at runtime, 98 → 5 production transitive
  packages (RCB-152).
- **The board UI.** `serve` fires one non-blocking rescan on the watcher's `ready`, closing the
  scan/watch gap where a file created before the first watch went unseen (RCB-125 closes K16); a
  dead server on load shows "can't reach the server" after 5 s (RCB-138); card titles clamp to 3
  lines, full title on hover (RCB-139); log timeline blocks render markdown, parsed only when
  opened (RCB-143); a text search box filters the board by title, id and label (RCB-147); a
  one-time dismissible tip strip shows on a board with at most 1 card (RCB-149); memoized cards
  and linear per-render work cut drawer-open latency 277 → 27 ms at 500 cards, and a column above
  150 cards virtualizes — sort 191 → 44 ms, DOM 4,098 → 193 nodes at N=500 (RCB-151 closes
  RCB-148); web test coverage added for the reconnect layer and wire protocol (RCB-150).
- **npm packaging.** The package page ships README and LICENSE, repo links, no source maps, no
  tracker ids in `--help` (RCB-121); CI green on `main` — suite on Node 22/24, pack-smoke on
  20/22/24 (RCB-120); per-command `--help`, parse errors with a usage block, a one-line crash,
  and a 7-line quickstart replacing a 212-line one (RCB-134); the npm README strips
  `<!-- npm:omit -->` regions and turns 13 prose doc pointers into GitHub links (RCB-135); `init`
  names its sibling verbs, the dead "Build once, then" line is gone (RCB-136); the library entry
  stops re-exporting `runCli`, so `dist/index.js` no longer bundles the CLI — 395,379 → 260,438 B,
  the packed tarball 366.0 → 339.7 kB (RCB-141); README measures the MCP SDK's install weight —
  98 production packages, 93 reachable only through `@modelcontextprotocol/sdk` (RCB-142); a
  build-time src digest clears the dist-stale false alarm after a checkout that rewrites src/
  with unchanged bytes (RCB-145).
- `@repoboard/core` is internal: not published, bundled into `repoboard`.

## [0.1.0] — 2026-09-18

### Highlights

What 0.1.0 is, plan task ids in parentheses point at the decision in `docs/BUILD-PLAN.md` §5:

- **The board as markdown files.** One card per file in `.repoboard/cards/<id>.md`, columns in
  `.repoboard/board.yml`, transitions and validation pure and I/O-free (P1.1, P1.2, P1.3, P1.4).
- **The local dashboard.** Board view with drag-and-drop columns (P3.1, P3.2), a card drawer with
  markdown body, edit, and refs resolved live from the file rather than cached (P3.3, K7), an
  activity ticker (P3.4), and a repo map: file treemap by size/language, an activity-heat overlay,
  "who is where" (a card's files glow in the assignee's color), and an import graph for JS/TS
  (P4.1, P4.2, P4.3, P4.4). A directory with no `.repoboard/` opens map-only and read-only (P7.2).
- **The CLI.** `init` (`--practices` scaffolds STATE.md, today's log, `leases.yml`, P8.3);
  `card add/move/update/list/show/ask/decide` (P2.1, decisions P8.1); `lease take/release/list`
  and `window add/list/check` (P8.2); `state` and `log` (P8.3, plus `log --last <seat>`,
  RCB-47); `seat` — the cold-start bundle for one seat in a single command (RCB-48); `check`,
  `cost` (P8.4), `archive`,
  `sync-issues` (P8.5); `serve` (P2.1), including `--root` for a foreign repo (P7.1, P7.2).
- **MCP server** (P5.1) — `repoboard mcp` over stdio, 21 tools: `list_cards`, `get_card`,
  `create_card`, `move_card`, `update_card`, `append_log`, `board_summary`, `ask_owner`,
  `record_decision`, `take_lease`, `release_lease`, `list_leases`, `add_window`, `check_window`,
  `get_state`, `set_state_section`, `append_repo_log`, `check`, `cost`, `archive_cards`,
  `sync_issues`. `docs/AGENTS.md` (P5.2) is the one page an agent needs.
- **HTTP + WebSocket API** (P2.3) — every mutation goes through the same store the CLI and MCP
  use; the watcher pushes changes to every open browser.
- **The practices layer** — the board becomes the framework for how agents work in a repo:
  decisions and owner tasks recorded directly on a card, no separate queue (P8.1); leases and
  windows for coordinating shared resources, shown in a "Now" strip (P8.2); `STATE.md` and a
  daily log per seat, `check`'s staleness and lease findings (P8.3); cold-context cost
  measurement against a configurable budget (P8.4); archiving old `done` cards and syncing a
  markdown known-issues list to cards (P8.5).

Compare: https://github.com/prism-nexus/repoboard/releases/tag/v0.1.0
