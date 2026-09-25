# repoboard reference: wire shapes and history

Moved out of `docs/AGENTS.md` (RCB-73) to keep that page short: wire shapes, byte tables, and RCB-nn history for decisions, leases/windows, state/log/check, cost, and archive/issue sync. `docs/AGENTS.md` §8 points here one line per topic; read this page only when a card sends you to a specific §.

## 1. Decisions on cards (P8.1)

A card can carry one optional `decision:` block — the question, its options, and (once answered)
the owner's choice. **No separate file, no Decisions tab (O10):** the card *is* the decision, and
the board's `decide` column (`decision: true` in `board.yml`, O11) IS the owner's queue — a card
with an open decision moves there when asked and moves back to where it was when answered.
`decision.chosen !== null || decision.decidedAt !== null` means DECIDED; neither set means NEEDS
OWNER. **A DECIDED card is authority: read `decision.chosen`/`decision.words` yourself, do not
re-ask it and do not wait for a relay.**

```markdown
decision:
  question: "Ops cost: shrink the seat or retire it?"
  options:
    - letter: C1
      text: "waiter scripts into the repo, fuse counted as terminal"
    - letter: C2
      text: "K101 idle-OOM + K129(b) as builder items"
  askedBy: claude/coordinator
  askedAt: 2026-09-17T19:00:00Z
  returnTo: doing        # the column it was in when asked; decide moves it back here
  chosen: null           # a letter, once decided
  words: null            # the owner's text VERBATIM, optional
  decidedBy: null        # actor: web/owner, cli/<user>, mcp/<actor>
  decidedAt: null
```

`options` may be empty — a yes/no or free-text question, answered with `words` only.

### Owner tasks (RCB-52)

`decision:` gains an optional `kind: task` — an owner WORK item in the SAME queue, not a new
record type (plan §11 O10, CLAUDE.md "one function per guarantee": `needsDecision` stays the only
gate into the OWNER QUEUE). `kind` is absent for a question and never written as `kind: question`
— a question card's bytes are unchanged. A task has no options (asking one with `--option` is
refused: `a task has no options`) and `decide` closes it with **neither a letter nor words** — a
plain "done"; words are optional and kept verbatim. The OWNER QUEUE line reads
`RCB-9 · owner: buy the domain` instead of the question form, and `card list`'s `DECISION` column
shows `!` for a task instead of `?`.

### CLI

| Command | Example |
|---|---|
| `repoboard card ask <id> "<question>" [--option "A1 <text>"]... [--as a] [--replace]` | `repoboard card ask RCB-36 "sync-issues: which column?" --option "A todo" --option "B backlog"` → `asked RCB-36: sync-issues: which column? (2 options)` |
| `repoboard card ask <id> "<task text>" --task [--as a]` | `repoboard card ask RCB-9 "buy the domain" --task --as coord` → `owner task RCB-9: buy the domain` |
| `repoboard card decide <id> [<letter>] [--words "<verbatim>"] [--as a]` | `repoboard card decide RCB-36 A` → `decided RCB-36 A`; or `repoboard card decide RCB-36 --words "do it"` → `decided RCB-36 — "do it"`; on a task, `repoboard card decide RCB-9` → `done RCB-9` (or `done RCB-9 — "<words>"`) |
| `repoboard card list --needs-decision` | filters to cards with an OPEN decision; the table gains a `DECISION` column (a `?` marker, `!` for a task) only when at least one listed card has one — see the bytes below |
| `repoboard card show <id> --resolve` | each `refs:` entry as a fenced block headed `path:start-end`; RCB-106: overlapping or touching spans of the SAME file print once as one block headed `path:start-end — satisfies: <spec>, <spec>` (`mergeResolvedRefs`, server `refs.ts`); a single-spec block and an unresolved line are byte-identical to before |
| `repoboard card list --parent <id> [--unblocked]` | `--parent` lists that card's steps in phase order (ID PHASE STATUS ASSIGNEE GATE BLOCKED TITLE); `--unblocked` keeps the not-done, not-blocked ones (RCB-104) |
| `repoboard card list --size S\|M\|L\|XL` | filters to cards of that size |
| `repoboard card show <id> --steps` | `--steps` appends a `## Steps` table of its children (RCB-104) |
| `repoboard card show <id> --json [--resolve] [--steps]` | the same card object `card list --json --full` emits for one row (RCB-144); `steps`/`refs` added only with `--steps`/`--resolve`; an archived id: `{"archived": "<path>"}`; unknown id: unchanged error |

RCB-107: `ask` and `decide` also write the body's `## Decision` section (created before `## Notes`, else before `## Log`, else at the end — `appendDecisionLine`): `- <ts> <actor> — asked: <question>` with each option as a nested `- <letter>: <text>` line, then `- <ts> <actor> — decided <letter>: <text>` (or `— "<words>"`, `done` for a task); a `--replace` adds `question withdrawn` first. The frontmatter `decision:` block is REPLACED by a re-ask; the body section keeps every question, its options and its answer.

Asking again on a card whose decision is OPEN is refused, naming the open question — pass
`--replace` to withdraw it and ask a new one. Asking again on a DECIDED card just replaces the
block (its `decided …` line is already in the `## Log`). `decide` refuses an unknown letter,
naming the valid ones, and refuses when nothing is open. On a board with a `decision: true`
column, `ask` moves the card there (recording `returnTo`) and `decide` moves it back — on a board
without one, both only touch the badge.

RCB-69 (FPJ-28): `moveCard` — the one funnel every surface uses — refuses a DECIDED card moving
back into a `decision: true` column (naming the letter, or `—` for a words-only/task answer, and
pointing at `card ask` to open a new question) rather than letting it sit there looking undecided;
a never-asked card moving into one is allowed but warns. RCB-69 (FPJ-33): `decide` always moves a
card OUT of a `decision: true` column — a card asked WHILE ALREADY in that column (or a pre-fix
card with no real `returnTo`) lands in the board's default landing column (`todo` on the default
board) instead of staying, once `decide` answers it.

### MCP

`ask_owner(id, question, options?, replace?, kind?)` and `record_decision(id, letter?, words?)`,
plus `list_cards(needsDecision: true)` for the owner queue. `get_card` returns `decision` for free
— nothing extra to ask for. `kind: "task"` on `ask_owner` files an owner WORK item (no options; a
bare `record_decision(id)` closes it, no letter or words needed). RCB-146: `list_cards` gained
`size`/`parent`/`unblocked`, the same filters as `card list`, so an agent no longer has to pull
`full: true` to filter — all through one shared `filterCards` (`card-query.ts`).

### HTTP

`POST /api/cards/:id/ask` `{question, options?, replace?, kind?}`, `POST /api/cards/:id/decide`
`{letter?, words?}` — 200 with the card, 400 naming the bad field (`kind` must be `"task"` if
present), 409 when the request conflicts with the decision's own state (nothing open to decide;
one already open to ask again without `replace`). **`PATCH /api/cards/:id` refuses a `decision`
field** with 400 ("use /ask and /decide") — the only two writers of `decision` are `ask`/`decide`,
so nothing can bypass the log line that makes a decision auditable. `GET /api/state`'s
`ownerQueue` items carry `kind: "task"` only for a task, so the web can render it without
re-deriving.

### Bytes (O3), measured on a 10-card fixture (6 plain, 4 with an open 3-option decision)

