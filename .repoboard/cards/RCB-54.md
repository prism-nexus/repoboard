---
id: RCB-54
title: "`log --last <seat>` and `seat <name>` read only .repoboard/log/ — on a board with board.yml `logDir` (fpj: docs/log, 45 blocks 09-18) both print '(no log block for <seat>)'. Two causes (builder, 21:2xZ): store.lastRepoLogBlock reads its own dir only — should use loadAllLogInfo like `check` (P8.6); core parseLogBlocks' heading regex `^##### (\\S+) (\\S+): (.*)$` splits fpj's `2026-09-18 19:5xZ` on the space and never matches — widen the regex + a fixture from fpj's real header. First card for the FRESH repoboard builder."
status: done
assignee: builder
priority: high
labels:
  - web
  - dogfood
files:
  - docs/RCB-54-LOGDIR-BRIEF.md
  - packages/core/src/repolog.ts
  - packages/server/src/store.ts
created: 2026-09-18T21:15:41Z
updated: 2026-09-18T22:15:21Z
---

## Log
- 2026-09-18T21:16:05Z coordinator — moved backlog → todo
- 2026-09-18T21:16:48Z coordinator — updated title
- 2026-09-18T21:55:15Z builder — moved todo → doing
- 2026-09-18T21:55:15Z builder — updated assignee
- 2026-09-18T22:12:23Z builder — updated files
- 2026-09-18T22:15:21Z coordinator — moved doing → done
