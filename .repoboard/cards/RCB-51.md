---
id: RCB-51
title: "K5 publish `repoboard` to npm — OWNER WORK first: npm account + `repoboard` org, 2FA on, placeholder 0.0.1 to claim the name; then the builder publishes the CLI as unscoped `repoboard` and core/server under @repoboard"
status: todo
priority: high
decision:
  question: npm account + `repoboard` org, 2FA on, placeholder 0.0.1 published to claim the name; then tell the builder (K5 publishes the CLI as unscoped `repoboard`, core/server under @repoboard)
  kind: task
  options: []
  askedBy: coordinator
  askedAt: 2026-09-18T20:55:35Z
  returnTo: null
  chosen: null
  words: account and org created on npm so once this batch finishes we are set to release
  decidedBy: coordinator
  decidedAt: 2026-09-24T20:55:45Z
created: 2026-09-18T19:52:32Z
updated: 2026-09-24T20:55:45Z
---
## Decision
- 2026-09-24T20:55:45Z coordinator — done — "account and org created on npm so once this batch finishes we are set to release"

## Notes
- 2026-09-24T20:55:45Z repoboard builder — repoboard builder 20:5xZ 09-24: recorded from the coordinator's relay (owner words heard at the coordinator pane 20:0xZ, 1:0x pm Pacific). NOT confirmed by those words: 2FA on the account (coordinator asking the owner), and the placeholder 0.0.1 publish (moot if 0.2.0 ships at batch-done). Release gate: RCB-133..150 finished; the builder confirms the tag+publish with the owner in its own terminal before running it. Title's 'core/server under @repoboard' superseded by RCB-126 (core internal; only repoboard publishes).

## Log
- 2026-09-18T19:52:32Z coordinator — moved todo → decide
- 2026-09-18T19:52:32Z coordinator — asked: OWNER WORK, not a letter: is the npm account + repoboard org set up (names measured free 18:2xZ)? [A|B]
- 2026-09-18T20:55:35Z coordinator — question withdrawn
- 2026-09-18T20:55:35Z coordinator — owner task: npm account + `repoboard` org, 2FA on, placeholder 0.0.1 published to claim the name; then tell the builder (K5 publishes the CLI as unscoped `repoboard`, core/server under @repoboard)
- 2026-09-24T20:55:45Z coordinator — done — "account and org created on npm so once this batch finishes we are set to release" → todo (default; asked in-column)
- 2026-09-24T20:55:45Z coordinator — moved decide → todo
