# Proposal — a cheaper builder cold start (2026-09-18, repoboard builder, for the owner)

**Status: proposal. Nothing here is done.** Written by the fresh builder seat right after its own
cold start on 2026-09-18 21:53Z, from what that start actually cost; the coordinator puts it in
front of the owner. Each item names the measurement that motivated it, what would change, and
what it must NOT change. Items are independent; pick any subset. Product changes (§B) are
candidates for cards; doc/state changes (§A) are one commit each.

## What this cold start cost — measured

| Step | Input | Bytes | ≈tok | Verdict |
|---|---|---|---|---|
| CLAUDE.md routing | `CLAUDE.md` | 5,523 | 1.4k | needed |
| CLAUDE.md sends a cold orchestrator to | `docs/NEXT-AGENT-PROMPT.md` | 4,182 | 1.0k | **stale** — dated 2026-09-07, cites HANDOFF §12.0l; says `card update` does not exist (it has since §12.0n), queues K9/RCB-31 (done), describes a Review column that is gone |
| …and to HANDOFF §12's highest letter | `docs/HANDOFF.md` | 23,350 | 5.8k | §12 ends at §12.0n (2026-09-07); eleven days of work since live only in `.repoboard/` |
| the live one | root `NEXT-AGENT-PROMPT.md` (8 lines) | 688 | 0.2k | correct, but CLAUDE.md does not point at it |
| what actually worked | `repoboard seat builder` | 3,482 | 0.9k | needed — this is the cold start |
| `repoboard cost` first-order total | 6 files | 140,251 | 35k | a builder needs ~5k of it |

Numbers: `wc -c`, `repoboard cost` on e40d5c1. Then four questions had to go to the coordinator
before the first command; three were answerable from a doc that does not exist (§A4): the seat
name to pass to `--as` (`builder` — the stale prompt says `claude/<role>`), whether an fpj gate
window was live, which of the two `builder` sessions on this machine was mine, and who restarts
:4243.

Contradictions a cold reader had to resolve by hand:
- `STATE.md` §LIVE still says "Builder seat: RCB-50 in doing, then STAND DOWN; fresh builder's
  queue RCB-47 → RCB-52 → …" while §SEATS says RCB-54 first — two queues in one file, five
  landings apart.
- `seat builder` printed **Next card: RCB-34** ("first todo; nothing assigned") while the SEATS
  line said **RCB-54** first. RCB-54 was `priority: high`, in `todo`, created later; `nextCard`
  takes list order and ignores priority. The prose was right and the tool was wrong.
- The SEATS builder bullet is 1,565 characters and mixes four kinds of content: the stand-down
  record (already in the log block it points at), the cold-start command (belongs in CLAUDE.md),
  the queue (belongs on the board), and rig facts (lock protocol, ports, subagent policy — stable
  for days, restated on every restamp).
- `repoboard check` went red (`stale-state`) the moment the builder logged its stand-up, and
  stays red until the coordinator restamps, because the builder terminal's classifier blocks
  `state --set-section`. Every builder start therefore produces one red `check` by design.

## A. Doc and state cleanup — no code, one commit each

**A1. Retire `docs/NEXT-AGENT-PROMPT.md` and HANDOFF §12 as cold-start inputs.** Delete the
docs/ prompt (the root 8-liner is the live one). Append a final HANDOFF §12.0o that says, in one
line, "superseded 2026-09-18: the running record is `.repoboard/` (STATE.md, log/, the board);
this section is closed" — so no one appends to it or trusts its tail. HANDOFF §1 and §7 stay;
§7 lessons are still read.
*Must not change:* nothing in `.repoboard/`; the plan.

