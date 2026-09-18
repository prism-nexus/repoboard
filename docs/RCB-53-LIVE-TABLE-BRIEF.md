# Brief — RCB-53 LIVE panel: a markdown table collapses its first column (2026-09-18)

One agent, web only. The builder seat verifies in the browser on the owner's board (:4243), gates,
commits, pushes.

Baseline on `main` @ 552fb2e, measured 2026-09-18 by the builder: 664 passed | 2 skipped (666) ×2, typecheck 0, lint 0, build 0,
bundle JS 145.36 KB gzip, CSS 5.54 KB gzip (23.65 KB raw).

## The finding (builder, 20:5xZ, on http://127.0.0.1:4243 — the fpj board)

fpj's STATE `LIVE` section is a markdown table (`| row | value (as of …) |`). In the RCB-45
window-locked LIVE box the table's first column renders one or two characters wide: the header
`row` wraps to `ro` / `w`, the cell `tree` to `tre` / `e`. Zoomed screenshot taken; the second
column is fine.

## Cause (read `packages/web/src/styles.css` ~lines 405–445 before touching anything)

`.state-panel__section { min-width: 0 }` (RCB-45, correct — it stops a wide table widening the
grid track) plus `.state-panel__window { overflow-wrap: anywhere }` (also RCB-45, for prose). With
`anywhere`, a table cell's min-content width becomes ONE character, so auto table layout gives the
narrow column almost nothing and breaks its words at every letter. Prose wanted `anywhere`;
table cells do not.

## Rules (CLAUDE.md; HANDOFF §7)

- **You do not commit.** Leave the tree dirty.
- **Stay inside your file list.** `packages/web/src/styles.css`,
  `packages/web/test/state-panel.test.tsx`. Nothing else.
- **No `pnpm test`.** vitest only on your file, under the box lock (`mkdir /tmp/fpj-vitest.lock ||
  exit 1`; write `"$$ <cwd> <ISO time>"` to `/tmp/fpj-vitest.lock/owner`; `rm -rf` ONLY when the
  owner line's pid is yours; never remove a foreign lock):
  `pnpm --filter @repoboard/web exec vitest run test/state-panel.test.tsx`.
- **Every save must parse**; `pnpm typecheck` exit 0; `pnpm lint` clean.
- **Claims carry numbers.**

## The fix — two CSS rules, no markup change

```css
/* RCB-53: prose in the window wraps anywhere; table cells do not — with `anywhere` a cell's
   min-content is one character and auto table layout starves the narrow column (fpj's LIVE table,
   header "row" rendered as "ro"/"w"). Cells keep whole words; a table wider than the window
   scrolls sideways inside it instead of squeezing. */
.state-panel__window {
  overflow-x: auto;            /* add to the existing block, keep every other declaration */
}
.state-panel__window :is(th, td) {
  overflow-wrap: normal;
  word-break: keep-all;
  white-space: nowrap;
}
```

Also add, if the file has no table styling in the panel already (check `grep -n "table"`), a
minimal readable table: `.state-panel__window table { border-collapse: collapse; }` and
`.state-panel__window :is(th, td) { padding: 2px 8px 2px 0; text-align: left; vertical-align:
top; }` — merge into the rule above; do not introduce new colours.

## Test — a CSS pin, the RCB-45 way

`state-panel.test.tsx` already pins RCB-45's rules by reading `styles.css` as text (find the test
that asserts `height: 160px` and copy its shape). Add ONE test that reads the file and asserts,
inside the `.state-panel__window :is(th, td)` block, `overflow-wrap: normal` AND
`white-space: nowrap` — assert the block, not the file, i.e. slice the text from the selector to
the next `}` first, so a `nowrap` elsewhere in the file cannot satisfy it (RCB-44 found exactly
that kind of vacuous pin: `toContain('height: 160px')` matched a `max-height`).

**Control C1**: change `overflow-wrap: normal` in that block to `overflow-wrap: anywhere` (the
bug), `grep -n` it back, run the test — it must FAIL naming the block; restore with a targeted
edit; `git diff --stat` shows only your feature change.

**Control C2 (vacuity)**: temporarily add `white-space: nowrap` to a DIFFERENT rule (e.g.
`.state-panel__heading`) and remove it from the `th, td` block — the test must still FAIL. Restore
both. Paste both failing assertions.

## Report (numbers)

Test count before/after for the file; typecheck/lint exits; the two control outputs; `git diff
--stat`; `pnpm build` gzip size of the CSS and JS bundles vs baseline. The builder measures the
actual column width on :4243 in the browser (before: the header wraps; after: `row` and `tree`
on one line each) and records the numbers in the commit.
