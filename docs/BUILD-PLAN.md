# BUILD-PLAN — the authority

**What this is.** A local-first dashboard you run inside any repo. It shows the repo as pictures
a human can read at a glance, and it shows work as cards on a Kanban board that move while agents
(Claude Code and friends) work on them. It ships to GitHub as an open-source utility.

**One-line pitch.** `npx rcb` in a repo → a browser tab with a live board and a live map of the
codebase. Agents move cards by editing files, running the CLI, or calling the MCP server. Humans
drag cards. Everything is plain files in git.

Working name: **rcb** (Remember · Connect · Build). The name is the owner's decision — §11 O1.

---

## §0 Ground rules

0.1 `CLAUDE.md` non-negotiables apply. This plan wins over HANDOFF when they disagree.
0.2 Local-first. No accounts, no telemetry, no network calls at runtime. The dashboard binds to
    localhost only.
0.3 **Plain files are the database.** Board state lives in the repo under `.rcb/`. Git is the
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
| D1 | **Cards are markdown files with YAML frontmatter** in `.rcb/cards/<id>.md`. One file per card. | Diffable, mergeable, agent-editable with zero tooling, readable on GitHub. |
| D2 | **Columns are configured in `.rcb/board.yml`**; `status` on a card is a column id. Default columns: `backlog, todo, doing, review, done`. | Teams differ; the default matches how the owner already works. |
| D3 | **Card ids are `<PREFIX>-<n>`**, prefix from `board.yml`, `n` monotonic, allocated by scanning existing ids (max+1). Default prefix `RCB`. | Matches the owner's `K<n>` habit. No counter file to merge-conflict. |
| D4 | **Three agent surfaces, one core:** direct file edit · CLI (`rcb card move RCB-3 doing`) · MCP server (`rcb mcp`). Plus HTTP for the web UI. | An agent that can only edit files still works. Claude Code gets a native tool. |
| D5 | **Stack:** TypeScript, Node ≥ 20, pnpm workspace. `packages/core` (domain), `packages/server` (CLI + HTTP + WS + watcher + MCP), `packages/web` (Vite + React + d3). Tests: vitest. Lint: biome. | Widest contributor pool for an OSS utility. d3 for treemap/graph. |
| D6 | **Live updates via a filesystem watcher (chokidar) → WebSocket.** The server never trusts its own memory as the source of truth; it re-reads the file on every change event. | An agent editing a file with `sed` shows up on the board in under a second, and the server cannot drift from disk. |
| D7 | **Repo visuals, in priority order:** (a) treemap of files by size, colored by language; (b) import graph for JS/TS (other languages: directory graph fallback); (c) git activity heat — commits per file over the last 30/90 days; (d) **"who is where"** — files listed on `doing` cards glow with the assignee's color. | (a)+(c) are language-agnostic and land first. (d) is the connection between board and code, which is the point. |
| D8 | **Agent identity is a free string on `assignee`** (e.g. `claude/web-agent`). Avatar = deterministic emoji + color hashed from the string. **"Active"** = card in a column with `active: true` in board.yml AND `updated` within `activeWindowMinutes` (default 30). | No registration step. Presence derives from the files, like everything else. |
| D9 | **Fun is a setting, defaulting on:** card slide animation, avatar bounce on move, confetti on `done`, activity ticker. `--no-fun` and a UI toggle turn them off. Never fun at the cost of readability. | "Utility meets fun." Readability wins ties. |
| D10 | **License MIT.** | Utility for folks to use. |
| D11 | No LLM in the product's own path. It is a viewer and a file editor; the agents bring the intelligence. | Keeps it deterministic, free, and offline. |

---

## §2 File formats (the contract agents see)

### `.rcb/board.yml`
```yaml
prefix: RCB
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

### `.rcb/cards/RCB-12.md`
```markdown
---
id: RCB-12
title: Treemap view of the repo
status: doing
assignee: claude/web-agent
priority: high          # high | medium | low, optional
labels: [web, viz]
files:
  - packages/web/src/views/Treemap.tsx
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

### `.rcb/events.jsonl` (optional, append-only)
One JSON object per line: `{ts, actor, type, cardId, from, to}`. Written by CLI/HTTP/MCP moves.
Direct file edits produce no event; the watcher synthesizes one from the diff (`actor: "file"`).
The ticker reads this. Safe to delete; safe to gitignore.

---

## §3 Wire contract (server ↔ web)

HTTP, JSON, localhost only:
- `GET /api/board` → `{ config, cards: Card[] }`
- `POST /api/cards` `{title, status?, ...}` → `Card`
- `PATCH /api/cards/:id` `{status?, assignee?, title?, ...}` → `Card`
- `GET /api/repo` → `RepoSnapshot` (§4)
- `GET /api/events?since=<ts>` → `Event[]`

WebSocket `/ws`, server → client:
- `{type:"snapshot", board, repo}` on connect
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
- **P2.1** CLI `rcb init` writes `.rcb/board.yml` and a first card; `rcb card add|move|list|show`;
  `rcb serve [--port] [--open] [--no-fun]`. Uses core for every mutation.
- **P2.2** Card store: reads `.rcb/cards/*.md`, chokidar watcher, atomic writes (temp + rename),
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
- **P5.1** `rcb mcp` — stdio MCP server exposing `list_cards`, `get_card`, `create_card`,
  `move_card`, `update_card`, `append_log`. Same core, same store. Tool descriptions written for
  an agent that has never seen the board.
- **P5.2** `docs/AGENTS.md` — the one page an agent (or a CLAUDE.md) needs: file format, CLI,
  MCP registration snippet for Claude Code, the `## Log` convention.

### P6 Ship
- **P6.1** README with a 20-second GIF, install (`npx rcb`), the thesis (files are the DB).
- **P6.2** `npx rcb` works from a fresh `npm pack` install; `bin` wiring verified.
- **P6.3** Owner decisions O1–O3 answered; GitHub repo created; v0.1.0 tagged. **Ask first.**

**Exit criterion for v0.1:** in a foreign repo, `npx rcb` opens a board; an agent with only a
shell moves a card with `sed` and the board updates within 1 s; the treemap renders; the card's
files glow with the agent's color.

---

## §6 Repo layout
```
packages/core/      domain, I/O-free
packages/server/    cli (bin: rcb), http, ws, watcher, scanner, mcp
packages/web/       vite app, built into packages/server/dist/web at build time
docs/               this plan, HANDOFF, AGENTS, briefs
.rcb/               this repo dogfoods its own board
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
- **O4 — K5 (core ships TS source only): leave for v0.1, resolve before GitHub goes public.**
  Decided 2026-09-03. Core stays `private`; only `repoboard` publishes. Before the repo is made
  public, either build core to JS and publish `@repoboard/core`, or document it as internal.
  Gate on P6.3.
