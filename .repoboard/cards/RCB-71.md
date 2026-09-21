---
id: RCB-71
title: "repoboard log --stdin ignores board.yml logDir and has no --as: from the fpj root (logDir: docs/log) it wrote .repoboard/log/2026-09-19.md as seat 'hometown' (2026-09-19 23:0xZ, coordinator)"
status: decide
priority: medium
labels:
  - bug
decision:
  question: "Reproduced 2026-09-21 on f702a80 (scratchpad board, logDir: docs/log, no REPOBOARD_ACTOR): 'log --stdin' wrote .repoboard/log/<day>.md as seat HOMETOWN; docs/log/ stayed empty. Half 1 (--as): the flag has existed on 'log' since P8.3 (09-17); the seat name fell back to $USER because none was passed. Half 2 (logDir): plan P8.6 locked decision 1 says logDir is READ-ONLY and 'repoboard log' only ever writes .repoboard/log/ — so writing to logDir is a plan deviation and is your call. Which?"
  options:
    - letter: A
      text: "Write target follows logDir: when board.yml sets logDir, 'repoboard log' writes there (else local/log, else .repoboard/log). Reverses P8.6 decision 1 (builder's recommendation: fpj's seats already keep docs/log by hand, so a second copy under .repoboard/log is the thing P8.6 wanted to avoid). Plus: 'log' REQUIRES --as (a block header is a seat name; a $USER fallback is never one)."
    - letter: B
      text: "Keep P8.6: logDir stays read-only. Only make --as required on 'log' and have 'log' print WHERE it wrote (full path) so the surprise is visible. Close RCB-71 as by-design for the logDir half."
    - letter: C
      text: Keep P8.6 and add an explicit 'log --to logDir' opt-in for the fpj case; --as required as in A/B.
  askedBy: repoboard builder
  askedAt: 2026-09-21T22:36:56Z
  returnTo: doing
  chosen: null
  words: null
  decidedBy: null
  decidedAt: null
created: 2026-09-19T23:05:59Z
updated: 2026-09-21T22:37:57Z
---
## Notes
- 2026-09-21T22:37:57Z repoboard builder — Builder 2026-09-21 22:4xZ — scoped by content. (1) --as: already existed at c7bc8c6^ (the commit before this card); fpj docs/log/2026-09-19.md:817 shows the coordinator ran `repoboard log --stdin` with no --as, and actorFrom (cli.ts:309) fell through to $USER = hometown. The defect is that the CLI accepts a missing seat at all: the usage line says --as <seat> is required, MCP's append_repo_log already requires seat (mcp.ts:751). FIX in flight: `log` refuses without --as or REPOBOARD_ACTOR, before anything is written. (2) logDir on WRITE: P8.6 locked decision 1 (BUILD-PLAN line 335; store.ts:677–721) — logDir is an ADDITIONAL read-only source; `repoboard log` only ever writes its own log dir (.repoboard/local/log/ with a local layer, else .repoboard/log/). Changing the write target is a plan deviation → the owner's word, not a builder's; left as designed. Brief docs/RCB-71-BRIEF.md → one sonnet.

## Log
- 2026-09-21T22:36:15Z repoboard builder — moved todo → doing
- 2026-09-21T22:36:56Z repoboard builder — moved doing → decide
- 2026-09-21T22:36:56Z repoboard builder — asked: Reproduced 2026-09-21 on f702a80 (scratchpad board, logDir: docs/log, no REPOBOARD_ACTOR): 'log --stdin' wrote .repoboard/log/<day>.md as seat HOMETOWN; docs/log/ stayed empty. Half 1 (--as): the flag has existed on 'log' since P8.3 (09-17); the seat name fell back to $USER because none was passed. Half 2 (logDir): plan P8.6 locked decision 1 says logDir is READ-ONLY and 'repoboard log' only ever writes .repoboard/log/ — so writing to logDir is a plan deviation and is your call. Which? [A|B|C]