| Surface | Before P8.1 | After, 4/10 cards with a decision |
|---|---|---|
| `card list` (table) | unaffected — no `DECISION` column appears when no listed card has an open decision (measured: 6-plain-card table byte-identical to pre-P8.1 shape) | 533 B (10 rows, `DECISION` column added) |
| `card list --needs-decision` (table) | n/a (flag did not exist) | 245 B (4 rows) |
| `card list --json` | — | 1,447 B (10 rows) |
| one card file, plain | 110 B | — |
| one card file, with an open 3-option decision | — | 536 B (+426 B: the `decision:` block, its two extra `## Log` lines) |
| MCP tool schema | 8.6 KB for 7 tools (2026-09-07) | **14,546 B for 9 tools** (+5,946 B: `ask_owner` 2,191 B, `record_decision` 1,514 B, plus `needsDecision` growing `list_cards`' own description) |

So a decision costs roughly 400 B per card on disk and adds two tools' worth of schema to the MCP
standing cost; the CLI and file-edit paths carry no new standing cost at all, which is the same
ranking O3 already found and this does not change it.

## 2. Leases and windows (P8.2)

`.repoboard/leases.yml` is a second plain file, a sibling of `board.yml`: who holds a named
resource right now (a lock, a dev server, a lane) and the time windows during which one is
claimed for something. **Absent file = no leases, no windows** — nothing to initialise. Every
mutation goes through the same core→store→CLI/MCP/HTTP funnel as a card move; the server watches
the file and re-reads it on an external `sed`/hand edit, exactly like `board.yml`.

```yaml
leases:
  - resource: vitest-lock        # free string, the team's name for the thing
    holder: claude/ops           # same actor string as a card's assignee (D8)
    since: 2026-09-17T18:50:00Z
    until: 2026-09-17T19:30:00Z  # optional; absent = held until released
    note: cold4 gate             # optional
windows:
  - resource: vitest-lock
    start: 2026-09-17T18:50:00Z
    end: 2026-09-17T19:30:00Z
    name: cold4 gate
```

A lease with `until` in the past is **STALE** — reported as such (`lease list`'s `STATE` column,
`list_leases`' `state`), never silently held and never silently dropped; a human (or `--force`)
decides whether to take it anyway. `until === now` is still LIVE — only strictly-past `until` is
stale. A window whose `end` is past is pruned on the next **write** of the file, never on a read:
`lease list`/`window list`/`GET /api/leases` can still show an expired window until some other
mutation writes the file next.

### CLI

| Command | Example |
|---|---|
| `repoboard lease take <resource> [--as h] [--until ts] [--note n] [--force]` | `repoboard lease take vitest-lock --until +90m --note "cold4 gate"` → `took vitest-lock as claude/ops until 2026-09-17T20:20:00Z` |
| `repoboard lease release <resource> [--as h] [--force]` | `repoboard lease release vitest-lock` → `released vitest-lock` |
| `repoboard lease list [--json]` | table: `RESOURCE HOLDER SINCE UNTIL STATE NOTE` |
| `repoboard window add <resource> <start> <end> <name> [--as a]` | `repoboard window add vitest-lock +5m +45m cold4 gate` |
| `repoboard window list [--json]` | table: `RESOURCE START END NAME` |
| `repoboard window check <resource> [--at ts]` | `repoboard window check vitest-lock` → exit 0 `clear vitest-lock`, or exit 1 naming what blocks it |

`--until` and window `<start>`/`<end>` accept **ISO-8601 or `+90m` / `+2h`, relative to now**
(`resolveTimeSpec` in `@repoboard/core`). A live lease held by ANOTHER holder refuses `take`
(names the holder and `until`) unless `--force`; the same holder renews — `since` is kept, `until`
and `note` are replaced by whatever the call gives (omit to clear). `release` by a non-holder
refuses the same way, naming the holder; releasing a resource with no lease at all is also
refused — there is nothing to release.

**`window check` is the shell-callable contract a lock shim calls before starting a long job**:
exit 0 and print `clear <resource>` when nothing blocks it (no window contains `now`/`--at`, no
live lease on the resource); exit 1 and print every reason that does, one per line — `inside
<name> <start>–<end> <resource>` for a window (start inclusive, end exclusive), `held by <holder>
until <until|—>` for a live lease. Exit 2 is a crash, as everywhere. **A `clear` result must never
be printed while blocked** — that silent failure is what C1 exists to catch (a check that always
says clear is silence that reads as health, same species as a `pgrep` guard that never matches).

### MCP

`take_lease(resource, until?, note?, force?, actor?)`, `release_lease(resource, force?, actor?)`,
`list_leases()` → `{leases: [{resource, holder, since, until, state: live|stale, note}], windows:
[{resource, start, end, name}]}` (same row shape and same formatter as the CLI's `--json`),
`add_window(resource, start, end, name, actor?)`, `check_window(resource, at?)` → `{clear: true}`
or `{clear: false, reasons: [...]}`. **`check_window`'s description carries the sentence an agent
needs verbatim: "Call check_window before starting any long-running shared-resource job such as a
test suite; exit/clear false means DO NOT start."** All five tool descriptions are terse (no
`CARD_INTRO` reuse — leases are not cards) and each measures under 700 B; see the bytes table.

### HTTP

`GET /api/leases` → `{leases, windows, stale: [<resource>, ...], now}` (the whole doc, plus which
resources are currently stale and the server's own clock, so a client renders staleness without
trusting its own). `POST /api/leases/take` `{resource, until?, note?, force?, actor?}`,
`POST /api/leases/release` `{resource, force?, actor?}`, `POST /api/leases/windows` `{resource,
start, end, name, actor?}` — 200 with the refreshed `GET /api/leases` payload, 400 for a bad
request (empty resource, unknown field, `end` not after `start`), 409 for a request that conflicts
with who currently holds the resource ("is held by …") or for the map-only refusal (K10).
`GET /api/leases/check/:resource?at=` is a pure read and always 200 (`{clear:false}` is not an
error — it is the answer). The WS `snapshot` message carries `leases` alongside `board`/`repo`; a
`{type:"leases", leases}` message follows any take/release/add-window, from any surface.

### Bytes (O3), measured on a fixture of 3 leases (2 live, 1 stale) + 4 windows

| Surface | Bytes |
|---|---|
| `lease list` (table) | 350 B |
| `lease list --json` | 411 B |
| `window list` (table) | 340 B |
| `window list --json` | 435 B |
| `leases.yml` on disk | 781 B |
| `GET /api/leases` | 826 B |
| MCP `list_leases` result | 1,214 B |
| MCP tool schema, 9 tools (P8.1 baseline, 2026-09-17) | 14,546 B |
| MCP tool schema, **14 tools** (P8.2, 2026-09-17 — measured via `client.listTools()`, sum of each tool's own `JSON.stringify`; the current count and bytes are in section 3) | **17,411 B** (+2,865 B for the five P8.2 tools) |

Per-tool bytes of the five new tools: `take_lease` 691 B, `release_lease` 509 B, `list_leases`
400 B, `add_window` 630 B, `check_window` 645 B — every one at or under the 700 B budget a terse
tool aims for (contrast P8.1's `ask_owner`/`record_decision` at 2,191 B / 1,514 B, which reused the
long `CARD_INTRO` prefix; these five do not, because a lease is not a card).

## 3. State, log, check (P8.3)

Three more plain files, sitting beside `board.yml` and `leases.yml`: `.repoboard/STATE.md` (one
page, rewritten in place, never appended), `.repoboard/log/YYYY-MM-DD.md` (one file per day,
append-only, every seat's own block), and `repoboard check`, which reads all of the above plus the
board and leases and reports what needs attention. `repoboard init --practices` scaffolds all
three (plus a root `NEXT-AGENT-PROMPT.md`) the first time a repo adopts this — see §1's table for
the full command list.

```markdown
# STATE

**Written 2026-09-17T21:00:00Z by claude/ops.**

## LIVE

Tree: dev = origin/main = e000c5d.

## LAST LANDINGS

0. K117 landed, hot, no migration.

## OWNER QUEUE

_(not stored in this file — generated from open decisions: run `repoboard state`)_

## SEATS

ops: watching the run.
```

**OWNER QUEUE is GENERATED, never typed or stored.** The file on disk always keeps the one-line
placeholder shown above; every read (`repoboard state`, `GET /api/state`, MCP `get_state`)
substitutes the current list of cards with an open decision (P8.1's `needsDecision`), one line per
card: `RCB-40 · <question> · [A B]`. A card's decision changing therefore never requires rewriting
STATE.md — only `LIVE`, `LAST LANDINGS` and `SEATS` are ever written, by
`repoboard state --set-section <SECTION> (<text> | --stdin)`, which restamps line 3 and leaves
every other section byte-identical.

**Never hand-type `OWNER QUEUE = <ids>` into a SEATS bullet's `in-flight:`/`owes:` text** — it is
generated (above), so a hand-typed copy is a snapshot that goes stale the moment any of those ids
gets decided. `repoboard check` catches it as `seat-owner-queue-drift` (RCB-130) once the hand-typed
set no longer matches the generated one; the fix is to drop the hand line, not to update it.

### CLI

| Command | Example |
|---|---|
| `repoboard state` | prints the rendered page (OWNER QUEUE generated fresh) |
| `repoboard state --json` | (RCB-144) read path only — refused with `--set-section`/`--trim-landings`; prints `{stamp, actor, sections, ownerQueue}` from `store.state()`, `ownerQueue` generated fresh from cards that need a decision (same computation as MCP's `get_state`); no `STATE.md`: `null`, exit 0 |
| `repoboard state --set-section LIVE\|LAST-LANDINGS\|SEATS (<text> \| --stdin) [--as a]` | `repoboard state --set-section LIVE "Tree is dev." --as claude/ops` → `updated STATE.md LIVE` |
| `repoboard state --trim-landings <n> [--archive <path>] [--as a]` | `repoboard state --trim-landings 3 --as claude/ops` — keeps the newest `<n>` LAST LANDINGS entries, archiving the rest verbatim to today's log (`.repoboard/log/<date>.md`, a normal seat-attributed block); with `--archive <path>` (RCB-132), archives to `<path>` INSTEAD (relative to root; created with a `# LAST LANDINGS archive` header if absent; never overwritten; no log block is written at all) — either way the SEATS-adjacent pointer left in LAST LANDINGS names wherever the entries went; `--archive` without `--trim-landings` is a user error; "nothing to trim: `<n>` entries ≤ `<n>`" and no write when there is nothing beyond `<n>` |
| `repoboard log --as <seat> [--title "…"] (<text> \| --stdin)` | `repoboard log --as claude/ops --title "armed the fires" "Five waiters set."` → `logged 2026-09-17 claude/ops` — creates today's file if this is the first entry. RCB-127 (owner decision 2026-09-25): also restamps STATE.md's own line-3 stamp — the SAME restamp `seat --update` performs (`setStateSectionCore` on `seats`, the UNCHANGED body, actor = `<seat>`) — iff `<seat>` has an UP bullet in SEATS right now (`findSeatLine`'s own match rule); the line then reads `logged 2026-09-17 claude/ops · STATE restamped (claude/ops is UP)`. A DOWN seat, an unknown seat, or a hand-typed block still leave `check`'s stale-state finding to fire until that seat runs `seat --update` |
| `repoboard log show [--date YYYY-MM-DD] [--seat s] [--since ts] [--tail n]` | prints a day's log (default today); `--seat` filters to that seat's own blocks; `--since ts` (RCB-132) keeps blocks whose `ts` >= `ts` — a full ISO-8601 datetime, or `HH:MMZ` for that UTC time on `--date`'s day; `--tail n` keeps the last `n` blocks of what's left, `n` greater than the count printing everything (never an error); the three compose in that fixed order — seat, then since, then tail. With any of the three, text output is the formatted blocks (as `--seat` alone prints them), never the day's raw file text |
| `repoboard log show --json [--date YYYY-MM-DD] [--seat s] [--since ts] [--tail n]` | (RCB-144, RCB-132) prints `{date, blocks: [{seat, ts, title, text}]}` from the parsed blocks the text path already has, filtered the same way; no log for that date (or nothing matches): `{date, blocks: []}`, exit 0 |
| `repoboard log --last <seat>` | `repoboard log --last claude/builder` — prints that seat's newest block, searching back across every day in `.repoboard/log/` AND, when configured, `board.yml`'s `logDir` (RCB-54 — the same merged set `check` reads; `repoboard log` itself still only ever writes `.repoboard/log/`), not just today; the seat match is by LEADING WORD, case-insensitive, when `<seat>` is one word (RCB-62) — `builder` finds a hand-written heading like `BUILDER (fresh, f87be1)`, but `coordinator` does NOT match `COORDINATOR/SEARCH` (no whitespace, so that whole token is its own leading word); a multi-word `<seat>` still compares whole-to-whole; a cold seat with no history prints `(no log block for <seat>)`, exit 0 |
| `repoboard seat <name> [--json]` | `repoboard seat claude/builder` — the RCB-48 cold-start bundle in one command: an `## In flight / owes` section first (`in-flight:`/`owes:` parsed off the seat's own SEATS bullet, RCB-89), the SEATS bullet mentioning `<name>` (whole word), its own last log block (same RCB-62 leading-word match as `log --last`), the coordinator's (omitted when `<name>` IS the coordinator), its Next card (RCB-103: first, the next unblocked step — `blockedReason(...) === null`, no assignee or assigned to it — of the first non-done card of its own that HAS steps (`parent`/`phase`/`gate`, RCB-68), in list order; only then, as before, assigned to it, else the highest-priority unassigned todo card — high > medium > low > unset, list order among equals — the render says which), and the cards with an open decision. Fixed `## ` headings; a missing part prints a one-line placeholder, never an empty section (a missing `in-flight:`/`owes:` line prints `(none recorded)`, empty-but-present prints as empty). Exit 0 on any successful read, even an entirely cold seat. `--json` prints the bundle object. Prints `warning: dist is older than src — run pnpm build (<pkgs>)` on stderr when run from a source checkout whose `packages/*/src` is newer than its `dist` (RCB-60); silent from an npm install |
| `repoboard seat list [--json]` | RCB-89: one row per SEATS bullet whose first line is a seat bullet (a non-seat bullet, e.g. `- Owner tasks elsewhere: …`, is skipped, never an error) — `NAME  STATUS  STAMP  IN-FLIGHT`, columns padded to the widest value, `in-flight` printed as `-` when unrecorded; no bullets at all prints `(no seat bullets in SEATS)`. Exit 0 even with no STATE.md. `--json` prints `SeatRow[]` (`name`, `status`, `stamp`, `inFlight`). `--up`/`--down`/`--update` together with `list` is a usage error — this is the reserved word that stops `seat list` being parsed as a seat literally named "list" |
| `repoboard seat <name> --up "<text>" \| --down "<text>" \| --update "<text>"` | RCB-58: replaces ONLY that seat's own SEATS bullet — found the way `seat` finds its SEATS line: label first, then first line — with `- **<name>: UP\|DOWN <YYYY-MM-DD HH:MMZ>.** <text>`, restamping line 3 as `<name>` and touching no other byte; appended as the last bullet when the seat has none yet. `state --set-section SEATS` stays the whole-section rewrite. `--up` refuses a second UP inside `activeWindowMinutes` unless `--force` (RCB-87, audited in the log); `--down` is refused, before any write, unless `<text>` carries BOTH an `in-flight:` line and an `owes:` line (case-insensitive key, value trimmed — RCB-89, so a successor never has to guess a stand-down's live subagents/Monitors/worktree/lock holder or what it still owes); `--update` rewrites only the body, keeps the standing status + stamp, restamps line 3, refused when the seat has no bullet (RCB-88). Both `--down` and `--update` (RCB-130, one shared guard, `checkFieldCounts`) are ALSO refused when `<text>` carries MORE THAN ONE `in-flight:` or `owes:` line — a hand-edit that pastes a second copy of both fields (and their stale hand-typed `OWNER QUEUE = …`) into the same bullet is refused before the write, not left for `check` to find after the fact. `--update` still has no PRESENCE guard: a bullet with neither field yet may still be updated |
| `repoboard check [--json] [--strict]` | exit 0 `ok` with no findings, else exit 1 (or 0 if every finding is warning-grade and `--strict` is absent) with one line per finding |
| `repoboard init --practices` | scaffolds `STATE.md`, today's log, `leases.yml`, and a root `NEXT-AGENT-PROMPT.md` — **never overwrites an existing file**, printing `kept <path>` for each; works whether or not `.repoboard/` already existed |

A log block is `##### <SEAT-UPPERCASED> <ISO>: <title or first line>`, a blank line, then the text
verbatim — append-only, so a hand `sed` can add to it but core exposes no rewrite. `--as` on `log`
uses the same actor chain as everywhere else (`$REPOBOARD_ACTOR`, then `$USER`, then `cli`).

Rig facts — the vitest lock protocol, the port map, the restart rule, seat names and `--as`
values, subagent policy, the per-landing gate — live in one place, written once: `.repoboard/local/RIG.md` (the local layer, RCB-83)
(RCB-55 A4). SEATS bullets point at it rather than restating it.

### `repoboard check`'s findings

| Kind | Level | Fires when | Blocks by default? |
|---|---|---|---|
| `stale-state` | error | STATE's stamp is older than the newest log file's mtime OR the newest `#####` header time inside it, whichever is later | yes |
| `active-without-lease` | warning | a card in an `active: true` column whose `assignee` holds no live lease on any resource | only with `--strict` |
| `stale-lease` | error | any lease past `until` (one finding per lease) | yes |
| `needs-decision` | info | count of cards with an open decision; only emitted when > 0 | never |
| `needs-ask` | warning | a card in a `decision: true` column with no OPEN ask — never asked, or already decided and moved back | only with `--strict` |
| `cost-over-budget` | error | the root `CLAUDE.md` exceeds its budget (default 8192 B, or `board.yml`'s `claudeMdBudgetBytes`) — P8.4, §4 | yes |
| `future-stamp` | warning | a log block's `#####` header time is more than 60 s ahead of `now` — hand-typed or clock-skewed, and ignored for `stale-state` rather than letting it wedge every other seat's `check` — RCB-90 | only with `--strict` |
| `seat-owner-queue-drift` | warning | a SEATS bullet's text hand-types `OWNER QUEUE =`/`OWNER QUEUE:` followed by a list of card ids, and that set differs from the GENERATED queue (`needsDecision` cards) — RCB-130; one per bullet | only with `--strict` |

Findings are pure data (`{kind, level, message}`); `exitCodeForFindings(findings, strict)` is the
one function every surface (CLI, HTTP, MCP) calls to turn them into the 0/1 contract, so the
meaning of `--strict` cannot drift between surfaces.

### MCP

`get_state()` → `{stamp, actor, sections: {live, lastLandings, seats}, ownerQueue: [{id, question,
options}], text}` (nulls before any STATE.md exists), `set_state_section(section, body, actor?)`,
`append_repo_log(seat, text, title?)` → `{date, block, restamped}` (RCB-127: `restamped` is true
iff `seat` had an UP bullet in SEATS at the moment of the call — the same restamp `seat --update`
performs), `check(strict?)` → `{findings, exitCode}`. All four are terse (no `CARD_INTRO`,
matching P8.2's five lease tools) and each measures under 700 B.
`ownerQueue` (both here and in `repoboard state --json`) is computed by one shared function
(`card-query.ts`, RCB-146) — the CLI and MCP can no longer disagree about which cards are open.

RCB-146 rounds out the read side: `get_log({date?, seat?, since?, tail?, last?})` → `{date,
blocks}` (same as `log show --json`, `seat` upper-cased the way the CLI does; RCB-132 adds
`since`/`tail`, the SAME `filterLogBlocks` core function `log show --since/--tail` calls, composed
seat-then-since-then-tail), or, with `last` (exclusive with `date`/`seat`/`since`/`tail`), that
seat's newest block anywhere in the log: `{date, block}`, nulls when it has none. `get_seat({name})`
→ the SAME cold-start bundle `seat <name> --json` prints; read only — `--up`/`--down`/`--update`
stay CLI-only for now.

### HTTP

`GET /api/state` (same shape as MCP `get_state`), `PUT /api/state/section`
`{section, body, actor?}` — 200 with the refreshed state, 400 for a bad section/empty body, 409
map-only. `GET /api/log?date=` → `{date, text, blocks}` — merged with `board.yml`'s configured `logDir` for that date when set (RCB-62; the same source `check`/`seat` read), 404 only when neither file exists for that date. **Reversed 2026-09-21 (RCB-71, owner chose A):** `repoboard log` WRITES to `logDir` when it is set; reads unchanged.
`POST /api/log` `{seat, text, title?}` — 200 with `{date, text, block, restamped}`, 400/409 as above; `restamped` is true when `seat` had an UP bullet in SEATS, so STATE.md was restamped too (RCB-127, same function as `log --as`).
`GET /api/check?strict=1` is a pure read, always 200 (`{findings, exitCode}` — exitCode is data,
not a status code, the same reasoning as `GET /api/leases/check/:resource`). The WS `snapshot`
carries `state` and today's `log`; a `{type:"state", state}` message follows any rewrite (from any
surface), and `{type:"log", date, text}` follows any append or external edit of that day's file.

### Web

STATE renders as a collapsible panel (`data-testid="state-panel"`) at the top of the Board view;
the collapsed/expanded choice is remembered in `localStorage` as a per-viewer convenience (never
in the shared store). **The web does NOT trust the wire payload's own `ownerQueue` field for
display** — it recomputes the queue from the live `cards` it already has, via the same
`needsDecision`/`ownerQueueLine` core functions the server uses, so a card's decision changing
updates the panel the instant the `card` message arrives, with no dependency on a fresh `state`
broadcast. **O11 retired the `needs decision` TopBar filter**, so a queue line does not toggle
anything — it scrolls the board to the first `decision: true` column (orchestrator note 2). The
daily log renders as a timeline beside the Ticker (`data-testid="log-timeline"`), newest block
first, one `<details>` disclosure per block (seat avatar, title, expand for the full text).

### Bytes (O3)

`state`/`log` measured with the built CLI against a fixture whose `LIVE`/`LAST LANDINGS`/`SEATS`
content is sized like freshpickedjobs' real `docs/STATE.md` (2026-09-17); `check`/`get_state`
measured via the MCP client the same way as §1/§2's tables.

| Surface | Bytes |
|---|---|
| `repoboard state` (rendered page, no open decisions) | 1,186 B |
| `repoboard state` (same page, 4 cards / 2 with an open decision) | 1,212 B (+26 B: two `RB-n · <question> · [letters]` lines replacing the placeholder) |
| `repoboard log show` (3 blocks, one per seat) | 242 B |
| MCP `get_state` result | 515 B |
| MCP `check` result (clean fixture, empty findings) | 83 B |
| MCP tool schema, 14 tools (P8.2 baseline) | 17,411 B |
| MCP tool schema, **18 tools** (`client.listTools()`, sum of each tool's own `JSON.stringify`; the current count and bytes are in section 3) | **19,682 B** (+2,271 B for the four P8.3 tools) |

Per-tool bytes of the four new tools: `get_state` 432 B, `set_state_section` 645 B,
`append_repo_log` 628 B, `check` 566 B — every one under the 700 B budget, for the same reason
P8.2's five lease tools are: no `CARD_INTRO`/`ACTOR_DESC` reuse, because state/log/check are not
cards.

## 4. Cost — what a cold agent loads, against a budget (P8.4)

`repoboard cost` answers one question in bytes: **what does a cold agent load before it does
anything?** — `CLAUDE.md` at the repo root (and `.claude/CLAUDE.md`, `CLAUDE.local.md` if
present, each listed separately), `AGENTS.md` at root and `docs/AGENTS.md` if present, every
repo-relative path `CLAUDE.md` names in backticks that **exists as a file** (first-order only —
no recursion into a linked file's own text, no globs, deduplicated; `..` and absolute paths are
ignored), and the **names** (never bytes — that cost is per-harness) of any MCP servers in
`.mcp.json`. Tokens are an ESTIMATE at 4 bytes/token, always printed with `≈` and labelled as an
estimate. Motivating measurement (plan §5 P8.4): freshpickedjobs' own `CLAUDE.md` reached
32,620 B — loaded into every turn of every subagent, including ones that never needed 151 lines
of verification catalogue — before anyone measured it; it was cut to 4,996 B by hand on
2026-09-17, the same day this task landed.

Core (`packages/core/src/cost.ts`, pure — §0.5) does the extraction rule and the arithmetic;
`packages/server/src/cost.ts` does the one `stat`/`readFile` per candidate, through the same
`resolveRepoPath` guard K7's refs use (absolute, `..`, `.git/`, and a symlink escaping the repo
are all refused there too, even though `extractLinkedPaths` already rejects the first two on
syntax alone). **Read-only**, always: `cost` never writes, and the CLI's own `--root` measures
ANY directory, with or without a `.repoboard/` board — that is the freshpickedjobs case, which
has never adopted this tool.

### CLI

| Command | Example |
|---|---|
| `repoboard cost [--root <dir>] [--budget <bytes>] [--json]` | `repoboard cost --root /path/to/other/repo` |

With no `--root`, it climbs to the nearest `.repoboard/` like every other command; with `--root`,
it measures that directory exactly as given, board or no board. The budget: a `--budget` flag
wins; otherwise `board.yml`'s `claudeMdBudgetBytes:` (a new optional key —
`docs/BUILD-PLAN.md` §2); otherwise the built-in default, **8192 bytes**. Table columns: `FILE  BYTES  ≈TOK  WHY` (`WHY` is `root`,
`agents`, or `linked from CLAUDE.md`), then `total <bytes> ≈<tok>`, then
`CLAUDE.md <bytes> of budget <budget>  OK|OVER` (or `CLAUDE.md — absent` when there is none — an
absent CLAUDE.md can never be OVER), then the MCP servers line (only when at least one is
configured) and a footer labelling `≈tok` as an estimate. Exit 1 when CLAUDE.md is OVER, exit 0
otherwise — the same 0/1 shape `repoboard check`'s new `cost-over-budget` finding uses (error-
grade, blocks even without `--strict`, since a CLAUDE.md over budget is the failure nobody
notices without this).

### MCP / HTTP

MCP `cost(budget?)` → the same JSON `CostReport` the CLI's `--json` prints. HTTP
`GET /api/cost[?budget=]` — a pure read, always 200 (`over: true` is a well-formed answer, not a
failed request, the same reasoning as `GET /api/leases/check/:resource`); `?budget=` non-positive
is the one 400.

### Web

One tile on the Map view header: `cold context ≈Nk tok · CLAUDE.md X.X KB ✓` (✗ in the warning
color when OVER, or `CLAUDE.md absent`). Click opens a drawer-styled panel with the full table.
Fetched directly from `GET /api/cost` on mount (the same K7 `useRefs` pattern `Drawer.tsx` uses
for card refs) rather than riding the WS snapshot: this is a filesystem fact about the repo, not
board state, and nothing currently watches `CLAUDE.md`/`AGENTS.md`/`.mcp.json` for live updates.

### Measured (locked decision 6) — two repos, 2026-09-17

Both measured with the built CLI (`pnpm build` first). The freshpickedjobs run is **read-only**:
`git -C .../freshpickedjobs status --short` was identical (empty) before and after.

**repoboard itself** (`repoboard cost`, budget 8192 — the default; no `claudeMdBudgetBytes` set):

| File | Bytes | ≈tok | Why |
|---|---|---|---|
| `CLAUDE.md` | 5,563 | ≈1,391 | root |
| `docs/AGENTS.md` | 30,264 | ≈7,566 | agents |
| `docs/BUILD-PLAN.md` | 30,288 | ≈7,572 | linked from CLAUDE.md |
| `docs/HANDOFF.md` | 23,350 | ≈5,838 | linked from CLAUDE.md |
| `docs/NEXT-AGENT-PROMPT.md` | 4,182 | ≈1,046 | linked from CLAUDE.md |
| `README.md` | 18,228 | ≈4,557 | linked from CLAUDE.md |
| **total** | **111,875** | **≈27,969** | |

`CLAUDE.md 5,563 of budget 8,192` — **OK**.

**freshpickedjobs** (`repoboard cost --root ~/Projects/Repos/freshpickedjobs`, its
own default budget — it has no `board.yml`):

| File | Bytes | ≈tok | Why |
|---|---|---|---|
| `CLAUDE.md` | 4,996 | ≈1,249 | root |
| `docs/STATE.md` | 5,253 | ≈1,313 | linked from CLAUDE.md |
| `docs/OWNER-DECISIONS.md` | 4,661 | ≈1,165 | linked from CLAUDE.md |
| `README.md` | 165,906 | ≈41,477 | linked from CLAUDE.md |
| `docs/BUILD-PLAN.md` | 79,439 | ≈19,860 | linked from CLAUDE.md |
| `docs/HANDOFF.md` | 2,152,432 | ≈538,108 | linked from CLAUDE.md |
| `docs/ROUTER.md` | 16,133 | ≈4,033 | linked from CLAUDE.md |
| `docs/VERIFICATION-SPECIES.md` | 13,707 | ≈3,427 | linked from CLAUDE.md |
| `docs/SEARCH-SEAT-HANDOFF-2026-09-14.md` | 28,156 | ≈7,039 | linked from CLAUDE.md |
| `docs/DRAFT-REVIEW-NOTES-2026-09-11.md` | 22,996 | ≈5,749 | linked from CLAUDE.md |
| `docs/WORKDAY-UNPARK-RUNBOOK.md` | 10,429 | ≈2,607 | linked from CLAUDE.md |
| `docs/archive/CLAUDE-2026-09-17.md` | 32,620 | ≈8,155 | linked from CLAUDE.md |
| **total** | **2,536,728** | **≈634,182** | |

`CLAUDE.md 4,996 of budget 8,192` — **OK** — the very file this task's own motivating measurement
was about, now well under budget by design. **But the mechanical total is 2.5 MB, ≈634K tokens**,
almost entirely `docs/HANDOFF.md` alone (2,152,432 B — 85% of the total): CLAUDE.md's own text
names it as "the running record" to consult, not something eagerly loaded every turn, and this
tool's literal backtick rule cannot tell the difference between "loaded always" and "referenced
for later" — it counts every existing linked path the same way. **This is the measurement that
contradicts the plausible assumption**: cutting `CLAUDE.md` to 4,996 B fixed the ONE number this
tool gates on (locked decision 2 only budgets `CLAUDE.md` itself, on purpose), but did nothing to
the much larger number a naive reading of "cold context total" would suggest. Read `total` as
"every file this repo's CLAUDE.md points at, summed, whether or not an agent actually opens it
this turn" — not as "what gets loaded automatically."

### Bytes (O3) — the `cost` MCP tool

| Surface | Bytes |
|---|---|
| MCP `cost` tool schema | 621 B |
| MCP tool schema, 18 tools (P8.3 baseline) | 19,682 B |
| MCP tool schema, **19 tools** (`client.listTools()`, sum of each tool's own `JSON.stringify`; the current count and bytes are in section 3) | **20,303 B** (+621 B) |

621 B is under the 700 B aim, for the same reason P8.2/P8.3's tools are: no `CARD_INTRO`/
`ACTOR_DESC` reuse — a cost report is not a card.

## 5. Archive and issue sync (P8.5)

Two commands close the loop O5 opened: the board should be a **VIEW** of what already exists
elsewhere, never a second copy. `repoboard archive` retires `done` cards the way a closed README
`K`-entry retires itself (struck in place, eventually swept out); `repoboard sync-issues` is the
other direction — it turns a README's `## Known issues` list into cards **without copying the
entry's text**: `refs: [<path>@K<n>]` is the only pointer, and the source file is **never
written**.

### `repoboard archive`

Moves every card in a `done: true` column whose `updated` is strictly older than a cutoff (default
`14d`; also accepts `2h`/`90m` or an absolute ISO-8601 datetime) to `.repoboard/archive/`: `git mv`
when `.repoboard/` sits inside a git work tree **and** the file is tracked, a plain `fs.rename`
otherwise. **Byte-identical either way** — the card is never routed through `serializeCard`, so
the file that lands in `archive/` is the exact bytes that left `cards/`. One `type: 'archive'`
event per card (`from` the column it left, `to` the literal string `"archive"`). The store never
loads `.repoboard/archive/` — an archived card simply stops existing as far as `list()`/the board
are concerned; `card show <id>` on an archived id prints `archived: .repoboard/archive/<id>.md`
instead of the file.

| Surface | Example |
|---|---|
| CLI | `repoboard archive [--older-than 14d] [--dry-run] [--as actor]` |
| MCP | `archive_cards({olderThan?, dryRun?, actor?})` |
| HTTP | `POST /api/archive {olderThan?, dryRun?, actor?}` → `{dryRun, ids}` or `{dryRun, archived}` |
| Web | The Board's `done` column header: an **"archive older than 14d"** button, reporting the
count as a toast. Nothing else — no confirmation dialog, no options; the default cutoff is the
one everyone gets. |

`--dry-run` (`dryRun: true`) runs `selectArchivable` and prints/returns the ids **without calling
the writer at all** — not a real run that happens to skip the last step, a code path that never
reaches `archiveMoveFile`.

### `repoboard sync-issues`

```
repoboard sync-issues <path>#<heading> [--status todo] [--label issue] [--dry-run] [--as actor]
                       [--root <dir>]
```

Reads `path` (repo-relative; `..` and absolute paths refused — the same `resolveRepoPath` guard
K7's `refs:` use) and finds the section under the first heading whose text starts with `heading`
— **the identical function** `refs.ts`'s `path#Heading` ref case uses internally
(`findHeadingSection`, refactored out of `resolveRef` for this task so the two can never disagree
about where a section starts or ends — species 6's own lesson, applied structurally rather than
by convention). Unlike a rendered `refs:` preview, this read has **no line/byte cap**: a K-list
can run to thousands of lines, and every one of them has to be seen.

**An item** is a list item whose FIRST LINE begins at column 0 with `- **K<n>` (open) or
`- ~~**K<n>` (struck = closed). Nothing else is an item: a `- **K` line indented even one space is
prose; a `Closes K<n>` sentence inside an entry's continuation lines is not a separate item; and
`- ~~- **K` (a strike wrapped around a SECOND list marker — the E1 near-miss) is reported as
`skipped: malformed strike: <line>`, never treated as an item. Title = `K<n> ` + the first line's
text after `**K<n>` up to the first `**` or `—`, with a leading run of `.`/whitespace stripped
(`- **K1. Full sweep…` reads as `K1 Full sweep…`), trimmed, truncated at 100 characters.

For every **open** item with no card whose `refs` contains `<path>@K<n>`: create one — `status`
per `--status` (default `todo`), `labels: [label]` (default `issue`), `refs: [<path>@K<n>]`, body
`Filed from <path> §<heading>. The entry is the text; this card is the pointer.` For every
**struck or vanished** item (gone from the section entirely) whose card exists and is not already
in the done column: move it there with a log line naming the CAUSE — `synced: entry closed in
<path>` — instead of the generic `moved <from> → <to>` a plain move would write. **Idempotent by
ref**: a second run against the same state creates and moves nothing, because the check is always
"does a card with this exact ref exist right now", never a saved list from a prior run.
**NEVER writes `path`** — proven by a byte-hash comparison before/after in the test suite, and
guarded structurally: `packages/server/src/issues.ts` calls `readRepoText` on the source and
nothing else touches it.

| Surface | Example |
|---|---|
| CLI | `repoboard sync-issues README.md#Known issues --dry-run --root <dir>` |
| MCP | `sync_issues({path, heading, status?, label?, dryRun?, actor?})` |
| HTTP | `POST /api/sync-issues {path, heading, status?, label?, dryRun?, actor?}` → `{dryRun, create, close, malformed, unchanged}` or `{dryRun, created, closed, malformed, errors}` |

`--root` (CLI) works exactly like `repoboard cost --root`: it measures/acts on ANY directory, with
or without a `.repoboard/` board, and does not climb from `cwd` — this is what makes it safe to
point at a repo this one does not own. `--dry-run` is the only mode to run against a repo you do
not maintain: it computes the plan and reports it without a single write call, even in a
non-map-only board (nothing about the write path is reachable from the dry-run branch).

### Measured on freshpickedjobs (read-only — `git status --short` and `.repoboard/` presence both
unchanged before and after every call)

`sync-issues README.md#Known issues --dry-run --root ~/Projects/Repos/freshpickedjobs`,
measured three times as the target repo moved under this task:

| freshpickedjobs HEAD | create | close | malformed | Why it changed |
|---|---|---|---|---|
| `b633c84` (brief's own number) | 68 | — | — | the brief's stated expectation, superseded before the builder ran |
| `b633c84` (orchestrator's re-measurement, same sha) | 69 | 0 | 0 | K130/K131/K132 were filed after the brief; K130 was struck in place, still counted (open-SHAPED, per the literal rule) |
| `44acaf1` | 64 | 0 | 0 | K67/K68/K69/K70/K81 (closed-in-text but open-in-shape) and the struck K130 were all moved out to `docs/CLOSED-ISSUES.md` |
| `0427693` (final measurement, this task's own build) | 64 | 0 | 0 | unchanged from `44acaf1` — confirms the count is stable, not a fluke of one commit |

Every one of those runs left `git -C freshpickedjobs status --short` byte-identical before and
after (empty both times) and `.repoboard/` absent both times — printed in full in this task's own
§7 log. The CLI's own dry-run output for the final run is 323 bytes:

```
would create 64, close 0, malformed 0, unchanged 0
create: K1 K7 K8 K9 K11 K12 K13 K14 K17 K18 K19 K21 K64 K66 K71 K72 K73 K74 K76 K80 K85 K87 K91 K94 K95 K97 K100 K101 K103 K75 K105 K108 K112 K126 K127 K128 K129 K131 K132 K22 K23 K24 K25 K26 K28 K29 K30 K31 K32 K33 K34 K35 K36 K38 K43 K45 K59 K47 K50 K51 K52 K53 K58 K61
```

### Bytes (O3)

| Surface | Bytes |
|---|---|
| MCP `archive_cards` tool schema | 913 B |
| MCP `sync_issues` tool schema | 2,145 B (reuses `CARD_INTRO` — a filed card IS a card, unlike a lease/cost tool) |
| MCP tool schema, 19 tools (P8.4 baseline) | 20,303 B |
| MCP tool schema, **21 tools** (`client.listTools()`, sum of each tool's own `JSON.stringify`; the current count and bytes are in section 3) | **23,380 B** (+3,077 B) |
| CLI `sync-issues --dry-run` against freshpickedjobs (64/0/0) | 323 B |

`sync_issues` is over the terse 700 B lease/cost budget on purpose: it is a card-creating tool
(like `create_card`/`ask_owner`), and those already carry `CARD_INTRO` — the alternative is an
agent that creates a card here not knowing `decision`/`refs`/the log convention apply to it too.

## 6. Server internals

**`serve`'s repo watcher (K12).** The chokidar watcher over `--root` shares the scanner's own idea
of "the repo": on a git root, `git ls-files -z --others --ignored --exclude-standard --directory`
(`packages/server/src/watch-ignore.ts`) builds the ignore set once at start, so a gitignored tree —
build output, a data dump, a pile of worktrees — is neither walked nor watched, matching what
`git ls-files --cached --others --exclude-standard` already excludes from the scan. It also carries
a hard cap (`--watch-cap`, default 20,000 watched paths, checked once the watcher reports ready): if
what it would watch still exceeds the cap, or the watcher itself hits `EMFILE`/`ENFILE`, it closes
itself and logs one `warning: repo watcher off: … (rescans now only on request)` line — the map
keeps serving from the last scan, and a rescan only happens on request, rather than the server
degrading silently under load. Measured on freshpickedjobs (K12, README): before the fix, the
watcher walked 6.36M gitignored files and hit EMFILE at 27 s with RSS climbing past 1.6 GB and
`/api/board` never answering; after, `/api/board` answered in 4 ms with RSS flat at ~169 MB.

**Repo-scoped routes (RCB-43 slice 2).** With more than one `--root`, every route documented in
this file also exists under `/api/repos/<key>/…` — `/api/repos/<key>/board`,
`/api/repos/<key>/cards`, `/api/repos/<key>/repo`, and so on, one for one with the unprefixed
`/api/…` route, which keeps meaning the primary (so the existing web keeps working without
change). The server strips the `/api/repos/<key>` prefix once and hands the rest to that root's
own handler unchanged. `GET /api/repos/<key>` alone (no further path) answers with that one
root's `GET /api/repos` list entry, without opening it; `GET /api/repos/<key>/repo` is the one
route that opens and scans a lazily-opened root on first request (K12 "map on demand"). The WS is
per root too: `/ws` is always the primary, `/api/repos/<key>/ws` is that root's own socket — a
`card:move` sent on one never touches another root's files or clients. An unknown key is a 404
naming every known key. `repos` is a reserved key (a root whose folder is literally `repos`
becomes `repos-2`, as if it had already collided) so it can never be confused with the list route.

**The web (RCB-43 slice 3).** The top bar shows a repo `<select>` (fed by `GET /api/repos`, shown
only when 2+ roots are served) whose choice is a real page navigation to `?repo=<key>` (or the
plain URL for the primary) — every scoped fetch and the WS go through the one base-path rule in
`packages/web/src/repo-key.ts`.

### Command details

- `repoboard init [--practices]`: `repoboard init` — creates `.repoboard/` with the default board and card `RB-1 Welcome`; `--practices` also scaffolds `STATE.md`, today's log, `leases.yml` and a root `NEXT-AGENT-PROMPT.md` (docs/REFERENCE.md §3)
- `repoboard local init [--remote <url>|none] [--move-record]`: creates `.repoboard/local/` (RIG.md, gitignored, its own git repo — §1 of this file); the running record (`STATE.md`, `log/`) follows the rule **the record lives where it already is** — an untracked top-level record moves in unconditionally, a record tracked in the root repo's git index is left in place (printing `kept .repoboard/<name> (tracked in git; pass --move-record to move it into .repoboard/local/)`) unless `--move-record`, which moves it AND stages its removal (`git rm --cached`) in the root repo for the owner to commit; the store (`store.ts` `load()`/`resolveLogDir()`) reads/writes the top-level path whenever it exists, so the bare DIRECTORY `.repoboard/local/` never by itself flips which STATE.md/log the store reads (RCB-93). RCB-128: `--remote none` is the opt-out ack for a local layer with no backup on purpose — it writes `.repoboard/local/local.yml` (`remote: none`), sets no `origin`, and silences `check`'s `local-no-remote`; `--remote <url>` afterwards sets the remote and removes the ack (a real remote supersedes it). With neither `--remote` nor a remote already configured, prints `local: no remote — back up with --remote <url>, or --remote none to stop check asking`. `repoboard local status` shows `no remote (ack: none)` when acked.
- `repoboard card note <id> "<text>" [--as actor]`: `repoboard card note RB-12 "owner: ship it after the restart" --as owner` → `noted RB-12` — appends a dated, attributed remark under `## Notes`, created before `## Log` if missing (RCB-70, section 6)
- `repoboard columns set (--stdin | "<text>") [--as actor]`: `repoboard columns set --stdin < new-columns.yml` — replaces the WHOLE column list (YAML or JSON, a bare list or `{columns: [...]}`), exactly `PATCH /api/board`'s contract (RCB-34); a schema error (empty list, duplicate id) leaves `board.yml` untouched
- `repoboard seat <name> [--json]`: `repoboard seat claude/builder` — the cold-start bundle: SEATS line, own last block, the coordinator's, next todo card, open decisions (docs/REFERENCE.md §3)
- `repoboard cost [--root <dir>] [--budget <bytes>] [--json]`: `repoboard cost --root /path/to/other/repo` — "cold context" bytes/≈tokens, exit 1 if CLAUDE.md is OVER budget (docs/REFERENCE.md §4)
- `repoboard serve [--root <dir>]... [--port 4242] [--open] [--no-fun] [--watch-cap 20000] [--sibling <name>=<url>]...`: `repoboard serve --open` — the dashboard on 127.0.0.1; `--root` repeats (RCB-43): the first is primary and opens immediately, later ones open lazily on first request, and `GET /api/repos` lists all of them

`card list --json` row shape detail: (RCB-68: `parent`/`phase`/`gate` mirror the frontmatter,
`blocked` is the computed reason or `null`; RCB-105: a card that itself sits in a `done: true` column is never blocked — `gateState` reads its gate as history, `clear` with `by: "<gate> — card done"`, a gate naming an already-clear card keeping `"<id> (<status>)"` — so a finished step never drags its parent's rollup, lane head or chip); RCB-67: `size` is one of `S | M | L | XL` — S ≤2h ·
M half a day · L days, investigate first · XL plan-sized — or `null`, shown as a chip on the card
and sortable/filterable on the web board. On this repo's 31 cards, measured 2026-09-07: 2,529 B
(table), 7,639 B (`--json`), 20,758 B (`--json --full`).

## 7. Systems detect (RCB-96)

`repoboard systems detect [--root <dir>] [--apply] [--json]` proposes `.repoboard/systems.yml`
candidates from a FIXED file list — it never walks the tree: `package.json` at root, each
workspace dir's `package.json` (globs from `pnpm-workspace.yaml` or `package.json` `workspaces`,
`dir/*`/`dir/**` expanded to direct subdirectories); in root and every workspace dir,
`wrangler.{toml,jsonc,json}`, `Dockerfile`, `.env.example`, `.dev.vars`,
`vite/drizzle.config.{ts,js,mts,mjs}`, `prisma/schema.prisma`; at root only, `*compose*.yml` and
`.github/workflows/*.yml|yaml`. Every read goes through `resolveRepoPath` (K7's guard), so a
workspace glob can never escape `root`.

**Dry-run by default** (non-negotiable 5): prints the candidate table and exits — nothing is
written. `--apply` merges the candidates into `.repoboard/systems.yml` (`emptySystemsDoc()` if
absent) and stamps `source: { detected: <file>, at: <now> }` on every row it touches. **A hand
row always wins**: a row whose `source` is already `hand` is left byte-for-byte unchanged and
counted as "kept", never overwritten or deleted. An existing `systems.yml` that fails to parse
refuses the whole run — errors on stderr, exit 1, nothing written — whether or not `--apply` was
given. `--apply` with no `.repoboard/` at `root` refuses the same way ("not a repoboard repo").

Table columns: `ID KIND LAYER ENV FROM`, then one `connections: <from>→<to> (<via>)` line per
connection, then an `unclassified:` block for anything a detector could not place, then a summary
line with the add/update/keep counts. Exit 0 on a clean dry run or a successful `--apply`; exit 1
on a parse or refusal error. `--json` prints the whole `DetectRun` (`files`, `candidates`, `plan`,
`applied`, `path`, `errors`). Measured read-only against freshpickedjobs (PH.5): 14 systems, 13
connections, 7 unclassified, ≈3 hand corrections; report 3,580 B.

### Surfaces over `.repoboard/systems.yml` (PH.3, RCB-97)

`repoboard systems [--json]` prints two `dev:`/`prod:` environment lines then the
`ID KIND LAYER ENV RUNTIME` table (file order, ≤80 B/row); no file: the one "no systems.yml yet"
line, exit 0; invalid: each parse error on stderr, exit 1. `repoboard systems show <id> [--json]`
prints one row plus its `pointers` resolved the way `card show --resolve` does; unknown id: exit
1. `--json` on either mirrors `store.systems()` (`{doc, errors, exists}`) / `{system,
connections, pointers}`.

MCP gains `list_systems` (`{exists, errors, environments, systems: [{id, kind, layer, env,
runtime}], connections}`, rows trimmed to five keys) and `get_system` (`{id}` →
`{system, connections, pointers}`, pointers resolved live); `check`'s description names the two
new findings. `GET /api/systems` is always 200 (an invalid file is a well-formed answer, like
`/api/cost`); the WS `snapshot` gains a `systems` field and a `systems` message on file change
(watcher already existed for `leases.yml`, same shape).

`repoboard seat <name>` gains exactly one line in every state: `Systems: <n> systems, <m>
connections, <envs> — repoboard systems` / `Systems: no systems.yml yet — repoboard systems
detect proposes one` / `Systems: systems.yml invalid (<k> errors) — repoboard check`.
`repoboard cost` counts `.repoboard/systems.yml` (`why: "systems"`) when present. `repoboard
check` gains `systems-invalid` (error — the file failed to parse) and `systems-stale` (warning —
a `source.detected` row no longer matches its source file; blocks only with `--strict`); an
absent file raises neither (§3.1: unconfigured is inert).

### Bytes (O3), measured 2026-09-22 on this repo's own systems.yml (5 systems, 3 connections, RCB-99)

| Surface | Bytes |
|---|---|
| `.repoboard/systems.yml` | 2,693 B (budget 4,096) |
| `repoboard cost` total with it | 87,559 B (was 84,866) |
| `repoboard seat <name>` Systems line | 66 B |
| `repoboard systems` | 631 B |
| `repoboard systems --json` | 4,383 B |
| `repoboard systems show repoboard` (4 source-file pointers, each truncated at the K7 cap) | 33,770 B; `--json` 36,049 B |
| `repoboard systems show freshpickedjobs` (0 pointers) | 400 B |
| `repoboard systems detect` (dry run) | 621 B; `--json` 1,999 B |
| MCP `list_systems` schema / result | 620 B / 2,776 B |
| MCP `get_system` schema / result for `repoboard` / for `freshpickedjobs` | 606 B / 37,366 B / 936 B |
| MCP `check` schema (names the two systems findings) | 665 B |
| MCP tool schema, **25 tools**, `client.listTools()` summing each tool's own `JSON.stringify` | **31,301 B** (was 26,401 B for 23 tools, RCB-70, 2026-09-19) |

`show` and `get_system` resolve pointer TEXT (K7 cap per file), so a row with source-file pointers
costs tens of KB while the list costs 631 B — list first, show one row. The seat line is 66 B
standing, the file 2,693 B in the cold read, both under plan §3.1's 4,096 B budget.

### Test coverage per pointer (RCB-110, owner chose A: static)

`repoboard systems show <id>` prints a `tests:` block between the row and the resolved refs —
`tests: N files` / `tests: none found` / `tests: n/a (no source pointers)`, then one line per
pointer (`<pointer>: N — a, b`, `none`, or the reason) and a `source:` sentence. The rule lives in
one pure function, `testsForPointers` (core `systems-tests.ts`): a test file is a code file
matching `*.test.*` / `*.spec.*` or under a `test/`, `tests/`, `__tests__/` segment; it exercises a
pointer when a relative import of it resolves to the pointer (or under a directory pointer) or its
text names the pointer literally; a pointer that is not in the tree or not a code file is `null`
with a reason (a non-code pointer named by a test is still `null`); `files` is the union across
pointers, `null` when no pointer is a source file. The server (`systems-tests.ts`) lists the tree
(`listRepoFiles`, git ls-files or the walk) and reads only the test files. Same payload on MCP
`get_system` (`tests`), `GET /api/systems/:id/tests`, and the Flow drawer's Tests row (collapsed;
`show` reveals the per-pointer list). Nothing is stored: 0 B added to systems.yml.

Measured 2026-09-22 on this repo (5 systems): `systems show repoboard` 33,770 → 34,616 B
(`--json` 36,049 → 37,477 B), `show freshpickedjobs` 400 → 564 B; 0.18 s wall for the repoboard
row (11 test files across 4 pointers; `repo-context.ts` has none that names it directly). The
literal-name half is broad by design: a fixture string naming `packages/server/src/cli.ts` in a
web test counts, and `packages/web/test/helpers.tsx` counts as a test file by its `test/` segment.
Coverage-report driven (B) is a later card with its own provenance.

## 8. Flow view (RCB-98)

A third top-level view, `Board | Map | Flow` (`View = 'board' | 'map' | 'flow'`, `TopBar.tsx`,
`App.tsx`), drawing `.repoboard/systems.yml` via core's pure `layoutSystems` (RCB-95) as inline
SVG — 0 KB added. States: no file → the `systemsSummary(null, []).line` note; invalid → each
parse error in a `<pre>`; else rows by `layer`, boxes per system, orthogonal edges. An env switch
(`dev | prod | both`, default `both`) redraws via `layoutSystems(doc, env)`; a `none` environment
shows its note in prose instead of a diagram. Clicking a box opens a drawer: the row's fields,
`pointers` resolved live (`GET /api/systems/:id/refs`, same resolver as `systems show`), and
backlinks — cards whose `refs:`/`files:` path equals or falls under a pointer — clicking one
selects the card and switches to Board.

## 9. Repo dashboard: health + commits + coverage (RCB-112 A)

`GET /api/dashboard` (per served repo, always 200 — the same "well-formed answer even when
everything is null" reasoning as `/api/cost` and `/api/systems`) returns `{now, health, commits,
coverage, coverageSource}`. **`health`** never re-runs a check (CLAUDE.md non-negotiable 2): a seat
records its own result with `repoboard gate record --as <seat> [--tests <passed>|<skipped>
--failed n] [--files n] [--typecheck n] [--lint n] [--build n] [--sha s] [--note t]` — one JSONL
line appended to `.repoboard/local/gate.jsonl` when that directory exists, else
`.repoboard/gate.jsonl` (`gateLedgerPath`, the one function the reader and `cli.ts`'s writer both
call); `sha` defaults to `git rev-parse --short HEAD` (null outside a repo); no check given is exit
1 and nothing written; `--tests` requires `--failed` (0 means a clean run) — given without it, exit
1 and nothing written (RCB-116), since an unstated failed count would read as `tests: FAIL`.
`repoboard gate show [--json]` prints the newest result per check (`tests`, `typecheck`, `lint`,
`build`), ordering by each record's `at` — not file position, so an older passing line after a
newer failing one still reports the failure, and a tie on `at` (same-second precision) goes to the
later line in the ledger (RCB-116) — and `no gate recorded` for a check with no line yet. RCB-146
gives MCP the same pair: `record_gate({as, passed?, skipped?, failed?, files?, typecheck?, lint?,
build?, sha?, note?})` calls the SAME `recordGate` (`repo-health.ts`) the CLI's flag parsing now
delegates to — one validation, one ledger writer — and returns the `GateRecord`; `get_gate()`
returns `loadGateHealth(root)`, the object `gate show --json` prints. **`commits`** is read live from git (never stored): the last 10 on `HEAD`
and on `origin/main` (null when that ref does not resolve), plus a 14-UTC-day commit count and a
per-`agent ?? author` count from `git log --since=<UTC midnight 13 days ago>`; `agent` is a
commit's first `Co-Authored-By` trailer name, email stripped. **`coverage`** is RCB-110 A's
per-system `tests:` line (`null` only when there is no valid `systems.yml`, `[]` for zero systems)
— the test-file corpus (`loadTestCorpus`) is read from the tree exactly ONCE for the whole
dashboard and reused across every system, not once per system. A repo with neither `.git` nor
`.repoboard/` still answers 200 with every field at its null state, never a throw.
