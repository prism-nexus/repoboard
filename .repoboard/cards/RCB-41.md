---
id: RCB-41
title: "Repo name on the board: board.yml `name` (default = folder), shown in the top bar and the browser tab title"
status: doing
labels:
  - practices
created: 2026-09-17T23:32:23Z
updated: 2026-09-17T23:51:27Z
---

## Body
Owner 2026-09-17 23:5xZ: "We should also make sure that repoboard displays the name of the repo, this may only be the issue that the live board is in its own repo."

Measured: `TopBar.tsx` already shows `repoName(repo.root)` = the last path segment of the served root, plus branch and short sha. On the live board that reads **Remember-Connect-Build** (the folder), not "repoboard"; on freshpickedjobs it will read **freshpickedjobs**. The browser tab `<title>` is the constant `repoboard` (`packages/web/index.html`), so two boards open at once (4242 / 4243) are indistinguishable in the tab strip, and `document.title` is never set.

Build: optional `name:` in `board.yml` (default: folder name, as today); top bar shows it; `document.title` = `<name> · repoboard`; `/api/board` config carries it. Tests: default vs explicit name; title set on connect. Small; after P8.5, before or alongside adoption. Nothing to decide.

## Log
- 2026-09-17T23:51:27Z claude/builder — moved todo → doing
