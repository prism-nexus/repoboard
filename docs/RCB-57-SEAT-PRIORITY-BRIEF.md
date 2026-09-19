# Brief — RCB-57 (B1) `seat` nextCard honours priority (2026-09-19)

One agent (sonnet). The builder seat verifies, gates, commits, pushes. Two OTHER agents are
working this tree at the same time on DISJOINT files (RCB-61: `scripts/`, `docs/RIG.md`;
RCB-62: `packages/core/src/repolog.ts`, `packages/server/src/store.ts`,
`packages/server/src/repo-context.ts`, `packages/web/src/time.ts` and their tests). Do not touch
those. Do not `git add`, `git stash`, `git checkout`, or `git restore` anything — ever.

Baseline on `main` @ 1fd7ee0 (code unchanged since a263ec9): 758 passed | 2 skipped (760),
47 files; typecheck 0; biome 132 clean — measured by the previous builder at the a263ec9 gate.

## The change (card text, verbatim intent)

`seatBundle` in `packages/core/src/seat.ts` picks `nextCard` as: the todo card assigned to this
seat, else `todoCards[0]` (list order). B1: the fallback must honour priority — among todo AND
unassigned cards, order high → medium → low → unset, then list order within a rank — and the
render must say WHY it picked what it picked.

Note "unassigned": today's fallback takes the first todo card even if it is assigned to SOMEONE
ELSE (existing test "falls back to the first todo card … when none is assigned to this seat"
has RCB-2 assigned to `ops` and expects RCB-1 — that one stays green either way). The card says
"todo + unassigned"; do exactly that: a card assigned to another seat is never this seat's next
card. If NO todo card is unassigned and none is assigned to us → `nextCard` null, reason null.
(Say in a test that a todo card assigned to another seat is skipped.)

## Rules (CLAUDE.md; docs/RIG.md)

- **You do not commit.** Leave the tree dirty.
- **Stay inside your file list.** Need another file → stop and report.
- **No `pnpm test`.** The builder holds `/tmp/fpj-vitest.lock` — do not `mkdir` it, do not `rm`
  it. Run vitest only on your own test file:
  `pnpm --filter @repoboard/core exec vitest run test/seat.test.ts`.
- **Every save must parse**: `pnpm typecheck` after each `.ts` save, exit 0, **no `any`**.
- `pnpm lint` clean on your files (`pnpm exec biome check --write <file>` first).
- **Claims carry numbers.** The control is verified the CLAUDE.md way: perturbation read back
  by `grep -n`, typecheck with it in place, failing assertion pasted, then restore BY EDIT (never
  `git checkout`/`git restore`) and prove restore with `git diff --stat` + re-run green.

## Owns

`packages/core/src/seat.ts`, `packages/core/test/seat.test.ts`, `docs/AGENTS.md` (ONLY the
`repoboard seat <name> [--json]` row in the §10 table, currently line ~486, and ONLY the clause
"else the first todo card in list order" — replace it with the new rule).

## Design

- `NextCardReason` becomes `'assigned' | 'priority' | 'first-todo' | null`:
  - `'assigned'` — unchanged.
  - `'priority'` — the chosen card has a `priority` set and won on rank (or on list order among
    equals of the top rank present).
  - `'first-todo'` — no candidate had a priority at all; plain list order among unassigned todo.
- Rank: `high` 0, `medium` 1, `low` 2, unset 3. Stable sort (JS `Array.prototype.sort` is
  stable) so list order breaks ties — do not re-sort by id, date, or anything else.
- The render line under `## Next card` says the rule in words:
  - `(assigned to <name>)` — unchanged;
  - `(first high-priority todo)` / `(first medium-priority todo)` / `(first low-priority todo)`
    — the chosen card's own priority;
  - `(first todo; nothing assigned, nothing prioritised)`.
  Keep the two existing strings exact where they still apply; the JSON `nextCardReason` carries
  the machine form.
- Pure, I/O-free, as the file header says. No new dependency.

## Tests (`seat.test.ts`, in the existing `seatBundle: nextCard` describe)

1. **Control fixture (the card names it):** an OLDER low-priority todo listed FIRST and a NEWER
   high-priority todo listed second, both unassigned → `nextCard` = the high one,
   `nextCardReason === 'priority'`, render contains `(first high-priority todo)`.
2. Two `high` cards → the first in list order wins (stability).
3. A `medium` listed after an unset card → the medium wins.
4. A todo card assigned to ANOTHER seat is skipped even if it is high priority and listed first.
5. `assigned` still beats a higher-priority unassigned card.
6. Nothing prioritised → `'first-todo'`, render shows the new no-priority string.
7. Render: the `--json` shape (`renderSeatBundle` is not JSON, but assert `bundle.nextCardReason`
   values) — covered by 1–6; also assert the exact render line for one `medium` case.
8. **Control:** make the rank map return the same number for every priority (read it back with
   `grep -n`; typecheck must pass with it in place — an uncompilable control is vacuous), run the
   file, paste the failing assertion(s) verbatim, restore by edit, `git diff --stat` shows only
   your intended changes, re-run green.

## Report (numbers)

Targeted vitest before/after (`N passed`); typecheck 0; lint 0; control assertion verbatim;
`git diff --stat`; anything found but not fixed.
