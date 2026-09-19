#!/bin/sh
# scripts/vitest-lock.sh — the ONE vitest lock protocol (RCB-61).
#
# Usage: vitest-lock.sh take|release|status [--force]
#
# One runner on the machine, across every session and both repos (fpj + this one). The lock is a
# directory; its presence IS the lock. Protocol is documented in prose in docs/RIG.md
# §"vitest lock" — this script IS the protocol; a brief points there and does not restate it.
#
# Lock dir:   ${VITEST_LOCK_DIR:-/tmp/fpj-vitest.lock}
# Owner file: <lock dir>/owner, ONE line: "<pid> <cwd> <ISO time> <session>"
#   <session> is $REPOBOARD_SESSION if set, else "-".
#   <pid> is ${VITEST_LOCK_PID:-$PPID} — the CALLER's shell pid. A script's own $$ dies when the
#   script exits, so a later `release` invocation (a separate process) could never match it
#   against a `take` done by the same $$. The parent shell's pid is what persists across the
#   take and the release, as long as both run from the same shell session.
set -eu

LOCK="${VITEST_LOCK_DIR:-/tmp/fpj-vitest.lock}"
OWNER_FILE="$LOCK/owner"
SELF_PID="${VITEST_LOCK_PID:-$PPID}"
SESSION="${REPOBOARD_SESSION:--}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CLI="$REPO_ROOT/packages/server/dist/cli.js"

now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
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

  FPJ_ROOT="${FPJ_ROOT:-$HOME/Projects/Repos/freshpickedjobs}"
  if [ -d "$FPJ_ROOT/.repoboard" ]; then
    if ! _fpj_check_out=$(cd "$FPJ_ROOT" && node "$CLI" window check vitest-lock 2>&1); then
      echo "$FPJ_ROOT: $_fpj_check_out"
      exit 3
    fi
  fi

  # Flat-file gate windows (may be absent): lines "<startISO> <endISO> <name>". READ-ONLY — this
  # script never writes to the fpj tree or to this file. now_iso's format sorts lexically, so a
  # plain string `>` is a correct ISO-8601 comparison.
  _lane_file="/tmp/fpj-lane-windows"
  if [ -f "$_lane_file" ]; then
    _now=$(now_iso)
    while IFS=' ' read -r _lw_start _lw_end _lw_name || [ -n "$_lw_start" ]; do
      [ -z "$_lw_start" ] && continue
      if [ "$_lw_end" \> "$_now" ]; then
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
