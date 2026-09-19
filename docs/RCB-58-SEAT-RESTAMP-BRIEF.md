# Brief — RCB-58 (B2) `repoboard seat <name> --up|--down "<text>"` restamps ONLY its own SEATS bullet (2026-09-19)

One agent (sonnet). The builder seat verifies, gates, commits, pushes. Nothing else is in
flight on this repo. Never `git add/stash/checkout/restore`; you do not commit.

Baseline on `main` @ 4393de0 (code unchanged since b27d182): 783 passed | 2 skipped (785),
48 files; typecheck 0; biome 134 clean; build 0 — the builder's gate at b27d182.

## Why

`repoboard state --set-section SEATS --stdin` rewrites the WHOLE section from a body the seat
pastes. In the builder's terminal the permission classifier blocks that command (a whole-section
overwrite of shared state), so the builder cannot restamp its own line and `check` reports
`stale-state` until the coordinator restamps for it (log 2026-09-18 21:xxZ–00:1xZ). RCB-55 A
asked for a one-bullet blast radius: a seat replaces ITS OWN bullet and nothing else. The
classifier may then let it through; if not, the coordinator's routine is unchanged.

## Design

### core — `packages/core/src/seat.ts`

Beside `findSeatLine` (which already splits a SEATS section into top-level bullets and finds
the seat's own by LABEL, then by first line), add:

```ts
/** RCB-58 … */
export function replaceSeatBullet(
  seatsSection: string,
  name: string,
  bullet: string,
): string
```

- Uses the SAME two-pass match as `findSeatLine` — refactor the bullet-splitting and the
  match into one private helper both call (`locateSeatBullet` → the bullet's index, or -1),
  so the two can never disagree about which bullet is "mine". `findSeatLine`'s existing tests
  must stay green unchanged.
- Found → the whole bullet (first line + continuation lines) is replaced by `bullet`; every
  other byte of the section is preserved (lines before, other bullets, blank lines between).
- Not found → `bullet` is appended as the last bullet (after a trailing newline if the section
  lacks one). Section is the placeholder `_(nothing recorded yet)_` (or otherwise has no
  `- ` line) → the section becomes just `bullet`.
- `bullet` is passed in already formatted (below); this function does no formatting.
- Pure, no I/O, no clock.

Formatting, one exported pure function in the same file:

```ts
export function formatSeatBullet(
  name: string, status: 'UP' | 'DOWN', text: string, now: Date,
): string
```
→ `- **<name>: <UP|DOWN> <YYYY-MM-DD HH:MMZ>.** <text>` with `text` trimmed, internal newlines
kept (a ≤3-line bullet may have continuation lines — a continuation line is indented two
spaces so it stays inside the bullet: replace each `\n` in `text` with `\n  `). `HH:MM` is
UTC from `now`, minutes exact (not redacted — the seat's own log block carries the redacted
form if it wants one). The label `**<name>: …**` is what `findSeatLine`'s label pass matches
on the NEXT call, so a bullet written by this function is always found again by it — pin that
with a test (`formatSeatBullet` → `replaceSeatBullet` → `findSeatLine` returns exactly the
bullet).

### server — `packages/server/src/store.ts`

```ts
setSeatBullet(name: string, status: 'UP'|'DOWN', text: string): Promise<SetStateOutcome>
```
inside `this.mutate`, `refuseWriteWithoutBoard()`, read STATE.md (missing → `initialStateText`
first, like `setStateSection`), `parseState`, `replaceSeatBullet(doc.sections.seats, name,
formatSeatBullet(name, status, text, this.now()))`, then `setStateSectionCore(text, 'seats',
newSeats, {now: this.now(), actor: name})` — so the restamp and the byte-preservation of every
other section are the SAME code path `state --set-section` uses (one function per guarantee).
Actor on the stamp line = the seat name as typed.

### CLI — `packages/server/src/cli.ts` `cmdSeat`

New string options `--up <text>` and `--down <text>` (`parse` already handles `{type:'string'}`).
- Both given → `UserError('seat: --up and --down are exclusive')`.
- Empty text (`--up ""`) → `UserError('seat --up/--down needs the bullet text')`.
- One given → `store.setSeatBullet(name, 'UP'|'DOWN', text)`; on `!ok` → `UserError(res.error)`;
  print `restamped SEATS <name>: <UP|DOWN> <stamp>\n` where `<stamp>` is the same
  `YYYY-MM-DD HH:MMZ`; exit 0; do NOT print the bundle (a restamp is a write, the bundle is a
  read — keep them separate so the classifier sees one small write). `--json` with `--up` →
  print `{name, status, stamp, bullet}`.
- Usage line in the `--help` text (`repoboard seat <name> [--json] [--up "<text>" | --down "<text>"]`)
  plus one indented description line: "replace ONLY this seat's own SEATS bullet and restamp
  STATE.md; appends the bullet if the seat has none".
- The RCB-60 dist-staleness warning still prints after (it is harmless on a write).

No HTTP / MCP surface (the card says CLI; `PUT /api/state/section` remains the web's path).

### docs — `docs/AGENTS.md` §10

One new table row directly under the `repoboard seat <name> [--json]` row:
`repoboard seat <name> --up "<text>" | --down "<text>"` — replaces ONLY that seat's own SEATS
bullet (found the way `seat` finds its SEATS line: label first, then first line; appended when
absent) with `- **<name>: UP|DOWN <YYYY-MM-DD HH:MMZ>.** <text>`, restamps line 3 as `<name>`,
touches no other byte (RCB-58); `state --set-section SEATS` stays the whole-section rewrite.
Also: the "**A SEATS bullet is ≤ 3 lines**" paragraph (~line 506) gets one sentence: "A seat
restamps its own with `repoboard seat <name> --up|--down`."

## Rules (CLAUDE.md; docs/RIG.md)

- **No `pnpm test`.** The lock is NOT held for you; you run only:
  `pnpm --filter @repoboard/core exec vitest run test/seat.test.ts test/state.test.ts`
  `pnpm --filter repoboard exec vitest run test/store.test.ts test/cli.test.ts`
  Never `mkdir`/`rm` `/tmp/fpj-vitest.lock`; never run `scripts/vitest-lock.sh`.
- **Every save must parse**: `pnpm typecheck` after each save, exit 0, **no `any`**.
- `pnpm lint` clean on your files (`pnpm exec biome check --write <files>` first).
- **Do not run `repoboard seat … --up/--down` against THIS repo's real `.repoboard/STATE.md`.**
  Tests use temp roots only. The builder does the real one.
- **Claims carry numbers.** Two controls, each: perturb, `grep -n` read-back, typecheck with it
  in place, failing assertion verbatim, restore by edit, `git diff --stat`, green again.

## Owns

`packages/core/src/seat.ts`, `packages/core/test/seat.test.ts`, `packages/server/src/store.ts`
(new method + import only), `packages/server/src/cli.ts` (`cmdSeat`, the help text), 
`packages/server/test/store.test.ts`, `packages/server/test/cli.test.ts`, `docs/AGENTS.md`
(the two spots above only).

## Tests

Core (`seat.test.ts`):
1. Replace: a 3-bullet section (coordinator / repoboard builder / ops, the builder bullet having
   2 continuation lines) → `replaceSeatBullet(section, 'builder', X)` yields the coordinator and
   ops bullets byte-identical, the builder bullet = X (all 3 old lines gone). Assert the whole
   string, not `toContain`.
2. Append when absent; placeholder section → just the bullet.
3. Label-pass precedence: the coordinator's bullet mentions "the builder" in prose ahead of the
   builder's own bullet → the builder's own is the one replaced (the RCB-48 dogfood case).
4. `formatSeatBullet('repoboard builder', 'DOWN', 'x\ny', 2026-09-19T01:55:00Z)` →
   `- **repoboard builder: DOWN 2026-09-19 01:55Z.** x\n  y`.
5. Round trip: format → replace → `findSeatLine` returns exactly the new bullet.
6. **Control A:** make `replaceSeatBullet` return `bullet` alone (drop everything else) → test 1
   fails (paste); restore.

Server:
7. `store.test.ts`: on a temp repo with a 3-bullet SEATS, `setSeatBullet('builder','UP','held: RCB-58')`
   → STATE.md on disk: LIVE and LAST LANDINGS byte-identical to before, stamp line
   `**Written <now> by builder.**`, SEATS = the other two bullets untouched + the new one.
   Missing STATE.md → scaffolded then the bullet appended.
8. `cli.test.ts`: `seat builder --up "holding RCB-58"` prints `restamped SEATS builder: UP …`,
   exit 0; then `seat builder` shows the new bullet under `## SEATS line`; then `check` no
   longer reports `stale-state` when a log block newer than the OLD stamp exists (write the
   block first with `log --as builder`, prove `check` says stale-state BEFORE the restamp,
   `ok` after — this is the whole point of the card, make the test say so).
   `--up` + `--down` → usage error, exit 2 (or whatever `UserError` maps to — read `cli.ts`).
9. **Control B:** in `store.setSeatBullet`, pass `parsed.doc.sections.seats` unchanged (skip the
   replace) → tests 7 and 8 fail (paste one); restore.

## Report (numbers)

Targeted vitest before/after per file; typecheck 0; lint 0; the two controls' assertions
verbatim; `git diff --stat`; anything found but not fixed.
