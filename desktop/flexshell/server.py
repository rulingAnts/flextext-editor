"""The local static server for the bundled engine (plan §2.2 items 1–2, §8.3).

- bound to 127.0.0.1 ONLY, fixed port (default 8017) so the origin — and with it IndexedDB — is stable
  across launches;
- the Host header must equal `127.0.0.1:<port>` (DNS-rebinding defence);
- paths are resolved and must stay inside the engine root; no directory listing;
- a CSP on every response: same-origin everything, `connect-src` additionally the relay worker
  origin(s), images/media from blob:/data: as the engine needs;
- `sw.js` is NOT served (404), so no stale engine is cached across shell upgrades (plan §12.1);
- `/__flextext_shell_nonce` answers this process's nonce, so a second launch can tell whether the
  port is held by us or by something else and refuse to start rather than fall back to another port;
- `/media/<token>`: the ONLY non-static route. Each token is a random 128-bit value registered by
  `get_media` for one existing file; range requests are honoured; tokens die with the project
  session. No file bytes ever cross js_api, and no FLEx operation has an HTTP endpoint (CSRF /
  DNS-rebinding would otherwise be able to drive it).
"""

import base64
import hashlib
import re
import mimetypes
import os
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

DEFAULT_PORT = 8017
NONCE_PATH = "/__flextext_shell_nonce"
MEDIA_PREFIX = "/media/"

mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("application/wasm", ".wasm")


_INLINE_SCRIPT = re.compile(r"<script(?![^>]*\bsrc\s*=)[^>]*>(.*?)</script>", re.IGNORECASE | re.DOTALL)


def inline_script_hashes(root):
    """'sha256-…' for every inline <script> in every .html under root, for the CSP's script-src.

    The satellite shell page sets `window.__MODE` in a classic inline script (and carries the
    staging-ribbon script); under a plain `default-src 'self'` WebView2 refused both, the engine
    booted as the editor and the home screen stayed blank (first VM launch, 2026-10-14). Hashing the
    exact script bodies keeps the CSP strict — no 'unsafe-inline' — and self-maintaining."""
    out = []
    for dirpath, _dirs, files in os.walk(root):
        for f in sorted(files):
            if not f.lower().endswith(".html"):
                continue
            try:
                with open(os.path.join(dirpath, f), "r", encoding="utf-8") as fh:
                    html = fh.read()
            except (OSError, UnicodeDecodeError):
                continue
            for body in _INLINE_SCRIPT.findall(html):
                h = "'sha256-%s'" % base64.b64encode(hashlib.sha256(body.encode("utf-8")).digest()).decode("ascii")
                if h not in out:
                    out.append(h)
    return out


def csp_for(connect_origins, script_hashes=()):
    extra = " ".join(o for o in (connect_origins or []) if o)
    hashes = " ".join(script_hashes or ())
    return ("default-src 'self'; script-src 'self'" + ((" " + hashes) if hashes else "") + "; "
            "frame-src 'self' blob:; form-action 'self'; base-uri 'self'; "
            "object-src 'none'; connect-src 'self'" + ((" " + extra) if extra else "") + "; "
            "img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; "
            "style-src 'self' 'unsafe-inline'; font-src 'self'")


class MediaRegistry:
    """token → absolute path of an existing media file. Cleared when the project closes."""

    def __init__(self):
        self._lock = threading.Lock()
        self._by_token = {}

    def register(self, path):
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        token = secrets.token_hex(16)
        with self._lock:
            self._by_token[token] = path
        return token

    def lookup(self, token):
        with self._lock:
            return self._by_token.get(token)

    def clear(self):
        with self._lock:
            self._by_token.clear()

    def __len__(self):
        with self._lock:
            return len(self._by_token)


def confine(root, url_path):
    """Resolve a request path inside `root`, or return None. '/' → index.html. No listings."""
    rel = unquote(url_path.split("?", 1)[0].split("#", 1)[0])
    if "\x00" in rel or "\\" in rel:
        return None
    rel = rel.lstrip("/")
    if rel == "" or rel.endswith("/"):
        rel = rel + "index.html"
    root_abs = os.path.realpath(root)
    full = os.path.realpath(os.path.join(root_abs, rel))
    if full != root_abs and not full.startswith(root_abs + os.sep):
        return None
    if os.path.isdir(full):
        return None   # no directory listing, and no implicit index below the root rule above
    return full


