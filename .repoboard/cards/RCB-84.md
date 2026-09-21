---
id: RCB-84
title: "Board scroll: the whole card area scrolls, not each column (owner 2026-09-21 11:0x Pacific: 'the scrolling of the card area should be the whole area not column specific, that functionality makes things feel too tight'). Today .board is overflow-y: hidden (styles.css:510) and each .column__cards is overflow-y: auto (styles.css:620), so every column is a separate viewport-tall scroll box. Change: .board scrolls vertically as one surface (overflow-y: auto, keep overflow-x: auto for the horizontal column strip), .column__cards grows to its content (overflow visible, no min-height clamp), column heads may stick (position: sticky; top: 0) so the column name stays readable while the page scrolls. Check the drawer, the swimlanes (RCB-68 lane__head) and both boards at 844px and 1372px; the fpj board (?repo=freshpickedjobs, 100+ cards) is the one that shows it."
status: done
priority: high
size: S
labels:
  - web
files:
  - packages/web/src/styles.css
  - packages/web/src/views/Board.tsx
created: 2026-09-21T17:56:06Z
updated: 2026-09-21T18:01:07Z
---

## Log
- 2026-09-21T17:57:38Z builder — moved todo → doing
- 2026-09-21T18:01:07Z builder — moved doing → done
