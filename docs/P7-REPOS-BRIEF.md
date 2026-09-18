# Brief — P7.1 and P7.2: point repoboard at any repo (2026-09-07)

Owner decision **O7** (plan §11), scoped 2026-09-07: *"we also need the ability to point this
project at different projects to see what is in them and get the full usability. pointing at our
own repo is just a test to get up and running."*

**One agent owns both tasks.** They share `packages/server/src/cli.ts`, so splitting them across
two agents would put two writers on one file. Do P7.1 first; it is the smaller half and P7.2
builds on it.

Baseline on `main` @ `9121046`, measured by the orchestrator 2026-09-07: **217 tests, 22 files;
`pnpm typecheck` exit 0; `biome check .` exit 0 on 88 files; web bundle 135.2 KB gzipped**
(limit 600 KB). Every number you report is a delta against those.

Cards: **RCB-32** (P7.1), **RCB-33** (P7.2). Both are in `todo` with
`assignee: claude/repos-agent` already set.

---

## Rules (CLAUDE.md; HANDOFF §0, §7)

- **You do not commit.** Leave the tree dirty; the orchestrator verifies and commits.
- **Do not run `pnpm build` or start a long-lived `serve` without saying so in your report** —
  the orchestrator may be holding port 4242 (CLAUDE.md non-negotiable 2). Use `--port 0` or a
  high port of your own for any server you start, and shut it down before you finish.
- **Every save must parse** — the tree hot-reloads into the owner's browser.
- Move your card with the built CLI when you start:
  `node packages/server/dist/cli.js card move RCB-32 doing --as claude/repos-agent`.
  Leave it in `doing`; the orchestrator moves it on. **`card update` does not exist** (that is
  K9, RCB-31) — `assignee` is already set on both cards, so you do not need it.
- Run `biome check --write <your files>` before reporting (§7.6).
- **Claims carry numbers.** Report measurements, not adjectives. If you did not measure it, say
  so in those words.
- **Every protective test is verified the CLAUDE.md way.** Break the thing it guards, **read the
  file back to confirm the perturbation landed**, confirm it still **typechecks**, confirm the
  test **fails in the direction you fear**, then restore with a targeted edit — never
  `git checkout`, which would discard your whole uncommitted change. Paste the failing output
  into your report.

## The one rule that is not about code quality

This feature's whole purpose is to open directories outside this repo, which makes it the first
task here that *could* write somewhere it must not.

- **CLAUDE.md non-negotiable 1 is absolute: never write to `~/Projects/Repos/Other App/other-app-live`
  or `other-app-pipeline`, from any repo on this machine, for any reason.** Do not point a test,
  a manual run, or a scratch command at either. Do not `require` their `database.js`.
- **Every test creates its own fixture repo** under `mkdtemp` in the OS temp dir and removes it
  afterwards. No test may point at a path outside the fixture it created, this repo included.
- For a manual smoke test against a real foreign repo, use a **throwaway clone you make
  yourself** (`git clone` some public repo into your temp dir). Report which path you used.

---

## P7.1 — `repoboard serve --root <dir>`

**Owns:** `packages/server/src/cli.ts`, `packages/server/test/cli.test.ts` (or the existing serve
test file, whichever holds `cmdServe` coverage today).

`repoboard mcp` has had `--root` since P5.1. `serve` never got it, so today the only way to serve
another project is to `cd` there. Give `serve` the same flag, with the same semantics.

The existing implementation to mirror is `cmdMcp` (`cli.ts:318-319`):

```ts
const { values } = parse(args, { root: { type: 'string' } });
const root = await requireRoot(values.root === undefined ? io : { ...io, cwd: values.root });
```

**Settled — do not redesign:**

- `--root` is a directory path. Relative paths resolve against the process cwd.
- Update the `HELP` text (`cli.ts:59-60`) so the `serve` line reads like the `mcp` line.
- `--port` and `--open` keep working alongside it.
- The line `serve` already prints — `repoboard: serving ${root}` — is how the user confirms the
  flag took effect. Do not change its shape.

**DoD:** a test that `serve --root <fixture>` serves the *fixture's* cards, not the cwd's. Assert
on content from `GET /api/board` (a card id that exists only in the fixture), not on an exit code.

---

## P7.2 — a repo with no `.repoboard/` opens in map-only mode

**Owns:** `packages/server/src/cli.ts`, `packages/server/src/http.ts`,
`packages/server/test/http.test.ts`, and the Board view in `packages/web/src/` plus its test.

