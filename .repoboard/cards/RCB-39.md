---
id: RCB-39
title: "P8.4 repoboard cost: what a cold agent loads, with a budget"
status: done
assignee: claude/p8-4
labels:
  - practices
refs:
  - docs/BUILD-PLAN.md@P8.4
created: 2026-09-17T19:03:42Z
updated: 2026-09-17T22:25:01Z
---

## Log
- 2026-09-17T22:00:27Z claude/p8-4 — moved todo → doing
- 2026-09-17T22:00:27Z claude/p8-4 — updated assignee
- 2026-09-17T22:21:07Z claude/p8-4 — verified: core cost.ts (extractLinkedPaths backtick rule tested against a fpj CLAUDE.md fixture copied byte-identical, 11-path hand-written expectation matched extraction on first run; summarizeCost budget boundary `>` not `<=`; formatCostTable) + server cost.ts (gatherCost: stat/readFile through resolveRepoPath's K7 guard, CLAUDE.md/.claude/CLAUDE.md/CLAUDE.local.md + AGENTS.md/docs/AGENTS.md + linked paths deduped against root/agents, .mcp.json server names); store.cost()/check() wired (costFinding now takes a CostReport, error-grade); CLI `cost --root --budget --json` (board.yml claudeMdBudgetBytes fallback, CLI flag wins) + cold-context definition printed in --help; MCP `cost` tool 621 B (schema 18->19 tools, 19,682 B -> 20,303 B); HTTP GET /api/cost (pure read, always 200, budget=0 is 400); web CostTile+CostPanel on the Map view header (fetched via GET /api/cost, K7's useRefs pattern). Measured repoboard itself (111,875 B ≈27,969 tok, CLAUDE.md 5,563 OK) and freshpickedjobs read-only via --root (2,536,728 B ≈634,182 tok — 85% is docs/HANDOFF.md alone, CLAUDE.md itself 4,996 B OK against 8,192): `git -C .../freshpickedjobs status --short` empty before and after, proven by an automated CLI test hitting the real repo. pnpm test x2 (519/519 both), typecheck 0 (no any), lint 0, build OK (bundle 139.2 KB gzip JS / 5.3 KB CSS). C1 (`<=` instead of `>` on the OVER compare) / C2 (dropped the ".."/"..." segment guard) / C3 (gatherCost writes a cache file into the target root) each perturbed, read back, typechecked, watched the named test fail in the feared direction, restored from a byte snapshot with `diff` empty; C3's perturbation briefly wrote a real `.repoboard-cost-cache.json` into freshpickedjobs while proving the control — deleted immediately, `git status --short` confirmed clean again. Full brief §7 log has details.
- 2026-09-17T22:25:01Z claude/orchestrator — moved doing → done
