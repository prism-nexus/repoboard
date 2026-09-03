# Brief: P6 Ship (P6.0 rename, P6.1 README, P6.2 npx works) — P6.3 is the owner's

You are implementing P6.0–P6.2 of `docs/BUILD-PLAN.md`. Read `CLAUDE.md`, plan §5 P6 and
§11 (O1–O3 are ANSWERED — read them), `README.md` as it stands, `docs/AGENTS.md`. Do NOT
commit. Do NOT publish to npm or create a GitHub repo (O2: after v1).

## P6.0 first — the rename (plan §11 O1)
Package `@rcb/server` → `repoboard` (unscoped, this is the one that publishes); `@rcb/core` →
`@repoboard/core`, `@rcb/web` → `@repoboard/web`; bin `rcb` → `repoboard`; data dir `.rcb/` →
`.repoboard/` (move this repo's own with `git mv`); default prefix `RCB` → `RB` in
`defaultBoardConfig()` — but this repo's own `board.yml` keeps `prefix: RCB` so existing card
ids stay valid; events file `.repoboard/events.jsonl`; `localStorage` keys `rcb.*` →
`repoboard.*`; the wordmark in the top bar; every doc, brief, test fixture and error string.
`grep -rni '\brcb\b' --exclude-dir=node_modules --exclude-dir=.git .` must return only
`docs/HANDOFF.md` history lines and this repo's own card ids/prefix when you are done — paste
that grep's output. Update `.gitignore`. Run the full suite after.

## K6 (README) — compact list output
`repoboard card list --json` currently emits 14.1 KB for 24 cards because it includes bodies;
the table is 1.9 KB. Make `--json` compact by default (`id, title, status, assignee, priority,
labels, files, updated`) with `--full` for bodies; make MCP `list_cards` return the same
compact shape. Measure both before and after and paste the byte counts. Edit the K6 entry in
README to record the numbers and mark it closed.

## P6.2 — `npx repoboard` from a tarball
- Root `pnpm build` must produce `packages/server/dist/cli.js` AND copy `packages/web/dist`
  into `packages/server/dist/web` so the published package is self-contained. Add that copy
  step (a small node script, no shell-isms, works on Windows). `http.ts` already looks in
  `dist/web` first.
- `cd packages/server && pnpm pack` → a tarball. In a temp dir outside the repo: `git init`,
  make one commit, `npm install <tarball>`, `npx repoboard init`, `npx repoboard card add "Hello: world"`,
  `npx repoboard card list`, `npx repoboard serve --port 4545` in the background, `curl /` returns the
  built HTML (not "web not built"), `curl /api/board` shows the card, kill it. Paste all of it.
- `package.json` for `repoboard`: `files`, `bin`, `engines.node >=20`, `license: MIT`,
  `keywords`; leave `repository` out until O2 (no GitHub yet).
- Check `npm pack --dry-run` output lists no test files, no source maps over 1 MB, nothing
  from `.repoboard/`.

## P6.1 README
Rewrite `README.md` top-to-bottom, keeping the `## Known issues` section verbatim at the end.
Sections, in order, each short:
1. One-line pitch and a screenshot placeholder line `![board](docs/board.png)` — then TAKE
   that screenshot: `pnpm dev` (check `lsof -i :4242` first; if held, use `--port 4646`) on
   this repo's own board, dark theme, 1400×850, save to `docs/board.png`, and a second one of
   the map at `docs/map.png`. Use the Chrome tools (ToolSearch
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__tabs_close_mcp`).
   A GIF is a stretch goal: if `ffmpeg` is on PATH, record ~15 s of a card moving via a `sed`
   in another shell; otherwise say so and leave the two PNGs.
2. **Try it** — `npx repoboard init && npx repoboard serve --open`, three lines.
3. **The idea** — files are the database; cards are markdown; git is the history; any agent
   that can edit a file can move a card. Five sentences max.
4. **For agents** — CLI first, MCP second, file edit as the escape hatch (plan §11 O3 has the
   token numbers; cite them); link to `docs/AGENTS.md`, and reorder AGENTS.md the same way.
5. **What it shows** — board, map (treemap/churn/who-is-where/import graph), ticker. One line
   each, no adjectives without a number.
6. **Config** — `.repoboard/board.yml` example from plan §2.
7. **Develop** — `pnpm install`, `pnpm test`, `pnpm dev`, link to `docs/BUILD-PLAN.md`.
8. **Status / Known issues** — "pre-1.0", then the existing list.
No working-name caveat any more; the name is `repoboard`.

## Definition of done
`pnpm test`, `pnpm typecheck`, `pnpm lint` exit 0. The rename grep. K6 byte counts. The tarball transcript above. Both PNGs
exist and you looked at them. Report: file list, outputs, tarball size, anything that did not
work.
