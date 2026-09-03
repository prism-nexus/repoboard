---
id: RCB-27
title: K7 Cards render the doc lines they reference
status: todo
priority: high
labels:
  - web
created: 2026-09-03T18:44:44Z
updated: 2026-09-03T20:51:09Z
---

`README.md` Known issues K7 (owner's note, 2026-09-03):

> A card that points at a doc section shows only the pointer; the reader has to leave the
> board to learn what the task is. Cards should populate from the lines they reference so the
> drawer shows what the card actually contains.

Proposed shape: a `refs:` field (`path#heading` or `path:L10-L20`); the drawer fetches and
renders those lines under the body, live from the file. Interim convention in force: quote the
referenced lines into the body. Pulled into v0.1 by the owner 2026-09-03 (plan §11 O5). Brief: `docs/K7-REFS-BRIEF.md`.

## Log
- 2026-09-03T20:51:09Z matt — moved backlog → todo
