---
id: RCB-37
title: "P8.2 Leases and windows: leases.yml, lease/window CLI, window check exit code, Now strip"
status: doing
assignee: claude/p8-2
labels:
  - practices
refs:
  - docs/BUILD-PLAN.md@P8.2
created: 2026-09-17T19:03:42Z
updated: 2026-09-17T20:54:40Z
---

## Log
- 2026-09-17T20:09:06Z claude/orchestrator — moved todo → todo
- 2026-09-17T20:11:56Z claude/p8-2 — moved todo → doing
- 2026-09-17T20:11:56Z claude/p8-2 — updated assignee
- 2026-09-17T20:54:40Z claude/p8-2 — verified: core leases.ts (parse/serialize, takeLease/releaseLease/addWindow, pruneWindows on-write-only, checkResource, staleLeases/isStale, resolveTimeSpec) + Event widened with lease|window; store take/release/addWindow/checkResource/leases() funnel through the two guarded writers (K10 structural test updated); CLI `lease take|release|list`, `window add|list|check` (ISO or +90m/+2h); MCP take_lease/release_lease/list_leases/add_window/check_window, all <=700 B (691/509/400/630/645), schema 9->14 tools 14,546 B -> 17,411 B; HTTP GET /api/leases, POST take/release/windows, GET /api/leases/check/:resource, WS snapshot+leases broadcast; web Now strip under TopBar on every view. pnpm test x2 (383/383 both), typecheck 0, lint 0, build OK (bundle 137.1 KB gzip JS / 4.7 KB CSS). C1 (checkResource ignoring windows/leases, always clear) / C2 (takeLease overwriting a live lease without --force) / C3 (isStale boundary flipped to <=) each perturbed, read back, typechecked, watched the named test fail, restored from a byte snapshot with `diff` empty. Correction: EVENT_TYPES in store.ts's parseEventLines was missing 'ask'/'decide' (P8.1 events were silently dropped on a reread from disk) — widened alongside the 'lease'/'window' addition this task needed anyway. Left in `doing` — no `review` column on this board (O11); orchestrator to verify and move to `done`
