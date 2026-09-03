# HANDOFF — the running record

## §0 How to work
Orchestrator writes briefs, dispatches subagents, verifies independently, commits. One commit per
task with verification output in the message. Subagents never commit. See `CLAUDE.md`.

## §1 What has landed
(append-only; newest at the bottom)

- 2026-09-02 — Repo created. Plan written (`docs/BUILD-PLAN.md`). Nothing built yet.

## §7 Things learned the hard way
(numbered, append-only)

## §12 What to work on next
- §12.0a (2026-09-02): P0 and P1 are the current work. P2 and P3 can run in parallel once P1
  lands, because §3 fixes the wire contract between them.
