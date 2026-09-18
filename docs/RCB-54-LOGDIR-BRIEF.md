# Brief — RCB-54 `log --last` / `seat` honour `logDir`; heading regex accepts fpj's shape (2026-09-18)

One agent (sonnet). The builder seat verifies, gates, commits, pushes. Nothing else is in flight
on this repo.

Baseline on `main` @ e40d5c1 (code unchanged since 6ddc269): 687 passed | 2 skipped (689),
typecheck 0, lint 0, build 0 — measured by the previous builder at the 6ddc269 gate.

## The bug, re-derived by the builder before this brief (HANDOFF §7.13)

On the sibling board (`board.yml` has `logDir: docs/log`; 45 blocks on 09-18) both
`repoboard log --last ops` and `repoboard seat ops` print `(no log block for ops)`. Two
independent causes, each sufficient on its own:

1. **`store.lastRepoLogBlock`** (`packages/server/src/store.ts:612`) reads
   `loadLogInfoFrom(this.logDir)` — `.repoboard/log/` only. `check` (`store.ts:647`) already
   reads `loadAllLogInfo()` = own dir + `cfg.logDir`. The doc comment above it argues own-dir-only
   is by definition correct ("a seat's own last block is one it wrote with `repoboard log`");
   the sibling's seats write their blocks to `docs/log/` by hand, so the premise is false in the
   field. `seatBundle` (`store.ts:625`) inherits the same gap for both the own and coordinator
   blocks.
2. **`BLOCK_HEADING`** in `packages/core/src/repolog.ts:61` is
   `/^##### (\S+) (\S+): (.*)$/gm`. The sibling's real headings, digits redacted to `N`,
   measured with `grep -h '^#####' docs/log/*.md | sed 's/[0-9]/N/g' | sort | uniq -c` on 09-18:
   - `##### OPS NNNN-NN-NN NN:NxZ: <TITLE>` (14) — a SPACE between date and time → `(\S+)` takes
     the date, then demands `: ` and finds ` NN:NxZ:` → no match.
   - `##### COORDINATOR NNNN-NN-NN NN:NxZ: …` (≈30), `##### BUILDER NNNN-NN-NN NN:NxZ: …` (16)
   - `##### OPS NNNN-NN-NN NN:NxZ (addendum): …` (1) — a parenthetical after the time.
   - `##### COORDINATOR NNNN-NN-NN Nx:xxZ: …` (1) — an `x`-redacted hour.
   - `##### COORDINATOR/SEARCH NNNN-NN-NN NN:NxZ: …` (1) — a slash in the seat.
   - `##### BUILDER (fresh, fNNbeN) NNNN-NN-NN NN:NxZ: …` (1) — a parenthetical in the seat.
   - `##### COORDINATOR NNNN-NN-NNTNN:NN:NNZ: stand-up NN:NxZ: …` (1) — OUR shape, and the title
     itself contains `: ` — a lazy match must stop at the FIRST `: ` after the timestamp.
   The exact 09-18 count you should reproduce in a fixture test is whatever the real file
   parses to after the fix; measure it (read-only) with a one-off script and paste the number.

## Rules (CLAUDE.md; HANDOFF §7)

- **You do not commit.** Leave the tree dirty.
- **Stay inside your file list.** Need another file → stop and report.
- **The sibling repo at `~/Projects/Repos/freshpickedjobs` is READ-ONLY. Never write there,
  never `require` anything from it.** Copy the heading LINES you need into a fixture; redact
  nothing else (digits are fine to keep; the log is public on the sibling's own terms — but do
  NOT copy block bodies, only the `#####` lines and a one-line placeholder body).
- **No `pnpm test`.** The builder already holds `/tmp/fpj-vitest.lock` for this session — do
  not `mkdir` it, do not `rm` it. Run vitest only on your own test files:
  `pnpm --filter @repoboard/core exec vitest run test/repolog.test.ts test/seat.test.ts`,
  `pnpm --filter repoboard exec vitest run test/store.test.ts test/cli.test.ts`.
- **Every save must parse**: `pnpm typecheck` after each `.ts` save, exit 0, **no `any`**.
- `pnpm lint` clean on your files before reporting (`biome check --write` on them first).
- **Claims carry numbers.** Controls verified the CLAUDE.md way (perturbation read back by
  `grep -n`, typecheck with it in place, failing assertion pasted, targeted restore proved by
  `git diff --stat`; never `git checkout`).

