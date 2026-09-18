# BUILD-PLAN — the authority

**What this is.** A local-first dashboard you run inside any repo. It shows the repo as pictures
a human can read at a glance, and it shows work as cards on a Kanban board that move while agents
(Claude Code and friends) work on them. It ships to GitHub as an open-source utility.

**One-line pitch.** `npx repoboard` in a repo → a browser tab with a live board and a live map of the
codebase. Agents move cards by editing files, running the CLI, or calling the MCP server. Humans
drag cards. Everything is plain files in git.

Name: **repoboard** (Remember · Connect · Build) — decided 2026-09-03, §11 O1.

---

## §0 Ground rules

0.1 `CLAUDE.md` non-negotiables apply. This plan wins over HANDOFF when they disagree.
0.2 Local-first. No accounts, no telemetry, no network calls at runtime. The dashboard binds to
    localhost only.
0.3 **Plain files are the database.** Board state lives in the repo under `.repoboard/`. Git is the
    history. If you can `cat` it, an agent can edit it. This is the product's whole thesis.
0.4 Every surface that mutates a card (file edit, CLI, HTTP, MCP) funnels through one function in
    `packages/core`. No surface writes its own frontmatter.
0.5 `packages/core` is I/O-free and a purity test proves it. Clock and randomness are parameters.
0.6 Stop and ask before: publishing to npm, creating the GitHub repo, adding a runtime network
    call, adding a dependency over 200 KB to the web bundle.

---

## §1 Decisions (settled — do not relitigate without the owner)

| # | Decision | Why |
|---|---|---|
| D1 | **Cards are markdown files with YAML frontmatter** in `.repoboard/cards/<id>.md`. One file per card. | Diffable, mergeable, agent-editable with zero tooling, readable on GitHub. |
| D2 | **Columns are configured in `.repoboard/board.yml`**; `status` on a card is a column id. Default columns: `backlog, decide, todo, doing, done` (O11; was `backlog, todo, doing, review, done` until 2026-09-17). | Teams differ; the default matches how the owner already works. |
| D3 | **Card ids are `<PREFIX>-<n>`**, prefix from `board.yml`, `n` monotonic, allocated by scanning existing ids (max+1). Default prefix `RB`. | Matches the owner's `K<n>` habit. No counter file to merge-conflict. |
| D4 | **Three agent surfaces, one core:** direct file edit · CLI (`repoboard card move RB-3 doing`) · MCP server (`repoboard mcp`). Plus HTTP for the web UI. | An agent that can only edit files still works. Claude Code gets a native tool. |
| D5 | **Stack:** TypeScript, Node ≥ 20, pnpm workspace. `packages/core` (domain), `packages/server` (CLI + HTTP + WS + watcher + MCP), `packages/web` (Vite + React + d3). Tests: vitest. Lint: biome. | Widest contributor pool for an OSS utility. d3 for treemap/graph. |
| D6 | **Live updates via a filesystem watcher (chokidar) → WebSocket.** The server never trusts its own memory as the source of truth; it re-reads the file on every change event. | An agent editing a file with `sed` shows up on the board in under a second, and the server cannot drift from disk. |
| D7 | **Repo visuals, in priority order:** (a) treemap of files by size, colored by language; (b) import graph for JS/TS (other languages: directory graph fallback); (c) git activity heat — commits per file over the last 30/90 days; (d) **"who is where"** — files listed on `doing` cards glow with the assignee's color. | (a)+(c) are language-agnostic and land first. (d) is the connection between board and code, which is the point. |
| D8 | **Agent identity is a free string on `assignee`** (e.g. `claude/web-agent`). Avatar = deterministic emoji + color hashed from the string. **"Active"** = card in a column with `active: true` in board.yml AND `updated` within `activeWindowMinutes` (default 30). | No registration step. Presence derives from the files, like everything else. |
| D9 | **Fun is a setting, defaulting on:** card slide animation, avatar bounce on move, confetti on `done`, activity ticker. `--no-fun` and a UI toggle turn them off. Never fun at the cost of readability. | "Utility meets fun." Readability wins ties. |
| D10 | **License MIT.** | Utility for folks to use. |
| D11 | No LLM in the product's own path. It is a viewer and a file editor; the agents bring the intelligence. | Keeps it deterministic, free, and offline. |

