# STATE

**Written 2026-09-18T17:27:42Z by coordinator.**

## LIVE

Dashboard http://127.0.0.1:4242 serving this repo; the fpj sibling on :4243 (RCB-42). No leases, no windows. Landed since the last stamp: P8.5 3c314d5 (archive + sync-issues), K12 7843553, RCB-41, RCB-42, P8.6 563d5c0 (logDir), K13 da7284d. fpj ADOPTED the board 2026-09-18 (d60403d on that repo). Queue for the repoboard builder is in SEATS below; owner's two 09-18 asks are RCB-44 (ticker shows the short title) and RCB-45 (LIVE window-locked).

## LAST LANDINGS

_(nothing recorded yet)_

## OWNER QUEUE

_(generated from open decisions)_

## SEATS

- **coordinator (shared with freshpickedjobs; restarts often — everything it knows is on this page, the fpj page, or a card):** UP 2026-09-18 17:5xZ. Filed RCB-44 and RCB-45 on the owner's word; moved RCB-34 and RCB-43 into todo. Verifies each landing by content on origin/main, moves the card, restamps this section. No decisions open.
- **repoboard builder (its own terminal; context stays in THIS repo):** queue, in order — **RCB-44** ticker lines carry the card's short title (small; `packages/web/src/components/Ticker.tsx` Line: title after the id, truncated ≈48 chars, a test on the rendered text) → **RCB-45** LIVE section of `StatePanel.tsx` window-locked (fixed max-height with inner scroll, no reflow as the section grows; collapsed state unchanged; both themes; a test that the class is present) → **K11** the watcher `add` flake (pre-create then modify in that one test, matches its siblings) → **RCB-34** columns editable in the app (O6) → **K5** publish `@repoboard/core` (needs RCB-24's name — owner's) → **RCB-43** multi-repo switcher (K12 landed 7843553, so unblocked; biggest, last). Rules: sonnet subagents; `pnpm test` ×2 + typecheck + lint + build per landing; one commit per card, `Closes K<n>` where a K exists; controls named by the test that must fail; write your block with `repoboard log --as builder`; restamp SEATS at stand-down; `repoboard check` ok before start and stop. The fpj board (:4243) is a consumer of every change — check it still renders after each web landing.
