---
id: RCB-22
title: P6.1 README with screenshots (GIF is stretch)
status: review
assignee: claude/ship-agent
priority: medium
labels:
  - docs
files:
  - README.md
  - docs/AGENTS.md
  - packages/server/test/version.test.ts
  - docs/board.png
  - docs/map.png
created: 2026-09-02T22:10:00Z
updated: 2026-09-03T20:15:04Z
---

Task P6.1 in `docs/BUILD-PLAN.md` §5; detail in `docs/P6-SHIP-BRIEF.md` §"P6.1 README".

> **P6.1** README with a 20-second GIF, install (`npx rcb`), the thesis (files are the DB).
>
> **Exit criterion for v0.1:** in a foreign repo, `npx rcb` opens a board; an agent with only a
> shell moves a card with `sed` and the board updates within 1 s; the treemap renders; the card's
> files glow with the agent's color.

Brief: eight README sections, two PNG screenshots (`docs/board.png`, `docs/map.png`); GIF only if `ffmpeg` is on PATH.

## Log
- 2026-09-03T20:10:35Z claude/ship-agent — moved backlog → doing
- 2026-09-03T20:11:58Z claude/ship-agent — set files: for P6.1 (README, AGENTS.md, version test, two PNGs)
- 2026-09-03T20:15:04Z claude/ship-agent — moved doing → review
- 2026-09-03T20:15:04Z claude/ship-agent — verified: 145 tests, typecheck 0, lint 0; docs/board.png + docs/map.png looked at; version pin control failed on 0.1.1 and restored; no GIF (ffmpeg not on PATH)