---

## §2 File formats (the contract agents see)

### `.repoboard/board.yml`
```yaml
name: My Project        # optional (RCB-41); absent = the served folder's name
siblings: []            # optional (RCB-42); [{name, url}], merged with `serve --sibling` (flag wins ties)
prefix: RB
activeWindowMinutes: 30
claudeMdBudgetBytes: 8192  # optional (P8.4); a `repoboard cost --budget` flag wins over this
columns:
  - id: backlog
    title: Backlog
  - id: decide
    title: Needs decision
    decision: true      # O11: cards asking the owner a question land here
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

### `.repoboard/cards/RB-12.md`
```markdown
---
id: RB-12
title: Treemap view of the repo
status: doing
assignee: claude/web-agent
priority: high          # high | medium | low, optional
labels: [web, viz]
files:
  - packages/web/src/views/Treemap.tsx
refs:                   # optional; rendered live from the file (O5). See K7 brief for forms.
  - docs/BUILD-PLAN.md@P4.1
  - docs/BUILD-PLAN.md#§11 Owner decisions
  - packages/web/src/views/Treemap.tsx:L1-L20
created: 2026-09-02T22:00:00Z
updated: 2026-09-02T22:41:10Z
---

Description in markdown. Agents append notes below a `## Log` heading; humans write wherever.

## Log
- 2026-09-02T22:41Z claude/web-agent — moved to doing, starting on the d3 layout
```

Rules: `id`, `title`, `status`, `created`, `updated` required; everything else optional.
Unknown frontmatter keys are preserved on round-trip, never dropped. Body is preserved
byte-for-byte except when a surface explicitly appends to `## Log`.

### `.repoboard/events.jsonl` (optional, append-only)
One JSON object per line: `{ts, actor, type, cardId, from, to}`. Written by CLI/HTTP/MCP moves.
Direct file edits produce no event; the watcher synthesizes one from the diff (`actor: "file"`).
**Exactly one entry per mutation** (K8, 2026-09-06): a surface that writes the file also appends
its event, so the watcher synthesizes only for a change nobody claimed — a claim being an event
whose `ts` equals the card's `updated`, counted only when `updated` actually moved. Without that
freshness test a later hand edit of `status:` alone matches a spent claim and goes unreported,
which would break §0.3. A reader of this file must also catch up before appending: the byte
offset cannot be maintained by arithmetic when another process appends too. The ticker reads
this. Safe to delete; safe to gitignore.

---

## §3 Wire contract (server ↔ web)

HTTP, JSON, localhost only:
- `GET /api/board` → `{ config, cards: Card[], hasBoard: boolean }` — `hasBoard` (additive, P7.2)
  is false when the served root has no `.repoboard/` directory: the map works, `config` is
  `defaultBoardConfig()` standing in for a board that does not exist, and `cards` is empty. An
  empty but initialized `.repoboard/` is `hasBoard: true` with zero cards; the two states are
  different. Read once at start — a `.repoboard/` created while the server runs needs a restart.
- `POST /api/cards` `{title, status?, ...}` → `Card`
- `PATCH /api/cards/:id` `{status?, assignee?, title?, ...}` → `Card`
- `GET /api/repo` → `RepoSnapshot` (§4)
- `GET /api/events?since=<ts>` → `Event[]`
- `GET /api/cards/:id/refs` → `{spec, path, start, end, text, truncated, error}[]` — the card's
  `refs:` resolved from the files on every request, never cached (K7, O5); a ref that does not
  resolve has `text: null` and an `error`

WebSocket `/ws`, server → client:
- `{type:"snapshot", board, repo}` on connect — `board` is the `GET /api/board` payload verbatim,
  `hasBoard` included (one function builds both, so they cannot disagree)
- `{type:"card", card}` · `{type:"card:removed", id}`
- `{type:"repo", repo}` (debounced, ≤ 1 per 2 s)
- `{type:"event", event}`

Client → server: `{type:"card:move", id, status}` · `{type:"card:update", id, patch}`.
The server applies via core, writes the file, and lets the watcher echo the change back. No
optimistic state that disagrees with disk for more than one round trip.

---

