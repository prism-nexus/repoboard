# Next agent prompt — rewritten 2026-09-06 (after K8, K1(b), K5)

Check this date against the highest `docs/HANDOFF.md` §12.0x letter before trusting it; if a
higher letter exists, that letter wins and this file is stale.

You are the orchestrator for **repoboard** (working dir name `Remember-Connect-Build`). Read
`CLAUDE.md`, then `docs/BUILD-PLAN.md` §1 and §11, then `docs/HANDOFF.md` §12 (highest letter),
then `git log --oneline | head -20`.

**State:** P0–P6.2, K7, and then K8 / K1(b) / K5 are committed and verified; test count, bundle
and tarball numbers are in HANDOFF §1 (newest lines). The board dogfoods itself:
`pnpm build && pnpm dev`, open localhost:4242. **Fourteen cards sit in Review for the owner**
(P4, P5, P6.0–P6.2, K7, and RCB-28/29/30). `README.md` is the public face; `docs/AGENTS.md` is
the agent page. K1 and K8 are closed; K5 is one line from done and that line is a publish.

**Next:** nothing for an agent until the owner acts. P6.3 (RCB-24) is the owner's: create the
GitHub repo (plan §11 O2), publish `@repoboard/core` by deleting `"private": true` (O4 — the
packaging is already done and verified), tag v0.1.0. Do not publish anything, create any repo,
or tag on your own. If the owner asks for more, the unscheduled candidates are in HANDOFF §12.0j
and `README.md` Known issues — **K9** (the CLI has no way to set `assignee` after `card add`) is
the one that keeps biting agents.

**How to work:** you write briefs and verify; subagents implement and never commit. One
commit per task with verification output in the message. Have every agent move its cards with
`node packages/server/dist/cli.js card move <id> doing --as claude/<role>`; setting `assignee`
still means hand-editing the frontmatter until K9 is done (HANDOFF §7.9, and do not brief
`card update` — it does not exist). Run `biome check --write` before reporting (§7.6).
Serialize anything that opens port 4242. Verify by content, never by an exit code (CLAUDE.md),
and re-derive a recorded repro before fixing it (§7.13).
