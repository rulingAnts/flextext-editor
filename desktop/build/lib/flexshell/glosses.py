"""Set the word gloss of ONE occurrence in WS X (plan §7.2) — stricter than FLEx: no other
occurrence ever changes. Runs inside the caller's UOW and raises on any surprise.

(i)   reuse a gloss in A.MeaningsOC equal to T on every WS in C (blank = blank; tie-break: fewest
      other non-empty WSs) — write nothing to it;
(ii)  else, if g0 exists and is referenced EXACTLY ONCE in the whole project (this occurrence), edit
      it in place, only the WSs that differ;
(iii) else create a new WfiGloss in A.MeaningsOC with T.
All-empty T → point the occurrence back at A (never delete g0) (D5). An unanalysed word gets an
existing FLEx-style trivial analysis or a new one (D6; create path [unverified], V-12). Approval as
FLEx does (D7). [verified] single-use edited in place; shared → new gloss, other untouched;
unanalysed → existing trivial analysis reused plus a new gloss.
"""

from .errors import FlexError


def plan_gloss(port, seg, index, chosen_wss, ws, value):
    """The decision WITHOUT writing: → {outcome, ...} for the preview's wording. `seg` is a SegRead."""
    if not (0 <= index < len(seg["analyses"])):
        raise FlexError("E_SCOPE", "no such word in the phrase", {"index": index})
    occ = seg["analyses"][index]
    if occ["kind"] == "punct":
        raise FlexError("E_SCOPE", "punctuation has no gloss", {"index": index})
    if ws not in chosen_wss:
        raise FlexError("E_SCOPE", "writing system not among the chosen gloss WSs", {"ws": ws})
    g0 = occ if occ["kind"] == "gloss" else None
    a_guid = occ.get("analysisGuid")
    current = dict(g0["gloss"]) if g0 else {}
    target = {w: current.get(w, "") for w in chosen_wss}
    target[ws] = value or ""
    if not any(target.values()):
        return {"outcome": "unglossed", "analysisGuid": a_guid, "target": target, "needsAnalysis": a_guid is None and False}
    if a_guid is None:
        trivial = port.find_trivial_analysis(occ["wordformGuid"])
        return {"outcome": "newGloss", "analysisGuid": trivial, "needsAnalysis": trivial is None,
                "wordformGuid": occ["wordformGuid"], "target": target, "newAnalysis": trivial is None}
    candidates = []
    for g in port.glosses_of(a_guid):
        f = g["forms"]
        if all((f.get(w, "") or "") == (target[w] or "") for w in chosen_wss):
            others = sum(1 for w, t in f.items() if w not in chosen_wss and t)
            candidates.append((others, g["guid"]))
    if candidates:
        candidates.sort()
        return {"outcome": "reuse", "analysisGuid": a_guid, "glossGuid": candidates[0][1], "target": target}
    if g0 and port.gloss_ref_count(g0["guid"]) == 1:
        return {"outcome": "editInPlace", "analysisGuid": a_guid, "glossGuid": g0["guid"], "target": target,
                "changes": {w: target[w] for w in chosen_wss if (current.get(w, "") or "") != (target[w] or "")}}
    return {"outcome": "newGloss", "analysisGuid": a_guid, "target": target,
            "otherUses": port.gloss_ref_count(g0["guid"]) - 1 if g0 else 0}


def set_gloss(port, text_guid, para_guid, seg_guid, index, chosen_wss, ws, value, snapshot_seg=None):
    """Apply, inside the UOW, with the concurrency and invariant checks of §7.2."""
    t = port.read_text(text_guid)
    p = next((x for x in t["paragraphs"] if x["guid"] == para_guid), None)
    seg = next((s for s in (p["segments"] if p else []) if s["guid"] == seg_guid), None)
    if seg is None:
        raise FlexError("E_NOT_FOUND", "segment not found", {"seg": seg_guid})
    if snapshot_seg is not None:
        # 1. concurrency: the occurrence, the baseline and the count must be as at preview
        if (len(seg["analyses"]) != len(snapshot_seg["analyses"])
                or seg["analyses"][index]["guid"] != snapshot_seg["analyses"][index]["guid"]
                or p["contents"][seg["begin"]:seg["end"]] != snapshot_seg.get("_text")):
            raise FlexError("E_STALE_BASE", "the word changed since the preview", {"seg": seg_guid, "index": index})
    plan = plan_gloss(port, seg, index, chosen_wss, ws, value)
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
    g0_forms = dict(occ.get("gloss") or {}) if g0_guid else None
    if plan["outcome"] == "reuse":
        g = plan["glossGuid"]
    elif plan["outcome"] == "editInPlace":
        g = plan["glossGuid"]
        for w, txt in plan["changes"].items():
            port.set_gloss_form(g, w, txt)
    else:
        g = port.create_gloss(a_guid, {w: txt for w, txt in plan["target"].items() if txt})
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
    for w in chosen_wss:
        if (got["gloss"].get(w, "") or "") != (plan["target"][w] or ""):
            raise FlexError("E_INVARIANT", "re-read gloss differs from the target", {"ws": w})
    if g0_guid and plan["outcome"] != "editInPlace":
        # every other reference to g0 still stands and g0's form is unchanged
        for pp in t2["paragraphs"]:
            for ss in pp["segments"]:
                for i, a in enumerate(ss["analyses"]):
                    if a["guid"] == g0_guid and dict(a.get("gloss") or {}) != g0_forms:
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
