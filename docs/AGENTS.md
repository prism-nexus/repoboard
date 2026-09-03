# AGENTS.md — the one page an agent needs for the `.repoboard/` board

## 1. What `.repoboard/` is

`.repoboard/` is this repository's Kanban board, stored as plain files: one markdown card per task in
`.repoboard/cards/<id>.md`, the columns in `.repoboard/board.yml`, and an optional append-only
`.repoboard/events.jsonl` that the dashboard's ticker reads. Every agent surface — the `repoboard`
CLI, the `repoboard mcp` server, and editing the file directly — writes the same files through the
same core code, so whichever you use, the others see it within a second. There is no database and
no registration step: a card is on the board when its file exists, and it is in a column when its
`status:` says so.

Use the surfaces in the order below. Measured 2026-09-03 (bytes on the wire, ≈4 bytes per token):
the CLI costs ~40 B in and 33 B out per move with no standing cost beyond reading this page once
(5.2 KB); MCP costs 7.8 KB of tool schema per turn where the harness loads it, ~80 B per call and
~200 B per result; a direct `sed` is ~60 B but a correct move also bumps `updated` and appends a
log line. The CLI is cheapest per operation; MCP pays off when you have no shell or your harness
loads schemas on demand; the file edit always works.

## 2. CLI (first choice)

`repoboard` is `packages/server/dist/cli.js` (run `pnpm build` once; `npx repoboard` once it is
published). It finds `.repoboard/` by walking up from the current directory.

| Command | Example |
|---|---|
| `repoboard init` | `repoboard init` — creates `.repoboard/` with the default board and card `RB-1 Welcome` |
| `repoboard card add "<title>" [--status s] [--assignee a] [--priority p] [--label l]... [--file f]... [--body md] [--as actor]` | `repoboard card add "Treemap view: files by size" --status todo --label web --as claude/web-agent` |
| `repoboard card move <id> <status> [--as actor]` | `repoboard card move RB-12 doing --as claude/web-agent` |
| `repoboard card list [--status s] [--json [--full]]` | `repoboard card list --status doing` |
| `repoboard card show <id>` | `repoboard card show RB-12` — prints the card file |
| `repoboard serve [--port 4242] [--open] [--no-fun]` | `repoboard serve --open` — the dashboard on 127.0.0.1 |
| `repoboard mcp [--root <dir>]` | `repoboard mcp` — the MCP server on stdio (section 3) |

`card list` prints a table by default. `--json` prints one compact row per line, without the body:
`{id, title, status, assignee, priority, labels, files, updated}`, absent scalars as `null`;
`--json --full` adds `body` and the rest of the frontmatter. On this repo's 27 cards that is
2.1 KB (table), 6.4 KB (`--json`), 16.8 KB (`--json --full`).

Exit codes: 0 ok, 1 user error (one line on stderr), 2 crash. `--as` defaults to `$REPOBOARD_ACTOR`,
then `$USER`, then `cli`. A move that exceeds a column's `wip:` prints a warning and still moves.
`move` sets the actor of the event, not the card's `assignee`; pass `--assignee` on `add`, or set
`assignee:` in the file, so the map knows whose card it is.

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
`update_card`, `append_log`, `board_summary`. Call `list_cards` or `board_summary` first: they
are cheap and return the column ids. `list_cards` takes optional `status`, `assignee`, `label`
filters (exact match, AND) and `full: true` to include bodies; without it, rows are the same
compact shape as the CLI's `--json` (6.4 KB vs 16.2 KB for `full` on this repo's 27 cards). A
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
- `status` must be a column `id` from `.repoboard/board.yml` (default board: `backlog`, `todo`,
  `doing`, `review`, `done`). `id` is `<prefix>-<n>`; the next `n` is max existing + 1.
- **Quote a title that contains a colon.** `title: P3.1 Board view: columns` is invalid YAML
  and the card turns red as "invalid" on the board; `title: "P3.1 Board view: columns"` is fine.
  The CLI and MCP quote for you; this bites only when you write frontmatter by hand (it hit 7 of
  the first 24 cards written on this repo). Colons in `id` or `status` do not occur.
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

> This repo has a `.repoboard/` board. Before starting a task, move its card to `doing` with your
> actor name; when done, move it to `review` and append what you verified.
> (`repoboard card move RB-12 doing --as claude/<role>` first; the `move_card` / `append_log` MCP
> tools if you have no shell; editing `.repoboard/cards/RB-12.md` by hand as a last resort —
> `docs/AGENTS.md` has the details.)
