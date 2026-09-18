# Brief — RCB-48 `repoboard seat <name>` — the cold-start bundle (2026-09-18)

One agent. The builder seat verifies, gates, commits, pushes. Dispatched AFTER RCB-52 agent A lands
(shared files); may run alongside RCB-52 agent B (web only — do not touch `packages/web`).

Baseline on `main` @ 552fb2e, measured 2026-09-18 by the builder: 664 passed | 2 skipped (666) ×2, typecheck 0,
lint 0, build 0.

## What the owner asked (log 18:1xZ) and what exists

RCB-48: "one command prints a seat's cold-start bundle — its SEATS line, its last log block, its next
todo card, the open decisions — replacing the three-file ritual; design: one command per seat."
RCB-47 (landed 00aae0a) gave the cold-start RULE — STATE.md → your own seat's last block → the
coordinator's → `card list --status todo` — and the reader it needs: core `lastBlockFor`, store
`lastRepoLogBlock(seat)`, CLI `log --last <seat>`. RCB-48 packages that rule as ONE command.

## Rules (CLAUDE.md; HANDOFF §7)

- **You do not commit.** Leave the tree dirty.
- **Stay inside your file list.** Need another file → stop and report.
- **No `pnpm test`.** vitest only on your own test files, only while holding the box lock:
  `mkdir /tmp/fpj-vitest.lock || exit 1`; write `"$$ <cwd> <ISO time>"` to
  `/tmp/fpj-vitest.lock/owner`; `rm -rf` it ONLY when the owner line's pid is yours; never remove a
  foreign lock. Filters: `pnpm --filter @repoboard/core exec vitest run test/state.test.ts`,
  `pnpm --filter repoboard exec vitest run test/cli.test.ts -t "repoboard seat"`.
- **Every save must parse**: `pnpm typecheck` after each `.ts` save, exit 0, **no `any`**.
- `pnpm lint` clean on your files before reporting.
- **Claims carry numbers.** Controls verified the CLAUDE.md way (perturbation read back by
  `grep -n`, typecheck with it in place, failing assertion pasted, targeted restore proved by
  `git diff --stat`; never `git checkout`).

## Owns

`packages/core/src/seat.ts` (new), `packages/core/src/index.ts` (export lines only),
`packages/core/test/seat.test.ts` (new), `packages/server/src/store.ts`, `packages/server/src/cli.ts`,
`packages/server/test/cli.test.ts`, `docs/AGENTS.md` (§10 tables + the RCB-47 cold-start paragraph),
`README.md` only if it has a CLI list naming `log`/`state` (say if it does not).

## Design

### Core `seat.ts` — pure, I/O-free

```ts
export interface SeatBundleInput {
  name: string;                       // as typed
  now: Date;
  seatsSection: string | null;        // StateDoc.sections.seats, null when no STATE.md
  ownBlock: { date: string; block: LogBlock } | null;
  coordinatorBlock: { date: string; block: LogBlock } | null;   // null when name IS the coordinator
  cards: readonly Card[];
}
export interface SeatBundle {
  name: string;
  seatsLine: string | null;           // the matching SEATS bullet, whole bullet incl. continuation lines
  ownBlock: … | null;
  coordinatorBlock: … | null;
  nextCard: Card | null;
  openDecisions: Card[];              // needsDecision(c), list order
}
export function seatBundle(input: SeatBundleInput): SeatBundle
export function findSeatLine(seatsSection: string, name: string): string | null
export function renderSeatBundle(b: SeatBundle, now: Date): string
```

- `findSeatLine`: split the SEATS section into top-level bullets (a line starting with `- `; the
  following lines up to the next `- ` line are its continuation). Match the FIRST bullet whose
  **first line** contains `name` as a whole word, case-insensitive (`\b` on both sides; escape the
  name). `builder` matches `- **repoboard builder (its own terminal…)**`; `coordinator` matches the
  coordinator bullet; `ordinator` matches nothing (whole word). Returns the bullet's text with
  continuation lines, trimmed. Null when nothing matches or the section is a placeholder.
  **Two-pass, added after the RCB-48 dogfood (2026-09-18 21:07Z) found `seat builder` returning
  this repo's own coordinator bullet — its prose genuinely says "the builder's card" and "each
  builder sha" ahead of the real builder bullet: pass 1 matches on the bullet's LABEL (the leading
  `**…**` span, else up to the first `:`) so a bullet's own name wins over another bullet's prose
  mention of it, and pass 2 (the rule above) is the fallback only when no label matches at all.**
