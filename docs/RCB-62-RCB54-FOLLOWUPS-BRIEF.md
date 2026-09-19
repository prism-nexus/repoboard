# Brief — RCB-62 (B6) RCB-54 follow-ups: seat token match, /api/log merged dirs, web relTime (2026-09-19)

One agent (sonnet). The builder seat verifies, gates, commits, pushes. Two OTHER agents work
this tree at the same time (RCB-57: `packages/core/src/seat.ts` + `test/seat.test.ts` +
`docs/AGENTS.md`; RCB-61: `scripts/`, `docs/RIG.md`). Touch nothing of theirs — in particular
NOT `docs/AGENTS.md`: report the row wording you would change and the builder applies it.
Never `git add/stash/checkout/restore`.

Baseline on `main` @ 1fd7ee0 (code unchanged since a263ec9): 758 passed | 2 skipped (760),
47 files; typecheck 0; biome 132 clean.

Three findings from the RCB-54 landing (713d330), each measured on the sibling board
(`~/Projects/Repos/freshpickedjobs`, **READ-ONLY, never write there, never import from it**):

## 1. `lastBlockFor` matches the seat token exactly

`packages/core/src/repolog.ts:111` — `block.seat === wanted`. The sibling's log has a heading
`##### BUILDER (fresh, f87be1) 2026-09-18 …` whose parsed `seat` is `BUILDER (fresh, f87be1)`;
`repoboard seat builder` does not find it. Rule (card text): **match the leading word** — the
seat token's first whitespace-delimited word, compared case-insensitively, equals `wanted`. So
`builder` finds `BUILDER (fresh, f87be1)` and `BUILDER`; it does NOT find `COORDINATOR/SEARCH`
via `coordinator`? — decide: `COORDINATOR/SEARCH`'s leading word is `COORDINATOR/SEARCH`, so
strict leading-word says no. Keep it strict (the card says "leading word", not "prefix"); write
a test that pins that `coordinator` does NOT match `COORDINATOR/SEARCH`, with a comment saying
this is the card's rule and a prefix rule is a separate decision. `wanted` itself: a multi-word
`wanted` (e.g. `repoboard builder`) compares whole against the whole seat token, as today
(keep the existing behaviour for that path — add a test that `repoboard builder` still matches
a `REPOBOARD BUILDER` heading exactly and does not match `BUILDER`).

Fixture: `packages/core/test/fixtures/sibling-log-headings.md` (RCB-54) already has the
`BUILDER (fresh, …)` shape — use it.

## 2. `GET /api/log` (and the WS hello's `log`) read own dir only

`packages/server/src/store.ts` `log(date?)` reads `<.repoboard/log>/<date>.md` only. The
LOG panel on :4243 (the fpj board, `board.yml` `logDir: docs/log`) therefore never shows fpj's
blocks. Fix: `log(date)` returns the MERGED day: own-dir file text, then the configured
`logDir`'s file text for the same date (when `cfg.logDir` is set and the file exists), joined
with a blank line; `blocks` parsed from the merged text; `null` only when NEITHER exists. The
`date` field unchanged. Order own → extra matches `loadAllLogInfo`. Reuse `loadLogInfoFrom`'s
sibling: add a private `readLogDay(dir, day)` helper returning `string | null`, used by `log()`;
do NOT change `loadAllLogInfo`, `lastRepoLogBlock`, or `appendRepoLog` (writes stay own-dir
only — say so in the doc comment). Callers: `repo-context.ts:637` (WS hello), `:900` (GET
/api/log), `cli.ts:934` (`log show`) — all three get the merge for free; add nothing there.

`LogFile` type in core: check whether it carries a `path` or single-file assumption; if it does,
say so and keep the type, the merged text is still one `text`.

## 3. Web `relTime` → `Invalid Date` on `YYYY-MM-DD HH:MxZ`

`packages/web/src/time.ts` `relTime(iso)` returns `''` on `Date.parse` NaN — fine — but the
sibling's stamps (`2026-09-18 21:4xZ`, `2026-09-18 2x:xxZ`) are neither parseable nor blank
in the UI: the card says the panel shows `Invalid Date`. Find where: `LogTimeline.tsx:39` calls
`relTime(b.ts, now)`; if `relTime` returns `''` the rendering is empty, not `Invalid Date` — so
measure first: write a test in `packages/web/test/log-timeline.test.tsx` rendering a block with
ts `2026-09-18 21:4xZ` and assert what appears (`getByText`/`container.textContent`). If the
`Invalid Date` comes from `shortTime` or somewhere else, say so and fix THAT. Rule for the fix:
an unparseable stamp is shown VERBATIM (the human wrote `21:4xZ` on purpose — a redacted minute
is a stamp, not an error), never `Invalid Date`, never blank. `relTime` keeps returning `''`
for garbage; the caller falls back to the raw string. Keep `time.ts` tests (if any) green.

## Rules (CLAUDE.md; docs/RIG.md)

- **You do not commit.** Leave the tree dirty.
- **No `pnpm test`.** The builder holds `/tmp/fpj-vitest.lock` — never `mkdir`/`rm` it. Run
  vitest only on your own files:
  `pnpm --filter @repoboard/core exec vitest run test/repolog.test.ts`
  `pnpm --filter repoboard exec vitest run test/store.test.ts test/http.test.ts test/cli.test.ts`
  `pnpm --filter @repoboard/web exec vitest run test/log-timeline.test.tsx` (check the filter
  name in `packages/web/package.json`).
- **Every save must parse**: `pnpm typecheck` after each save, exit 0, **no `any`**.
- `pnpm lint` clean on your files (`pnpm exec biome check --write <files>` first).
- **Claims carry numbers.** Each of the three fixes gets a control: perturb (read back with
  `grep -n`), typecheck with it in place, paste the failing assertion, restore BY EDIT, prove
  with `git diff --stat`, re-run green.

## Owns

`packages/core/src/repolog.ts`, `packages/core/test/repolog.test.ts`,
`packages/server/src/store.ts` (`log()` + one new private helper + doc comments only),
`packages/server/test/store.test.ts`, `packages/server/test/http.test.ts`,
`packages/web/src/time.ts`, `packages/web/src/components/LogTimeline.tsx`,
`packages/web/test/log-timeline.test.tsx`, plus `packages/web/test/time.test.ts` if one exists.

## Tests

Core: (a) `builder` finds `BUILDER (fresh, f87be1)`; (b) `coordinator` does not find
`COORDINATOR/SEARCH`; (c) multi-word `wanted` exact as before; (d) control on the match rule.
Server store: (e) `log('2026-09-18')` with a block only in `docs/log/` returns it; (f) both dirs
→ both blocks, own first, `text` contains both; (g) no `logDir` configured → own only, as before;
(h) neither → `null`. HTTP: (i) `GET /api/log?date=…` returns the merged text on a board with
`logDir`. Web: (j) the verbatim-stamp render; (k) a parseable ISO still renders `Nm ago`.

## Report (numbers)

Targeted vitest before/after per file; typecheck 0; lint 0; the three controls' failing
assertions verbatim; `git diff --stat`; the `docs/AGENTS.md` row wording for `log --last` /
`seat` / `GET /api/log` (you do not edit it); the real sibling check, READ-ONLY:
`cd ~/Projects/Repos/freshpickedjobs && node <this-repo>/packages/server/dist/cli.js seat builder`
after `pnpm build` — paste the `## Last block — BUILDER` heading line it finds now (the
builder will re-run it).
