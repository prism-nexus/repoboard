# AGENTS.md — the one page an agent needs for the `.repoboard/` board

## 1. What `.repoboard/` is

`.repoboard/` is this repository's Kanban board, stored as plain files: one markdown card per task in
`.repoboard/cards/<id>.md`, the columns in `.repoboard/board.yml`, and an optional append-only
`.repoboard/events.jsonl` that the dashboard's ticker reads. Every agent surface — the `repoboard`
CLI, the `repoboard mcp` server, and editing the file directly — writes the same files through the
same core code, so whichever you use, the others see it within a second. There is no database and
no registration step: a card is on the board when its file exists, and it is in a column when its
`status:` says so.

Use the surfaces in the order below. Per-operation costs measured 2026-09-03, standing costs
re-measured 2026-09-07 (bytes on the wire, ≈4 bytes per token): the CLI costs ~40 B in and 33 B
out per move with no standing cost beyond reading this page once (10.1 KB); MCP costs 8.6 KB of
tool schema per turn where the harness loads it, ~80 B per call and ~200 B per result; a direct
`sed` is ~60 B but a correct move also bumps `updated` and appends a log line. The CLI is
cheapest per operation; MCP pays off when you have no shell or your harness loads schemas on
demand; the file edit always works.

## 2. CLI (first choice)

`repoboard` is `packages/server/dist/cli.js` (run `pnpm build` once; `npx repoboard` once it is
published). It finds `.repoboard/` by walking up from the current directory.

| Command | Example |
|---|---|
| `repoboard init` | `repoboard init` — creates `.repoboard/` with the default board and card `RB-1 Welcome` |
| `repoboard card add "<title>" [--status s] [--assignee a] [--priority p] [--label l]... [--file f]... [--ref r]... [--body md] [--as actor]` | `repoboard card add "Treemap view: files by size" --status todo --label web --ref docs/BUILD-PLAN.md@P4.1 --as claude/web-agent` |
| `repoboard card move <id> <status> [--as actor]` | `repoboard card move RB-12 doing --as claude/web-agent` |
| `repoboard card update <id> [--title t] [--assignee a] [--priority p] [--label l]... [--file f]... [--ref r]... [--clear field]... [--as actor]` | `repoboard card update RB-12 --assignee claude/web-agent --priority high --as claude/web-agent` |
| `repoboard card list [--status s] [--json [--full]]` | `repoboard card list --status doing` |
| `repoboard card show <id> [--resolve]` | `repoboard card show RB-12` — prints the card file; `--resolve` appends each `refs:` target's live lines (section 4) |
| `repoboard serve [--port 4242] [--open] [--no-fun]` | `repoboard serve --open` — the dashboard on 127.0.0.1 |
| `repoboard mcp [--root <dir>]` | `repoboard mcp` — the MCP server on stdio (section 3) |

`card list` prints a table by default. `--json` prints one compact row per line, without the body:
`{id, title, status, assignee, priority, labels, files, updated}`, absent scalars as `null`;
`--json --full` adds `body` and the rest of the frontmatter. On this repo's 31 cards, measured
2026-09-07: 2,529 B (table), 7,639 B (`--json`), 20,758 B (`--json --full`). Ask for the table
unless you need to parse it, and for `--full` only when you actually need bodies.

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
  fields: `assignee`, `priority`, `labels`, `files`, `refs`. There is no `--clear title`: a card
  must have one. Naming a field with both a value and `--clear` is an error, not a precedence rule.
- **No `--status`.** It is refused with a pointer to `card move`; a move is a status change and
  setting a field is not.
- At least one field is required, and the command prints what changed —
  `updated RB-12 assignee, priority` — in the same order as the `## Log` line it wrote.

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
`update_card`, `append_log`, `board_summary`, `ask_owner`, `record_decision` (P8.1, section 8).
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
  `decide`, `todo`, `doing`, `done` — `decide` is the `decision: true` column §8 moves a card
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

## 7. Paste this into a CLAUDE.md

> This repo has a `.repoboard/` board. Before starting a task, move its card to `doing` and put
> your actor name on it as the assignee; when done, append_log what you verified (`review` is not
> in the default board — O11 — so unless this repo added it back, `doing` → `done` is the whole
> path). (`repoboard card move RB-12 doing --as claude/<role>` and
> `repoboard card update RB-12 --assignee claude/<role> --as claude/<role>` first; the `move_card`
> / `update_card` / `append_log` MCP tools if you have no shell; editing
> `.repoboard/cards/RB-12.md` by hand as a last resort — `docs/AGENTS.md` has the details.) If a
> task needs a human decision, `repoboard card ask RB-12 "<question>" --option "A <text>"...`
> instead of guessing or waiting on a chat relay — §8.