## §4 Repo snapshot shape
```ts
type RepoSnapshot = {
  root: string;
  scannedAt: string;
  files: { path: string; bytes: number; lines: number; lang: string;
           commits30d: number; commits90d: number; lastCommitAt: string | null }[];
  edges: { from: string; to: string }[];   // import graph, JS/TS only in P4
  languages: Record<string, number>;       // bytes per lang
  head: { branch: string; sha: string } | null;
}
```
Respect `.gitignore` (use `git ls-files` as the file list when in a git repo; walk otherwise).
Cap at 20,000 files; beyond that, report and truncate rather than hang.

**K12 (2026-09-17): the repo watcher must respect the same `.gitignore` rule as the scan above, and
carry its own hard cap.** Before K12, `serve`'s chokidar watcher over `--root` skipped only `.git`
(mostly), `.repoboard`, and `node_modules`/`dist` path segments — not `.gitignore` — so a gitignored
tree the scan never lists (build output, a data dump, a pile of worktrees) was still walked and
watched in full. Measured on freshpickedjobs: 6.36M files outside node_modules/.git, EMFILE at 27 s,
RSS past 1.6 GB, `/api/board` never answering. Fixed in `packages/server/src/watch-ignore.ts`
(shared ignore predicate, one `git ls-files --others --ignored --exclude-standard --directory` spawn
per watcher start) plus `ServerOptions.watchCap` / CLI `--watch-cap` (default `DEFAULT_WATCH_CAP` =
20,000 watched paths, checked via `getWatched()` once the watcher is ready): over cap, or an
EMFILE/ENFILE from the watcher itself, closes it and serves from the last scan, logging one warning
rather than degrading silently. See README K12 and `docs/AGENTS.md`'s "`serve`'s repo watcher" note.

---

## §5 Phases and tasks

Each task: DoD as written · `pnpm test` green · `pnpm typecheck` exit 0 with no `any` added ·
one commit carrying verification output.

### P0 Scaffold
- **P0.1** pnpm workspace with `packages/core`, `packages/server`, `packages/web`; root scripts
  `test`, `typecheck`, `lint`, `build`, `dev`; vitest workspace; biome; MIT `LICENSE`;
  GitHub Actions CI running test+typecheck+lint on Node 20 and 22.
  DoD: `pnpm install && pnpm test && pnpm typecheck && pnpm lint` all exit 0 on a clean clone.
- **P0.2** `packages/core/test/purity.test.ts`: fails if any file in `core/src` imports a node
  builtin, `node:*`, or any bare package other than an allowlist (`yaml`, `zod`).

### P1 Core (I/O-free)
- **P1.1** Card schema (zod) · `parseCard(text) → Card | ParseError` · `serializeCard(card) →
  text` with unknown keys and body preserved. Round-trip property test.
- **P1.2** Board config schema · `parseBoard(text)` · defaults.
- **P1.3** Transitions: `moveCard(card, toStatus, {actor, now})` → `{card, event}`; validates
  column exists; enforces `wip` **as a warning in the returned result, never a hard block**;
  appends a `## Log` line. `createCard(input, {existingIds, now})` allocates the id.
- **P1.4** Presence: `isActive(card, config, now)`; `avatarFor(assignee) → {emoji, color}`
  deterministic; `computeBoardSummary(cards, config)`.

### P2 Server
- **P2.1** CLI `repoboard init` writes `.repoboard/board.yml` and a first card; `repoboard card add|move|list|show`;
  `repoboard serve [--port] [--open] [--no-fun] [--watch-cap] [--sibling <name>=<url>]` (K12, RCB-42).
  Uses core for every mutation.
- **P2.2** Card store: reads `.repoboard/cards/*.md`, chokidar watcher, atomic writes (temp + rename),
  event log append. Tests write to a temp dir, never the repo.
- **P2.3** HTTP + WS per §3. Binds `127.0.0.1` only.
- **P2.4** Repo scanner per §4: `git ls-files`, sizes, line counts, language by extension, git
  activity via one `git log --name-only --since=90.days` pass, not one call per file.
  Cache keyed on HEAD sha + mtimes; rescan on watcher events, debounced 2 s.

### P3 Web — the board
- **P3.1** Vite + React + TS; WS client with reconnect; column layout from config; cards with
  avatar, labels, priority stripe, file count.
