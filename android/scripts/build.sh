#!/usr/bin/env bash
# Build a Flextext native app.
#
#   scripts/build.sh recorder                 # normal build (bundled web engine)
#   scripts/build.sh editor
#   scripts/build.sh recorder --diagnostic    # swap in tools/diagnostic instead of the engine
#
# STALE-BUILD TRAP (bit us 2026-07-20): the shared plugin is SYMLINKED into apps/*/node_modules,
# and Gradle's up-to-date check does not see edits through the symlink — it will happily report
# "UP-TO-DATE" in 1s and package the PREVIOUS native code. So we always force the plugin module to
# recompile, then ASSERT the native classes are really in the packaged dex.
set -euo pipefail

APP_NAME="${1:-}"
MODE="${2:-}"
case "$APP_NAME" in
  recorder|editor) ;;
  *) echo "usage: $(basename "$0") <recorder|editor> [--diagnostic]" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/apps/$APP_NAME"
[ -d "$APP/android" ] || { echo "no android project at $APP — run 'npx cap add android' there first" >&2; exit 1; }

export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

rm -rf "$APP/www"; mkdir -p "$APP/www"
if [ "$MODE" = "--diagnostic" ]; then
  cp "$ROOT/tools/diagnostic/index.html" "$APP/www/index.html"
  echo "web payload: capability diagnostic"
elif [ -x "$ROOT/scripts/bundle-engine.sh" ]; then
  "$ROOT/scripts/bundle-engine.sh" "$APP_NAME"
  echo "web payload: bundled editor engine"
else
  # Engine bundling not built yet — keep the placeholder so the shell still compiles and runs.
  printf '<!doctype html><meta charset="utf-8"><title>Flextext</title><p>placeholder — engine bundled at build time</p>\n' > "$APP/www/index.html"
  echo "web payload: PLACEHOLDER (scripts/bundle-engine.sh not present yet)"
fi

cd "$APP" && npx cap sync android >/dev/null

cd "$APP/android"
./gradlew :flextext-native-audio:compileDebugJavaWithJavac --rerun-tasks --no-configuration-cache -q
./gradlew assembleDebug --no-configuration-cache -q

APK="$APP/android/app/build/outputs/apk/debug/app-debug.apk"
echo "APK: $APK"

# NOTE: use grep -c, NOT grep -q. Under `set -o pipefail`, grep -q exits on the first match and
# SIGPIPEs unzip upstream, so the pipeline reports failure and this check produces a FALSE
# "missing" — timing-dependent, so it passes on one app and fails on another. grep -c consumes
# all input, and `|| true` absorbs grep's exit-1-on-no-match.
missing=0
for cls in FlextextAudioPlugin RecordingService; do
  n=$(unzip -p "$APK" 'classes*.dex' 2>/dev/null | strings | grep -c "$cls" || true)
  if [ "${n:-0}" -gt 0 ]; then
    echo "  ok: $cls present in packaged dex ($n refs)"
  else
    echo "  WARNING: $cls NOT in the APK — build may be stale" >&2
    missing=1
  fi
done
exit $missing
