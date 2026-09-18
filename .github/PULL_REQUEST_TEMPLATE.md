## What changed and why

<!-- One paragraph. -->

## Which issue

Closes #

## Measured

Run `pnpm test` **twice**, then `pnpm typecheck`, `pnpm lint`, `pnpm build`:

- Tests (run 1): <!-- e.g. 687 passed | 2 skipped (689) -->
- Tests (run 2): <!-- same count, second green run -->
- `pnpm typecheck` exit code:
- `pnpm lint` exit code:
- `pnpm build` exit code:
- Gzipped web bundle size (only if `packages/web` changed —
  `pnpm --filter @repoboard/web check:size`):

## Checklist

- [ ] `pnpm test` twice, both green
- [ ] `pnpm typecheck` exit 0, no `any` added to silence it
- [ ] `pnpm lint` exit 0
- [ ] `pnpm build` exit 0
- [ ] `node packages/server/dist/cli.js check` prints `ok` (or only `needs-decision:` lines)
- [ ] One concern per PR
- [ ] Tests added for the behaviour this PR changes
- [ ] Touches `.repoboard/`? (should be **no** for outside contributors — see `CONTRIBUTING.md`)
