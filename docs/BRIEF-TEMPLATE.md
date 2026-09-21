# Brief — <CARD> <title> (<date>)

One agent (sonnet). The <seat> seat verifies, gates, commits, pushes. Never `git add/stash/
checkout/restore`, never `pnpm test`; you do not commit. Every save must parse: run
`pnpm -s typecheck` (or the file's own parser) after each save.

Baseline on `main` @ <sha>: <tests> passed | <skipped> skipped, typecheck 0, lint 0, build 0.

## The problem (card <CARD>)

Two to five sentences. Name the file and the line that is wrong today and what a reader sees.

## The change — exactly this, nothing wider

### `<path>`
- What to add or change, with the signature or the wording.

### `<test path>`
- The control: what must FAIL with the change reverted, and what must pass with it.

## Files you may touch
`<path>`, `<path>`, `<test path>`. Anything else: stop and report.

## Report back — measurements, not verdicts
- `git diff --stat`.
- The targeted vitest line for the touched files (`pnpm vitest run <file>`), pasted.
- Any question the brief left open, and what you assumed.

Landed briefs live in `.repoboard/local/briefs/`; the seat moves this file there in the landing commit.
