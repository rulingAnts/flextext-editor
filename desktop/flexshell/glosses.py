"""Set the word gloss of ONE occurrence (plan §7.2) — stricter than FLEx: no other occurrence ever
changes, and no writing system the save does not name changes either. Runs inside the caller's UOW
and raises on any surprise.

`changes` = {ws: text}: the writing systems edited in the app, and only those (Seth, 2026-10-16: "If
it edits a GUID object (a word), it should ONLY change what we changed and leave everything else
preserved. I don't want it erasing data in other writing systems or languages when I edit ONE of
them"). The TARGET T is the occurrence's gloss as it is now in EVERY writing system it has — shown in
the app or not, current or not — with just those replaced:

(i)   reuse a gloss of the analysis equal to T in every writing system (blank = blank; the first in
      FLEx's order) — write nothing to it;
(ii)  else, if g0 exists and is referenced EXACTLY ONCE in the whole project (this occurrence), edit
      it in place: only the writing systems whose text changes;
(iii) else create a new WfiGloss in A.MeaningsOC holding T — every writing system g0 had comes along.
T the same as now → nothing is written. All-empty T → point the occurrence back at A (never delete
g0) (D5). An unanalysed word gets an existing FLEx-style trivial analysis or a new one (D6; create
path [unverified], V-12) — and a gloss of that analysis equal to T, if it has one. Approval as FLEx
does (D7). [verified] single-use edited in place; shared → new gloss, other untouched; unanalysed →
existing trivial analysis reused plus a new gloss.

ONE SAVE, MANY WORDS. The preview plans every gloss of a save before any is written, but each one runs
on what the ones before it left: a second unanalysed copy of a word finds the analysis the first one
made, a gloss made or edited for one word is the one another word may reuse, and a gloss another word
has just started pointing at is no longer single-use. `Planner` replays the save's gloss ops in the
order the save runs them over a simulation of those effects, so the preview's object counts are the
save's — W4 refuses any difference, and a planner that ignored them rolled back a save glossing the
same unanalysed word twice.

A word made by the same save (a split's halves, an added word, a join) does not exist until the save's
structural ops have run: its gloss op runs after them (`new_word` = its form), and is planned on the
bare wordform FLEx makes for it, or the one it already has with that form.
"""

from .errors import FlexError
from .port import nfc


def _norm(forms):
    """{ws: text} with the empty alternatives dropped, NFC — blank and missing are the same gloss."""
    return {w: nfc(t) for w, t in (forms or {}).items() if t}


def target_of(current, changes):
    """The occurrence's gloss after `changes`: every writing system it has now, those replaced."""
    target = dict(_norm(current))
    for w, v in (changes or {}).items():
        if v:
            target[w] = nfc(v)
        else:
            target.pop(w, None)
    return target


def check_changes(changes, allowed_wss):
    if not isinstance(changes, dict) or not changes:
        raise FlexError("E_SCOPE", "a gloss change names no writing system", {})
    for w, v in changes.items():
        if w not in allowed_wss:
            raise FlexError("E_SCOPE", "writing system not among the text's analysis writing systems", {"ws": w})
        if not isinstance(v, str):
            raise FlexError("E_SCOPE", "a gloss must be text", {"ws": w})


def plan_gloss(port, seg, index, changes, allowed_wss, occurrence=None):
    """The decision WITHOUT writing: → {outcome, target, changed, ...} for the preview's wording. `seg`
    is a SegRead; `occurrence` stands in for a word the save has not made yet. `port` needs only
    find_trivial_analysis, glosses_of and gloss_ref_count (a Planner provides them for a whole save)."""
    check_changes(changes, allowed_wss)
    if occurrence is None:
        if not (0 <= index < len(seg["analyses"])):
            raise FlexError("E_SCOPE", "no such word in the phrase", {"index": index})
        occ = seg["analyses"][index]
    else:
        occ = occurrence
    if occ["kind"] == "punct":
        raise FlexError("E_SCOPE", "punctuation has no gloss", {"index": index})
    g0 = occ if occ["kind"] == "gloss" else None
    a_guid = occ.get("analysisGuid")
    current = _norm(g0["gloss"]) if g0 else {}
    target = target_of(current, changes)
    if target == current:
        return {"outcome": "unchanged", "analysisGuid": a_guid, "target": target, "changed": []}
    changed = sorted(w for w in set(target) | set(current) if target.get(w, "") != current.get(w, ""))
    if not target:
        return {"outcome": "unglossed", "analysisGuid": a_guid, "target": target, "changed": changed,
                "from": g0["guid"] if g0 else None}
    new_analysis = False
    if a_guid is None:
        a_guid = port.find_trivial_analysis(occ["wordformGuid"]) if occ.get("wordformGuid") else None
        new_analysis = a_guid is None
    plan = {"analysisGuid": a_guid, "target": target, "changed": changed, "from": g0["guid"] if g0 else None,
            "wordformGuid": occ.get("wordformGuid")}
    if new_analysis:
        return dict(plan, outcome="newGloss", needsAnalysis=True, newAnalysis=True)
    for g in port.glosses_of(a_guid):
        if _norm(g["forms"]) == target:
            return dict(plan, outcome="reuse", glossGuid=g["guid"])
    if g0 and port.gloss_ref_count(g0["guid"]) == 1:
        return dict(plan, outcome="editInPlace", glossGuid=g0["guid"], changes={w: target.get(w, "") for w in changed})
    return dict(plan, outcome="newGloss", otherUses=port.gloss_ref_count(g0["guid"]) - 1 if g0 else 0)


