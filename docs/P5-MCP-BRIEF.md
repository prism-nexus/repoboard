# Brief: P5 MCP server + AGENTS.md

You are implementing P5.1 and P5.2 of `docs/BUILD-PLAN.md`. Read `CLAUDE.md`, plan §1 D4, §2,
§5 P5, `packages/server/src/store.ts` and `cli.ts`. Do NOT commit. Edit only `packages/server`
and `docs/AGENTS.md`.

## P5.1 `rcb mcp`
Use `@modelcontextprotocol/sdk` (stdio transport). Subcommand `rcb mcp [--root <dir>]` opens
the same `openStore(root)` the CLI uses — one store, one code path. Tools:
- `list_cards({status?, assignee?, label?})` → compact JSON array of `{id, title, status,
  assignee, priority, labels, files, updated}`.
- `get_card({id})` → the full card including body.
- `create_card({title, status?, assignee?, priority?, labels?, files?, body?})` → the new card.
- `move_card({id, status, actor?})` → `{card, warnings}`; WIP breach is a warning in the
  result text, never a refusal.
- `update_card({id, title?, assignee?, priority?, labels?, files?, actor?})`.
- `append_log({id, text, actor?})` → appends `- <ts> <actor> — <text>` under `## Log`.
- `board_summary()` → per-column counts, active cards, WIP breaches (from core).
`actor` defaults to env `RCB_ACTOR`, then `mcp`. Every tool description must be written for an
agent that has never seen this board: say what a card is, that `status` must be a column id,
and that `list_cards` first is the cheap way to learn the column ids (include them in the
`board_summary` output too). Errors return `isError: true` with a one-line message naming the
bad field.
Tests: drive the server in-process through the SDK's `InMemoryTransport` pair against a temp
dir: create → list → move → get shows the log line and the events file has a row.

## P5.2 `docs/AGENTS.md`
One page, in this order: (1) what `.rcb/` is, in three sentences; (2) the card file format
from plan §2 with the K1 warning (**quote titles containing colons**); (3) the CLI commands
with one example each; (4) the MCP registration snippet for Claude Code (`claude mcp add rcb
-- npx rcb mcp`) and for a `.mcp.json`; (5) the `## Log` convention and the ask to write
actor names as `<tool>/<role>` (e.g. `claude/web-agent`) so avatars are stable; (6) a
paragraph to paste into a CLAUDE.md: "This repo has an `.rcb/` board. Before starting a task,
move its card to `doing` with your actor name; when done, move it to `review` and append what
you verified." Keep the tone plain; claims carry numbers or none.

## Definition of done
`pnpm test`, `pnpm typecheck`, `pnpm lint` exit 0 at root. `pnpm build` then run
`echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node packages/server/dist/cli.js mcp`
(after the initialize handshake — script it) and paste the tool names returned. Report: file
list, outputs, decisions.
