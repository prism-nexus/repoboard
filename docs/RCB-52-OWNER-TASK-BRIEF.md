# Brief — RCB-52 owner TASKS in the one owner queue (2026-09-18)

Two agents in sequence (web depends on core's types): **agent A** core + server + CLI + MCP + HTTP,
then **agent B** web. The builder seat verifies, gates, commits, pushes.

## What the owner asked (log 20:1xZ)

"this should be in the owner lane, needs decision/owner work. I think 1 queue there is appropriate
instead of adding additional lanes." Today the coordinator fakes it with `card ask` and stuffs
"OWNER WORK, not a letter:" into the question (see `.repoboard/cards/RCB-51.md`).

## The shape (builder's call — record any disagreement, do not act on it)

The card's title sketches an `owner:` block. This brief keeps the ONE existing mechanism instead:
**`decision:` gains an optional `kind: task`**. Why: plan §11 O10 (no new record type),
CLAUDE.md "one function per guarantee" (`needsDecision` stays the only gate into the OWNER QUEUE,
`decide` column, badge, `check`, `card list --needs-decision`, MCP `needsDecision`), and every
existing surface keeps working with a rendering difference only. The `owner:` word appears where
the owner reads it: the OWNER QUEUE line becomes `RCB-51 · owner: <task>`.

Semantics of a task: `question` holds the task text; `options` MUST be empty (asking a task with
options is refused: `a task has no options`); the owner closes it with `decide` and needs
**neither a letter nor words** (a plain "done"), words optional and kept verbatim. `kind` is
absent for a question — never written as `kind: question` — so no existing card's bytes change.

Baseline on `main` after RCB-47 (the builder fills this in when dispatching): tests ___ ,
typecheck 0, lint 0, build 0.

## Rules (CLAUDE.md; HANDOFF §7) — both agents

- **You do not commit.** Leave the tree dirty; the builder verifies and commits.
- **Stay inside your file list.** Need another file → stop and report.
- **No `pnpm test`.** vitest only on your own test files, only while holding the box lock:
  `mkdir /tmp/fpj-vitest.lock || exit 1`; write `"$$ <cwd> <ISO time>"` to
  `/tmp/fpj-vitest.lock/owner`; `rm -rf` it ONLY when the owner line's pid is yours; never remove a
  foreign lock. Package filters: `@repoboard/core`, `repoboard` (server — confirm the name in
  `packages/server/package.json`), `@repoboard/web` (confirm).
- **Every save must parse** (the tree hot-reloads into the owner's browser): `pnpm typecheck` after
  each `.ts`/`.tsx` save, exit 0, **no `any` added**.
- `pnpm lint` (biome) clean on your files before reporting.
- **Claims carry numbers.** Report measurements, not adjectives.
- **Controls verified the CLAUDE.md way**: apply the perturbation, `grep -n` the changed line to
  prove it landed, `pnpm typecheck` to prove it compiles, run the one test and paste the failing
  assertion, restore with a targeted edit (never `git checkout`), prove restoration with
  `git diff --stat` showing only the feature change.

---

## Agent A — core, server, CLI, MCP, HTTP

**Owns:** `packages/core/src/types.ts`, `packages/core/src/card.ts`, `packages/core/src/decisions.ts`,
`packages/core/src/state.ts`, `packages/core/test/decisions.test.ts`, `packages/core/test/state.test.ts`,
`packages/core/test/card.test.ts`, `packages/server/src/store.ts`, `packages/server/src/cli.ts`,
`packages/server/src/http.ts`, `packages/server/src/mcp.ts`, `packages/server/test/cli.test.ts`,
`packages/server/test/http.test.ts`, `packages/server/test/mcp.test.ts`, `docs/AGENTS.md` (§ on
decisions and the CLI tables), `docs/BUILD-PLAN.md` (P8.1 paragraph only: one sentence noting
`kind: task`, RCB-52).

### Core

1. `types.ts` `Decision`: add `kind?: 'task';` after `question` with a doc comment: *RCB-52: an
   owner WORK item in the same queue. Absent = a question. A task has no options and is closed by
   `decide` with neither letter nor words.*
2. `card.ts` `DecisionSchema`: `kind: z.literal('task').optional()` after `question`. Field order
   on serialize must place `kind` right after `question` (check how `askDecision` builds the
   object — declared order — and how zod's parse output orders keys; write a card test that a task
   round-trips with `kind: task` on the line after `question:` and that a question card's bytes are
   UNCHANGED, i.e. no `kind:` line appears — control C1).
3. `decisions.ts`:
   - `AskDecisionOptions` gains `kind?: 'task'`. `askDecision` with `kind === 'task'` and
     `options.length > 0` → `{ ok: false, error: 'a task has no options' }`. The built `Decision`
     includes `kind: 'task'` only for a task (spread conditionally, so a question object has no
     `kind` key at all — `'kind' in decision` must be false; test it).
   - Log line for a task: `owner task: <text>` (instead of `asked: …`).
   - `decide`: when `card.decision.kind === 'task'`, neither letter nor words is required; a
     letter is refused with the existing unknown-option message (a task has no options). Log
     line: `done` or `done — "<words>"`; the event stays `type: 'decide'`.
   - The "already open" refusal message stays as is (a task is an open decision).
4. `state.ts` `ownerQueueLine`: a task renders `<id> · owner: <text>` (no letters bracket).
   Export a tiny `isOwnerTask(card): boolean` next to `needsDecision` in `decisions.ts` (true when
   `card.decision?.kind === 'task'`), and use it here and in the web (agent B imports it from
   `@repoboard/core` — make sure `index.ts` exports it; `index.ts` is in your ownership for that
   one line).

Core tests (`decisions.test.ts`, `state.test.ts`, `card.test.ts`): task asked → `kind: 'task'`,
options `[]`, log line `owner task: …`, moves to the `decide` column like a question; task with
options refused; `decide` with nothing on a task → decided, `chosen: null`, `words: null`,
`decidedAt` set, log `done`, moves back to `returnTo`; `decide` with nothing on a QUESTION still
refused (**control C2**: remove the kind guard in `decide` → this test must fail); a letter on a
task refused; `ownerQueueLine` for a task = `RCB-9 · owner: buy the domain`; round-trip bytes
(control C1).

### Server

5. `store.ts` `AskInput` gains `kind?: 'task'`; pass it through to `askDecision`.
6. `cli.ts` `card ask`: new flag `--task` (boolean). With `--task` and any `--option` → UserError
   `a task has no options`. Success line: `owner task ${id}: ${text}`. Help text: add
   `--task` to the ask line: *`--task` files an owner WORK item instead of a question (no options;
   the owner closes it with `card decide <id>` and no letter)*. `card decide` on a task with
   nothing prints `done ${id}` (with words: `done ${id} — "<words>"`). `card list --needs-decision`
   is unchanged (tasks are included because `needsDecision` is unchanged) but its table's DECISION
   column should show `!` for a task instead of `?` — find where `?` is produced and branch on
   `isOwnerTask`.
7. `http.ts`: `ASK_FIELDS` gains `kind`; `toAskInput` accepts `kind: 'task'` only (anything else
   400 `kind must be "task"`); the `ownerQueue` payload item gains `kind: 'task' | undefined`
   (only present for a task) so the web can render it without re-deriving.
8. `mcp.ts` `ask_owner`: input `kind: z.literal('task').optional()` with a description (*an owner
   WORK item, same queue; no options; closed by `record_decision` with neither letter nor words*);
   pass through. `record_decision` description: add one sentence about tasks.

Server tests: CLI `card ask RCB-x "set up npm" --task --as coord` → card file has `kind: task`,
status `decide`, `card list --needs-decision` shows `!`; `card ask … --task --option "A x"` → exit 1;
`card decide RCB-x --as owner` → exit 0 `done RCB-x`, status back to `returnTo`; HTTP `POST
/ask {question, kind:'task'}` 200 and `{kind:'nope'}` 400; `GET /api/state` ownerQueue item carries
`kind: 'task'`; MCP `ask_owner` with `kind: 'task'` then `record_decision` with only `id` succeeds
(**control C3**: in `store.decide`, drop the pass-through of `kind`… no — `kind` lives on the card;
instead perturb `decide` in core to require words for tasks → the MCP/CLI "nothing" test fails).

### Docs

`docs/AGENTS.md`: in the decisions section, one paragraph *Owner tasks (RCB-52)*; add `--task` to
both CLI tables' `card ask` row; note `decide` needs nothing on a task. `docs/BUILD-PLAN.md` P8.1
paragraph: one sentence.

### Report (numbers)

Per-file test counts before/after; typecheck/lint exit codes; C1–C3 outputs (line read back,
failing assertion, restoration proof); `git diff --stat`; anything in this brief that measured wrong.

---

## Agent B — web (dispatched after agent A typechecks)

**Owns:** `packages/web/src/components/CardItem.tsx`, `packages/web/src/components/Drawer.tsx`,
`packages/web/src/components/StatePanel.tsx` (only if the queue line needs it — it already uses
core's `ownerQueueLine`, so probably NOT), `packages/web/src/styles.css` (the decision block only),
`packages/web/test/decisions.test.tsx`, `packages/web/test/state-panel.test.tsx`.

Read `packages/web/test/helpers.tsx` and the existing `decisions.test.tsx` first; follow their
fixture and render pattern exactly.

1. `CardItem.tsx` `DecisionMark`: an OPEN task shows `!` (class `card__decision-mark
   card__decision-mark--task`, title `owner task: <text>`, same `data-testid`). Decided task: the
   existing chip with `✓`.
2. `Drawer.tsx` `DecisionSection`: for a task (`isOwnerTask(card)` from `@repoboard/core`, or
   `decision.kind === 'task'`), heading **Owner task** instead of Decision; no option buttons (there
   are none); the words input stays (placeholder `notes, optional`); the submit button reads
   **Done** and is ENABLED with empty words (for a question it stays disabled until a letter or
   words — **control C4**: make the task button obey the question rule → the task test fails).
   The decided view reads `Done` instead of `Decided`.
3. `styles.css`: `.card__decision-mark--task` uses the existing accent/warning token — no new
   colors; one rule.

Web tests: an open task renders `!` and the Drawer's **Done** button enabled with empty words;
clicking it calls `onDecide({ letter: undefined, words: undefined })`; a question with no letter and
no words keeps **Decide** disabled (C4); the StatePanel queue line for a task shows `owner:`.

Report the same numbers as agent A, plus the web bundle gzipped size from `pnpm build` (baseline
in the builder's dispatch message) — it must not grow past 600 KB (P6 limit).
