# RCB-80 — Systems flow: the plan (proposal, 2026-09-22)

**Status: a proposal.** Nothing in this page is built. The owner's decisions are collected in §7
and asked on card RCB-80; the plan lands in `docs/BUILD-PLAN.md` as phase P9 only when they are
answered. Numbers below are measured on `main` at `9ee8857` unless a line says otherwise.

## §0 What it is, and for whom

A repo has systems (a worker, a database, a queue, a mail provider, a CI runner) and connections
between them, and it has them differently in development and in production. Today repoboard shows
files (the Map: treemap, import graph, churn, who-is-where) and work (the Board). It shows nothing
at the level a person actually reasons about first: *what runs, where, talking to what*.

Two readers, one file:

1. **A cold agent.** It needs to know where the edges of the system are before it greps. Today it
   gets that by reading `CLAUDE.md`, the plan, and whatever docs the repo happens to have — on
   freshpickedjobs that was a 32,620 B `CLAUDE.md` before anyone measured it (P8.4). A systems file
   with **pointers** (paths, not prose) is a token-budgeted map of the architecture that the cold
   read can load in one shot and follow selectively.
2. **A human.** They need the picture: rows of layers, boxes for systems, lines for connections,
   a DEV/PROD switch, and an honest note when one of the two does not exist (repoboard itself:
   local-only by design, for speed and tokens).

The thesis holds as it does for cards (plan §0.3): **a plain file under `.repoboard/` that `sed`
can edit, written through core by every surface, rendered by the dashboard, its bytes measured.**

## §1 What exists today (measured 2026-09-22, pointers into the tree)

| Fact | Where |
|---|---|
| Two top-level views, `board` and `map`; a plain union + ternary, no router | `packages/web/src/store.ts:33`, `App.tsx:72`, `TopBar.tsx:92-104` |
| Map = treemap (`d3-hierarchy`) + import graph (`d3-force`), churn modes, who-is-where via card `refs:` | `packages/web/src/views/{Map,Treemap,Graph}.tsx`, `map/model.ts` (pure, 478 lines) |
| No diagram library in the bundle; gzipped JS 145.4 KB against a 600 KB gate | `packages/web/scripts/check-size.mjs` |
| Scanner reads files, languages, git churn, JS/TS import edges — nothing else | `packages/server/src/scanner.ts:393` |
| Nothing reads `package.json` scripts, `wrangler.*`, Dockerfiles, compose, CI, `.env.example` | grep, 0 hits outside comments |
| The one config-reading precedent: `cost` reads `CLAUDE.md`, `AGENTS.md`, `.mcp.json` | `packages/server/src/cost.ts` |
| Path-escape guard every file reader must reuse | `packages/server/src/refs.ts` `resolveRepoPath` |
| `refs:` = the pointer primitive (`path#Heading`, `path@Token`, `path:L10-L20`), rendered live | `packages/core/src/refs.ts`, AGENTS §4 |
| Cold-start bundle: `repoboard seat <name>`; cost budget: `repoboard cost` | `packages/core/src/seat.ts`, `cost.ts` |
| Wire convention: additive optional fields, absent means nothing | `packages/web/src/wire.ts:48-58` |
| Card plan fields exist (`parent`, `phase`, `gate`, rollup, lanes) — **used by 0 cards today** | RCB-68; `grep -l '^parent:' .repoboard/cards/*.md` → 0 |
| 58 test files, 1,029 `it` blocks (core 405, server 427, web 197) | one `test/` per package |

freshpickedjobs, read-only, as the rich detection target: a Worker (`wrangler.jsonc` `main`),
Hyperdrive → Postgres (local `:5433` in dev), R2, two Durable Objects, a service binding to a
second worker (`hasher`, Rust), Resend and better-auth via `vars`, Vite web on `:5173`, GitHub CI
that runs `db:migrate` then `pnpm test`. No `.env.example`, no Dockerfile, no compose.

## §2 Concepts borrowed, tools not adopted

We use none of these tools. We take the concept that earned each one its users, and we leave what
contradicts plan §0 (local-first, plain files, no LLM in the path, no dependency over 200 KB).

