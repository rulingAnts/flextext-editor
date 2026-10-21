"""Between LCM's read model and the engine's flextext-shaped doc (plan §4.1), plus the fingerprints
W1/W4/W6 compare (plan §5.3 C5). Pure functions over the plain dicts FlexPort returns."""

import hashlib
import json
import re
import unicodedata
from xml.sax.saxutils import escape as _xml_escape
from xml.sax.saxutils import unescape as _xml_unescape

SECTION = "\u00A7"
LINE_SEP = "\u2028"   # a hard line break (Shift+Enter in FLEx): its own label segment in LCM


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


def to_engine_doc(t, media_urls=None, ws=None, guesses=None):
    """The engine's doc: ONE PHRASE PER LINE (the engine's own flat model), `paraOf` = the FLEx
    paragraph GUID so the serializer and the ¶ control see the paragraph structure, phrase guid =
    segment guid, words from AnalysesRS with `flex` ride-alongs, a phrase-final § flagged
    `boundaryMarker`, label segments `readOnly`, times in ms, media as the text's URIs.

    `ws` = {vern, anal}, the text's writing systems (default_ws when None): words in `vern`; glosses and
    the free translation in `anal` in the engine's editable slot (`gls`, `free`), and every other current
    analysis writing system's as the items a .flextext from FLEx carries (`<item type="gls" lang=…>`) —
    every one of them shown and editable in the Matcher (2026-10-16), compared per writing system by
    the diff, and written back only where it changed (glosses.py).

    `guesses` = port.guesses(text): a word with no analysis of its own carries FLEx's guess for it as
    `flex.guess` = {analysisGuid, glossGuid, gloss: {ws: text}, form} — shown, never its own gloss; a
    gloss typed into the word adopts it, and the save builds on it (glosses.plan_gloss)."""
    media_urls = media_urls or {}
    guesses = guesses or {}
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
                # `flex.seg` + `flex.index` name the occurrence as read — unique in the text, and carried by
                # the word wherever an edit moves it (the engine keys a word's gloss by them, flex-ops.js)
                w = {"guid": a["guid"] + ":" + str(i), "txt": word_form(a, vern), "punct": a["kind"] == "punct", "phrase": False, "gls": "",
                     "preservedXML": [], "flex": {"analysisGuid": a["guid"], "analysisKind": a["kind"], "index": i, "seg": s["guid"]}}
                gs = guesses.get(s["guid"], {}).get(i) if a["kind"] == "wordform" else None
                if gs and gs.get("analysisGuid"):
                    w["flex"]["guess"] = {"analysisGuid": gs["analysisGuid"], "glossGuid": gs.get("glossGuid"),
                                          "gloss": dict(gs.get("gloss") or {}), "form": w["txt"]}
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
                    # every current analysis writing system, in FLEx's order: each is shown and editable,
                    # whether or not this text has anything in it yet
                    "anals": list(t["analWss"] or []),
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


_GLS_ITEM = re.compile(r'^\s*<item\b([^>]*?)(?:/>|>([\s\S]*?)</item>)')


def _gls_items(xmls):
    """{lang: text} of the top-level <item type="gls"> strings an engine doc carries (flextext.js
    wordGlosses / phraseFrees read the same ones)."""
    out = {}
    for x in xmls or []:
        m = _GLS_ITEM.match(x or "")
        if not m:
            continue
        attrs = dict(re.findall(r'([\w:-]+)="([^"]*)"', m.group(1)))
        if attrs.get("type") != "gls":
            continue
        lang = _xml_unescape(attrs.get("lang", ""), {"&quot;": '"', "&apos;": "'"})
        out.setdefault(lang, _xml_unescape(m.group(2) or "", {"&quot;": '"', "&apos;": "'"}))
    return out


def word_gloss_map(w, prim):
    """Every gloss an engine word carries, {ws: text} with the empties dropped: the editable one
    (`gls` in `glsLang`, the doc's analysis language when unset) and every other language's item."""
    out = {}
    if w.get("gls") or w.get("glsLang"):
        out[w.get("glsLang") or prim] = w.get("gls") or ""
    for lang, text in _gls_items(w.get("preservedXML")).items():
        out.setdefault(lang or prim, text)
    return {k: unicodedata.normalize("NFC", v) for k, v in out.items() if v}


def phrase_free_map(seg, prim):
    out = {}
    if seg.get("free") or seg.get("freeLang"):
        out[seg.get("freeLang") or prim] = seg.get("free") or ""
    for lang, text in _gls_items(list(seg.get("preItemsXML") or []) + list(seg.get("postItemsXML") or [])).items():
        out.setdefault(lang or prim, text)
    return {k: unicodedata.normalize("NFC", v) for k, v in out.items() if v}


