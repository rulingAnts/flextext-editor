#!/usr/bin/env bash
# Catch a satellite serving the WRONG engine because the release process misfired.
#
#   ./check-release-integrity.sh                 # check everything
#   ./check-release-integrity.sh paths <name>    # just one satellite's precached engine paths
#
# WHY THIS EXISTS
# A satellite's service worker precaches editor engine files BY PATH. Two ways that goes wrong:
#   - published too EARLY: the paths 404, precacheAll() throws inside install's waitUntil, the SW
#     install FAILS, and new installs get no offline shell at all. That happened on 2026-07-20.
#   - published too LATE / not at all: the satellite keeps serving a STALE cached engine.
# Neither is visible from the source tree — only from what the live sites actually serve.
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

# 2. Each satellite's LIVE version must match its source here (this repo is the source of truth).
for name in $(src_list); do
  src_exists "satellites/$name/sw.js" || { echo "  ok: $name has no sw.js (nothing to version)"; continue; }
  s=$(src_version "satellites/$name/sw.js")
  l=$(live_version "$BASE/$name/sw.js")
  if [ -z "$l" ]; then
    echo "  FAIL: $name — could not read its live version" >&2; fail=1
  elif [ "$s" != "$l" ]; then
    echo "  FAIL: $name source is $s but live serves $l — the mirror was not republished." >&2
    echo "        Installed copies are precaching an engine that no longer matches this repo." >&2
    fail=1
  else
    echo "  ok: $name live at $l, matching source"
  fi
done

# 3. Every precached engine path must be live, for every satellite.
for name in $(src_list); do
  check_paths "$name" || fail=1
done

# 4. The published mirrors must not have drifted from the source. Anyone editing a mirror directly
#    is editing something the next publish silently overwrites, so catch it while it is still true.
if [ "${SKIP_MIRROR_DIFF:-0}" != "1" ]; then
  for name in $(src_list); do
    tmp=$(mktemp -d)
    mkdir -p "$tmp/src"
    git archive "$REF" "satellites/$name" 2>/dev/null | tar -x -C "$tmp/src" --strip-components=2 2>/dev/null
    if git clone --depth 1 -q "https://github.com/rulingAnts/$name.git" "$tmp/m" 2>/dev/null; then
      # DO-NOT-EDIT-HERE.md is generated at publish time and deliberately absent from the source.
      if diff -rq --exclude=.git --exclude=.github --exclude=DO-NOT-EDIT-HERE.md \
              "$tmp/src" "$tmp/m" >/tmp/mirror-diff-$name.txt 2>&1; then
        echo "  ok: $name mirror matches source"
      else
        echo "  FAIL: $name mirror has drifted from $REF:satellites/$name/:" >&2
        sed 's/^/        /' "/tmp/mirror-diff-$name.txt" | head -10 >&2
        fail=1
      fi
    else
      echo "  WARN: could not clone $name to compare (network, or repo renamed)" >&2
    fi
    rm -rf "$tmp"
  done
fi

echo
if [ "$fail" = 0 ]; then
  echo "PASS: live sites match this repo; no satellite is serving a wrong engine."
else
  echo "FAILED — a satellite may be serving the wrong engine. See above." >&2
fi
exit $fail
