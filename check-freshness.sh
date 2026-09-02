#!/usr/bin/env bash
# Refuse to let work start — or land — on a STALE checkout.
#
# ⚠ WHY THIS EXISTS (2026-09-02). A clone here sat 336 commits and 12 days behind origin/main
# (v441 while origin was v566) and an entire evening's work was built on it: two new apps written
# against an engine that had moved on by 125 releases, every edit to a shared file made against a
# version that no longer existed. Nothing was lost and nothing was overwritten — git rejects a
# non-fast-forward push, so the damage was never data, it was WORK. Hours of it, silently aimed at
# the wrong tree.
#
# That is the failure this guards: not a dangerous push, but a wasted night. Nothing in the repo
# could see it, because a stale checkout looks exactly like a current one — the tests pass, the
# files read sensibly, and the version number in front of you is a real version that really shipped.
#
# OFFLINE IS NOT STALE. This suite is built for people working with no connectivity, and Seth codes
# on planes. If the fetch cannot reach the remote this says so and EXITS 0. A guard that blocks work
# whenever the network is down would be uninstalled within a week, and deserve to be.
#
# Usage:
#   ./check-freshness.sh              report; exit 1 if badly stale
#   ./check-freshness.sh --warn       never exit non-zero (for dev-server startup)
#   ./check-freshness.sh --quiet      print only when there is something to say
#   FRESHNESS_MAX_COMMITS=50 …        override the threshold (default 25)
#   FRESHNESS_MAX_DAYS=7 …            override the age threshold (default 3)
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "check-freshness: not a git checkout" >&2; exit 2; }

WARN_ONLY=0; QUIET=0
for a in "$@"; do
  case "$a" in
    --warn)  WARN_ONLY=1 ;;
    --quiet) QUIET=1 ;;
    --help)  sed -n '2,24p' "$0"; exit 0 ;;
  esac
done
MAX_COMMITS="${FRESHNESS_MAX_COMMITS:-25}"
MAX_DAYS="${FRESHNESS_MAX_DAYS:-3}"

say() { [ "$QUIET" = 1 ] || echo "$@"; }

# The yardstick is origin/main: the trunk everything branches from. A feature branch is not stale
# because it lacks its own upstream — it is stale because the MAIN it forked from has moved.
UPSTREAM="${FRESHNESS_REF:-origin/main}"
remote="${UPSTREAM%%/*}"

# --no-tags keeps this to one ref; the time limit keeps a hung proxy from stalling a dev server.
#
# ⚠ NOT `timeout`. macOS has no timeout(1) — it is GNU coreutils — so on Seth's Mac the command
# failed outright, the fetch never ran, and this reported "offline" and exited 0 on a machine that
# was online. A guard that skips itself is worse than no guard: it prints a reassuring line and
# checks nothing. Found the first time this script was run, which is the only reason it is not
# still doing it. Prefer git's own low-speed abort, which needs no extra binary.
# FRESHNESS_NO_FETCH=1 compares against the refs already on disk. For the test suite (which must
# not depend on a network) and for a deliberate offline check against a remote you fetched earlier.
fetch_ok=0
if [ "${FRESHNESS_NO_FETCH:-0}" = 1 ]; then
  fetch_ok=1
elif command -v timeout >/dev/null 2>&1; then
  timeout 20 git fetch --quiet --no-tags "$remote" main 2>/dev/null && fetch_ok=1
elif command -v gtimeout >/dev/null 2>&1; then
  gtimeout 20 git fetch --quiet --no-tags "$remote" main 2>/dev/null && fetch_ok=1
else
  git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 \
      fetch --quiet --no-tags "$remote" main 2>/dev/null && fetch_ok=1
fi
if [ "$fetch_ok" != 1 ]; then
  say "check-freshness: could not reach $remote — skipping (offline is not stale)."
  exit 0
fi
git rev-parse --verify --quiet "$UPSTREAM" >/dev/null || {
  say "check-freshness: no $UPSTREAM to compare against — skipping."; exit 0; }

base=$(git merge-base HEAD "$UPSTREAM" 2>/dev/null) || { say "check-freshness: no common ancestor — skipping."; exit 0; }
behind=$(git rev-list --count "$base..$UPSTREAM" 2>/dev/null || echo 0)

if [ "$behind" -eq 0 ]; then
  say "check-freshness: up to date with $UPSTREAM."
  exit 0
fi

# Age of the point we forked from, which is the number that actually tells you how old your
# assumptions are. 336 commits sounds abstract; "12 days behind" does not.
base_epoch=$(git log -1 --format=%ct "$base" 2>/dev/null || echo 0)
now_epoch=$(date +%s)
days=$(( (now_epoch - base_epoch) / 86400 ))

tip_desc=$(git log -1 --format='%h %s' "$UPSTREAM" | cut -c1-64)
base_desc=$(git log -1 --format='%h %s' "$base" | cut -c1-64)

stale=0
[ "$behind" -ge "$MAX_COMMITS" ] && stale=1
[ "$days"   -ge "$MAX_DAYS"    ] && stale=1

if [ "$stale" = 0 ]; then
  say "check-freshness: $behind commit(s) behind $UPSTREAM (${days}d) — within tolerance."
  exit 0
fi

echo "" >&2
echo "  ⚠  STALE CHECKOUT — you are $behind commits and ${days} days behind $UPSTREAM." >&2
echo "" >&2
echo "     you forked from : $base_desc" >&2
echo "     $UPSTREAM is now : $tip_desc" >&2
echo "" >&2
echo "     Building on this means writing against an engine that has already moved on:" >&2
echo "     shared files will conflict, and anything you pin (ENGINE versions, extracted" >&2
echo "     markup, line numbers) will be pinned to a version that no longer exists." >&2
echo "" >&2
echo "     Sync first:   git fetch origin && git rebase origin/main" >&2
echo "     Deliberate?   FRESHNESS_MAX_COMMITS=99999 (or --warn) to proceed anyway" >&2
echo "" >&2
[ "$WARN_ONLY" = 1 ] && exit 0
exit 1
