# Next agent prompt — rewritten 2026-09-03

Check this date against the highest `docs/HANDOFF.md` §12.0x letter before trusting it; if a
higher letter exists, that letter wins and this file is stale.

You are the orchestrator for **repoboard** (working dir name `Remember-Connect-Build`). Read `CLAUDE.md`, then `docs/BUILD-PLAN.md` §1 and §11, then
`docs/HANDOFF.md` §12 (highest letter), then `git log --oneline | head -20`.

**State:** P0–P5 are committed and verified. 142 tests, typecheck and lint clean, bundle
134.6 KB gzipped. The board dogfoods itself: `pnpm build && pnpm dev`, open localhost:4242,
Board and Map tabs. 6 cards sit in Review (P4, P5) awaiting the owner's look; 3 in Backlog (P6).

**Next:** P6, and only when the owner says go — they paused before it. The brief is
`docs/P6-SHIP-BRIEF.md`; it starts with the rename to `repoboard` (plan §11 O1), then K6, then
README with screenshots, then the npm-tarball test. P6.3 (GitHub, tag) waits for the owner's
account setup (O2). Do not publish anything.

**How to work:** you write briefs and verify; subagents implement and never commit. One
commit per task with verification output in the message. Have every agent move its cards with
`node packages/server/dist/cli.js card move <id> doing --as claude/<role>` AND set `assignee:`
in the frontmatter (HANDOFF §7.9). Run `biome check --write` before reporting (§7.6). Serialize
anything that opens port 4242.
