# Brief — RCB-47 `repoboard log --last <seat>` (2026-09-18)

One agent, one card. The builder seat (orchestrator) verifies, gates, commits, pushes.

Baseline on `main` @ 405cab5, measured 2026-09-18 by the builder: last gate **629 passed | 2 skipped
(631) ×2, `pnpm typecheck` exit 0, `pnpm lint` exit 0, `pnpm build` exit 0**. Every number you report
is a delta against those.

## Rules (CLAUDE.md; HANDOFF §7)

- **You do not commit.** Leave the tree dirty; the orchestrator verifies and commits.
- **Stay inside your file list** (below). If you believe you need another file, stop and report.
- **Do not run the full suite** (`pnpm test`) and do not run vitest at all unless you hold the
  box-wide lock: `mkdir /tmp/fpj-vitest.lock || exit 1`, then write `"$$ <cwd> <ISO time>"` to
  `/tmp/fpj-vitest.lock/owner`; release with `rm -rf /tmp/fpj-vitest.lock` ONLY if the owner line's
  pid is yours. **Never remove a lock you did not take.** Run only your own test files:
  `pnpm --filter @repoboard/core exec vitest run test/repolog.test.ts` and
  `pnpm --filter repoboard exec vitest run test/cli.test.ts -t "repoboard log"` (check the server
  package name in `packages/server/package.json` first). Each run is short; take and release the
  lock around each one.
- **Every save must parse** — the tree hot-reloads into the owner's browser. After each save of a
  `.ts` file run `pnpm typecheck` (exit 0, **no `any` added**).
- Run `pnpm lint` (biome) before reporting; fix what it flags in your files.
- **Claims carry numbers.** Report measurements, not adjectives.
- **Your protective tests are verified the CLAUDE.md way.** For each control below: apply the
  perturbation, **read the file back** (`grep -n` the changed line) to prove it landed, run
  `pnpm typecheck` to prove it compiles, run the one test and paste the failing assertion, then
  restore with a targeted edit and prove restoration with `git diff --stat` on that file (the file
  must show only your intended feature changes, not the perturbation). Never `git checkout`.

## What exists (read these first)

- `packages/core/src/repolog.ts` — `formatLogBlock`, `appendLogBlock`, `parseLogBlocks`
  (`LogBlock { seat, ts, title, text }`, seat stored UPPERCASED). A block's heading is
  `##### <SEAT> <ISO>: <title>`; the title already defaults to the first line of the text.
