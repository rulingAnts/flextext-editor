#!/usr/bin/env bash
# Enforce the JS<->native containment rule.
#
#   ./check-native-containment.sh
#
# WHY: the Flextext native apps (android/ and electron/) wrap this engine. The engine
# auto-updates; the APK and the desktop installer do NOT. So native-facing code is confined to ONE
# file — docs/js/native-audio.js — and everything else in the engine must be unaware they exist.
# If a future change scatters `window.Capacitor` or `window.__flextextNative` references around the
# engine, an unrelated refactor can silently break installed field apps that cannot be patched
# without shipping a new build.
#
# Run this after touching capture/recording code. Exit 0 = contained.
set -uo pipefail
cd "$(dirname "$0")"

CHOKEPOINT="docs/js/native-audio.js"
fail=0

echo "== native containment check =="

# 1. Only the chokepoint may reference the Capacitor bridge.
offenders=$(grep -rln "window\.Capacitor\|Capacitor\.Plugins" docs/js/ 2>/dev/null | grep -v "^$CHOKEPOINT$" || true)
if [ -n "$offenders" ]; then
  echo "FAIL: files outside $CHOKEPOINT reference the Capacitor bridge:" >&2
  echo "$offenders" | sed 's/^/  - /' >&2
  echo "  Move that code into $CHOKEPOINT and call it through the exported interface." >&2
  fail=1
else
  echo "  ok: only $CHOKEPOINT touches the Capacitor bridge"
fi

# 1b. Same rule for the DESKTOP bridge global that the Electron preload exposes.
offenders=$(grep -rln "__flextextNative" docs/js/ 2>/dev/null | grep -v "^$CHOKEPOINT$" || true)
if [ -n "$offenders" ]; then
  echo "FAIL: files outside $CHOKEPOINT reference the desktop native bridge:" >&2
  echo "$offenders" | sed 's/^/  - /' >&2
  echo "  Move that code into $CHOKEPOINT and call it through the exported interface." >&2
  fail=1
else
  echo "  ok: only $CHOKEPOINT touches the desktop bridge"
fi

# 2. The chokepoint must still exist and still carry its warning header.
if [ ! -f "$CHOKEPOINT" ]; then
  echo "FAIL: $CHOKEPOINT is missing — the native apps depend on it." >&2
  fail=1
elif ! grep -q "THE ENGINE AUTO-UPDATES. THE APK DOES NOT" "$CHOKEPOINT"; then
  echo "FAIL: $CHOKEPOINT lost its warning header; restore it (it is the guard rail)." >&2
  fail=1
else
  echo "  ok: $CHOKEPOINT present with its warning header"
fi

# 3. The contract version the engine speaks must be stated exactly once.
n=$(grep -c "EXPECTED_CONTRACT = " "$CHOKEPOINT" 2>/dev/null || echo 0)
if [ "$n" != "1" ]; then
  echo "FAIL: expected exactly one EXPECTED_CONTRACT declaration in $CHOKEPOINT (found $n)." >&2
  fail=1
else
  echo "  ok: contract version declared once ($(grep -oE 'EXPECTED_CONTRACT = [0-9]+' "$CHOKEPOINT"))"
fi

# 4. Native captures must be absorbed via convertFileSrc+fetch, never Filesystem.readFile
#    (base64 through the bridge would OOM on a large capture). Match only real CALLS: skip
#    vendor code, and skip comment lines — the chokepoint documents this rule in prose, and a
#    check that cries wolf at its own documentation is a check people learn to ignore.
readfile_hits=$(grep -rn "Filesystem\.readFile" docs/js/ 2>/dev/null \
  | grep -v "^docs/js/vendor/" \
  | grep -vE "^[^:]+:[0-9]+:\s*(\*|//|/\*)" || true)
if [ -n "$readfile_hits" ]; then
  echo "WARN: Filesystem.readFile is called — native captures must use convertFileSrc + fetch" >&2
  echo "$readfile_hits" | sed 's/^/  /' >&2
fi

[ "$fail" = 0 ] && echo "PASS: native boundary is contained." || echo "FAILED — see above." >&2
exit $fail
