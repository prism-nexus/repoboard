---
id: RCB-86
title: "scripts/vitest-lock.sh ships this rig's defaults in the public tree: /tmp/fpj-vitest.lock (line 20), $HOME/Projects/Repos/freshpickedjobs (line 66), /tmp/fpj-lane-windows (line 80). Make them neutral (repoboard-named lock dir; no FPJ_ROOT default; lane-window check only when FPJ_LANE_WINDOWS is set) and set this rig's values in .repoboard/local/ (RIG.md documents them; a sourced env file the shim reads) — needs the fpj coordinator's word because fpj's shim shares the lock path (RCB-83 follow-up, 2026-09-21)"
status: backlog
priority: low
size: S
labels:
  - chore
created: 2026-09-21T22:37:47Z
updated: 2026-09-21T22:37:47Z
---
