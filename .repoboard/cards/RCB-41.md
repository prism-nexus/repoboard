---
id: RCB-41
title: "Repo name on the board: board.yml `name` (default = folder), shown in the top bar and the browser tab title"
status: doing
labels:
  - practices
created: 2026-09-17T23:32:23Z
updated: 2026-09-18T00:06:42Z
---

## Body
Owner 2026-09-17 23:5xZ: "We should also make sure that repoboard displays the name of the repo, this may only be the issue that the live board is in its own repo."

Measured: `TopBar.tsx` already shows `repoName(repo.root)` = the last path segment of the served root, plus branch and short sha. On the live board that reads **Remember-Connect-Build** (the folder), not "repoboard"; on freshpickedjobs it will read **freshpickedjobs**. The browser tab `<title>` is the constant `repoboard` (`packages/web/index.html`), so two boards open at once (4242 / 4243) are indistinguishable in the tab strip, and `document.title` is never set.

Build: optional `name:` in `board.yml` (default: folder name, as today); top bar shows it; `document.title` = `<name> · repoboard`; `/api/board` config carries it. Tests: default vs explicit name; title set on connect. Small; after P8.5, before or alongside adoption. Nothing to decide.

## Log
- 2026-09-17T23:51:27Z claude/builder — moved todo → doing
- 2026-09-18T00:06:42Z claude/rcb-41 — verified: core parseBoard/serializeBoard/boardDisplayName; server GET /api/board carries config.name (present/absent); web TopBar + Map crumb use boardDisplayName; document.title = "<name> · repoboard" on connect and on a live config message. pnpm test x2: 577/577 both (one interleaved run hit the pre-existing K11 watcher flake in store.test.ts, re-ran clean). typecheck/lint/build all exit 0. Controls C1 (boardDisplayName ignoring config.name) and C2 (dropping the document.title assignment) both watched to fail, then restored byte-identical.
