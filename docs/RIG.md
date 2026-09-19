# RIG — machine and process facts for every seat

_written 2026-09-18 (RCB-55 A4)_

This page is facts, not status: the rig itself, not what anyone is doing on it. Nothing here is
a queue, a count, or a landing — those live in `.repoboard/STATE.md` and `docs/log/<day>.md`.

## Build first

`pnpm build` before anything else. The CLI is `node packages/server/dist/cli.js` — nothing is on
`PATH`. A stale `dist/` silently runs old code; if in doubt, rebuild.

## Ports

- **:4242** — BOTH boards, one process (RCB-63, owner letter A, 2026-09-19). Start it from this
  root, always with both roots, in this order (the first `--root` is the primary):
  `node packages/server/dist/cli.js serve --root . --root ~/Projects/Repos/freshpickedjobs --port 4242`
  This repo's board is `http://127.0.0.1:4242/`; the fpj board is
  `http://127.0.0.1:4242/?repo=freshpickedjobs` (opened on first request, map on demand; nothing
  is written into the fpj tree). The top-bar `<select>` switches; the RCB-42 `siblings`
  cross-links are gone from both `board.yml`s.
- **:4243** — retired 2026-09-19. Nothing listens there; a pointer to it is stale.
- **:5173** and **:8787** — freshpickedjobs' own dev servers. Never touch, never restart, never
  serve from this repo.
- Stray `serve` processes (`ps -eo pid,command | grep 'cli.js serve'`): only the :4242 pid
  above is this rig's. A scratchpad `--root` on another port belongs to whichever session
  started it — report, do not kill.

## Restart rule

After any `packages/web` landing: rebuild, restart :4242 on the line above (kill the old pid,
start the new one, `lsof -nP -iTCP:4242 -sTCP:LISTEN` shows exactly one), then look at
`?repo=freshpickedjobs` in a browser. It is the owner's board and has caught layout bugs the
repoboard board did not.

## vitest lock

**One runner on the machine, across every session and both repos.** `scripts/vitest-lock.sh
take|release|status` — the three verbs, nothing else. Owner file `/tmp/fpj-vitest.lock/owner`
(override with `VITEST_LOCK_DIR`), one line: `<pid> <cwd> <ISO time> <session>`. Release only
when the owner line's pid is yours; a foreign lock is a human decision (`release --force`
removes it anyway but prints the foreign line it removed, audited). `take` also refuses (exit 3)
inside a live fpj gate window — fpj's own `leases.yml` windows (via `window check`, checked on
both repo roots) and any future-ending line in `/tmp/fpj-lane-windows`. The script is the
protocol; a brief points here and does not restate it.

## Seat names and `--as` values

Plain words, no `claude/` prefix: `builder`, `coordinator`, `ops`.

Cross-session names live on this one machine:
- `repoboard builder` — this repo's builder seat.
- `coordinator` — shared across both repos.
- fpj's `builder` and `Ops` — fpj's own seats.

A repoboard builder talks ONLY to the coordinator — never directly to an fpj seat.

## Subagents

Sonnet, dispatched from a written brief at `docs/<CARD>-…-BRIEF.md`. A subagent never commits,
stays inside its brief's named file list, and never runs `pnpm test` (the orchestrating seat
holds the vitest lock and runs the suite).

## Shared checkout — staging

Two seats commit in this one checkout. **Stage by named path, never `git commit -a` or `git add -A`**
— a builder agent's half-done files may be sitting in the tree (or even STAGED, if it ran `git rm`/`git add`).
A subagent does not stage anything; if one hands back with files staged, unstage them first
(`git restore --staged <path>`). Pull `--ff-only` before every commit; the other seat may have moved HEAD.

## Gate per landing

- Targeted vitest on the touched files while building.
- Full `pnpm test` **×2** at landing, under the lock.
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0.
- `pnpm build` — exit 0.
- One commit per card, the gate's numbers in the message.
- `repoboard check` at start and at stop.

## Reporting

Report the sha to the coordinator. The coordinator verifies it by content on `origin/main`
(`git show origin/main:<path>`, never bare `main`), moves the card, and restamps SEATS.
