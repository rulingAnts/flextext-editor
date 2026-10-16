"""W8 — the disk read-back (plan §5.4): stream-parse `.bak` (exactly the pre-save file, because
auto-save is off) against the new `.fwdata`, keyed by `rt guid`, with a REAL XML parser.

[verified] validator pitfalls, both built in here:
  - self-closing `<rt …/>` elements exist (a regex missed 185 of them) — iterparse sees them;
  - hashing ET.tostring(el) at an iterparse end event includes the element's TAIL, which depends on
    buffer boundaries — `el.tail = None` first, and the tests always include an edit that changes the
    file length.
Runtime on a 25 MB file: 1–1.7 s [verified].

`diff_rt(bak_path, fwdata_path)` → {added: {guid: Rt}, removed: {...}, changed: {guid: (old, new)}}
`Rt` = {cls, owner, fields: {tag: text-or-None}, raw: canonical bytes hash}
`check(diff, allowed)` → list of unexplained changes, where `allowed` is the preview's expectation:
  {classes: set, touchedOwners: set(guids), referencedFrom: set(guids), expect: {guid: {field: value}},
   countDeltas: {cls: n}, newPunctForms: set(forms)}
"""

import hashlib
import os
import xml.etree.ElementTree as ET

ALWAYS_TOUCHED = ("LangProject",)   # DateModified on every save [verified]
DATE_ONLY_OK = ("Text", "StText", "LangProject")


def _fields(el):
    """{tag: value}: an attribute value, a string's text, the guids an objsur list names — and for a
    multilingual field (AStr / AUni alternatives) {ws: text}, so an expectation can name ONE writing
    system: a phrase's free translation in Indonesian is not its English one joined to it."""
    out = {}
    for ch in el:
        alts = [a for a in ch if a.tag in ("AStr", "AUni") and a.get("ws")]
        if alts:
            out[ch.tag] = {a.get("ws"): ("".join(r.text or "" for r in a.iter("Run")) if a.tag == "AStr" else (a.text or "")) for a in alts}
        elif ch.get("val") is not None:
            out[ch.tag] = ch.get("val")
        else:
            runs = [r.text or "" for r in ch.iter("Run")]
            unis = [u.text or "" for u in ch.iter("Uni")]
            objs = [o.get("guid") for o in ch.iter("objsur")]
            out[ch.tag] = "|".join(runs) if runs else ("|".join(unis) if unis else ("|".join(objs) if objs else (ch.text or "")))
    return out


def iter_rt(path):
    """Yield (guid, Rt) for every rt element, streaming."""
    for ev, el in ET.iterparse(path, events=("end",)):
        if el.tag != "rt":
            continue
        el.tail = None   # the pitfall: tail text depends on buffer boundaries
        raw = ET.tostring(el, encoding="utf-8")
        h = hashlib.sha256(raw).hexdigest()
        yield el.get("guid"), {"cls": el.get("class"), "owner": el.get("ownerguid"), "fields": _fields(el), "hash": h}
        el.clear()


def load_rt(path):
    return dict(iter_rt(path))


def header_version(path):
    for ev, el in ET.iterparse(path, events=("start",)):
        if el.tag == "languageproject":
            return int(el.get("version") or 0)
        break
    return None


def diff_rt(bak_path, fwdata_path):
    old = load_rt(bak_path)
    new = load_rt(fwdata_path)
    added = {g: new[g] for g in new if g not in old}
    removed = {g: old[g] for g in old if g not in new}
    changed = {g: (old[g], new[g]) for g in new if g in old and old[g]["hash"] != new[g]["hash"]}
    # `newMap` is the saved file's objects, for check()'s ownership chains: parsing a 25 MB file again took
    # five seconds of every save (2026-10-16, the first real saves)
    return {"added": added, "removed": removed, "changed": changed, "oldCount": len(old), "newCount": len(new),
            "headerVersion": header_version(fwdata_path), "newMap": new}


def owner_chain(rt_map, guid):
    seen = []
    g = guid
    while g and g in rt_map and len(seen) < 32:
        seen.append(g)
        g = rt_map[g]["owner"]
    return seen


