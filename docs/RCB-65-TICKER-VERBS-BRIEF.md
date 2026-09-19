# Brief — RCB-65 RCB-56 follow-ups: a verb per event type in the Ticker; AGENTS MCP tool list + count (2026-09-19)

One agent (sonnet). The builder seat verifies, gates, commits, pushes. Nothing else is in
flight on this repo. Never `git add/stash/checkout/restore`; you do not commit.

Baseline on `main` @ fb2baff: 807 passed | 2 skipped (809), 48 files ×2; typecheck 0;
biome clean; build 0.

## The two findings (RCB-56 landing fb2baff, "found, not fixed")

### 1. `packages/web/src/components/Ticker.tsx` — one verb for every event type

`Line` renders every event as `<actor> moved <cardId> <title> → <to>`. There are NINE
`Event.type`s (`packages/core/src/types.ts` ~line 148–181, read the doc comment — it says
what `from`/`to`/`cardId`/`resource`/`letter` carry per type). A `columns` event today reads
`builder moved  → backlog,decide,todo,doing,done`; a lease event reads `ops moved  → released`.

Render exactly this per type (`<id>`/`<resource>` in the existing `.mono` span, `<title>` in
`.ticker__title` via `shortTitle`, absent when there is no cardId or the card is gone — keep
RCB-44's rule; `<actor>` via `shortActor`; the `· <relTime>` suffix unchanged on every line):

| type | rendered text (spaces as shown) |
|---|---|
| `move` | `<actor> moved <id> <title> → <to>` — unchanged, the three existing tests must still pass verbatim |
| `create` | `<actor> created <id> <title> in <to>` |
| `update` | `<actor> updated <id> <title>` (from === to; no arrow) |
| `ask` | `<actor> asked on <id> <title>` |
| `decide` | `<actor> decided <id> <title>` — plus ` → <letter>` (letter in `.mono`) only when `letter` is present |
| `archive` | `<actor> archived <id> <title>` (`to` is the literal `archive`; do not print it) |
| `lease` | `to === 'released'` → `<actor> released <resource>`; otherwise `<actor> took <resource>` |
| `window` | `<actor> added window <to> on <resource>` (`to` is the window name) |
| `columns` | `<actor> set columns → <to>` (`to` is the comma-joined ids, in `.mono`) |

Do it as ONE exported pure function next to `shortTitle` — e.g. `tickerVerb(e: Event): string`
returning the verb word(s) — plus the JSX switch in `Line`; the table above is the contract, so
a `switch` over `e.type` with NO `default` branch that types as exhaustive (`const _: never =
e.type` or the return-type trick) — a tenth type added later must fail typecheck here, not
silently read "moved". `resource` is optional on the type: render it as `''`-safe (an empty
mono span is fine; never `undefined` in the text). The empty-state line ("No moves yet…") and
the fun/static/scroll structure are untouched.

Tests in `packages/web/test/ticker.test.tsx` — one `it` per non-`move` type (8), each asserting
the full line via `toHaveTextContent` on `document.querySelector('.ticker')` (the existing
tests query `getByText(/moved/)`; yours must not depend on the word "moved"). `decide` gets two
cases (with and without `letter`); `lease` gets two (`took`, `released`). So 11 new `it`s. Use
the existing `moveEvent(overrides)` helper — for `lease`/`window`/`columns` pass `cardId: null`
and (lease/window) `resource: 'vitest-lock'`. Assert `.ticker__title` is ABSENT on the
`cardId: null` lines.

### 2. `docs/AGENTS.md` — the MCP tool list is short by two and the count is stale

- §3 (~line 136–142) "Tools: …" sentence lists 20 names; `MCP_TOOL_NAMES` in
  `packages/server/src/mcp.ts` has 22 — `archive_cards`, `sync_issues` (P8.5, section 12) are
  missing. Add them in the same style ("`archive_cards`, `sync_issues` (P8.5, section 12)")
  after `cost`. Then PIN it: a test in `packages/server/test/mcp.test.ts` (which already
  imports `MCP_TOOL_NAMES`) reads `docs/AGENTS.md` relative to the repo root (the pattern:
  `packages/core/test/board.test.ts` ~line 302, "README.md §Config example" — `fileURLToPath` +
  `../../..`), slices from the literal `Tools: ` (first occurrence after the `## 3. MCP`
  heading) to the literal `Call \`list_cards\``, extracts every `` `[a-z_]+` `` token, and
  expects the sorted set to equal `[...MCP_TOOL_NAMES].sort()`. A `toContain('## 3. MCP')`
  sanity assert first, like the README test's `toContain('columns:')`.
- §9 "Bytes (O3)" table (~line 435) row "MCP tool schema, **14 tools** (measured via …)" is a
  dated P8.2 measurement, not wrong — but a reader takes it as current. Relabel that row's
  first cell to `MCP tool schema, **14 tools** (P8.2, 2026-09-17 — measured via …; the current
  count and bytes are in section 3)`; leave its number. Same one-clause pointer on the §10
  "18 tools", §11 "19 tools", §12 "21 tools" rows (find them with `grep -n 'tools\*\*'`).
- §3, one new sentence right after the tool list (before "Call `list_cards`…"): `All 22 tools'
  schema, via client.listTools() summing each tool's own JSON.stringify: **N B** (2026-09-19,
  RCB-65).` where N is MEASURED — the test "the full schema, all twenty-two tools, is reported
  here" (~line 133) computes exactly `total` but stays silent. Measure it once with a throwaway
  script under `/private/tmp/…/scratchpad` (NOT in the repo) that builds the server the way
  `rig()` in that test does, and paste the command + its output in your report. Put the
  number with thousands separator, like the tables.

## Rules (CLAUDE.md; docs/RIG.md)

- **No `pnpm test`.** The lock is NOT held for you; run only:
  `pnpm --filter @repoboard/web exec vitest run test/ticker.test.tsx`
  `pnpm --filter repoboard exec vitest run test/mcp.test.ts`
  Never `mkdir`/`rm` `/tmp/fpj-vitest.lock`; never run `scripts/vitest-lock.sh`.
- **Every save must parse**: `pnpm typecheck` after each save, exit 0, **no `any`**. The tree
  hot-reloads into a live board.
- `pnpm lint` clean on your files (`pnpm exec biome check --write <files>` first).
- **Claims carry numbers.** Three controls, each: `grep -n` read-back of the perturbation,
  typecheck WITH it in place (a control that does not compile is species 4 — worthless), the
  failing assertion pasted verbatim, restore by edit (never `git checkout`), `git diff --stat`,
  green again.
  (A) make `lease` render `took` for `released` too → the `released` test fails.
  (B) drop `sync_issues` from the AGENTS §3 sentence → the pin test fails naming it.
  (C) the exhaustiveness guard: add a fake `'zzz'` to the `Event.type` union in `types.ts` →
  `pnpm typecheck` exit ≠ 0 pointing at `Ticker.tsx` (paste the error line); then remove it.

## Owns

`packages/web/src/components/Ticker.tsx`, `packages/web/test/ticker.test.tsx`,
`packages/server/test/mcp.test.ts` (one new `it` only), `docs/AGENTS.md` (§3 sentence + the
four table-row labels only). Nothing else; `types.ts` only transiently for control C.

## Tests (numbers in the report)

web ticker: 8 → 19 `it`s (11 new). server mcp: 41 → 42. Nothing else moves.

## Report

Targeted vitest before/after per file (counts); typecheck 0; lint 0; the three controls'
outputs verbatim; the schema-bytes measurement command + output; `git diff --stat`;
found-not-fixed list.
