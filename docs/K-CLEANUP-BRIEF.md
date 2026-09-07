# Brief — K8, K1(b), K5 (post-v0.1 cleanup, 2026-09-06)

Three independent tickets, three agents, disjoint file ownership. Owner scoped these on
2026-09-06 and explicitly **left P6.3 alone**: nothing is published, no GitHub repo is created,
no tag is pushed. If a task seems to require any of that, stop and report instead.

Baseline on `main` @ 29214ca, measured 2026-09-06 by the orchestrator: **191 tests, 21 files;
`pnpm typecheck` exit 0; `biome check .` exit 0 on 87 files; web bundle 135.2 KB gzipped**
(limit 600 KB). Every number you report is a delta against those.

## Rules for all three (CLAUDE.md; HANDOFF §0, §7)

- **You do not commit.** Leave the tree dirty; the orchestrator verifies and commits.
- **Stay inside your file list.** Another agent is editing the other files right now. If you
  believe you need a file you do not own, stop and report it — do not edit it.
- **Do not run the full suite** (`pnpm test`) — three agents at once against a shared tree makes
  every count worthless (CLAUDE.md non-negotiable 2). Run only your own package:
  `pnpm --filter @repoboard/core exec vitest run test/<yours>.test.ts` (or `repoboard` for the
  server package). The orchestrator runs the full suite serially at the end.
- **Every save must parse** — the tree hot-reloads into the owner's browser.
- Run `biome check --write <your files>` before reporting (§7.6).
- Move your card and set `assignee` — both, they are different things (§7.9):
  `node packages/server/dist/cli.js card move <id> doing --as claude/<role>` and
  `node packages/server/dist/cli.js card update <id> --assignee claude/<role>`.
  Leave the card in `doing`; the orchestrator moves it on.
- **Claims carry numbers.** Report measurements, not adjectives. If you did not measure it,
  say so.
- **Your protective test is verified the CLAUDE.md way, not assumed.** Break the thing it
  guards, **read the file back to confirm the perturbation landed**, confirm it still
  **typechecks**, confirm the test **fails in the direction you fear**, then restore with a
  targeted edit — never `git checkout`. Paste the failing output into your report. A control you
  did not watch fail is not evidence.

---

## RCB-28 — K8: one external mutation, one ticker entry

**Owns:** `packages/server/src/store.ts`, `packages/server/test/store.test.ts`.

**Symptom as recorded** (README K1..K8 list): a CLI `card move` followed by a hand edit puts two
lines in the ticker, `ship-agent moved RCB-22 → doing` and `file moved RCB-22 → doing`.

