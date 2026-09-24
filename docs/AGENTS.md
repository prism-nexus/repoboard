# AGENTS.md — the one page an agent needs for the `.repoboard/` board

## 1. What `.repoboard/` is

`.repoboard/` is this repository's Kanban board, stored as plain files: one markdown card per task in
`.repoboard/cards/<id>.md`, the columns in `.repoboard/board.yml`, and an optional append-only
`.repoboard/events.jsonl` that the dashboard's ticker reads. Every agent surface — the `repoboard`
CLI, the `repoboard mcp` server, and editing the file directly — writes the same files through the
same core code, so whichever you use, the others see it within a second. There is no database and
no registration step: a card is on the board when its file exists, and it is in a column when its
`status:` says so. `board.yml` may also carry an optional `name:` (RCB-41) — the repo's display
name in the top bar and browser tab title; absent means the served folder's name (`docs/BUILD-PLAN.md` §2).
It may also carry an optional `siblings: [{name, url}]` (RCB-42) — other running boards, shown as
plain top-bar links (each opens in a new tab; zero siblings shows nothing). `serve --sibling
<name>=<url>` (repeatable) adds more for that process only, on top of board.yml's own list; **on a
name collision the flag wins.** Both require an `http:`/`https:` url — nothing else is a valid link.

`.repoboard/systems.yml` is the one architecture model (plan docs/SYSTEMS-FLOW-PLAN.md §3.1) —
systems with kind/layer/env/pointers, connections, both environments, provenance on every row;
`repoboard systems` reads it (one line per system), `systems show <id>` resolves a row's pointers,
`systems detect` proposes rows (dry-run; `--apply` merges, a hand row always wins), `seat` prints
one Systems line, the Flow view draws it. Point, don't paste: never inline the file. →
docs/REFERENCE.md §7, §8.

Use the surfaces in the order below. Per-operation costs measured 2026-09-03, standing costs
re-measured 2026-09-22 (bytes on the wire, ≈4 bytes per token): the CLI costs ~40 B in and 33 B
out per move with no standing cost beyond reading this page once (20.9 KB); MCP
costs 22.2 KB (25 tools, 2026-09-24, RCB-137) of tool schema per turn where the harness loads it, ~80 B per call and
~200 B per result; a direct `sed` is ~60 B but a correct move also bumps `updated` and appends a
log line. The CLI is cheapest per operation; MCP pays off when you have no shell or your harness
loads schemas on demand; the file edit always works.

This page is for a seat working the maintainers' own board. An outside contributor to this repo
does not file cards here — see `CONTRIBUTING.md`.

## 2. CLI (first choice)

`repoboard` is `packages/server/dist/cli.js` (run `pnpm build` once; `npx repoboard` once it is
published). It finds `.repoboard/` by walking up from the current directory.

`repoboard` with no arguments prints the full usage for every command.

