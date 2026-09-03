# HANDOFF — the running record

## §0 How to work
Orchestrator writes briefs, dispatches subagents, verifies independently, commits. One commit per
task with verification output in the message. Subagents never commit. See `CLAUDE.md`.

## §1 What has landed
(append-only; newest at the bottom)

- 2026-09-02 — Repo created. Plan written (`docs/BUILD-PLAN.md`).
- 2026-09-02 — P0.1, P0.2, P1.1–P1.4 landed (core-agent). 61 tests. Core exports `Card` with a `body` field; `computeBoardSummary` takes `now` as a third argument; `createCard` throws on unknown status. TypeScript resolved to 7.x (native tsc).

## §7 Things learned the hard way
(numbered, append-only)

1. **Hand-written frontmatter breaks on colons in titles** (K1). The orchestrator wrote 24 cards by hand and 7 were invalid YAML. Core's parser was right to reject them; the fix is quoting, and the lesson is that the dogfood board is a test fixture — run the cards through `parseCard` before trusting them.
2. **The core purity control was verified the right way**: perturbation read back, suite loaded (main tsconfig exit 0), assertion failed with the expected violation, restored by targeted `sed` not `git checkout`. Keep that shape for every protective test.

## §12 What to work on next
- §12.0a (2026-09-02): P0 and P1 are the current work. P2 and P3 can run in parallel once P1
  lands, because §3 fixes the wire contract between them.