class Planner:
    """A save's gloss ops, planned in the order the save runs them, each on what the ones before it
    leave (module docstring). Wraps the port for plan_gloss: the analyses, glosses and references the
    earlier ops make, edit or move are seen by the later ones. Never writes."""

    def __init__(self, port, new_wordforms=()):
        self.port = port
        self.new_wordforms = set(new_wordforms)   # (form, ws) the save's word ops create
        self.trivial = {}        # wordform key → analysis marker made by an earlier op
        self.made = {}           # analysis (guid or marker) → [{guid: marker, forms}]
        self.edited = {}         # gloss guid → forms after an earlier op's edit in place
        self.refs = {}           # gloss guid → change in references
        self._n = 0

    def _new(self, what):
        self._n += 1
        return "planned-%s-%d" % (what, self._n)

    # what plan_gloss asks
    def find_trivial_analysis(self, wordform_key):
        if wordform_key in self.trivial:
            return self.trivial[wordform_key]
        if str(wordform_key).startswith("planned-"):
            return None
        return self.port.find_trivial_analysis(wordform_key)

    def glosses_of(self, analysis):
        real = [] if str(analysis).startswith("planned-") else self.port.glosses_of(analysis)
        out = [{"guid": g["guid"], "forms": self.edited.get(g["guid"], g["forms"])} for g in real]
        return out + [dict(g) for g in self.made.get(analysis, [])]

    def gloss_ref_count(self, gloss):
        base = 0 if str(gloss).startswith("planned-") else self.port.gloss_ref_count(gloss)
        return base + self.refs.get(gloss, 0)

    def wordform_of(self, form, ws):
        """A new word's wordform: FLEx's, or the one an earlier word op of this save makes."""
        wf = self.port.find_wordform(form, ws)
        if wf is None and (nfc(form), ws) in self.new_wordforms:
            return "planned-wf:%s@%s" % (nfc(form), ws)
        return wf

    def plan(self, seg, index, changes, allowed_wss, new_word=None, ws=None):
        """Plan one op and record what it will do. `new_word` = the form of a word the save makes."""
        occ = None
        if new_word is not None:
            wf = self.wordform_of(new_word, ws)
            occ = {"kind": "wordform", "guid": wf, "wordformGuid": wf or "planned-wf:%s@%s" % (nfc(new_word), ws), "form": nfc(new_word)}
        plan = plan_gloss(self, seg, index, changes, allowed_wss, occurrence=occ)
        out = plan["outcome"]
        if out in ("unchanged",):
            return plan
        if plan.get("from"):
            self.refs[plan["from"]] = self.refs.get(plan["from"], 0) - 1
        if out == "unglossed":
            return plan
        if plan.get("newAnalysis"):
            a = self._new("analysis")
            self.trivial[plan["wordformGuid"]] = a
            plan["analysisGuid"] = a
        if out == "newGloss":
            g = self._new("gloss")
            self.made.setdefault(plan["analysisGuid"], []).append({"guid": g, "forms": dict(plan["target"])})
            plan["glossGuid"] = g
        elif out == "editInPlace":
            self.edited[plan["glossGuid"]] = dict(plan["target"])
        self.refs[plan["glossGuid"]] = self.refs.get(plan["glossGuid"], 0) + 1
        return plan


