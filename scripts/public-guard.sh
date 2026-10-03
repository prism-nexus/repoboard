#!/usr/bin/env bash
# RCB-209: keep a private denylist out of what this repo publishes.
#
#   public-guard.sh staged        pre-commit: the lines `git diff --cached` ADDS
#   public-guard.sh msg <file>    commit-msg: the message in <file> (lines starting `#` skipped)
#   public-guard.sh push [<remote> [<url>]]
#                                 pre-push (ref lines on stdin): for each ref being pushed, the tree
#                                 at the local sha, plus every outgoing commit's message and every
#                                 line it added (a match added then removed is still outgoing).
#                                 Outgoing for a new branch is what no tracking ref of <remote> has;
#                                 with no usable <remote> that is every commit — never fewer.
#
# The denylist is `.repoboard/local/public-denylist.txt` in the repo's top directory: one extended
# regex per line, matched case-insensitively; blank lines and `#` lines are ignored, and each line
# is trimmed first (an empty pattern would match every line). No file, or no patterns left after
# cleaning, exits 0 silently — an unconfigured guard is inert, never a blocker. A hit exits 1 and
# names WHERE (file:line, a commit sha, a message line) on stderr and never the matched text: what
# the denylist keeps out must not be echoed into a terminal log. A pattern grep cannot compile also
# exits 1 — a guard that cannot run must not wave a commit through.
#
# Lockfiles are skipped (integrity hashes false-positive). bash 3.2 (macOS) compatible.

set -u

usage() {
  echo 'usage: public-guard.sh staged | msg <commit-msg-file> | push' >&2
  exit 2
}

mode="${1:-}"
case "$mode" in
  staged | push) ;;
  msg) [ -n "${2:-}" ] || usage ;;
  *) usage ;;
esac

root="$(git rev-parse --show-toplevel 2> /dev/null)" || {
  echo 'public-guard: not inside a git work tree' >&2
  exit 2
}
deny_rel='.repoboard/local/public-denylist.txt'
deny="$root/$deny_rel"
[ -e "$deny" ] || exit 0
[ -r "$deny" ] || {
  echo "public-guard: cannot read $deny_rel" >&2
  exit 1
}

tmp="$(mktemp -d "${TMPDIR:-/tmp}/public-guard.XXXXXX")" || exit 2
trap 'rm -rf "$tmp"' EXIT

# Clean: trim each line (CR included), drop blanks and `#` lines.
pats="$tmp/patterns"
LC_ALL=C sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$deny" \
  | LC_ALL=C grep -v -e '^$' -e '^#' > "$pats"
[ -s "$pats" ] || exit 0

# A pattern grep cannot compile fails here, not silently later.
grep -E -f "$pats" < /dev/null > /dev/null 2> "$tmp/err"
if [ $? -ge 2 ]; then
  echo "public-guard: $deny_rel has a pattern that does not compile: $(head -n 1 "$tmp/err")" >&2
  exit 1
fi

cd "$root" || exit 2

excludes=(
  ':(exclude,glob)**/pnpm-lock.yaml'
  ':(exclude,glob)**/package-lock.json'
  ':(exclude,glob)**/yarn.lock'
)
soh="$(printf '\001')"
report="$tmp/report"
: > "$report"

# All zeros (a missing ref's sha, in either hash length), or empty.
is_zero() {
  case "$1" in *[!0]*) return 1 ;; *) return 0 ;; esac
}

fail_run() {
  # $1 = what was being run, $2 = file holding its stderr
  echo "public-guard: $1 failed: $(head -n 1 "$2")" >&2
  exit 1
}

# `git grep -z` prints `[<rev>:]path NUL line NUL text NL`; keep `path:line` and drop the text.
places() {
  LC_ALL=C tr '\0' '\001' | LC_ALL=C awk -F "$soh" '{ p = $1; sub(/^[^:]*:/, "", p); print p ":" $2 }'
}

# The one walker over a zero-context diff, `git diff` or `git log -p` output: every line it ADDS,
# matched against the denylist. Hunks are walked by their header counts, so an added line that
# itself starts `+++` is still a content line. `$tmp/idx` line N = where content line N is,
# `path:line`, or `commit <short> path:line` once a commit marker (a line `<SOH><short>`, which
# only `git log --format` emits, outside any hunk) has been seen. Hits land in `$tmp/hits`, one
# place per added matching line; never the text. $1 = the diff file, $2 = what it was, for errors.
scan_added() {
  : > "$tmp/idx"
  : > "$tmp/content"
  : > "$tmp/hits"
  LC_ALL=C awk -v soh="$soh" -v idx="$tmp/idx" -v out="$tmp/content" '
        oldn > 0 || newn > 0 {
          c = substr($0, 1, 1)
          if (c == "+") { print pre newl > idx; print substr($0, 2) > out; newl++; newn-- }
          else if (c == "-") { oldn-- }
          else if (c != "\\") { oldn--; newn--; newl++ }
          next
        }
        substr($0, 1, 1) == soh { commit = substr($0, 2); next }
        /^\+\+\+ / {
          path = substr($0, 5); sub(/\t.*$/, "", path)
          pre = (commit == "" ? "" : "commit " commit " ") path ":"
          next
        }
        /^@@ / {
          split($2, o, ","); split($3, n, ",")
          oldn = (o[2] == "" ? 1 : o[2] + 0)
          newn = (n[2] == "" ? 1 : n[2] + 0)
          newl = substr(n[1], 2) + 0
        }
      ' "$1"
  [ -s "$tmp/content" ] || return 0
  grep -n -a -i -E -f "$pats" "$tmp/content" > "$tmp/m" 2> "$tmp/err"
  rc=$?
  [ "$rc" -le 1 ] || fail_run "grep over $2" "$tmp/err"
  cut -d: -f1 "$tmp/m" > "$tmp/nums"
  awk 'NR == FNR { want[$1] = 1; next } FNR in want { print }' "$tmp/nums" "$tmp/idx" > "$tmp/hits"
}