class _Handler(BaseHTTPRequestHandler):
    server_version = "FlexTextShell/0.1"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):   # paths can hold text titles (media names): never log them
        pass

    # ---- helpers -------------------------------------------------------------------------
    def _deny(self, code, body=b""):
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _host_ok(self):
        return self.headers.get("Host", "") == "127.0.0.1:%d" % self.server.server_address[1]

    def _common_headers(self, ctype, length, cacheable=False):
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Content-Security-Policy", self.server.csp)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cache-Control", "no-cache" if cacheable else "no-store")

    # ---- routes --------------------------------------------------------------------------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._host_ok():
            return self._deny(421)
        path = urlsplit(self.path).path
        if path == NONCE_PATH:
            body = self.server.nonce.encode("ascii")
            self.send_response(200)
            self._common_headers("text/plain; charset=utf-8", len(body))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
            return
        if path.startswith(MEDIA_PREFIX):
            return self._serve_media(path[len(MEDIA_PREFIX):])
        if path.rstrip("/").endswith("/sw.js") or path == "/sw.js":
            return self._deny(404)   # the shell serves no service worker (plan §12.1)
        full = confine(self.server.root, path)
        if not full or not os.path.isfile(full):
            return self._deny(404)
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json", "application/manifest+json"):
            ctype += "; charset=utf-8"
        size = os.path.getsize(full)
        self.send_response(200)
        self._common_headers(ctype, size, cacheable=True)
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(full, "rb") as f:
            while True:
                chunk = f.read(1 << 16)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def _serve_media(self, token):
        if not token or not all(c in "0123456789abcdef" for c in token) or len(token) != 32:
            return self._deny(404)
        path = self.server.media.lookup(token)
        if not path or not os.path.isfile(path):
            return self._deny(404)
        size = os.path.getsize(path)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        status = 200
        if rng and rng.startswith("bytes="):
            spec = rng[6:].split(",")[0].strip()
            a, _, b = spec.partition("-")
            try:
                if a == "":
                    n = int(b)
                    start = max(0, size - n)
                else:
                    start = int(a)
                    if b:
                        end = min(size - 1, int(b))
            except ValueError:
                return self._deny(416)
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % size)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        length = end - start + 1
        self.send_response(status)
        self._common_headers(ctype, length)
        self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(1 << 16, left))
                if not chunk:
                    break
                left -= len(chunk)
                self.wfile.write(chunk)

    def do_POST(self):
        self._deny(405)

    do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_POST


class ShellServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False   # a taken port must be DETECTED, never silently shared

    def __init__(self, root, port=DEFAULT_PORT, connect_origins=(), media=None):
        self.root = os.path.realpath(root)
        self.nonce = secrets.token_hex(16)
        self.csp = csp_for(connect_origins, inline_script_hashes(self.root))
        self.media = media or MediaRegistry()
        super().__init__(("127.0.0.1", int(port)), _Handler)

    @property
    def port(self):
        return self.server_address[1]

    @property
    def origin(self):
        return "http://127.0.0.1:%d" % self.port

    def serve_in_thread(self):
        t = threading.Thread(target=self.serve_forever, name="flexshell-http", daemon=True)
        t.start()
        return t


def probe_nonce(port, timeout=1.0):
    """What holds the port? → the nonce string, or None if nothing answers our route."""
    import http.client
    try:
        c = http.client.HTTPConnection("127.0.0.1", int(port), timeout=timeout)
        c.request("GET", NONCE_PATH, headers={"Host": "127.0.0.1:%d" % int(port)})
        r = c.getresponse()
        body = r.read().decode("ascii", "replace")
        c.close()
        return body if r.status == 200 and len(body) == 32 else None
    except OSError:
        return None


def start(root, port=DEFAULT_PORT, connect_origins=(), media=None):
    """Start the server, or raise OSError with a clear message if the port is held by something
    that is not this process (never fall back to another port: that would be a new origin and an
    empty IndexedDB for the user)."""
    try:
        srv = ShellServer(root, port, connect_origins, media)
    except OSError as e:
        other = probe_nonce(port)
        if other:
            raise OSError("Port %d is held by another FlexText Segmenter for FLEx (nonce %s…). "
                          "Close it first." % (port, other[:6])) from e
        raise OSError("Port %d is in use by another program. The shell needs this exact port so "
                      "your Segmenter data stays with its origin; free the port or change it in "
                      "settings." % port) from e
    srv.serve_in_thread()
    return srv