**A2. Re-route CLAUDE.md's "Picking this up cold" paragraph** to: `pnpm build && node
packages/server/dist/cli.js seat <name>` first, then the card it names, then the most recent
`docs/*-BRIEF.md` for the pattern, then plan §11 only if the card points at a decision. Say
explicitly that a builder does not read the plan or HANDOFF §1 unless a card sends it there.
Keep CLAUDE.md under its 8,192-byte budget (5,523 today; the paragraph gets shorter, not longer).

**A3. Rewrite STATE.md §LIVE to hold only slow-changing facts** — ports and which repo each
serves, the public remote, the owner lane, the sibling — and never a queue or a per-landing
status. The queue is the board; landings are §LAST LANDINGS; seat status is §SEATS. One-time
rewrite by the coordinator, then a rule in `docs/AGENTS.md` §10.

**A4. One `docs/RIG.md` for the rig facts, written once.** The vitest lock protocol (path,
owner-line format — two formats are in use today — take/release rules, "never rm a foreign
lock"), the port map (:4242 this root, :4243 fpj root served by this repo's dist, :5173/:8787
never), the restart rule (rebuild + restart both after a `packages/web` landing; look at :4243),
the seat names and their `--as` values, the cross-session names on this machine (`repoboard
builder`, `coordinator`, fpj's `builder`/`Ops`) and who talks to whom, the subagent policy
(sonnet, written brief, never commits), the gate (targeted vitest while building, full suite
once at landing, `check` at start and stop). SEATS bullets then shrink to status + pointer, and
the coordinator stops restamping 1.5 KB of rig prose.
*Answers three of the four questions above without a round-trip.*

**A5. SEATS bullet shape rule: ≤ 3 lines** — `UP/DOWN <stamp>`, what it holds (lease + card),
where its last block is. Anything else goes in the log block. Enforce by convention first; a
`check` finding (`seats-bullet-over-budget`) is a §B candidate if convention fails.

## B. Product changes — candidates for cards, in the order the builder would take them

**B1. `seat` `nextCard` honours priority.** Today: first `todo` in list order with no assignee.
Proposed: `todo`, unassigned, ordered `high` → `medium` → `low` → unset, then list order — and
print WHY it chose it (`first high-priority todo`). Pure change in `packages/core/src/seat.ts`
plus one table row in AGENTS §10. Small; it would have made the prose queue in SEATS redundant
today. Control: a fixture with a low-priority older todo and a high-priority newer one.

**B2. A seat may restamp its own SEATS bullet without rewriting the section.**
`repoboard seat <name> --up "<text>"` / `--down "<text>"` (or `state --seat <name> <text>`):
replaces only that seat's bullet in §SEATS, restamps the header, appends nothing else. Blast
radius is one bullet, which is the argument for the classifier letting it through where the
whole-section rewrite is blocked; if it is still blocked, the coordinator's routine is unchanged
and nothing is lost. Also lets `check` stop being red after every builder stand-up (the block and
the bullet land together).

**B3. `check`: `stale-state` should compare against the newest log block from a seat OTHER than
the one that most recently restamped, or accept a same-seat log block that names the stamp** —
whichever is simpler to state. Today a seat that logs and then restamps in that order is fine,
but the builder cannot restamp (see B2), so every builder log block is a finding. Alternative:
land B2 and leave `check` alone. B2 first; revisit B3 only if red `check` persists.

**B4. `seat` warns when `dist/` is behind `src/`.** Cold agents are told "`pnpm build` first"
because a stale dist silently runs old code (the RCB-53/54 gap was found this way). `seat` can
compare `packages/*/dist` mtimes to the newest `src` mtime and print one line: `dist is older
than src — run pnpm build`. Read-only, no new dependency.

**B5. A lock shim in `scripts/`.** `scripts/vitest-lock.sh take|release|status` implementing the
protocol in RIG.md (mkdir, owner line `"<pid> <cwd> <ISO> <session>"`, release only when the pid
is ours, `window check` consulted first — the CLI already says that is "what a lock shim calls").
"One function per guarantee": the protocol lives in one script instead of in three briefs with
two formats.

**B6. RCB-54 follow-ups (landed 713d330; its out-of-scope list):**
`lastBlockFor` matches the seat token exactly, so `seat builder` cannot find a sibling block
headed `BUILDER (fresh, f87be1)`; `GET /api/log` (the web timeline) still reads `.repoboard/log/`
only, so the LOG panel on :4243 never shows fpj's `docs/log`; the web's `relTime` gets
`Invalid Date` for the sibling's `YYYY-MM-DD HH:MxZ` stamps.

## What this does not propose

- No change to the column set, the plan's decisions, or anything under §11 without the owner.
- No change to `.repoboard/log/` being append-only or to `repoboard log` writing only there.
- No rewrite of HANDOFF §1/§7 or the plan; they stay as the history and the contract.
- Not "make the cost tool smaller": `repoboard cost` is measuring correctly; the fix is to stop
  routing a builder through 35k tokens it does not need.

## Suggested order

A1 + A2 (one commit, coordinator or builder) → A4 (builder writes, coordinator reviews) → A3 +
A5 (coordinator, next restamp) → B1 → B2 → B4 → B5 → B6 as cards. A1–A5 remove more cold-start
cost than all of §B; §B stops it coming back.
