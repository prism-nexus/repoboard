---
id: RCB-29
title: K1(b) parseCard accepts an unquoted title containing a colon
status: review
assignee: claude/core-agent
priority: medium
labels:
  - core
files:
  - packages/core/src/card.ts
  - packages/core/test/card.test.ts
refs:
  - README.md#Known issues
  - docs/AGENTS.md@Quote a title that contains a colon
created: 2026-09-07T06:13:14Z
updated: 2026-09-07T06:27:35Z
---
K1 options (a) document and (c) always quote on serialize are done; (b) is open. A hand-written `title: P3.1 Board view: columns` is invalid YAML and the card turns red. Recover the title line only — never loosen any other key.

## Log
- 2026-09-07T06:14:52Z claude/core-agent — moved todo → doing
- 2026-09-07T06:27:35Z claude/orchestrator — moved doing → review
