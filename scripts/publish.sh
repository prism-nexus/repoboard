#!/usr/bin/env bash
# RCB-222: publish chosen card commits from the private `dev` line to public `main`, by a per-card
# pull request, after the public check.
#
#   publish.sh [--apply] [--from <ref>] [--remote <name>] <card-id|sha>...
#
#   --from <ref>      where the work lives (default dev)
#   --remote <name>   the public remote (default origin); its `main` is the base
#   <card-id>         ABC-12 selects every candidate whose subject starts `ABC-12:`
#   <sha>             selects that one commit; it must be a candidate (unlike remote main by
#                     patch), or the run exits 1
#
# Candidates are the `+` lines of `git cherry <remote>/main <from>`: commits whose patch is not
# already on the remote's main. They are picked oldest first onto a detached worktree of
# <remote>/main under a temp dir; the caller's HEAD, index and working tree are never touched, and
# the worktree is removed on exit. Then the public check (public-guard.sh push) runs over exactly
# what would go out. Without --apply that is all: the outgoing commits and a diff stat are printed
# and nothing is pushed. With --apply and a clean check the picked tip is pushed as
# `publish/<ids joined by ->` and `gh pr create --base main` opens the pull request.
#
# No denylist (or no patterns in it) prints `public check: NO DENYLIST`: a dry run still shows what
# would go out, but --apply refuses — an unconfigured check must not wave a publish through. A hit
# prints where, never the matched text (the guard's rule), and nothing about the commits is echoed.
#
# Exit: 0 ok, 1 refused or failed, 2 usage. bash 3.2 (macOS) compatible: no mapfile, no
# associative arrays, no empty-array expansion.

set -u

usage() {
  echo 'usage: publish.sh [--apply] [--from <ref>] [--remote <name>] <card-id|sha>...' >&2
  exit 2
}

die() {
  echo "publish: $*" >&2
  exit 1
}

apply=0
from=dev
remote=origin
args=''
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=1 ;;
    --from)
      [ $# -ge 2 ] || usage
      from="$2"
      shift
      ;;
    --remote)
      [ $# -ge 2 ] || usage
      remote="$2"
      shift
      ;;
    -*) usage ;;
    *) args="$args$1
" ;;
  esac
  shift
done
[ -n "$args" ] || usage

guard="$(cd "$(dirname "$0")" && pwd)/public-guard.sh"
[ -r "$guard" ] || die "cannot read $guard"
root="$(git rev-parse --show-toplevel 2> /dev/null)" || die 'not inside a git work tree'
base="refs/remotes/$remote/main"
base_name="$remote/main"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/publish.XXXXXX")" || exit 2
wt="$tmp/wt"
cleanup() {
  if [ -e "$wt" ]; then
    git -C "$root" worktree remove --force "$wt" > /dev/null 2>&1
  fi
  git -C "$root" worktree prune > /dev/null 2>&1
  rm -rf "$tmp"
}
trap cleanup EXIT

# 1. candidates ----------------------------------------------------------------------------------
git -C "$root" fetch --quiet "$remote" main > "$tmp/out" 2>&1 || {
  cat "$tmp/out" >&2
  die "git fetch $remote main failed"
}
git -C "$root" rev-parse --verify --quiet "$base^{commit}" > /dev/null \
  || die "$base_name is not a commit here"
git -C "$root" rev-parse --verify --quiet "$from^{commit}" > /dev/null \
  || die "--from $from is not a commit here"
git -C "$root" cherry "$base_name" "$from" > "$tmp/cherry" 2> "$tmp/out" || {
  cat "$tmp/out" >&2
  die "git cherry $base_name $from failed"
}

# cand: `<full sha> TAB <subject>`, oldest first (git cherry prints oldest first).
: > "$tmp/cand"
while read -r mark sha; do
  [ "$mark" = '+' ] || continue
  printf '%s\t%s\n' "$sha" "$(git -C "$root" log -1 --format=%s "$sha")" >> "$tmp/cand"
done < "$tmp/cherry"

: > "$tmp/want"
ids=''   # one label per argument, in argument order, without repeats
printf '%s' "$args" > "$tmp/args"
while IFS= read -r arg; do
  [ -n "$arg" ] || continue
  case "$arg" in
    *[!0-9A-Za-z-]*) die "'$arg' is neither a card id nor a sha" ;;
  esac
  if printf '%s\n' "$arg" | grep -q -E '^[A-Za-z][A-Za-z0-9]*-[0-9]+$'; then
    label="$arg"
    awk -F '\t' -v p="$arg:" 'index($2, p) == 1 { print $1 }' "$tmp/cand" > "$tmp/hit"
    [ -s "$tmp/hit" ] || die "no candidate commit has a subject starting '$arg:'"
  else
    full="$(git -C "$root" rev-parse --verify --quiet "$arg^{commit}")" \
      || die "'$arg' is not a commit here"
    cut -f1 "$tmp/cand" | grep -q -x -F "$full" \
      || die "$arg is not a candidate: its patch is already on $base_name, or it is not on $from"
    printf '%s\n' "$full" > "$tmp/hit"
    label="$(printf '%s' "$full" | cut -c1-7)"
  fi
  cat "$tmp/hit" >> "$tmp/want"
  printf '%s\n' "$ids" | grep -q -x -F "$label" || ids="$ids$label
