# acme-shop — routing anchor

**This file routes; it does not restate.** Figures and status are left out on purpose: they go
stale, and a stale signpost is worse than none. Each fact has one home, and this file names it.

**Start here, every session:** `docs/STATUS.md` (one page: what is deployed, what is in review, and
who holds which seat) → `docs/journal/<today>.md` (each seat's notes for the day) →
`docs/DECISIONS.md` (append-only; a line there is settled, so do not ask again) → `README.md`
§Backlog (the numbered queue, `B<n>`; a closing commit says `Closes B<n>` and edits the list).
`docs/DESIGN.md` is the architecture authority: where it and anything else disagree, the design
wins and the clash is worth reporting. `docs/ROADMAP-2025.md`
is FROZEN as of 2025-12-01 — read a `§` you are pointed at, never append to it.

---

## Ground rules — every task

1. **Hosted staging is written by CI alone.** Treat `.../acme-staging` as read-only from a laptop,
   whatever a script's help text suggests.
2. **Secrets stay out of git.** Local scratch data lives under `~/.acme/cache`; delete it freely, it
   is rebuilt on demand.
3. **One test run at a time.** Take the lock (`/tmp/acme-test.lock`) before the suite and release it
   after; the windows when CI owns it are posted in `docs/STATUS.md`. Only one holder of `pnpm dev`
   at a time. **A count taken while two runs overlap is worthless.**
4. **Seed and migration scripts dry-run by default.** They write only when given `--apply`, and
   never to the hosted database.
5. **Ask a person first** before: a paid-plan change, DNS, mail to a real customer, a public preview
   link, or anything that contradicts an entry in `docs/DECISIONS.md`.
6. **Merge through a pull request.** Work on a feature branch; `main` only moves by a reviewed merge,
   and the reviewer reads the diff itself — a green CI run proves the suite passed, not that the
   change is right.
7. **A health probe is a poll, not a hope.** After a deploy or a dependency bump, hit `/healthz`
   until it answers 200 before reporting success.

**Done means:** the ticket's acceptance list is ticked, `pnpm test` is green, `pnpm typecheck` exits
0 (a type error is fixed, never cast away with `any`), a new page ships its keyboard-navigation
test, and the commit message names the Backlog entry it closes.

---

## Where to look

These are the rows used every day. The complete index is `docs/ROUTER.md`.

| If you are… | Read |
|---|---|
| **Starting a session** | `docs/STATUS.md`, then `docs/journal/<today>.md`, then `docs/DECISIONS.md`. Say what you will do first, then do it. |
| **The BUILDER** | `README.md` §Backlog from the top, the brief template in `docs/ROUTER.md`, and the house style in `docs/STYLE-NOTES-2025-10-12.md`. |
| **The REVIEWER** (works through the `acme-docs` server and never edits code) | `docs/REVIEW-GUIDE-2025-11-04.md`, newest section first, then `docs/STYLE-NOTES-2025-10-12.md` §2. Verdicts go on the pull request; `flag_page` and `close_thread` only on the owner's word. |
| **Cutting a release** | `docs/journal/<yesterday>.md` for open incidents, then `docs/RELEASE-RUNBOOK.md` and `scripts/README.md`. Post the freeze window to `docs/STATUS.md` before you start. |
| **Changing the schema** | `docs/SCHEMA.md`; run the migrations from an empty database before you open the pull request. |
| **Anything else** | Start at `docs/ROUTER.md`. |

---

## Maintaining this file

Edit it only when a destination moves: a doc is added, renamed or retired. Keep it small, because it
is read at the start of every agent's context — check with `wc -c CLAUDE.md`, and move any row that
is not used daily into `docs/ROUTER.md`. The longer predecessor is kept at
`docs/archive/CLAUDE-2025-11-03.md`.