def set_gloss(port, text_guid, para_guid, seg_guid, index, changes, allowed_wss, snapshot_seg=None, new_word=None):
    """Apply, inside the UOW, with the concurrency and invariant checks of §7.2. `new_word` = the form
    of a word this save made (the op runs after the save's structural ops): the occurrence must be
    exactly that bare wordform, or nothing is written."""
    t = port.read_text(text_guid)
    p = next((x for x in t["paragraphs"] if x["guid"] == para_guid), None)
    seg = next((s for s in (p["segments"] if p else []) if s["guid"] == seg_guid), None)
    if seg is None and new_word is not None:
        # a word in a phrase or paragraph this save made: the segment is wherever the save put it
        for pp in t["paragraphs"]:
            seg = next((s for s in pp["segments"] if s["guid"] == seg_guid), None)
            if seg is not None:
                p, para_guid = pp, pp["guid"]
                break
    if seg is None:
        raise FlexError("E_NOT_FOUND", "segment not found", {"seg": seg_guid})
    if snapshot_seg is not None:
        # 1. concurrency: the occurrence, the baseline and the count must be as at preview
        if (len(seg["analyses"]) != len(snapshot_seg["analyses"])
                or seg["analyses"][index]["guid"] != snapshot_seg["analyses"][index]["guid"]
                or p["contents"][seg["begin"]:seg["end"]] != snapshot_seg.get("_text")):
            raise FlexError("E_STALE_BASE", "the word changed since the preview", {"seg": seg_guid, "index": index})
    if new_word is not None:
        occ = seg["analyses"][index] if 0 <= index < len(seg["analyses"]) else None
        if occ is None or occ["kind"] != "wordform" or nfc(occ["form"]) != nfc(new_word):
            raise FlexError("E_INVARIANT", "a word this save made is not where the save expected it", {"seg": seg_guid, "index": index})
    plan = plan_gloss(port, seg, index, changes, allowed_wss)
    if plan["outcome"] == "unchanged":
        return plan
    occ = seg["analyses"][index]
    a_guid = plan.get("analysisGuid")
    before_counts = port.counts()
    if plan["outcome"] == "unglossed":
        if a_guid:
            port.set_analysis(seg_guid, index, a_guid)
        return plan
    if plan.get("newAnalysis"):
        a_guid = port.create_trivial_analysis(plan["wordformGuid"])
        plan["analysisGuid"] = a_guid
    g0_guid = occ["guid"] if occ["kind"] == "gloss" else None
    g0_forms = _norm(occ.get("gloss")) if g0_guid else None
    if plan["outcome"] == "reuse":
        g = plan["glossGuid"]
    elif plan["outcome"] == "editInPlace":
        g = plan["glossGuid"]
        for w, txt in plan["changes"].items():
            port.set_gloss_form(g, w, txt)
    else:
        g = port.create_gloss(a_guid, dict(plan["target"]))
        plan["glossGuid"] = g
    port.set_analysis(seg_guid, index, g)
    # 7. approval as FLEx does
    approved_now = False
    if not port.is_approved(a_guid):
        port.set_evaluation(a_guid, True)
        approved_now = True
    plan["approved"] = approved_now
    # 8. invariants
    t2 = port.read_text(text_guid)
    p2 = next(x for x in t2["paragraphs"] if x["guid"] == para_guid)
    s2 = next(s for s in p2["segments"] if s["guid"] == seg_guid)
    got = s2["analyses"][index]
    if got["guid"] != g or got["kind"] != "gloss" or got["analysisGuid"] != a_guid:
        raise FlexError("E_INVARIANT", "the occurrence does not point at the chosen gloss", {"seg": seg_guid})
    # EVERY writing system, not only the ones edited: the ones the save does not name are as they were
    have = _norm(got["gloss"])
    if have != plan["target"]:
        bad = sorted(w for w in set(have) | set(plan["target"]) if have.get(w, "") != plan["target"].get(w, ""))
        raise FlexError("E_INVARIANT", "re-read gloss differs from the target", {"ws": bad})
    if g0_guid and plan["outcome"] != "editInPlace":
        # every other reference to g0 still stands and g0's forms are unchanged
        for pp in t2["paragraphs"]:
            for ss in pp["segments"]:
                for a in ss["analyses"]:
                    if a["guid"] == g0_guid and _norm(a.get("gloss")) != g0_forms:
                        raise FlexError("E_INVARIANT", "a shared gloss changed", {"gloss": g0_guid})
    after = port.counts()
    for cls in ("LexEntry", "LexSense", "MoForm", "WfiWordform"):
        if after[cls] != before_counts[cls]:
            raise FlexError("E_INVARIANT", "%s count changed by a gloss edit" % cls, {})
    exp_an = 1 if plan.get("newAnalysis") else 0
    exp_mb = 1 if plan.get("newAnalysis") else 0
    exp_gl = 1 if plan["outcome"] == "newGloss" else 0
    if after["WfiAnalysis"] - before_counts["WfiAnalysis"] != exp_an or after["WfiMorphBundle"] - before_counts["WfiMorphBundle"] != exp_mb \
            or after["WfiGloss"] - before_counts["WfiGloss"] != exp_gl:
        raise FlexError("E_INVARIANT", "object counts differ from what the gloss plan announced", {})
    return plan
