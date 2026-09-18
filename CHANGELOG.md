# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
