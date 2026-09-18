# Brief — RCB-49 open-source readiness files (2026-09-18)

One agent, docs and templates only — **no source code changes**. The builder seat verifies, commits,
pushes, and then cuts the `v0.1.0` tag itself (the tag is NOT the agent's job).

Baseline on `main` @ 6ddc269, measured 2026-09-18 by the builder: 687 passed | 2 skipped (689) ×2, typecheck 0, lint 0 (125 files), build 0; web bundle 145.36 KB JS + 5.62 KB CSS gzip.

## Context

The repo went public at https://github.com/prism-nexus/repoboard on 2026-09-18 20:3xZ (owner's push).
`repoboard` is NOT on npm yet (K5 / RCB-51 wait on the owner's npm account). License: MIT,
`LICENSE` copyright line unchanged. CI exists: `.github/workflows/ci.yml` runs `pnpm test`,
`typecheck`, `lint` on Node 20 and 22 on every push and PR. `packages/server` is `repoboard@0.1.0`;
`@repoboard/core` and `@repoboard/web` are private workspace packages.

The dogfood board `.repoboard/` is public and IS the maintainers' board: cards, daily log, STATE,
leases. Outside contributors do not file cards; they open GitHub issues. Seats (agents) and the
owner file cards.

## Rules (CLAUDE.md; HANDOFF §7)

- **You do not commit.** Leave the tree dirty.
- **Stay inside your file list.** Need another file → stop and report.
- **No tests to run** — you change no code. Do run `pnpm lint` at the end (biome checks the repo;
  markdown is not linted but confirm exit 0 anyway) and `pnpm typecheck` once (exit 0, proving you
  touched nothing that compiles).
- **Claims carry numbers.** Where a document states a number (test count, bundle size, file
  count), MEASURE it and say when; where you cannot measure, say so rather than guess.
- Do not invent contact e-mail addresses. Where a template wants one, use the GitHub route named
  below and flag it in your report for the owner to swap.
- Never write to any other repo on this machine.

## Owns (all new unless marked)

`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`,
`.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`,
`.github/ISSUE_TEMPLATE/config.yml`, `.github/PULL_REQUEST_TEMPLATE.md`,
`README.md` (existing — three paragraphs only, listed below), `docs/AGENTS.md` (existing — one
pointer line only, if there is a natural place; otherwise leave it and say so).

## The files

### CONTRIBUTING.md (≤120 lines)

Sections, in this order:
1. **Run it locally** — `pnpm install`, `pnpm build`, `node packages/server/dist/cli.js serve
   --open`; `pnpm dev` for hot reload (server + web). Node 20 or 22 (what CI runs); pnpm from the
   `packageManager` field in `package.json` (quote the exact version string from there).
2. **Layout** — `packages/core` (domain, no I/O, pure functions), `packages/server` (CLI, HTTP,
   WebSocket, watcher, MCP), `packages/web` (Vite + React + d3). Point at `docs/AGENTS.md` for the
   agent-facing contract and `docs/BUILD-PLAN.md` for settled decisions (§1, §11) — "decisions in
   §11 are the owner's; open an issue to propose changing one, do not PR it silently".
3. **Before you open a PR** — the exact gate: `pnpm test` **twice** (the suite has a filesystem
   watcher test that is timing-sensitive; two green runs are the bar), `pnpm typecheck` exit 0 with
   **no `any` added to silence it**, `pnpm lint` exit 0, `pnpm build` exit 0, and
   `node packages/server/dist/cli.js check` prints `ok` (or only `needs-decision:` lines) so the
   dogfood board is consistent. Measure and state the current test count and the gzipped web bundle
   size with the date (the size check is `pnpm --filter @repoboard/web check:size`, limit 600 KB).
4. **What a PR needs** — one concern per PR; tests for behaviour (a fix carries the test that
   failed before it); the PR description states what was measured (counts, sizes, timings), not
   adjectives; conventions from CLAUDE.md that apply to contributors, quoted briefly: a missing
   value is stored as `null` never a plausible number; an unconfigured rule is inert (an empty
   config yields everything); every stored value carries its provenance. No CLA — MIT, and the
   sign-off is your commit author line (say DCO is not required; the owner may turn it on later).
5. **The `.repoboard/` directory** — it is the maintainers' own board, public on purpose
   (dogfooding). Do not add or edit cards in a PR; open an issue instead. Maintainers' agents
   ("seats") move cards and append to `.repoboard/log/`; that traffic is normal on `main`.
6. **Reporting bugs / proposing features** — the two issue templates; security → `SECURITY.md`.

### CODE_OF_CONDUCT.md

Contributor Covenant **v2.1**, verbatim (it is CC BY 4.0; keep its attribution paragraph). For the
enforcement contact, write: *"Report to the maintainers through a GitHub issue, or privately via
the repository's Security tab (GitHub private vulnerability reporting), if the report is sensitive."*
Flag in your report that the owner may replace this with an e-mail address.

### SECURITY.md (≤40 lines)

- Supported versions: `0.1.x` (the only line; it is pre-1.0).
- Threat model in three sentences: the dashboard binds `127.0.0.1` only and never accepts remote
  connections; the store reads and writes `.repoboard/` in the repo it serves and nothing else
  (`--root` on a foreign directory is read-only and writes nothing); no data leaves the machine —
  there is no telemetry, no network call. Quote `README.md` "The idea" for the binding claim and
  check `packages/server/src/http.ts` or `cli.ts` for the literal `127.0.0.1` — cite the line.
- Reporting: GitHub private vulnerability reporting (Security tab → "Report a vulnerability");
  say the owner must enable it (it is on the GitHub checklist in RCB-49's card body). Target
  acknowledgement: state none; say "best effort, pre-1.0" — do not invent an SLA.

### .github/ISSUE_TEMPLATE/

- `bug_report.md` — front matter `name: Bug report`, `about`, `labels: bug`. Fields: what you ran
  (exact command or UI action), what you expected, what happened (paste output), `repoboard`
  version (`node packages/server/dist/cli.js --version` if that flag exists — check `cli.ts`; if
  not, say "commit sha"), OS and Node version, and "does `repoboard check` pass on your board?".
- `feature_request.md` — `labels: enhancement`. Fields: the problem (what you could not do), the
  agent or human workflow it serves, what you would expect to see on the board or in the CLI, and
  "is this a plan §11 decision?" (link `docs/BUILD-PLAN.md`).
- `config.yml` — `blank_issues_enabled: false`; one contact link to `SECURITY.md` for
  vulnerabilities.

### .github/PULL_REQUEST_TEMPLATE.md (≤30 lines)

Checklist mirroring CONTRIBUTING §3 with literal commands and a "Measured:" block (tests ×2 counts,
typecheck/lint/build exit codes, bundle size if `packages/web` changed), "What changed and why"
(one paragraph), "Which issue" (`Closes #n`), and "Touches `.repoboard/`? (should be no for outside
contributors)".

### CHANGELOG.md

Keep-a-Changelog format, `## [Unreleased]` empty, then `## [0.1.0] — 2026-09-18` with a
**Highlights** list of what 0.1.0 IS, written from the repo, not from memory: the board as markdown
files + `board.yml`; the local dashboard (board, map, drawer with live refs, ticker, STATE panel,
log timeline, now-strip); the CLI (`init`, `card add/move/update/list/show/ask/decide`, `lease`,
`window`, `state`, `log`, `seat` if it has landed by the time you write — check `git log` and the
help text, `check`, `cost`, `archive`, `sync-issues`, `serve`); MCP tools (count them in
`packages/server/src/mcp.ts` — the `TOOL_NAMES` or equivalent list — and state the number); HTTP
+ WebSocket API; the practices layer (STATE.md, daily log per seat, leases/windows, decisions and
owner tasks on cards, cold-context cost). Cite each highlight with a plan task id (P-numbers from
`docs/BUILD-PLAN.md` §5) so a reader can find the decision. Link the compare URL
`https://github.com/prism-nexus/repoboard/releases/tag/v0.1.0` (the builder cuts the tag after
this lands; write the link anyway).

### README.md — three edits only

1. **Try it**: the sentence "Once `repoboard` is on npm (it is not yet — see Status)" stays true;
   add one line after the checkout instructions: the repo is at
   https://github.com/prism-nexus/repoboard and contributions go through `CONTRIBUTING.md`.
2. **Develop**: the fenced comment `# vitest (250 tests) + a gzipped-bundle size check (135.7 KB JS,
   limit 600 KB)` is stale — replace the two numbers with what you MEASURE now
   (`pnpm test` output's `Tests` line and the `check:size` output) and add the date in the comment,
   or drop the numbers and keep only the limit. Say which you did and why.
3. **Status**: "No GitHub repo until after v1 (O2)." is false since 20:3xZ — rewrite the paragraph:
   public at the GitHub URL since 2026-09-18, tagged `v0.1.0`, not on npm yet (K5 waits on the
   owner's npm account); keep the packaging sentences that are still true (re-measure the tarball
   claim with `pnpm --filter repoboard pack --dry-run` or `npm pack --dry-run` in
   `packages/server` — if the numbers moved, update them with today's date; if you cannot run it,
   say so and leave the old numbers with their old date).

## Report (numbers)

1. Every number you wrote into a file, with the command that produced it and the date.
2. `pnpm lint` and `pnpm typecheck` exit codes; `git status --short` (must list only your files).
3. Line counts of each new file (`wc -l`).
4. The places where you had to choose (contact method, `--version` flag existence, whether `seat`
   had landed, tarball re-measure) and what you chose.
5. Anything in this brief that measured wrong.
