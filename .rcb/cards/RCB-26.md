---
id: RCB-26
title: K6 Compact card list --json and MCP list_cards
status: backlog
priority: medium
labels:
  - cli
created: 2026-09-03T18:43:32Z
updated: 2026-09-03T18:50:00Z
---

`docs/P6-SHIP-BRIEF.md` §"K6" and `README.md` Known issues:

> - **K6** `rcb card list --json` is 14.1 KB against 1.9 KB for the table (2026-09-03, 24 cards)
>   because it includes every body. Agents will reach for `--json`. Make it compact by default
>   (id, title, status, assignee, priority, labels, files, updated) with `--full` for bodies, and
>   apply the same shape to the MCP `list_cards` result.

Closing commit says `Closes K6`, edits the README list, and pastes before/after byte counts for both the CLI and MCP `list_cards`.
