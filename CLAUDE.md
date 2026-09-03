# repoboard (Remember · Connect · Build) — routing anchor

**This file routes; it does not restate.** It carries no test counts, commit hashes, or task
status, because those move and a stale router is worse than none. Every fact lives in one place
and this file says which place. If you need a number, get it from the section named below or
measure it.

`docs/BUILD-PLAN.md` is **the authority** — decisions in §1, file and wire contracts in §2–§4,
tasks in §5, owner-only decisions in §11. `docs/HANDOFF.md` is the running record; its §12.0x
subsections are append-only and the highest letter is current.

**Picking this up cold as orchestrator:** `docs/NEXT-AGENT-PROMPT.md` (check its date against the
highest HANDOFF §12.0x letter), then plan §11, then `git log`. Briefs live in `docs/P*-BRIEF.md`;
the most recent is the pattern. Lessons that cost time are HANDOFF §7, numbered.
- Unfinished work: `README.md` §"Known issues", a numbered list `K1` upward. A commit that closes
  one says `Closes K<n>` and edits that list in the same commit.

---

## Non-negotiables — these apply to every task

1. **NEVER write to `~/Projects/Repos/Job Seeker/job-seeker-stable`** or `job-seeker-pipeline`.
   The first is the owner's live job search. Read-only, always, from any repo on this machine.
   Never `require` its `database.js`; importing it runs a migration chain as a side effect.
2. **Serialize test runs.** Two agents running the suite at once against a shared local resource
   produce failures indistinguishable from real regressions. Any count produced during overlap is
   worthless. Only one holder of the dev server at a time.
3. **Stop and ask a human** before: spending money, any write to the owner's real data, DNS,
   email to a real address, a publicly reachable deploy, any scraper needing CAPTCHA or
   bot-protection evasion, or deviating from a recorded plan decision.
4. **Delegate implementation to subagents and be the orchestrator** — the owner's standing
   instruction. You write briefs, review, verify independently, and commit. If the tree
   hot-reloads into the owner's browser, **every save must parse**; briefs demand a per-save
   parse check.
5. **Tests never touch real data.** Destructive scripts dry-run by default and take an explicit
   `--apply`. Migrations run from empty, and CI proves it on every run.

**Definition of done, every task:** the task's own DoD from the plan · tests pass · typecheck
exit 0 with **no `any` added to silence it** · one commit per task, carrying its own verification
output in the message.

---

## Conventions for code and data

- **A missing answer is stored as `null`, never as a plausible number.** If the input is
  insufficient, say so in the data.
- **An unconfigured rule must be inert, not dangerous.** An empty config yields everything, not
  silently nothing.
- **One function per guarantee, and it takes no argument that could weaken it.** A guarantee that
  lives in a convention gets forgotten; one that lives in the only code path cannot be.
- **Every stored value carries its provenance.** A number nobody can attribute is a number nobody
  can debug.
- **Adjustments are reversible and audited.** Keep the pre-adjustment value and a row saying why.
- **Claims carry numbers.** In docs, briefs, and commit messages, where there is no measurement,
  say so rather than reaching for an adjective.

---

## Two habits that catch what tests do not

**Ask for measurements, not conclusions.** The most valuable findings on the predecessor project
were numbers that **contradicted the brief that produced them** — often the orchestrator's own
error. Ask for the table, not the verdict, then re-measure it yourself.

**Trust a protective test only after watching it fail.** Break the thing it protects, **confirm
the perturbation applied by reading the file back** — an exit code will lie to you — then confirm
the test catches it. Five species of vacuous control have been observed, four of which look like
they ran:

1. a `sed` that landed on a **comment** and changed nothing;
2. `git checkout -- <file>` used to revert a control, which **discarded the whole uncommitted
   edit** rather than just the perturbation;
3. an **unexported shell variable**, so the perturbation never applied;
4. a perturbation that left the file **uncompilable**, so the suite failed to LOAD — an exit code
   indistinguishable from a control that works;
5. a perturbation that **escaped into another session's commit** through the shared git index.

So the rule has three parts: **verify the perturbation APPLIED (read the file back), that it
COMPILES (typecheck with it in place), and that it points in the DIRECTION YOU FEAR.** A control
written to catch an overcount leaves the undercount unguarded. Brief a control as a demand to be
verified, not a step to be followed.

**Verify by CONTENT, never by an exit code.** A merge can succeed, print a commit, and push
cleanly while landing nothing on the target branch. `git show <branch>:<path>` is the check. The
same applies to a peer's number: ask what it was measured on before you accept it, especially when
it agrees with you.

---

## Maintaining this file

Update it when a *destination* changes — a doc is added, a section is renumbered, a phase ends.
Do **not** update it when a count, a status, or a commit hash changes; if you feel the urge to put
one here, the right fix is a pointer to where it already lives.
