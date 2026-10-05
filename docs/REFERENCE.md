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

RCB-69 (ACME-28): `moveCard` — the one funnel every surface uses — refuses a DECIDED card moving
back into a `decision: true` column (naming the letter, or `—` for a words-only/task answer, and
pointing at `card ask` to open a new question) rather than letting it sit there looking undecided;
a never-asked card moving into one is allowed but warns. RCB-69 (ACME-33): `decide` always moves a
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

### Answered, not acknowledged (RCB-129)

Observed on acme, 2026-09-24: the owner answers ACME-19 on the web at 18:19:51Z (`decide`, core
`decisions.ts` — sets `decision.decidedAt`/`decidedBy`/`chosen`/`words`). Nothing a seat reads
changed: no log line, no STATE change; the card only left the OWNER QUEUE. The coordinator noticed
7 minutes later from `git status`.

`answeredDecisions(cards, {since?})` (core `decisions.ts`) is the one pure function every surface
below calls: every card whose decision `isDecided` (locked decision 1), newest `decidedAt` first —
`{id, title, assignee, question, chosen, chosenText, words, decidedAt, decidedBy, acknowledged}`.
`chosenText` is `chosen`'s option TEXT. A card decided by a hand edit that set `chosen`/`words` but
never stamped `decidedAt` is excluded — there is no answer TIME to report or sort by, and CLAUDE.md
rules out inventing one.

