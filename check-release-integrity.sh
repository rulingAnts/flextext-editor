#!/usr/bin/env bash
# Catch the LIVE Pages estate breaking underneath the people still standing on it.
#
#   ./check-release-integrity.sh                 # check everything (the nightly run)
#   ./check-release-integrity.sh paths <name>    # publish gate: one satellite's SOURCE path list
#
# WHY THIS EXISTS — REWRITTEN 2026-08-27, and the history matters. This began as the satellite
# MIRROR pipeline's watchdog: mirror versions had to match the source, mirror trees must not
# drift, and every precached path had to be live. v432 then FROZE the mirrors on purpose — they
# stopped receiving updates but keep SERVING installed field apps — which turned the mirror
# comparisons into permanent, by-design failures that buried the checks that still meant
# something under a guaranteed nightly email. Two invariants survive, and they are the file now:
#
#   1. The live Pages EDITOR matches productionWeb — the only automated "did the Pages deploy
#      actually complete" check anywhere, and Pages is still production for existing field users.
#   2. Every engine path a FROZEN mirror's LIVE service worker precaches is still served by the
#      live editor. Read from the LIVE sw.js deliberately, not the source copy: the frozen shells
#      list OLD paths, and an editor release that drops one bricks exactly those installs'
#      offline mode (the v108 class — precacheAll() throws inside install's waitUntil, and the SW
#      install fails) with nothing else anywhere watching.
#
# WHAT THIS CANNOT SEE: any individual device's cache. A phone stuck on an old engine is invisible
# from here, by construction. That is covered separately by the researcher panel's confirmed-stale
# badge, which compares each device's TRUE running engine version against the live site.
#
# The `paths` mode is what the publish workflow calls as its ordering gate, so the gate and this
# checker are the SAME code — testing one tests the other.
set -uo pipefail
cd "$(dirname "$0")"

BASE="${FLEXTEXT_BASE:-https://rulingants.github.io}"
fail=0

live_version() {   # live_version <url> -> the VERSION string, or empty
  curl -fsS "$1?cb=$RANDOM$$" 2>/dev/null | grep -m1 "const VERSION" | grep -oE "v[0-9]+" || true
}
# ⚠ READ FROM productionWeb, NOT THE WORKING TREE.
# `main` is the DEVELOPMENT branch and is ahead of production nearly all the time, so comparing the
# checkout against the live site would fail on every ordinary day. The question this script answers
# is "does the live site match what PRODUCTION says it should be" — anything else is noise, and a
# checker that cries wolf gets ignored, which is the whole failure it exists to prevent.
REF="${FLEXTEXT_REF:-productionWeb}"
# A shallow CI checkout may not have the branch ref even when its CONTENT is checked out, so
# callers that already have production checked out pass FLEXTEXT_REF=HEAD. Fail loudly here
# rather than reporting a confusing "no satellites found" further down.
if ! git rev-parse --verify -q "$REF" >/dev/null; then
  echo "FAIL: ref '$REF' does not resolve here. Fetch it, or pass FLEXTEXT_REF=HEAD if" >&2
  echo "      production is already the checked-out commit." >&2
  exit 1
fi

src_version() {    # src_version <path-in-repo> -> the VERSION string per productionWeb, or empty
  git show "$REF:$1" 2>/dev/null | grep -m1 "const VERSION" | grep -oE "v[0-9]+" || true
}
src_exists() { git cat-file -e "$REF:$1" 2>/dev/null; }
src_list() {       # satellite directory names as of productionWeb
  git ls-tree -d --name-only "$REF:satellites" 2>/dev/null | sed 's#/$##'
}

# Verify every /flextext-editor/ path a satellite precaches is actually being served.
check_paths() {
  local name="$1" sw="satellites/$1/sw.js" bad=0
  src_exists "$sw" || { echo "  skip: $name has no sw.js"; return 0; }
  local paths
  paths=$(git show "$REF:$sw" | grep -oE "'/flextext-editor/[^']+'" | tr -d "'" | sort -u)
  [ -n "$paths" ] || { echo "  skip: $name precaches no engine paths"; return 0; }
  while IFS= read -r p; do
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$p?cb=$RANDOM$$" || echo 000)
    if [ "$code" != "200" ]; then
      echo "  FAIL: $name precaches $p -> HTTP $code (its service worker install would throw)" >&2
      bad=1
    fi
  done <<< "$paths"
  [ "$bad" = 0 ] && echo "  ok: $name — every precached engine path is live"
  return $bad
}

# The nightly counterpart of check_paths, reading the path list from the LIVE mirror's own sw.js
# (see the header: the frozen shells are the ones field installs actually run). A mirror serving no
# sw.js is a skip, not a failure — crowd-recorder never had one.
check_live_paths() {
  local name="$1" bad=0
  local sw
  sw=$(curl -fsS "$BASE/$name/sw.js?cb=$RANDOM$$" 2>/dev/null) || { echo "  skip: $name serves no sw.js"; return 0; }
  local paths
  paths=$(printf '%s' "$sw" | grep -oE "'/flextext-editor/[^']+'" | tr -d "'" | sort -u)
  [ -n "$paths" ] || { echo "  skip: $name's live sw.js precaches no engine paths"; return 0; }
  while IFS= read -r p; do
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$p?cb=$RANDOM$$" || echo 000)
    if [ "$code" != "200" ]; then
      echo "  FAIL: $name's LIVE service worker precaches $p -> HTTP $code" >&2
      echo "        Frozen field installs would lose their offline shell (the v108 class)." >&2
      bad=1
    fi
  done <<< "$paths"
  [ "$bad" = 0 ] && echo "  ok: $name — every path its live service worker precaches is still served"
  return $bad
}

# Called by the publish workflow as its ordering gate.
if [ "${1:-}" = "paths" ]; then
  check_paths "${2:?satellite name required}" || exit 1
  exit 0
fi

echo "== release integrity (live vs $REF) =="

# 1. The live editor must match what productionWeb says it should be.
want=$(src_version docs/sw.js)
got=$(live_version "$BASE/flextext-editor/sw.js")
if [ -z "$got" ]; then
  echo "  FAIL: could not read the live editor version (site down, or sw.js changed shape)" >&2; fail=1
elif [ "$want" != "$got" ]; then
  echo "  FAIL: editor source says $want but the live site serves $got" >&2
  echo "        Either a deploy did not complete, or productionWeb is ahead of what shipped." >&2
  fail=1
else
  echo "  ok: editor live at $got, matching source"
fi

# 2. Every engine path each FROZEN mirror still precaches must be live (see the header).
#    (The old sections here — mirror version == source, mirror tree == source — were REMOVED
#    2026-08-27: the mirrors are deliberately frozen at v432, so both had become permanent
#    by-design failures that drowned the two real checks in a guaranteed nightly email. A check
#    that cries wolf gets muted, which is worse than no check.)
for name in $(src_list); do
  check_live_paths "$name" || fail=1
done

echo
if [ "$fail" = 0 ]; then
  echo "PASS: live sites match this repo; no satellite is serving a wrong engine."
else
  echo "FAILED — a satellite may be serving the wrong engine. See above." >&2
fi
exit $fail
