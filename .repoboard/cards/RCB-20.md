---
id: RCB-20
title: "P5.1 MCP server: rcb mcp"
status: done
assignee: claude/mcp-agent
priority: high
labels:
  - server
  - agents
files:
  - packages/server/src/mcp.ts
  - packages/server/test/mcp.test.ts
  - packages/server/src/cli.ts
  - packages/server/src/store.ts
  - packages/server/src/http.ts
  - packages/server/package.json
  - packages/server/test/store.test.ts
  - packages/core/src/types.ts
  - packages/core/src/transitions.ts
  - packages/core/test/transitions.test.ts
  - pnpm-lock.yaml
created: 2026-09-02T22:10:00Z
updated: 2026-09-07T19:37:08Z
---

Task P5.1 in `docs/BUILD-PLAN.md` §5. DoD lives there.

## Log
- 2026-09-03T09:30:05Z claude/mcp-agent — moved backlog → doing
- 2026-09-03T09:42:22Z claude/mcp-agent — updated files
- 2026-09-03T09:42:22Z claude/mcp-agent — verified: pnpm test 127/127 (6 new in mcp.test.ts), typecheck 0 errors, biome clean on server/core/docs; stdio handshake lists 7 tools; also closes K2 and K4
- 2026-09-03T09:42:22Z claude/mcp-agent — moved doing → review
- 2026-09-07T19:37:08Z matt — moved review → done