## Owns

`packages/core/src/repolog.ts`, `packages/core/test/repolog.test.ts`,
`packages/core/test/fixtures/` (new fixture file, name it `sibling-log-headings.md`),
`packages/server/src/store.ts` (only `lastRepoLogBlock`, its doc comment, and `loadAllLogInfo`
visibility if needed), `packages/server/test/store.test.ts`, `packages/server/test/cli.test.ts`,
`docs/AGENTS.md` (§10 only: the sentence that says `log --last`/`seat` read `.repoboard/log/`,
if one exists — say if it does not).

## Design

### Cause 1 — store

`lastRepoLogBlock(seat)` calls `this.loadAllLogInfo()` instead of `loadLogInfoFrom(this.logDir)`.
Rewrite its doc comment to say why: `check` and `seat` must agree on what "the log" is (P8.6
locked decision 1 — `logDir` is an ADDITIONAL read-only source; `repoboard log` still writes only
`.repoboard/log/`). `lastBlockFor` already sorts by date desc and takes the last block in a day,
so two files with the same date (one per dir) both contribute; keep that behaviour and say so in
a test — do not dedupe.

### Cause 2 — core regex

Replace `BLOCK_HEADING` with a regex whose contract is:
- seat = everything after `##### ` up to the space before the first `YYYY-MM-DD` token (lazy);
- ts = from that date token, lazily, up to the FIRST `: ` (colon-space);
- title = the rest of the line.
Suggested: `/^##### (.+?) (\d{4}-\d{2}-\d{2}.*?): (.*)$/gm`. Verify against every shape listed
above and against the two existing tests (`OPS 2026-09-17T18:00:00Z`, `CLAUDE/P8-3 …`) — those
must not change. Update the doc comment on `formatLogBlock` if it claims the heading is strictly
`<SEAT> <ISO>` — the WRITER still emits exactly that; only the READER widened.
`LogBlock.ts` keeps its type `string`; note in the comment that it is no longer guaranteed
parseable as a Date (the web's `relTime` gets `Invalid Date` for the sibling shape — out of
scope, report it, do not touch `packages/web`).

Out of scope, report only: `lastBlockFor` matches `block.seat === wanted` exactly, so
`seat builder` will not find `BUILDER (fresh, f87be1)`; `GET /api/log` still serves own dir only.

## Tests

Core `repolog.test.ts`:
1. Fixture `sibling-log-headings.md`: one line per distinct real shape above (copy the real
   heading lines from the sibling's 09-18 file, one representative each, bodies replaced with a
   one-line placeholder). Assert the parsed count equals the number of `#####` lines, and assert
   `{seat, ts, title}` for at least: the space shape, the `(addendum)` shape, the
   `COORDINATOR/SEARCH` seat, the `BUILDER (fresh, …)` seat, and the title-with-colon shape
   (ts must be exactly `2026-09-18T20:23:38Z`, title starts `stand-up`).
2. Control: with the OLD regex in place, the fixture test FAILS with the count it produced (paste
   the assertion). Restore, re-run, green.

Server `store.test.ts` (next to the existing P8.6 `logDir` describe at ~563):
3. `lastRepoLogBlock` finds a block that exists only in the configured `logDir`; with `logDir`
   removed from board.yml (new store, same disk) it is `null`. Use the SPACE shape for that
   block's heading so this test alone proves both causes fixed together.
4. Same date in both dirs: the block from whichever file is later in `lastBlockFor`'s order is
   returned — assert the observed one and say in the test name that ties are file-list order,
   not "newest".
Server `cli.test.ts`:
5. `repoboard seat ops` on a repo whose only ops block sits in `docs/log/2026-09-18.md` with the
   space shape prints the block under `## Last block — OPS` (not `(no log block for ops)`).

## Report (numbers)

Targeted vitest before/after per file; typecheck 0; lint 0; the fixture's block count; the count
the real sibling 09-18 file parses to after the fix (read-only one-off, paste the command);
the control's failing assertion verbatim; `git diff --stat`; the out-of-scope list above with
anything you found on top.
