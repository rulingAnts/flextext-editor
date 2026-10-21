"""`--flextext`: the device's texts as .flextext FILES beside their recordings — what a person can
open in FLEx or drop into another device, as opposed to the raw records (texts/*.json).

The writer is the engine's own (engine/js/flextext.js, staged into the wheel by setup.py), run in
Node.js: one process per report, JSON in, JSON out. Node is the one thing this needs that pip does
not install; without it the report still has the JSON records and says what to install. A record the
writer rejects is listed under `failed`, never dropped silently.
"""

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).parent


def engine_js_dir():
    """The staged engine inside the package; from a source checkout, the repository's docs/js."""
    staged = HERE / "engine" / "js"
    if (staged / "flextext.js").is_file():
        return staged
    repo = HERE.parent.parent.parent / "docs" / "js"
    if (repo / "flextext.js").is_file():
        return repo
    return None


def engine_version():
    try:
        return (HERE / "engine" / "ENGINE_VERSION").read_text(encoding="utf-8").strip()
    except OSError:
        d = engine_js_dir()
        if d is not None and (d / "i18n.js").is_file():
            m = re.search(r"ENGINE_VERSION\s*=\s*'([^']+)'", (d / "i18n.js").read_text(encoding="utf-8"))
            if m:
                return m.group(1) + " (source checkout)"
        return "unknown"


def bundled_node():
    """The portable exe carries its own Node (packaging/build_exe.py --node): <bundle>/node/node(.exe).
    In a frozen build HERE is <_MEIPASS>/fxdiag, so the bundle root is HERE.parent."""
    for name in ("node.exe", "node"):
        p = HERE.parent / "node" / name
        if p.is_file():
            return str(p)
    return None


def find_node():
    """FXDIAG_NODE, then the bundled one (the exe), then whatever is on PATH."""
    return os.environ.get("FXDIAG_NODE") or bundled_node() or shutil.which("node") or shutil.which("node.exe")


def availability():
    """(ok, why): can .flextext files be written on this machine?"""
    if engine_js_dir() is None:
        return False, "the engine serializer (flextext.js) is not staged in this install"
    if find_node() is None:
        return False, "Node.js is not installed (nodejs.org); the records are in texts/ as JSON meanwhile"
    return True, ""


def sanitize_base(title):
    """seg-exports.js sanitizeBase — the one filename rule, kept the same here."""
    return re.sub(r'[\\/:*?"<>|]+', "_", str(title or "")).strip()[:120]


def ext_for(mime, name=None):
    m = re.search(r"(\.[A-Za-z0-9]{1,5})$", str(name or ""))
    if m:
        return m.group(1).lower()
    return {"audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav", "audio/webm": ".webm", "audio/ogg": ".ogg",
            "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/flac": ".flac", "video/mp4": ".mp4"}.get((mime or "").split(";")[0], "")


def serialize(records, settings, media_names):
    """[{id, xml}|{id, error}] for the given docs records; media_names: {id: filename or None}."""
    ok, why = availability()
    if not ok:
        return [{"id": str(r.get("id")), "error": why} for r in records]
    payload = {"settings": settings or {}, "records": [{"rec": r, "mediaName": media_names.get(str(r.get("id")))} for r in records]}
    env = dict(os.environ, FXDIAG_ENGINE_JS=str(engine_js_dir()))
    try:
        p = subprocess.run([find_node(), str(HERE / "engine" / "serialize.mjs")], input=json.dumps(payload, default=str).encode("utf-8"),
                           capture_output=True, env=env, timeout=600, check=False)
    except (OSError, subprocess.TimeoutExpired) as e:
        return [{"id": str(r.get("id")), "error": "node could not run: %s" % e} for r in records]
    if p.returncode != 0:
        err = p.stderr.decode("utf-8", "replace")[-800:]
        return [{"id": str(r.get("id")), "error": "the serializer failed: %s" % err} for r in records]
    try:
        return json.loads(p.stdout.decode("utf-8"))
    except ValueError as e:
        return [{"id": str(r.get("id")), "error": "unreadable serializer output: %s" % e} for r in records]


def unique_name(base, taken):
    name, n = base, 2
    while name.lower() in taken:
        name = "%s (%d)" % (base, n)
        n += 1
    taken.add(name.lower())
    return name
