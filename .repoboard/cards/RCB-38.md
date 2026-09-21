---
id: RCB-38
title: P8.3 STATE.md, daily log, init --practices, check
status: done
assignee: claude/p8-3
labels:
  - practices
refs:
  - docs/BUILD-PLAN.md@P8.3
created: 2026-09-17T19:03:42Z
updated: 2026-09-17T21:51:58Z
---

## Log
- 2026-09-17T20:59:13Z claude/orchestrator — moved todo → todo
- 2026-09-17T21:01:39Z claude/p8-3 — moved todo → doing
- 2026-09-17T21:01:39Z claude/p8-3 — updated assignee
- 2026-09-17T21:47:17Z claude/p8-3 — verified: core state.ts (parseState/renderState/setStateSection round-trip, generated OWNER QUEUE substituted only for display, on-disk placeholder never touched) + repolog.ts (formatLogBlock/appendLogBlock/parseLogBlocks, append-only) + checkFindings/exitCodeForFindings (stale-state via mtime-or-header whichever-later, active-without-lease warning-grade via new holdsLiveLease export, stale-lease error-grade, needs-decision info-only, cost-over-budget stubbed); store gains state()/setStateSection/appendRepoLog/log()/check() through two new guarded writers writeState/writeLog (K10 structural test extended 9->11 outcome methods, 3->5 disk writers) and a real watcher bug caught+fixed (STATE.md change never emitted 'state'); CLI state/state --set-section/log/log show/check + init --practices (never overwrites, kept/created per file); MCP get_state/set_state_section/append_repo_log/check, all <=700B (432/645/628/566), schema 14->18 tools 17,411B -> 19,682B; HTTP GET /api/state, PUT /api/state/section, GET+POST /api/log, GET /api/check, WS snapshot+state+log broadcast (store.clock getter fix for the fallback date); web StatePanel (collapsible, localStorage, OWNER QUEUE recomputed client-side from live cards not the wire snapshot, scrolls to decide column per orchestrator note 2, not a filter toggle) + LogTimeline beside Ticker (newest-first, details disclosure) - caught+fixed a real localStorage.getItem-not-a-function crash in this sandbox via read/write-level try/catch. pnpm test x2 (479/479 both), typecheck 0 (no any), lint 0, build OK (bundle 138.3 KB gzip JS / 5.1 KB CSS). C1/C2/C3 each perturbed, read back, typechecked, watched the named test fail in the feared direction, restored from a byte snapshot with diff empty; C3 also exposed a gap in my own CLI append test (didn't check the first block survived a second append), fixed. Full brief §7 log has details.
- 2026-09-17T21:51:58Z claude/orchestrator — moved doing → done
