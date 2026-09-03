# HANDOFF — the running record

## §0 How to work
Orchestrator writes briefs, dispatches subagents, verifies independently, commits. One commit per
task with verification output in the message. Subagents never commit. See `CLAUDE.md`.

## §1 What has landed
(append-only; newest at the bottom)

- 2026-09-02 — Repo created. Plan written (`docs/BUILD-PLAN.md`).
- 2026-09-02 — P0.1, P0.2, P1.1–P1.4 landed (core-agent). 61 tests. Core exports `Card` with a `body` field; `computeBoardSummary` takes `now` as a third argument; `createCard` throws on unknown status. TypeScript resolved to 7.x (native tsc).
- 2026-09-03 — P2.1–P2.4 (server-agent) and P3.1–P3.5 (web-agent) landed. 117 tests, bundle 120 KB gzipped against a 600 KB control. Orchestrator verified the thesis on the built server: `sed` on a card file → WS `card` message in 282 ms, with a synthesized `actor: file` event in `events.jsonl`. Wire contract additions beyond plan §3 are listed in the P2 report and are additive: `invalid`, `config`, `warning`, `error` WS messages; `GET /api/cards/:id`; `POST` returns 201; WIP warnings in an `x-rcb-warnings` header. Open follow-ups K2–K5.

## §7 Things learned the hard way
(numbered, append-only)

1. **Hand-written frontmatter breaks on colons in titles** (K1). The orchestrator wrote 24 cards by hand and 7 were invalid YAML. Core's parser was right to reject them; the fix is quoting, and the lesson is that the dogfood board is a test fixture — run the cards through `parseCard` before trusting them.
2. **The core purity control was verified the right way**: perturbation read back, suite loaded (main tsconfig exit 0), assertion failed with the expected violation, restored by targeted `sed` not `git checkout`. Keep that shape for every protective test.
3. **The `ws` client can deliver the first frame before `open` resolves.** The server sends `snapshot` right after the upgrade, so it arrives in the same chunk; `ws` unshifts that data before emitting `open`, and a test that attaches its `message` listener after `await connect()` misses it — a 3-in-6 flake that looked like a server timing bug. Attach the listener synchronously in the `open` handler and buffer. Browsers do not have this window.
4. **tsup `splitting` breaks an `import.meta.url === argv[1]` main-module guard**: the CLI's code lands in a chunk, the guard is false, and `card list` prints nothing with exit 0. `splitting: false` for a bin. A DoD that runs the built binary is what caught it.
5. **Plain `git ls-files` lists tracked files only.** The scanner saw 69 of 109 files because everything written this session was untracked. Use `--cached --others --exclude-standard`.
6. **Auto-fixable lint (`organizeImports`, format) costs an agent nothing to leave behind but costs the orchestrator a round trip.** Briefs should say "run `biome check --write` before reporting."

## §12 What to work on next
- §12.0a (2026-09-02): P0 and P1 are the current work. P2 and P3 can run in parallel once P1
  lands, because §3 fixes the wire contract between them.
- §12.0b (2026-09-02): P2 (server-agent) and P3 (web-agent) dispatched in parallel against plan §3. Next: reconcile their contract decisions, then P4 (`docs/P4-MAP-BRIEF.md`) and P5 (`docs/P5-MCP-BRIEF.md`) in parallel.
- §12.0c (2026-09-03): P2 and P3 landed. Next: P4 (`docs/P4-MAP-BRIEF.md`) and P5 (`docs/P5-MCP-BRIEF.md`) in parallel; P5's agent also fixes K2–K4 in core since it is the only one touching server internals at that point.