- `nextCard`: the first `todo` card whose `assignee` equals `name` (case-insensitive), else the
  first `todo` card in list order (`store.list()` is id-sorted). Null when none. Report which rule
  picked it via a `nextCardReason: 'assigned' | 'first-todo' | null` field on the bundle.
- `openDecisions`: `cards.filter(needsDecision)` — reuse the core function, do not re-derive.
- `renderSeatBundle` — markdown, sections in the cold-start ORDER, each with a fixed heading so a
  reader can `sed -n '/^## /,/^## /p'` it; a missing part prints a one-line placeholder, never an
  empty section:

```
# seat <name> — <ISO now>

## SEATS line
<bullet | "(no SEATS line mentions <name>)">

## Last block — <NAME UPPERCASED>
<formatLogBlock(block) | "(no log block for <name>)">

## Last block — COORDINATOR
<formatLogBlock(block) | "(no log block for coordinator)">      ← section OMITTED entirely when
                                                                   name is the coordinator
## Next card
<id>  <status>  <title>   — one line, then "(assigned to <name>)" or "(first todo; nothing assigned)"
| "(no todo card)"

## Open decisions
<ownerQueueLine per card, one per line | "(none)">
```

The coordinator's seat name is `coordinator` (compare case-insensitive against `name`).

### Store

`seatBundle(name)` in `store.ts`: gathers `this.state()?.sections.seats ?? null`,
`await this.lastRepoLogBlock(name)`, `name.toLowerCase() === 'coordinator' ? null : await
this.lastRepoLogBlock('coordinator')`, `this.list()`, `this.now()` and calls core `seatBundle`.
Read-only: nothing is written, no event, works with no STATE.md (seatsSection null).

### CLI

`repoboard seat <name> [--json]`. No name → `UserError('usage: repoboard seat <name> [--json]')`.
`--json` prints the bundle object (blocks as `{date, block}`, cards as full cards) via the existing
`formatRows`/JSON helper the other `--json` commands use — match their shape. Otherwise prints
`renderSeatBundle`. Exit 0 always on a successful read, even when every part is a placeholder (a
cold seat on a fresh board is the normal case). Help text: add a `repoboard seat <name> [--json]`
line right after the `log --last` line:
```
  repoboard seat <name> [--json]       the cold-start bundle for one seat: its SEATS line, its last
                                        log block, the coordinator's, its next todo card, the open
                                        decisions — one command instead of the three-file ritual
```

### Docs

`docs/AGENTS.md`: a row in both CLI tables; rewrite the RCB-47 "Cold-start rule" paragraph to:
*a seat coming up runs `repoboard seat <name>` — one command prints its SEATS line, its own last
log block, the coordinator's, its next todo card and the open decisions, in that order. The
underlying reads stay available one at a time: `repoboard state`, `log --last <seat>`,
`card list --status todo`, `card list --needs-decision`.*

## Tests

`seat.test.ts` (core): `findSeatLine` whole-word (a–c above, plus continuation lines kept, plus
placeholder → null); `seatBundle` nextCard assigned-wins-over-first-todo (**C1**: perturb to
always take the first todo → fails), coordinator section omitted for the coordinator (**C2**:
perturb the name compare to case-sensitive `'Coordinator'` and call with `coordinator` → the
"omitted" test fails); `renderSeatBundle` placeholders present for every missing part.

`cli.test.ts` `describe('repoboard seat')`: on `freshRepo`, write a STATE.md via
`state --set-section SEATS "- **ops**: watching\n- **builder (own terminal)**: on RCB-1"`, log two
blocks (`ops` then `builder`), `card add "x" --status todo --assignee builder`, one `card ask` →
`repoboard seat builder` output contains the builder bullet and NOT the ops bullet; the builder's
block; a `coordinator` block (log one as `coordinator` too) under `## Last block — COORDINATOR`;
the assigned card line with `(assigned to builder)`; the queue line. Put a `- **rebuilder**: x`
bullet BEFORE the builder bullet in the SEATS fixture and assert the output does NOT contain it
(**C3**: perturb `findSeatLine` to a plain substring match → this assertion fails). `--json`
parses and has the bundle's keys. No STATE.md → still exit 0 with the placeholder. No name →
exit 1.

## Report (numbers)

Per-file counts before/after; typecheck/lint exits; C1–C3 outputs; `git diff --stat`; the full
output of `node packages/server/dist/cli.js seat builder` on THIS repo after `pnpm build` (it is
the dogfood — paste it); anything in this brief that measured wrong.
