---
id: RCB-89
title: "Cold-start bundle carries structured IN-FLIGHT and OWES fields: `seat --down` requires an `in-flight:` line (subagent ids, Monitor ids, worktree, lock holder — or `none`) and an `owes:` line; `seat <name>` prints the seat's last IN-FLIGHT/OWES first; `repoboard seat list` (today misparsed as a seat named 'list') prints every seat's status, stamp and in-flight. Why: sonnets, gates and Monitors outlive a pane /clear and successors find them by discovery (fpj ops ran two health watches 09-22 01:38–01:43Z; the fpj builder respawned or found live sonnets four times since 09-20); a stand-down committed late (fpj 410eb0f, 03:22Z with a 01:5xZ body) misled its successor on what was in flight. Touches core/seat.ts + cli.ts cmdSeat — AFTER RCB-88 lands, same region."
status: todo
assignee: repoboard builder
size: M
labels:
  - seat
  - cold-start
gate: RCB-88
created: 2026-09-22T03:34:28Z
updated: 2026-09-22T03:35:10Z
---

## Log
- 2026-09-22T03:35:10Z coordinator — moved backlog → todo
- 2026-09-22T03:35:10Z coordinator — updated assignee, gate
