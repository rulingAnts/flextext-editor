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

# ⚠ THE POINT OF INTERCEPTION. Starting a dev server is the moment before coding, which is the only
# moment a staleness warning can still save the work rather than describe its loss. Warn-only and
# non-blocking on purpose: offline is normal here, and a dev server that refuses to start because a
# laptop is on a plane would be turned off, not obeyed.
[ -x "$(dirname "$0")/check-freshness.sh" ] && "$(dirname "$0")/check-freshness.sh" --warn --quiet
PORT="${1:-8012}"
SELF="$(cd "$(dirname "$0")" && pwd)"
MIRROR="$HOME/GIT/.flextext-devserve-$PORT"    # PER-PORT: a second instance must not re-point this one's symlinks
# The published site now lives in docs/ (GitHub Pages serves productionWeb:/docs), so the
# symlink that becomes /flextext-editor/ must point THERE, not at the repo root.
# FLEXTEXT_DOCS overrides the source — e.g. serve a git WORKTREE of another branch:
#   FLEXTEXT_DOCS="$HOME/GIT/flextext-staging-test/docs" bash dev-serve.sh 8012
#
# ⚠⚠ THE DEFAULT IS THE CHECKOUT THIS SCRIPT LIVES IN, not a hardcoded $HOME path. It used to be
# "$HOME/GIT/flextext editor/docs", which meant running it FROM A WORKTREE served the MAIN checkout
# instead — the branch you were testing was never loaded, and nothing said so. On 2026-08-23 that
# silently served v441 while the branch under test was v443; the on-screen version badge is the only
# reason it was caught, and only because the two numbers disagreed.
#
# Deriving it from the script's own location makes the common case correct by construction: a
# worktree serves ITS OWN docs/. FLEXTEXT_DOCS still overrides for the deliberate cross-checkout case.
# ⚠ Trust the version badge over your memory of which port is which — that is what it is for.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EDITOR="${FLEXTEXT_DOCS:-$SELF_DIR/docs}"
RECORDER="$HOME/GIT/text-recorder"
CROWD="$HOME/GIT/crowd-recorder"
# The paragraph-analysis shell lives BESIDE docs/ in the same checkout, so follow whatever
# checkout FLEXTEXT_DOCS points at (a worktree's docs ⇒ that worktree's shell).
PARAGRAPH="${FLEXTEXT_PARAGRAPH:-$(dirname "$EDITOR")/paragraph-analysis}"
rm -rf "$MIRROR"; mkdir -p "$MIRROR"
ln -s "$EDITOR" "$MIRROR/flextext-editor"
[ -d "$RECORDER" ] && ln -s "$RECORDER" "$MIRROR/text-recorder" || echo "(note: text-recorder repo not found — editor only)"
[ -d "$CROWD" ] && ln -s "$CROWD" "$MIRROR/crowd-recorder" || echo "(note: crowd-recorder repo not found — skipping)"
[ -d "$PARAGRAPH" ] && ln -s "$PARAGRAPH" "$MIRROR/paragraph-analysis" || echo "(note: paragraph-analysis shell not found — skipping)"
# The two newest satellites live IN THIS REPO under satellites/, so unlike the recorder they need
# no sibling clone — link them straight from the tree being edited.
ln -s "$SELF/satellites/consent-collector" "$MIRROR/consent-collector"
ln -s "$SELF/satellites/audio-segmenter"   "$MIRROR/audio-segmenter"
echo "Serving on http://localhost:$PORT"
echo "  Editor:    http://localhost:$PORT/flextext-editor/"
echo "  Recorder:  http://localhost:$PORT/text-recorder/"
echo "  Consent:   http://localhost:$PORT/consent-collector/"
echo "  Segmenter: http://localhost:$PORT/audio-segmenter/"
echo "  Crowd:     http://localhost:$PORT/crowd-recorder/"
echo "  Paragraph: http://localhost:$PORT/paragraph-analysis/"
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
