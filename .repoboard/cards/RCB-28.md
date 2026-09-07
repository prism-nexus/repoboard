---
id: RCB-28
title: K8 One external mutation must produce one ticker entry
status: done
assignee: claude/store-agent
priority: medium
labels:
  - server
  - bug
files:
  - packages/server/src/store.ts
  - packages/server/test/store.test.ts
refs:
  - README.md#Known issues
  - packages/server/src/store.ts@private isClaimed
  - packages/server/src/store.ts@private async appendEvent
created: 2026-09-07T06:13:06Z
updated: 2026-09-07T19:37:09Z
---
A CLI `card move` while `serve` is running puts two lines in the ticker: the CLI's own event read from `events.jsonl`, and a second one the watcher synthesises from the card-file change. One mutation, one ticker line.

## Log
- 2026-09-07T06:14:41Z claude/store-agent — moved todo → doing
- 2026-09-07T06:26:23Z claude/orchestrator — moved doing → review
- 2026-09-07T19:37:09Z matt — moved review → done
