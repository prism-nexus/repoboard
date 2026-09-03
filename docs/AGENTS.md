# AGENTS.md — the one page an agent needs for the `.repoboard/` board

## 1. What `.repoboard/` is

`.repoboard/` is this repository's Kanban board, stored as plain files: one markdown card per task in
`.repoboard/cards/<id>.md`, the columns in `.repoboard/board.yml`, and an optional append-only
`.repoboard/events.jsonl` that the dashboard's ticker reads. Every agent surface — editing the file
directly, the `repoboard` CLI, and the `repoboard mcp` server — writes the same files through the same core
code, so whichever you use, the others see it within a second. There is no database and no
registration step: a card is on the board when its file exists, and it is in a column when its
`status:` says so.

## 2. Card file format

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

## 3. CLI

`repoboard` is `packages/server/dist/cli.js` (run `pnpm build` once). It finds `.repoboard/` by walking up
from the current directory.

| Command | Example |
|---|---|
| `repoboard init` | `repoboard init` — creates `.repoboard/` with the default board and card `RB-1 Welcome` |
| `repoboard card add "<title>" [--status s] [--assignee a] [--priority p] [--label l]... [--file f]... [--body md] [--as actor]` | `repoboard card add "Treemap view: files by size" --status todo --label web --as claude/web-agent` |
| `repoboard card move <id> <status> [--as actor]` | `repoboard card move RB-12 doing --as claude/web-agent` |
| `repoboard card list [--status s] [--json]` | `repoboard card list --status doing` |
| `repoboard card show <id>` | `repoboard card show RB-12` — prints the card file |
| `repoboard serve [--port 4242] [--open] [--no-fun]` | `repoboard serve --open` — the dashboard on 127.0.0.1 |
| `repoboard mcp [--root <dir>]` | `repoboard mcp` — the MCP server on stdio (section 4) |

Exit codes: 0 ok, 1 user error (one line on stderr), 2 crash. `--as` defaults to `$REPOBOARD_ACTOR`,
then `$USER`, then `cli`. A move that exceeds a column's `wip:` prints a warning and still moves.

## 4. MCP registration

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
are cheap and return the column ids. A tool-level mistake (unknown card, unknown column, empty
patch) comes back as an error result naming the field; a WIP breach comes back as a warning
with the moved card. The tool actor defaults to `$REPOBOARD_ACTOR`, then `mcp`.

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

> This repo has an `.repoboard/` board. Before starting a task, move its card to `doing` with your
> actor name; when done, move it to `review` and append what you verified.
> (`repoboard card move RB-12 doing --as claude/<role>`, or the `move_card` / `append_log` MCP
> tools; `docs/AGENTS.md` has the details.)
