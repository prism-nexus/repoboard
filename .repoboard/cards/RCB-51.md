---
id: RCB-51
title: "K5 publish `repoboard` to npm — OWNER WORK first: npm account + `repoboard` org, 2FA on, placeholder 0.0.1 to claim the name; then the builder publishes the CLI as unscoped `repoboard` and core/server under @repoboard"
status: done
priority: high
gate: RCB-153
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
updated: 2026-09-25T23:16:04Z
---
## Decision
- 2026-09-24T20:55:45Z coordinator — done — "account and org created on npm so once this batch finishes we are set to release"

## Notes
- 2026-09-24T20:55:45Z repoboard builder — repoboard builder 20:5xZ 09-24: recorded from the coordinator's relay (owner words heard at the coordinator pane 20:0xZ, 1:0x pm Pacific). NOT confirmed by those words: 2FA on the account (coordinator asking the owner), and the placeholder 0.0.1 publish (moot if 0.2.0 ships at batch-done). Release gate: RCB-133..150 finished; the builder confirms the tag+publish with the owner in its own terminal before running it. Title's 'core/server under @repoboard' superseded by RCB-126 (core internal; only repoboard publishes).
- 2026-09-24T20:56:56Z repoboard builder — repoboard builder 20:5xZ 09-24: owner words via the coordinator's relay (heard 20:5xZ, 1:5x pm Pacific): "I have not setup the 2fa yet". Account + org exist; 2FA is NOT set up — the owner's step before the publish; the builder raises it in its terminal confirm at publish time (check npm whoami and the org's publishing setting then).
- 2026-09-24T21:05:48Z repoboard builder — repoboard builder 21:1xZ 09-24: owner words via the coordinator's relay (fpj OWNER-DECISIONS f1965613): "2fa is enabled on my account now". RCB-51 fully answered: account, org, 2FA. Placeholder 0.0.1 moot — 0.2.0 ships at batch-done after the builder's terminal confirm with the owner.
- 2026-09-25T19:35:31Z builder — repoboard builder 19:4xZ 09-25: owner decision in the builder terminal: publish UNSCOPED `repoboard` (O1 unchanged). Considered and rejected: @repoboard/cli scoped (npx friction; leaves the unscoped name open to squatting) and scoped+unscoped-alias (two publishes, bin clash, cli.ts main-module guard blocks a thin import wrapper). The @repoboard scope stays org-owned for future packages. npm whoami = prism-nexus (login completed after the reboot).
- 2026-09-25T20:17:51Z builder — repoboard builder 20:2xZ 09-25: owner in the builder terminal: 'lets not do multiple launches lets get rcb-153 done verified and then I will create the publish token and we can publish'. Order flipped: RCB-51 now gated on RCB-153 (was the reverse). Publish-ready state at 9afc33c (gate 1591|4|0, dry run clean, shasum 28f2fdf0) is superseded by whatever RCB-153 lands; re-gate + re-pack at publish time. Owner will create a publish token (granular access token) instead of an OTP.
- 2026-09-25T23:14:06Z builder — PUBLISHED repoboard@0.2.0 (owner 2026-09-25 23:1xZ in the builder terminal: 0.2.0, token supplied). c21cad3 folds the workspace into CHANGELOG [0.2.0]; gate 1641|4|0 x2, typecheck/lint/build 0; pack-smoke 9/9; dry run clean (no 'invalid and removed'). Registry: dist-tags.latest 0.2.0, shasum 56933c209374684de94bbd8c69331e09391246e0 = the smoked tarball; fresh install from npm prints 0.2.0, init + check exit 0. Tag v0.2.0 -> c21cad3 pushed. https://www.npmjs.com/package/repoboard
- 2026-09-25T23:16:04Z coordinator — coordinator 23:2xZ 09-25: PUBLISH VERIFIED by content — c21cad3 (parent c4f1ba7, CHANGELOG fold only), annotated tag v0.2.0 → c21cad3 on origin, gate.jsonl 23:14:06Z c21cad3 1641|4|0, npm view repoboard@0.2.0: latest=0.2.0 shasum 56933c20…, fresh install in a scratch dir prints 0.2.0 with the bin present. Set done (owner: one launch, RCB-153 then this). RCB-154 is a post-set follow-up.

## Log
- 2026-09-18T19:52:32Z coordinator — moved todo → decide
- 2026-09-18T19:52:32Z coordinator — asked: OWNER WORK, not a letter: is the npm account + repoboard org set up (names measured free 18:2xZ)? [A|B]
- 2026-09-18T20:55:35Z coordinator — question withdrawn
- 2026-09-18T20:55:35Z coordinator — owner task: npm account + `repoboard` org, 2FA on, placeholder 0.0.1 published to claim the name; then tell the builder (K5 publishes the CLI as unscoped `repoboard`, core/server under @repoboard)
- 2026-09-24T20:55:45Z coordinator — done — "account and org created on npm so once this batch finishes we are set to release" → todo (default; asked in-column)
- 2026-09-24T20:55:45Z coordinator — moved decide → todo
- 2026-09-25T20:17:51Z builder — updated gate
- 2026-09-25T23:16:04Z coordinator — moved todo → done
