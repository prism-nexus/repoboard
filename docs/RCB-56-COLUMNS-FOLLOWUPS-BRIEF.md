# Brief — RCB-56 RCB-34 follow-ups: README example, CLI/MCP columns surface, a `columns` event (2026-09-19)

One agent (sonnet). The builder seat verifies, gates, commits, pushes. Nothing else is in
flight on this repo. Never `git add/stash/checkout/restore`; you do not commit.

Baseline on `main` @ 743ea3c: 796 passed | 2 skipped (798), 48 files ×3; typecheck 0;
biome 134 clean; build 0.

## The three findings (RCB-34 landing 32da2a1, "found, not fixed")

1. `README.md` §Config example (~line 118–137) still shows the pre-O11 column set with
   `review`; the default (`defaultBoardConfig()` in `packages/core/src/board.ts`) is
   `backlog, decide (Needs decision, decision: true), todo, doing (active, wip 3), done`.
   Make the example the real default, verbatim from `defaultBoardConfig()` — a test pins it:
   `README.md`'s fenced yaml block after "`.repoboard/board.yml` (plan §2; `init` writes this):"
   parses (with the `yaml` package + `parseBoard`) to a config whose `columns` deep-equal
   `defaultBoardConfig().columns`. Put that test in `packages/core/test/board.test.ts` (read the
   README relative to the repo root with `fileURLToPath(import.meta.url)` + `../../..`). Keep
   `name`, `siblings`, `prefix`, `activeWindowMinutes` lines in the example as they are, and the
   prose after it; drop nothing else. The prose sentence "`status:` on a card is a column `id`…"
   may mention `decision: true` in one clause (the column decisions land in, O11).
2. No CLI/MCP surface for columns (HTTP `PATCH /api/board` + the web ColumnEditor only).
   Add:
   - **CLI** `repoboard columns [--json]` — prints the table `ID TITLE FLAGS COUNT` (flags:
     `active`, `wip:N`, `done`, `decision`, comma-joined; count = cards in that column) via the
     existing `formatRows`; `--json` prints `store.config.columns`.
   - **CLI** `repoboard columns set (--stdin | "<text>") [--as a]` — `<text>` is YAML or JSON
     (the `yaml` package parses both): either a bare list `[{id, title, …}]` or an object with a
     `columns:` key. It is the WHOLE new list (a replace, exactly `PATCH /api/board`'s
     contract — RCB-34 brief) → `store.setColumns(columns, actor)`; on `!ok` → `UserError`
     (the schema text). Prints `updated columns: <ids joined by ', '>`. Map-only root → the
     `MapOnlyError` → K4's `{ok:false}` → `UserError`, like every other write.
     Both under a new `cmd === 'columns'` branch; help text: two usage lines in the block near
     `repoboard card …`.
   - **MCP** `set_columns` tool (`packages/server/src/mcp.ts`, next to the board/config tools;
     add the name to the tool-name list near line 40 if there is one): input
     `{columns: z.array(z.record(z.unknown())), actor?: string}` (the store's `parseBoard` is the
     validator — do NOT duplicate the column schema in zod; say so in the description), returns
     `ok({config})` / `fail(error)`. Description says it is a whole-list replace.
3. No event line for a column edit. `Event.type` gains `'columns'`
   (`packages/core/src/types.ts`; update the doc comment: `cardId` null, `resource` absent,
   `from` = the previous ids joined by `,`, `to` = the new ids joined by `,`). `store.setColumns`
   appends exactly ONE such event through `this.appendEvent` (K8: one mutation, one event — the
   K8 describe in `store.test.ts` shows the counting pattern; add a case there) and the
   `EVENT_TYPES` reread filter in `store.ts` (~line 1301) gains `'columns'` (RCB-38's lesson in
   the comment above it: a type missing there is silently dropped on reread — test that a
   `columns` line survives a restart of the store, the way that comment describes). Remove the
   RCB-34 "no event this round" comment and the biome-ignore on `actor`. The web Ticker renders
   every event as `<actor> moved <cardId> → <to>` — for this event that reads
   `builder moved → backlog,decide,todo,doing,done`; acceptable for this card, do not touch
   `packages/web` (report it under found-not-fixed: the ticker has one verb for every type).
   HTTP `PATCH /api/board` and the web ColumnEditor get the event for free through
   `setColumns` — add one assertion to the existing PATCH test in `http.test.ts` that
   `GET /api/events` (or the events list, whatever the existing tests read) now ends with a
   `columns` event.

## Rules (CLAUDE.md; docs/RIG.md)

- **No `pnpm test`.** The lock is NOT held for you; run only:
  `pnpm --filter @repoboard/core exec vitest run test/board.test.ts`
  `pnpm --filter repoboard exec vitest run test/store.test.ts test/cli.test.ts test/mcp.test.ts test/http.test.ts`
  Never `mkdir`/`rm` `/tmp/fpj-vitest.lock`; never run `scripts/vitest-lock.sh`.
- **Every save must parse**: `pnpm typecheck` after each save, exit 0, **no `any`**.
- `pnpm lint` clean on your files (`pnpm exec biome check --write <files>` first).
- **Never run `repoboard columns set` against THIS repo's real `.repoboard/`.** Temp roots only.
- **Claims carry numbers.** Two controls: (A) drop `'columns'` from `EVENT_TYPES` → the
  survives-restart test fails (paste); (B) make `columns set` append nothing → the K8 case and
  the CLI event test fail (paste). Each: `grep -n` read-back, typecheck with it in place,
  restore by edit, `git diff --stat`, green again.

## Owns

`README.md` (§Config example + its following prose only), `packages/core/src/types.ts` (the
`Event` doc comment + union only), `packages/core/test/board.test.ts`,
`packages/server/src/store.ts` (`setColumns` + `EVENT_TYPES` only), `packages/server/src/cli.ts`
(new `cmdColumns`, dispatch line, help text), `packages/server/src/mcp.ts` (one tool),
`packages/server/test/store.test.ts`, `packages/server/test/cli.test.ts`,
`packages/server/test/mcp.test.ts`, `packages/server/test/http.test.ts`, `docs/AGENTS.md`
(§10 table: two CLI rows + the MCP tool list sentence, wherever `take_lease` is listed).
Need `packages/core/src/index.ts`? Only if you export something new from core — say so.

## Tests (numbers in the report)

core: README example = default columns (1). server store: setColumns appends one `columns`
event with the right from/to; K8 count = 1; `columns` line survives a store restart (3). cli:
`columns` table + `--json`; `columns set --stdin` YAML; `columns set "<json>"`; schema error →
exit code of `UserError`, board.yml untouched (`cmp`); `--as` shows as the event's actor (5).
mcp: `set_columns` ok + fail (2). http: PATCH test gains the event assertion (1).

## Report

Targeted vitest before/after per file; typecheck 0; lint 0; both controls' assertions
verbatim; `git diff --stat`; found-not-fixed list (the ticker verb at minimum).
