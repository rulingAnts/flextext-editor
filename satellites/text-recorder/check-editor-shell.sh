#!/usr/bin/env bash
# Verify every editor-owned file in this app's service-worker SHELL is ACTUALLY LIVE before we
# push this repo.
#
# WHY THIS EXISTS (a real breakage, 2026-07-20):
# This app's sw.js precaches engine files from the editor BY PATH. Editor v108 added
# js/native-audio.js; the satellites were pushed while that editor commit was still sitting on
# `main`, undeployed. Live result: /flextext-editor/js/native-audio.js returned 404 while this
# app's SW listed it. precacheAll() retries 3x then THROWS, inside install's waitUntil — so the
# service-worker install FAILS. Existing installs got stuck on the old SW; NEW installs got no
# precached shell at all, i.e. they silently lost offline support — the entire point of a field app.
#
# The old rule ("bump the satellite sw when the engine changes") was necessary but insufficient:
# it says BUMP, it never said VERIFY THE FILE EXISTS FIRST. This script is that missing half.
#
#   ./check-editor-shell.sh            # check against production
#   BASE=http://localhost:8012 ./check-editor-shell.sh
#
# Exit 0 = every referenced engine file is live. Non-zero = DO NOT PUSH.
set -uo pipefail

BASE="${BASE:-https://rulingants.github.io}"
SW="$(dirname "$0")/sw.js"
[ -f "$SW" ] || { echo "check-editor-shell: no sw.js next to this script" >&2; exit 2; }

# Pull the '/flextext-editor/...' entries out of the SHELL array.
paths=$(grep -oE "'/flextext-editor/[^']+'" "$SW" | tr -d "'" | sort -u)
[ -n "$paths" ] || { echo "check-editor-shell: no editor paths in SHELL — nothing to verify"; exit 0; }

fail=0; n=0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  n=$((n+1))
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$p?cb=$RANDOM" || echo "000")
  if [ "$code" != "200" ]; then
    echo "  MISSING ($code): $BASE$p" >&2
    fail=1
  fi
done <<< "$paths"

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'MSG'

BLOCKED: this app's service worker precaches engine files that are NOT live yet.
Pushing now would make the SW install fail — new installs would lose offline support.

FIX: deploy the editor FIRST (its productionWeb must be live and serving these paths),
confirm with this script, and only then push this repo.

  cd "../flextext editor" && git checkout productionWeb && git merge --ff-only main \
    && ALLOW_MAIN_PUSH=1 git push origin productionWeb && git checkout main

Override only if you genuinely know why:  ALLOW_STALE_SHELL=1 git push ...
MSG
  exit 1
fi

echo "check-editor-shell: OK — all $n editor SHELL paths are live on $BASE"
