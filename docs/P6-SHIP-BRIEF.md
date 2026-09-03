# Brief: P6 Ship (P6.1 README, P6.2 npx works) — P6.3 is the owner's

You are implementing P6.1 and P6.2 of `docs/BUILD-PLAN.md`. Read `CLAUDE.md`, plan §5 P6 and
§11, `README.md` as it stands, `docs/AGENTS.md`. Do NOT commit. Do NOT publish to npm, create a
GitHub repo, or rename the package — §11 O1/O2 are open and the owner decides.

## P6.2 first — `npx rcb` from a tarball
- Root `pnpm build` must produce `packages/server/dist/cli.js` AND copy `packages/web/dist`
  into `packages/server/dist/web` so the published package is self-contained. Add that copy
  step (a small node script, no shell-isms, works on Windows). `http.ts` already looks in
  `dist/web` first.
- `cd packages/server && pnpm pack` → a tarball. In a temp dir outside the repo: `git init`,
  make one commit, `npm install <tarball>`, `npx rcb init`, `npx rcb card add "Hello: world"`,
  `npx rcb card list`, `npx rcb serve --port 4545` in the background, `curl /` returns the
  built HTML (not "web not built"), `curl /api/board` shows the card, kill it. Paste all of it.
- `package.json` for `@rcb/server`: `files`, `bin`, `engines.node >=20`, `repository`,
  `license: MIT`, `keywords`. Leave `name` as `@rcb/server` — the owner renames.
- Check `npm pack --dry-run` output lists no test files, no source maps over 1 MB, nothing
  from `.rcb/`.

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
2. **Try it** — `npx rcb init && npx rcb serve --open`, three lines.
3. **The idea** — files are the database; cards are markdown; git is the history; any agent
   that can edit a file can move a card. Five sentences max.
4. **For agents** — three ways to move a card (sed, CLI, MCP) with one line each; link to
   `docs/AGENTS.md`.
5. **What it shows** — board, map (treemap/churn/who-is-where/import graph), ticker. One line
   each, no adjectives without a number.
6. **Config** — `.rcb/board.yml` example from plan §2.
7. **Develop** — `pnpm install`, `pnpm test`, `pnpm dev`, link to `docs/BUILD-PLAN.md`.
8. **Status / Known issues** — "pre-1.0", then the existing list.
Keep the working-name caveat in one line near the top.

## Definition of done
`pnpm test`, `pnpm typecheck`, `pnpm lint` exit 0. The tarball transcript above. Both PNGs
exist and you looked at them. Report: file list, outputs, tarball size, anything that did not
work.
