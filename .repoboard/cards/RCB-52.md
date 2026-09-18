---
id: RCB-52
title: "Owner lane = ONE queue: the Needs-decision column holds owner WORK items as well as letters (a card can carry an `owner:` task instead of a decision; same column, same OWNER QUEUE line, no new lane; `card ask` today is the workaround) (owner 2026-09-18)"
status: doing
assignee: builder
priority: medium
created: 2026-09-18T19:52:32Z
updated: 2026-09-18T20:32:48Z
---

**Shape (builder 2026-09-18 20:4xZ, coordinator concurred):** the owner's words were about ONE
queue, not about the record shape. `owner:` in the title is a RENDERING, not a frontmatter field:
the existing `decision:` block gains `kind: task` (O10 — no new record type; `needsDecision` stays
the one gate into the decide column, OWNER QUEUE and `check`), the queue line reads
`<id> · owner: <text>`, the badge is `!`, and `card decide <id>` with no letter and no words closes
it. Brief: `docs/RCB-52-OWNER-TASK-BRIEF.md`.

## Log
- 2026-09-18T20:32:48Z builder — moved todo → doing
- 2026-09-18T20:32:48Z builder — updated assignee
