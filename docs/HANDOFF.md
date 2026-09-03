# HANDOFF — the running record

## §0 How to work
Orchestrator writes briefs, dispatches subagents, verifies independently, commits. One commit per
task with verification output in the message. Subagents never commit. See `CLAUDE.md`.

Practicalities that are not in the plan:
- `pnpm build` before using the CLI (`node packages/server/dist/cli.js …`); `dist/` is gitignored.
- Parallel agents work by file ownership stated in the brief; two agents may share a file only
  by named regions (§7.8) and both should expect the other's mid-flight typecheck failures.
- Every brief ends with a Definition of done that runs the built artifact, not just the tests
  (§7.4 and §7.5 were both caught only that way), and a protective-test control verified the
  CLAUDE.md way (perturbation read back, compiles, fails in the feared direction).
- The rate limit can kill agents mid-task (2026-09-03, two at once). Their files stay on disk
  and `SendMessage` to the same agent id resumes with full context; check `git status` and
  run the suite first to see what landed.
- `.repoboard/events.jsonl` is gitignored and ephemeral; the cards are not.

## §1 What has landed
(append-only; newest at the bottom)

- 2026-09-02 — Repo created. Plan written (`docs/BUILD-PLAN.md`).
- 2026-09-02 — P0.1, P0.2, P1.1–P1.4 landed (core-agent). 61 tests. Core exports `Card` with a `body` field; `computeBoardSummary` takes `now` as a third argument; `createCard` throws on unknown status. TypeScript resolved to 7.x (native tsc).
- 2026-09-03 — P2.1–P2.4 (server-agent) and P3.1–P3.5 (web-agent) landed. 117 tests, bundle 120 KB gzipped against a 600 KB control. Orchestrator verified the thesis on the built server: `sed` on a card file → WS `card` message in 282 ms, with a synthesized `actor: file` event in `events.jsonl`. Wire contract additions beyond plan §3 are listed in the P2 report and are additive: `invalid`, `config`, `warning`, `error` WS messages; `GET /api/cards/:id`; `POST` returns 201; WIP warnings in an `x-rcb-warnings` header. Open follow-ups K2–K5.
- 2026-09-03 — P4.1–P4.4 (map-agent) and P5.1–P5.2 (mcp-agent) landed; K2, K3, K4 closed. 142 tests, bundle 134.6 KB gzipped. Map on this repo: 119 files, 113 import edges, layout under 1 ms; Homebrew clone (3,220 files) 2 ms layout via aggregation. MCP: 7 tools over stdio, `claude mcp add rcb -- npx rcb mcp`. **Paused before P6 at the owner's request.** Remaining: P6.1 README+screenshots, P6.2 npx-from-tarball, P6.3 owner decisions O1–O3 (`docs/P6-SHIP-BRIEF.md` is ready to dispatch). K5 (core exports TS source only) is a P6.2 concern.
- 2026-09-03 — P6.0 (ship-agent) landed: `rcb` → `repoboard`. Packages `repoboard`, `@repoboard/core`, `@repoboard/web`; bin `repoboard`; data dir `.repoboard/` (27 cards git-mv'd, this repo keeps `prefix: RCB`); default prefix `RB`; `REPOBOARD_ACTOR`; `x-repoboard-warnings`; `localStorage` `repoboard.*`. 143 tests (+1 pinning the default prefix), typecheck/lint 0, bundle 134.6 KB. `\brcb\b` hits: 91 files → 36, all docs history, the rename's own from→to spec lines, and this repo's card ids. Orchestrator re-ran suite and `init`/`card add`/`card list` on the built binary in a fresh temp repo: `RB-1`, `RB-2`.
- 2026-09-03 — K6 + P6.2 (ship-agent) landed. `card list --json` compact rows, one per line, `--full` for bodies; MCP `list_cards` shares `toRow`/`formatRows`, `full: true`. Bytes on 27 cards: json 18,290 → 6,435; full 16,833; table 2,149; MCP result 8,506 → 6,432 (MCP rows were already compact — the brief was wrong there; the saving is the formatter). Root `pnpm build` runs `scripts/copy-web.mjs` into `packages/server/dist/web`. `repoboard@0.1.0` manifest: not private, bin, engines ≥20, MIT, `files: [dist]`, no `repository` (O2); `@repoboard/core` moved to devDependencies because tsup bundles it and a packed `workspace:*` would resolve to a registry lookup. Tarball 267 KB packed / 922 KB unpacked, 8 files, no tests, no `.repoboard/`. Smoke in a temp repo: `npm install <tgz>`, `npx repoboard init|card add|card list|serve --port 4545`, `/` served the built HTML. 144 tests. Open: `src/version.ts` must equal `package.json` by hand — no test pins it.

## §7 Things learned the hard way
(numbered, append-only)

1. **Hand-written frontmatter breaks on colons in titles** (K1). The orchestrator wrote 24 cards by hand and 7 were invalid YAML. Core's parser was right to reject them; the fix is quoting, and the lesson is that the dogfood board is a test fixture — run the cards through `parseCard` before trusting them.
2. **The core purity control was verified the right way**: perturbation read back, suite loaded (main tsconfig exit 0), assertion failed with the expected violation, restored by targeted `sed` not `git checkout`. Keep that shape for every protective test.
3. **The `ws` client can deliver the first frame before `open` resolves.** The server sends `snapshot` right after the upgrade, so it arrives in the same chunk; `ws` unshifts that data before emitting `open`, and a test that attaches its `message` listener after `await connect()` misses it — a 3-in-6 flake that looked like a server timing bug. Attach the listener synchronously in the `open` handler and buffer. Browsers do not have this window.
4. **tsup `splitting` breaks an `import.meta.url === argv[1]` main-module guard**: the CLI's code lands in a chunk, the guard is false, and `card list` prints nothing with exit 0. `splitting: false` for a bin. A DoD that runs the built binary is what caught it.
5. **Plain `git ls-files` lists tracked files only.** The scanner saw 69 of 109 files because everything written this session was untracked. Use `--cached --others --exclude-standard`.
6. **Auto-fixable lint (`organizeImports`, format) costs an agent nothing to leave behind but costs the orchestrator a round trip.** Briefs should say "run `biome check --write` before reporting."
7. **The MCP SDK's stdio transport does not close when stdin ends**, and an open chokidar watcher keeps the process alive, so `echo … | rcb mcp` hung for two minutes. `serveMcp` closes on stdin `end`. Any long-lived subcommand that opens the store needs an explicit exit path.
8. **Two agents editing the same file by line ownership worked** (types.ts: `Event` vs `RepoSnapshot`) but each saw the other's mid-flight typecheck failures. Cheap here; for anything larger, split the file first.
9. **An agent that moves a card with `--as` does not set `assignee`.** Actor is who did the move; assignee is who owns the card. The mcp-agent's cards showed "unassigned" on the map. Briefs should say to set both, or the CLI's `move` should offer `--assign`.

## §12 What to work on next
- §12.0a (2026-09-02): P0 and P1 are the current work. P2 and P3 can run in parallel once P1
  lands, because §3 fixes the wire contract between them.
- §12.0b (2026-09-02): P2 (server-agent) and P3 (web-agent) dispatched in parallel against plan §3. Next: reconcile their contract decisions, then P4 (`docs/P4-MAP-BRIEF.md`) and P5 (`docs/P5-MCP-BRIEF.md`) in parallel.
- §12.0c (2026-09-03): P2 and P3 landed. Next: P4 (`docs/P4-MAP-BRIEF.md`) and P5 (`docs/P5-MCP-BRIEF.md`) in parallel; P5's agent also fixes K2–K4 in core since it is the only one touching server internals at that point.
- §12.0d (2026-09-03): P4 and P5 landed. **Paused before P6 by the owner.** When resumed: dispatch `docs/P6-SHIP-BRIEF.md`; P6.3 needs O1–O3 answered first.
- §12.0e (2026-09-03): O1–O3 answered (plan §11). P6 rename to `repoboard` is the first P6 step; K6 goes into P6.2's brief. Still paused until the owner says go.
- §12.0f (2026-09-03): P6.0 rename committed. Next: K6 + P6.2 in one dispatch (tarball, package manifest, compact list), then P6.1 README + screenshots last so it sees final names and numbers. P6.3 (GitHub, K5 per O4, tag) is the owner's.
- §12.0g (2026-09-03): K6 and P6.2 committed. Next: P6.1 README + screenshots (last, sees final names and numbers), plus a test pinning `version.ts` to `package.json`. Then P6.3 is the owner's.
