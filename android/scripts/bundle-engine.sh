#!/usr/bin/env bash
# Bundle the shared web engine from the flextext-editor repo into an app's www/.
#
#   scripts/bundle-engine.sh <recorder|editor>
#
# WHY A PINNED SNAPSHOT: the PWAs load the engine live over one origin; a native app cannot. We
# copy a snapshot at BUILD time, so an APK carries a fixed engine version. Re-run this + rebuild
# when you want the APK to pick up engine changes (later this is what the OTA bundle replaces).
#
# The file list mirrors the editor service worker's SHELL — that is the authoritative inventory of
# what the engine needs offline. If sw.js SHELL gains a file, add it here too, or the native app
# will 404 it at runtime (a missing static import makes the app dead on launch).
set -euo pipefail

APP_NAME="${1:-}"
case "$APP_NAME" in
  recorder|editor) ;;
  *) echo "usage: $(basename "$0") <recorder|editor>" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The engine now lives in THIS repo at docs/ (GitHub Pages serves productionWeb:/docs).
# It used to be a sibling repo; that indirection is gone since the consolidation.
ENGINE_SRC="${FLEXTEXT_EDITOR_DIR:-$(cd "$ROOT/.." && pwd)/docs}"
[ -d "$ENGINE_SRC/js" ] || { echo "engine source not found at: $ENGINE_SRC" >&2
                             echo "set FLEXTEXT_EDITOR_DIR to override" >&2; exit 1; }

WWW="$ROOT/apps/$APP_NAME/www"
rm -rf "$WWW"; mkdir -p "$WWW"

# Engine files (mirrors sw.js SHELL, minus PWA-only bits: sw.js, manifests, record/relay shims).
cp -R "$ENGINE_SRC/js"    "$WWW/js"
cp -R "$ENGINE_SRC/css"   "$WWW/css"
cp -R "$ENGINE_SRC/icons" "$WWW/icons"
[ -d "$ENGINE_SRC/help" ] && cp -R "$ENGINE_SRC/help" "$WWW/help" || true

# Record the exact engine commit so a built APK is traceable to a source revision.
ENGINE_REV="$(git -C "$ENGINE_SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
ENGINE_VER="$(grep -oE "ENGINE_VERSION = '[^']+'" "$ENGINE_SRC/js/i18n.js" | grep -oE "v[0-9]+" || echo unknown)"

# The native shell. Deliberately NOT the PWA index.html:
#   - no <link rel="manifest">  (nothing to "install" from inside an installed app)
#   - no service worker         (assets are bundled; a SW would only add a stale-cache failure mode)
#   - sets window.__NATIVE      (the engine skips SW setup and enables the native capture backend)
#   - recorder additionally sets window.__MODE='record'
MODE_LINE=""
TITLE="Flextext Editor"
if [ "$APP_NAME" = "recorder" ]; then
  MODE_LINE="window.__MODE = 'record';"
  TITLE="Flextext Recorder"
fi

cat > "$WWW/index.html" <<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>$TITLE</title>
<link rel="stylesheet" href="css/app.css">
<script>
  // Native shell markers — read by the engine. See CLAUDE.md "THE JS<->NATIVE CONTRACT".
  window.__NATIVE = 'android';
  window.__NATIVE_ENGINE = { version: '$ENGINE_VER', rev: '$ENGINE_REV' };
  $MODE_LINE
</script>
</head>
<body>
<script src="js/vendor/lame.min.js" defer></script>
<script type="module" src="js/app.js"></script>
</body>
</html>
HTML

# The engine's markup lives in the PWA index.html, which the engine expects to exist. Splice in
# everything inside <body> (minus its script tags, which we declare above) so the native shell has
# the same DOM the engine builds against.
python3 - "$ENGINE_SRC/index.html" "$WWW/index.html" "$APP_NAME" <<'PY'
import re, sys, io
src, dst, app = sys.argv[1], sys.argv[2], sys.argv[3]
html = io.open(src, encoding='utf-8').read()
m = re.search(r'<body[^>]*>(.*)</body>', html, re.S)
if not m:
    print("could not find <body> in the editor index.html", file=sys.stderr); sys.exit(1)
body = m.group(1)
body = re.sub(r'<script\b.*?</script>', '', body, flags=re.S)   # our shell declares its own scripts
if app == 'recorder':
    # The spliced markup is the EDITOR's, so its header would read "Flextext Editor" inside the
    # recorder app — confusing for a coworker who only ever sees one of the two. Mirror the real
    # recorder shell's title span (i18n key record.appName) so it localises like everything else.
    body, n = re.subn(r'<span class="app-title">.*?</span>',
                      '<span class="app-title" data-i18n="record.appName">Flextext Recorder</span>',
                      body, count=1, flags=re.S)
    if not n:
        print("WARNING: could not retitle the header for the recorder", file=sys.stderr)
out = io.open(dst, encoding='utf-8').read()
out = out.replace('<body>\n', '<body>\n' + body + '\n')
io.open(dst, 'w', encoding='utf-8').write(out)
PY

echo "bundled engine $ENGINE_VER ($ENGINE_REV) -> apps/$APP_NAME/www"