| Command | Example |
|---|---|
| `repoboard init [--practices]` | `repoboard init` — creates `.repoboard/` with the default board (docs/REFERENCE.md §6) |
| `repoboard card add "<title>" [--status s] [--assignee a] [--priority p] [--size S\|M\|L\|XL] [--label l]... [--file f]... [--ref r]... [--parent id] [--phase PH.n] [--gate id\|"sentence"] [--body md] [--as actor]` | `repoboard card add "Treemap view: files by size" --status todo --label web --ref docs/BUILD-PLAN.md@P4.1 --as claude/web-agent` |
| `repoboard card move <id> <status> [--as actor]` | `repoboard card move RB-12 doing --as claude/web-agent` |
| `repoboard card update <id> [--title t] [--assignee a] [--priority p] [--size S\|M\|L\|XL] [--label l]... [--file f]... [--ref r]... [--parent id] [--phase PH.n] [--gate id\|"sentence"] [--clear field]... [--as actor]` | `repoboard card update RB-12 --assignee claude/web-agent --priority high --as claude/web-agent` |
| `repoboard card list [--status s] [--json [--full]]` | `repoboard card list --status doing` |
| `repoboard card show <id> [--resolve]` | `repoboard card show RB-12` — `--resolve` adds `refs:` lines (section 4) |
| `repoboard card note <id> "<text>" [--as actor]` | `repoboard card note RB-12 "owner: ship it after the restart" --as owner` (RCB-70, docs/REFERENCE.md §6) |
| `repoboard columns [--json]` | `repoboard columns` — table `ID TITLE FLAGS COUNT`; `--json` prints the raw list |
| `repoboard columns set (--stdin \| "<text>") [--as actor]` | `repoboard columns set --stdin < new-columns.yml` — replaces the whole column list (docs/REFERENCE.md §6) |
| `repoboard state [--set-section s (<text>\|--stdin)]` | `repoboard state` — prints the rendered STATE.md (docs/REFERENCE.md §3) |
| `repoboard log --as <seat> [--title t] (<text>\|--stdin)` / `log show [--date d] [--seat s]` / `log --last <seat>` | `repoboard log --as claude/ops "armed the fires"` (docs/REFERENCE.md §3) |
| `repoboard seat <name> [--json]` | `repoboard seat claude/builder` — the cold-start bundle (docs/REFERENCE.md §3, §6) |
| `repoboard check [--json] [--strict]` | `repoboard check` — exit 0 `ok`, or 1 with findings (docs/REFERENCE.md §3) |
| `repoboard cost [--root <dir>] [--budget <bytes>] [--json]` | `repoboard cost --root /path/to/other/repo` — "cold context" bytes vs budget (docs/REFERENCE.md §4, §6) |
| `repoboard systems [--json]` | `repoboard systems` — one line per system (docs/REFERENCE.md §7) |
| `repoboard systems show <id> [--json]` | `repoboard systems show repoboard` — resolves the row's pointers (docs/REFERENCE.md §7) |
| `repoboard systems detect [--root <dir>] [--apply] [--json]` | `repoboard systems detect --apply` — proposes rows, dry-run by default (docs/REFERENCE.md §7) |
| `repoboard serve [--root <dir>]... [--port 4242] [--open] [--no-fun] [--watch-cap 20000] [--sibling <name>=<url>]...` | `repoboard serve --open` — the dashboard on 127.0.0.1 (docs/REFERENCE.md §6) |
| `repoboard mcp [--root <dir>]` | `repoboard mcp` — the MCP server on stdio (section 3) |

`log` has three forms: append (`log --as <seat> [--title t] (<text>|--stdin)`), read one
day (`log show [--date d] [--seat s]`), and cold-start read (`log --last <seat>`, the seat a
positional after the flag). The grammar is kept as is through 0.x; unifying it is a post-1.0
change.

`systems show <id>` resolves every pointer's text — 33,770 B for a 4-pointer row; run `systems`
(631 B) first.