- **P3.2** Drag and drop between columns (`@dnd-kit`), sends `card:move`, reconciles with echo.
- **P3.3** Card drawer: rendered markdown body, edit title/assignee/status, show `## Log`.
- **P3.4** Activity ticker across the top; agent avatars; the fun layer per D9 with toggle.
- **P3.5** `web` vitest project with at least: renders columns from config; a `card` WS message
  moves a card; the bundle size control (fail if `dist` > 600 KB gzipped).

### P4 Web — the repo
- **P4.1** Treemap (d3-hierarchy) of files by bytes, colored by language, zoomable by directory.
- **P4.2** Activity heat overlay: opacity by commits30d; toggle 30/90.
- **P4.3** "Who is where": files on active cards outlined in the assignee's color; hovering a
  card highlights its files; clicking a file lists its cards.
- **P4.4** Import graph for JS/TS (regex import/require scan in the server, no bundler):
  force-directed, capped at 500 nodes with a "too big, filter by directory" affordance.

### P5 MCP
- **P5.1** `repoboard mcp` — stdio MCP server exposing `list_cards`, `get_card`, `create_card`,
  `move_card`, `update_card`, `append_log`. Same core, same store. Tool descriptions written for
  an agent that has never seen the board.
- **P5.2** `docs/AGENTS.md` — the one page an agent (or a CLAUDE.md) needs: file format, CLI,
  MCP registration snippet for Claude Code, the `## Log` convention.

### P6 Ship
- **P6.1** README with a 20-second GIF, install (`npx repoboard`), the thesis (files are the DB).
- **P6.2** `npx repoboard` works from a fresh `npm pack` install; `bin` wiring verified.
- **P6.3** Owner decisions O1–O3 answered; GitHub repo created; v0.1.0 tagged. **Ask first.**

**Exit criterion for v0.1:** in a foreign repo, `npx repoboard` opens a board; an agent with only a
shell moves a card with `sed` and the board updates within 1 s; the treemap renders; the card's
files glow with the agent's color.

### P7 Other repos (post-v0.1; owner decisions O6 and O7, 2026-09-07)
- **P7.1** `repoboard serve --root <dir>` — the flag `repoboard mcp` has had since P5.1. One repo
  per process; the port stays the user's to pick with `--port`.
- **P7.2** A directory with no `.repoboard/` opens in **map-only** mode instead of being refused:
  treemap, churn heat and the import graph render; the Board tab says the project has no board
  and offers `repoboard init` as a *command to run*, not an action the server takes. **Read-only
  is the guarantee** — serving a foreign repo must never create, move or write anything inside it.
- **P7.3** Columns editable in the app (O6): `PATCH /api/board` writes `board.yml` through
  `serializeBoard`, and the UI edits the column set. **Next round, not P7.1/P7.2's dispatch.**

**Exit criterion for P7:** `repoboard serve --root <a repo that has never seen repoboard>` renders
that repo's map, writes nothing into it (verified by `git status` in the target being clean and
`.repoboard/` still absent), and the Board tab explains itself rather than showing five empty
columns.

---

### P8 Practices — the board becomes the framework for how agents work in a repo (owner decision O9, 2026-09-17)
Source: `~/Projects/Repos/freshpickedjobs/docs/REPOBOARD-FIT-ASSESSMENT.md` §3 (the problems were
measured there: a 32.6 KB CLAUDE.md in every context, a 23,877-line running record, an owner decision
held 11 h on a relay, lock windows sent as chat messages). One principle for every task: **a plain file
under `.repoboard/` that `sed` can edit, written through core by all three surfaces, rendered by the
dashboard, its bytes on the wire measured before it ships (O3).** Core stays I/O-free (0.5).

