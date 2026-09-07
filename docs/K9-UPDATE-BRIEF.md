# Brief — K9: `repoboard card update <id>` (2026-09-07)

Owner decision **O8** (plan §11), taken 2026-09-07: of the two shapes RCB-31 offered, the owner
picked **`card update <id>`**, not `--assign` on `card move`.

K9 is the most-hit bug in this project's history that never got a ticket. HANDOFF §7.9 asked for
it on 2026-09-03. On 2026-09-06 all three agents were briefed to run `card update --assignee`, all
three hit `unknown card command "update"`, and all three hand-edited YAML frontmatter instead. The
orchestrator's own K-cleanup brief still contains the instruction to run a command that does not
exist. **You are deleting a class of wasted agent turns, not adding a convenience.**

Baseline on `main` @ `706fdb6`, measured by the orchestrator 2026-09-07: **242 tests, 23 files;
`pnpm typecheck` exit 0; `biome check .` exit 0 on 89 files; web bundle 135.7 KB gzipped**
(limit 600 KB). Every number you report is a delta against those.

Card: **RCB-31**, in `todo`.

---

## Rules (CLAUDE.md; HANDOFF §0, §7)

- **You do not commit.** Leave the tree dirty; the orchestrator verifies and commits.
- **Port 4242 is held by the orchestrator** (CLAUDE.md non-negotiable 2). Use a high port of your
  own for anything you start and shut it down before you finish. Disclose any `pnpm build`.
- **Every save must parse** — the tree hot-reloads into the owner's browser.
- Move your card when you start:
  `node packages/server/dist/cli.js card move RCB-31 doing --as claude/cli-agent`.
  Leave it in `doing`; the orchestrator moves it on. Yes — the command you are building is the one
  you would otherwise want here. Set `assignee` by hand this one last time.
- Run `biome check --write <your files>` before reporting (§7.6).
- **Claims carry numbers.** If you did not measure it, say so in those words.
- **Every protective test is verified the CLAUDE.md way**: perturb, **read the file back** to
  confirm it landed, confirm it still **typechecks**, confirm the test **fails in the direction
  you fear**, then restore with a targeted edit — never `git checkout`. Paste the failing output.

---

## The design is already settled — by code that exists, not by this brief

`updateCard` in `packages/core/src/transitions.ts:146` is the authority, and MCP `update_card`
(`mcp.ts:238`) and `PATCH /api/cards/:id` (`http.ts:536`) already speak it. **Your job is to make
the CLI the third surface with the same meaning, not to design a fourth.** Re-derive each of these
before you build on it (§7.13):

- `undefined` = leave alone, `null` = clear, a value = **set**. (`applyOptional`, transitions.ts:181)
- A list is **replaced wholesale**, never appended to (`patch.labels?.slice()`, :166-168).
- `status` is refused: `'updateCard cannot change status; use moveCard'` (:147-149).
- An empty patch is refused: `'patch is empty'` (:158-160).
- It bumps `updated` and appends a `## Log` line reading `updated <changed keys>` (:171-174).

**Settled — do not redesign:**

1. **Flags:** `--title`, `--assignee`, `--priority`, `--label` (repeatable), `--file`
   (repeatable), `--ref` (repeatable), `--as`. The repeatable three mirror `cmdAdd`
   (`cli.ts:186-189`) — parse them the same way.
2. **A repeatable flag REPLACES the list.** `--label a --label b` sets exactly `[a, b]`. This will
   feel wrong to you; it is what the other two surfaces do, and a CLI that appends where MCP
   replaces is a worse bug than the one you are fixing. The help text must say "replaces".
3. **Clearing is `--clear <field>`, repeatable.** Valid fields: `assignee`, `priority`, `labels`,
   `files`, `refs`. This is **the only new concept in the change** — MCP and HTTP carry `null` in
   JSON and a shell flag cannot. Rejected alternative, for the record: `--assignee ""`, because it
   cannot express clearing a list and it silently conflates "set to empty" with "clear".
   `--clear title` is an error (core forbids an empty title).
4. **`--status` is rejected by the CLI with a message naming `card move`**, before the store is
   touched. Core would refuse it anyway; a user who typed it deserves the pointer, not
   `unknown option`.
5. **Output is one terse line** in house style, naming what changed:
   `updated RCB-31 assignee, priority`. Match the log line's field list.
6. **Update `HELP`** (`cli.ts:55-63`) — the `card update` line sits with `add`/`move`/`list`/`show`.

## Docs are part of this task, not a follow-up

- **`docs/AGENTS.md`** currently tells agents the CLI has no way to set these and to edit
  frontmatter. That instruction is the bug. Rewrite the relevant part so `card update` is the
  documented path, and check the §"move its card" paragraph at `AGENTS.md:178` too.
- **`README.md` Known issues:** strike K9 through with the closure note, per the K1/K6/K7/K8/K10
  convention, and say `Closes K9` in nothing — the orchestrator writes the commit.
- **One drift to fix while you are in there:** `mcp.ts:242-244` describes `update_card` as
  changing "title, assignee, priority, labels and/or files" — it omits `refs`, which its own
  schema has taken since K7. Fix the prose.

## DoD

- `card update <id> --assignee x` sets it, on a card created without one. This is K9's actual
  complaint; test it as such.
- Each of title, assignee, priority, labels, files, refs settable; each of the five clearable.
- `--label a --label b` replaces rather than appends — asserted against a card that already has
  labels.
- `--status doing` errors and names `card move`. No flags at all errors.
- **On the BUILT binary, not just vitest** (§7.15): `pnpm build`, then run the real command
  against a fixture repo you created. That is what agents actually invoke.
- **The K8 property still holds:** one `card update` against a repo with `serve` running puts
  **exactly one** line in `events.jsonl`, not two. Measure the line count before and after. This
  is a new mutating CLI path through the machinery K8 fixed and K10 guarded; nothing else will
  catch a regression there.

## Controls — three, each verified by content

1. **Replace-not-append:** make `--label` append to the existing list. Read back, typecheck,
   confirm the replace test fails.
2. **Clearing:** make `--clear assignee` a no-op. Read back, typecheck, confirm the clear test
   fails **with the old value still on the card**, not merely with a thrown error.
3. **The status guard:** remove the `--status` rejection. Read back, typecheck, confirm the test
   fails — and report **which layer caught it**, the CLI's message or core's. If core catches it,
   say so; that is a real finding about where the guarantee actually lives.

## Report back

- The five re-derived facts above: did each hold? Quote what you ran.
- Test delta against 242, typecheck, biome, and bundle only if you touched `packages/web/`.
- All three controls: perturbation, proof it landed, that it typechecked, the failing output.
- The built-binary run and the `events.jsonl` before/after counts.
- Anything in the "settled" list that turned out to be wrong. The last two rounds each found an
  error in the orchestrator's brief and both were worth more than the feature — say it plainly.
