# Next agent — eight lines

1. Read `CLAUDE.md` (or this repo's equivalent) — it routes.
2. Read `.repoboard/STATE.md` — if its stamp is older than the newest `.repoboard/log/` file,
   the log wins.
3. Read today's and yesterday's `.repoboard/log/<date>.md`.
4. Read decided cards (`repoboard card list --json`, the `decision` block) before asking the
   owner anything — a decided card is authority.
5. The queue is the board (`repoboard card list --status todo`).
6. Write your block with `repoboard log --as <seat>` as you go.
7. Rewrite STATE when you stand down (`repoboard state --set-section <SECTION> --stdin`).
8. `repoboard check` before you start and before you stop.
