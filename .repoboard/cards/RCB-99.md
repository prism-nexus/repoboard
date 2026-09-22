---
id: RCB-99
title: "PH.5 Dogfood: repoboard's own systems.yml (hand + detect); read-only detect report on freshpickedjobs handed to the owner, nothing written there"
status: done
assignee: repoboard builder
size: M
refs:
  - docs/SYSTEMS-FLOW-PLAN.md#§5 Measurements before and while building
parent: RCB-80
phase: PH.5
gate: RCB-98
created: 2026-09-22T03:53:07Z
updated: 2026-09-22T08:54:54Z
---

## Notes
- 2026-09-22T08:43:23Z repoboard builder — Pre-measured 2026-09-22 08:5xZ, nothing applied: repoboard dry run 3 systems / 0 conn / 2 unclassified; fpj READ-ONLY dry run 14 / 13 / 7, ≈3 hand corrections (hyperdrive=postgres, hasher dup, DO bindings undetected). cost before 84866 B, seat before 9740 B. Numbers + owner report: .repoboard/local/reports/ (RCB-99-premeasure-2026-09-22.md, fpj-systems-detect-2026-09-22.txt). Successor: brief a sonnet for this repo's systems.yml (hand + detect --apply HERE only; prod = none), then re-measure cost/seat/check.
- 2026-09-22T08:54:53Z repoboard builder — Landed fba9e3a — systems.yml 2693 B (5 hand rows, 3 conn, prod none), detect --apply 0/0/3, dogfood test 5/5 with two verified controls; cost 84866→87559 B; seat 9740→8529 B (Systems line 69→66 B — the commit message says 68→63, plan §5 has the measured numbers); fpj READ-ONLY report for the owner: .repoboard/local/reports/fpj-systems-detect-2026-09-22.txt (14/13/7, ≈3 corrections). K15 filed (detect env on prod-none). Gate 1241|4 ×3 of 4 (run 2: 1 unnamed failure, watcher-flake pattern), typecheck/lint/build 0.

## Log
- 2026-09-22T08:45:32Z hometown — moved backlog → doing
- 2026-09-22T08:45:43Z hometown — updated assignee
- 2026-09-22T08:54:54Z hometown — moved doing → done
