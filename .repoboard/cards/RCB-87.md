---
id: RCB-87
title: "seat --up does not refuse a second UP for a seat that is already UP: two sessions both answered to 'repoboard builder' 2026-09-21 22:36–22:37Z in one checkout, both took RCB-71, both wrote UP blocks and briefs into the same tree — the collision the rig forbids, and nothing in the tool noticed. Make `seat <name> --up` refuse (exit 1, prints the standing bullet + its stamp) when that seat's bullet already says UP and is younger than activeWindowMinutes; `--force` overrides, audited in the log. Same guard on the MCP seat_up if one exists."
status: todo
priority: medium
size: S
labels:
  - bug
refs:
  - .repoboard/local/log/2026-09-21.md
created: 2026-09-21T22:40:29Z
updated: 2026-09-21T22:40:29Z
---