scan_staged() {
  git -c core.quotepath=off diff --cached --no-color --no-ext-diff --no-textconv --no-renames \
    --no-prefix -U0 -- . "${excludes[@]}" > "$tmp/diff" 2> "$tmp/err" \
    || fail_run 'git diff --cached' "$tmp/err"
  scan_added "$tmp/diff" 'the staged lines'
  cat "$tmp/hits" >> "$report"
}

scan_msg() {
  [ -r "$1" ] || {
    echo "public-guard: cannot read the commit message file $1" >&2
    exit 1
  }
  # `git commit -v` appends the diff under a scissors line; it is not part of the message.
  LC_ALL=C sed -e '/^# -\{24\} >8 -\{24\}$/,$d' "$1" > "$tmp/msg"
  grep -n -a -i -E -f "$pats" "$tmp/msg" > "$tmp/m" 2> "$tmp/err"
  rc=$?
  [ "$rc" -le 1 ] || fail_run 'grep over the commit message' "$tmp/err"
  grep -v -E '^[0-9]+:#' "$tmp/m" | cut -d: -f1 | while read -r n; do
    echo "commit message line $n"
  done >> "$report"
}

scan_push() {
  remote="${1:-}" # the hook's $1: the remote's name, or its URL when pushed by URL
  grep_args=(-i -E)
  while IFS= read -r p; do
    grep_args+=("--grep=$p")
  done < "$pats"
  while read -r lref lsha rref rsha; do
    [ -n "${lsha:-}" ] || continue
    is_zero "$lsha" && continue # the ref is being deleted
    git grep -n -z -I -i -E -f "$pats" "$lsha" -- . "${excludes[@]}" > "$tmp/g" 2> "$tmp/err"
    rc=$?
    [ "$rc" -le 1 ] || fail_run "git grep over $lref" "$tmp/err"
    places < "$tmp/g" | while read -r where; do
      echo "$lref: $where"
    done >> "$report"
    # Outgoing commits: remote..local, or everything no tracking ref OF THIS REMOTE has when the
    # remote sha is all zeros (a new branch) or is not an object here (a remote we have not
    # fetched). Another remote's tracking ref proves nothing about what this remote holds. No
    # remote name scans every commit; a URL matches no tracking ref and does the same.
    if [ -n "${rsha:-}" ] && ! is_zero "$rsha" && git cat-file -e "${rsha}^{commit}" 2> /dev/null; then
      range=("$rsha..$lsha")
    elif [ -n "$remote" ]; then
      range=("$lsha" --not "--remotes=$remote")
    else
      range=("$lsha")
    fi
    git log "${grep_args[@]}" --format=%h "${range[@]}" > "$tmp/c" 2> "$tmp/err" \
      || fail_run "git log over $lref" "$tmp/err"
    while read -r c; do
      echo "$lref: commit $c message"
    done < "$tmp/c" >> "$report"
    # Every line each outgoing commit ADDED, not just the tip tree: a match added in one commit and
    # removed in the next is in the history that goes out. --full-history keeps a merge that is
    # TREESAME to its parent from hiding the side branch it brought in (on git 2.54
    # --diff-merges=first-parent alone does too, so the test pins the pair, not either flag); the
    # marker line carries the short sha for scan_added.
    git -c core.quotepath=off log -p --full-history --diff-merges=first-parent --no-color \
      --no-ext-diff --no-textconv --no-renames --no-prefix -U0 "--format=${soh}%h" "${range[@]}" \
      -- . "${excludes[@]}" > "$tmp/diff" 2> "$tmp/err" \
      || fail_run "git log -p over $lref" "$tmp/err"
    scan_added "$tmp/diff" "the lines added to $lref"
    while IFS= read -r where; do
      echo "$lref: $where"
    done < "$tmp/hits" >> "$report"
  done
}

case "$mode" in
  staged) scan_staged ;;
  msg) scan_msg "$2" ;;
  push) scan_push "${2:-}" ;;
esac

if [ -s "$report" ]; then
  n="$(wc -l < "$report" | tr -d ' ')"
  {
    echo "public-guard: $n place(s) match $deny_rel (the matched text is not shown):"
    head -n 20 "$report" | sed 's/^/  /'
    [ "$n" -le 20 ] || echo "  ...+$((n - 20)) more"
  } >&2
  exit 1
fi
exit 0