- **P8.1 Decisions ON THE CARD** (rewritten on O10, amended on O11) — **Landed `aef44c3`.** A card
  carries an optional `decision:` block: `question`,
  `options: [{letter, text}]`, `askedBy/askedAt`, `returnTo` (O11), and once the owner answers
  `chosen` (a letter), `words` (verbatim, optional), `decidedBy/decidedAt`. A card with a decision
  and no answer NEEDS OWNER; the board badges it and shows the letters inline; the drawer shows one
  button per option and a words field, and the owner decides **right there**. `ask` and `decide`
  are core transitions that append `## Log` lines and, on a board with a `decision: true` column
  (O11), move the card there and back (recording `returnTo`); `PATCH` refuses the field so nothing
  bypasses the log. CLI `card ask <id> "<q>" --option "A1 …"...`, `card decide <id> [letter]
  [--words]`, `card list --needs-decision`; MCP `ask_owner`, `record_decision`, `list_cards
  needsDecision`; HTTP `/api/cards/:id/ask|decide`. A decided card is authority. **No separate
  file, no separate tab** — the "owner queue" is the `decide` column itself (O11 dropped the
  TopBar `needs decision` filter as redundant with it; `card list --needs-decision` and MCP
  `needsDecision` stay, for an agent with no dashboard). Brief: `docs/P8.1-DECISIONS-BRIEF.md`.
- **P8.2 Leases and windows** — **Landed `6ceb5ce`.** `.repoboard/leases.yml`: `leases: [{resource, holder, since, until?, note?}]`,
  `windows: [{resource, start, end, name}]`. A lease past `until` renders STALE, not held; a window past
  `end` is pruned on the next write. CLI `repoboard lease take|release <resource> --as <holder> [--until ts] [--note]`,
  `lease list`; `repoboard window add <resource> <start> <end> <name>`, `window list`,
  **`repoboard window check <resource> [--at ts]` exits 0 clear / 1 inside, printing the window** — so a
  test-lock shim can call it. MCP `take_lease`, `release_lease`, `list_leases`, `add_window`,
  `check_window`. HTTP `GET /api/leases`. Web: a **Now** strip under the top bar — who holds what, the
  next window, the next expiry.
