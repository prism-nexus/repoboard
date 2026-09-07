---
id: RCB-31
title: K9 The CLI cannot set assignee after card add
status: todo
assignee: claude/cli-agent
priority: high
labels:
  - cli
  - dx
files:
  - packages/server/src/cli.ts
  - packages/server/test/cli.test.ts
refs:
  - README.md#Known issues
  - docs/BUILD-PLAN.md@O8
  - docs/K9-UPDATE-BRIEF.md#The design is already settled
  - packages/core/src/transitions.ts@export function updateCard
created: 2026-09-07T06:32:57Z
updated: 2026-09-07T21:37:37Z
---
The CLI has `add, move, list, show` only. MCP has `update_card` and HTTP has `PATCH /api/cards/:id`, so the gap is the CLI alone — and the CLI is the surface `docs/AGENTS.md` tells agents to reach for first (plan §11 O3).

Cost so far: HANDOFF §7.9 asked for this on 2026-09-03 and it never got a ticket. On 2026-09-06 all three agents on K8/K1(b)/K5 were briefed to run `card update --assignee`, all three hit `unknown card command "update"`, and all three fell back to hand-editing frontmatter — the escape hatch, for a field the board displays as an avatar.

Two shapes, and the choice is not obvious:
- `card update <id> [--assignee|--priority|--label|--file|--ref]` — general, mirrors MCP `update_card` and the HTTP PATCH that already exist, so core needs nothing new.
- `--assign` on `card move` — narrower, and fixes the exact §7.9 complaint (actor is who moved it, assignee is who owns it) in the one command agents already run.

**Decided 2026-09-07 by the owner (plan §11 O8): `card update <id>`.** It mirrors the `CardPatch` semantics that MCP `update_card` and HTTP `PATCH /api/cards/:id` already speak, so core needs nothing new and the CLI stops being the odd surface out — which is the actual complaint. `--assign` on `move` was rejected: it would have fixed only `assignee`, and it conflates a status change with setting a field. The one thing the CLI must add is a way to say `null`, which a shell flag cannot carry: `--clear <field>`. Brief: `docs/K9-UPDATE-BRIEF.md`.

Not started. Whichever ships must go through core's `updateCard` like every other mutation, and must not let a hand edit and a CLI write race into the K8 shape again.

## Log
- 2026-09-07T21:37:37Z web — updated assignee, priority, refs
