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
