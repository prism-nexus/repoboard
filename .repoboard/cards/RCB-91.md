---
id: RCB-91
title: "`repoboard cost` lists a CLAUDE.md-linked file as `frozen` and leaves it out of the total when the CLAUDE.md line that links it carries the word FROZEN. Why: fpj's cost table counts docs/HANDOFF.md at 2.15 MB (≈538k tokens) of a 2.52 MB total although CLAUDE.md says it is frozen history read a § at a time; the meter overstates the cold load 6×. Touches core/cost.ts (extractLinkedPaths gains the frozen flag, summarizeCost the separate line) + server/cost.ts + tests."
status: done
assignee: coordinator
size: S
labels:
  - cost
  - cold-start
created: 2026-09-22T03:34:29Z
updated: 2026-09-22T03:58:08Z
---

## Log
- 2026-09-22T03:35:09Z coordinator — moved backlog → todo
- 2026-09-22T03:35:09Z coordinator — updated assignee
- 2026-09-22T03:39:28Z coordinator — moved todo → doing
- 2026-09-22T03:58:08Z coordinator — moved doing → done
