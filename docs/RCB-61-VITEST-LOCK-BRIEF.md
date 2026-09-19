# Brief — RCB-61 (B5) `scripts/vitest-lock.sh` — the ONE lock protocol (2026-09-19)

One agent (sonnet). The builder seat verifies, gates, commits, pushes. Two OTHER agents work
this tree at the same time on other files (RCB-57: `packages/core/src/seat.ts` + test +
`docs/AGENTS.md`; RCB-62: core `repolog.ts`, server `store.ts`/`repo-context.ts`, web `time.ts`
+ tests). Touch nothing of theirs. Never `git add/stash/checkout/restore`.

## The change

The vitest lock protocol is restated in prose in `docs/RIG.md` §"vitest lock" and in every
brief since RCB-47 (`docs/RCB-47-LOG-LAST-BRIEF.md:14`, `RCB-48-SEAT-BRIEF.md:22`,
`RCB-52-OWNER-TASK-BRIEF.md:34`, `RCB-53-LIVE-TABLE-BRIEF.md:29`). On 2026-09-18 19:32Z a
builder's hand-typed `mkdir` failed without stopping its script and its cleanup removed a
FOREIGN lock (log block at `.repoboard/log/2026-09-18.md:41`). One script, one code path:

`scripts/vitest-lock.sh take|release|status` — POSIX sh (`#!/bin/sh`, `set -eu`), no
dependencies beyond coreutils + the built CLI. Executable bit set (`chmod +x`, and confirm with
`ls -l`).

- **Lock dir:** `/tmp/fpj-vitest.lock`. **Owner file:** `/tmp/fpj-vitest.lock/owner`, ONE line:
  `<pid> <cwd> <ISO time> <session>` — `<session>` is `$REPOBOARD_SESSION` if set, else `-`.
  `<pid>` is the CALLER's shell pid: take `$PPID`… no — a script's `$$` is its own pid, which
  dies at exit, so a later `release` can never match it. Use `${VITEST_LOCK_PID:-$PPID}` and
  document that: the parent shell's pid is what persists across the take and the release.
- **`take`:** first `node packages/server/dist/cli.js window check vitest-lock` (run from the
  repo root; if `dist/cli.js` is missing, print `dist missing — run pnpm build` and exit 2). If
  `window check` exits non-zero, print its output and exit 3 — never take inside a foreign
  window. Then `mkdir "$LOCK" 2>/dev/null || { echo "lock busy: $(cat $LOCK/owner)"; exit 1; }`
  and write the owner line. Print `took vitest-lock: <owner line>`. Exit 0.
- **`release`:** read the owner line; if the dir is absent print `no lock` exit 0; if the pid
  field ≠ ours print `NOT ours: <owner line> — not removed` and exit 1; else `rm -rf "$LOCK"`,
  print `released vitest-lock`, exit 0. `release --force` removes regardless but PRINTS the
  foreign owner line it removed (a human decision, audited).
- **`status`:** prints the owner line or `free`; exit 0 either way. Also says whether the
  owner pid is alive (`kill -0`) — `live` / `dead (pid gone; a human decides)`.
- **`window check`**: find the real subcommand shape with `node packages/server/dist/cli.js
  --help | grep -n window`; the resource name is `vitest-lock` (matches what fpj's seats
  reserve — confirm READ-ONLY with `cd ~/Projects/Repos/freshpickedjobs && node
  <this-repo>/packages/server/dist/cli.js window list`; do not write anything there).

## Rules (CLAUDE.md; docs/RIG.md)

- **You do not commit.** Leave the tree dirty.
- **The builder currently HOLDS `/tmp/fpj-vitest.lock`** (owner line pid is the builder's
  shell). Your tests of the script must therefore use a DIFFERENT lock path: make the dir
  configurable via `VITEST_LOCK_DIR` (default `/tmp/fpj-vitest.lock`) and test against a
  scratch dir under `$TMPDIR`. Never touch the real lock.
- No vitest, no `pnpm test` — this card has no TS. Prove the script with a shell transcript.
- `docs/RIG.md` §"vitest lock": replace the four bullets with a pointer — the three verbs, the
  owner-line format, the two rules (release only when ours; a foreign lock is a human decision),
  and one line "the script is the protocol; a brief points here and does not restate it". Keep
  the section heading. Do not edit any old brief (frozen history) — new briefs point at RIG.md.

## Owns

`scripts/vitest-lock.sh` (new), `docs/RIG.md` (§"vitest lock" only).

## Proof (paste the transcript)

With `VITEST_LOCK_DIR=$TMPDIR/vl-test`:
1. `status` → `free`.
2. `take` → `took vitest-lock: <line>`; `status` → the line, `live`.
3. Second `take` → `lock busy: <line>`, exit 1 (`echo $?`).
4. `release` with `VITEST_LOCK_PID=999999` → `NOT ours … not removed`, exit 1; dir still exists
   (`ls`).
5. `release` (our pid) → `released vitest-lock`; `status` → `free`.
6. `release --force` after a take under a foreign pid → prints the foreign line, removes it.
7. `window check` refusal: cannot be provoked without writing a window — say so; show the
   command the script runs (`sh -x` excerpt) instead.
8. `shellcheck` if installed (`which shellcheck`); if not, say so.

## Report

The transcript above; `ls -l scripts/vitest-lock.sh`; `git diff --stat`; the RIG.md diff.