| Source | The concept we take | What we leave |
|---|---|---|
| **C4 model / Structurizr** | *One model, many views.* Context → container → component; the **container** level is exactly this card. Views are filters over one model, so DEV and PROD are two views of one `systems.yml`, not two files. | The DSL, the workspace server, the diagram-as-code toolchain. |
| **arc42** | §5 building-block view and §7 **deployment view** are separate questions with the same blocks. Our `env` field is the deployment view. | The 12-section template. |
| **Backstage `catalog-info.yaml`** | Entity kinds (`System`, `Component`, `Resource`, `API`), `dependsOn`/`providesApis` edges, **owner** per entity, annotations, and *processors* that discover entities from the tree. Our `kind`, `connections`, `owner`, `source`. | The catalog service, plugins, a portal. |
| **beads** (git-native issue graph for agents) | Explicit **dependency edges** with a computed "ready" set; hash ids that merge; **compaction** of old records; an agent-first CLI that prints tersely. We already have cards, `gate`, `blocked`; we take *systems as a graph with computed state* and terse CLI output. | JSONL as the store (our cards are markdown, D1), a daemon, any sync. |
| **Obsidian** | **Wikilinks + backlinks + Maps of Content**: a note that is only pointers is a valid, valuable note. Our systems file is an MOC for the repo; each system's `pointers:` are its links; the drawer shows backlinks (cards that reference the system). Daily notes = our log. | The vault, plugins, graph view of prose. |
| **aider repo-map** | A **token-budgeted** map: rank what matters, cut to fit. Our file has a byte target and `cost` counts it. | tree-sitter symbol ranking (out of scope; the Map's import graph is the file-level cousin). |
| **`llms.txt` / `AGENTS.md`** | One curated entry file for machines, small, with links out. `systems.yml` is that for architecture; `AGENTS.md` §-new says so in one paragraph. | A second prose file. |
| **Cline memory bank / progressive disclosure** | Load the index, follow pointers on demand (already K7's "point, don't paste"). | Hierarchies of prose memory files the agent rewrites. |
| **Mermaid / D2 / Graphviz** | Layered (Sugiyama-style) layout by rank is the right shape for a flow diagram. | The libraries (Mermaid ≈ 1 MB+, elkjs ≈ 1 MB, dagre ≈ 100 KB unmaintained); we lay out in core, pure, tested. |
| **Terraform `graph`, `wrangler`, compose** | The deploy config IS the production model; read it, do not restate it. | Any cloud API call. |
| **ADRs** | A decision is a record with a date and a why. Ours already exists: `decision:` on a card. Systems rows carry `why:` optionally. | A separate `adr/` directory. |

## §3 Design

### 3.1 One model: `.repoboard/systems.yml`

```yaml
environments:                     # both keys always present; a null note = "no story", and the
  dev:  { note: "wrangler dev :8787 + local postgres :5433" }
  prod: { note: "Cloudflare Workers; Neon via Hyperdrive" }
  # repoboard itself:  prod: { none: "local-only by design — speed and tokens" }
systems:
  - id: worker                      # [a-z0-9-]+, unique, the edge endpoint
    name: freshpickedjobs worker
    kind: service                   # client | service | worker | job | db | cache | queue | storage | auth | email | ci | external | tool
    layer: app                      # client | edge | app | data | external | ops  — the diagram's row
    env: [dev, prod]                # which views show it; one entry = drawn dashed in "both"
    runtime: { dev: "wrangler dev", prod: "Cloudflare Workers" }
    owner: null                     # a seat or a person; null when nobody said
    pointers: ["apps/worker/src/index.ts", "wrangler.jsonc@main"]   # refs syntax (K7), resolved live
    docs: ["docs/BUILD-PLAN.md#§3"]
    why: null                       # optional one line
    source: { detected: "wrangler.jsonc", at: "2026-09-22T04:00:00Z" }   # or { hand: "<actor>", at }
connections:
  - from: worker
    to: postgres
    via: "Hyperdrive binding HYPERDRIVE"
    env: [dev, prod]
    source: { detected: "wrangler.jsonc@hyperdrive", at: "…" }
```

Rules, each one function in core with a test:
- **Provenance on every row** (`source`), hand or detected — CLAUDE.md conventions.
- **A missing answer is `null`**, never a guessed runtime or owner.
- **Unconfigured is inert**: no file → the view says "no systems.yml yet; `repoboard systems
  detect` proposes one"; the CLI prints one line; `check` says nothing. An empty `systems:` list
  is valid and renders the environments' notes alone.
- An `env` list of one entry is the *one-of-two* case the card names. A `prod: { none: "…" }`
  environment is the *no-story* case; the view prints the note in place of the diagram.
- Parser + validator are pure (`packages/core/src/systems.ts`): unknown `kind`/`layer` are
  errors with the row named; a dangling connection endpoint is an error; ids unique.
- **Byte target 4,096 B** for the file on this repo, measured by `cost` (which learns to count
  it); a repo may raise it in `board.yml` like `claudeMdBudgetBytes`.
- Shapes landed in `packages/core/src/systems.ts` (RCB-95).

### 3.2 Truth: hand rows plus detection with provenance (answers Q1)

Detection **proposes**; the file **is** the truth. `repoboard systems detect` dry-runs by default
and prints a table of candidates with the file each came from; `--apply` merges: a detected row
never overwrites a hand row with the same id, never deletes anything, and stamps `source`. A
detected row whose source file no longer yields it is reported by `check` as `systems-stale`
(warning grade). Non-negotiable 5 as written.

Detectors, each a pure function `(text) → candidates` in core with an I/O shell in server that
reuses `resolveRepoPath`, first set, in the order they pay off on the two target repos:

| File | Yields |
|---|---|
| `package.json` (+ workspaces) | one `tool`/`client`/`service` per workspace package; `scripts.dev/build/deploy` as runtime hints |
| `wrangler.toml` / `wrangler.jsonc` | the worker; `hyperdrive`/`d1`/`kv_namespaces`/`r2_buckets`/`queues`/`durable_objects`/`services` as systems + connections; `vars` keys matching `*_API_KEY` → `external` systems named by the key's stem, runtime `null` |
| `docker-compose*.yml` | one system per service, `depends_on` as connections, ports as dev runtime |
| `Dockerfile` | runtime hint for the containing package |
| `.github/workflows/*.yml` | one `ci` system per workflow; `run:` lines matching deploy/migrate as connections to the systems they name |
| `.env.example`, `.dev.vars` | `external` candidates by key stem, always `runtime: null` |
| `vite.config.*`, `drizzle.config.*`, `prisma/schema.prisma` | client dev port; the db system |

What a detector cannot classify it lists under "unclassified", never guesses.

### 3.3 The agent surface (cold start, pointers, cost)

- `repoboard systems` — one line per system: `id  kind  layer  env  runtime(dev→prod)`, ≤ 80 B a
  row. `repoboard systems show <id>` prints the row plus its `pointers` resolved the way
  `card show --resolve` does. `--json` mirrors the MCP shape. `systems detect [--apply]` as above.
- MCP `list_systems`, `get_system`; HTTP `GET /api/systems`; WS `snapshot` gains an optional
  `systems` field and a `systems` message on file change (the watcher already exists).
- `repoboard seat <name>` gains **one line**: `Systems: <n> systems, <m> connections, dev+prod |
  dev only | prod none — repoboard systems`. A pointer, not the table (O3: standing cost).
- `cost` counts `systems.yml` in the cold read; `check` gains `systems-stale` and
  `systems-invalid` (the latter error grade: a file that will not parse is worse than none).
- `AGENTS.md` gains one paragraph and the §7 paste gains one line. Bytes re-measured and put in
  the O3 table.

### 3.4 The human surface: the Flow view (answers Q2, Q3)

- **A third top-level view, `flow`**, beside Board and Map — the Map is per-file, this is
  per-system; a tab inside Map would bury the one picture a newcomer wants first. Cost: one union
  member, one button, one branch (§1). Map-only mode (no `.repoboard/`) shows Flow with the
  "no systems.yml" note.
- **Layout in core, pure, no library.** Rows = `layer` in fixed order (client, edge, app, data,
  external, ops); within a row, order by a stable topological pass over connections, ties by id.
  Output is boxes and orthogonal edge paths in abstract units; the web scales to the SVG. Tested
  on a hand fixture and on the two dogfood files. 0 KB added to the bundle; the 600 KB gate
  stays untouched.
- **Env switch: `dev | prod | both`**, default `both`. A system present in one env is drawn
  dashed with an `env` tag; a connection likewise. When an environment is `none`, its button
  reads the note and the diagram for that env is replaced by the note in prose.
- **Click a system → the drawer**: the row, its `pointers` resolved live (the refs engine),
  backlinks = cards whose `refs:`/`files:` fall under any of its pointers (system-level
  who-is-where; the Map's file-level highlight already computes the file set), its `source`.
- Fun stays off here by default (D9: readability wins ties on a diagram).

### 3.5 What is out of scope for the first landing

Auto-layout of arbitrary graphs (we have rows), non-JS symbol ranking, cloud API calls of any
kind, a runtime network check of any system, editing the diagram by drag (edit the file), and
Kubernetes/Helm/Terraform detectors (a second set once the first six prove the shape).

## §4 The plan as cards — and the experiment on the plan itself

This card is the first real use of RCB-68's `parent`/`phase`/`gate` fields (0 cards use them
today). So the plan is written **as cards first**, and how it reads cold on the board is itself a
deliverable (owner, 2026-09-22): *see how plans come across fresh in repoboard, and how the work
is displayed.*

Steps (all `parent: RCB-80`, `refs:` into this page, backlog until PH.0 clears):

| Phase | Card | Size | Gate |
|---|---|---|---|
| PH.0 | Owner decisions Q1–Q4 + budget answered on RCB-80 | S | RCB-80 (its decision) |
| PH.1 | `systems.yml` schema, parser, validator, layout — core, pure; plan §2 and §4 gain the shapes. Shapes landed in `packages/core/src/systems.ts` (RCB-95). | M | PH.0 |
| PH.2 | Detectors + `systems detect [--apply]`, dry-run default, provenance stamped. Landed (RCB-96). | L | PH.1 |
| PH.3 | Surfaces: CLI/MCP/HTTP/WS, `seat` line, `cost` counts it, `check` findings. Landed (RCB-97). | M | PH.1 |
| PH.4 | Flow view: rows, env switch, one-env dashes, none-note, drawer with pointers + backlinks | L | PH.3 |
| PH.5 | Dogfood: repoboard's own `systems.yml` (hand + detect); a read-only detect report on freshpickedjobs handed to the owner, nothing written there | M | PH.2, PH.4 |
| PH.6 | Docs and bytes: AGENTS, REFERENCE, README; O3 table re-measured with the new line | S | PH.5 |
| PH.7 | Plan-on-the-board findings: every gap a cold reader hit becomes its own card (label `plan-ux`) | S each | none |

**The experiment (PH.7 runs from day one).** Before any code, a fresh seat cold-starts on this
board with only `repoboard seat <name>` and the Board tab, and records — as numbers — what it
took to understand RCB-80:

1. Bytes of the cold read: `repoboard seat` output, then `card show RCB-80 --resolve`, then the
   step cards' `card list --json` rows. Compare with reading this page raw.
2. On the Board: does the RCB-80 lane appear in every column its steps sit in, does the rollup
   read `n/8 done`, and is the step ORDER (PH.1 before PH.2) visible anywhere without opening
   each card? (Hypothesis: no — a phase order across columns has no rendering today.)
3. In the drawer: do `refs:` into this page's `§3.1` heading resolve to the schema block, and how
   many clicks from the board to the schema?
4. Does `gate: PH.0` — a sentence, not a card id — show as blocked with the reason, and does
   clearing RCB-80's decision clear the id-gated steps automatically (RCB-68's rule)?
5. `repoboard check`: does a parent in `backlog` with steps in `todo` raise anything? Should it?

Each answer that is "no" or "unclear" is one `plan-ux` card with the measurement in its body.
Candidates already visible from the code: a **plan view** (parent card → its steps in phase order
with gate state, one screen), `card list --parent <id>`, `seat` printing a step's parent title
next to the next card, and the drawer showing a parent's step list. None are built until the
measurement says the gap is real.

## §5 Measurements before and while building

- Bundle: 145.4 KB gzipped today; the Flow view's delta, measured by `check:size`, target ≤ 15 KB.
- `systems.yml` bytes on repoboard and on the fpj detect report; `cost` before and after.
- Detect on freshpickedjobs: candidates found / unclassified / hand corrections needed — the
  three numbers that say whether detection is worth its code.
- `seat` bundle bytes before and after the one line.
- Layout: time to lay out the fpj model (target < 5 ms, pure function, measured in a test).
- PH.7: the five numbers in §4.

## §6 Gates for every step

The rig's gate per landing (`.repoboard/local/RIG.md`): targeted vitest while building, full
`pnpm test` ×2 under the lock at landing, typecheck 0, lint 0, build 0, one commit per card with
the numbers, `check` at start and stop, restart `:4242` after any `packages/web` landing and look
at `?repo=freshpickedjobs`. Each web step's brief names a control that must FAIL with the
rendering removed.

## §7 Owner decisions (asked on RCB-80)

| # | Question | Recommendation | Why |
|---|---|---|---|
| Q1 | Source of truth | **Detection proposes, the file is truth; hand rows win, nothing deleted** | Provenance and reversibility conventions; detection alone guesses, hand alone rots |
| Q2 | Diagram engine | **Own layout in core, inline SVG** | 0 KB, pure, testable; Mermaid/elk each ≈ 1 MB against a 600 KB gate and plan §0.6 |
| Q3 | Where it lives | **Third top-level view `flow`** | Per-system, not per-file; the first picture a newcomer wants |
| Q4 | First target | **Both, in this order: repoboard (the none-prod case) then freshpickedjobs (the rich case, read-only)** | Each exercises a branch the other cannot |
| Q5 | Byte budget for `systems.yml` | **4,096 B default, `board.yml` override** | Half the CLAUDE.md budget; a map, not a manual |
| Q6 | Run the PH.7 experiment before PH.1 | **Yes** | It is the owner's stated interest and costs one cold start |

Choosing **A** on the card takes every recommendation; **B** takes them with changes in `--words`;
**C** parks the card.
