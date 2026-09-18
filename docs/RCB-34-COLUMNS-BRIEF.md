# Brief — RCB-34 / P7.3 Columns editable in the app (O6) — 2026-09-18

Two agents in parallel, disjoint files: **agent S** (core + server) and **agent W** (web). The
builder seat verifies, gates, commits, pushes, restarts :4242/:4243. The wire contract below is
fixed so neither agent waits on the other.

Baseline on `main` @ 4705988: 697 passed | 2 skipped (699), 43 files; typecheck 0; lint 125
files clean (builder, 713d330 gate).

## What the plan says and why

Plan §5 P7.3: "`PATCH /api/board` writes `board.yml` through `serializeBoard`, and the UI edits
the column set." Plan §11 O6 (owner, 2026-09-07): the column set is a per-user choice — "lets
make it an option in the app itself since different users could have different use cases" —
so the default stays and a user removes/adds columns visibly. O11 later changed the default to
`backlog, decide, todo, doing, done`; O6's rule stands: "anyone who wants `review` adds it to
`board.yml`" — this task is how they do it without an editor.

Foundation already in place (O6 names it): `serializeBoard()` writes `board.yml` (`cli.ts`
init), the store watches the file and reloads + emits `config` (`store.ts:1110`), and a card
whose `status` names no column already renders in a column marked `unconfigured` / "not in
board.yml" (`packages/web/src/store.ts:433`, `Column.tsx:43`). **Removing a column therefore
never loses a card, and nothing in this task touches cards.**

## Rules (CLAUDE.md; HANDOFF §7) — both agents

- **You do not commit.** Leave the tree dirty.
- **Stay inside your file list.** Need another file → stop and report.
- **No `pnpm test`.** The builder holds `/tmp/fpj-vitest.lock` — do not mkdir/rm it. Run only
  the targeted filters named in your section.
- **Every save must parse**: `pnpm typecheck` after each `.ts`/`.tsx` save, exit 0, **no `any`**.
  The tree hot-reloads into the owner's browser.
- `npx biome check --write <your files>` from the repo root before reporting; lint clean.
- **Claims carry numbers.** Controls verified the CLAUDE.md way (perturbation read back with
  `grep -n`, typecheck with it in place, failing assertion pasted, restored by EDIT and proved
  with `git diff --stat`; never `git checkout`).
- Never write outside this repo. Never touch `.repoboard/board.yml` in THIS repo by hand — tests
  use temp repos (`packages/server/test/helpers.ts`, `packages/web/test/helpers.tsx`).

## Wire contract (fixed; both agents code to this)

`PATCH /api/board` — body `{ columns: Column[], actor?: string }`.
- `columns` is the WHOLE new list, in order (a replace, like every list in `CardPatch`). Each
  item is a `Column`: `{ id, title?, active?, wip?, done?, decision? }` — the same shape
  `ColumnSchema` accepts today; unknown keys on a column are kept (looseObject), unknown keys on
  the BODY are rejected 400 (`rejectUnknown`, like cards).
- Validation = the existing `BoardConfigSchema` applied to `{ ...currentConfig, columns }`,
  nothing new: ≥1 column, unique ids, `wip` positive int. Failure → 400 with the schema's message
  (same text `parseBoard` would give a hand edit).
- Map-only root (no `.repoboard/`) → 409, via `refuseWriteWithoutBoard()` — same as every write.
- Success → 200 with `boardPayload()` (the same object `GET /api/board` returns), and the store
  emits `config` so the WS `{type:'config'}` broadcast reaches every client — that path already
  exists (`http.ts:837`), triggered by the watcher OR directly after the write (S decides; both
  must not produce two broadcasts for one write — measure it).
- Every other top-level key of `board.yml` (`name`, `siblings`, `prefix`, `activeWindowMinutes`,
  `claudeMdBudgetBytes`, `logDir`, and any key the schema does not know) is preserved
  byte-for-content: `serializeBoard` already orders and keeps them. **YAML comments are lost** —
  `serializeBoard` cannot keep them. S: say so in the store method's doc comment; W: say so in
  the editor UI in one line ("saving rewrites board.yml; comments in it are dropped"). This
  repo's own `board.yml` has 0 comment lines (measured).
- An event: append one `events.jsonl` line `{type:'board', actor, columns: <ids in order>}`?
  **No** — `Event` has a fixed type union and the ticker/K8 dedupe are built on it; do not widen
  it in this round. Report it as a follow-up instead. The log of who changed columns is git.

## Agent S — core + server

Owns: `packages/core/src/board.ts` (only if a helper is needed — prefer none),
`packages/server/src/store.ts`, `packages/server/src/http.ts`, `packages/server/test/store.test.ts`,
`packages/server/test/http.test.ts`, `docs/AGENTS.md` (one row in the HTTP table in §2/§3 if
one lists routes; say if it does not), `README.md` §Config (one sentence: the column set can be
edited in the app, and what that does to the file).

