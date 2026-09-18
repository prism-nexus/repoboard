---
id: RCB-42
title: "Sibling boards link: a top-bar link to the other running board(s) — one process per repo stays"
status: doing
labels:
  - practices
created: 2026-09-17T23:42:00Z
updated: 2026-09-18T00:44:11Z
---

## Body
Owner 2026-09-18 00:0xZ, letter B of the multi-repo question: "B now a later" — B now (this card), A later (RCB-43).
Build: `serve --sibling <name>=<url>` (repeatable) or a `siblings:` list in board.yml; the top bar shows each as a plain link that opens in a new tab. No shared process, no shared state. Pairs with RCB-41 (name in top bar and tab title). Tests: zero siblings renders nothing; two render two links with the names given.

## Log
- 2026-09-18T00:27:18Z claude/builder — moved todo → doing
- 2026-09-18T00:44:11Z claude/rcb-42 — verified: core parseBoard/serializeBoard siblings (accept/reject-empty-name/reject-javascript:/reject-file:/round-trip) and mergeSiblings (flag wins on collision, file-order-then-new-flag-names); server --sibling <name>=<url> parsing (repeatable, bad value is a UserError naming --sibling), merge on GET /api/board and the WS config broadcast (siblings sits next to config, not inside it), map-only root still carries a flag; web TopBar renders zero siblings as nothing and N siblings as target=_blank/rel=noopener links, updating live on a config message. pnpm test x2: 615/615 both (592 baseline + 23 new tests); no K11 flake either run. typecheck/lint/build all exit 0. Controls C1 (mergeSiblings ignoring the flag list), C2 (TopBar rendering the container when siblings is empty) and C3 (isSiblingUrl dropping the protocol check) all watched to fail in the feared direction, then restored byte-identical (diff empty, md5 unchanged).