- **P8.3 State, the daily log, `init --practices`, `check`** — `.repoboard/STATE.md` (fixed sections
  `## LIVE`, `## LAST LANDINGS`, `## OWNER QUEUE`, `## SEATS`; rewritten in place, never appended) and
  `.repoboard/log/YYYY-MM-DD.md` (every seat appends its own block; never rewritten).
  `repoboard log --as <seat> [--title "…"] <text | --stdin>` appends `##### <SEAT> <ts>` + the text to
  today's file (creates it). `repoboard state` prints STATE (OWNER QUEUE generated fresh);
  `repoboard state --set-section LIVE|LAST-LANDINGS|SEATS` restamps one section. `repoboard init
  --practices` scaffolds STATE.md, today's log, `leases.yml` (O10 dropped `decisions.jsonl` — a
  card's own `decision:` block carries it, so there is nothing separate left to scaffold), and an
  eight-line NEXT-AGENT-PROMPT.md at the repo root (only if absent). **`repoboard check`** exits 1
  with one line per finding, `ok` when none: `stale-state` (STATE's stamp older than the newest log
  file's mtime or its newest `#####` header, whichever is later) and `stale-lease` are error-grade;
  `active-without-lease` (a card in an `active` column with no lease held by its assignee) is
  warning-grade, blocking only with `--strict`; `needs-decision` (a count) is informational, never
  fails; `cost-over-budget` (P8.4) is stubbed. MCP `get_state`, `set_state_section`,
  `append_repo_log`, `check`. Web: STATE rendered as a collapsible panel at the top of the Board
  view (localStorage remembers collapsed/expanded); the log as a timeline beside the ticker;
  OWNER QUEUE on STATE is GENERATED from cards that need a decision (P8.1), never typed, and a
  queue line scrolls to the `decide` column rather than toggling a filter (O11 retired it).
  Brief: `docs/P8.3-STATE-LOG-BRIEF.md`. **Landed `562a09d`.**
- **P8.4 Cost** — **Landed `b16c115`.** `repoboard cost [--root <dir>] [--budget <bytes>] [--json]`:
  bytes (and ≈tokens at 4 B/token) of CLAUDE.md and its variants, AGENTS.md and its variants, every
  repo-relative path CLAUDE.md names in backticks that exists, and the names of MCP servers in
  `.mcp.json`; total = "what a cold agent loads". Exit 1 when CLAUDE.md exceeds its budget (default
  8192, or `board.yml`'s `claudeMdBudgetBytes`); `check`'s `cost-over-budget` finding (error-grade)
  is wired to the same report. MCP `cost`, HTTP `GET /api/cost`, a Map-view header tile. Measured
  both repoboard (111,875 B) and freshpickedjobs read-only via `--root` (2,536,728 B, 85% one
  linked file) — `docs/AGENTS.md` §11 has both tables. Brief: `docs/P8.4-COST-BRIEF.md`.
- **P8.5 Archive and issue sync** — `repoboard archive [--older-than 14d]` moves `done` cards whose
  `updated` is older than the cutoff to `.repoboard/archive/` (a `git mv` when the repo is git, else a
  rename); the store does not load `archive/`. `repoboard sync-issues <path>#<heading>` creates a card
  (status `todo`, label `issue`, `refs: [<path>@K<n>]`) for every `- **K<n>` list item under the
  heading, and moves the card to `done` when the item is gone or struck (`- ~~**K<n>`); idempotent by
  ref; never edits the source file. The README stays the text; the board is the view.
  **Landed `3c314d5`** (verified by the orchestrator: 562/562 ×2 independently, typecheck 0, lint 0; fpj dry-run re-run read-only at 0427693 → 64/0/0, K list identical to an independent grep; C1 and C2 re-perturbed by the orchestrator and watched failing). Measured read-only against freshpickedjobs three times
  as the target file moved under the task (68 brief / 69 at `b633c84` / 64 at `44acaf1` and again
  at `0427693`, the final build) — `git status --short` byte-identical before/after every call,
  `.repoboard/` absent throughout. `docs/AGENTS.md` §12 has the full table and the K-number list.
  Brief: `docs/P8.5-ARCHIVE-SYNC-BRIEF.md` §7.
- **P8.6 `logDir`: an extra daily-log source for `check`** (fpj STATE convergence, source
  `~/Projects/Repos/freshpickedjobs/docs/STATE-CONVERGENCE-BRIEF.md` locked decision 1).
  `board.yml: logDir: <path>`, optional, relative to the repo root (e.g. `docs/log`) — an
  ADDITIONAL directory of daily `<YYYY-MM-DD>.md` files that `repoboard check`'s `stale-state`
  reads alongside `.repoboard/log/` (both merged into the store's `loadAllLogInfo`); `repoboard
  log` remains the only writer, and it only ever writes `.repoboard/log/`. Absent `logDir` is
  byte-identical to before; a configured path that does not exist reads as empty, not an error.
  Lets a repo whose seats already keep their own daily log (fpj's `docs/log/`, headed
  `##### SEAT YYYY-MM-DD HH:MMZ: TITLE` — not ISO, so `newestMomentOf` falls back to the file's
  mtime) be seen by `check` without a second copy of the same text.

**Exit criterion for P8:** in freshpickedjobs, `repoboard init --practices` + `sync-issues
README.md#Known issues` produces a board with one card per open K-entry and no second copy of any
entry's text; `decide`, `lease take`, `window check` and `log` each round-trip through CLI, MCP and a
`sed` edit within 1 s on the dashboard; `repoboard check` exits 1 on a STATE older than the log and 0
after STATE is rewritten; every new surface's bytes are in `docs/AGENTS.md` alongside O3's table.

## §6 Repo layout
```
packages/core/      domain, I/O-free
packages/server/    cli (bin: repoboard), http, ws, watcher, scanner, mcp
packages/web/       vite app, built into packages/server/dist/web at build time
docs/               this plan, HANDOFF, AGENTS, briefs
.repoboard/         this repo dogfoods its own board
```

---

## §11 Owner decisions
Answered 2026-09-03:
- **O1 — name: `repoboard`.** npm package `repoboard`, bin `repoboard`. Rename lands in P6 and
  also renames the data directory `.rcb/` → `.repoboard/`, the default prefix `RCB` → `RB`, and
  every doc; the old names must not survive in user-facing text. (Directory and prefix names were the orchestrator's proposal;
  the owner accepted them 2026-09-03.)
- **O2 — GitHub: after v1.** The owner sets up the account/org. P6.3 stays closed until then;
  P6.1 and P6.2 do not depend on it.
- **O3 — docs steer to CLI first, MCP second, file edits as the escape hatch.** The owner's
  question was token efficiency; measured 2026-09-03 on the built binary, bytes on the wire
  (≈4 bytes per token):

  | Surface | Fixed cost | Per move | Per list |
  |---|---|---|---|
  | CLI via shell | AGENTS.md read once: 5.2 KB | command ~40 B + output 33 B | table 1.9 KB |
  | MCP | tool schema in context: 7.8 KB (every turn unless the harness defers it) | call ~80 B + result ~200 B | similar to table |
  | direct file edit | same AGENTS.md | `sed` ~60 B, **but** a correct move also bumps `updated` and appends a log line, or the activity signal is wrong (and K1) | n/a |

  So per operation the CLI is the cheapest by a wide margin and has no standing cost; MCP costs
  roughly 2,000 tokens of schema per turn where it is loaded and pays off only when the agent
  has no shell or its harness loads tool schemas on demand. Consequences: (a) `AGENTS.md` leads
  with the CLI; (b) CLI output stays terse — one line per mutation, table for list; (c) K6.

  Re-measured 2026-09-07 (the table above is left as the record of what the decision was made
  on): `AGENTS.md` 10.1 KB, MCP tool schema 8.6 KB for 7 tools, and on 31 cards the CLI table is
  2,529 B against `--json` 7,639 B. The MCP `list_cards` content is 7,638 B — within one byte of
  the CLI, which is K6's shared-formatter claim still holding. Both standing costs grew with the
  docs and the tool surface; the ranking and every consequence above are unchanged.
- **O4 — K5 (core ships TS source only): leave for v0.1, resolve before GitHub goes public.**
  Decided 2026-09-03. Core stays `private`; only `repoboard` publishes. Before the repo is made
  public, either build core to JS and publish `@repoboard/core`, or document it as internal.
  Gate on P6.3.
- **O5 — K7 pulled into v0.1 (2026-09-03).** The owner: "the repo should be looking at where all
  notes are being written so it is more directly pulling from the repo, more than agents having
  to fully write to cards." Measured state before O5: the board reads only `.repoboard/cards/`;
  the server serves no repo file content; the map reads files only for line counts and imports.
  Decision: cards get an optional `refs:` list; the drawer, `card show --resolve` and MCP
  `get_card` render the referenced lines live from the file. Agents point, they do not paste.
  Brief: `docs/K7-REFS-BRIEF.md`.

Answered 2026-09-07:
- **O6 — `review` stays in the default; the column set becomes editable in the app.** The owner
  first chose to delete `review` outright, then reversed it: "lets make it an option in the app
  itself since different users could have different use cases." So `defaultBoardConfig()` and §2
  are **unchanged** — `backlog, todo, doing, review, done` — and the fix for a column a user does
  not want is that they can remove it themselves, visibly, instead of the project picking for
  everyone. Measured basis: on this repo `review` took 14 cards and released 0 across the whole
  project (no card ever transited `review → done`; the 15 in Done arrived from `doing`) until the
  owner drained it on 2026-09-07 — HANDOFF §12.0l. That is an argument about *this* workflow, not
  about every workflow, which is why it changes the UI and not the default. Foundation already in
  place: `serializeBoard()` writes `board.yml` today (`cli.ts:143`), the store watches that file
  and reloads on change (`store.ts:461`), and a card whose `status` names no column already
  renders in a column marked `unconfigured: true` / "not in board.yml"
  (`packages/web/src/store.ts:297`, `Column.tsx:41`) — so removing a column cannot lose cards.
  Task P7.3.
- **O7 — repoboard points at any repo, and the map works without a board.** The owner: "we also
  need the ability to point this project at different projects to see what is in them and get the
  full usability. pointing at our own repo is just a test to get up and running." Decision for
  this round: `serve --root <dir>` plus **map-only mode** for a directory with no `.repoboard/`.
  Measured basis for why this is small: `scanner.ts` reads no `.repoboard/` path at all
  (**corrected 2026-09-07:** this entry first said its only core import is types; line 12 is a
  value import of `toIso`. It touches no disk, so the conclusion stands, but the stated fact was
  wrong — the implementing agent caught it), `loadConfig` already returns `defaultBoardConfig()` on ENOENT
  (`store.ts:326-328`) and `load()` already tolerates a missing cards directory (`:143-147`) — the
  server can already open a boardless repo; `requireRoot` (`cli.ts:95`) is what refuses. **Not in
  this round, deliberately:** multi-repo in one server with a UI switcher. `startServer` takes a
  single `store` and `http.ts` closes over `store.root` in four places (`:358`, `:385`, `:424`,
  `:526`), so that is a store registry, repo-scoped API paths and per-repo WS channels — revisit
  once `--root` has been used enough to say what the switcher should do. **Standing constraint
  this decision creates:** pointing at a directory is a read-only act. Nothing may be written
  into a target repo without the user explicitly asking, and CLAUDE.md non-negotiable 1 (the
  owner's Job Seeker repos are never written to, from any repo on this machine) now has a feature
  that could violate it by accident — every test for P7 uses a fixture repo it created itself.
  Tasks P7.1, P7.2. Brief: `docs/P7-REPOS-BRIEF.md`.
- **O8 — K9: the CLI gets `card update <id>`, not `--assign` on `card move`.** Decided
  2026-09-07; the owner picked the first of the two shapes RCB-31 offered. Rationale it settles:
  `update_card` (MCP) and `PATCH /api/cards/:id` (HTTP) already exist and already take
  title/assignee/priority/labels/files/refs, so the CLI is the odd surface out — the complaint in
  K9 — and `--assign` on `move` would have fixed only `assignee` while conflating two operations
  (a move is a status change; setting a field is not). Consequence: `card update` **mirrors the
  existing `CardPatch` semantics exactly and invents nothing** — a list flag replaces the list,
  status is refused with a pointer to `card move`, an empty patch is an error. The one thing the
  CLI must add is a way to say `null`, which a shell flag cannot carry; that is `--clear <field>`,
  and it is the only new concept in the change. Brief: `docs/K9-UPDATE-BRIEF.md`. Card: RCB-31.

Answered 2026-09-17:
- **O9 — P8 Practices: build all five tasks, in order P8.1 → P8.5, then adopt on freshpickedjobs.**
  The owner, after `REPOBOARD-FIT-ASSESSMENT.md` (letters F/G/H): "lets make all the improvements to
  repoboard then lets adopt it." Measured basis: that assessment's §1 table — the board solves queue
  visibility and embodies O5, and has no object for decisions, leases/windows, live state or the daily
  log, which freshpickedjobs had to build by hand on 2026-09-17. The four new record types are files
  under `.repoboard/` (0.3), written through core (0.4), core stays pure (0.5). **Standing constraint:**
  `sync-issues` and `init --practices` must never edit a file they did not create — a repo's README is
  read, never written.
- **O10 — decisions live on cards, not in a file; the owner picks the letter on the card.** The owner,
  2026-09-17 19:1xZ, forty minutes into the first P8.1 build: "i think the plan actually should be owner
  decisions where a decision is needed can be represented on the boards card with the ability to have
  the human user select what letter option if applicable right there." That build (a separate
  `decisions.jsonl` + Decisions tab) was stopped and discarded unmerged; P8.1 and its brief were
  rewritten. Consequences: no new record type (0.3 stays one directory of cards); P8.3's OWNER QUEUE is
  generated from `needs decision` cards; the dashboard's `needs decision` filter is the owner's agenda.
- **O11 — `review` leaves the default board; a `decide` column ("Needs decision") sits before `todo`
  and IS the owner's queue.** The owner, 2026-09-17 19:2xZ: "there was the outstanding review column
  issue I think we retire that column unless you see a purpose and it is replaced by a pre to do column
  for the user decisions needed column." Measured basis (O6): `review` took 14 cards and released 0 on
  its own; the owner drained it by hand on 09-07 and again on 09-08 (RCB-31/32/33/35, committed
  2026-09-17). The orchestrator's stated purpose for `review` ("built, awaiting the orchestrator's
  verification") is served by a `verified:` log line on the card while it stays in `doing`, and by the
  orchestrator moving it to `done`. Consequences: `defaultBoardConfig()` and §2 become
  `backlog, decide, todo, doing, done` with `decide: { title: "Needs decision", decision: true }`;
  P8.1's `card ask` MOVES the card into the first `decision: true` column (recording `returnTo`) and
  `card decide` moves it back to `returnTo` — the column is the agenda, so the `needs decision` FILTER
  is dropped (the badge and inline letters stay); a board with no `decision: true` column keeps the
  card where it is (the badge alone). O6's rule stands: anyone who wants `review` adds it to
  `board.yml`. This repo's own `board.yml` changes in the same commit; no card was in `review`.
