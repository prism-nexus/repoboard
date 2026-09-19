---
id: RCB-64
title: "Flaky under load: store.test.ts > watcher > 'emits events appended to events.jsonl by another process' — same species as K11 (chokidar `add` on a brand-new file with awaitWriteFinish; the test creates events.jsonl fresh). Sightings 2026-09-19: RCB-62 agent ×1 (store+http+cli together), builder full-suite runs 2 and 3 of 3 at the RCB-58 gate (run 1 green 796|2); 0 of 2 at the batch-1 gate; 8/8 green alone (5× -t isolated, 3× whole file). Fix like K11: pre-create events.jsonl in the fixture and append, so the watcher sees a `change`; control = revert the pre-create under load. Until then a full-suite miss on exactly this test is not a regression signal."
status: doing
assignee: builder
priority: medium
labels:
  - flake
files:
  - packages/server/test/store.test.ts
created: 2026-09-19T02:14:40Z
updated: 2026-09-19T02:15:48Z
---

## Log
- 2026-09-19T02:15:48Z builder — moved todo → doing
- 2026-09-19T02:15:48Z builder — updated assignee
