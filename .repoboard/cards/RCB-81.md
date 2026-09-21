---
id: RCB-81
title: "vitest-lock.sh refuses take for a FUTURE lane window: lines 71-77 exit 3 whenever a window's END is ahead of now, ignoring START, so every repoboard take is refused from the moment ops arms (05:30Z) until the fire (13:30Z)"
status: doing
priority: high
size: S
labels:
  - scripts
files:
  - scripts/vitest-lock.sh
created: 2026-09-21T05:58:34Z
updated: 2026-09-21T18:25:40Z
---
Found 2026-09-21 05:56Z: `take` printed `lane window live: 2026-09-21T13:30:00Z 2026-09-21T13:50:00Z main` seven and a half hours before that window opened. Coordinator (01DAt8T7) diagnosis, confirmed by reading the script: the flat-file loop tests only `end > now`. Fix: copy the fpj shim arithmetic (packages/db/scripts/lane/vitest-lock-shim.sh, `lane_window_check`, read-only) — refuse iff `now + MIN*60 >= start` AND `now <= end`, with MIN = the suite lead in minutes (fpj uses FPJ_SUITE_MINUTES=20; ours runs ~1 min, so a `REPOBOARD_SUITE_MINUTES` default of 5 is enough). Keep the ISO string compare or switch to epoch seconds; either way the control is a line whose START is 2h ahead must NOT refuse, and one whose start is 3 min ahead MUST. Also: `take` must never be piped through `tail` in a brief — read `status` back after it (CLAUDE.md "verify by content").

## Log
- 2026-09-21T18:25:40Z repoboard builder — moved todo → doing
