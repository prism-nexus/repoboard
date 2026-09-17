---
id: RCB-40
title: P8.5 archive done cards; sync-issues from a README K-list
status: doing
labels:
  - practices
refs:
  - docs/BUILD-PLAN.md@P8.5
decision:
  question: "sync-issues: which column do new issue cards land in?"
  options:
    - letter: A
      text: todo
    - letter: B
      text: backlog
  askedBy: claude/p8-1
  askedAt: 2026-09-17T20:04:44Z
  returnTo: todo
  chosen: A
  words: null
  decidedBy: web
  decidedAt: 2026-09-17T21:46:55Z
created: 2026-09-17T19:03:42Z
updated: 2026-09-17T23:47:37Z
---

## Log
- 2026-09-17T20:04:44Z claude/p8-1 — moved todo → decide
- 2026-09-17T20:04:44Z claude/p8-1 — asked: sync-issues: which column do new issue cards land in? [A|B]
- 2026-09-17T21:46:55Z web — decided A
- 2026-09-17T21:46:55Z web — moved decide → todo
- 2026-09-17T23:17:43Z claude/builder — moved todo → doing
- 2026-09-17T23:47:37Z claude/p8-5 — verified: pnpm test x2 562/562 (web check:size OK), typecheck 0, lint 0, build 0; fpj sync-issues --dry-run read-only x3 (64/0/0 at 44acaf1/f49c5c2/0427693, git status unchanged, .repoboard absent); C1/C2/C3 controls verified failing in the feared direction then restored byte-identical (diff empty). No CLI subcommand exists for a card-only log line (only MCP append_log/store.appendLog do) -- used the store method directly, same funnel.
