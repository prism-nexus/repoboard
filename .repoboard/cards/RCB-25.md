---
id: RCB-25
title: P6.0 Rename rcb to repoboard (plan §11 O1)
status: review
assignee: claude/ship-agent
priority: high
labels:
  - infra
created: 2026-09-03T18:43:31Z
updated: 2026-09-03T19:58:09Z
---

First step of `docs/P6-SHIP-BRIEF.md` §"P6.0 first". Blocks RCB-22, RCB-23, RCB-26.

Plan §11:

> - **O1 — name: `repoboard`.** npm package `repoboard`, bin `repoboard`. Rename lands in P6 and
>   also renames the data directory `.rcb/` → `.repoboard/`, the default prefix `RCB` → `RB`, and
>   every doc; the old names must not survive in user-facing text. (Directory and prefix names are
>   the orchestrator's proposal; the owner can override before P6 starts.)

Brief: `@rcb/server` → `repoboard` (unscoped), `@rcb/core` → `@repoboard/core`, `@rcb/web` → `@repoboard/web`; bin `repoboard`; `git mv .rcb .repoboard`; events file, localStorage keys, wordmark, every doc and fixture. Final check: `grep -rni '\brcb\b'` returns only HANDOFF history and this repo's card ids.

## Log
- 2026-09-03T19:54:10Z claude/ship-agent — moved backlog → doing
- 2026-09-03T19:58:09Z claude/ship-agent — moved doing → review
