#!/usr/bin/env bash
# Bump ALL FOUR version sites to an explicit engine version — the ONLY sanctioned way to bump.
#
#   ./bump-version.sh v168
#
# WHY EXPLICIT-SET AND NOT sed-from-previous: on 2026-08-04 a sed chain keyed on the PREVIOUS
# version ("s/v167'/v168'/") silently no-opped because the earlier bump it assumed had itself
# been swallowed by an interrupted command — two releases shipped labelled v167/v168 in git
# while every file still said v166, and version-sync could not catch it (it checks that the
# sites AGREE, not what they say). This script sets the target value regardless of what is
# there now, bumps each satellite's own VERSION by one, and FAILS if any site did not change
# to the requested value.
set -euo pipefail
cd "$(dirname "$0")"
V="${1:?usage: ./bump-version.sh vNNN}"
[[ "$V" =~ ^v[0-9]+$ ]] || { echo "not a version: $V" >&2; exit 1; }

perl -pi -e "s/const VERSION = 'v\\d+';/const VERSION = '$V';/" docs/sw.js
perl -pi -e "s/export const ENGINE_VERSION = 'v\\d+';/export const ENGINE_VERSION = '$V';/" docs/js/i18n.js
for sat in satellites/text-recorder/sw.js satellites/flextext-researcher/sw.js; do
  cur=$(grep -m1 -oE "const VERSION = 'v[0-9]+'" "$sat" | grep -oE '[0-9]+')
  perl -pi -e "s/const VERSION = 'v\\d+';/const VERSION = 'v$((cur + 1))';/" "$sat"
  perl -pi -e "s/const ENGINE = 'v\\d+';/const ENGINE = '$V';/" "$sat"
done

fail=0
grep -q "const VERSION = '$V';" docs/sw.js            || { echo "FAIL: docs/sw.js not at $V" >&2; fail=1; }
grep -q "ENGINE_VERSION = '$V';" docs/js/i18n.js      || { echo "FAIL: i18n not at $V" >&2; fail=1; }
grep -q "const ENGINE = '$V';" satellites/text-recorder/sw.js       || { echo "FAIL: recorder ENGINE" >&2; fail=1; }
grep -q "const ENGINE = '$V';" satellites/flextext-researcher/sw.js || { echo "FAIL: researcher ENGINE" >&2; fail=1; }
[ "$fail" = 0 ] || exit 1
node test/version-sync.test.mjs >/dev/null || { echo "FAIL: version-sync test" >&2; exit 1; }
echo "all four sites at $V:"
grep -h "const VERSION = \|ENGINE" docs/sw.js docs/js/i18n.js satellites/*/sw.js | grep -oE "'v[0-9]+'" | sort | uniq -c
