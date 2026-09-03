# AGENTS.md — the one page an agent needs for the `.rcb/` board

## 1. What `.rcb/` is

`.rcb/` is this repository's Kanban board, stored as plain files: one markdown card per task in
`.rcb/cards/<id>.md`, the columns in `.rcb/board.yml`, and an optional append-only
`.rcb/events.jsonl` that the dashboard's ticker reads. Every agent surface — editing the file
directly, the `rcb` CLI, and the `rcb mcp` server — writes the same files through the same core
code, so whichever you use, the others see it within a second. There is no database and no
registration step: a card is on the board when its file exists, and it is in a column when its
`status:` says so.

## 2. Card file format

```markdown
---
id: RCB-12
title: "Treemap view: files by size"
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
- 2026-09-02T22:41:10Z claude/web-agent — moved todo → doing
```

Rules:
- `id`, `title`, `status`, `created`, `updated` are required; everything else is optional.
- `status` must be a column `id` from `.rcb/board.yml` (default board: `backlog`, `todo`,
  `doing`, `review`, `done`). `id` is `<prefix>-<n>`; the next `n` is max existing + 1.
- **Quote a title that contains a colon.** `title: P3.1 Board view: columns` is invalid YAML
  and the card turns red as "invalid" on the board; `title: "P3.1 Board view: columns"` is fine.
  The CLI and MCP quote for you; this bites only when you write frontmatter by hand (it hit 7 of
  the first 24 cards written on this repo). Colons in `id` or `status` do not occur.
- Unknown frontmatter keys are kept on round-trip. The body is preserved byte-for-byte except
  when a surface appends under `## Log`.
- Timestamps are ISO 8601 UTC with seconds, as above.

## 3. CLI

`rcb` is `packages/server/dist/cli.js` (run `pnpm build` once). It finds `.rcb/` by walking up
from the current directory.

| Command | Example |
|---|---|
| `rcb init` | `rcb init` — creates `.rcb/` with the default board and card `RCB-1 Welcome` |
| `rcb card add "<title>" [--status s] [--assignee a] [--priority p] [--label l]... [--file f]... [--body md] [--as actor]` | `rcb card add "Treemap view: files by size" --status todo --label web --as claude/web-agent` |
| `rcb card move <id> <status> [--as actor]` | `rcb card move RCB-12 doing --as claude/web-agent` |
| `rcb card list [--status s] [--json]` | `rcb card list --status doing` |
| `rcb card show <id>` | `rcb card show RCB-12` — prints the card file |
| `rcb serve [--port 4242] [--open] [--no-fun]` | `rcb serve --open` — the dashboard on 127.0.0.1 |
| `rcb mcp [--root <dir>]` | `rcb mcp` — the MCP server on stdio (section 4) |

Exit codes: 0 ok, 1 user error (one line on stderr), 2 crash. `--as` defaults to `$RCB_ACTOR`,
then `$USER`, then `cli`. A move that exceeds a column's `wip:` prints a warning and still moves.

## 4. MCP registration

Claude Code, one command (project scope, so teammates get it from `.mcp.json`):

```sh
claude mcp add rcb -- npx rcb mcp
```

From a checkout of this repo before it is on npm, point at the built CLI instead:

```sh
claude mcp add rcb -- node /absolute/path/to/packages/server/dist/cli.js mcp --root /absolute/path/to/repo
```

The same thing as a `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "rcb": {
      "command": "npx",
      "args": ["rcb", "mcp"],
      "env": { "RCB_ACTOR": "claude/dev" }
    }
  }
}
```

The server finds `.rcb/` by walking up from its working directory; pass `--root <dir>` when it is
launched from somewhere else. Tools: `list_cards`, `get_card`, `create_card`, `move_card`,
`update_card`, `append_log`, `board_summary`. Call `list_cards` or `board_summary` first: they
are cheap and return the column ids. A tool-level mistake (unknown card, unknown column, empty
patch) comes back as an error result naming the field; a WIP breach comes back as a warning
with the moved card. The tool actor defaults to `$RCB_ACTOR`, then `mcp`.

## 5. The `## Log` convention

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

## 6. Paste this into a CLAUDE.md

> This repo has an `.rcb/` board. Before starting a task, move its card to `doing` with your
> actor name; when done, move it to `review` and append what you verified.
> (`rcb card move RCB-12 doing --as claude/<role>`, or the `move_card` / `append_log` MCP
> tools; `docs/AGENTS.md` has the details.)
