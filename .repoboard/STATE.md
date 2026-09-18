# STATE

**Written 2026-09-18T20:17:16Z by coordinator.**

## LIVE

Dashboard http://127.0.0.1:4242 serving this repo; the fpj sibling on :4243 (RCB-42). Public remote (RCB-24 DONE): https://github.com/prism-nexus/repoboard — EMPTY; push word GIVEN 20:0xZ: the coordinator pushes local main once RCB-50 lands and is verified. OWNER LANE = one queue (letters + owner work, 20:1xZ): RCB-51 npm setup sits there now. Builder seat: RCB-50 in doing, then STAND DOWN; fresh builder's queue RCB-47 → RCB-52 (owner-task cards, same seam) → RCB-48 → RCB-49 (v0.1.0 tag after the push) → RCB-34 → K5/RCB-51 (after the owner's npm) → RCB-43. Landed today: RCB-44 795056e, RCB-45 3c2c3ec, K11 3317bfb, RCB-46 a5e2d13.

## LAST LANDINGS

-4. **RCB-50 2d9490a — 2026-09-18 20:2xZ, verified by content** (0 private names outside .repoboard, 0 home paths outside the append-only log; a never-asserted fixture test now asserted). Builder DOWN 317de72. **FIRST PUBLIC PUSH on the owner's word (20:0xZ): local main → https://github.com/prism-nexus/repoboard.**


-3. **RCB-46 a5e2d13 — 2026-09-18 19:4xZ, verified by content** (home paths 22 → 2, both in today's append-only log; CLAUDE.md rule 1 generic; sibling-repo proofs skipIf $REPOBOARD_SIBLING_ROOT, 629+2 skipped without / 631 with; fixture → sample-claude.md; origin = https://github.com/prism-nexus/repoboard, NOTHING pushed). Residue filed as RCB-50 (private dir names as path examples, 9 lines) — lands before the push. Push HELD for the owner's word.


-2. **K11 3317bfb — 2026-09-18 19:1xZ, verified by content** (the watcher test pre-creates its card and starts with a `change`; README entry closed in the commit; 631/631 ×12 after vs 2 of 6 failing before, different load). RCB-46 scrub in doing; owner's answers relayed: the dogfood `.repoboard/` IS public, the append-only log keeps the old handle.


-1. **RCB-44 795056e + RCB-45 3c2c3ec — 2026-09-18 19:0xZ, verified by content by the coordinator** (ticker lines carry shortTitle(≤48) beside the id; STATE LIVE window-locked at height 160px with inner scroll; two fpj-board layout fixes measured in the browser: .app grid minmax(0,1fr), .state-panel__section min-width 0). Also a80efd4 (biome format, lint green again since 563d5c0). Gate 631/631 ×4 of 6, the two misses = K11 (next). Both dashboards restarted on this build.

## OWNER QUEUE

_(generated from open decisions)_

## SEATS

- **coordinator (shared with freshpickedjobs): DOWN 2026-09-18 20:3xZ on the owner's word (decide-then-restart).** Fresh coordinator: this page → `.repoboard/log/2026-09-18.md` last blocks → `card list --needs-decision` (RCB-51 npm setup is OWNER WORK in the owner lane, one queue by his rule) → `card list --status todo`. The repo is PUBLIC at github.com/prism-nexus/repoboard since 20:3xZ (owner's push); routine pushes from seats work. Verify each landing by content, move the card, restamp.
- **repoboard builder (its own terminal; context stays in THIS repo):** DOWN 2026-09-18 19:4xZ on the owner's "every seat clears and restarts". Landed today: RCB-44 795056e, RCB-45 3c2c3ec, K11 3317bfb, RCB-46 a5e2d13, RCB-50 2d9490a. **Fresh builder's queue, in order:** **RCB-47** per-seat log blocks → **RCB-48** `repoboard seat` (the seat cold-start command) → **RCB-49** open-source readiness files → **RCB-34** columns editable in the app (O6) → **K5** publish `@repoboard/core` (waits on the owner's npm account) → **RCB-43** multi-repo switcher (biggest, last). **Rig facts:** (1) `pnpm build` FIRST — the CLI is `node packages/server/dist/cli.js`, nothing is on PATH, and :4242/:4243 serve `packages/server/dist/web`. (2) vitest: one runner on the box. Take the lock with `mkdir /tmp/fpj-vitest.lock || exit` then write `"$$ <cwd> <ISO time>"` to `/tmp/fpj-vitest.lock/owner`; release with `rm -rf` ONLY when the owner line's pid is yours; NEVER remove a foreign lock (the 19:32Z incident in today's log is what happens otherwise); fpj's gate windows are in its STATE and no suite runs inside one. (3) After any web landing rebuild, then restart :4242 (`node packages/server/dist/cli.js serve --port 4242` from this root) and :4243 from the fpj root (`cd ~/Projects/Repos/freshpickedjobs && node <this repo>/packages/server/dist/cli.js serve --port 4243`), and look at :4243 in a browser — it is the owner's board and has caught two layout bugs this repo's own board did not. Never touch :5173 or :8787. (4) `origin` = https://github.com/prism-nexus/repoboard is configured, NOTHING is pushed; the first push is the owner's word via the coordinator. (5) Rules unchanged: sonnet subagents with written briefs; `pnpm test` ×2 + typecheck + lint + build per landing; one commit per card with its numbers in the message, `Closes K<n>` where a K exists; controls named by the test that must fail, perturbation read back and restored with `cmp`; take a lease on the card you hold; `repoboard log --as builder`; `repoboard check` ok before start and stop.
