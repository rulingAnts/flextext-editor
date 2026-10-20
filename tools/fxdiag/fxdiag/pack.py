"""`fxdiag pack` — a USB EXCHANGE PACKAGE: texts and recordings for a device that has no network, with
the assignment that goes with them, in the shape the apps can take TODAY.

⚠ WHY THIS IS NOT "INJECT INTO THE BROWSER": fxdiag reads browser storage from disk and will not write
it. Chromium's IndexedDB is a LevelDB with Blink-serialised values, blob journals and per-store
metadata; Firefox's is SQLite with structured-clone values and side files. A write from outside the
browser, into a store the browser may hold open, with the wrong byte somewhere, is how a device loses
every text on it — the one outcome this suite is built to prevent — and no field phone can be reached
that way in any case. So the package is applied BY THE APP: the person opens the app on the device and
imports it. Grabbing (this tool's --flextext report), deleting (in the app, after the grab is confirmed)
and assigning (this package) all happen through the app's own doors, which exist already:

  - a text + its recording  → the app's "Open text + recording together" dialog (app.js openPairDialog),
    one pair at a time, today; a MANIFEST.json rides along for the app's future "Import from USB"
    (plans/BACKLOG.md, "USB exchange") which will take the whole package in one go and offer the
    deletions the researcher marked;
  - the assignment (writing systems, upload folder, consent mode, switches) → the same settings LINK the
    researcher panel sends (app.js applyUrlSettings), here as assign.html: opened on the device it reaches
    the installed app offline (the service worker serves it) and applies the parameters.

Package layout (a folder, or a zip of it):
  MANIFEST.json      who made it, when, for which device (free text), the texts (file, recording, id,
                     title), the assignment parameters, the texts to DELETE once grabbed (ids + titles) —
                     advisory: nothing deletes anything until the app's import asks and the person agrees
  README.txt         the steps, for the person holding the device
  assign.html        the settings link (and the same as text), when --assign is given
  <title>.flextext (+ <title>.<ext>)   the texts and their recordings
"""

import datetime as _dt
import html
import json
import re
import shutil
import zipfile
from pathlib import Path
from urllib.parse import urlencode

from . import VERSION, flexexport

AUDIO_EXTS = (".wav", ".webm", ".ogg", ".oga", ".opus", ".mp3", ".m4a", ".aac", ".flac", ".3gp", ".amr", ".mp4")


def collect(sources):
    """[(flextext_path, [audio_paths])] from folders, .flextext files and fxdiag report zips (their export/)."""
    pairs, tmp = [], []
    for src in sources:
        src = Path(src)
        if src.is_file() and src.suffix.lower() == ".zip":
            out = Path(str(src) + ".unpacked")
            with zipfile.ZipFile(src) as z:
                for n in z.namelist():
                    if n.startswith("export/") and not n.endswith("/"):
                        z.extract(n, out)
            tmp.append(out)
            src = out / "export"
        files = [src] if src.is_file() else sorted(p for p in src.rglob("*") if p.is_file())
        texts = [p for p in files if p.suffix.lower() == ".flextext"]
        for t in texts:
            audio = [p for p in files if p.parent == t.parent and p.stem.split(".")[0] == t.stem and p.suffix.lower() in AUDIO_EXTS]
            pairs.append((t, audio))
    return pairs, tmp


def title_and_id(flextext_path):
    """From the file, without parsing the whole document: the title item and the text guid."""
    try:
        head = flextext_path.read_text(encoding="utf-8", errors="replace")[:20000]
    except OSError:
        return flextext_path.stem, None
    t = re.search(r'<item[^>]*type="title"[^>]*>([^<]*)</item>', head)
    g = re.search(r'<interlinear-text[^>]*guid="([^"]+)"', head)
    return (html.unescape(t.group(1)) if t else flextext_path.stem), (g.group(1) if g else None)


def assign_url(app_origin, params):
    """The settings link the panel would send: app origin + the parameters, as applyUrlSettings reads them."""
    base = (app_origin or "https://app.flextext.app/").rstrip("/") + "/"
    return base + ("?" + urlencode(params) if params else "")


