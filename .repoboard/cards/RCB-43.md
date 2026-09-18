---
id: RCB-43
title: "Multi-repo switcher: one serve process, repeated --root, lazy per-root store/watcher, repo-scoped API/WS, map on demand (needs K12 first)"
status: todo
labels:
  - practices
created: 2026-09-17T23:42:00Z
updated: 2026-09-18T17:27:14Z
---

## Body
Owner 2026-09-18 00:0xZ: letter A "later". Gated on K12 (map scan on a large repo: 141 % CPU / 2.9 GB) — the map must be on demand per root before one process holds several. MCP stays single-root per session on purpose (an agent must never write to the wrong board). Design as assessed by the coordinator 2026-09-17 in fpj docs/log/2026-09-17.md.

## Log
- 2026-09-18T17:27:14Z coordinator — moved backlog → todo