- `packages/server/src/store.ts` — `appendRepoLog(seat, text, title)` (writes today's file),
  `log(date?)` (reads one day), and `private loadLogInfoFrom(dir)` which already reads EVERY
  `<dir>/*.md` into `LogFileInfo[] { date, mtimeMs, blocks }`.
- `packages/server/src/cli.ts` — `cmdLogAppend` (the `--as/--title/--stdin` writer) and
  `cmdLogShow` (`log show [--date] [--seat]`); dispatch at ~line 1256; the help text at ~line 122.
- `packages/server/test/cli.test.ts` `describe('repoboard log', …)` (~line 1346) with helpers
  `freshRepo`, `repoboard(root, ...args)`, `repoboardStdin`. The fixture clock is
  `2026-09-02T22:41:10Z` (see `first.out` assertion there).
- `docs/AGENTS.md` §10 CLI table (~line 446) and the top command table (~line 40).

So the writer half of the card ("header carries seat + time + a short title") is **already
landed** (P8.3). Do not re-implement it. RCB-47's delta is the reader and the rule.

## Owns

`packages/core/src/repolog.ts`, `packages/core/test/repolog.test.ts`,
`packages/server/src/store.ts`, `packages/server/src/cli.ts`, `packages/server/test/cli.test.ts`,
`docs/AGENTS.md`, `README.md` (the "Known issues"/CLI mention only if one exists — do not add a K).

## The feature

### 1. Core: `lastBlockFor(seat, files)` — pure, in `repolog.ts`

```ts
export interface DatedLogBlocks { date: string; blocks: readonly LogBlock[] }
/** The newest block written by `seat` (case-insensitive) across the given days, or null. */
export function lastBlockFor(seat: string, days: readonly DatedLogBlocks[]): { date: string; block: LogBlock } | null
```

Rules: compare `seat.toUpperCase()` to `block.seat`. Order days by `date` descending (do not trust
input order — `readdir` order is filesystem-defined), and within a day take the LAST matching block
in file order (newest last is the file's invariant). Return `null` when no day has one. A seat name
that is empty after trim returns `null` (an unconfigured rule is inert).

Tests (`repolog.test.ts`, new `describe('lastBlockFor')`): (a) three days, target seat only on the
oldest and middle day → returns the middle day's LAST block of that seat, not the first; (b) days
passed in ascending order still return the newest day's block (this is the control C1); (c) seat
case-insensitive (`'builder'` finds `BUILDER`); (d) no match → `null`; (e) a seat that is a prefix
of another (`OPS` vs `OPS-2`) does not match.

### 2. Store: `lastRepoLogBlock(seat)` — in `store.ts`

Reads `.repoboard/log/*.md` via the existing `loadLogInfoFrom(this.logDir)` (**own dir only** — do
NOT include `cfg.logDir`; that is `check`'s read-only extra source, and a seat's own last block is
by definition one it wrote with `repoboard log`, which only ever writes `.repoboard/log/`). Returns
`lastBlockFor(seat, infos)`. Fresh from disk each call, never cached, like `log()`.

### 3. CLI: `repoboard log --last <seat>`

Add to the `log` dispatch: when the first arg after `log` is `--last`, call a new `cmdLogLast`.
Output on a hit: the block re-rendered by `formatLogBlock(block)` followed by one `\n` — i.e. the
same text `log show --seat` prints for one block, so a reader can `sed`/`grep` it the same way.
Output on a miss: `(no log block for <seat>)\n`, exit 0 (a cold seat with no history is normal, not
an error). Missing seat name → `UserError` with usage `repoboard log --last <seat>`, exit 1.
`--last` MUST search back across days: a builder that stood down yesterday finds yesterday's block
with no `--date`. Update the help text (line ~122) to:

```
  repoboard log show [--date YYYY-MM-DD] [--seat s]
                                        print a day's log (default today), optionally one seat's blocks
  repoboard log --last <seat>           print that seat's newest block, searching back across days
                                        (cold-start: your own seat's last block, then the coordinator's)
```

Tests (`cli.test.ts`, inside `describe('repoboard log')`):
- (f) two blocks by `builder` on the fixture day plus one by `ops` after them → `log --last builder`
  prints the SECOND builder block's text and NOT the first's, and NOT the ops text. Assert
  `res.out` starts with `##### BUILDER 2026-09-02T22:41:10Z: ` (the heading survives the round trip).
- (g) cross-day: write `.repoboard/log/2026-09-01.md` by hand (header + one `##### BUILDER
  2026-09-01T10:00:00Z: yesterday` block, use `formatLogBlock`/`appendLogBlock` or a literal) with
  no builder block on the fixture day (today) → `log --last builder` returns the 2026-09-01 block
  (this is control C2).
- (h) miss → exit 0, `(no log block for nobody)`.
- (i) `log --last` with no seat → exit 1, stderr mentions usage.

### 4. Docs: the cold-start rule

`docs/AGENTS.md` §10: add the `log --last <seat>` row to BOTH CLI tables (top table ~line 40, §10
table ~line 447), and directly under the §10 table add one short paragraph headed
**Cold-start rule (RCB-47)**: *a seat coming up reads STATE.md, then its own seat's last block
(`repoboard log --last <seat>`), then the coordinator's (`repoboard log --last coordinator`), then
`card list --status todo`. Three commands replace reading the whole day's log.* Keep it to ≤6 lines.
If `README.md` has a CLI summary listing `log show`, add `log --last <seat>` beside it in one line;
if it does not, leave README alone and say so.

## Controls — each one is a demand, not a step

- **C1 (ordering, core test b):** in `lastBlockFor`, remove the date sort (or sort ascending).
  Read the line back. Typecheck. Test (b) must FAIL by returning the older day. Restore.
- **C2 (cross-day, cli test g):** in `lastRepoLogBlock`, replace the all-days read with only
  `this.log()` (today). Read back. Typecheck. Test (g) must FAIL with the miss message. Restore.
- **C3 (newest-within-day, cli test f):** in `lastBlockFor`, take the FIRST matching block of the
  day instead of the last. Read back. Typecheck. Test (f) must FAIL showing the first block's text.
  Restore.

Paste the failing assertion from each into your report.

## Report back (measurements, not adjectives)

1. Test counts from your two file runs, before and after (`N passed`).
2. `pnpm typecheck` exit code; `pnpm lint` exit code and file count.
3. The three control outputs (perturbation line read back, failing assertion, restoration proof).
4. `git diff --stat`.
5. Anything in this brief that turned out to be wrong when you measured it.
