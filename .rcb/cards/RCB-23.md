---
id: RCB-23
title: "P6.2 npx repoboard works from a tarball"
status: backlog
priority: high
labels: [infra]
created: 2026-09-02T22:10:00Z
updated: 2026-09-03T18:50:00Z
---

Task P6.2 in `docs/BUILD-PLAN.md` §5; detail in `docs/P6-SHIP-BRIEF.md` §"P6.2".

> **P6.2** `npx rcb` works from a fresh `npm pack` install; `bin` wiring verified.

Brief: root build copies `packages/web/dist` into `packages/server/dist/web`; `pnpm pack` then, in a temp repo outside this one, `npm install <tarball>` and `npx repoboard init | card add | card list | serve --port 4545`, `curl /` returns built HTML. `npm pack --dry-run` lists no tests, no `.repoboard/`.