## 8. Decisions on cards (P8.1)

A card can carry one optional `decision:` block — the question, its options, and (once answered)
the owner's choice. **No separate file, no Decisions tab (O10):** the card *is* the decision, and
the board's `decide` column (`decision: true` in `board.yml`, O11) IS the owner's queue — a card
with an open decision moves there when asked and moves back to where it was when answered.
`decision.chosen !== null || decision.decidedAt !== null` means DECIDED; neither set means NEEDS
OWNER. **A DECIDED card is authority: read `decision.chosen`/`decision.words` yourself, do not
re-ask it and do not wait for a relay.**

```markdown
decision:
  question: "Ops cost: shrink the seat or retire it?"
  options:
    - letter: C1
      text: "waiter scripts into the repo, fuse counted as terminal"
    - letter: C2
      text: "K101 idle-OOM + K129(b) as builder items"
  askedBy: claude/coordinator
  askedAt: 2026-09-17T19:00:00Z
  returnTo: doing        # the column it was in when asked; decide moves it back here
  chosen: null           # a letter, once decided
  words: null            # the owner's text VERBATIM, optional
  decidedBy: null        # actor: web/owner, cli/<user>, mcp/<actor>
  decidedAt: null
```

`options` may be empty — a yes/no or free-text question, answered with `words` only.

### CLI

| Command | Example |
|---|---|
| `repoboard card ask <id> "<question>" [--option "A1 <text>"]... [--as a] [--replace]` | `repoboard card ask RCB-36 "sync-issues: which column?" --option "A todo" --option "B backlog"` → `asked RCB-36: sync-issues: which column? (2 options)` |
| `repoboard card decide <id> [<letter>] [--words "<verbatim>"] [--as a]` | `repoboard card decide RCB-36 A` → `decided RCB-36 A`; or `repoboard card decide RCB-36 --words "do it"` → `decided RCB-36 — "do it"` |
| `repoboard card list --needs-decision` | filters to cards with an OPEN decision; the table gains a `DECISION` column (a `?` marker) only when at least one listed card has one — see the bytes below |

Asking again on a card whose decision is OPEN is refused, naming the open question — pass
`--replace` to withdraw it and ask a new one. Asking again on a DECIDED card just replaces the
block (its `decided …` line is already in the `## Log`). `decide` refuses an unknown letter,
naming the valid ones, and refuses when nothing is open. On a board with a `decision: true`
column, `ask` moves the card there (recording `returnTo`) and `decide` moves it back — on a board
without one, both only touch the badge.

### MCP

`ask_owner(id, question, options?, replace?)` and `record_decision(id, letter?, words?)`, plus
`list_cards(needsDecision: true)` for the owner queue. `get_card` returns `decision` for free —
nothing extra to ask for.

### HTTP

`POST /api/cards/:id/ask` `{question, options?, replace?}`, `POST /api/cards/:id/decide`
`{letter?, words?}` — 200 with the card, 400 naming the bad field, 409 when the request conflicts
with the decision's own state (nothing open to decide; one already open to ask again without
`replace`). **`PATCH /api/cards/:id` refuses a `decision` field** with 400 ("use /ask and
/decide") — the only two writers of `decision` are `ask`/`decide`, so nothing can bypass the log
line that makes a decision auditable.

### Bytes (O3), measured on a 10-card fixture (6 plain, 4 with an open 3-option decision)

| Surface | Before P8.1 | After, 4/10 cards with a decision |
|---|---|---|
| `card list` (table) | unaffected — no `DECISION` column appears when no listed card has an open decision (measured: 6-plain-card table byte-identical to pre-P8.1 shape) | 533 B (10 rows, `DECISION` column added) |
| `card list --needs-decision` (table) | n/a (flag did not exist) | 245 B (4 rows) |
| `card list --json` | — | 1,447 B (10 rows) |
| one card file, plain | 110 B | — |
| one card file, with an open 3-option decision | — | 536 B (+426 B: the `decision:` block, its two extra `## Log` lines) |
| MCP tool schema | 8.6 KB for 7 tools (2026-09-07) | **14,546 B for 9 tools** (+5,946 B: `ask_owner` 2,191 B, `record_decision` 1,514 B, plus `needsDecision` growing `list_cards`' own description) |

So a decision costs roughly 400 B per card on disk and adds two tools' worth of schema to the MCP
standing cost; the CLI and file-edit paths carry no new standing cost at all, which is the same
ranking O3 already found and this does not change it.
