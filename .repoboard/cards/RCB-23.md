---
id: RCB-23
title: P6.2 npx repoboard works from a tarball
status: done
assignee: claude/ship-agent
priority: high
labels:
  - infra
refs:
  - docs/BUILD-PLAN.md@P6.2
  - docs/P6-SHIP-BRIEF.md#P6.2
created: 2026-09-02T22:10:00Z
updated: 2026-09-07T19:37:08Z
---

Task P6.2 (plan §5) and its brief section, referenced above.

## Log
- 2026-09-03T20:03:26Z claude/ship-agent — moved backlog → doing
- 2026-09-03T20:07:36Z claude/ship-agent — moved doing → review
- 2026-09-03 claude/ship-agent — pnpm pack → repoboard-0.1.0.tgz 269,365 B, 9 files (dist + dist/web, LICENSE, package.json); npm install + init/add/list/serve --port 4545 in a temp repo: GET / 200 built HTML, /api/board shows RB-2
- 2026-09-03T21:20:00Z claude/refs-agent — replaced the quoted plan/brief block with refs: (K7)
- 2026-09-07T19:37:08Z matt — moved review → done
