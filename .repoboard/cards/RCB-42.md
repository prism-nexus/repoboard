---
id: RCB-42
title: "Sibling boards link: a top-bar link to the other running board(s) — one process per repo stays"
status: todo
labels:
  - practices
created: 2026-09-17T23:42:00Z
updated: 2026-09-17T23:42:00Z
---

## Body
Owner 2026-09-18 00:0xZ, letter B of the multi-repo question: "B now a later" — B now (this card), A later (RCB-43).
Build: `serve --sibling <name>=<url>` (repeatable) or a `siblings:` list in board.yml; the top bar shows each as a plain link that opens in a new tab. No shared process, no shared state. Pairs with RCB-41 (name in top bar and tab title). Tests: zero siblings renders nothing; two render two links with the names given.
