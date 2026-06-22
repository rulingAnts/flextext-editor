#!/usr/bin/env bash
# Stable LOCAL dev rig — serve the editor + recorder at their PRODUCTION paths on a
# FIXED port, so the PWA origin/scope, service worker, and localStorage all persist
# across sessions (switching ports = a new origin = lost test state).
#
#   Editor:   http://localhost:8012/flextext-editor/
#   Recorder: http://localhost:8012/text-recorder/
#   Reset this origin's test state: append ?devreset   (e.g. .../flextext-editor/?devreset)
#
# Plain HTTP on purpose: localhost is a secure context (SW + getUserMedia still work) AND
# an HTTP page can reach the http://localhost:8787 connectivity dev worker (an HTTPS page
# can't — mixed content). For the researcher panel, also run the dev worker:
#   flextext-r2-worker/dev-worker.sh
set -euo pipefail
PORT="${1:-8012}"
MIRROR="$HOME/GIT/.flextext-devserve"          # stable (gitignored-irrelevant; lives outside the repos)
EDITOR="$HOME/GIT/flextext editor"
RECORDER="$HOME/GIT/text-recorder"
rm -rf "$MIRROR"; mkdir -p "$MIRROR"
ln -s "$EDITOR" "$MIRROR/flextext-editor"
[ -d "$RECORDER" ] && ln -s "$RECORDER" "$MIRROR/text-recorder" || echo "(note: text-recorder repo not found — editor only)"
echo "Serving on http://localhost:$PORT"
echo "  Editor:   http://localhost:$PORT/flextext-editor/"
echo "  Recorder: http://localhost:$PORT/text-recorder/"
exec python3 -m http.server "$PORT" --directory "$MIRROR"
