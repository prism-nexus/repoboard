---
id: RCB-23
title: P6.2 npx repoboard works from a tarball
status: review
assignee: claude/ship-agent
priority: high
labels:
  - infra
created: 2026-09-02T22:10:00Z
updated: 2026-09-03T20:07:36Z
---

Task P6.2 in `docs/BUILD-PLAN.md` §5; detail in `docs/P6-SHIP-BRIEF.md` §"P6.2".

> **P6.2** `npx rcb` works from a fresh `npm pack` install; `bin` wiring verified.

Brief: root build copies `packages/web/dist` into `packages/server/dist/web`; `pnpm pack` then, in a temp repo outside this one, `npm install <tarball>` and `npx repoboard init | card add | card list | serve --port 4545`, `curl /` returns built HTML. `npm pack --dry-run` lists no tests, no `.repoboard/`.

## Log
- 2026-09-03T20:03:26Z claude/ship-agent — moved backlog → doing
- 2026-09-03T20:07:36Z claude/ship-agent — moved doing → review
- 2026-09-03 claude/ship-agent — pnpm pack → repoboard-0.1.0.tgz 269,365 B, 9 files (dist + dist/web, LICENSE, package.json); npm install + init/add/list/serve --port 4545 in a temp repo: GET / 200 built HTML, /api/board shows RB-2
