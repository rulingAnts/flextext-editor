"""One zip, the same shape as the in-app problem report's private leg (plans/BACKLOG.md, #98):

  report.json                     tool, when, machine, what was asked for, what was found, blind spots
  README.txt                      the same, for a person
  storage-<store>.json            per profile: origins → databases → manifests; settings; installed apps
  texts/<store>/<origin>/<id>.json   the full `docs` records (only when asked: they ARE the language data)
  media/<store>/<origin>/<key>.<ext> recordings (only with --with-audio)

Titles are content too: `redact_titles` replaces each with its sha256 prefix so a manifest can still
be matched against a device without carrying the words. Nothing is read that was not copied first.
"""

import datetime as _dt
import hashlib
import json
import platform
import sys
import zipfile
from pathlib import Path

from . import VERSION, reader, snapshot

BLIND_SPOTS = [
    "Only what the copied LevelDB folders held at copy time; a browser running during the copy may have written since.",
    "Cache Storage (the service worker's precached shell, which names the installed engine version) is not read.",
    "sessionStorage, cookies and history are not read; only IndexedDB and localStorage of suite origins.",
    "Keys whose names say they hold a credential are listed as present with a length, never copied.",
    "An Android phone's Chrome cannot be read from a computer at all; use the in-app report there.",
    "Files the OS refused to copy are listed under copyProblems; a manifest built from fewer files is incomplete.",
]


def _iso(ms):
    try:
        return _dt.datetime.fromtimestamp(float(ms) / 1000, tz=_dt.timezone.utc).isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def _title(t, redact):
    if t is None:
        return None
    return "sha256:" + hashlib.sha256(str(t).encode("utf-8")).hexdigest()[:16] if redact else t


def doc_manifest(rec, media, redact_titles=False):
    """One text's row in the manifest: identity, dates, shape, state — never its words."""
    doc = rec.get("doc") if isinstance(rec.get("doc"), dict) else {}
    paras = doc.get("paragraphs") if isinstance(doc.get("paragraphs"), list) else []
    words = sum(len(p.get("words") or []) for p in paras if isinstance(p, dict))
    rid = str(rec.get("id"))
    mine = {k: v for k, v in media.items() if k == rid or k.endswith(":" + rid)}
    row = {
        "id": rid, "title": _title(rec.get("title"), redact_titles),
        "modified": _iso(rec.get("modified")), "created": _iso(rec.get("created")),
        "recordBytes": reader._json_size(rec), "paragraphs": len(paras), "words": words,
        "segments": len(doc.get("segments")) if isinstance(doc.get("segments"), list) else 0,
        "done": rec.get("done"), "assigned": rec.get("assigned"), "hasDriveFolder": bool(rec.get("driveFolderId")),
        "flexTextGuid": (rec.get("flex") or {}).get("textGuid") if isinstance(rec.get("flex"), dict) else None,
        "fields": sorted(k for k in rec.keys() if k != "doc"),
        "media": mine,
    }
    rec_keys = {k.lower(): k for k in rec.keys()}
    for k in rec_keys.values():
        if "upload" in k.lower() or "sent" in k.lower():
            v = rec[k]
            row.setdefault("uploadState", {})[k] = v if isinstance(v, (str, int, float, bool)) or v is None else {"fields": sorted(v.keys())[:20]} if isinstance(v, dict) else type(v).__name__
    recd = rec.get("recording")
    if isinstance(recd, dict):
        row["recording"] = {k: recd[k] for k in ("name", "size", "type", "duration", "mime") if k in recd}
    return row


def store_report(copy, redact_titles=False):
    """The storage-<store>.json body for one copied ProfileStore, plus the docs for texts/."""
    body = copy.to_dict()
    body["origins"] = []
    docs_by_origin = {}
    hosts = {o.host for o in copy.origins}
    for o in copy.origins:
        r = reader.read_origin(o)
        docs_store = (r["databases"].get("flextext-editor", {}).get("stores", {}).get("docs", {}))
        media_store = (r["databases"].get("flextext-editor", {}).get("stores", {}).get("media", {}))
        docs = docs_store.pop("docs", []) if docs_store else []
        media = media_store.get("media", {}) if media_store else {}
        r["texts"] = [doc_manifest(d, media, redact_titles) for d in docs]
        docs_by_origin[o.origin] = docs
        body["origins"].append(r)
    ls, ls_problems = reader.read_local_storage(copy.local_storage, hosts)
    body["localStorage"] = ls
    body["problems"] = ls_problems
    return body, docs_by_origin