Today `requireRoot` (`cli.ts:95`) refuses to start without `.repoboard/`. But the map half of the
product does not need a board at all — verified by the orchestrator 2026-09-07:

- `packages/server/src/scanner.ts` reads no `.repoboard/` path. (**This brief originally added**
  **"its only core import is types" — that was wrong**: line 12 is a value import of `toIso`. It
  touches no disk, so the conclusion held; the agent reported the contradiction rather than
  agreeing with the brief, which is the behaviour this project wants.)
- `loadConfig` already returns `defaultBoardConfig()` on ENOENT (`store.ts:326-328`).
- `load()` already tolerates a missing cards directory (`store.ts:143-147`).

So the server can already open a boardless repo. **Re-derive those three facts yourself before
you build on them** (§7.13 — the last recorded repro in this project was wrong twice over).

**Settled — do not redesign:**

1. **Root resolution.** With `--root`, use that directory as given; **never search upward** from
   it, board or no board. Without `--root`, behaviour is **unchanged**: search upward for
   `.repoboard/`, and if there is none, keep today's error — but extend its text to mention
   `--root` as the way to open a project that has no board. Rationale: map-only is an explicit
   act, so bare `repoboard serve` in a random directory must not silently change meaning.
2. **How the server says "no board".** Add `hasBoard: boolean` to the `/api/board` payload and
   to the WS `board` message. This is an **additive** change to the plan §3 wire contract; update
   §3 in `docs/BUILD-PLAN.md` in the same change so the contract and the code do not drift.
   Compute it from whether `.repoboard/` exists, exposed off the store — one function, computed
   in the only code path, not a convention callers must remember (CLAUDE.md).
3. **Explicitly out of scope:** noticing a `.repoboard/` that appears *while* the server runs. If
   the user runs `init` against a served repo, they restart. Say so in the UI copy. If you find
   the existing repo watcher already gives you this for free, **report the measurement and leave
   it out anyway** — scope creep here costs the round.
4. **The Board tab in map-only mode** shows an explanatory panel, not five empty columns. It must
   name the exact command (`repoboard init`) and say the server will not create anything on its
   own. **It must not offer a button that writes `.repoboard/`.** The read-only guarantee is the
   feature; a write path from a web UI into a foreign repo is precisely what O7 forbids this
   round.
5. **Map is the default tab** when `hasBoard` is false.
6. An **empty but initialized** board (`.repoboard/` exists, zero cards) must still render as a
   normal empty board. `hasBoard: true`. These two states are different and the UI must say so.

**DoD:**

- A fixture repo with **no** `.repoboard/`: server starts, `GET /api/repo` returns a scan with a
  non-zero file count, `GET /api/board` returns `hasBoard: false` and zero cards.
- A fixture repo with an **empty** `.repoboard/`: `hasBoard: true`, zero cards.
- A web test that the Board tab renders the explanation, not columns, when `hasBoard` is false.
- **The read-only proof, measured:** after serving a boardless fixture through a full start /
  scan / stop cycle, `git status --porcelain` in the target is **empty** and `.repoboard/` is
  **still absent**. Paste both outputs.

---

## Controls — three, and the third is the one that matters

Each is verified by content, not exit code (CLAUDE.md, five species of vacuous control).

1. **P7.1:** make `--root` be ignored (use `io` unconditionally). Read the file back, typecheck,
   confirm the P7.1 test fails because the cwd's board was served.
2. **P7.2:** force `hasBoard` to `true` always. Read back, typecheck, confirm the map-only UI
   test fails.
3. **The read-only guarantee.** The fear is writing into someone else's repo. Make map-only mode
   create `.repoboard/` in the target (a one-line `mkdir` in the boardless path). Read the file
   back to confirm the perturbation landed, typecheck it, and confirm your read-only test
   **fails** — `.repoboard/` present where the test demands absence. A test that only ever sees
   the passing case is not evidence that this feature is safe. Restore with a targeted edit.

## Report back

- The three re-derived facts from P7.2's preamble: did each hold? Quote what you ran.
- Test delta against 217, per package, and `pnpm typecheck` / `biome check` results.
- Bundle size against 135.2 KB gz if you touched `packages/web/`.
- All three controls: the perturbation, proof it landed (the file read back), that it typechecked,
  and the failing output.
- The read-only proof: `git status --porcelain` and the `.repoboard/` check on the target.
- Which foreign repo you smoke-tested against, and its path.
- Anything in the "settled" lists above that turned out to be wrong. Say so — the orchestrator's
  briefs have been wrong before (§7.12), and a measurement that contradicts this brief is the
  most valuable thing you can report.
