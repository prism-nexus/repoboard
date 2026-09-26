# Contributing to repoboard

## Run it locally

```sh
pnpm install
pnpm build
node packages/server/dist/cli.js serve --open
```

`pnpm dev` runs the server and web app together with hot reload. CI runs on Node 22 and 24; use
either (the pinned pnpm needs Node >= 22.13 to develop; the published package itself runs on Node
20 and up, which CI's pack-smoke job covers). This repo's pnpm version is pinned in
`package.json`'s `packageManager` field (`"pnpm@11.18.0"`) — use that version.

## Layout

- `packages/core` — domain logic, no I/O, pure functions.
- `packages/server` — CLI, HTTP, WebSocket, the repo watcher, MCP.
- `packages/web` — Vite + React + d3.

`docs/AGENTS.md` is the agent-facing contract for the `.repoboard/` board file formats and CLI/MCP
surfaces. `docs/BUILD-PLAN.md` has the settled decisions: §1 for product decisions, §11 for owner
decisions. Decisions in §11 are the owner's — open an issue to propose changing one, do not PR it
silently.

## Before you open a PR

Run, in order:

```sh
pnpm test        # twice — see below
pnpm typecheck    # exit 0, no `any` added to silence it
pnpm lint         # exit 0
pnpm build        # exit 0
node packages/server/dist/cli.js check   # prints `ok`, or only `needs-decision:` lines
```

Run `pnpm test` **twice**. The suite has a filesystem-watcher test that is timing-sensitive; two
green runs in a row is the bar, not one. CI sets `REPOBOARD_WATCH_DIAG=1` so a watcher-related
failure prints its trace; set it locally (`REPOBOARD_WATCH_DIAG=1 pnpm test`) to get the same
trace. `pnpm test` also runs the web bundle size check (`pnpm --filter @repoboard/web check:size`,
limit 600 KB gzipped JS).

`node packages/server/dist/cli.js check` must print `ok`, or only `needs-decision:` lines (that
finding is informational and never fails) — anything else means the dogfood board
(`.repoboard/`, see below) is inconsistent with your change.

State, in your PR description, what you measured: the current test count from `pnpm test`'s
`Tests` line, and the gzipped web bundle size from `check:size`'s output — both with the date you
ran them. Not adjectives; numbers.

## What a PR needs

- One concern per PR. PRs are squash-merged (the only merge method enabled), so the PR title
  becomes the commit subject on `main`; the branch is deleted on merge.
- Tests for behaviour: a bug fix carries the test that failed before the fix and passes after.
- The PR description states what was measured (counts, sizes, timings) with the date, not
  adjectives.
- Conventions from this repo's `CLAUDE.md` that apply to contributors:
  - A missing value is stored as `null`, never as a plausible number.
  - An unconfigured rule is inert — an empty config yields everything, not silently nothing.
  - Every stored value carries its provenance; a number nobody can attribute is a number nobody
    can debug.

No CLA. The license is MIT and your sign-off is your commit's author line — a DCO is not
required (the owner may turn one on later).

## The `.repoboard/` directory

`.repoboard/` is the maintainers' own board, kept public on purpose (this project dogfoods
itself). It is not where outside contributors file work: open a GitHub issue instead of adding or
editing a card. You will see commits from maintainers' agents ("seats") moving cards and
appending to `.repoboard/log/` on `main` between PRs — that traffic is normal and is not part of
your PR's review.

## Reporting bugs / proposing features

Open an issue with the **Bug report** or **Feature request** template. For a security
vulnerability, see `SECURITY.md` instead of opening a public issue.