def _slug(s):
    return "".join(c if c.isalnum() or c in "-_." else "-" for c in str(s)).strip("-")[:80] or "x"


def build(stores, out_path, texts="none", with_audio=False, redact_titles=False, note="", workdir=None):
    """stores: [ProfileStore] from profiles.discover. texts: 'none' | 'all' | iterable of record ids.
    Returns a summary dict (also written as report.json inside the zip)."""
    out_path = Path(out_path)
    wanted = None if texts in ("none", None) else ("all" if texts == "all" else {str(t) for t in texts})
    summary = {
        "tool": "fxdiag", "version": VERSION, "generatedAt": _dt.datetime.now(tz=_dt.timezone.utc).isoformat(),
        "machine": {"system": platform.system(), "release": platform.release(), "python": sys.version.split()[0]},
        "asked": {"texts": texts if isinstance(texts, str) else sorted(wanted or []), "withAudio": with_audio, "redactTitles": redact_titles},
        "note": note or "", "stores": [], "blindSpots": BLIND_SPOTS, "copyProblems": [],
    }
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        for store in stores:
            copy, problems, base = snapshot.take(store, workdir)
            summary["copyProblems"].extend(problems)
            body, docs_by_origin = store_report(copy, redact_titles)
            body["copyProblems"] = problems
            z.writestr("storage-%s.json" % copy.slug, json.dumps(body, indent=1, ensure_ascii=False, default=str))
            n_texts = n_audio = 0
            for o in copy.origins:
                for rec in docs_by_origin.get(o.origin, []):
                    rid = str(rec.get("id"))
                    if wanted == "all" or (wanted and rid in wanted):
                        z.writestr("texts/%s/%s/%s.json" % (copy.slug, _slug(o.host), _slug(rid)), json.dumps(rec, ensure_ascii=False, default=str))
                        n_texts += 1
                        if with_audio:
                            for key, m in (next((orr for orr in body["origins"] if orr["origin"] == o.origin), {}).get("databases", {})
                                           .get("flextext-editor", {}).get("stores", {}).get("media", {}).get("media", {}).items()):
                                if (key == rid or key.endswith(":" + rid)) and m.get("kind") == "blob":
                                    data = reader.read_blob(o, "media", key)
                                    if data is not None:
                                        ext = {"audio/wav": "wav", "audio/x-wav": "wav", "audio/webm": "webm", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac"}.get(m.get("type") or "", "bin")
                                        z.writestr("media/%s/%s/%s.%s" % (copy.slug, _slug(o.host), _slug(key), ext), data)
                                        n_audio += 1
            summary["stores"].append({"slug": copy.slug, "app": copy.app, "profile": copy.profile_name, "origins": [o.origin for o in copy.origins],
                                      "texts": sum(len(orr.get("texts", [])) for orr in body["origins"]), "textsIncluded": n_texts, "audioIncluded": n_audio,
                                      "problems": body["problems"] + [p for orr in body["origins"] for p in orr.get("problems", [])]})
        z.writestr("report.json", json.dumps(summary, indent=1, ensure_ascii=False, default=str))
        z.writestr("README.txt", readme(summary))
    return summary


def readme(summary):
    lines = ["fxdiag report — FlexText suite browser storage, read from disk", "generated %s by fxdiag %s" % (summary["generatedAt"], summary["version"]), ""]
    for s in summary["stores"]:
        lines.append("- %s / %s: %d text(s) across %s; %d text record(s) included, %d recording(s) included" % (
            s["app"], s["profile"], s["texts"], ", ".join(s["origins"]) or "no suite origin", s["textsIncluded"], s["audioIncluded"]))
        for p in s["problems"]:
            lines.append("    problem: %s" % p)
    if summary["copyProblems"]:
        lines.append("")
        lines.append("%d file(s) could not be copied (see report.json copyProblems) — the manifests may be incomplete." % len(summary["copyProblems"]))
    lines += ["", "Files: report.json (this, as data); storage-<store>.json (manifests, settings, installed apps);",
              "texts/ (full text records, only if asked); media/ (recordings, only if asked).", "", "What this cannot see:"]
    lines += ["- " + b for b in BLIND_SPOTS]
    if summary.get("note"):
        lines += ["", "Note from the person who made it:", summary["note"]]
    return "\n".join(lines) + "\n"
