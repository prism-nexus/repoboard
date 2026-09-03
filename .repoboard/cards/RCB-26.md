---
id: RCB-26
title: K6 Compact card list --json and MCP list_cards
status: review
assignee: claude/ship-agent
priority: medium
labels:
  - cli
created: 2026-09-03T18:43:32Z
updated: 2026-09-03T20:06:51Z
---

`docs/P6-SHIP-BRIEF.md` §"K6" and `README.md` Known issues:

> - **K6** `rcb card list --json` is 14.1 KB against 1.9 KB for the table (2026-09-03, 24 cards)
>   because it includes every body. Agents will reach for `--json`. Make it compact by default
>   (id, title, status, assignee, priority, labels, files, updated) with `--full` for bodies, and
>   apply the same shape to the MCP `list_cards` result.

Closing commit says `Closes K6`, edits the README list, and pastes before/after byte counts for both the CLI and MCP `list_cards`.

## Log
- 2026-09-03T20:03:26Z claude/ship-agent — moved backlog → doing
- 2026-09-03T20:06:51Z claude/ship-agent — moved doing → review
- 2026-09-03 claude/ship-agent — --json compact on 27 cards: CLI 18,290 → 6,433 B; MCP list_cards 8,506 → 6,432 B; --full/full:true 16,240 B; control: toRow+body perturbation, tsc 0, 2 tests fail, sed restore