Store: `setColumns(columns: Column[], actor: string): Promise<SetColumnsOutcome>` inside
`this.mutate(...)`, guarded by `refuseWriteWithoutBoard()`. Build `next = { ...this.cfg, columns }`,
validate by `parseBoard(serializeBoard(next))` — one round trip through the only two functions
that define the file — and on `ok:false` return `{ ok:false, error }` without writing. On ok:
write atomically (`.tmp` + rename, same as `writeCard`), set `this.cfg`, emit `'config'`. The
watcher will ALSO see the rename and call `loadConfig()` → second `config` emit. Decide: either
suppress by hashing (the store already keeps `byPath` hashes for cards — a `boardHash` is the
same idea), or accept two emits and prove the UI is idempotent. Measure which happens with a
test that counts `config` emits across one `setColumns` with `watch: true`, and state the count
in your report. Prefer exactly one.

HTTP: `PATCH /api/board` per the contract, next to `GET /api/board` (`http.ts:915`). `actor`
defaults to `'web'` like the state route. Reuse `readBody`, `rejectUnknown`, `HttpError`.

Tests (targeted: `pnpm --filter repoboard exec vitest run test/store.test.ts test/http.test.ts`):
1. `setColumns` on a temp board: file rewritten, `parseBoard` of the file equals the new list,
   every other key (`name`, `logDir`, `prefix`, an unknown `extraKey: 1`) survives.
2. Invalid: empty list → `ok:false`, error mentions "at least one column"; duplicate id →
   `ok:false`; the file is byte-identical before/after (sha or string compare).
3. Map-only root → `MapOnlyError` / HTTP 409; `.repoboard/` still absent after.
4. HTTP: 200 body equals `GET /api/board` afterwards; 400 on `{ columns: [] }`, 400 on an
   unknown body key, 400 on missing `columns`.
5. Cards untouched: a card in a removed column is still on disk with the same `status`, and
   `list()` still returns it.
6. `config` emit count across one write (see above) — assert the number you chose.
Control: with the `refuseWriteWithoutBoard()` line removed from `setColumns`, test 3 must FAIL
(paste it) — that is the O7 read-only guarantee; restore by edit.

## Agent W — web

Owns: `packages/web/src/components/ColumnEditor.tsx` (new), `packages/web/src/store.ts`
(one action `saveColumns(columns)` modelled on `archiveDone`: fetch PATCH, toast on failure, on
success rely on the WS `config` message — do NOT set config locally from the response, so the
UI shows what the server has, not what it hoped), `packages/web/src/views/Board.tsx` (mount
point only), `packages/web/src/styles.css` (append a `.column-editor*` block; touch nothing
else), `packages/web/test/column-editor.test.tsx` (new), `packages/web/test/helpers.tsx` only
if a helper is missing (say which).

UI (keep it plain; it is a settings panel, not a feature page):
- One control in the board header row, near the existing StatePanel/board area: a button
  "Columns…". Hidden when `hasBoard` is false (map-only offers no write, P7.2).
- Opens an inline panel (not a modal) listing the current columns as rows: `id` (read-only for
  existing rows — changing an id would orphan every card in it; the fix for a bad id is remove +
  add), `title` (text), `active` / `done` / `decision` (checkboxes), `wip` (number, blank =
  unset), a card count for the column from the current cards (so removing one is an informed
  act), ↑ ↓ Remove buttons, and an "Add column" row (id + title; id validated client-side to
  `^[a-z0-9_-]+$` and unique — the server still validates).
- Save → `saveColumns(list)`. Cancel → discard. A one-line note: "Saving rewrites
  `.repoboard/board.yml`; comments in it are dropped. Cards in a removed column stay on disk and
  show under 'not in board.yml'."
- Disabled state while the request is in flight; server error text shown inline (from the
  toast path) — no silent failure.
- No drag-reorder; ↑/↓ is enough. No confirm dialogs (they block the browser harness).

Tests (targeted: `pnpm --filter @repoboard/web exec vitest run test/column-editor.test.tsx
test/columns.test.tsx`), with `fetch` stubbed:
1. Renders one row per configured column with the card count.
2. Remove + Save sends PATCH with the remaining ids in order; ↑ on the second row swaps order in
   the payload; Add row appends `{id,title}`.
3. A 400 from the stub surfaces its `error` text; the panel stays open with the user's edits.
4. Hidden when `hasBoard` is false.
5. Existing `columns.test.tsx` still green (the unconfigured-column rendering is what makes
   removal safe — do not weaken it).
Control: stub PATCH → 400 with `{error:"duplicate column id \"x\""}`; assert the text is shown;
then break the error path (drop the toast/inline set) and paste the failing assertion; restore.

## Report (numbers) — each agent

Targeted vitest before → after per file; typecheck 0; lint 0; `git diff --stat`; the `config`
emit count (S); the control's failing assertion verbatim; anything you found and did not fix.
