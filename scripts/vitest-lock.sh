#!/bin/sh
# scripts/vitest-lock.sh — the ONE vitest lock protocol (RCB-61).
#
# Usage: vitest-lock.sh take|release|status [--force]
#
# One runner on the machine, across every session and both repos (fpj + this one). The lock is a
# directory; its presence IS the lock. Protocol is documented in prose in .repoboard/local/RIG.md
# §"vitest lock" — this script IS the protocol; a brief points there and does not restate it.
#
# Lock dir:   ${VITEST_LOCK_DIR:-${TMPDIR:-/tmp}/repoboard-vitest.lock}
# Owner file: <lock dir>/owner, ONE line: "<pid> <cwd> <ISO time> <session>"
#   <session> is $REPOBOARD_SESSION if set, else "-".
#   <pid> is ${VITEST_LOCK_PID:-${CLAUDE_PID:-$PPID}} — whichever pid outlives both the take and
#   the release. The script's own $$ dies when it exits. In a human terminal $PPID is the shell,
#   which persists. An agent seat's Bash tool opens a one-shot shell per call, so $PPID is dead a
#   second later and the seat's own release reads "NOT ours"; Claude Code exports $CLAUDE_PID
#   (the long-lived `claude` process) into every tool shell, so it comes first (RCB-114).
# Lane windows: ${FPJ_LANE_WINDOWS:-}, unset means no lane-file check. Suite lead
#   ${REPOBOARD_SUITE_MINUTES:-5} min. This script ships with neutral defaults; a rig that needs
#   fpj's paths sets them in .repoboard/local/env (sourced below, gitignored, per-machine).
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

# Optional rig env file (gitignored, per-machine, RCB-83/RCB-86). Plain `sh`; each line MUST use
# `export X="${X:-value}"` so an explicit environment (tests, a caller) still wins over the file.
RIG_ENV="$REPO_ROOT/.repoboard/local/env"
if [ -f "$RIG_ENV" ]; then . "$RIG_ENV"; fi

# Trailing slash in $TMPDIR is not stripped — "/tmp//x" is a fine path, no need to normalize it.
LOCK="${VITEST_LOCK_DIR:-${TMPDIR:-/tmp}/repoboard-vitest.lock}"
OWNER_FILE="$LOCK/owner"
SELF_PID="${VITEST_LOCK_PID:-${CLAUDE_PID:-$PPID}}"
SESSION="${REPOBOARD_SESSION:--}"
MIN="${REPOBOARD_SUITE_MINUTES:-5}"  # suite lead in minutes: ours runs ≈1 min; fpj's shim uses 20.

CLI="$REPO_ROOT/packages/server/dist/cli.js"

now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# Portable ISO-8601 (Z) -> epoch seconds: BSD `date` first, then GNU `date`. Prints nothing and
# returns non-zero if neither parses — caller treats that as "skip this line", never a refusal.
iso_to_epoch() {
  date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null || date -u -d "$1" +%s 2>/dev/null
}

# Prints the current owner line. Caller must have already checked $OWNER_FILE exists.
# `head -n 1`, not `IFS= read -r`: a file with no trailing newline makes `read` return non-zero,
# which under `set -e` inside a `$(...)` capture kills the whole script.
owner_line() {
  _ol_line=$(head -n 1 "$OWNER_FILE")
  printf '%s\n' "$_ol_line"
}

owner_pid() {
  printf '%s\n' "${1%% *}"
}

