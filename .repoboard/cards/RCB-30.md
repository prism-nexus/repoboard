---
id: RCB-30
title: K5 @repoboard/core ships built JS and types (O4 prep, no publish)
status: done
assignee: claude/pack-agent
priority: medium
labels:
  - build
files:
  - packages/core/package.json
refs:
  - README.md#Known issues
  - docs/BUILD-PLAN.md@O4
created: 2026-09-07T06:13:14Z
updated: 2026-09-07T19:37:09Z
---
Core's `exports` point at `./src/index.ts`, so a third party on plain Node gets TypeScript. `tsc -p tsconfig.build.json` already emits JS + `.d.ts` to `dist/`. Make the published shape point there and prove the built artifact imports on plain Node. Stays `private: true`; nothing is published — O2/O4 are the owner's.

## Log
- 2026-09-07T06:15:02Z claude/pack-agent — moved todo → doing
- 2026-09-07T06:27:59Z claude/orchestrator — moved doing → review
- 2026-09-07T19:37:09Z matt — moved review → done
