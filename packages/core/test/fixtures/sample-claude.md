# sample-app — routing anchor

**This file routes; it does not restate.** No counts, hashes or status live here — they move, and a
stale router is worse than none. Every fact lives in one place and this file says which.

**Start here, every seat, every day:** `docs/STATE.md` (one page: live state, what is armed, the
owner's open letters, who holds which seat) → `docs/log/<today>.md` (each seat's block for the day)
→ `docs/OWNER-DECISIONS.md` (append-only, verbatim; a line there is authority — never re-ask it,
never wait for a relay) → `README.md` §Known issues (the numbered work queue, `K<n>`; a closing commit
says `Closes K<n>` and edits the list). `docs/BUILD-PLAN.md` is the architecture authority; when it
and anything else disagree, the plan wins and the disagreement is worth reporting. `docs/HANDOFF.md`
is FROZEN history as of 2026-09-17 — read a `§` it is pointed at, never append to it.

---

## Non-negotiables — every task, none worth rediscovering

1. **NEVER write to `.../Other App/other-app-live`.** It is the owner's live project.
   Read-only, always. Same for `.../other-app-pipeline`.
2. **Read the predecessor database only as** `sqlite3 "file:...jobs.db?mode=ro" "SELECT ..."`.
   **Never `require('./database.js')`** — importing it runs its migration chain.
3. **No LLM and no network in the ingest or scoring path** (D8).
4. **Serialize test runs.** One vitest holder across all sessions (`/tmp/fpj-vitest.lock`; the lane's
   gate windows are in `docs/STATE.md` and a suite may not hold the lock inside one). One holder of
   `pnpm dev` (:8787) or `pnpm dev:web` (:5173). **Any count produced during overlap is worthless.**
5. **Stop and ask a human** before: spend beyond Cloudflare Paid + Neon's tier, deviating from a
   plan §1 decision, any write to `other-app-live` or `~/other-app-data`, DNS, email to a real
   address, a public preview deploy, CAPTCHA/bot-protection evasion, a backfill's `--apply`, or firing
   a sweep. Full list: plan §0.6.
6. **Delegate implementation to subagents and be the orchestrator.** Write the brief (pattern:
   `docs/ROUTER.md` "Writing a brief"), own the contention files first, verify independently, commit.
   The tree hot-reloads into the owner's browser: **every save must parse**, and a merge that ADDS A
   DEPENDENCY needs `pnpm install` in the main checkout plus a dev-server restart with the queue empty,
   then a `/health/db` poll. **Monitor silence is not health; poll.**
7. **Verify by content, never by exit code.** `git show origin/main:<path>` (never bare `main`) for a
   landing; read a perturbed file back; a control must fail in the direction you fear. The full
   catalogue of ways a control has lied is `docs/VERIFICATION-SPECIES.md` — required reading before
   writing or checking any negative control, and linked from every brief.
8. **Every Agent call gets a cheaper model** (sonnet default). Stage commits by named path — the main
   checkout is shared.

**Definition of done, every task:** the task's own DoD · `pnpm test` passes twice · `pnpm typecheck`
exit 0 with no `any` added to silence it · a new route or MCP tool ships its isolation test · one
commit per task carrying its verification output · the README K-entry closed in the same commit.

---

## Route by what you are doing (the daily rows; every row is in `docs/ROUTER.md`)

| If you are… | Read |
|---|---|
| **Any seat, cold** | `docs/STATE.md` → `docs/log/<today>.md` → `docs/OWNER-DECISIONS.md`. First useful sentence in ≤3 tool calls. |
| **The SEARCH seat** (owner's live workflow through the `sample-app` MCP; never his Chrome) | `docs/SEARCH-SEAT-HANDOFF-2026-09-14.md` highest-numbered section, then `docs/DRAFT-REVIEW-NOTES-2026-09-11.md` §2 (the numbered sub-sections). The app is the record: cards, notes, kit. The seat writes decisions and kit changes only. `save_application`/`skip_jobs` on the owner's word. |
| **The BUILDER** | README §Known issues top to bottom; brief from the pattern in `docs/ROUTER.md`; species list in every brief header. |
| **OPS (a live run day)** | `docs/log/<yesterday>.md` ops block, `docs/WORKDAY-UNPARK-RUNBOOK.md`, the lane scripts' README. Publish gate windows to `docs/STATE.md` before arming. |
| **Writing a brief** | `docs/ROUTER.md` "Writing a brief for a subagent" — the pattern, the newest examples, the control rule. |
| **A strange test failure** | `docs/ROUTER.md` "Hitting a strange test failure" — K67 is fixed; the platform traps are HANDOFF §6. |
| **About to argue a decision** | `docs/OWNER-DECISIONS.md`, then HANDOFF §8 / §11. Do not relitigate. |
| **Anything else** | `docs/ROUTER.md`. |

---

## Maintaining this file

Update it when a *destination* changes. Never for a count, a status or a hash. Keep it under 8 KB
(`wc -c CLAUDE.md`) — it loads into every context of every agent; a row that is not hit daily belongs
in `docs/ROUTER.md`. The previous 32 KB version is `docs/archive/CLAUDE-2026-09-17.md`.
