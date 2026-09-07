# Next agent prompt — rewritten 2026-09-07 (after K8, K1(b), K5, and the K9 ticket)

Check this date against the highest `docs/HANDOFF.md` §12.0x letter before trusting it; if a
higher letter exists, that letter wins and this file is stale. Highest letter when this was
written: **§12.0k**.

You are the orchestrator for **repoboard** (working dir name `Remember-Connect-Build`). Read
`CLAUDE.md`, then `docs/BUILD-PLAN.md` §1 and §11, then `docs/HANDOFF.md` §12 (highest letter),
then `git log --oneline | head -20`.

## State

P0–P6.2, K7, then K8 / K1(b) / K5 are committed and verified. Test count, bundle and tarball
numbers are in HANDOFF §1 (newest lines) — take them from there, not from memory. The board
dogfoods itself: `pnpm build && pnpm dev`, open localhost:4242.

- **31 cards.** Fourteen in Review for the owner (P4, P5, P6.0–P6.2, K7, RCB-28/29/30). One in
  `todo`: **RCB-31 (K9)**. One in Backlog: **RCB-24 (P6.3)**, the owner's.
- Review is **not** an approval gate — `review` carries only `active: true`, which is a map flag.
  Nothing in the product enforces a workflow; a card is approved when a human moves it to `done`.
- Known issues open: **K5** (publish `@repoboard/core` — one line, the owner's) and **K9**.
  K1–K4, K6, K7, K8 are closed.
- `README.md` is the public face; `docs/AGENTS.md` is the agent page; plan §2–§4 are the
  contracts and were re-checked against shipped behaviour on 2026-09-07.

## Next

**Nothing is blocked on an agent except RCB-31, and that needs a decision first.** K9 is that
the CLI cannot set `assignee` after `card add` (it has `add, move, list, show` only). Two shapes,
and the card states both without picking: `card update <id> [--assignee|--priority|…]`, which
mirrors the MCP `update_card` and HTTP `PATCH /api/cards/:id` that already exist, or `--assign`
on `card move`. Ask the owner which; do not pick for them.

**P6.3 (RCB-24) is the owner's**: create the GitHub repo (plan §11 O2), publish
`@repoboard/core` by deleting `"private": true` (O4 — the packaging is done and verified), tag
v0.1.0. Do not publish anything, create any repo, or tag on your own (CLAUDE.md non-negotiable 3,
plan §0.6).

Unscheduled and unticketed: a test that the board's own `refs:` all resolve — nothing guards that
today, and a broken pointer was found by hand on 2026-09-07; and generating cards from plan
headings rather than writing them (a new owner decision; see O5 for the direction).

## How to work

You write briefs and verify; subagents implement and never commit. One commit per task with its
verification output in the message. Specifics that have cost time here:

- Have every agent move its cards with
  `node packages/server/dist/cli.js card move <id> doing --as claude/<role>`. Setting `assignee`
  means hand-editing the frontmatter until K9 lands — **do not brief `card update`, it does not
  exist** (HANDOFF §7.9).
- Run `biome check --write` before reporting (§7.6). Serialize anything that opens a port, and
  never let two agents run the full suite at once (CLAUDE.md non-negotiable 2).
- **Verify by content, never by an exit code** (CLAUDE.md), and verify against the **built**
  artifact, not just vitest — that is what caught the K8 event-loss mode (§7.15).
- **Re-derive a recorded repro before fixing it** (§7.13). The K8 entry in README had the wrong
  trigger, and the fix specified in its brief would have introduced a third bug (§7.12).
- A `@Token` ref matches a line that *starts* with the token after list markers, emphasis and
  whitespace are stripped. Check every ref you write resolves:
  `GET /api/cards/<id>/refs` on the built server, and look for a non-null `error`.
