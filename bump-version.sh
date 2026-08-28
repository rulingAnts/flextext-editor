#!/usr/bin/env bash
# Bump ALL FIVE version sites to an explicit engine version — the ONLY sanctioned way to bump.
#
#   ./bump-version.sh v168
#
# WHY EXPLICIT-SET AND NOT sed-from-previous: on 2026-08-04 a sed chain keyed on the PREVIOUS
# version ("s/v167'/v168'/") silently no-opped because the earlier bump it assumed had itself
# been swallowed by an interrupted command — two releases shipped labelled v167/v168 in git
# while every file still said v166, and version-sync could not catch it (it checks that the
# sites AGREE, not what they say). This script sets the target value regardless of what is
# there now — on EVERY site, satellites included — and FAILS if any did not change to the
# requested value.
#
# Since 2026-08-28 the satellites carry the SAME number rather than their own +1 counters, so
# version-sync now asserts all five are EQUAL, not merely parseable. That closes the gap named
# above: "it checks that the sites AGREE, not what they say" is no longer true of the satellites.
set -euo pipefail
cd "$(dirname "$0")"
V="${1:?usage: ./bump-version.sh vNNN}"
[[ "$V" =~ ^v[0-9]+$ ]] || { echo "not a version: $V" >&2; exit 1; }

perl -pi -e "s/const VERSION = 'v\\d+';/const VERSION = '$V';/" docs/sw.js
perl -pi -e "s/export const ENGINE_VERSION = 'v\\d+';/export const ENGINE_VERSION = '$V';/" docs/js/i18n.js
# ⚠ EXPLICIT-SET FOR THE SATELLITES TOO (Seth, 2026-08-28). This loop used to read the satellite's
# current number and write back cur+1 — the LAST surviving instance of the exact read-modify-write
# this script's header says was abandoned, and for the same reason: a value derived from what is
# already in the file is a value that can silently derive from the wrong thing. It also produced two
# number lines (recorder v419 beside engine v477), which the panel's live banner then invited people
# to compare — a false "catastrophically behind" alarm on a device that was current.
#
# Every site now carries ONE number, set explicitly, and version-sync asserts they are equal rather
# than merely parseable — the check that would have caught the 2026-08-04 v166 drift.
for sat in satellites/text-recorder/sw.js satellites/flextext-researcher/sw.js paragraph-analysis/sw.js; do
  perl -pi -e "s/const VERSION = 'v\\d+';/const VERSION = '$V';/" "$sat"
  perl -pi -e "s/const ENGINE = 'v\\d+';/const ENGINE = '$V';/" "$sat"
done

fail=0
grep -q "const VERSION = '$V';" docs/sw.js            || { echo "FAIL: docs/sw.js not at $V" >&2; fail=1; }
grep -q "ENGINE_VERSION = '$V';" docs/js/i18n.js      || { echo "FAIL: i18n not at $V" >&2; fail=1; }
# BOTH constants, on every satellite — VERSION as well as ENGINE, now that they are one number.
# Checking only ENGINE would let a satellite's VERSION silently miss the set and leave its installed
# service worker convinced it is already current.
for sat in satellites/text-recorder/sw.js satellites/flextext-researcher/sw.js paragraph-analysis/sw.js; do
  grep -q "const VERSION = '$V';" "$sat" || { echo "FAIL: $sat VERSION not at $V" >&2; fail=1; }
  grep -q "const ENGINE = '$V';"  "$sat" || { echo "FAIL: $sat ENGINE not at $V" >&2; fail=1; }
done
[ "$fail" = 0 ] || exit 1
node test/version-sync.test.mjs >/dev/null || { echo "FAIL: version-sync test" >&2; exit 1; }
tag=$(grep -m1 -oE "export const BUILD_TAG = '[^']*'" docs/js/i18n.js | sed "s/.*= '//;s/'$//")
if [ -n "$tag" ]; then
  echo "⚠ BUILD_TAG is set to \"$tag\" — this build shows that name instead of the bare version."
  echo "  A PRODUCTION release must clear it:  BUILD_TAG = ''  in docs/js/i18n.js"
fi
echo "all five sites at $V (one number line — any straggler below is a bug):"
grep -h "const VERSION = \|ENGINE" docs/sw.js docs/js/i18n.js satellites/*/sw.js paragraph-analysis/sw.js | grep -oE "'v[0-9]+'" | sort | uniq -c