**`acknowledged`** is true once someone OTHER than `decidedBy` has written a `- <ts> <actor> —
<text>` bullet (§6's grammar) under the card's `## Log` OR `## Notes` **strictly after**
`decidedAt` — any touch counts, not a specific word: an ordinary `append_log`/move and `repoboard
card note <id> "ack" --as you` both clear it, whichever a seat reaches for first. `## Decision` is
not scanned — `ask`/`decide` append it at the same ts, by the same actor, as the matching `## Log`
line, so it could only repeat a hit already found there.

| Command | Example |
|---|---|
| `repoboard decisions [--since <ISO\|HH:MMZ>] [--all] [--json]` | `repoboard decisions` → table `DECIDED BY CARD CHOSEN ACK QUESTION`, unacknowledged rows only; `--all` also lists acknowledged ones; `--since 18:19Z` (or a full ISO-8601 datetime) filters on `decidedAt`; empty: `(no answered decisions awaiting acknowledgement)`, or `(no answered decisions)` with `--all` |

MCP: `list_decisions(since?, all?)` — same function, same default (unacknowledged only).

`seat <name>`'s bundle (and its rendered text) gains a `## Answered, not acknowledged` block right
after `## Open decisions` — the same rows, unacknowledged only, `(none)` when empty; the bundle's
`--json` carries it as `answeredNotAck`.

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
the file and re-reads it on an external `sed`/hand edit, exactly like `board.yml`. RCB-157D: on
macOS chokidar sometimes misses that fs event entirely (measured, RCB-157B: 65/1080 trials), so a
periodic reconcile sweep (every 2 s, off for CLI one-shots) re-stats the tracked files and routes
anything the watcher never reported, as a backstop rather than a poller the board depends on.

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

**LEASES is generated too (RCB-131), right after OWNER QUEUE, on the CLI and MCP read paths —
never on the on-disk file, never on `GET /api/state`** (item 4 of that card is out of scope: the
HTTP surface still shows the old four-section page byte for byte). One line per LIVE lease (never
a stale one — `check`'s `stale-lease` finding already owns those): `<resource> · <holder> · since
<HH:MMZ or date> · until <HH:MMZ, date, or —> · "<note>"` (the note clause only when one is
recorded), `(no live leases)` when there are none. `formatLeaseLine`/`renderLeaseLines`
(`leases.ts`) are the ONE formatter behind this line, this section, and `seat <name>`'s `## Leases`
block below — the three surfaces cannot disagree on the format. `repoboard state --json` and MCP's
`get_state` gain a `leases` array of the same `{resource, holder, since, until, state, note}` rows
`lease list --json`/`list_leases` already use, filtered to live only, via the ONE shared
`liveLeaseRows` (mcp.ts).

### CLI

| Command | Example |
|---|---|
| `repoboard state` | prints the rendered page (OWNER QUEUE, and LEASES right after it — RCB-131, live leases only — both generated fresh) |
| `repoboard state --json` | (RCB-144) read path only — refused with `--set-section`/`--trim-landings`; prints `{stamp, actor, sections, ownerQueue, leases}` from `store.state()`, `ownerQueue` generated fresh from cards that need a decision (same computation as MCP's `get_state`), `leases` (RCB-131) the live leases as `{resource, holder, since, until, state, note}` rows (same `liveLeaseRows` MCP's `get_state` calls); no `STATE.md`: `null`, exit 0 |
| `repoboard state --set-section LIVE\|LAST-LANDINGS\|SEATS (<text> \| --stdin) [--as a] [--force]` | `repoboard state --set-section LIVE "Tree is dev." --as claude/ops` → `updated STATE.md LIVE`. RCB-196: `SEATS` is written by the seat verbs (`seat <name> --up\|--down\|--update`, one bullet re-read under the lock), so `--set-section SEATS` WITHOUT `--force` exits 1 with `SEATS is written by seat verbs …` and writes nothing — a whole-section rewrite from a stale copy reverted another seat's UP on 2026-09-27. With `--force` it is the whole-section rewrite it always was. `LIVE` and `LAST-LANDINGS` never need it; `--force` without `--set-section` is a usage error. Same rule on every surface: MCP `set_state_section` takes `force: true`, HTTP `PUT /api/state/section` honours `force` only when the body says `force: true` (a non-boolean is a 400) |
| `repoboard state --trim-landings <n> [--archive <path>] [--as a]` | `repoboard state --trim-landings 3 --as claude/ops` — keeps the newest `<n>` LAST LANDINGS entries, archiving the rest verbatim to today's log (`.repoboard/log/<date>.md`, a normal seat-attributed block); with `--archive <path>` (RCB-132), archives to `<path>` INSTEAD (relative to root; created with a `# LAST LANDINGS archive` header if absent; never overwritten; no log block is written at all) — either way the SEATS-adjacent pointer left in LAST LANDINGS names wherever the entries went; `--archive` without `--trim-landings` is a user error; "nothing to trim: `<n>` entries ≤ `<n>`" and no write when there is nothing beyond `<n>` |
| `repoboard log --as <seat> [--title "…"] [--force] (<text> \| --stdin)` | `repoboard log --as claude/ops --title "armed the fires" "Five waiters set."` → `logged 2026-09-17 claude/ops` — creates today's file if this is the first entry. RCB-127 (owner decision 2026-09-25): also restamps STATE.md's own line-3 stamp — the SAME restamp `seat --update` performs (`setStateSectionCore` on `seats`, the UNCHANGED body, actor = `<seat>`) — iff `<seat>` has an UP bullet in SEATS right now (`findSeatLine`'s own match rule); the line then reads `logged 2026-09-17 claude/ops · STATE restamped (claude/ops is UP)`. A DOWN seat, an unknown seat, or a hand-typed block still leave `check`'s stale-state finding to fire until that seat runs `seat --update`. RCB-188: `[<board>] <seat>` and `<board> <seat>` (this board's name) ARE the seat `<seat>`, and a prefix naming another board is refused with nothing written — the store's own `seatName` door, run first inside `appendSeatLog` (also `setSeatBullet`/`updateSeatBullet`), so the same on every surface (CLI, MCP, HTTP `POST /api/log`, status 400). RCB-196: the append is read-modify-write under a cross-process file lock on the day's file (`<date>.md.lock`, the guard `state` and `--archive` use) with a unique tmp name, so two processes logging at once each land their block; and it is REFUSED from a linked git worktree (`git worktree add`) — exit 1 naming the main checkout — because the worktree's `.repoboard/` is its own copy, not the board's record (git absent or not a repository: no check, writes as before). RCB-198: with a local layer (`.repoboard/local/`) the append is the HOLDER's — the whole body runs inside `seats.yml`'s lock, the lease `seat:<seat>` (case-insensitive, as the bullet is matched) is read under it, and a pane that is not the recorded holder (same pane, or same host + pid + process start time — a new session after `/clear` is the same holder) exits 1 with NOTHING written (no block, no restamp), naming both labels: `builder is held by A7B2 · acme builder (UP 2026-09-30 00:32Z); you are 0460 · acme — use --force to write it anyway (audited in the log)`. `--force` appends ONE audit block first (`log --as builder --force over another holder`, text = the holder's label, its `since`, and who wrote it — labels only, never a pane id, session, pid or host), then the block asked for; if the audit cannot be written nothing else is. No lease (a legacy bullet, a seat nobody claimed) or no local layer: writable by anyone, as before, and `--force` there is not audited (nothing was overridden). No liveness is consulted — a dead holder is still the holder until `--up` takes it over or it stands itself down. An empty `<seat>` or `<text>` is refused before the check, so an audit is never written for a block that then fails |
| `repoboard log show [--date YYYY-MM-DD] [--seat s] [--since ts] [--tail n]` | prints a day's log (default today); `--seat` filters to that seat's own blocks; `--since ts` (RCB-132) keeps blocks whose `ts` >= `ts` — a full ISO-8601 datetime, or `HH:MMZ` for that UTC time on `--date`'s day; `--tail n` keeps the last `n` blocks of what's left, `n` greater than the count printing everything (never an error); the three compose in that fixed order — seat, then since, then tail. With any of the three, text output is the formatted blocks (as `--seat` alone prints them), never the day's raw file text |
| `repoboard log show --json [--date YYYY-MM-DD] [--seat s] [--since ts] [--tail n]` | (RCB-144, RCB-132) prints `{date, blocks: [{repo, seat, ts, title, text}]}` (RCB-160: `repo` is the `[name]` a block's header carries, `null` on an older unprefixed block) from the parsed blocks the text path already has, filtered the same way; no log for that date (or nothing matches): `{date, blocks: []}`, exit 0 |
| `repoboard log --last <seat>` | `repoboard log --last claude/builder` — prints that seat's newest block, searching back across every day in `.repoboard/log/` AND, when configured, `board.yml`'s `logDir` (RCB-54 — the same merged set `check` reads; `repoboard log` itself still only ever writes `.repoboard/log/`), not just today; the seat match is by LEADING WORD, case-insensitive, when `<seat>` is one word (RCB-62) — `builder` finds a hand-written heading like `BUILDER (fresh, f87be1)`, but `coordinator` does NOT match `COORDINATOR/SEARCH` (no whitespace, so that whole token is its own leading word); a multi-word `<seat>` still compares whole-to-whole; a cold seat with no history prints `(no log block for <seat>)`, exit 0 |
| `repoboard seat <name> [--json]` | `repoboard seat claude/builder` — the RCB-48 cold-start bundle in one command: an `## In flight / owes` section first (`in-flight:`/`owes:` parsed off the seat's own SEATS bullet, RCB-89), the SEATS bullet mentioning `<name>` (whole word), a `## Leases` block right after it (RCB-131: every LIVE lease, `<resource> · <holder> · since <…> · until <…> · "<note>"`, ` (yours)` suffixed when this seat holds it, `(no live leases)` when none — same `formatLeaseLine`/`renderLeaseLines` `state`'s LEASES section uses), its own last log block (same RCB-62 leading-word match as `log --last`), the coordinator's (omitted when `<name>` IS the coordinator), its Next card (RCB-103: first, the next unblocked step — `blockedReason(...) === null`, no assignee or assigned to it — of the first non-done card of its own that HAS steps (`parent`/`phase`/`gate`, RCB-68), in list order; only then, as before, assigned to it, else the highest-priority unassigned todo card — high > medium > low > unset, list order among equals — the render says which), and the cards with an open decision. Fixed `## ` headings; a missing part prints a one-line placeholder, never an empty section (a missing `in-flight:`/`owes:` line prints `(none recorded)`, empty-but-present prints as empty). Exit 0 on any successful read, even an entirely cold seat. `--json` prints the bundle object (`leases` an array of live `Lease`s). Prints `warning: dist is older than src — run pnpm build (<pkgs>)` on stderr when run from a source checkout whose `packages/*/src` is newer than its `dist` (RCB-60); silent from an npm install |
| `repoboard seat list [--json]` | RCB-89: one row per SEATS bullet whose first line is a seat bullet (a non-seat bullet, e.g. `- Owner tasks elsewhere: …`, is skipped, never an error) — `NAME  STATUS  STAMP  PANE  LABEL  LIVE  IN-FLIGHT`, columns padded to the widest value, `in-flight` printed as `-` when unrecorded; no bullets at all prints `(no seat bullets in SEATS)`. Exit 0 even with no STATE.md. RCB-199: `PANE` is the pane tag of the seat's recorded holder (`.repoboard/local/seats.yml`; 4 characters, 6 when another live holder shares them), `LABEL` is the holder label the bullet itself carries (`A7B2 · acme builder`), `LIVE` is whether that holder's process is still that process (`alive`, `dead: no process`, `dead: pid reused`, `unknown: other host`, …); each is `-` when there is no answer (no lease, no label, a holder with no pane). After the table, one `! <name> <STATUS>: holder <tag> is dead: no process` line per row whose holder is DEAD (`(no pane)` for a holder with no pane) — a bullet still saying UP for a process that is gone. A `seats.yml` that cannot be read is a stderr `warning: …`, the rows still print with those columns `-`. `--json` prints `SeatListRow[]` (`name`, `status`, `stamp`, `inFlight`, `label`, `tag`, `live`; `label`/`tag`/`live` `null` when unknown). RCB-184: with `board.yml`'s `workspace:` the home board's own seats follow this board's rows as `[<home>] <seat>`, read live and read-only (see §3 "Workspace"); an own bullet prefixed with the home's name is a copy and is not listed; an unreadable home is a stderr `warning: workspace: …`, this board's rows still print. `--up`/`--down`/`--update` together with `list` is a usage error — this is the reserved word that stops `seat list` being parsed as a seat literally named "list" |
| `repoboard seat whoami [--json]` | RCB-199: which seat does THIS pane hold — `A7B2 · acme builder`, i.e. the pane tag, the board's short name and the seat, read from `.repoboard/local/seats.yml` for the pane the command runs in (its `ITERM_SESSION_ID` and the rest of `seats.identityEnv`, measured from the environment the command is given). `A7B2 · no seat` when the pane holds none (exit 0 — not an error); `(no pane) · no seat` for a process with no pane env; ` (also holds a, b)` appended when the same holder has further seats (a finding, not a guess). A read: it creates no file and no lock and leaves the tree byte-identical. `--json` prints `{label, tag, seat, alsoHolds, holder, lease, bullet}` — `holder` is this process (`pane`, `session`, `start`, `host`, `pid`), `lease` the seat's recorded holder with its `tag`, `label` and `liveness`, `bullet` the seat's SEATS line; `seat`, `lease` and `bullet` are `null` when it holds none. A `seats.yml` that cannot be read is `seat whoami: <error>` on stderr, exit 1. `--up`/`--down`/`--update` together with `whoami` is a usage error |
| `repoboard seat <name> --up "<text>" [--force] [--from <seat>] [--pane <tag>] \| --down "<text>" [--force] \| --update "<text>" [--force]` | RCB-58: replaces ONLY that seat's own SEATS bullet — found the way `seat` finds its SEATS line: a stamped bullet only by its EXACT seat name (RCB-196: trimmed, whitespace folded, case-insensitive, its own `[repo]` prefix normalized away — `builder` never owns `builder-2` or `web builder`), an unstamped legacy bullet by label, then first line — with `- **<name>: UP\|DOWN <YYYY-MM-DD HH:MMZ>.** <text>`, restamping line 3 as `<name>` and touching no other byte; appended as the last bullet when the seat has none yet. `state --set-section SEATS` stays the whole-section rewrite, but since RCB-196 only with `--force` (see the `state --set-section` row). `--up` is a claim decided INSIDE the seats.yml + STATE.md locks, on the STATE.md, log and holder record read under them (RCB-197; before, `cli.ts` decided on the copy it loaded at open, so two panes could both take a seat): the seat's bullet is not UP, or its recorded holder (`.repoboard/local/seats.yml`) is THIS pane (same pane, or same host + pid + process start time — a new session after `/clear` needs no `--force`) → taken; the holder is DEAD (`kill -0` says no such process, or the pid is alive with a different start time) → taken over, with an audit block in the log naming the old holder by label, its `since` and `dead: no process` / `dead: pid reused`; the holder is ALIVE, or cannot be measured (`unknown`: another host, no pid, no start time) → refused, exit 1, nothing written, `builder is held by A7B2 · acme builder (UP 2026-09-30 00:32Z); you are 0460 · acme`, unless `--force` (taken, audited); a pane that already holds ANOTHER UP seat is refused whatever `--force` says, naming it, unless `--from <seat>`, which writes that seat DOWN (`moved to <name> in the same pane`, with the `in-flight:`/`owes:` lines) and drops its lease in the same locked write (`--from` needs a local layer, and a seat this pane does not hold is refused); a seat with no recorded lease (no local layer, or UP before holders were recorded) keeps the old rule — refused inside `activeWindowMinutes` of its freshest sign of life unless `--force` (RCB-87, RCB-169, audited in the log). `--pane <4|6 chars>` asserts this process's pane (the first characters of its pane id, case-insensitive; a restart paste-in carries it) and exits 1 writing nothing on a mismatch; `--from` and `--pane` are usage errors without `--up`. Order of writes: the audit block, then ONE STATE.md write (this seat UP, the `--from` seat DOWN), then seats.yml; a failed audit stops everything after it. `--json` adds `released` (the `--from` seat, else `null`) and `audit` (the audit block's title, else `null`); a `--from` also prints `restamped SEATS <label>: DOWN … (moved to <name>)`; `--down` is refused, before any write, unless `<text>` carries BOTH an `in-flight:` line and an `owes:` line (case-insensitive key, value trimmed — RCB-89, so a successor never has to guess a stand-down's live subagents/Monitors/worktree/lock holder or what it still owes); `--update` rewrites only the body, keeps the standing status + stamp, restamps line 3, refused when the seat has no bullet (RCB-88). Both `--down` and `--update` (RCB-130, one shared guard, `checkFieldCounts`) are ALSO refused when `<text>` carries MORE THAN ONE `in-flight:` or `owes:` line — a hand-edit that pastes a second copy of both fields (and their stale hand-typed `OWNER QUEUE = …`) into the same bullet is refused before the write, not left for `check` to find after the fact. `--update` still has no PRESENCE guard: a bullet with neither field yet may still be updated. RCB-198 — `--down` and `--update` are the HOLDER's (RCB-194: a pane wrote another pane's seat): with a local layer both take `seats.yml`'s lock, then STATE.md's (a stand-down by a caller with no holder identity — a store call that passes none — takes them too and is `web`, a non-holder), and the lease `seat:<name>` is read under them (case-insensitive, as the bullet is matched). A pane that is not the recorded holder (same pane, or same host + pid + process start time) exits 1, nothing written (STATE.md, `seats.yml` and the log byte-identical), naming both labels — `builder is held by A7B2 · acme builder (UP 2026-09-30 00:32Z); you are 0460 · acme — use --force to write it anyway (audited in the log)`; `--force` writes it and appends ONE audit block to the log FIRST (`seat --down --force over another holder` / `seat --update --force over another holder`, labels only; a failed audit stops everything after it). Every `--down` drops the seat's lease; `--update` keeps it (`seats.yml` is only read). A seat with no lease (UP before holders were recorded, or never claimed) is writable by anyone until it is next claimed, and a board with no local layer behaves exactly as before; `--force` on a seat nobody holds is not audited. No liveness is consulted: a dead holder is still the holder until `--up` takes it over or it stands itself down. A `seats.yml` that does not parse is `{ok:false}` for all three writes, nothing written. RCB-188: `[<board>] <name>` and `<board> <name>` (this board's name) are the seat `<name>`, and another board's prefix is refused before any write — `setSeatBullet`/`updateSeatBullet` run the store's `seatName` door themselves, so it holds for every caller, not just the CLI (the only surface that writes a seat bullet today; `log --as`, MCP `append_repo_log` and HTTP `POST /api/log` get the same door via `appendSeatLog`). RCB-196: `--up`/`--down`/`--update` are REFUSED from a linked git worktree (`git worktree add`) — exit 1, nothing written (`seats.yml` included), naming the main checkout to run it from — because the worktree's `.repoboard/` is its own tracked copy, not the board's record; git absent or not a repository: no check, writes as before |
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
| `stale-state` | error | STATE's stamp is older than the newest `#####` header time in the logs. A log file with at least one parseable header is judged by its headers alone; its mtime counts only for a file with NO parseable header (a git checkout/merge/stash that rewrites an old day's file no longer trips it) — RCB-170 | yes |
| `active-without-lease` | warning | a card in an `active: true` column whose `assignee` holds no live lease on any resource | only with `--strict` |
| `stale-lease` | error | any lease past `until` (one finding per lease) | yes |
| `live-lease` | info | RCB-131: one finding per LIVE lease, `live-lease: <resource> held by <holder> since <HH:MMZ> (until <…\|—>)` — so a plain `check` shows who holds what without a separate `lease list` | never |
| `needs-decision` | info | count of cards with an open decision; only emitted when > 0 | never |
| `needs-ask` | warning | a card in a `decision: true` column with no OPEN ask — never asked, or already decided and moved back | only with `--strict` |
| `gated-steps` | info | RCB-68: one line counting the cards blocked on a gate (`gated-steps: N card(s) blocked on a gate`) — the same set `repoboard card list` shows as BLOCKED; only emitted when N > 0. A blocked step is ordinary board state, not a rig problem | never |
| `cost-over-budget` | error | the root `CLAUDE.md` exceeds its budget (default 8192 B, or `board.yml`'s `claudeMdBudgetBytes`) — P8.4, §4 | yes |
| `local-unsynced` | warning | RCB-83: `.repoboard/local/` is its own git repo and has uncommitted changes (`local: uncommitted changes in .repoboard/local/ — repoboard local sync`), or no uncommitted changes but commits ahead of `origin` (`local: N ahead of origin`); at most one per run. Nothing is said when there is no local layer or it is not a git repo | only with `--strict` |
| `local-no-remote` | info | RCB-83/RCB-128: `.repoboard/local/` is its own git repo with no `origin` remote and no `remote: none` ack in `.repoboard/local/local.yml` — a forgotten backup is still caught every run, the ack silences it on purpose; see `repoboard local init --remote <url>` | never |
| `future-stamp` | warning | a log block's `#####` header time is more than 60 s ahead of `now` — hand-typed or clock-skewed, and ignored for `stale-state` rather than letting it wedge every other seat's `check` — RCB-90 | only with `--strict` |
| `systems-invalid` | error | RCB-97: `.repoboard/systems.yml` exists and fails to parse — one finding naming the first error (`(+N more)` when there are others); "a file that will not parse is worse than none". An absent file is inert | yes |
| `systems-stale` | warning | RCB-97: a `systems.yml` row marked `source.detected` that its source file no longer yields; one finding listing the stale rows. Computed only when the file parses and has at least one detected row | only with `--strict` |
| `systems-unblocker-unknown` | warning | RCB-161: a `systems.yml` system or connection whose `unblocked_by` names a card id that is on neither this board nor any workspace member (the id is resolved by its prefix); one finding per unknown id. Inert with no parsed `systems.yml` | only with `--strict` |
| `systems-planned-without-unblocker` | warning | RCB-161: a `systems.yml` system or connection whose status is not `live` (`planned` or `blocked`) and whose `unblocked_by` list is empty — "if this isn't live yet, what unblocks it?"; one finding per row. Inert with no parsed `systems.yml` | only with `--strict` |
| `untracked-cards` | warning | RCB-119: card files in the cards directory that git does not track (`git ls-files --others --exclude-standard`); one finding listing up to 10 ids with the actor of each one's newest `create` event, `…+N more` past 10. Inert when the root is not a git repo — a fresh repo's first `check` prints this and exits 0 | only with `--strict` |
| `seat-owner-queue-drift` | warning | a SEATS bullet's text hand-types `OWNER QUEUE =`/`OWNER QUEUE:` followed by a list of card ids, and that set differs from the GENERATED queue (`needsDecision` cards) — RCB-130; one per bullet | only with `--strict` |
| `seat-duplicate-bullet` | error | RCB-200: two or more STAMPED SEATS bullets (`- **[repo] name: UP\|DOWN <stamp>.**`) for one seat on one board — the seat verbs find only the FIRST, so they rewrite bullet N and leave the others reading whatever they last said. An unprefixed bullet counts as this board's, so `- **builder: …**` and `- **[repoboard] builder: …**` are duplicates; one finding per seat, naming every bullet's position; the later bullets are not judged again by the checks below | yes |
| `seat-name-ambiguous` | warning | RCB-200: one seat name stamped for two or more boards (`[acme] ops` and `[repoboard] ops`) — a seat verb matches the NAME alone, so one typed for one board can land on the other's bullet; one finding per seat name | only with `--strict` |
| `seat-log-while-down` | warning | RCB-200: a seat whose bullet says DOWN and whose newest log block on this board is NEWER than that DOWN — the stamp has minute resolution, so the block's time is floored to its minute first (a block in the DOWN minute is the seat's last block, the next minute is not); a block stamped more than 60 s ahead of `now` does not count (that is `future-stamp`); one finding per seat | only with `--strict` |
| `seat-up-dead-holder` | warning | RCB-200: a bullet says UP and the process `.repoboard/local/seats.yml` records for that seat is measured DEAD (no such process, or a recycled pid); `alive` and `unknown` (other host, no pid) say nothing; one finding per seat. Holder checks need a local layer and a `seats.yml` that parses — without them they say nothing, never "no holder" | only with `--strict` |
| `pane-holds-two-seats` | error | RCB-200: two or more recorded seats held by ONE holder (the same pane, or the same host + pid + start time) — a pane is one seat, `seat whoami` names only the first, the rest are leases it never released; one finding per holder, naming its seats. A holder check (see `seat-up-dead-holder`) | yes |
| `seat-lease-bullet-drift` | warning | RCB-200: the bullet and the lease disagree about who holds a seat — UP with a lease whose pane the bullet's holder label (`1D3F ·`) is not a prefix of (or one side has a pane and the other none), UP with a label but no lease, DOWN with a lease, or a lease for a seat with no stamped bullet on this board; one finding per seat. A holder check (see `seat-up-dead-holder`) | only with `--strict` |
| `seat-copy` | warning | RCB-184: only with `board.yml`'s `workspace:` — a STAMPED SEATS bullet prefixed with the home board's name (`- **[acme] coordinator: UP …**`) is a copy of a seat the home's own STATE.md speaks for; `seat list` hides it and reads the home's bullet live, so the copy only goes stale — delete it. One per bullet; silent when the home cannot be read (its name is then unknown) | only with `--strict` |
| `seat-home-unreadable` | warning | RCB-184: only with `workspace:` — the home's `.repoboard/`, STATE.md or board.yml cannot be read (names the `workspace:` text as written and why); this board's own seats still list, the home's are not shown | only with `--strict` |
| `seat-home-not-member` | warning | RCB-184: only with `workspace:` — the home's `repos:` lists no root that resolves to this repo (`resolveMemberRoot`, symlinks resolved), so the link is one-sided: add this repo to the home's board.yml, or drop `workspace:` | only with `--strict` |
| `workspace-member-missing` | error | RCB-153: at a workspace root, a `repos:` entry whose root has no `.repoboard/` — names the key and the resolved path; one per missing member | yes |
| `workspace-key-name-mismatch` | warning | RCB-160: at a workspace root, a member whose `boardDisplayName` (board.yml `name:`, else its folder) differs from the `repos[].key` the workspace uses for it — that member's OWN SEATS bullets and log headers are prefixed with its NAME (slice 1), while workspace `state` prefixes them with its KEY (slice 2); one per mismatched member, before that member's own findings | only with `--strict` |
| `public-denylist-missing` | info | RCB-209: `.repoboard/local/` is its own git repo and has no `public-denylist.txt` — the file that lists what the public repo must never contain (one extended regex per line, case-insensitive; blank and `#` lines ignored). A board with no local layer is never told, since nothing private has anywhere to live | never |
| `public-denylist-invalid` | error | RCB-209: `.repoboard/local/public-denylist.txt` exists but the match could not run — the file is unreadable, or git cannot compile a pattern in it (`error` is git's first line of complaint). While it fires no hits are reported: a match that could not run reads as an error, never as zero hits | yes |
| `public-denylist-hit` | error | RCB-209: one or more lines of git-tracked files match a pattern in `.repoboard/local/public-denylist.txt` (`git grep -n -I -i -E`; binary files and lockfiles are skipped). One finding with the counts and up to 5 hits as `path:line` (`…+N more`) — never the matched text, so the finding cannot itself leak what the denylist keeps out. A present file with no patterns yields nothing | yes |

Findings are pure data (`{kind, level, message}`); `exitCodeForFindings(findings, strict)` is the
one function every surface (CLI, HTTP, MCP) calls to turn them into the 0/1 contract, so the
meaning of `--strict` cannot drift between surfaces.

### MCP

`get_state()` → `{stamp, actor, sections: {live, lastLandings, seats}, ownerQueue: [{id, question,
options}], leases: [{resource, holder, since, until, state, note}], text}` (nulls/`[]` before any
STATE.md exists), `set_state_section(section, body, actor?, force?)` (RCB-196: `SEATS` needs `force: true`), `append_repo_log(seat, text, title?, force?)`
→ `{date, block, restamped}` (RCB-127: `restamped` is true iff `seat` had an UP bullet in SEATS at
the moment of the call — the same restamp `seat --update` performs; RCB-198: written as this MCP server's own holder — `repoboard mcp` measures `holderFromEnv` once at startup — so a seat another pane holds is an error result, both labels named and nothing written, unless `force: true`, which is audited in the log), `check(strict?)` →
`{findings, exitCode}`. All four are terse (no `CARD_INTRO`, matching P8.2's five lease tools) and
each measures under 700 B. `ownerQueue` (both here and in `repoboard state --json`) is computed by
one shared function (`card-query.ts`, RCB-146) — the CLI and MCP can no longer disagree about which
cards are open. RCB-131: `leases` is the live-only rows `liveLeaseRows` (mcp.ts) computes — the same
function `repoboard state --json` calls — and `text`'s generated LEASES section (right after OWNER
QUEUE) formats the SAME live leases through `renderLeaseLines`; none of the three ever writes to
`.repoboard/STATE.md` on disk.

RCB-146 rounds out the read side: `get_log({date?, seat?, since?, tail?, last?})` → `{date,
blocks}` (same as `log show --json`, `seat` upper-cased the way the CLI does; RCB-132 adds
`since`/`tail`, the SAME `filterLogBlocks` core function `log show --since/--tail` calls, composed
seat-then-since-then-tail), or, with `last` (exclusive with `date`/`seat`/`since`/`tail`), that
seat's newest block anywhere in the log: `{date, block}`, nulls when it has none. `get_seat({name})`
→ the SAME cold-start bundle `seat <name> --json` prints, including `holder` (RCB-199: the seat's
recorded holder with its pane tag, label and liveness, `null` when none) and `holderError`; read
only — `--up`/`--down`/`--update` stay CLI-only for now.

### HTTP

`GET /api/state` (same shape as MCP `get_state`), `PUT /api/state/section`
`{section, body, actor?}` — 200 with the refreshed state, 400 for a bad section/empty body, 409
map-only. `GET /api/log?date=` → `{date, text, blocks}` — merged with `board.yml`'s configured `logDir` for that date when set (RCB-62; the same source `check`/`seat` read), 404 only when neither file exists for that date. **Reversed 2026-09-21 (RCB-71, owner chose A):** `repoboard log` WRITES to `logDir` when it is set; reads unchanged.
`POST /api/log` `{seat, text, title?, force?}` — 200 with `{date, text, block, restamped}`, 400/409 as above (RCB-198: this door has no pane — it writes as `web` — so a seat with a recorded holder on a board with a local layer is refused with 409 `… you are web — use --force …`, nothing written, unless the body says `force: true`, which is audited in the log; a non-boolean `force` is a 400); `restamped` is true when `seat` had an UP bullet in SEATS, so STATE.md was restamped too (RCB-127, same function as `log --as`).
`GET /api/check?strict=1` is a pure read, always 200 (`{findings, exitCode}` — exitCode is data,
not a status code, the same reasoning as `GET /api/leases/check/:resource`). The WS `snapshot`
carries `state` and `log`; a `{type:"state", state}` message follows any rewrite (from any
surface), and `{type:"log", date, text}` follows any append or external edit of that day's file.
RCB-217: the snapshot's `log` is today's day when it has at least one block, else the newest
earlier day within 14 days that has one, else today's empty payload (`GET /api/log` still answers
for the day it is asked about). The snapshot also carries two derived payloads, each re-sent as its
own message:

- `seats` — `SeatRowPayload[]`, one per stamped SEATS bullet, the rows and holder join `seat list`
  prints (core's `seatRowPayloads`, built on `seatListRows`, `parseSeatFields` and `parseSeatStamp`
  — one parser): `{name, home, status: "UP"|"DOWN", at, tag, label,
  live: "alive"|"dead"|"unknown"|null, inFlight, owes}`. `home` (RCB-184) is the home board's
  display name on a row read from the home (`workspace:`; `name` is then `[<home>] <seat>`, listed
  after this board's own rows, which omit the home's copies; the home is re-read on every send),
  `null` on this board's own rows. `at` is the stamp as ISO, `null` when it does not parse;
  `tag`/`label`/`live` are `null` when nobody holds the seat (or `seats.yml` cannot be read — rows
  with null holder fields, never an error); `inFlight`/`owes` are `null` when the bullet has no such line.
  `{type:"seats", seats}` follows every STATE.md change and every `seat` event, and a 30 s poll
  sends it again ONLY when the JSON differs from the last one sent — a holder's process ending
  leaves no file event. Nothing is polled while no client is connected; a new connection makes the
  next poll re-send once.
- `landings` — `{rows, web, source}`: the last 14 days of HEAD's commits (`git log`, the dashboard's
  own read) whose subject starts with a card id of the board's prefix followed by `:` or a space
  (`RCB-217: …`; `cards: RCB-1 filed` is not a landing), grouped by card id — `rows[]` is
  `{cardId, commits: {sha, at, author, subject}[]}`, commits newest first, cards ordered by their
  newest commit. `web` is the GitHub https base `GET /api/git` reports (`null` without one);
  `source` names the command. No git: `{rows: [], web: null, source}`. `{type:"landings",
  landings}` follows a new HEAD (checked by the same poll).

The ticker's `seat` events (`events.jsonl`, plan §2) are one per SEATS status change — `took the
seat` / `stood down`, with ` · <pane tag>` when a holder was recorded.

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
content is sized like a member repo's real `docs/STATE.md` (2026-09-17); `check`/`get_state`
measured via the MCP client the same way as §1/§2's tables.

| Surface | Bytes |
|---|---|
| `repoboard state` (rendered page, no open decisions) | 1,186 B (P8.3). RCB-131's generated `## LEASES` section adds 29 B with no live lease — measured on a fresh `init --practices`, 227 → 256 B; this fixture itself was not re-run |
| `repoboard state` (same page, 4 cards / 2 with an open decision) | 1,212 B (+26 B: two `RB-n · <question> · [letters]` lines replacing the placeholder) — plus the same 29 B LEASES section since RCB-131 |
| `repoboard log show` (3 blocks, one per seat) | 242 B |
| MCP `get_state` result | 515 B (P8.3). RCB-131 adds 49 B with no live lease (the LEASES text section plus `leases: []`) — fresh `init --practices`, 495 → 544 B |
| MCP `check` result (clean fixture, empty findings) | 83 B |
| MCP tool schema, 14 tools (P8.2 baseline) | 17,411 B |
| MCP tool schema, **18 tools** (`client.listTools()`, sum of each tool's own `JSON.stringify`; the current count and bytes are in section 3) | **19,682 B** (+2,271 B for the four P8.3 tools) |

Per-tool bytes of the four new tools: `get_state` 432 B, `set_state_section` 645 B (RCB-196: 693 B with the `force` parameter, re-measured through `client.listTools()`),
`append_repo_log` 628 B, `check` 566 B — every one under the 700 B budget, for the same reason
P8.2's five lease tools are: no `CARD_INTRO`/`ACTOR_DESC` reuse, because state/log/check are not
cards.

### Workspace (RCB-153 slices 1-3b)

A workspace is a normal board whose `board.yml` carries one more optional key — `repos:`, a list
of member boards this one coordinates:

```yaml
name: acme-workspace
prefix: WS
repos:
  - key: acme                 # ^[a-z0-9][a-z0-9-]*$ — the CLI/MCP/`/api/repos` key
    root: ../acme             # relative to THIS board's root, or absolute; `~` expanded
    writes: cards             # optional; absent = read-only member (O7). Only value in v1
  - key: repoboard
    root: ../repoboard
```

A board with no `repos:` key is exactly today's board — `state`, `state --json` and `check` render
byte-identical to before this card. A member is opened lazily, read-only, and memoised for the
life of the process (`Workspace`, `packages/server/src/workspace.ts`) — the same "open on demand"
shape `RepoRegistry` (RCB-43) already uses for `serve --root`. Opening a member creates NOTHING in
its tree: no `.repoboard/local`, no log dir, no gate file (W3). A `root` that does not exist, or
exists with no `.repoboard/`, is not an error to open — the returned store just has `hasBoard:
false`, `openStore`'s existing map-only contract for any such root.

**`state` aggregates.** OWNER QUEUE renders the workspace's own open-decision lines first, exactly
as before, then each member's, `repos:` order, every member line prefixed `[<key>] ` — a member
with nothing open contributes no line, a member whose root has no board contributes exactly one,
`[<key>] (missing)`. LEASES does the same with each member's live leases, right after the
workspace's own. RCB-160 slice 2: SEATS does the same with each member's OWN SEATS bullets, right
after the workspace's own — every bullet re-keyed `[<key>] ` (`keySeatBullets`, `packages/core/src/
seat.ts`), REPLACING whatever `[<name>] ` prefix the member's own board already writes on it
(slice 1's `boardDisplayName`) rather than leaving both; a member's whole-word `seat <name>` match
is unaffected (it strips any prefix before matching either way). A missing member contributes no
SEATS line — its `(missing)` already shows once, under OWNER QUEUE. `--json` adds `repos: { <key>:
{ ownerQueue, leases, seats, missing? } }`, one entry per configured member — `ownerQueue`/`leases`
the same row shapes `ownerQueue()`/`liveLeaseRows()` already produce for the workspace's own
top-level fields, `seats` the same `SeatRow[]` `seat list --json` produces (bare names, never
`[key]`- or `[name]`-prefixed — that prefix is a `state`-text-only, `repoboard state`'s human page,
concern), `missing: true` (with empty arrays, `seats` included) instead of either when the root has
no board.

**`check` aggregates.** The workspace's own `checkFindings` run first, then, for each member: a
root with no `.repoboard/` is one error finding, `workspace-member-missing` (names the key and the
resolved path); otherwise, RCB-160 slice 2: a member whose `boardDisplayName` differs from the
`repos[].key` the workspace uses for it is one warning finding, `workspace-key-name-mismatch`
(names both), BEFORE that member's own findings; then the member's own `check` runs (the SAME
`checkFindings`/`store.check` every board runs) and every one of its findings is prefixed `[<key>]
`. Exit code is one `exitCodeForFindings` call over the combined list — the worst of the
workspace's own and every member's.

**`workspace:` — a member's home board (RCB-184 slice 1).** The other direction of the link: a
member's `board.yml` may carry `workspace: ../acme`, the root (relative to THIS repo's root, or
absolute, `~` expanded — the same `resolveMemberRoot` rule as `repos[].root`) of the board its
coordinator seat actually lives on. Absent = today's board, byte-identical. With it, `seat list`
prints this board's own rows and then the HOME's own seats, named `[<home name>] <seat>`, read live
from the home's STATE.md SEATS section and `.repoboard/local/seats.yml` holders (`seat list --json`
carries the same `SeatListRow` shape) — a bullet in the home's SEATS that is prefixed with some
third board's name is that board's seat, not the home's, and is left out. The read is strictly
read-only (`CardStore.readHome`, `packages/server/src/store.ts`: `load(false)` only reads, nothing
is created or watched), one hop (the home's own `workspace:` is not followed). An own SEATS bullet
prefixed with the home's name (`[acme] coordinator`) is a stale copy and is left out of the list.
A home that cannot be read (no `.repoboard/`, no STATE.md, a board.yml or STATE.md that does not
parse) is a stderr `warning: workspace: …` and this board's own rows still print — never an empty
list standing for "unreadable". `check` adds three warnings (kinds in the findings table):
`seat-copy`, `seat-home-unreadable`, `seat-home-not-member`; and, while the home is readable,
`stale-state` ignores log blocks written under the home's name (`##### <ts> [acme] coordinator` —
the home's seat speaking in this member's log says nothing about this board's STATE.md).

**Card-id resolution (W4) — wired into `card show`/`list`, plus every write verb (RCB-153 slice
2).** `resolveCardRef(ref, boards)` is pure and now lives in its own leaf module,
`packages/core/src/card-ref.ts` (still re-exported from `workspace.ts`, so no existing import of it
needs to change): a bare `<PREFIX>-<n>` checks the workspace's own prefix first, then exactly one
member's; a prefix two members share is an error naming both keys and `<key>:<id>` is always
accepted for a known key. At a workspace root:

- `card show <ref>` resolves `<ref>` by W4 and reads that board's own card (a plain board, no
  `repos:`, never calls `resolveCardRef` at all — every existing error text is byte-identical).
- `card move/note/ask/decide/update <ref>` resolve the same way, then write through
  `Workspace.storeForWrite(key)` (`packages/server/src/workspace.ts`) — the ONE function that
  checks `writes: cards`; every write verb goes through it and none checks `writes` itself. A
  member with no `writes:` refuses with the exact text `member <key> is read-only (set writes:
  cards in board.yml)`, and its tree is left byte-identical (the write never opens the member's
  store when the check fails). `card add` targets `--repo <key>` instead (absent = the workspace
  itself, unaffected by `writes:`).
- `card list --repo <key>` is that one member's own table (unchanged shape); `--repo all` is every
  board's cards in one table, a `REPO` column first (`repos:` order, the workspace's own rows
  tagged with its own basename key, the same key `GET /api/repos` will give it in W6). `--json`
  rows gain a `repo` field either way. With no `--repo` at all, `card list` is exactly the
  workspace's own cards, unaffected.
- A WORKSPACE card's `gate: <id>` resolves the same way (W4) when its target isn't found on the
  workspace's own board: core's `gateState`/`blockedReason` (`packages/core/src/phases.ts`) take an
  OPTIONAL trailing `members: GateMemberFacts[]` (`{key, prefix, cards, config}`, never a verdict) —
  a member's own `done`/decided column decides clear-ness, from that member's OWN config. Every
  existing single-board caller (`rollup`, `seat`, MCP, web) passes none, so their output is
  byte-identical. Wired into `card list`'s BLOCKED column at a workspace root only. Still
  single-board (open, after RCB-153): `seat`, `state`'s gated count, MCP `list_cards`' `blocked`,
  and the web board read a member-card gate as `blocked on <id> (no such card)` — never clear.

**`serve` expands (RCB-153 slice 3a, W6).** `repoboard serve` with NO `--root` at all, at a
workspace root, serves the workspace plus every member — one process, roots = [workspace,
...members in `repos:` order]. The workspace keeps its `assignRepoKeys` basename key (unchanged);
every member keeps its CONFIGURED `repos[].key`, never re-derived from its folder name — the same
key `GET /api/repos`, the per-root startup line, and `/api/repos/<key>/…` all end up printing,
because they all read it off the one `RootEntry[]` `cli.ts`'s `workspaceServeRoots` builds
(`packages/server/src/repo-context.ts`'s `RepoRegistry` takes this pre-keyed list directly instead
of running it through `assignRepoKeys` — a NEW `keyedRoots` input on `ServerOptions`/`RepoRegistry`,
not a second key function; a plain `roots: string[]` list is byte-identical to before). ANY
`--root` flag is the override — no workspace expansion when one is given, so `serve --root .`
serves only the workspace, exactly as a plain board would. `repos[].key`'s shape and uniqueness
among members is already enforced by `board.yml` parsing (`BoardConfigSchema`); the only NEW
collision this checks is a member key against the workspace's own key or the reserved `repos` word
(`GET /api/repos` is the list route) — either throws a `UserError` naming the key. A member whose
`root` does not exist is not an error here either — `serve`'s own per-root startup line already
says `(board)` or `(map-only)` for every key, so a missing member is still named, never silently
dropped.

**`init --workspace` scaffolds one (RCB-153 slice 3a, W8).** `repoboard init --workspace --repo
<key>=<path>` (repeatable) writes `board.yml` with a `repos:` entry per flag — the path relative
when the member shares this directory's OWN parent (the sibling-repo layout W2 assumes), absolute
otherwise, `~` expanded. Validation (the key regex, duplicate keys) goes through the SAME
`BoardConfigSchema` `board.yml` parsing already uses, not a second copy of the rule, so a refusal
here reads exactly like the one `check`/`serve` would give the same file later. It refuses when
`.repoboard/` already exists — even with `--practices` (repos: is a one-time scaffold, never a
merge onto a board that might already have a different member list; plain `--practices` with no
`--workspace` is unaffected, exactly today's behaviour). It never reads or writes anything under a
member's own path — path arithmetic is pure string math (`resolve`/`dirname`/`relative`), and a
member that does not exist yet is allowed (`check` finds it later as `workspace-member-missing`);
the CLI's own output says so, one line per configured member.

**`mcp` sees the same store, the same resolution, the same 30 tools (RCB-153 slice 3b, W7).**
`repoboard mcp` at a workspace root opens the workspace with its members, exactly like every other
verb — no new tool, no new transport concept. Six read tools (`list_cards`, `board_summary`,
`check`, `get_state`, `list_leases`, `get_log`) gain an OPTIONAL `repo` argument (a workspace member
key; `list_cards`/`list_leases` also take `"all"`, the same "every board, each row tagged" shape
`card list --repo all` gives the CLI); `create_card` gains an optional `repo` too (needs `writes:
cards`, same as `card add --repo`). With no `repo` at all: `get_state`/`check` AGGREGATE exactly as
`state`/`check` do (member lines `[<key>] `-prefixed, `check`'s exit code the worst of all of
them); the other four are simply this board's own view, unaffected. The **`repo` property (and any
description wording that mentions it) exists ONLY when the store is a workspace** — a plain board's
`tools/list` is untouched, byte-identical, because `createMcpServer` builds each of these six tools'
schema conditionally on `store.config.repos` at server-construction time (the same "board with no
`repos:` is exactly today's board" rule every other slice keeps); the tool count pin stays 30.

The seven card verbs that take an `id` (`get_card`, `move_card`, `update_card`, `add_note`,
`ask_owner`, `record_decision`, `append_log`) resolve it by W4
(`resolveWorkspaceCardRef`/`resolveWorkspaceWriteTarget`, `packages/server/src/workspace.ts`) —
their SCHEMAS never change (id resolution is transparent to the caller), only what a bare id means:
`BB-1` reaches the member whose prefix is `BB`; a write additionally clears `writes: cards`
(`Workspace.storeForWrite`, the exact refusal text `member <key> is read-only (set writes: cards in
board.yml)`) before it opens that member's store at all.

**MCP is long-lived; a member is opened FRESH every call, never memoised across calls.** `serveMcp`
opens the top-level board once, watched, for the life of the process — but a member's `CardStore` is
a one-shot snapshot (`watch: false`) the moment it is opened, and nothing here refreshes it after
that. Holding one open across calls would mean a member card edited on disk (another seat's commit)
goes stale until this process restarts. So every tool that touches the workspace calls
`openWorkspaceBoards`/`new Workspace(...)` again, from scratch, on every single invocation: a fresh
`Workspace`, opened again, is strictly cheaper to get right than a long-lived one with its own
invalidation logic, and a member board is small enough that re-reading it per call is not a cost
worth avoiding. `cmdState`/`cmdCheck`'s own aggregation (`memberStateRepos`, `checkMembers`,
`packages/server/src/workspace.ts`) moved out of `cli.ts` in the same slice so MCP's `get_state`/
`check` share the identical loop instead of a second copy of it — the CLI's own output is
byte-identical, only the code moved.

| Command | Example |
|---|---|
| `repoboard state` (workspace root) | OWNER QUEUE/LEASES/SEATS aggregate every configured member, `[<key>] `-prefixed, after the workspace's own lines (SEATS: RCB-160 slice 2, replacing a member's own `[<name>] ` prefix) |
| `repoboard state --json` (workspace root) | adds `repos: { <key>: { ownerQueue, leases, seats, missing? } }` |
| `repoboard check` (workspace root) | runs `check` on the workspace, then every member, `[<key>] `-prefixed; a missing member is `workspace-member-missing` (error); a member whose board name differs from its key is `workspace-key-name-mismatch` (warning, RCB-160); exit = the worst of all of them |
| `repoboard card show BB-1` (workspace root) | resolves to the member whose prefix is `BB`, reads its card |
| `repoboard card move BB-1 done` (workspace root) | resolved the same way, written through `bb`'s own store — refused if `bb` has no `writes: cards` |
| `repoboard card list --repo all` (workspace root) | every board's cards, `REPO ID STATUS ASSIGNEE … TITLE` |
| `repoboard serve` (workspace root, no `--root`) | one process, `GET /api/repos` = `[<workspace-key>, ...members]`, every key from `board.yml` |
| `repoboard serve --root .` (workspace root) | overrides expansion — only the workspace, exactly a plain board |
| `repoboard init --workspace --repo aa=../aa --repo bb=/abs/bb` | scaffolds `board.yml` with `repos: [{key: aa, root: ../aa}, {key: bb, root: /abs/bb}]` |
| MCP `list_cards {repo:"bb"}` (workspace root) | BB's cards only, each row tagged `repo:"bb"` |
| MCP `list_cards {repo:"all"}` (workspace root) | every board's cards, each row tagged with its own key |
| MCP `get_card {id:"BB-1"}` (workspace root) | resolves by prefix, same as `card show BB-1` |
| MCP `add_note {id:"AA-1", ...}` on a read-only member | refused, the exact W5 text; AA's tree untouched |
| MCP `get_state`/`check` with no `repo` (workspace root) | aggregate, same shape `state`/`check` give the CLI |

## 4. Cost — what a cold agent loads, against a budget (P8.4)

`repoboard cost` answers one question in bytes: **what does a cold agent load before it does
anything?** — `CLAUDE.md` at the repo root (and `.claude/CLAUDE.md`, `CLAUDE.local.md` if
present, each listed separately), `AGENTS.md` at root and `docs/AGENTS.md` if present, every
repo-relative path `CLAUDE.md` names in backticks that **exists as a file** (first-order only —
no recursion into a linked file's own text, no globs, deduplicated; `..` and absolute paths are
ignored), and the **names** (never bytes — that cost is per-harness) of any MCP servers in
`.mcp.json`. Tokens are an ESTIMATE at 4 bytes/token, always printed with `≈` and labelled as an
estimate. Motivating measurement (plan §5 P8.4): a member repo's own `CLAUDE.md` reached
32,620 B — loaded into every turn of every subagent, including ones that never needed 151 lines
of verification catalogue — before anyone measured it; it was cut to 4,996 B by hand on
2026-09-17, the same day this task landed.

Core (`packages/core/src/cost.ts`, pure — §0.5) does the extraction rule and the arithmetic;
`packages/server/src/cost.ts` does the one `stat`/`readFile` per candidate, through the same
`resolveRepoPath` guard K7's refs use (absolute, `..`, `.git/`, and a symlink escaping the repo
are all refused there too, even though `extractLinkedPaths` already rejects the first two on
syntax alone). **Read-only**, always: `cost` never writes, and the CLI's own `--root` measures
ANY directory, with or without a `.repoboard/` board — that is the case of a member repo that has
never adopted this tool.

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

Both measured with the built CLI (`pnpm build` first). The member-repo run is **read-only**:
`git -C ../acme status --short` was identical (empty) before and after.

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

**A member repo** (`repoboard cost --root ../acme`, its
own default budget — it has no `board.yml`):

`CLAUDE.md` plus 11 linked files; their names and sizes are that repo's own and are left out of this public doc.

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

### Measured on a member repo (read-only — `git status --short` and `.repoboard/` presence both
unchanged before and after every call)

`sync-issues README.md#Known issues --dry-run --root ../acme`,
measured three times as the target repo moved under this task:

| member-repo HEAD | create | close | malformed | Why it changed |
|---|---|---|---|---|
| `b633c84` (brief's own number) | 68 | — | — | the brief's stated expectation, superseded before the builder ran |
| `b633c84` (orchestrator's re-measurement, same sha) | 69 | 0 | 0 | K130/K131/K132 were filed after the brief; K130 was struck in place, still counted (open-SHAPED, per the literal rule) |
| `44acaf1` | 64 | 0 | 0 | K67/K68/K69/K70/K81 (closed-in-text but open-in-shape) and the struck K130 were all moved out to `docs/CLOSED-ISSUES.md` |
| `0427693` (final measurement, this task's own build) | 64 | 0 | 0 | unchanged from `44acaf1` — confirms the count is stable, not a fluke of one commit |

Every one of those runs left `git -C ../acme status --short` byte-identical before and
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
| CLI `sync-issues --dry-run` against a member repo (64/0/0) | 323 B |

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
degrading silently under load. Measured on a large member repo (K12, README): before the fix, the
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

**Watcher reconcile and empty-read grace (RCB-157, RCB-164).** Both are `openStore(root, opts)`
options only — no CLI flag and no `board.yml` key reaches either one; every call
site in `cli.ts`/`workspace.ts`/`mcp.ts`/`repo-context.ts` passes only `watch`/`now`
(`packages/server/src/store.ts:2475` `openStore`). `reconcileMs` (`store.ts:153`, doc comment
above it) periodically re-stats the tracked files and routes anything the watcher's own events
never reported — the fix for a measured chokidar miss (RCB-157B: 65/1080 macOS trials had no raw
event at any delay after ready, 0/1080 on Linux). Default: the caller's own value, else `2000`ms
when `watch` is true, else `0` (`store.ts:437` `this.reconcileMsOpt = opts.reconcileMs`, applied at
`store.ts:545` `reconcileMs = this.reconcileMsOpt ?? (watch ? 2000 : 0)`); `<= 0` always turns it
off (`store.ts:546`). `emptyGraceMs` (`store.ts:142`, default `1000`ms at `store.ts:437`) holds a
0-byte read of a path that already maps to a card — `writeFile` is `open(O_TRUNC)` then a separate
`write`, and a gap between them can make the watcher see an empty file mid-write — for that long
before re-checking it (`store.ts:1874`, `:1960-1973`); `<= 0` reproduces the un-held behaviour
exactly: an immediate `card:removed` + `invalid`.

**`REPOBOARD_WATCH_DIAG=1`** (RCB-157, set on CI's `pnpm test` step — `.github/workflows/ci.yml`)
turns on an opt-in recorder, off for any other value including unset (`watchDiagFromEnv`,
`packages/server/src/watch-diag.ts`). While on, `store.ts` records the watcher's lifecycle
per store root — row kinds `ready`, `all` (chokidar events), `enq`, `run`, `dedupe`, `empty-hold`,
`error`, `reconcile`, `reconcile-on`, `sweep`, `sweep-busy` — capped at the most recent 500 rows per root (`createWatchDiag`, `watch-diag.ts`). On a
timeout, `packages/server/test/helpers.ts`'s `waitForEvent` (and the ws-queue waits in the
systems/http/multiroot tests) calls `dumpWatchDiag(roots)`, which prints `diag.dump(root)` — a
`RB157 DIAG root=<root> node=<version> rows=<n>` header followed by each `[Date.now(), kind,
...fields]` row as JSON — to stderr via `console.error` (`helpers.ts:76-82`), so a CI-only miss
carries a trace instead of a bare "timed out" message.

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
counted as "kept", never overwritten or deleted. A system or connection named in `rejected:`
(RCB-162, a hand "no" with a required `why`) is skipped the same way — `detect` never re-adds a
row the owner turned down. An existing `systems.yml` that fails to parse
refuses the whole run — errors on stderr, exit 1, nothing written — whether or not `--apply` was
given. `--apply` with no `.repoboard/` at `root` refuses the same way ("not a repoboard repo").

**RCB-161 slice 3.** A package with no `bin` and no client/service dependency signal — today's
`unclassified` case — is instead proposed as `external`/`planned` when its name matches a known
third-party integration token (`KNOWN_INTEGRATIONS`, `packages/core/src/systems-detect.ts:114-131`
— `shopify`, `qbo`, `quickbooks`, `stripe`, `resend`, `sendgrid`, `postmark`, `mailgun`, `twilio`,
`plaid`, `square`, `paypal`, `xero`, `hubspot`, `salesforce`, `slack`) or lives under an
`integrations/` directory; a name match wins when both match. On merge, `status`/`why` fill only
where absent, so a hand-set `status` and an existing row's own `status` both survive re-detection.

**RCB-177 — evidence is lines, not a file.** A detected row's `source.detected` is
`<file>:L<n>` or `<file>:L<a>-L<b>` (the `path:L10-L20` ref grammar) where the value was located,
not `<file>@<key>`; the row's `pointers` — and, for a detected connection, its `pointers` (RCB-173)
— are that same range instead of the whole file. `locateEvidence` (`packages/core/src/systems-detect.ts`)
finds it: a token matches as a WHOLE word (`queue` is not `queues`), bare or quoted; a line that is
only a comment never matches; a path (`queues` → `producers` → the queue's name) is searched inside
each step, and a value must be what its id field (`queue`, `binding`, `bucket_name`, …) is SET TO,
so a `dead_letter_queue` mention is not the DLQ's own record. The range is: for wrangler
JSON/JSONC, the binding's record (the `{…}` that is an array element); for a `vars` entry, that one
line; for a compose service, its indented block; for `.env.example`/`.dev.vars`, the `KEY=` line;
for a drizzle `dialect` / prisma `provider`, that line; for wrangler TOML, the `binding =` /
`queue =` line under the exact `[table]` / `[[table]]` header. A range over `EVIDENCE_MAX_LINES`
(40) lines is the one line the value was found on. **Not located, so unchanged:** the worker row (the wrangler file
IS the worker), package.json rows, workflow rows and their connections. **A line is found or absent,
never guessed:** a value that cannot be located (an escaped name, unbalanced JSON, an inline TOML
table) keeps `<file>@<key>` and the whole-file pointer, and its connection gets no `pointers`.
`--apply` on an UPDATED detected connection replaces every `path:L…` range into a file the value
was just located in with the fresh range — a hand-added `:L` range into that same file too, since
a pointer carries no provenance and the two cannot be told apart — and keeps every other pointer
(a hand `path@Token`, `path#Heading`, another file's range); a hand row is never touched. Measured 2026-09-29 on a
scratch COPY of a member repo's config files (the repo itself untouched): 0 of its 22 `file@key`
evidence strings resolved as refs before; after `--apply`, all 57 `detected` and pointer specs of
its detected rows resolve, 50 of them with a line range, hand rows unchanged, a second `--apply`
byte-identical, `systems.yml` 9,727 B → 11,320 B (budget 16,384).

Table columns: `ID KIND LAYER ENV FROM`, then one `connections: <from>→<to> (<via>)` line per
connection, then an `unclassified:` block for anything a detector could not place, then a summary
line with the add/update/keep counts. Exit 0 on a clean dry run or a successful `--apply`; exit 1
on a parse or refusal error. `--json` prints the whole `DetectRun` (`files`, `candidates`, `plan`,
`applied`, `path`, `errors`). Measured read-only against a member repo (PH.5): 14 systems, 13
connections, 7 unclassified, ≈3 hand corrections; report 3,580 B.

### Surfaces over `.repoboard/systems.yml` (PH.3, RCB-97)

`repoboard systems [--json]` prints two `dev:`/`prod:` environment lines then the
`ID KIND LAYER ENV RUNTIME` table (file order, ≤80 B/row); no file: the one "no systems.yml yet"
line, exit 0; invalid: each parse error on stderr, exit 1. `repoboard systems show <id> [--json]`
prints one row plus its `pointers` resolved the way `card show --resolve` does; unknown id: exit
1. `--json` on either mirrors `store.systems()` (`{doc, errors, exists}`) / `{system,
connections, pointers}`.

`repoboard systems` (RCB-163) is display-only: a valid doc where some row's `unblocked_by` names a
card id that exists nowhere on this board or any member (`systems-unblocker-unknown`, `check`'s
own finding, packages/core/src/state.ts) still exits 0, but prints one `warning: <message>` line
per such id on stderr after the table (`--json`: the same messages as `warnings: string[]`,
always present, `[]` when none). The planned-without-unblocker kind stays `check`'s alone. No
doc, or an invalid one, computes no warnings.

**RCB-161 slices 1-2.** A system or connection row gains `status: 'live' | 'planned' | 'blocked'`
(`SYSTEM_STATUSES`, `packages/core/src/systems.ts:43`; absent on disk → `'live'`, `systems.ts:67`/
`:79`/`:316`/`:325`) and `unblocked_by: string[]` (YAML key, `systems.ts:132`/`:159`; absent →
`[]`). `formatSystemsTable` adds a `STATUS` column only when some row is not `live` — a file with
no `status:` keys prints byte-for-byte what it did before (`packages/core/src/systems-
surface.ts:143-153`). `repoboard systems show <id>` resolves every `unblocked_by` id under an
`unblocked by:` block: the id's card title and status, plus its open decision (question + lettered
options) or its first not-done, not-blocked step — never both — or `(not on this board)` for an id
naming no card here (`unblockerInfo`, `packages/core/src/systems-unblockers.ts`, shared verbatim
between the CLI and the Flow view). `check` gains two findings (`packages/core/src/state.ts:302-
478`): `systems-unblocker-unknown` (warning — an `unblocked_by` id naming no card of this board or
any workspace member) and `systems-planned-without-unblocker` (warning — a `planned`/`blocked` row
with an empty `unblocked_by`); both exit 1 only with `--strict`. The Flow view (§8) draws a `planned`/`blocked` box or edge dashed
with a status badge, and its drawer gets an "Unblocked by" section resolving each id the same way
`systems show` does.

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
| `repoboard systems show` of an external row (0 pointers) | 400 B |
| `repoboard systems detect` (dry run) | 621 B; `--json` 1,999 B |
| MCP `list_systems` schema / result | 620 B / 2,776 B |
| MCP `get_system` schema / result for `repoboard` / for an external row | 606 B / 37,366 B / 936 B |
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
(`--json` 36,049 → 37,477 B), `show` of an external row 400 → 564 B; 0.18 s wall for the repoboard
row (11 test files across 4 pointers; `repo-context.ts` has none that names it directly). The
literal-name half is broad by design: a fixture string naming `packages/server/src/cli.ts` in a
web test counts, and `packages/web/test/helpers.tsx` counts as a test file by its `test/` segment.
Coverage-report driven (B) is a later card with its own provenance.

## 8. Flow view (RCB-98)

A third top-level view, `Board | Map | Flow` (`View = 'board' | 'map' | 'flow'`, `TopBar.tsx`,
`App.tsx`), drawing `.repoboard/systems.yml` via core's pure `layoutSystems` (RCB-95) as inline
SVG — 0 KB added. States: no file → the `systemsSummary(null, []).line` note; invalid → each
parse error in a `<pre>`; else rows by `layer`, boxes per system, orthogonal edges (RCB-179: each edge meets a box side at its own point, the
k-th of n at `x + w*(k+1)/(n+1)` ordered by the far end's x; each horizontal run has its own track
in a row gap and each long vertical run its own lane in a column gap or right of the last column;
a row gap grows with its track count (RCB-192) so tracks are >= 0.125 units (8 px) apart; no route
enters a box that is not one of its ends). An env switch
(`dev | prod | both`, default `both`) redraws via `layoutSystems(doc, env)`; a `none` environment
shows its note in prose instead of a diagram. Clicking a box opens a drawer: the row's fields,
`pointers` resolved live (`GET /api/systems/:id/refs`, same resolver as `systems show`), and
backlinks — cards whose `refs:`/`files:` path equals or falls under a pointer — clicking one
selects the card and switches to Board.

### `systems.yml` connection fields, warnings and the connection refs route (RCB-173)

A connection row gains three OPTIONAL fields (`packages/core/src/systems.ts`, `Connection`):
`label` — a 1..40 character edge caption (`CONNECTION_LABEL_MAX`); `pointers` — code refs, the same
grammar as a system's `pointers` (`path`, `path#Heading`, `path@Token`, `path:L10-L20`) and the same
resolver (RCB-177: `path@Token` also finds a JSON/YAML key — a line whose first token is the token in
`"` or `'` quotes, optionally followed by `:`, so `wrangler.jsonc@triggers` finds `"triggers": {`; it
is tried only when no line starts with the token bare, and exact inside the quotes; a dotted token
is one token, not a key path, so `@triggers.crons` still finds nothing); `id` — `[a-z0-9-]+`. Absent on disk means absent in memory, and `serializeSystems` writes
none of them back when absent (an empty `pointers` is never written; key order `from`, `to`, `id`,
`label`, `via`, `env`, `pointers`, `status`, `unblocked_by`, `source`). A `systems detect --apply`
update of a DETECTED connection keeps its hand-added `id`/`label`/`pointers` (RCB-177: except that
the detector's fresh `path:L…` range replaces any `:L` range into that same file, hand-added or not, §7);
a hand connection is left untouched. A `(from, to)` pair is unique unless EVERY row of that pair has its own distinct
`id` — otherwise `parseSystems` reports `connections[<i>]: duplicate connection "<from>→<to>" (also
connections[<j>]) …` as an error. A detector candidate (which knows only from/to) matches the pair's
id-less row, else the pair's first row, so an apply never adds a second, id-less row to a pair.

Two warnings, both inert — the parse still succeeds (`parseSystems` returns `{ ok: true, doc,
warnings }`, `SystemsWarning`): `systems-unknown-key` names the mapping and the key — on a system
(`systems[2] (id "api")`), a connection (`connections[0] (web→api)`), a path entry (RCB-180,
`paths[1] (name "nightly")`), or the top level — instead of dropping it silently (note `systems
detect --apply` rewrites the file and WOULD drop it); `systems-over-budget` when the file is over `DEFAULT_SYSTEMS_BUDGET_BYTES`, now **16,384 B** (was
4,096 B; a member repo's file is 9,727 B; owner 2026-09-29) — counted in UTF-8 bytes, warned not enforced.
There is no `board.yml` override for it. Shape: `{ kind: 'systems-unknown-key', path, key, message }`
| `{ kind: 'systems-over-budget', bytes, budget, message }`. `repoboard systems` surfaces the
`message` strings in the RCB-163 channel — `warning: <message>` lines on stderr after the table,
`--json` `warnings: string[]` (file's own first, then the `systems-unblocker-unknown` ones), exit
code unchanged.

`GET /api/systems/connections/:from/:to/refs[?id=<id>]` resolves a connection's `pointers` live with
the same resolver as `GET /api/systems/:id/refs` (same wire entries; `[]` for a connection with no
pointers). 404 `{error: 'unknown connection "<from>→<to>"'}` (plus ` id "<id>"` when `?id=` matched
no row) for an unknown pair, an unknown id, or no valid `systems.yml`; a pair with several rows and no
`?id=` is 400 `connection "<from>→<to>" has <n> rows — pass ?id=<id>`, never a silent pick.

### `systems.yml` paths and the Flow summary strip (RCB-180)

An OPTIONAL top-level `paths:` list names a route through the map ("a request goes web → api → db").
Each entry is `{ name, hops, source }` (`packages/core/src/systems.ts`, `FlowPath`): `name` — 1..40
characters (`FLOW_PATH_NAME_MAX`), unique; `hops` — two or more system ids in travel order; `source` —
`{ hand | detected, at }`, shaped as a row's. Absent on disk (or `paths: []`) means `SystemsDoc.paths`
is absent in memory, and `serializeSystems` writes the key only when there is a path to write —
after `connections` and before `rejected`, entry keys `name`, `hops`, `source` — so a file without
one round-trips byte-identical. `systems detect --apply` carries `paths` through unchanged (a hand
record, like `rejected`). `paths` is a known top-level key, and `name`, `hops` and `source` are the
known keys of an entry; any other key in a `paths[<i>]` entry gets a `systems-unknown-key` warning
(path `paths[<i>]`, label `paths[<i>] (name "<n>")`), because `serializeSystems` writes only those
three and `systems detect --apply` would drop it.

`parseSystems` reports, per path in `paths:` order, each as an error (all collected, not first-only):
`paths[<i>] (name "<n>"): name must be 1-40 characters` · `duplicate name "<n>" (also paths[<j>])` ·
`needs at least 2 hops` · `hops[<k>] names unknown system "<id>"` · `hop <a>→<b> is not a connection`,
with ` (<b>→<a> is)` appended when only the reverse connection exists. A consecutive pair `hops[i]` →
`hops[i+1]` needs a connection row in that direction; a pair with parallel rows (RCB-173 ids) is
satisfied by any of them, and a connection in only one env still satisfies it (the parse does not
look at env; the view does). A pair with an unknown system is reported once, as unknown, not again
as "not a connection".

`flowOverview(doc, env)` (core, pure) answers `{ dataStores, externals, entryPoints }`, ids in
`systems:` file order, over exactly the systems `layoutSystems(doc, env)` draws: layer `data`; layer
`external`; and no drawn connection INTO it with at least one OUT of it, in that env (a connection
from a system to itself counts as neither; a system with no connection is not an entry point). A
`none` environment draws nothing, so all three are `[]`.

The Flow view shows it as a strip under the toolbar: `Data stores (n)`, `Externals (n)`,
`Entry points (n)`, each id a button that selects that box exactly as clicking it does (drawer, focus,
`?system=`), an empty group reading `none`; no strip where there is no diagram (no file, an invalid
file, a `none` environment). A doc with `paths:` also gets a toolbar `Paths` select (absent
otherwise): `none`, then each path by name. Choosing one starts step 1 of `hops.length - 1`; Prev /
Next step it (Prev off at step 1, Next off at the last); the current step's edge(s) — every parallel
row of the pair — and its two boxes are lit (accent stroke) and everything else dims, the same
dimming as a focus and taking precedence over one while the walk runs; each step pans, minimally,
to show its two boxes and edge(s). Esc on the canvas, the select or a step button ends the walk (the
next Esc on the canvas clears a focus, as before), as does choosing `none`. A path whose hop is not
drawn in the env on show is listed disabled as `<name> (not in <env>)`; switching env to one that
does not draw the walked path ends the walk (it does not resume on the way back), and a live edit
that shortens the walked path clamps the step to its new last one (a removed path ends the walk).

### Flow drawers: how to get there (RCB-178)

Two routes beside `GET /api/systems/:id/refs`, both per served root (`/api/repos/<key>/…` scopes
them like every other route):

`GET /api/systems/:id/docs` resolves the system's `docs[]` through the same `resolveRefSpec` —
`path#Heading` is a ref spec — and answers the same wire as `/refs`: one `ResolvedRef` per entry, in
order (`{spec, path, start, end, text, truncated, error}`). An entry that does not resolve keeps its
own `error` with `text`/`start`/`end` `null`, never a guess. 404 `{error: 'unknown system "<id>"'}`
for an unknown id or no valid `systems.yml`, same as `/refs`.

`GET /api/git` answers `{root, web, head}`, always 200, read live on every call (nothing memoised;
three `git` spawns, cwd = the root). `root` is the served root, absolute. `head` is
`git rev-parse HEAD`, `null` with no git or no commit yet. `web` is `origin` as a GitHub https base —
`git@github.com:o/r(.git)`, `https://github.com/o/r(.git)` and `ssh://git@github.com/o/r.git` all
become `https://github.com/o/r` (`githubWebBase`, pure; embedded credentials never reach the
answer) — and `null` for no remote, no git, any other host, a path that is not exactly `<owner>/<repo>`,
or a root that is a subdirectory of the git repo (a blob URL would lack the subdirectory prefix). A
git failure is a `null` field, never an error. The Flow drawers fetch it on every open (skipped when
the drawer has no pointers and no docs) and hang two links on each RESOLVED ref's head line:
editor `vscode://file<root>/<path>:<start>` (no `:<start>` for a whole file; segments URI-encoded) and
GitHub `<web>/blob/<head>/<path>#L<start>-L<end>` (`#L<n>` for one line, no anchor for a whole file).
An errored ref has no links; with `web` or `head` `null` there is no GitHub link. A whole file is a
ref whose spec is just its path. A runtime value in the system drawer has a copy button
(`navigator.clipboard.writeText`); a refused or missing clipboard shows `copy failed`.

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