def check(diff, allowed, rt_map=None):
    """→ [] when every change is explained, else a list of {guid, cls, why}."""
    problems = []
    classes = set(allowed.get("classes", ()))
    touched = set(allowed.get("touchedOwners", ()))
    referenced = set(allowed.get("referencedFrom", ()))
    expect = allowed.get("expect", {})
    deltas = dict(allowed.get("countDeltas", {}))
    # a PunctuationForm of one of these forms may be new with nothing referencing it: FLEx makes the § form
    # the first time a § is written, and a paragraph join writes one only for the phrase join to delete it
    punct_ok = set(allowed.get("newPunctForms", ()))
    rt_map = rt_map or {}
    seen_deltas = {}

    def explained_by_ownership(guid, rt):
        # the object itself, or anything up its ownership chain, is a touched text or an object a
        # touched segment references (a WfiAnalysis's bundles and glosses hang under the analysis)
        chain = owner_chain(rt_map, guid) if rt_map else [guid, rt["owner"]]
        return any(c in touched or c in referenced for c in chain)

    for guid, (o, n) in diff["changed"].items():
        cls = n["cls"]
        if cls in DATE_ONLY_OK and set(k for k in n["fields"] if o["fields"].get(k) != n["fields"].get(k)) <= {"DateModified"}:
            continue
        if cls not in classes:
            problems.append({"guid": guid, "cls": cls, "why": "class not allowed to change"})
            continue
        if not explained_by_ownership(guid, n):
            problems.append({"guid": guid, "cls": cls, "why": "outside every touched text"})
            continue
        for field, value in expect.get(guid, {}).items():
            if not _field_is(n["fields"].get(field), value):
                problems.append({"guid": guid, "cls": cls, "why": "field %s is %r, expected %r" % (field, n["fields"].get(field), value)})
    for guid, n in diff["added"].items():
        cls = n["cls"]
        seen_deltas[cls] = seen_deltas.get(cls, 0) + 1
        if cls not in classes:
            problems.append({"guid": guid, "cls": cls, "why": "unexpected new object of this class"})
        elif not explained_by_ownership(guid, n) and not (cls == "PunctuationForm" and (n["fields"].get("Form") or "").strip() in punct_ok):
            problems.append({"guid": guid, "cls": cls, "why": "new object outside every touched text"})
        for field, value in expect.get(guid, {}).items():
            if not _field_is(n["fields"].get(field), value):
                problems.append({"guid": guid, "cls": cls, "why": "field %s is %r, expected %r" % (field, n["fields"].get(field), value)})
    for guid, o in diff["removed"].items():
        cls = o["cls"]
        seen_deltas[cls] = seen_deltas.get(cls, 0) - 1
        if cls not in classes:
            problems.append({"guid": guid, "cls": cls, "why": "unexpected removal of this class"})
    for cls, n in deltas.items():
        if seen_deltas.get(cls, 0) != n:
            problems.append({"guid": None, "cls": cls, "why": "count changed by %d, preview said %d" % (seen_deltas.get(cls, 0), n)})
    for cls, n in seen_deltas.items():
        if cls not in deltas and n != 0:
            problems.append({"guid": None, "cls": cls, "why": "count changed by %d, preview said 0" % n})
    return problems


def _field_is(have, want):
    """An expected {ws: text} names those writing systems only; anything else must be equal."""
    if isinstance(want, dict):
        return isinstance(have, dict) and all((have.get(w) or "") == (t or "") for w, t in want.items())
    return have == want


def files_after_save(fwdata_path, mtime_before):
    """W8's two file facts: .tmp is gone and .fwdata's mtime changed."""
    base = fwdata_path[:-len(".fwdata")]
    tmp_gone = not os.path.exists(base + ".tmp")
    try:
        mtime_changed = os.stat(fwdata_path).st_mtime_ns != mtime_before
    except OSError:
        mtime_changed = False
    return {"tmpGone": tmp_gone, "mtimeChanged": mtime_changed, "bakExists": os.path.exists(base + ".bak")}