def post_state_of(doc, para_guids=None):
    """What the engine says a touched paragraph should look like after the save — compared by
    W4.6 against a re-read of LCM. Per FLEx paragraph: ordered phrases with text, words (form,
    punct, the gloss in every writing system), FT per WS, times, and the analysis GUIDs the engine
    means to keep. (The engine's own is flex-ops.js postStateOf; this one serves the shell's tests.)"""
    out = {}
    prim = doc.get("analLang") or "en"
    for ln in doc["paragraphs"]:
        pg = ln.get("paraOf") or (ln.get("flex") or {}).get("paraGuid")
        if para_guids is not None and pg not in para_guids:
            continue
        for seg in ln["segments"]:
            fx = seg.get("flex") or {}
            a = seg.get("attrs") or {}
            words = _drop_final_markers(seg["words"], lambda w: bool(w.get("punct")), lambda w: w.get("txt") or "")
            out.setdefault(pg, []).append({
                "segGuid": fx.get("segGuid"),
                "text": " ".join(w["txt"] for w in words) if words else (seg.get("baseline") or ""),
                "words": [{"txt": w["txt"], "punct": bool(w.get("punct")), "gls": w.get("gls", ""),
                           "glosses": {} if w.get("punct") else word_gloss_map(w, prim),
                           "analysisGuid": (w.get("flex") or {}).get("analysisGuid")} for w in words],
                "ft": phrase_free_map(seg, prim), "lt": {k: v for k, v in (seg.get("lits") or {}).items() if v},
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
                           "gls": (a.get("gloss") or {}).get(ws["anal"], ""),
                           "glosses": {k: unicodedata.normalize("NFC", v) for k, v in (a.get("gloss") or {}).items() if v},
                           "analysisGuid": a["guid"]} for a in analyses],
                "ft": {k: v for k, v in s["ft"].items() if v}, "lt": {k: v for k, v in s["lt"].items() if v},
                "begin": s["beginTime"], "end": s["endTime"],
            })
    return out


def _nfc(s):
    return unicodedata.normalize("NFC", s or "")


def is_break_row(ph):
    """A post-state row that is only hard line breaks — FLEx's label segment for one, as read back or as the engine
    carries a break row (its words the break itself, or none)."""
    words = ph.get("words") or []
    if any(not set(w.get("txt") or "") <= {LINE_SEP} for w in words):
        return False
    txt = "".join(w.get("txt") or "" for w in words) + (ph.get("text") or "")
    # the break itself must be there: an empty row is not a break, and dropping it would hide what it says
    return LINE_SEP in txt and not txt.replace(LINE_SEP, "").strip()


def compare_post_state(intended, actual, loose_guids=(), primary=None, others=None, visible=None):
    """→ [] when they agree, else human-readable mismatches. New segments/analyses (from a split, a
    bare wordform) have GUIDs the engine could not know: `loose_guids` names the paragraphs where
    analysis GUIDs are compared only for words the engine marked as kept.

    `visible` = the analysis writing systems the engine shows and edits (FLEx's current ones for the
    text): the engine's free translations and word glosses speak for every one of them — in each, the
    re-read must hold exactly what the engine sends (nothing there = nothing in FLEx). With only
    `primary`, the engine speaks for that one writing system (an older engine's post-state). `others` =
    {segGuid: {"ft": {ws: text}, "lt": {ws: text}}} gives what every translation the engine does NOT
    speak for must be, on the phrases that had one before and that no join reshaped (their values
    before the save, as this save's ft.set/lt.set leave them). A phrase a split made, or a join's
    survivor, holds what LCM gives it there (plan §6.3)."""
    if visible is None and primary is not None:
        visible = {primary}
    visible = set(visible) if visible is not None else None
    # A hard line break is FLEx structure, not a phrase: LCM keeps each as a one-character label segment, which a
    # save may make (a split, the paragraph toggle off) or take out (a join, the toggle on) while the engine's
    # intended result has none of the new ones. Compared on both sides without them (2026-10-21: hard line breaks,
    # never §); the phrases around them, their GUIDs, words and translations are compared as before.
    intended = {pg: [r for r in segs if not is_break_row(r)] for pg, segs in intended.items()}
    actual = {pg: [r for r in segs if not is_break_row(r)] for pg, segs in actual.items()}
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
            if visible is None:
                if want["ft"] != have["ft"]:
                    problems.append("paragraph %s phrase %d: free translation differs" % (pg, i))
                if want["lt"] != have["lt"]:
                    problems.append("paragraph %s phrase %d: literal translation differs" % (pg, i))
            else:
                for w in sorted(visible):
                    if _nfc(want["ft"].get(w)) != _nfc(have["ft"].get(w)):
                        problems.append("paragraph %s phrase %d: free translation differs in %s" % (pg, i, w))
                exp = (others or {}).get(have["segGuid"])
                if exp is not None:
                    for field, label in (("ft", "free"), ("lt", "literal")):
                        wss = set(exp[field]) | set(have[field])
                        if field == "ft":
                            wss -= visible
                        for w in sorted(wss):
                            if (exp[field].get(w) or "") != (have[field].get(w) or ""):
                                problems.append("paragraph %s phrase %d: %s translation in %s changed" % (pg, i, label, w))
            if (want["begin"], want["end"]) != (have["begin"], have["end"]):
                problems.append("paragraph %s phrase %d: times %r ≠ %r" % (pg, i, (want["begin"], want["end"]), (have["begin"], have["end"])))
            for k, (ww, hw) in enumerate(zip(want["words"], have["words"])):
                if ww.get("analysisGuid") and ww["analysisGuid"] != hw["analysisGuid"]:
                    problems.append("paragraph %s phrase %d word %d: analysis %s ≠ %s" % (pg, i, k, ww["analysisGuid"], hw["analysisGuid"]))
                if visible is not None and isinstance(ww.get("glosses"), dict):
                    # the gloss in every writing system the engine speaks for (one shared by several
                    # words is checked by glosses.set_gloss: no other occurrence changes)
                    for w in sorted(visible):
                        a_, b_ = _nfc(ww["glosses"].get(w)), _nfc((hw.get("glosses") or {}).get(w))
                        if a_ != b_:
                            problems.append("paragraph %s phrase %d word %d: gloss in %s %r ≠ %r" % (pg, i, k, w, a_, b_))
                elif ww.get("gls", "") != (hw.get("gls") or ""):
                    problems.append("paragraph %s phrase %d word %d: gloss %r ≠ %r" % (pg, i, k, ww.get("gls"), hw.get("gls")))
    return problems