cmd_take() {
  if [ ! -f "$CLI" ]; then
    echo "dist missing — run pnpm build"
    exit 2
  fi

  # Windows live in each repo's OWN .repoboard/leases.yml (`windows:` list) — the CLI resolves
  # the root by walking up from cwd, so a check from this repo's root never sees fpj's windows.
  # fpj's seats are the ones that actually reserve `vitest-lock`, so check that board too.
  if ! _check_out=$(cd "$REPO_ROOT" && node "$CLI" window check vitest-lock 2>&1); then
    echo "$REPO_ROOT: $_check_out"
    exit 3
  fi

  # FPJ_ROOT: a second board root whose windows also gate this lock (this rig: fpj). No default —
  # unset (or a root with no .repoboard/) means this check is skipped entirely.
  if [ -n "${FPJ_ROOT:-}" ] && [ -d "$FPJ_ROOT/.repoboard" ]; then
    if ! _fpj_check_out=$(cd "$FPJ_ROOT" && node "$CLI" window check vitest-lock 2>&1); then
      echo "$FPJ_ROOT: $_fpj_check_out"
      exit 3
    fi
  fi

  # Flat-file gate windows (may be absent): lines "<startISO> <endISO> <name>". READ-ONLY — this
  # script never writes to the fpj tree or to this file. Path is the fpj shim's own env name
  # ($FPJ_LANE_WINDOWS) so both sides read the same file. Refuse (same rule as the fpj shim's
  # `lane_window_check`) iff a suite started now would still be running $REPOBOARD_SUITE_MINUTES
  # from now AND the window hasn't ended yet — START matters, not just END. A line whose START is
  # unparseable, or whose END is unparseable, is skipped, never a refusal.
  # No default: unset FPJ_LANE_WINDOWS (or a path that doesn't exist) means this check is skipped.
  _lane_file="${FPJ_LANE_WINDOWS:-}"
  if [ -n "$_lane_file" ] && [ -f "$_lane_file" ]; then
    _now=$(date -u +%s)
    _soon=$((_now + MIN * 60))
    while IFS=' ' read -r _lw_start _lw_end _lw_name || [ -n "$_lw_start" ]; do
      [ -z "$_lw_start" ] && continue
      _lw_start_epoch=$(iso_to_epoch "$_lw_start") || continue
      _lw_end_epoch=$(iso_to_epoch "$_lw_end") || continue
      if [ "$_soon" -ge "$_lw_start_epoch" ] && [ "$_now" -le "$_lw_end_epoch" ]; then
        echo "lane window live: $_lw_start $_lw_end $_lw_name"
        exit 3
      fi
    done <"$_lane_file"
  fi

  if ! mkdir "$LOCK" 2>/dev/null; then
    if [ -f "$OWNER_FILE" ]; then
      echo "lock busy: $(owner_line)"
    else
      echo "lock busy: $LOCK exists (no owner file)"
    fi
    exit 1
  fi

  _line="$SELF_PID $(pwd) $(now_iso) $SESSION"
  printf '%s\n' "$_line" >"$OWNER_FILE"
  echo "took vitest-lock: $_line"
  exit 0
}

cmd_release() {
  _force=0
  if [ "${1:-}" = "--force" ]; then
    _force=1
  fi

  if [ ! -d "$LOCK" ]; then
    echo "no lock"
    exit 0
  fi

  if [ ! -f "$OWNER_FILE" ]; then
    if [ "$_force" -eq 1 ]; then
      rm -rf "$LOCK"
      echo "released vitest-lock --force (no owner file was present)"
      exit 0
    fi
    echo "NOT ours: (no owner file) — not removed"
    exit 1
  fi

  _line=$(owner_line)
  _pid=$(owner_pid "$_line")

  if [ "$_force" -eq 1 ]; then
    rm -rf "$LOCK"
    echo "released vitest-lock --force (was: $_line)"
    exit 0
  fi

  if [ "$_pid" != "$SELF_PID" ]; then
    echo "NOT ours: $_line — not removed"
    exit 1
  fi

  rm -rf "$LOCK"
  echo "released vitest-lock"
  exit 0
}

cmd_status() {
  if [ ! -d "$LOCK" ] || [ ! -f "$OWNER_FILE" ]; then
    echo "free"
    exit 0
  fi

  _line=$(owner_line)
  _pid=$(owner_pid "$_line")
  echo "$_line"
  if kill -0 "$_pid" 2>/dev/null; then
    echo "live"
  else
    echo "dead (pid gone; a human decides)"
  fi
  exit 0
}

case "${1:-}" in
  take)
    cmd_take
    ;;
  release)
    shift
    cmd_release "${1:-}"
    ;;
  status)
    cmd_status
    ;;
  *)
    echo "usage: $0 take|release|status [--force]" >&2
    exit 64
    ;;
esac
