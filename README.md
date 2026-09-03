# repoboard — see your repo, watch the work move

*A local dashboard that shows a codebase as pictures a human can read at a glance,
and shows the work as cards on a board that move while agents work on them.*

**Status:** pre-alpha, nothing runs yet. Plan: `docs/BUILD-PLAN.md`.

## Thesis
Plain files are the database. Cards are markdown files in `.repoboard/cards/`. Columns are a YAML file.
Git is the history. Any agent that can edit a file can move a card; the board updates live.

## Known issues
(numbered `K1` upward; a commit that closes one says `Closes K<n>` and edits this list)
- **K1** A card whose `title:` contains a colon (`P3.1 Board view: columns`) is invalid YAML unless
  quoted, and an agent writing frontmatter by hand will do this. Found on 7 of the first 24 cards
  written by the orchestrator (2026-09-02). Options: (a) document "quote your titles" in
  `AGENTS.md`; (b) a lenient fallback in `parseCard` for the `title` line only; (c) the CLI/MCP
  always quote on serialize (they do, via `yaml`). Doing (a) and (c); (b) is open.
- ~~**K2** `Event.type` narrow in core; server carried its own superset.~~ Closed: core widened to
  `'move' | 'update' | 'create'` with `from: string | null`; server type deleted.
- ~~**K3** `lines` reported `0` for binary and >2 MB files.~~ Closed: `number | null` in core,
  scanner emits null (1 file in this repo), map shows "—".
- ~~**K4** `createCard` throws on an unknown status.~~ Closed: returns `{ok:false, error}` like
  `moveCard`; CLI and HTTP use the result.
- **K5** `@repoboard/core` exports TS source only. The server bundles core with tsup, so this only
  bites a third party importing `@repoboard/core` on plain Node. Owner decided 2026-09-03: leave it for
  v0.1 (core stays private, only `repoboard` publishes); **must be resolved before the GitHub
  repo goes public** (plan §11 O4). Gate on P6.3.
- ~~**K6** `repoboard card list --json` is 14.1 KB against 1.9 KB for the table (2026-09-03, 24 cards)
  because it includes every body.~~ Closed: `--json` is compact by default (id, title, status,
  assignee, priority, labels, files, updated; one row per line), `--full` adds bodies; MCP
  `list_cards` uses the same rows and formatter, with `full: true` for bodies. Measured on this
  repo's 27 cards, bytes: CLI `--json` 18,290 → 6,433; `--json --full` 16,240; table 2,149;
  MCP `list_cards` result 8,506 → 6,432 (`full: true` 16,239).
- **K7** A card that points at a doc section (`Task P6.2 in docs/BUILD-PLAN.md §5`) shows only
  the pointer; the reader has to leave the board to learn what the task is. Owner's note
  (2026-09-03): cards should populate from the lines they reference so the drawer shows what the
  card actually contains. Not in the plan. Two shapes: (a) convention — the orchestrator quotes
  the referenced lines into the body (done for RCB-22..26 as the interim); (b) feature — a
  `refs:` field (`path#heading` or `path:L10-L20`) that the drawer renders live from the file.
  (b) is post-v0.1 unless the owner says otherwise.
