# Brief — RCB-60 (B4) `seat` warns when dist/ is older than src/ (2026-09-19)

One agent (sonnet). The builder seat verifies, gates, commits, pushes. Other agents may be
working this tree on other files; stay inside "Owns". Never `git add/stash/checkout/restore`.

Baseline: see the builder's numbers in the dispatch message (the tree has RCB-57/61/62 changes
landing around you; the targeted file counts you report are what matter).

## Why

`docs/RIG.md` §"Build first": "A stale `dist/` silently runs old code; if in doubt, rebuild."
Every seat has been bitten. The CLI is `node packages/server/dist/cli.js` (tsup bundle of
server + core; `packages/web/dist` is copied into `packages/server/dist/web` by
`scripts/copy-web.mjs`). `repoboard seat <name>` is the cold-start command every seat runs
first — the right moment for one warning line.

## Design (read-only, no dependency)

`packages/server/src/dist-stale.ts` (new), one exported async function:

```ts
/** RCB-60 … */
export async function distStaleness(repoRoot: string): Promise<string | null>
```

- `repoRoot` is THIS CLI's own monorepo root, NOT the board's `--root`: derive it in `cmdSeat`
  from `import.meta.url` (`http.ts:145` already does `dirname(dirname(fileURLToPath(import.meta.url)))`
  for the package dir; the monorepo root is two more `dirname`s up). If `<repoRoot>/packages`
  does not exist (an npm install, no source tree) → `null`, silent. Never throws: any fs error
  → `null`.
- For each dir in `<repoRoot>/packages/*` that has BOTH `src/` and `dist/`: newest mtime under
  `src/` (recursive, files only, skip `node_modules`, `.d.ts` irrelevant since src has none)
  vs newest mtime under `dist/` (recursive, files only). If any package's newest src > newest
  dist → return the string `dist is older than src — run pnpm build` followed by ` (` + the
  stale package names joined by `, ` + `)`; else `null`. Exactly one line.
- `cmdSeat` in `packages/server/src/cli.ts`: after the bundle prints (so a seat's cold-start
  read is never blocked or reordered by the check), write the warning to
  `(io.stderr ?? io.stdout)` as `warning: <line>\n`. Also in `--json` mode (stderr does not
  corrupt the JSON on stdout; when `io.stderr` is absent, tests inject one). Exit code
  unchanged (0). Do not add it to any other command.
- Accept an injectable root for tests: `cmdSeat` reads `io.env?.REPOBOARD_SELF_ROOT` as an
  override of the derived root — document it as test-only in a comment; a `CliIO.env` already
  exists.

## Rules (CLAUDE.md; docs/RIG.md)

- **You do not commit.** Leave the tree dirty.
- **No `pnpm test`.** The builder holds `/tmp/fpj-vitest.lock` — never `mkdir`/`rm` it. Run
  only: `pnpm --filter repoboard exec vitest run test/dist-stale.test.ts test/cli.test.ts`.
- **Every save must parse**: `pnpm typecheck` after each save, exit 0, **no `any`**.
- `pnpm lint` clean on your files (`pnpm exec biome check --write <files>` first).
- **Claims carry numbers.** Control: flip the comparison direction (`>` → `<`), read it back
  with `grep -n`, typecheck with it in place, paste the failing assertion, restore by edit,
  `git diff --stat`, re-run green.

## Owns

`packages/server/src/dist-stale.ts` (new), `packages/server/test/dist-stale.test.ts` (new),
`packages/server/src/cli.ts` (`cmdSeat` only + the import), `packages/server/test/cli.test.ts`
(new tests only, appended in a new `describe('seat: dist staleness (RCB-60)')`), `docs/AGENTS.md`
(ONLY: add one sentence to the `repoboard seat <name> [--json]` row in §10's table: "Prints
`warning: dist is older than src — run pnpm build (<pkgs>)` on stderr when run from a source
checkout whose `packages/*/src` is newer than its `dist` (RCB-60); silent from an npm install."
— another agent (RCB-57) is editing the SAME row's "first todo" clause; re-read the file
immediately before your edit and change only your sentence).

## Tests (`dist-stale.test.ts`, temp dirs + `utimes`)

1. Fresh dist (dist mtime > src mtime) → `null`.
2. One stale package among two → the line names only that package.
3. No `packages/` → `null`. A package with `src` but no `dist` → ignored, `null`.
4. Nested src file newer than every dist file → stale (recursion proven).
5. `cli.test.ts`: `seat builder` with `env.REPOBOARD_SELF_ROOT` pointing at a stale fixture tree
   → stderr contains the line, stdout is the normal bundle, exit 0; with a fresh tree → stderr
   empty.
6. Control as above.

## Report (numbers)

Targeted vitest before/after per file; typecheck 0; lint 0; control assertion verbatim;
`git diff --stat`; the line the built CLI prints on THIS checkout right after `pnpm build`
(should be nothing) and after `touch packages/core/src/index.ts` (should be the warning —
then `touch` a dist file back or rebuild; say which you did).
