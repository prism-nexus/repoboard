---
id: RCB-93
title: "`repoboard local init` moves a repo's tracked STATE.md and log/ into .repoboard/local/ UNCONDITIONALLY (local.ts localInit → moveIntoLocal(root,'STATE.md') / ('log')), and store.ts switches statePath/logDir to the local layer the moment the DIRECTORY exists (hasLocalLayer = isDirectory(localDir)), git repo or not. On freshpickedjobs (STATE.md tracked, logDir docs/log, three live seats sharing the checkout) a plain mkdir .repoboard/local would make STATE.md read as missing for every seat at once; init would rename a tracked file. The cmdLocal comment (cli.ts ~1338) still says the record moves only 'once an owner git mv's them in' — stale. Wanted: (1) init refuses to move a TRACKED STATE.md/log (git ls-files) unless --move-record is passed, and says so; (2) the local layer holds RIG.md/env/briefs WITHOUT owning STATE/log when board.yml's logDir is set or STATE.md is tracked — the state path follows the tracked file, only RIG.md/env/briefs come from local/; (3) seat <name> prints local/RIG.md whenever it exists, independent of where STATE lives; (4) the comment fixed. Found by the K153 sonnet 2026-09-22 (fpj FPJ-96, stopped before running init)."
status: todo
assignee: repoboard builder
size: M
labels:
  - local
  - cold-start
created: 2026-09-22T03:47:46Z
updated: 2026-09-22T03:47:46Z
---

## Log
- 2026-09-22T03:47:46Z coordinator — moved backlog → todo
- 2026-09-22T03:47:46Z coordinator — updated assignee
