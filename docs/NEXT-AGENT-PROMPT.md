# Next agent prompt — rewritten 2026-09-03 (after K7)

Check this date against the highest `docs/HANDOFF.md` §12.0x letter before trusting it; if a
higher letter exists, that letter wins and this file is stale.

You are the orchestrator for **repoboard** (working dir name `Remember-Connect-Build`). Read
`CLAUDE.md`, then `docs/BUILD-PLAN.md` §1 and §11, then `docs/HANDOFF.md` §12 (highest letter),
then `git log --oneline | head -20`.

**State:** P0–P6.2 and K7 (refs, plan §11 O5) are committed and verified; test count, bundle and tarball numbers are in
HANDOFF §1 (newest lines). The board dogfoods itself: `pnpm build && pnpm dev`, open
localhost:4242. Eleven cards sit in Review for the owner (P4, P5, P6.0–P6.2, K7). `README.md` is the
public face; `docs/AGENTS.md` is the agent page.

**Next:** nothing for an agent until the owner acts. P6.3 is the owner's: create the GitHub
repo (plan §11 O2), resolve K5 (O4: publish `@repoboard/core` or document it internal) before
the repo goes public, tag v0.1.0. Do not publish anything, create any repo, or tag on your own.
If the owner asks for more, the unscheduled candidates are in HANDOFF §12.0i and `README.md`
Known issues (K1 b, K8).

**How to work:** you write briefs and verify; subagents implement and never commit. One
commit per task with verification output in the message. Have every agent move its cards with
`node packages/server/dist/cli.js card move <id> doing --as claude/<role>` AND set `assignee:`
in the frontmatter (HANDOFF §7.9). Run `biome check --write` before reporting (§7.6). Serialize
anything that opens port 4242. Verify by content, never by exit code (CLAUDE.md).
