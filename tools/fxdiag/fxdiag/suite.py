"""What the FlexText suite keeps in a browser, and how to tell it from everything else in a profile.

One origin, several apps: on GitHub Pages the editor, recorder, crowd recorder and researcher panel all
live on rulingants.github.io at different paths — ONE profile origin, one IndexedDB folder. On the
Cloudflare estate each app is its own host (app. / record. / crowd. / research. / audio-segmenter. /
consent. / pat. and the beta- twins), and the preview estates are *.68mh29kgsd.workers.dev. Dev rigs
are localhost. Database names start with `flextext` (db.js, sync.js, files.js, the crowd store), as do
localStorage keys. A key whose name says it holds a credential is listed as PRESENT, never copied.

⚠ THIS FILE FOLLOWS THE APPS. A new hostname, database or key in docs/js or worker/wrangler.toml that
this module would not recognise fails test/fxdiag-suite-sync.test.mjs in the commit that adds it
(CLAUDE.md, "fxdiag follows the suite's storage"); fix it HERE, in the same commit.
"""

import re

DOCS_DB = "flextext-editor"          # db.js: stores 'docs' (keyPath id) and 'media' (blobs + peaks by doc id)
DB_PREFIX = "flextext"
# localStorage key prefixes the apps use: the suite-wide `flextext-…`, and the Paragraph Analysis tool's own
# (`fxpa:` its working document and mappings, `pa.` its switches, `sfm.` its converter). On a suite origin
# only these are read; anything else under that origin is left alone.
KEY_PREFIXES = ("flextext-", "fxpa:", "pa.", "sfm.", "rp-")   # rp-: one researcher-panel key predates the flextext- rule
KEY_PREFIX = KEY_PREFIXES[0]
SETTINGS_KEY = "flextext-ws-settings"

# a localStorage key whose NAME says it carries something that must not travel: recorded as present + length
_SENSITIVE = re.compile(r"auth|session|unlock|acct|secret|token|cred|password|key$|-key", re.I)

# Every Worker on the suite's Cloudflare account answers at <name>.68mh29kgsd.workers.dev — production
# (flextext-editor, paragraph-analysis-tool, consent-collector, audio-segmenter, …), the -beta twins and
# every <branch>-<worker> preview. The account subdomain is the suite's, so the suffix is the rule;
# test/fxdiag-suite-sync.test.mjs checks it against worker/wrangler.toml's allow-list on every run.
_WORKERS_SUFFIX = ".68mh29kgsd.workers.dev"


def is_suite_host(host):
    host = (host or "").lower()
    if host in ("rulingants.github.io", "localhost", "127.0.0.1"):
        return True
    if host == "flextext.app" or host.endswith(".flextext.app"):
        return True
    return host.endswith(_WORKERS_SUFFIX) and len(host) > len(_WORKERS_SUFFIX)


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
    return (key or "").startswith(KEY_PREFIXES)


def is_sensitive_key(key):
    return bool(_SENSITIVE.search(key or ""))


def parse_idb_folder(name):
    """`https_app.flextext.app_0.indexeddb.leveldb` → ('https', 'app.flextext.app', '0'); None if not one.
    Chromium writes scheme_host_port; a host never holds `_`, so the split is unambiguous."""
    m = re.fullmatch(r"(https?|file)_(.+)_(\d+)\.indexeddb\.(leveldb|blob)", name)
    return (m.group(1), m.group(2), m.group(3)) if m else None


def origin_url(scheme, host, port):
    return "%s://%s" % (scheme, host) + ("" if port in ("0", "443", "80") else ":" + port)
