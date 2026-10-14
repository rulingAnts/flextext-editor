#!/usr/bin/env python3
"""Stage the engine for the shell (plan §12.1). Runs on Mac, Linux or Windows — Python only, no bash.

  python desktop/build/stage_engine.py [--out desktop/build/engine] [--satellite audio-segmenter]

Copies the editor's engine (`docs/`) and the chosen satellite's shell (`satellites/<name>/`) into one
folder laid out as the local server expects (the satellite at `/`, the engine at
`/flextext-editor/`), stamps the engine version into `engine-version.json`, drops every service
worker (the shell serves no sw.js, plan §12.1), and FAILS when any staged HTML, JS or CSS references
an OFF-ORIGIN script, stylesheet, font, frame or module import (plan §2.2 item 6: network is data,
never content). The engine is pinned per shell build: a shell shows its engine version and refuses
a newer sync contract rather than misbehave (risk R4).
"""
import argparse
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.realpath(os.path.join(HERE, "..", ".."))

# What a page may load from another origin: nothing. These patterns find content references.
CONTENT_REFS = [
    (re.compile(r"""<script[^>]+src=["']([^"']+)["']""", re.I), "script"),
    (re.compile(r"""<link[^>]+href=["']([^"']+)["']""", re.I), "link"),
    (re.compile(r"""<iframe[^>]+src=["']([^"']+)["']""", re.I), "iframe"),
    (re.compile(r"""@import\s+(?:url\()?["']?([^"')\s]+)""", re.I), "css-import"),
    (re.compile(r"""url\(\s*["']?([^"')\s]+)["']?\s*\)""", re.I), "css-url"),
    (re.compile(r"""^\s*import\s+[^'"]*['"]([^'"]+)['"]""", re.M), "js-import"),
    (re.compile(r"""import\(\s*['"]([^'"]+)['"]\s*\)"""), "js-dynamic-import"),
]
ALLOWED_SCHEMES = ("data:", "blob:", "about:")


def off_origin(ref):
    r = ref.strip()
    if not r or r.startswith(ALLOWED_SCHEMES) or r.startswith("#"):
        return False
    if re.match(r"^[a-z][a-z0-9+.-]*:", r, re.I) or r.startswith("//"):
        return True
    return False


def scan(root):
    """→ [(file, kind, ref)] of off-origin content references."""
    bad = []
    for dp, dn, fn in os.walk(root):
        for f in fn:
            if not f.lower().endswith((".html", ".js", ".mjs", ".css", ".webmanifest")):
                continue
            p = os.path.join(dp, f)
            try:
                with open(p, "r", encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            except OSError:
                continue
            # strip JS/CSS comments so documentation URLs do not count
            stripped = re.sub(r"/\*[\s\S]*?\*/", "", text)
            stripped = re.sub(r"(^|[^:])//[^\n]*", r"\1", stripped)
            for rx, kind in CONTENT_REFS:
                for m in rx.finditer(stripped if kind.startswith(("js", "css")) else text):
                    ref = m.group(1)
                    if off_origin(ref):
                        bad.append((os.path.relpath(p, root), kind, ref))
    return bad


def engine_version(docs):
    with open(os.path.join(docs, "js", "i18n.js"), "r", encoding="utf-8") as f:
        m = re.search(r"ENGINE_VERSION\s*=\s*['\"]([^'\"]+)['\"]", f.read())
    return m.group(1) if m else None


SHELL_META = '<meta name="flextext-flex-shell" content="1">'


def mark_shell_page(index_html):
    """The staged shell page carries a <meta> the engine reads SYNCHRONOUSLY (native-flex.js
    isFlexShellPage) before the bridge is injected: on it the engine's localhost dev switch is off,
    so the shell talks to the production relay worker like any installed app instead of the
    `wrangler dev` worker a developer's localhost means (Seth, 2026-10-14: a branch that is not
    production "will run into CORS, turnstile, and callback issues")."""
    with open(index_html, "r", encoding="utf-8") as f:
        html = f.read()
    if SHELL_META in html:
        return
    anchor = '<meta charset="utf-8">'
    if anchor not in html:
        raise SystemExit("stage_engine: the shell page has no <meta charset> to anchor the shell marker on")
    html = html.replace(anchor, anchor + "\n" + SHELL_META, 1)
    with open(index_html, "w", encoding="utf-8") as f:
        f.write(html)


def source_commit(repo):
    """Short commit of the checkout the engine is staged from, or None (no git, not a checkout).
    The shell prints it at start-up so "which build is this" is answered by the console, not by
    trusting pip: a `pip install git+…` that resolves a new commit can still skip the reinstall."""
    try:
        import subprocess
        r = subprocess.run(["git", "-C", repo, "rev-parse", "--short", "HEAD"], capture_output=True,
                           text=True, timeout=10)
        return r.stdout.strip() or None if r.returncode == 0 else None
    except Exception:   # noqa: BLE001 — git missing or not a checkout: the build does not care
        return None


def stage(out, satellite="audio-segmenter", docs=None):
    docs = docs or os.path.join(REPO, "docs")
    sat = os.path.join(REPO, "satellites", satellite)
    if not os.path.isdir(sat):
        raise SystemExit("no satellite at " + sat)
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)
    # the satellite's shell at the root
    for name in os.listdir(sat):
        src = os.path.join(sat, name)
        if name in ("sw.js", "robots.txt", "CLAUDE.md"):
            continue
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(out, name))
        else:
            shutil.copy2(src, os.path.join(out, name))
    # the engine at /flextext-editor/
    eng = os.path.join(out, "flextext-editor")
    shutil.copytree(docs, eng, ignore=shutil.ignore_patterns("sw.js", "installers", "*.md", ".nojekyll", "help"))
    # the engine's own help pages are useful offline; keep them
    if os.path.isdir(os.path.join(docs, "help")):
        shutil.copytree(os.path.join(docs, "help"), os.path.join(eng, "help"))
    mark_shell_page(os.path.join(out, "index.html"))
    ver = engine_version(docs)
    with open(os.path.join(out, "engine-version.json"), "w", encoding="utf-8") as f:
        json.dump({"engineVersion": ver, "satellite": satellite, "source": source_commit(os.path.dirname(docs))}, f)
    bad = scan(out)
    if bad:
        for file, kind, ref in bad:
            print("OFF-ORIGIN %-18s %s -> %s" % (kind, file, ref), file=sys.stderr)
        raise SystemExit("stage_engine: %d off-origin content reference(s); the shell serves only its own origin" % len(bad))
    # ASCII only: under pip this runs behind a pipe whose encoding on Windows is cp1252, and a
    # non-encodable character here failed the whole wheel build (seen on the first VM install).
    print("staged engine %s (%s) -> %s" % (ver, satellite, out))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "engine"))
    ap.add_argument("--satellite", default="audio-segmenter")
    ap.add_argument("--docs", default=None)
    a = ap.parse_args(argv)
    stage(a.out, a.satellite, a.docs)


if __name__ == "__main__":
    main()
