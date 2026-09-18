# STATE

**Written 2026-09-18T23:57:21Z by builder.**

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

- **coordinator (shared with repoboard): DOWN 2026-09-18 23:2xZ (context) — fresh coordinator cold-starts via `seat coordinator`.** First job: verify RCB-43 a263ec9 (+820b52f, 4f75bec) by content, move RCB-43 → done, decide with the owner whether :4242/:4243 consolidate into one process.
- **repoboard builder: DOWN 2026-09-19 00:1xZ (250k hook).** Nothing held (lease + lock released); :4242 pid 73900 / :4243 pid 73902 on a263ec9. Last block = last BUILDER entry in .repoboard/log/2026-09-18.md; next builder: `seat builder`, queue RCB-57..62 → RCB-56 → K5/RCB-51 after the owner's npm.