"
done < "$tmp/args"

: > "$tmp/pick"
while IFS="$(printf '\t')" read -r sha subj; do
  grep -q -x -F "$sha" "$tmp/want" && printf '%s\t%s\n' "$sha" "$subj" >> "$tmp/pick"
done < "$tmp/cand"
[ -s "$tmp/pick" ] || die 'nothing selected'

ids="$(printf '%s' "$ids" | sed '/^$/d')"
branch="publish/$(printf '%s\n' "$ids" | paste -s -d - -)"
title_ids="$(printf '%s\n' "$ids" | paste -s -d , - | sed 's/,/, /g')"

# 2. a detached worktree of the remote's main ----------------------------------------------------
git -C "$root" worktree add --quiet --detach "$wt" "$base_name" > "$tmp/out" 2>&1 || {
  cat "$tmp/out" >&2
  die "git worktree add failed"
}

# 3. pick, oldest first --------------------------------------------------------------------------
while IFS="$(printf '\t')" read -r sha subj; do
  if ! git -C "$wt" cherry-pick "$sha" > "$tmp/out" 2>&1; then
    git -C "$wt" cherry-pick --abort > /dev/null 2>&1
    cat "$tmp/out" >&2
    die "cherry-pick of $(printf '%s' "$sha" | cut -c1-7) does not apply onto $base_name; nothing pushed"
  fi
done < "$tmp/pick"
tip="$(git -C "$wt" rev-parse HEAD)" || die 'cannot read the picked tip'

# 4. the public check ----------------------------------------------------------------------------
deny_rel='.repoboard/local/public-denylist.txt'
deny="$root/$deny_rel"
npat=0
if [ -e "$deny" ]; then
  [ -r "$deny" ] || die "cannot read $deny_rel"
  npat="$(LC_ALL=C sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$deny" \
    | LC_ALL=C grep -c -v -e '^$' -e '^#')"
fi

hit=0
if [ "$npat" -eq 0 ]; then
  echo 'public check: NO DENYLIST'
else
  # The guard reads the denylist from the top of the tree it runs in; the worktree is a checkout
  # of public main, which does not carry the (gitignored) local layer. Lend it a copy.
  mkdir -p "$wt/.repoboard/local" && cp "$deny" "$wt/$deny_rel" || die 'cannot lend the denylist'
  zeros='0000000000000000000000000000000000000000'
  printf 'refs/heads/%s %s refs/heads/%s %s\n' "$branch" "$tip" "$branch" "$zeros" \
    | (cd "$wt" && bash "$guard" push "$remote")
  rc=$?
  case "$rc" in
    0) echo "public check: $npat patterns, clean" ;;
    1)
      echo "public check: $npat patterns, hits"
      hit=1
      ;;
    *)
      echo "public check: $npat patterns, failed (exit $rc)"
      hit=1
      ;;
  esac
fi

# A hit shows no commit or path: a subject or a file name could be the match itself.
if [ "$hit" -eq 1 ]; then
  echo 'refused: nothing pushed'
  exit 1
fi

# 5. what would go out ---------------------------------------------------------------------------
echo "branch: $branch"
git -C "$root" log --reverse --format='%h %s' "$base_name..$tip"
git -C "$root" diff --stat "$base_name" "$tip"

# 6. push and open the pull request --------------------------------------------------------------
if [ "$apply" -ne 1 ]; then
  echo 'dry run: nothing pushed'
  exit 0
fi
if [ "$npat" -eq 0 ]; then
  die "--apply refused: no denylist, so the public check did not run; nothing pushed"
fi

first="$(head -n 1 "$tmp/pick" | cut -f2- | sed -E 's/^[A-Za-z][A-Za-z0-9]*-[0-9]+: //')"
cut -f2- "$tmp/pick" | sed 's/^/- /' > "$tmp/body"

git -C "$root" push "$remote" "$tip:refs/heads/$branch" || die "git push to $remote failed"
(cd "$root" && gh pr create --base main --head "$branch" --title "$title_ids: $first" \
  --body "$(cat "$tmp/body")") > "$tmp/out" 2>&1 || {
  cat "$tmp/out" >&2
  die "gh pr create failed; $branch is pushed to $remote"
}
cat "$tmp/out"
exit 0
