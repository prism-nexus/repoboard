# rcb — see your repo, watch the work move

*Working name. A local dashboard that shows a codebase as pictures a human can read at a glance,
and shows the work as cards on a board that move while agents work on them.*

**Status:** pre-alpha, nothing runs yet. Plan: `docs/BUILD-PLAN.md`.

## Thesis
Plain files are the database. Cards are markdown files in `.rcb/cards/`. Columns are a YAML file.
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
- **K5** `@rcb/core` exports TS source only. The server bundles core with tsup, so this only
  bites a third party importing `@rcb/core` on plain Node. Decide before publishing (P6).
