---
id: RCB-27
title: K7 Cards render the doc lines they reference
status: backlog
priority: low
labels:
  - web
created: 2026-09-03T18:44:44Z
updated: 2026-09-03T18:44:44Z
---

`README.md` Known issues K7 (owner's note, 2026-09-03):

> A card that points at a doc section shows only the pointer; the reader has to leave the
> board to learn what the task is. Cards should populate from the lines they reference so the
> drawer shows what the card actually contains.

Proposed shape: a `refs:` field (`path#heading` or `path:L10-L20`); the drawer fetches and
renders those lines under the body, live from the file. Interim convention in force: quote the
referenced lines into the body. Post-v0.1 unless the owner pulls it forward.
