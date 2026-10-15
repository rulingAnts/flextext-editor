"""Between LCM's read model and the engine's flextext-shaped doc (plan §4.1), plus the fingerprints
W1/W4/W6 compare (plan §5.3 C5). Pure functions over the plain dicts FlexPort returns."""

import hashlib
import json
from xml.sax.saxutils import escape as _xml_escape

SECTION = "\u00A7"


def fingerprint_para(p):
    """Contents + WS, segment GUIDs and offsets, FT/LT per WS, times, media, speaker, notes,
    analysis GUIDs — everything a write could change, nothing a save alone changes."""
    body = {
        "c": p["contents"], "ws": p["ws"],
        "s": [[s["guid"], s["begin"], s["end"], sorted(s["ft"].items()), sorted(s["lt"].items()),
               s["beginTime"], s["endTime"], s["mediaUri"], s["speaker"], list(s["notes"]),
               [a["guid"] for a in s["analyses"]]] for s in p["segments"]],
    }
    return hashlib.sha256(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def fingerprint_text(t):
    return {p["guid"]: fingerprint_para(p) for p in t["paragraphs"]}


def base_rev(t):
    """One hash for the whole text — the engine's `baseRev`."""
    fp = fingerprint_text(t)
    return hashlib.sha256(json.dumps(sorted(fp.items())).encode()).hexdigest()[:24]


def segment_text(p, s):
    return p["contents"][s["begin"]:s["end"]]


def text_ws_usage(t):
    """What one text actually uses (plan §7.4): {vern: {ws: paragraphs}, anal: {ws: {ft, lt, gloss}},
    words: {approved, unapproved}} — paragraphs by their baseline's writing system; phrases with a
    free/literal translation and occurrences with a gloss, by analysis writing system; and how many word
    occurrences point at an approved gloss (a WfiGloss) and how many do not (a bare wordform, or an
    analysis with no word gloss chosen) — FLEx shows its GUESSES on the latter, tinted, and a guess is
    not FLEx's gloss, so the engine shows none there."""
    vern, anal = {}, {}
    words = {"approved": 0, "unapproved": 0}
    for p in t["paragraphs"]:
        if p["segments"]:
            vern[p["ws"]] = vern.get(p["ws"], 0) + 1
        for s in p["segments"]:
            for key, field in (("ft", "ft"), ("lt", "lt")):
                for w, x in s[field].items():
                    if x:
                        anal.setdefault(w, {"ft": 0, "lt": 0, "gloss": 0})[key] += 1
            for a in s["analyses"]:
                if a["kind"] == "gloss":
                    words["approved"] += 1
                elif a["kind"] in ("analysis", "wordform"):
                    words["unapproved"] += 1
                for w, x in (a.get("gloss") or {}).items():
                    if x:
                        anal.setdefault(w, {"ft": 0, "lt": 0, "gloss": 0})["gloss"] += 1
    return {"vern": vern, "anal": anal, "words": words}


def default_ws(t):
    """The writing systems a text opens in when nobody chose: the vernacular most of its paragraphs
    are in (FLEx's default vernacular for an empty text), and the current analysis writing system it
    uses most — free translations and glosses together, what the Segmenter shows (literal
    translations it never does); ties to the one FLEx lists first — else FLEx's first analysis one."""
    u = text_ws_usage(t)
    vern = max(u["vern"].items(), key=lambda kv: kv[1])[0] if u["vern"] else t["vernWs"]
    order = list(t["analWss"] or ["en"])
    used = {w: c["ft"] + c["gloss"] for w, c in u["anal"].items() if w in order and c["ft"] + c["gloss"]}
    anal = max(used, key=lambda w: (used[w], -order.index(w))) if used else order[0]
    return {"vern": vern, "anal": anal}


def _gls_item(lang, text):
    return '<item type="gls" lang="%s">%s</item>' % (_xml_escape(lang, {'"': "&quot;"}), _xml_escape(text))


def word_form(a, vern):
    """An occurrence's form as the engine shows it: in the text's chosen vernacular writing system
    when the wordform has that alternative, else as its paragraph holds it. Punctuation has one form."""
    if a["kind"] == "punct":
        return a["form"]
    return (a.get("forms") or {}).get(vern) or a["form"]


def to_engine_doc(t, media_urls=None, ws=None):
    """The engine's doc: ONE PHRASE PER LINE (the engine's own flat model), `paraOf` = the FLEx
    paragraph GUID so the serializer and the ¶ control see the paragraph structure, phrase guid =
    segment guid, words from AnalysesRS with `flex` ride-alongs, a phrase-final § flagged
    `boundaryMarker`, label segments `readOnly`, times in ms, media as the text's URIs.

    `ws` = {vern, anal}, the text's writing systems (default_ws when None): words in `vern`; glosses and
    the free translation in `anal` — the ONE analysis writing system the engine shows and edits — and
    every other analysis writing system's glosses and translations as the read-only items the engine's
    language picker already shows (`<item type="gls" lang=…>`, as a .flextext from FLEx carries them)."""
    media_urls = media_urls or {}
    ws = ws or default_ws(t)
    vern, prim = ws["vern"], ws["anal"]
    others = [w for w in (t["analWss"] or []) if w != prim]
    lines, spans = [], []
    for p in t["paragraphs"]:
        for s in p["segments"]:
            raw = segment_text(p, s)
            words = []
            n_an = len(s["analyses"])
            for i, a in enumerate(s["analyses"]):
                w = {"guid": a["guid"] + ":" + str(i), "txt": word_form(a, vern), "punct": a["kind"] == "punct", "phrase": False, "gls": "",
                     "preservedXML": [], "flex": {"analysisGuid": a["guid"], "analysisKind": a["kind"], "index": i}}
                if a["kind"] == "gloss":
                    g = a.get("gloss", {})
                    w["gls"] = g.get(prim, "")
                    w["glsLang"] = prim
                    w["glosses"] = dict(g)
                    w["preservedXML"] = [_gls_item(o, g[o]) for o in others if g.get(o)]
                if a["kind"] == "punct" and a["form"].strip() == SECTION and all(x["kind"] == "punct" for x in s["analyses"][i:]):
                    w["boundaryMarker"] = True
                words.append(w)
            attrs = {"guid": s["guid"]}
            if s["beginTime"] is not None and s["endTime"] is not None:
                attrs["begin-time-offset"] = str(s["beginTime"])
                attrs["end-time-offset"] = str(s["endTime"])
                if s["mediaUri"]:
                    attrs["media-file"] = s["mediaUri"]
            seg = {"attrs": attrs, "baseline": raw.strip(), "words": words, "free": s["ft"].get(prim, ""),
                   "freeLang": prim if s["ft"].get(prim) else None, "frees": dict(s["ft"]), "lits": dict(s["lt"]),
                   "preItemsXML": [], "postItemsXML": [_gls_item(o, s["ft"][o]) for o in others if s["ft"].get(o)], "txtLang": vern,
                   "flex": {"paraGuid": p["guid"], "segGuid": s["guid"], "notes": list(s["notes"])}}
            if s["isLabel"]:
                seg["readOnly"] = True
            lines.append({"guid": "ln-" + s["guid"], "paraOf": p["guid"], "segments": [seg], "flex": {"paraGuid": p["guid"], "segGuid": s["guid"]}})
            if s["beginTime"] is not None and s["endTime"] is not None:
                spans.append({"start": int(s["beginTime"]), "end": int(s["endTime"])})
            else:
                spans.append({"start": 0, "end": 0, "timePending": True})
    doc = {"title": t["title"], "vernLang": vern, "analLang": prim, "languages": [], "appAuthored": False,
           "paragraphs": lines, "segments": spans, "timeEdges": True,
           "flex": {"textGuid": t["guid"], "mediaContainer": t.get("mediaContainer"), "ws": {"vern": vern, "anal": prim},
                    "media": [{"uriGuid": m["guid"], "uri": m["uri"], "url": media_urls.get(m["guid"])} for m in t["media"]]}}
    return doc


def _drop_final_markers(words, is_punct, form):
    """The § boundary marker is FLEx structure, not text (seg-word-split): the engine may show a text
    with its markers replaced by real breaks, while LCM still holds the § punct items. The post-state
    comparison is therefore MARKER-AGNOSTIC: a phrase-final run of § punctuation is dropped on both
    sides before comparing. A § with words after it is text and stays."""
    out = list(words)
    while out and is_punct(out[-1]) and form(out[-1]).strip() == SECTION:
        out.pop()
    # markers inside a trailing punctuation run ("§" then ".") are dropped too
    tail = []
    while out and is_punct(out[-1]):
        tail.append(out.pop())
    tail = [w for w in tail if form(w).strip() != SECTION]
    return out + list(reversed(tail))


def normalize_post_state(post):
    """The engine's intended post-state, made marker-agnostic exactly as read_model_post_state is: the
    engine sends every word of a phrase, FLEx's phrase-final § included, and the re-read drops that run
    — so without this, ANY save touching a paragraph whose phrases end in § (every text FLEx's importer
    wrote) compared "words differ" and rolled back. A § with words after it is text and stays."""
    out = {}
    for pg, phrases in (post or {}).items():
        rows = []
        for ph in phrases or []:
            ph = dict(ph)
            words = ph.get("words")
            if isinstance(words, list):
                kept = _drop_final_markers(words, lambda w: bool(w.get("punct")), lambda w: w.get("txt") or "")
                if len(kept) != len(words):
                    ph["words"] = kept
                    ph["text"] = " ".join(w.get("txt") or "" for w in kept)
            rows.append(ph)
        out[pg] = rows
    return out


def post_state_of(doc, para_guids=None):
    """What the engine says a touched paragraph should look like after the save — compared by
    W4.6 against a re-read of LCM. Per FLEx paragraph: ordered phrases with text, words (form,
    punct), FT per WS, times, and the analysis GUIDs the engine means to keep."""
    out = {}
    for ln in doc["paragraphs"]:
        pg = ln.get("paraOf") or (ln.get("flex") or {}).get("paraGuid")
        if para_guids is not None and pg not in para_guids:
            continue
        for seg in ln["segments"]:
            fx = seg.get("flex") or {}
            frees = dict(seg.get("frees") or {})
            if seg.get("free") is not None and (seg.get("freeLang") or doc.get("analLang")):
                frees[seg.get("freeLang") or doc.get("analLang")] = seg.get("free") or ""
            frees = {k: v for k, v in frees.items() if v}
            a = seg.get("attrs") or {}
            words = _drop_final_markers(seg["words"], lambda w: bool(w.get("punct")), lambda w: w.get("txt") or "")
            out.setdefault(pg, []).append({
                "segGuid": fx.get("segGuid"),
                "text": " ".join(w["txt"] for w in words) if words else (seg.get("baseline") or ""),
                "words": [{"txt": w["txt"], "punct": bool(w.get("punct")), "gls": w.get("gls", ""),
                           "analysisGuid": (w.get("flex") or {}).get("analysisGuid")} for w in words],
                "ft": frees, "lt": {k: v for k, v in (seg.get("lits") or {}).items() if v},
                "begin": a.get("begin-time-offset"), "end": a.get("end-time-offset"),
            })
    return out


def read_model_post_state(t, para_guids=None, ws=None):
    """The same shape from a FlexPort read_text, for the W4.6 comparison — words as the engine shows
    them in the text's vernacular writing system, glosses in its analysis writing system (`ws`)."""
    ws = ws or {"vern": t["vernWs"], "anal": (t["analWss"] or ["en"])[0]}
    out = {}
    for p in t["paragraphs"]:
        if para_guids is not None and p["guid"] not in para_guids:
            continue
        for s in p["segments"]:
            analyses = _drop_final_markers(s["analyses"], lambda a: a["kind"] == "punct", lambda a: a["form"])
            out.setdefault(p["guid"], []).append({
                "segGuid": s["guid"],
                "text": " ".join(word_form(a, ws["vern"]) for a in analyses),
                "words": [{"txt": word_form(a, ws["vern"]), "punct": a["kind"] == "punct",
                           "gls": (a.get("gloss") or {}).get(ws["anal"], ""), "analysisGuid": a["guid"]} for a in analyses],
                "ft": {k: v for k, v in s["ft"].items() if v}, "lt": {k: v for k, v in s["lt"].items() if v},
                "begin": s["beginTime"], "end": s["endTime"],
            })
    return out


def compare_post_state(intended, actual, loose_guids=(), primary=None, others=None):
    """→ [] when they agree, else human-readable mismatches. New segments/analyses (from a split, a
    bare wordform) have GUIDs the engine could not know: `loose_guids` names the paragraphs where
    analysis GUIDs are compared only for words the engine marked as kept.

    With `primary` (the text's analysis writing system) the engine's free translation speaks for that
    writing system only — it never shows or edits another — and `others` = {segGuid: {"ft": {ws: text},
    "lt": {ws: text}}} gives what every OTHER translation must be on the phrases that had one before
    and that no join reshaped (their values before the save, as this save's ft.set/lt.set leave them).
    A phrase a split made, or a join's survivor, holds what LCM gives it there (plan §6.3)."""
    problems = []
    for pg, segs in intended.items():
        got = actual.get(pg)
        if got is None:
            problems.append("paragraph %s missing after write" % pg)
            continue
        if len(got) != len(segs):
            problems.append("paragraph %s: %d phrases intended, %d found" % (pg, len(segs), len(got)))
            continue
        for i, (want, have) in enumerate(zip(segs, got)):
            if want["segGuid"] and want["segGuid"] != have["segGuid"]:
                problems.append("paragraph %s phrase %d: segment guid %s ≠ %s" % (pg, i, want["segGuid"], have["segGuid"]))
            if [w["txt"] for w in want["words"]] != [w["txt"] for w in have["words"]]:
                problems.append("paragraph %s phrase %d: words differ" % (pg, i))
            if primary is None:
                if want["ft"] != have["ft"]:
                    problems.append("paragraph %s phrase %d: free translation differs" % (pg, i))
                if want["lt"] != have["lt"]:
                    problems.append("paragraph %s phrase %d: literal translation differs" % (pg, i))
            else:
                if (want["ft"].get(primary) or "") != (have["ft"].get(primary) or ""):
                    problems.append("paragraph %s phrase %d: free translation differs" % (pg, i))
                exp = (others or {}).get(have["segGuid"])
                if exp is not None:
                    for field, label in (("ft", "free"), ("lt", "literal")):
                        wss = set(exp[field]) | set(have[field])
                        if field == "ft":
                            wss.discard(primary)
                        for w in sorted(wss):
                            if (exp[field].get(w) or "") != (have[field].get(w) or ""):
                                problems.append("paragraph %s phrase %d: %s translation in %s changed" % (pg, i, label, w))
            if (want["begin"], want["end"]) != (have["begin"], have["end"]):
                problems.append("paragraph %s phrase %d: times %r ≠ %r" % (pg, i, (want["begin"], want["end"]), (have["begin"], have["end"])))
            for k, (ww, hw) in enumerate(zip(want["words"], have["words"])):
                if ww.get("analysisGuid") and ww["analysisGuid"] != hw["analysisGuid"]:
                    problems.append("paragraph %s phrase %d word %d: analysis %s ≠ %s" % (pg, i, k, ww["analysisGuid"], hw["analysisGuid"]))
                if ww.get("gls", "") != (hw.get("gls") or ""):
                    problems.append("paragraph %s phrase %d word %d: gloss %r ≠ %r" % (pg, i, k, ww.get("gls"), hw.get("gls")))
    return problems