**Measure before you fix.** The recorded trigger may be wrong. The orchestrator's reading of
`store.ts` is that the hand edit is incidental: a CLI `card move` *alone*, against a running
`serve`, is enough. The CLI is a second process; it calls `writeCard` then `appendEvent`, so the
server's watcher sees two changes — `cards/<id>.md` (→ `refreshCard(path,'watch')`, which diffs
against a now-stale `prevCard.status` and synthesises `actor:'file'`) and `events.jsonl`
(→ `loadEvents`, which emits the CLI's own event). **Confirm or refute that with a test before
changing anything**, and report which it was. If the recorded description is wrong, say so — a
finding that contradicts this brief is the most valuable thing you can return (CLAUDE.md).

**The fix — a claim check, not a timer.** `events.jsonl` is where a process states what it did.
The watcher should synthesise only for a change nobody claimed. Note that `moveCard`,
`updateCard` and `appendLog` all set `card.updated` to the same ISO string as the event's `ts`,
so `(cardId, ts) == (card.id, card.updated)` identifies a claim exactly.

In `refreshCard`, for `origin === 'watch'` only:
1. `await this.loadEvents()` first, so the log is current at the moment you decide (do not wait
   for the watcher's own `events.jsonl` task — ordering between the two is not guaranteed).
   `loadEvents` is offset-based, so calling it here and again from the watcher emits nothing
   twice; both run on the same serial `enqueue` queue.
2. Skip the synthesised event when the log already holds one with
   `cardId === card.id && ts === card.updated`.
3. Otherwise synthesise exactly as today.

A `sed` edit that does not touch `updated` has no claim and must still produce its `file` event —
that is the product's headline behaviour and it must not regress.

**Do not** add a delay to the `card` emit. The 282 ms sed-to-board number is the thesis; the
board push stays immediate whatever you do to the event.

**DoD**
- A test that reproduces the duplicate on the *pre-fix* code (state clearly what the real trigger
  is) and passes after.
- A test that a hand edit changing only `status:` (no `updated` bump, no `events.jsonl` append)
  still yields exactly one `actor:'file'` event of type `move`.
- A test that a hand edit that bumps `updated` but appends nothing to `events.jsonl` still yields
  one `file` event — an agent editing by hand correctly must not go silent.
- Control, verified the way above: remove the claim check, watch the duplicate test fail.
- Numbers: events emitted per mutation, before and after, for each of the three paths.

---

## RCB-29 — K1(b): a title with a colon

**Owns:** `packages/core/src/card.ts`, `packages/core/test/card.test.ts`.

`title: P3.1 Board view: columns` is invalid YAML. 7 of the first 24 hand-written cards hit this
(HANDOFF §7.1). (a) `AGENTS.md` says quote it and (c) `serializeCard` always quotes — both done.
This is (b): recover on parse.

**Scope, tightly.** The fallback exists for the `title` line and nothing else. Rules:
- It runs **only** after `YAML.parse` throws, never as a first attempt, and never on a document
  that parsed. A file that is valid YAML keeps exactly today's meaning.
- Retry once with **only** the `title` line quoted: find the first line matching
  `^title:[ \t]+(.*)$` in the frontmatter, and only when the value is not already quoted and does
  not start with a YAML indicator that would make quoting change meaning (`|`, `>`, `&`, `*`,
  `!`, `#`, `{`, `[`). Quote it as a YAML double-quoted scalar with proper escaping — do not
  hand-roll `"` + value + `"`; escape `\` and `"` at minimum. If the retry also fails, return the
  **original** error message, not the retry's — the user must not be told about a rewrite they
  did not write.
- The recovered card must round-trip: `serializeCard(parseCard(x).card)` re-parses to the same
  card, with the title quoted.
- `packages/core/test/purity.test.ts` must stay green — no new imports outside the allowlist
  (`yaml`, `zod`).

**Also update** the error path nobody sees: when a file is still invalid, the message is what the
board shows in red. Leave it as informative as it is now.

**DoD**
- Tests: unquoted colon title recovers; the recovered card equals the same card written with a
  quoted title; round-trip through `serializeCard` is stable; a *genuinely* broken frontmatter
  (e.g. bad indentation, a colon in some *other* value) still fails, with the original error
  text; a valid document is byte-identically unaffected (parse the 27 real cards in
  `.repoboard/cards/` read-only and assert every one still parses — do not write to them).
- Control: disable the fallback, watch the recovery test fail; then break the *guard* (make the
  fallback run on documents that already parsed) and show a test catches that too — the feared
  direction here is a lenient parser silently changing a valid file's meaning, not just a strict
  one rejecting a fixable file.
- Numbers: tests before/after; how many of this repo's 27 cards change parse outcome (expected: 0).

---

## RCB-30 — K5: `@repoboard/core` ships built JS and types

**Owns:** `packages/core/package.json`, and one new test file you name (put it in
`packages/server/test/` — it is a packaging check and core's suite must stay I/O-free per P0.2).
You may read anything. **You may not edit `packages/core/src/*`** (RCB-29's agent is in there).

`packages/core` already has `build: tsc -p tsconfig.build.json` emitting `.js`, `.d.ts` and maps
to `dist/`, and `files: ["dist"]`. The defect is only that `main`, `types` and `exports` point at
`./src/index.ts`, so a third party importing `@repoboard/core` on plain Node gets TypeScript.

**Constraint that decides the shape:** the local workspace resolves core from source — vitest,
`tsc`, and tsup all consume `./src/index.ts` today, and `pnpm test` on a clean clone must keep
working **without a build step**. So do **not** just repoint `exports` at `dist`. Use
`publishConfig` (pnpm rewrites it into the packed manifest) to carry the published shape:
`main`, `types`, and an `exports` map with `types` then `default` pointing into `./dist`.
If you find a better mechanism, argue it with a measurement, do not just prefer it.

**`private: true` stays.** O4 and O2 are the owner's and nothing publishes in this task. The
deliverable is that removing that one line is the only remaining step.

**DoD**
- `pnpm --filter @repoboard/core build`, then a test that asserts, on the *built* artifact:
  `dist/index.js` and `dist/index.d.ts` exist; a plain `node --input-type=module -e "import(...)"`
  against `dist/index.js` (no bundler, no ts resolution, from a cwd outside the repo) resolves and
  exposes `parseCard`, `serializeCard`, `moveCard`, `createCard`; and every path named in
  `publishConfig` exists under `dist/` after a build. Skip cleanly with a clear message if
  `dist/` is absent so a build-less `pnpm test` does not fail — but then also prove the test
  *does* fail when `dist` exists and a path is wrong (that is your control).
- Run `pnpm pack --filter @repoboard/core --pack-destination <a temp dir>` (or
  `pnpm --filter @repoboard/core pack`, whichever this pnpm 11 accepts) and report the file list
  and byte size of the tarball. Confirm by content — `tar -tzf` — that it contains `dist/*.js`
  and `dist/*.d.ts` and **no** `src/`. Delete the tarball afterwards; it is not a deliverable.
- Confirm the server is unaffected: `pnpm --filter repoboard build` still succeeds and
  `node packages/server/dist/cli.js card list` still prints the table (tsup must still bundle
  core from source).
- Numbers: tarball bytes and file count, files in `dist`, and the tests you added.

---

## Report back

One report each: what you changed and why, the control's failing output pasted, the numbers, and
anything you found that contradicts this brief. Do not commit. Do not run `pnpm test`.
