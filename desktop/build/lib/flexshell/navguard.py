"""The navigation policy, as a PURE function (plan §2.2 item 4). Nothing here touches WebView2;
webview_hooks.py wires `decide` to the CoreWebView2 events on Windows. Fail-closed: anything this
function does not positively recognise as our own origin is refused.

Seth's content-filter rule: the shell is not a browser. Only http://127.0.0.1:<port>/ content is
shown; a top-level http(s) navigation elsewhere is handed to the OS default browser (which the
device's filtering governs) and nothing else is ever opened. """

from urllib.parse import urlsplit, unquote

ALLOW = "allow"
OPEN_EXTERNAL = "open_external"
REFUSE = "refuse"

# `kind` values, one per WebView2 event we hook.
KIND_TOP = "top"            # NavigationStarting on the top frame
KIND_FRAME = "frame"        # FrameNavigationStarting
KIND_NEW_WINDOW = "new_window"   # NewWindowRequested
KIND_DOWNLOAD = "download"  # DownloadStarting (url = the download source)
KINDS = (KIND_TOP, KIND_FRAME, KIND_NEW_WINDOW, KIND_DOWNLOAD)


def own_origin(port):
    return "http://127.0.0.1:%d" % int(port)


def _is_own_http(url, port):
    """True only for http://127.0.0.1:<port>/… spelled plainly.

    Everything that could make a different host LOOK like ours is refused by construction:
    userinfo (our host and port placed before an `@`, so the real host is elsewhere), a different port, `localhost` or `[::1]` (another
    origin for IndexedDB even when it is the same machine), a longer host that begins with our
    address (`127.0.0.1.evil.example`), percent-encoding and letter case in the host, IDN hosts.
    """
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    if parts.scheme != "http":
        return False
    netloc = parts.netloc
    if "@" in netloc:          # userinfo trick: the real host is after the @
        return False
    if netloc != "127.0.0.1:%d" % int(port):
        return False
    if parts.hostname != "127.0.0.1" or parts.port != int(port):
        return False
    # the path must not escape with a percent-encoded or raw scheme separator
    if "\\" in parts.path:
        return False
    return True


def _is_own_blob_or_data(url, port, kind):
    """blob:/data: URLs are allowed ONLY as frames (or downloads) created by our own origin.
    A blob URL carries its creating origin: `blob:http://127.0.0.1:8017/<uuid>`."""
    if url.startswith("blob:"):
        inner = url[len("blob:"):]
        return _is_own_http(inner, port) and kind in (KIND_FRAME, KIND_DOWNLOAD)
    if url.startswith("data:"):
        # a data: frame has no origin; it is allowed only as a sub-frame, never top-level
        return kind == KIND_FRAME
    return False


def _is_http_s(url):
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and bool(parts.netloc)


def decide(url, kind, port):
    """→ 'allow' | 'open_external' | 'refuse'.

    kind == 'top'/'frame':     own origin → allow; about:blank → allow; blob:/data: frame of our
                               origin → allow; other http(s) TOP-LEVEL → open_external (and the
                               navigation itself is cancelled by the caller); everything else → refuse.
    kind == 'new_window':      never a second webview: http(s) → open_external, else refuse.
    kind == 'download':        only blob: from our origin (the engine's own exports) → allow.
    """
    if kind not in KINDS:
        return REFUSE
    if not isinstance(url, str) or not url:
        return REFUSE
    # judged on the RAW string: a control character anywhere, or a backslash (never part of a URL
    # WebView2 has normalised; in ours it can only be an escape attempt), refuses outright
    if any(ch in url for ch in "\r\n\t\x00\\"):
        return REFUSE
    u = url.strip()
    if not u:
        return REFUSE
    if kind == KIND_DOWNLOAD:
        return ALLOW if _is_own_blob_or_data(u, port, kind) and u.startswith("blob:") else REFUSE
    if kind == KIND_NEW_WINDOW:
        if _is_own_http(u, port):
            return REFUSE            # our own page in a second window: no second webview, ever
        return OPEN_EXTERNAL if _is_http_s(u) else REFUSE
    # top or frame
    if u == "about:blank":
        return ALLOW
    if _is_own_http(u, port):
        return ALLOW
    if _is_own_blob_or_data(u, port, kind):
        return ALLOW
    if kind == KIND_TOP and _is_http_s(u):
        return OPEN_EXTERNAL
    return REFUSE


def external_url_ok(url):
    """What open_external() will hand to the OS: http(s) with a host, nothing else (plan §3)."""
    return isinstance(url, str) and _is_http_s(url.strip()) and not any(c in url for c in "\r\n\x00")
