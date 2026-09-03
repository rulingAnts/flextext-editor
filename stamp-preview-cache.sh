#!/usr/bin/env bash
# Give a PREVIEW build's service worker a cache name nobody else has used.
#
#   stamp-preview-cache.sh public/sw.js
#
# ⚠ THE PROBLEM THIS SOLVES IS A TEST THAT LIES.
#
# Each shell's cache is keyed by VERSION alone (`const CACHE = 'audio-segmenter-' + VERSION`) and
# the fetch handler is cache-first. A service worker is only reinstalled when sw.js CHANGES BYTES —
# so a staging deploy that does not touch VERSION leaves every browser that has already opened the
# app serving the OLD files, for ever, with no error and no banner.
#
# For a RELEASE that is harmless: bump-version.sh changes VERSION every time, which is exactly what
# the header of each sw.js instructs. For STAGING it is not, because staging is deployed many times
# a day under one version — and the failure mode is the worst kind. On 2026-09-03 it twice served me
# yesterday's engine while I was "verifying" that morning's fix; the first time I concluded the
# deploy had failed, the second time I nearly concluded the fix had. A test rig that silently tests
# stale code is worse than no test rig, because it produces confident wrong answers.
#
# So: on any branch that is not productionWeb, append the commit to the CACHE NAME ONLY. That makes
# sw.js byte-different per commit, which makes the browser reinstall it, which makes a new cache.
#
# ⚠ VERSION AND ENGINE ARE NOT TOUCHED. ENGINE is the sentinel each SW checks the fetched engine
# against at install (SENTINEL_RE), and VERSION is what version-sync.test.mjs pins across five
# files. Only the cache KEY changes, and only in builds that can never reach production.
#
# ⚠ PRODUCTION IS DELIBERATELY EXEMPT. Stamping there would give every user a fresh cache on every
# deploy even when nothing they hold has changed — re-downloading the engine over a village
# connection to receive the same bytes. Production bumps on purpose; that is the whole ritual.
set -euo pipefail

SW="${1:?usage: stamp-preview-cache.sh <path to built sw.js>}"
[ -f "$SW" ] || exit 0

BRANCH="${WORKERS_CI_BRANCH:-productionWeb}"
[ "$BRANCH" = "productionWeb" ] && exit 0

# The researcher shell is deliberately not offline-cached and has no CACHE line. Nothing to do.
grep -q '^const CACHE = ' "$SW" || exit 0

# Stable for a given commit (re-deploying the same code must not churn every device's cache),
# different across commits (which is the entire point).
STAMP="${WORKERS_CI_COMMIT_SHA:-$(git rev-parse --short=8 HEAD 2>/dev/null || true)}"
[ -n "$STAMP" ] || STAMP="$(cksum "$SW" | cut -d' ' -f1)"
# ⚠ tr -cd (DELETE), not -c (REPLACE): replacing turned the trailing newline into a '-' and the
# stamp came out "146ed9f2-". Then cut, so a long CI sha cannot make the cache name unwieldy.
STAMP="$(printf '%s' "$STAMP" | tr -cd 'a-zA-Z0-9' | cut -c1-8)"
[ -n "$STAMP" ] || exit 0

# ⚠ MATCH UP TO THE FIRST ';', NOT TO END-OF-LINE. `.*?;\s*$` consumed the newline as well, which
# glued the next statement onto this one ("...;const SHELL = ["). Valid JS, unreadable file, and the
# next stamping would have matched the wrong thing.
perl -pi -e "s/^(const CACHE = [^;]*);/\$1 + '-$STAMP';/" "$SW"
echo "preview cache stamped: $(grep -m1 '^const CACHE = ' "$SW")"
