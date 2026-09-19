# STATE

**Written 2026-09-19T01:53:48Z by hometown.**

## LIVE

_(RCB-55 A3, 2026-09-18: slow-changing facts only — no queue, no per-landing status. The queue is the board (`card list --status todo`); landings are LAST LANDINGS; seat status is SEATS; rig facts are `docs/RIG.md`.)_

- **Dashboards:** :4242 serves this repo's board (from this root); :4243 serves the fpj board (from the fpj root, this repo's dist). Both link to each other from the top bar (RCB-42). fpj's `.repoboard/STATE.md` is the fpj live-state authority.
- **Remote:** public at https://github.com/prism-nexus/repoboard since 2026-09-18 20:3xZ (owner's first push); tag v0.1.0 = 5477022; routine pushes from seats to `main`.
- **Owner lane:** the Needs-decision column is the ONE owner queue — letters and owner tasks (`decision.kind: task`, RCB-52); OWNER QUEUE below is generated from it.
- **Sibling:** freshpickedjobs at ~/Projects/Repos/freshpickedjobs (board prefix FPJ, `logDir: docs/log`); the coordinator seat is shared across both boards.
- **npm:** nothing published yet — K5 waits on the owner's account (RCB-51).

## LAST LANDINGS

-4. **RCB-50 2d9490a — 2026-09-18 20:2xZ, verified by content** (0 private names outside .repoboard, 0 home paths outside the append-only log; a never-asserted fixture test now asserted). Builder DOWN 317de72. **FIRST PUBLIC PUSH on the owner's word (20:0xZ): local main → https://github.com/prism-nexus/repoboard.**


-3. **RCB-46 a5e2d13 — 2026-09-18 19:4xZ, verified by content** (home paths 22 → 2, both in today's append-only log; CLAUDE.md rule 1 generic; sibling-repo proofs skipIf $REPOBOARD_SIBLING_ROOT, 629+2 skipped without / 631 with; fixture → sample-claude.md; origin = https://github.com/prism-nexus/repoboard, NOTHING pushed). Residue filed as RCB-50 (private dir names as path examples, 9 lines) — lands before the push. Push HELD for the owner's word.


-2. **K11 3317bfb — 2026-09-18 19:1xZ, verified by content** (the watcher test pre-creates its card and starts with a `change`; README entry closed in the commit; 631/631 ×12 after vs 2 of 6 failing before, different load). RCB-46 scrub in doing; owner's answers relayed: the dogfood `.repoboard/` IS public, the append-only log keeps the old handle.


-1. **RCB-44 795056e + RCB-45 3c2c3ec — 2026-09-18 19:0xZ, verified by content by the coordinator** (ticker lines carry shortTitle(≤48) beside the id; STATE LIVE window-locked at height 160px with inner scroll; two fpj-board layout fixes measured in the browser: .app grid minmax(0,1fr), .state-panel__section min-width 0). Also a80efd4 (biome format, lint green again since 563d5c0). Gate 631/631 ×4 of 6, the two misses = K11 (next). Both dashboards restarted on this build.

## OWNER QUEUE

_(generated from open decisions)_

## SEATS

- **coordinator (shared with fpj): UP 2026-09-19 02:1xZ (f3c55d).** RCB-63 done; both boards on :4242 (fpj at `?repo=freshpickedjobs`). Routine = verify each sha by content on origin/main, move the card, restamp here. Last block: `log --last coordinator`.
- **repoboard builder: UP 2026-09-19 01:2xZ (a5f12e, Remote Control).** Batch 1 + RCB-63 landed. Queue: RCB-58 (B2), RCB-59 only if check stays red after it, RCB-56, K5 after the owner's RCB-51. Announces before any lock take. Last block: `log --last builder`.