def build(sources, out_dir, device="", assign=None, app_origin=None, delete=None, note="", zip_it=False):
    """Write the package. assign: dict of URL parameters (vern, vernName, anal, upload, consentMode, …).
    delete: [{id, title}] the researcher wants removed from the device once grabbed (advisory)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    pairs, tmp = collect(sources)
    taken = set()
    manifest = {
        "format": "flextext-usb-exchange", "version": 1, "tool": "fxdiag %s" % VERSION,
        "createdAt": _dt.datetime.now(tz=_dt.timezone.utc).isoformat(), "device": device or "", "note": note or "",
        "texts": [], "assign": assign or {}, "assignUrl": assign_url(app_origin, assign) if assign else None,
        "delete": list(delete or []), "appliedBy": "the app on the device — this tool writes nothing into a browser",
    }
    for t, audio in pairs:
        title, guid = title_and_id(t)
        base = flexexport.unique_name(flexexport.sanitize_base(title) or t.stem, taken)
        shutil.copy2(t, out_dir / (base + ".flextext"))
        rec_names = []
        for i, a in enumerate(audio):
            name = base + ("" if i == 0 else ".%d" % (i + 1)) + a.suffix.lower()
            shutil.copy2(a, out_dir / name)
            rec_names.append(name)
        manifest["texts"].append({"file": base + ".flextext", "recordings": rec_names, "title": title, "guid": guid})
    for d in tmp:
        shutil.rmtree(d, ignore_errors=True)
    (out_dir / "MANIFEST.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False), encoding="utf-8")
    if manifest["assignUrl"]:
        (out_dir / "assign.html").write_text(ASSIGN_HTML % {"url": html.escape(manifest["assignUrl"]), "device": html.escape(device or "this device"),
                                                             "params": html.escape(json.dumps(assign, ensure_ascii=False))}, encoding="utf-8")
    (out_dir / "README.txt").write_text(readme(manifest), encoding="utf-8")
    if zip_it:
        zp = Path(str(out_dir) + ".zip")
        with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
            for p in sorted(out_dir.rglob("*")):
                if p.is_file():
                    z.write(p, p.relative_to(out_dir).as_posix())
        manifest["zip"] = str(zp)
    return manifest


ASSIGN_HTML = """<!doctype html><meta charset="utf-8"><title>FlexText assignment</title>
<style>body{font:16px system-ui,sans-serif;max-width:40em;margin:2em auto;padding:0 1em}code{word-break:break-all}</style>
<h1>Assignment for %(device)s</h1>
<p>Open this link on the device. The FlexText app opens (it works offline once installed) and applies these settings:</p>
<p><a href="%(url)s">%(url)s</a></p>
<p><code>%(params)s</code></p>
<p>Then import the texts in this folder with the app's <b>Open text + recording together</b>.</p>
"""


def readme(m):
    lines = ["FlexText USB exchange package — made by %s on %s" % (m["tool"], m["createdAt"]), "for: %s" % (m["device"] or "(device not named)"), ""]
    if m.get("assignUrl"):
        lines += ["1. Open assign.html on the device and follow its link: the app applies the assignment (settings).", ""]
    lines += ["%d text(s) to put on the device, each with its recording beside it:" % len(m["texts"])]
    for t in m["texts"]:
        lines.append("   - %s%s" % (t["file"], ("  +  " + ", ".join(t["recordings"])) if t["recordings"] else "  (no recording)"))
    lines += ["   In the app: Texts → Open text + recording together → choose the .flextext and its recording.", ""]
    if m["delete"]:
        lines += ["%d text(s) the researcher asks to REMOVE from the device, once they have been grabbed and checked:" % len(m["delete"])]
        lines += ["   - %s" % (d.get("title") or d.get("id")) for d in m["delete"]]
        lines += ["   Nothing here deletes anything: remove them in the app, yourself, after checking they are safe elsewhere.", ""]
    if m.get("note"):
        lines += ["Note:", m["note"], ""]
    lines += ["This package is applied by the app on the device. fxdiag never writes into a browser's storage."]
    return "\n".join(lines) + "\n"
