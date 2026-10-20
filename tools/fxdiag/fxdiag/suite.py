"""What the FlexText suite keeps in a browser, and how to tell it from everything else in a profile.

One origin, several apps: on GitHub Pages the editor, recorder, crowd recorder and researcher panel all
live on rulingants.github.io at different paths — ONE profile origin, one IndexedDB folder. On the
Cloudflare estate each app is its own host (app. / record. / crowd. / research. / audio-segmenter. /
consent. / pat. and the beta- twins), and the preview estates are *.workers.dev. Dev rigs are
localhost. Database names start with `flextext` (db.js, sync.js, files.js, the crowd store), as do
localStorage keys. A key whose name says it holds a credential is listed as PRESENT, never copied.
"""

import re

DOCS_DB = "flextext-editor"          # db.js: stores 'docs' (keyPath id) and 'media' (blobs + peaks by doc id)
DB_PREFIX = "flextext"
KEY_PREFIX = "flextext-"
SETTINGS_KEY = "flextext-ws-settings"

# a localStorage key whose NAME says it carries something that must not travel: recorded as present + length
_SENSITIVE = re.compile(r"auth|session|unlock|acct|secret|token|cred|password|key$|-key", re.I)

_WORKERS = re.compile(r"^(?:[a-z0-9-]+-)?(?:flextext|paragraph-analysis)[a-z0-9-]*\.68mh29kgsd\.workers\.dev$", re.I)


def is_suite_host(host):
    host = (host or "").lower()
    if host in ("rulingants.github.io", "localhost", "127.0.0.1"):
        return True
    if host == "flextext.app" or host.endswith(".flextext.app"):
        return True
    return bool(_WORKERS.match(host))


def app_hint(host):
    """Which app(s) the host carries — a label for the report, not a rule."""
    h = (host or "").lower()
    if h == "rulingants.github.io":
        return "editor / recorder / crowd / researcher (GitHub Pages, one origin)"
    first = h.split(".")[0].replace("beta-", "")
    return {"app": "editor", "record": "recorder", "crowd": "crowd recorder", "research": "researcher panel",
            "audio-segmenter": "audio segmenter", "consent": "consent", "pat": "paragraph analysis",
            "beta": "editor (beta)", "localhost": "dev rig", "127": "dev rig"}.get(first, h)


def is_suite_db(name):
    return (name or "").startswith(DB_PREFIX)


def is_suite_key(key):
    return (key or "").startswith(KEY_PREFIX)


def is_sensitive_key(key):
    return bool(_SENSITIVE.search(key or ""))


def parse_idb_folder(name):
    """`https_app.flextext.app_0.indexeddb.leveldb` → ('https', 'app.flextext.app', '0'); None if not one.
    Chromium writes scheme_host_port; a host never holds `_`, so the split is unambiguous."""
    m = re.fullmatch(r"(https?|file)_(.+)_(\d+)\.indexeddb\.(leveldb|blob)", name)
    return (m.group(1), m.group(2), m.group(3)) if m else None


def origin_url(scheme, host, port):
    return "%s://%s" % (scheme, host) + ("" if port in ("0", "443", "80") else ":" + port)
