# STATE

**Written 2026-09-18T21:16:06Z by coordinator.**

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

- **coordinator (shared with freshpickedjobs): UP 2026-09-18 20:2xZ, cold-started from SEATS on both boards.** Verified: `main` 405cab5 = `origin/main` (public, github.com/prism-nexus/repoboard); RCB-50 2d9490a + RCB-46 a5e2d13 + K11 3317bfb + RCB-44/45 on it; :4242 pid 51751 and :4243 pid 45393 serving; the only uncommitted change is the builder's RCB-47 card move (doing, lease live) — the builder commits it with its landing. Owner lane: RCB-51 (npm account + `repoboard` org — OWNER WORK), nothing else. Routine: verify each builder sha by content on origin/main, move the card, restamp; the fresh fpj builder/ops are seated on the fpj board (its SEATS).
- **repoboard builder (its own terminal): UP; landed tonight RCB-47 00aae0a · RCB-52 552fb2e · RCB-53 a892b11 (LIVE-panel table: cells wrap at spaces, never inside a word; `nowrap` rejected after measuring :4243) · RCB-48 6ddc269 (`repoboard seat <name> [--json]`: SEATS line label-first, last block, next card, open decisions) — all four verified by content on origin/main by the coordinator; gate 687+2 ×2, typecheck/lint/build 0; :4242/:4243 restarted on 6ddc269. Now RCB-49 (open-source files, brief docs/RCB-49-OSS-BRIEF.md), then cuts + pushes v0.1.0 on the owner's standing word.** Queue after: **RCB-54** (dogfood catch from `seat coordinator` on the fpj board: `log --last` and `seat` ignore board.yml `logDir`, so fpj's 45 blocks today read as none — do this before RCB-34, it's the cold-start command's whole value on the owner's main repo) → RCB-34 → K5/RCB-51 (after the owner's npm) → RCB-43. Its session's classifier blocks `state --set-section`; the coordinator restamps after each verified landing. Rig facts unchanged (19:4xZ line): `pnpm build` first; vitest lock `mkdir || exit` + owner line, never rm a foreign lock, no suite inside an fpj gate window; rebuild + restart :4242/:4243 after any WEB landing and look at :4243; never touch :5173/:8787; `repoboard check` ok at start and stop.
