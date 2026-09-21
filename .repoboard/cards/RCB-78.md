---
id: RCB-78
title: "Lean-up: run repoboard archive (done >14d); move fpj MCP servers + autoMode env from global settings to fpj project scope"
status: done
priority: medium
size: S
labels:
  - board
decision:
  question: "Owner: move the job-search MCP servers out of user scope so repoboard sessions stop loading ~45 foreign tool schemas. Blocked for the builder (auto-mode classifier: self-modification). Run: (cd \"~/Projects/Repos/Job Seeker\" && claude mcp add job-seeker -s local -- node \"~/Projects/Repos/Job Seeker/job-seeker-stable/mcp_server.js\"); claude mcp remove job-seeker -s user; claude mcp remove freshpickedjobs -s user (fpj already has it at project scope); delete the dead mcpServers.job-pipeline block and the fpj-specific autoMode.environment list from ~/.claude/settings.json (it belongs in fpj's own .claude/settings.json)."
  kind: task
  options: []
  askedBy: repoboard builder
  askedAt: 2026-09-21T05:33:49Z
  returnTo: doing
  chosen: null
  words: "done 2026-09-21: job-seeker moved to Job Seeker project scope, job-seeker + freshpickedjobs removed from user scope (claude mcp list from this repo: Claude Docs, gemini only); ~/.claude/settings.json: mcpServers.job-pipeline and autoMode.environment removed, soft_deny kept; 24 environment lines now in fpj .claude/settings.json; archive --dry-run: 0 cards older than 14d"
  decidedBy: owner
  decidedAt: 2026-09-21T17:07:41Z
created: 2026-09-21T05:28:44Z
updated: 2026-09-21T17:07:51Z
---

## Log
- 2026-09-21T05:33:49Z repoboard builder — moved todo → doing
- 2026-09-21T05:33:49Z repoboard builder — moved doing → decide
- 2026-09-21T05:33:49Z repoboard builder — owner task: Owner: move the job-search MCP servers out of user scope so repoboard sessions stop loading ~45 foreign tool schemas. Blocked for the builder (auto-mode classifier: self-modification). Run: (cd "~/Projects/Repos/Job Seeker" && claude mcp add job-seeker -s local -- node "~/Projects/Repos/Job Seeker/job-seeker-stable/mcp_server.js"); claude mcp remove job-seeker -s user; claude mcp remove freshpickedjobs -s user (fpj already has it at project scope); delete the dead mcpServers.job-pipeline block and the fpj-specific autoMode.environment list from ~/.claude/settings.json (it belongs in fpj's own .claude/settings.json).
- 2026-09-21T17:07:41Z owner — done — "done 2026-09-21: job-seeker moved to Job Seeker project scope, job-seeker + freshpickedjobs removed from user scope (claude mcp list from this repo: Claude Docs, gemini only); ~/.claude/settings.json: mcpServers.job-pipeline and autoMode.environment removed, soft_deny kept; 24 environment lines now in fpj .claude/settings.json; archive --dry-run: 0 cards older than 14d"
- 2026-09-21T17:07:41Z owner — moved decide → doing
- 2026-09-21T17:07:51Z repoboard builder — moved doing → done
