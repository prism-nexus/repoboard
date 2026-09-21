---
id: RCB-85
title: "Seats preview on the board (owner 2026-09-21 11:0x Pacific: 'seats should also have a preview of just what seats are currently live and active so it doesn't need to be opened to see additional information'). Today the SEATS section is a collapsed PanelRow in StatePanel.tsx:219 — the whole STATE.md section, opened by click. Change: the SEATS row's collapsed header carries a live strip — one chip per seat from the SEATS lines (name + UP/DOWN + the stamp's age, UP coloured, DOWN muted), parsed from the '- **<seat>: UP|DOWN <stamp>.**' bullet pattern that seat --up/--down writes; opening the row still shows the full bullets. Both boards (fpj's STATE.md has its own SEATS)."
status: done
priority: high
size: S
labels:
  - web
files:
  - packages/web/src/components/StatePanel.tsx
  - packages/web/src/styles.css
created: 2026-09-21T17:56:45Z
updated: 2026-09-21T18:08:26Z
---

## Log
- 2026-09-21T18:02:10Z builder — moved todo → doing
- 2026-09-21T18:08:26Z builder — moved doing → done
