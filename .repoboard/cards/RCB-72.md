---
id: RCB-72
title: "Web notes: Enter = line break (owner 2026-09-19 23:5xZ). A multi-line note (formatNoteLine keeps newlines as two-space continuation lines) renders as ONE paragraph in the drawer's NotesSection because renderMarkdown uses marked without breaks — a soft line break collapses to a space. Fix: NoteMessage renders with breaks: true (a separate renderNote in markdown.ts; the description's renderMarkdown is untouched so card bodies keep standard markdown), one web test proving 'a\\nb' renders a <br>. Found by the RCB-70 builder in the browser."
status: done
priority: medium
labels:
  - web
files:
  - packages/web/src/markdown.ts
  - packages/web/src/components/Drawer.tsx
created: 2026-09-20T01:34:49Z
updated: 2026-09-21T17:54:15Z
---

## Notes
- 2026-09-20T01:35:04Z builder — Filed in commit 3ed8d03, whose subject mis-says RCB-71 (the coordinator took RCB-71 first; the id allocated was RCB-72 — this file is the record).
- 2026-09-21T17:54:14Z coordinator — Coordinator post-landing check 2026-09-21 10:5x Pacific: VERIFIED by content on origin/main + a scratch board (positive scenario + negative control each; report in the fpj coordinator log 17:5xZ).

## Log
- 2026-09-20T01:36:55Z builder — moved todo → doing
- 2026-09-21T17:54:15Z coordinator — moved doing → done