Server internals (watcher, multi-root routes, the web's repo select): docs/REFERENCE.md §6.

`card list` prints a table by default. `--json` prints one compact row per line, without the body:
`{id, title, status, assignee, priority, size, labels, files, parent, phase, gate, blocked, updated}`,
absent scalars as `null`; `--json --full` adds `body` and the rest of the frontmatter. Ask for the
table unless you need to parse it, and for `--full` only when you actually need bodies.

Exit codes: 0 ok, 1 user error (one line on stderr), 2 crash. `--as` defaults to `$REPOBOARD_ACTOR`,
then `$USER`, then `cli`. A move that exceeds a column's `wip:` prints a warning and still moves.
`move` sets the actor of the event, not the card's `assignee`; pass `--assignee` on `add`, or
`repoboard card update <id> --assignee <you>` afterwards, so the map knows whose card it is. Do
not hand-edit the frontmatter for this — `card update` writes the `## Log` line and the event too.

`card update` is `updateCard` (`packages/core/src/transitions.ts`), the same code MCP `update_card`
and `PATCH /api/cards/:id` go through, so all three surfaces mean the same thing:

- A repeatable flag **replaces** the whole list, it never appends: `--label a --label b` leaves
  exactly `[a, b]`, whatever was there before.
- **`--clear <field>`** is how the shell says the `null` that MCP and HTTP send as JSON. Valid
  fields: `assignee`, `priority`, `size`, `labels`, `files`, `refs`, `parent`, `phase`, `gate`. There is no
  `--clear title`: a card must have one. Naming a field with both a value and `--clear` is an
  error, not a precedence rule.
- **No `--status`.** It is refused with a pointer to `card move`; a move is a status change and
  setting a field is not.
- At least one field is required, and the command prints what changed —
  `updated RB-12 assignee, priority` — in the same order as the `## Log` line it wrote.

**Phases and gates (RCB-68).** Three optional fields, no new card kind: `parent: <card id>` makes
a card a STEP of that phase card; `phase: PH.<n>` (a free short label, sorted naturally) marks
which step; `gate: <card id> | "<sentence>"` names what blocks it. A card-id gate clears itself
once that card reaches a `done: true` column or is decided; an id-shaped gate naming no card is
BLOCKED, never a silent clear; a sentence gate is cleared only by hand (`--clear gate`). Any card
with children is a phase card: `card list`/`list_cards` show `blocked`, and its rollup (`n/m
done`) is computed live, never stored.

## 3. MCP (when you have no shell)

Claude Code, one command (project scope, so teammates get it from `.mcp.json`):

```sh
claude mcp add repoboard -- npx repoboard mcp
```

From a checkout of this repo before it is on npm, point at the built CLI instead:

```sh
claude mcp add repoboard -- node /absolute/path/to/packages/server/dist/cli.js mcp --root /absolute/path/to/repo
```

The same thing as a `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "repoboard": {
      "command": "npx",
      "args": ["repoboard", "mcp"],
      "env": { "REPOBOARD_ACTOR": "claude/dev" }
    }
  }
}
```

The server finds `.repoboard/` by walking up from its working directory; pass `--root <dir>` when it is
launched from somewhere else. Tools: `list_cards`, `get_card`, `create_card`, `move_card`,
`update_card`, `append_log`, `add_note` (RCB-70, section 6), `board_summary`, `set_columns`
(RCB-56, section 2 — the whole-list replace behind `repoboard columns set` / `PATCH /api/board`),
`ask_owner`, `record_decision`
(P8.1, docs/REFERENCE.md §1), `take_lease`, `release_lease`, `list_leases`, `add_window`, `check_window`
(P8.2, docs/REFERENCE.md §2),
`get_state`, `set_state_section`, `append_repo_log`, `check` (P8.3, docs/REFERENCE.md §3),
`cost` (P8.4, docs/REFERENCE.md §4), `list_systems`, `get_system` (RCB-97, docs/REFERENCE.md §7),
`archive_cards`, `sync_issues` (P8.5, docs/REFERENCE.md §5).
All 25 tools' schema, via client.listTools() summing each tool's own JSON.stringify: **22,769 B** (this repo's board, seat re-measure)
(2026-09-24, RCB-137: CARD_INTRO moved out of tool descriptions into the server instructions alone; was
31,301 B, 2026-09-22, RCB-100; before that 26,401 B for 23 tools, RCB-70).
Call `list_cards` or `board_summary` first: they
are cheap and return the column ids. `list_cards` takes optional `status`, `assignee`, `label`
filters (exact match, AND) and `full: true` to include bodies; without it, rows are the same
compact shape as the CLI's `--json` — byte-for-byte the same formatter: on this repo's 31 cards
the `list_cards` content is 7,638 B against the CLI's 7,639 B, and 20,757 B with `full: true`
(measured 2026-09-07). A
tool-level mistake (unknown card, unknown column, empty patch) comes back as an error result
naming the field; a WIP breach comes back as a warning with the moved card. The tool actor
defaults to `$REPOBOARD_ACTOR`, then `mcp`.

## 4. `refs:` — point, don't paste

A card can carry `refs:`, a list of pointers into files in the repo. Every surface renders the
referenced lines **live from the file** — the drawer (References, under the description),
`repoboard card show <id> --resolve`, and the MCP `get_card` tool with `resolveRefs: true` —
nothing is cached, so the file stays the only copy. Write the note where it lives (the plan, a
brief, a source file) and reference it from the card; do not quote it into the body.

| Form | Means | Span |
|---|---|---|
| `docs/BUILD-PLAN.md#§11 Owner decisions` | the first heading whose text starts with that (case, spacing and `#` ignored) | to the line before the next heading of the same or higher level |
| `docs/BUILD-PLAN.md@P6.2` | the first list item or paragraph line that starts with the token, after `- ` and `**` | to the line before the next blank line, heading, or list item at the same or lesser indent |
| `packages/web/src/store.ts:L10-L20` | 1-based inclusive lines; `:L10` is one line | exactly those lines |
| `README.md` | the whole file | all lines |

Caps: 200 lines or 16 KB per ref, whichever comes first (`truncated: true` says so). A ref that
does not resolve — heading or token not found, range past the end, file missing, binary, over
2 MB, or a path that is absolute, contains `..`, is under `.git/`, or leaves the repo through a
symlink — comes back as `text: null` with an `error` string, never a guess. Paths are
repo-relative. Set it with `card add --ref <spec>` (repeatable), `refs` on the MCP
`create_card` / `update_card` tools, or `refs:` in the file.

## 5. Editing the file directly (the escape hatch)

The card file is the source of truth, so `sed`, an editor, or a heredoc all work; the watcher
picks the change up and synthesizes an event with `actor: file`. Do three things the CLI would
have done for you: set `status:`, bump `updated:`, and append a `## Log` line (section 6).

You get exactly one ticker entry either way (K8): the watcher synthesizes an event only for a
change no surface claimed in `events.jsonl`, so a CLI or MCP move is reported once under its own
actor, and your hand edit is reported once as `file`. You do not need to write to
`events.jsonl` yourself, and you should not.

```markdown
---
id: RB-12
title: "Treemap view: files by size"
status: doing
assignee: claude/web-agent
priority: high          # high | medium | low, optional
labels: [web, viz]
files:
  - packages/web/src/views/Treemap.tsx
refs:
  - docs/BUILD-PLAN.md@P4.1   # optional, rendered live (section 4)
created: 2026-09-02T22:00:00Z
updated: 2026-09-02T22:41:10Z
---

Description in markdown. Agents append notes below a `## Log` heading; humans write wherever.

## Log
- 2026-09-02T22:41:10Z claude/web-agent — moved todo → doing
```

Rules:
- `id`, `title`, `status`, `created`, `updated` are required; everything else is optional.
- `status` must be a column `id` from `.repoboard/board.yml` (default board, O11: `backlog`,
  `decide`, `todo`, `doing`, `done` — `decide` is the `decision: true` column docs/REFERENCE.md §1 moves a card
  into when its question is asked). `id` is `<prefix>-<n>`; the next `n` is max existing + 1.
- **Quote a title that contains a colon.** `title: "P3.1 Board view: columns"`. Unquoted, that
  line is not valid YAML; since 2026-09-06 the parser recovers it by quoting the `title:` value
  and retrying once (K1(b)), and the next write through any surface stores it quoted — so the
  card is no longer red, but do not rely on it. The recovery runs only after a parse has already
  failed and it can only guess: a trailing `# comment` on an unquoted title line becomes part of
  the title. A colon in any *other* value is still an error, and still points at the real line.
  Colons in `id` or `status` do not occur.
- Unknown frontmatter keys are kept on round-trip. The body is preserved byte-for-byte except
  when a surface appends under `## Log`.
- Timestamps are ISO 8601 UTC with seconds, as above.
- `refs:` are pointers into repo files (section 4); every surface renders those lines live.
- `files:` are repo-relative paths; while the card is in an `active` column and `updated` is
  within `activeWindowMinutes`, they glow with the assignee's color on the map.

## 6. The `## Log` convention

Every surface appends the same shape under the card's `## Log` heading, one bullet per event,
newest last:

```
- <ISO timestamp> <actor> — <what happened>
```

`move` writes `moved <from> → <to>`, `update` writes `updated <fields>`, and `append_log` (MCP)
writes your text. When you edit a file by hand, add the same line yourself. Write the actor as
`<tool>/<role>` — `claude/web-agent`, `claude/mcp-agent`, `codex/reviewer` — and keep it
identical across calls: the board's avatar (emoji + color) is a hash of the exact string, so
`claude/web-agent` and `Claude/web-agent` are two different people.

### `## Notes` (RCB-70)

Same line shape as `## Log` — `- <ISO timestamp> <actor> — <text>`, a multi-line note's later
lines indented two spaces as a markdown list continuation. Its four writers are `repoboard card
note <id> "<text>" [--as a]`, the MCP `add_note` tool, `POST /api/cards/:id/notes {text,
actor?}`, and the drawer's notes box. Appended only, never rewritten; created immediately before
`## Log` when a card gets its first note and already has a `## Log` section, else at the end. A
note is a durable remark meant to stay on the card — a decision rationale, an owner's
instruction — where a `## Log` line is what happened; `card note`/`add_note`/the HTTP route write
NO `## Log` line, so the same event is never recorded twice.

## 7. Paste this into a CLAUDE.md

> This repo has a `.repoboard/` board. Before starting a task, move its card to `doing` and put
> your actor name on it as the assignee; when done, append_log what you verified (`review` is not
> in the default board — O11 — so unless this repo added it back, `doing` → `done` is the whole
> path). (`repoboard card move RB-12 doing --as builder` and
> `repoboard card update RB-12 --assignee builder --as builder` first; the `move_card`
> / `update_card` / `append_log` MCP tools if you have no shell; editing
> `.repoboard/cards/RB-12.md` by hand as a last resort — `docs/AGENTS.md` has the details.) If a
> task needs a human decision, `repoboard card ask RB-12 "<question>" --option "A <text>"...`
> instead of guessing or waiting on a chat relay — docs/REFERENCE.md §1. If you dispatch
> subagents, `docs/SUBAGENTS.md` is the brief-and-control practice this board expects.
> Architecture: `.repoboard/systems.yml` — `repoboard systems` lists it, `repoboard systems show
> <id>` resolves a system's pointers; don't paste the file.

## 8. Everything else

**Cold-start rule (RCB-47/RCB-48):** a seat coming up runs `repoboard seat <name>` — one command
prints its SEATS line, its own last log block, the coordinator's, its next todo card and the open
decisions, in that order. The underlying reads stay available one at a time: `repoboard state`,
`log --last <seat>`, `card list --status todo`, `card list --needs-decision`.

STATE shape rules (RCB-55 A3 + A5, owner's letter A, 2026-09-18): **LIVE holds slow-changing facts
only** — ports and what each serves, the remote, the owner lane, the sibling — never a queue or a
per-landing status (the queue is the board, landings are LAST LANDINGS, seat status is SEATS).
**A SEATS bullet is ≤ 3 lines**: `UP/DOWN <stamp>`, what the seat holds (lease + card), where its
last block is. Anything else goes in the seat's log block. A seat restamps its own with
`repoboard seat <name> --up|--down`.

Everything below is wire shapes, byte tables and RCB-nn history — read the matching
`docs/REFERENCE.md` section only when a card sends you there:

- Decisions on cards — `card ask`/`card decide`, the `decision:` block, owner tasks (P8.1) —
  docs/REFERENCE.md §1
- Leases and windows — `lease take/release/list`, `window add/list/check` (P8.2) —
  docs/REFERENCE.md §2
- State, log, check — the full command table and `repoboard check`'s findings (P8.3) —
  docs/REFERENCE.md §3
- Cost — what a cold agent loads, against a budget (P8.4) — docs/REFERENCE.md §4
- Archive and issue sync — `repoboard archive`, `repoboard sync-issues` (P8.5) —
  docs/REFERENCE.md §5
- Systems and the Flow view — `systems`, `systems show`, `systems detect`, the seat line, `check`'s
  two findings (RCB-95–99) — docs/REFERENCE.md §7, §8

## 9. Your local setup

`repoboard local init [--remote <url>]` (RCB-83) makes `.repoboard/local/` — a second git repo,
gitignored by the tool itself (the exact line `.repoboard/local/` in the root `.gitignore`), for
the facts that are true of THIS machine and must never ship in the public repo. It scaffolds
`RIG.md` with one heading per fact this rig needs a seat to know cold:

- `## Build` — how to build, typecheck and test here
- `## Ports` — what this rig binds, and what serves each one
- `## Locks` — lock files / lease resource names this rig uses
- `## Seat names` — the seat names in use here, one per terminal
- `## Other repos on this machine` — read-only unless a heading says otherwise

Add a tracked detail by adding a heading (or a line under one) to `RIG.md` — it is a plain file,
edited like any other. `repoboard seat <name>` prints it under `## Rig (.repoboard/local/RIG.md)`,
right after the SEATS line, so a cold seat gets its rig facts in the same command as everything
else.

`--remote <url>` points `origin` at a private backup — once set, every `seat --up/--down` and
`log` sync `.repoboard/local/` automatically (commit, then push; a push failure warns and moves
on, it never blocks the write that triggered it). Run `repoboard local sync [-m "<msg>"]` by hand
any time, and `repoboard local status` for a one-line read. `repoboard check` watches it the same
way it watches leases: `local-unsynced` (warning) for uncommitted changes or unpushed commits,
`local-no-remote` (informational) when there is no backup configured yet.

The running record follows the layer. Once `.repoboard/local/` exists, `STATE.md` is read and
written at `.repoboard/local/STATE.md` and new log blocks go to `.repoboard/local/log/`, so
`repoboard local init` moves an existing top-level `STATE.md` and `log/` in (a rename, printed as
`moved …`) rather than leaving them behind unread. In the parent repo they then show as deletions
to commit. Log reads still merge whatever is left in `.repoboard/log/`, so nothing already
written is lost.
