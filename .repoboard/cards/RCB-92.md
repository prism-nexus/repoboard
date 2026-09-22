---
id: RCB-92
title: "`repoboard state --trim-landings <n> [--as a]` keeps the n newest LAST LANDINGS entries and appends the rest verbatim as one `LAST LANDINGS archived` block to today's log (restamping STATE). Why: fpj's STATE.md is 37.8 KB with LAST LANDINGS at 38 entries / 30 KB never pruned — ≈9,500 tokens per cold seat for a 'one page' file whose live value is its top five. Touches core/state.ts (pure split of the section into entries — entries start at a line matching /^-?\\d+\\. \\*\\*/) + cli.ts cmdState + tests; NOT cmdSeat."
status: done
assignee: coordinator
size: S
labels:
  - state
  - cold-start
created: 2026-09-22T03:34:29Z
updated: 2026-09-22T04:01:30Z
---

## Log
- 2026-09-22T03:35:10Z coordinator — moved backlog → todo
- 2026-09-22T03:35:10Z coordinator — updated assignee
- 2026-09-22T03:39:28Z coordinator — moved todo → doing
- 2026-09-22T04:01:30Z coordinator — moved doing → done
