# docs/SUBAGENTS.md — how this repo runs subagents

This repo's standing instruction is to delegate implementation to subagents and stay the
orchestrator (`CLAUDE.md`, non-negotiable 4). This page is the practice that instruction turned
into: the brief shape, the file allow-list, the parse-per-save rule, the no-commit rule, the
hand-back as measurements, and the watched-failing control. `docs/BRIEF-TEMPLATE.md` is the
skeleton; this page is why it looks the way it does, and what has gone wrong when a step was
skipped.

## 1. Roles

The seat orchestrates: it writes the brief, holds the test-run lock, re-perturbs the subagent's
own control before trusting it, runs the gate, and commits by named path. The subagent implements
inside a file list the brief names explicitly, and never commits, never stages, and never runs the
full test suite.

Three reasons, each tied to something that actually happened rather than a rule assumed in
advance. First, two writers can share one checkout: a subagent that stages or commits can land a
half-finished change under the seat's name, and two sessions once answered to the same seat name
at once, one minute apart, both taking the same card and writing briefs into the same tree before
either noticed the other (the fix for that incident is a guard on coming UP, not a policy — see
item (f) below). Second, a git index is shared state: a stray stage or commit from a subagent can
escape into the orchestrating seat's next commit, which is why only the seat commits, and why it
commits by named path rather than `git add -A`. Third, the tree here hot-reloads into a running
server, so a subagent's save is live before the seat ever reviews it — every save must parse on
its own, which is why briefs demand a parse check (`pnpm -s typecheck`, or the file's own parser)
after each save, not just before reporting back.

## 2. The brief

`docs/BRIEF-TEMPLATE.md` is the skeleton, kept under 3 KB. This section is why each part of it
exists.

- **The problem** names a file and the line that is wrong today, read from the code as it stands
  — not recalled or guessed at. A brief that describes a symptom without reading the line risks
  briefing a fix for the wrong cause.
- **"Exactly this, nothing wider"** bounds the change to what the named problem needs. A subagent
  that drifts from a named bug into an adjacent cleanup produces a diff that is harder to verify
  and a control that is harder to write, because the control now has two things to isolate.
- **The file allow-list**, ending in "anything else: stop and report," is the actual scope
  enforcement. A sentence telling an agent to touch only certain files is a convention; an agent
  told to stop and report rather than improvise when it hits a wall is a check that fires before
  the diff grows past what the brief can verify.
- **The report-back is measurements**, never verdicts: `git diff --stat`, the vitest summary line
  pasted verbatim, exit codes, the accessor used for a shared value. Not "tests pass" — a verdict
  from the same agent that wrote the change is the thing least worth trusting on its own word, and
  a pasted number is at least checkable against a second run.

Landed briefs are kept beside the running log, so the next seat can see the shape that actually
worked on a real card, not only the empty skeleton.

## 3. The control

Every brief that lands a fix specifies a control: a test that must FAIL with the fix reverted and
PASS with it applied. "Watched failing" has three parts, and a control that skips any one of them
has, here, looked like it ran while catching nothing:

1. **The perturbation APPLIED.** Revert the fix and read the changed line back. An exit code does
   not prove the file changed under you.
2. **It COMPILES.** Typecheck with the perturbation in place. A perturbation that leaves the file
   unable to load fails the suite for the wrong reason — a load failure and a caught bug produce
   the same red exit code.
3. **It points in the DIRECTION FEARED.** Read the failing assertion's message, not just the exit
   code. A control written to catch an overcount does not, by that fact alone, guard against an
   undercount.

Six species of vacuous control have been observed on this project, five of which looked like they
ran:

1. A `sed` that landed on a comment and changed nothing.
2. `git checkout -- <file>` used to revert a control, which discarded the whole uncommitted edit
   rather than just the perturbation.
3. An unexported shell variable, so the perturbation never reached the process under test.
4. A perturbation that left the file uncompilable, so the suite failed to load — an exit code
   indistinguishable from a control that actually works.
5. A perturbation that escaped into another session's commit through a shared git index.
6. A "nothing was created" check made with `git status`, which does not track empty directories.
   Two empty directories left behind by a bug read as a perfectly clean `git status --porcelain`.
   When the property under test is "nothing was created," assert on the filesystem directly —
   the tool reached for to summarize a repo's state is allowed to omit what it considers
   uninteresting.

The seat re-perturbs the control itself before landing, on its own checkout, and reads the failure
back rather than trusting the subagent's description of one. A subagent's report that "the control
was verified" is a claim; the seat's own read of the reverted file and its own failing run is the
measurement.

## 4. What has gone wrong

A numbered list, one line each, each carrying the lesson it produced:

(a) A shell string-replacement command ate `${…}` inside a template literal, turning a filename
    into a literal empty value in the output. Caught by the agent's own test, not by review.
    Files containing template literals get edited with an editor tool or a small script, and the
    changed line gets read back — not a shell one-liner that treats the file as plain text.
(b) Backticks inside a help-text template literal broke typecheck, the build, and four test files
    in one save. The per-save parse check is what catches this class of failure before it
    compounds across the rest of a session.
(c) A brief named one file encoding a value that needed to change and missed a second test file
    encoding the same value three separate times. The seat aligned all three literals by hand
    rather than writing a second brief. A brief's file list is a hypothesis about where a value
    lives, not a guarantee; a grep for the old value across the tree is the check that closes the
    gap a brief's guess leaves open.
(d) A test assumed an ordering that the change under it reversed. Only the full suite caught it —
    the targeted run on the touched files did not, because the ordering assumption lived in a
    third file neither brief nor targeted run touched. Fixed as a test change, once the new
    ordering was confirmed to be the correct one and not a regression.
(e) Lint failures (non-null assertions, import order) were left in a subagent's output, costing
    the orchestrating seat a manual round trip to fix them. Briefs now say to run the linter's
    autofix before reporting back, not after being told to.
(f) Two sessions answered to the same seat name in one checkout, one minute apart, and both took
    the same card and wrote briefs into the same tree before either noticed the other. Nothing in
    the tooling refused it. The fix: coming UP on a seat name already UP inside a recent window is
    refused unless forced, and a forced override writes an audit entry to the log first.
(g) A brief leaned on a guard in a lower layer as though it protected a surface built on top of
    it, without checking a bad value could reach that guard. It could not: the surface under
    change built its input from a fixed set of fields that never included the one the lower-layer
    guard refused, so the guard was unreachable from that path and the surface's own check was
    the entire guarantee, not a backstop. Prove a bad value can reach a guard before trusting it.
(h) A brief's own specified fix became the next bug: a suppression rule written to silence one
    case (a synthesized event duplicating one already logged) also matched a case it should not
    have, which would have silently dropped a real, unrelated event under a later edit. Caught by
    measuring the fix's effect, not by trusting the brief's stated reason for it. A brief's fix is
    a hypothesis to be measured, not a step to be carried out on faith.

## 5. Gate at landing

Before any subagent's diff is treated as landed:

- Targeted vitest on the touched files while the change is being built and reviewed.
- The full test suite, run twice, under a single-runner lock. Two agents running the suite at once
  against a shared local resource produce failures indistinguishable from real regressions, so
  only one holder runs it at a time; running it twice catches a control that passed once by luck.
- Typecheck: exit 0.
- Lint: exit 0.
- Build: exit 0.
- One commit per card, carrying the gate's own numbers in the commit message — the actual counts,
  not a claim that "tests pass."
- Verification by content, never by exit code: `git show <branch>:<path>` (or the remote
  equivalent) read against the pushed ref. A merge or push can succeed, print a commit, and still
  land nothing on the target branch. The same applies to a peer's reported number — ask what it
  was measured on before accepting it, especially when it agrees with what you expected.

## 6. Not yet built

Whether this repo should also keep a per-card record of each subagent run — duration, tokens,
cost — is an open question for the project's owner, not a decision made here. This page describes
the practice as it runs today; a record of what each run costs would be a separate, dynamic
surface layered on top of it, not a rewrite of it.
