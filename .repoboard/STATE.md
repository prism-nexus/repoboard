# STATE

**Written 2026-09-18T22:15:21Z by coordinator.**

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
- **repoboard builder (fresh, its own terminal): UP 21:53Z. RCB-54 LANDED 713d330 — verified by content by the coordinator 22:1xZ (repolog.ts:80 regex `^##### (.+?) (\d{4}-\d{2}-\d{2}.*?): (.*)$`; store.ts `seat`/`log --last` on `loadAllLogInfo`; 47/47 fpj headings parse; `seat ops` from the fpj root prints the 21:4xZ OPS block). Gate 697+2 ×2, typecheck 0, lint 0. Card done, lease released, lock released. :4242 (pid 76195) / :4243 (pid 76197) restarted on this build by the coordinator. Also e0f9ed2: RCB-55 = the owner's cold-start cleanup ask as docs/COLD-START-CLEANUP-PROPOSAL.md (proposal only; A1–A5 doc/state, B1–B6 product incl. B6 = RCB-54's out-of-scope list) — ASKED on the card as the owner's letter A/B/C.** NOW: RCB-34 (columns editable in the app, O6) — GO. Then K5/RCB-51 (after the owner's npm, Done on RCB-51) → RCB-43; the B-items become cards on the owner's letter. Rig (unchanged): `pnpm build` first; lock `mkdir || exit` + owner line, never rm a foreign lock, no suite inside an fpj gate window (none armed for 09-19); rebuild + restart :4242/:4243 after any WEB landing and look at :4243; never touch :5173/:8787; `--as builder`; report each sha to the coordinator, who verifies by content, moves the card, restamps.
