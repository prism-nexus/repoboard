---
id: RCB-27
title: K7 Cards render the doc lines they reference
status: done
assignee: claude/refs-agent
priority: high
labels:
  - web
created: 2026-09-03T18:44:44Z
updated: 2026-09-07T19:37:09Z
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
- 2026-09-03T20:52:23Z claude/refs-agent — moved todo → doing
- 2026-09-03T21:35:12Z claude/refs-agent — moved doing → review
- 2026-09-03T21:40:00Z claude/refs-agent — K7 implemented, not committed: tests 145 → 191 (core +27, server +14, web +3), typecheck 0, lint 0, bundle 135.2 KB gz; RCB-22..26 quoted blocks → 12 refs, 5,306 → 3,895 bytes; GET /api/cards/RCB-25/refs live: @O1 229-232 → 229-233 with a line appended → 229-232 removed; controls: ".." rule removed → 3 server tests fail (inside-root docs/../docs/plan.md served), heading end=j → 3 core tests fail; docs/drawer-refs.png looked at
- 2026-09-07T19:37:09Z matt — moved review → done
