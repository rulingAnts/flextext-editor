#!/usr/bin/env bash
# Stable LOCAL dev rig — serve the editor + recorder at their PRODUCTION paths on a
# FIXED port, so the PWA origin/scope, service worker, and localStorage all persist
# across sessions (switching ports = a new origin = lost test state).
#
#   Editor:   http://localhost:8012/flextext-editor/
#   Recorder: http://localhost:8012/text-recorder/
#   Crowd:    http://localhost:8012/crowd-recorder/
#   Reset this origin's test state: append ?devreset   (e.g. .../flextext-editor/?devreset)
#
# Plain HTTP on purpose: localhost is a secure context (SW + getUserMedia still work) AND
# an HTTP page can reach the http://localhost:8787 connectivity dev worker (an HTTPS page
# can't — mixed content). For the researcher panel, also run the dev worker:
#   flextext-r2-worker/dev-worker.sh
set -euo pipefail
PORT="${1:-8012}"
MIRROR="$HOME/GIT/.flextext-devserve"          # stable (gitignored-irrelevant; lives outside the repos)
# The published site now lives in docs/ (GitHub Pages serves productionWeb:/docs), so the
# symlink that becomes /flextext-editor/ must point THERE, not at the repo root.
EDITOR="$HOME/GIT/flextext editor/docs"
RECORDER="$HOME/GIT/text-recorder"
CROWD="$HOME/GIT/crowd-recorder"
rm -rf "$MIRROR"; mkdir -p "$MIRROR"
ln -s "$EDITOR" "$MIRROR/flextext-editor"
[ -d "$RECORDER" ] && ln -s "$RECORDER" "$MIRROR/text-recorder" || echo "(note: text-recorder repo not found — editor only)"
[ -d "$CROWD" ] && ln -s "$CROWD" "$MIRROR/crowd-recorder" || echo "(note: crowd-recorder repo not found — skipping)"
echo "Serving on http://localhost:$PORT"
echo "  Editor:   http://localhost:$PORT/flextext-editor/"
echo "  Recorder: http://localhost:$PORT/text-recorder/"
echo "  Crowd:    http://localhost:$PORT/crowd-recorder/"
# Send no-store on every response so the browser NEVER caches dev assets (a plain
# `http.server` lets the browser cache css/js, which made edits appear not to land).
# With this, a normal reload always fetches fresh files — no hard-reload needed.
exec python3 - "$PORT" "$MIRROR" <<'PY'
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
PORT = int(sys.argv[1]); DIR = sys.argv[2]
class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=DIR, **k)
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()
    def send_header(self, k, v):
        if k.lower() == 'last-modified':   # drop Last-Modified so the browser can't 304 from a stale copy
            return
        super().send_header(k, v)
ThreadingHTTPServer.allow_reuse_address = True
ThreadingHTTPServer(('', PORT), H).serve_forever()
PY
