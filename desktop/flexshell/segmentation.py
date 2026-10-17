"""The § recipes (plan §6.3–§6.5), written against FlexPort. Every function runs INSIDE the
caller's UOW and raises on any surprise — the protocol turns a raise into a rollback. Nothing here
calls flexicon's segment operations (plan §6.6: SplitSegment corrupts, MergeSegments leaves the §).

Offsets are in the NFD contents string LCM holds; the engine's NFC text is converted at the port.
"""

from .errors import FlexError
from .lcm_mock import EOS_CHARS, CLOSERS, is_word_forming, tokenize, SECTION, LINE_SEP
from .port import lcm_diff, nfd

INVARIANT_MSG = "segment offsets disagree with the breaker"


def para_of(port, text_guid, para_guid):
    t = port.read_text(text_guid)
    for p in t["paragraphs"]:
        if p["guid"] == para_guid:
            return p
    raise FlexError("E_NOT_FOUND", "paragraph not in text", {"para": para_guid})


def check_invariant(port, p):
    """THE INVARIANT (plan §6.2): stored BeginOffsets == the breaker's IchMins, no zero-length
    segment. A paragraph failing it before an edit is FRAGILE (E_FRAGILE_PARAGRAPH); after an edit it
    raises E_INVARIANT inside the UOW → rollback."""
    stored = [s["begin"] for s in p["segments"]]
    derived = [b for b, e in port.get_segments(p["contents"], p["ws"])]
    if stored != derived:
        return False
    if any(s["end"] <= s["begin"] for s in p["segments"]):
        return False
    return True


def require_not_fragile(port, p):
    if not check_invariant(port, p):
        raise FlexError("E_FRAGILE_PARAGRAPH", "this paragraph's stored segments do not match FLEx's own breaks; "
                        "open it in FLEx first", {"para": p["guid"]})


def assert_invariant(port, text_guid, para_guid):
    p = para_of(port, text_guid, para_guid)
    if not check_invariant(port, p):
        raise FlexError("E_INVARIANT", INVARIANT_MSG, {"para": para_guid})
    return p


def _assign(port, p, new_text, expect=None):
    """ONE Contents assignment, after checking the diff LCM will see (TsStringUtils.GetDiffsInTsStrings
    on the real backend) is exactly the one we predict THE WAY LCM COMPUTES IT — longest common prefix,
    then longest common suffix (plan §6.3 step 3, §6.5 risk 1). Deleting " §" and deleting "§ " give
    the same string, so the prediction is made from the strings, never from the caller's intent;
    `expect`, when given, pins only the SIZE of the edit the caller meant."""
    old = nfd(p["contents"])
    new = nfd(new_text)
    predicted = lcm_diff(old, new)
    got = tuple(port.get_diffs(old, new))
    if got != predicted:
        raise FlexError("E_INVARIANT", "LCM would see a different edit than predicted",
                        {"para": p["guid"], "predicted": list(predicted), "lcm": list(got)})
    if expect is not None and (predicted[1], predicted[2]) != (expect[1], expect[2]):
        raise FlexError("E_INVARIANT", "the edit is not the size intended",
                        {"para": p["guid"], "intended": list(expect), "lcm": list(got)})
    port.set_contents(p["guid"], new)


def _ends_with_eos(text):
    t = text.rstrip()
    while t and t[-1] in CLOSERS:
        t = t[:-1]
    return bool(t) and t[-1] in EOS_CHARS


def _has_word(text):
    return any(is_word_forming(c) for c in text)


def word_token_ends(p, seg):
    """[(ichMin, ichLim)] of the segment's tokens in paragraph offsets."""
    txt = p["contents"][seg["begin"]:seg["end"]]
    return [(seg["begin"] + a, seg["begin"] + b, form, punct) for a, b, form, punct in tokenize(txt)]


# ---- §6.3 phrase operations ---------------------------------------------------------------------
def split_phrase(port, text_guid, para_guid, seg_guid, after_word_index, new_times=None):
    """Split segment k between word i and i+1 (word indices count ALL analyses incl. punctuation,
    as AnalysesRS does). Returns the new segment's guid. [verified] recipe:
      p = just after the last character of the first half (after any trailing punctuation);
      both halves must contain a word-forming character; if the first half does not already end in
      an EOS character, insert "§" at p (a space must already follow, else insert "§ "); LCM creates
      the new segment at k+1 — k keeps GUID, FT, notes and start time; set the new one's times,
      MediaURIRA and SpeakerRA (= k's), trim k's end time."""
    p = para_of(port, text_guid, para_guid)
    require_not_fragile(port, p)
    k = next((i for i, s in enumerate(p["segments"]) if s["guid"] == seg_guid), None)
    if k is None:
        raise FlexError("E_NOT_FOUND", "segment not in paragraph", {"seg": seg_guid})
    seg = p["segments"][k]
    toks = word_token_ends(p, seg)
    if not (0 <= after_word_index < len(toks) - 1):
        raise FlexError("E_SCOPE", "no word boundary at that index", {"index": after_word_index, "tokens": len(toks)})
    # the cut falls after the last token of the first half INCLUDING trailing punctuation
    i = after_word_index
    while i + 1 < len(toks) - 1 and toks[i + 1][3]:
        i += 1
    cut = toks[i][1]
    first = p["contents"][seg["begin"]:cut]
    second = p["contents"][cut:seg["end"]]
    if not _has_word(first) or not _has_word(second):
        raise FlexError("E_EMPTY_PHRASE", "both halves need a word-forming character", {"seg": seg_guid})
    old = p["contents"]
    if _ends_with_eos(first):
        raise FlexError("E_SCOPE", "a boundary at real punctuation is already a FLEx break", {"seg": seg_guid})
    if cut < len(old) and old[cut].isspace():
        ins = SECTION
    else:
        ins = SECTION + " "
    new = old[:cut] + ins + old[cut:]
    _assign(port, p, new, (cut, len(ins), 0))
    p2 = assert_invariant(port, text_guid, para_guid)
    if len(p2["segments"]) != len(p["segments"]) + 1:
        raise FlexError("E_INVARIANT", "LCM did not create exactly one segment", {"seg": seg_guid})
    kept, created = p2["segments"][k], p2["segments"][k + 1]
    if kept["guid"] != seg_guid:
        raise FlexError("E_INVARIANT", "segment k lost its GUID", {"seg": seg_guid})
    # analyses: every pre-existing analysis GUID kept; the only new one is the § PunctuationForm
    old_an = [a["guid"] for a in seg["analyses"]]
    new_an = [a["guid"] for a in kept["analyses"]] + [a["guid"] for a in created["analyses"]]
    extra = [g for g in new_an if g not in old_an]
    if len(extra) > 1 or [g for g in old_an if g not in new_an]:
        raise FlexError("E_INVARIANT", "analyses changed beyond the § item", {"seg": seg_guid})
    # times, media, speaker onto the new half
    if seg["mediaUri"]:
        port.set_segment_media(created["guid"], seg["mediaUri"])
    if seg["speaker"]:
        port.set_segment_speaker(created["guid"], seg["speaker"])
    if new_times:
        (b1, e1), (b2, e2) = new_times
        port.set_segment_times(seg_guid, b1, e1)
        port.set_segment_times(created["guid"], b2, e2)
    return created["guid"]


def join_phrases(port, text_guid, para_guid, seg_guid, new_end_time=None):
    """Join segment k with k+1 across a §: delete the § (leave the space). [verified] LCM merges
    k+1 into k — FT/LT joined with a space, notes moved, analyses kept; k+1's GUID, times, media and
    speaker gone. Set k's EndTimeOffset to the old k+1 end. A boundary at real punctuation is never
    joined by silently deleting the mark (E_SCOPE)."""
    p = para_of(port, text_guid, para_guid)
    require_not_fragile(port, p)
    k = next((i for i, s in enumerate(p["segments"]) if s["guid"] == seg_guid), None)
    if k is None or k + 1 >= len(p["segments"]):
        raise FlexError("E_NOT_FOUND", "no following segment to join", {"seg": seg_guid})
    seg, nxt = p["segments"][k], p["segments"][k + 1]
    if seg["isLabel"] or nxt["isLabel"]:
        # a hard line break (U+2028) is a label segment of its own, not a § to delete (protocol.preview says so first)
        raise FlexError("E_SCOPE", "a line break from FLEx sits here; remove it in FLEx to join these phrases", {"seg": seg_guid, "lineBreak": True})
    toks = word_token_ends(p, seg)
    if not toks or toks[-1][2] != SECTION:
        raise FlexError("E_SCOPE", "this boundary is real punctuation; change the text explicitly instead", {"seg": seg_guid})
    a, b = toks[-1][0], toks[-1][1]
    old = p["contents"]
    # delete the § and ONE adjacent space so the words do not end up doubly spaced
    if a > 0 and old[a - 1].isspace() and b < len(old) and old[b].isspace():
        a -= 1
    new = old[:a] + old[b:]
    _assign(port, p, new, (a, 0, b - a))
    p2 = assert_invariant(port, text_guid, para_guid)
    if len(p2["segments"]) != len(p["segments"]) - 1 or p2["segments"][k]["guid"] != seg_guid:
        raise FlexError("E_INVARIANT", "LCM did not merge exactly one segment into k", {"seg": seg_guid})
    end = new_end_time if new_end_time is not None else nxt["endTime"]
    if end is not None and seg["beginTime"] is not None:
        port.set_segment_times(seg_guid, seg["beginTime"], end)
    return seg_guid


def move_boundary(port, text_guid, para_guid, seg_guid, new_after_word_index):
    """Shift words between k and k+1: ONE Contents assignment that removes the old § and inserts
    the new one [verified: both GUIDs, FTs and times survive; two separate assignments lose the
    second segment and its times]. Words inside the diff span become bare wordforms — restored here
    from the snapshot."""
    p = para_of(port, text_guid, para_guid)
    require_not_fragile(port, p)
    k = next((i for i, s in enumerate(p["segments"]) if s["guid"] == seg_guid), None)
    if k is None or k + 1 >= len(p["segments"]):
        raise FlexError("E_NOT_FOUND", "no following segment", {"seg": seg_guid})
    seg, nxt = p["segments"][k], p["segments"][k + 1]
    toks_k = word_token_ends(p, seg)
    if not toks_k or toks_k[-1][2] != SECTION:
        raise FlexError("E_SCOPE", "the boundary is real punctuation", {"seg": seg_guid})
    both = toks_k[:-1] + word_token_ends(p, nxt)      # all tokens of k and k+1 without the §
    words = [t for t in both if not t[3]]
    if not (0 <= new_after_word_index < len(words) - 1):
        raise FlexError("E_SCOPE", "no word boundary at that index", {"index": new_after_word_index})
    cut_tok = words[new_after_word_index]
    j = both.index(cut_tok)
    while j + 1 < len(both) and both[j + 1][3]:
        j += 1
    cut = both[j][1]
    old = p["contents"]
    sa, sb = toks_k[-1][0], toks_k[-1][1]
    # remove "§" (and one space) at sa..sb; insert "§" after `cut` (adjusting for the removal)
    rm_a, rm_b = sa, sb
    if rm_a > 0 and old[rm_a - 1].isspace() and rm_b < len(old) and old[rm_b].isspace():
        rm_a -= 1
    without = old[:rm_a] + old[rm_b:]
    cut2 = cut - (rm_b - rm_a) if cut >= rm_b else cut
    ins = SECTION if (cut2 < len(without) and without[cut2].isspace()) else SECTION + " "
    new = without[:cut2] + ins + without[cut2:]
    if new == old:
        raise FlexError("E_SCOPE", "the boundary is already there", {"seg": seg_guid})
    # snapshot analyses by word form order for restoration
    snapshot = [(t[2], a["guid"]) for t, a in zip(both, (seg["analyses"][:-1] + nxt["analyses"]))]
    port.set_contents(p["guid"], nfd(new))
    p2 = assert_invariant(port, text_guid, para_guid)
    if len(p2["segments"]) != len(p["segments"]) or p2["segments"][k]["guid"] != seg_guid or p2["segments"][k + 1]["guid"] != nxt["guid"]:
        raise FlexError("E_INVARIANT", "a boundary move did not keep both segments", {"seg": seg_guid})
    # restore analyses: walk the two new segments' tokens, skipping the §, and re-point bare items
    # whose form matches the snapshot at that position
    pos = 0
    for s2 in (p2["segments"][k], p2["segments"][k + 1]):
        for i, a in enumerate(s2["analyses"]):
            if a["kind"] == "punct" and a["form"].strip() == SECTION:
                continue
            if pos < len(snapshot) and snapshot[pos][0] == a["form"] and snapshot[pos][1] != a["guid"]:
                port.set_analysis(s2["guid"], i, snapshot[pos][1])
            pos += 1
    assert_invariant(port, text_guid, para_guid)
    return seg_guid


# ---- §6.4 paragraph operations ------------------------------------------------------------------
def phrase_to_paragraph(port, text_guid, para_guid, seg_guid):
    """Phrase boundary → paragraph boundary: SplitParaAt(seg[k+1].BeginOffset) exactly on the
    boundary (mid-segment would duplicate the FT [verified]), then delete the trailing "§ " from
    the first paragraph (kept if it is real punctuation). Returns the new paragraph guid."""
    p = para_of(port, text_guid, para_guid)
    require_not_fragile(port, p)
    k = next((i for i, s in enumerate(p["segments"]) if s["guid"] == seg_guid), None)
    if k is None or k + 1 >= len(p["segments"]):
        raise FlexError("E_NOT_FOUND", "no following segment", {"seg": seg_guid})
    nxt = p["segments"][k + 1]
    new_para = port.split_para_at(para_guid, nxt["begin"])
    p2 = assert_invariant(port, text_guid, para_guid)
    assert_invariant(port, text_guid, new_para)
    if [s["guid"] for s in p2["segments"]] != [s["guid"] for s in p["segments"][:k + 1]]:
        raise FlexError("E_INVARIANT", "the first paragraph lost or gained segments", {"para": para_guid})
    toks = word_token_ends(p2, p2["segments"][-1])
    if toks and toks[-1][2] == SECTION:
        a, b = toks[-1][0], len(p2["contents"])
        if a > 0 and p2["contents"][a - 1].isspace():
            a -= 1
        _assign(port, p2, p2["contents"][:a], (a, 0, b - a))
        p3 = assert_invariant(port, text_guid, para_guid)
        if [s["guid"] for s in p3["segments"]] != [s["guid"] for s in p2["segments"]]:
            raise FlexError("E_INVARIANT", "removing the trailing § changed the segments", {"para": para_guid})
    return new_para


def paragraph_to_phrase(port, text_guid, para_guid):
    """Paragraph boundary → phrase boundary (join P and Q): if P does not end in EOS, append "§ "
    (one assignment); then P.MergeParaWithNext(). [verified] all of Q's segments survive with FT and
    times; Q's paragraph GUID and style are lost."""
    t = port.read_text(text_guid)
    idx = next((i for i, p in enumerate(t["paragraphs"]) if p["guid"] == para_guid), None)
    if idx is None or idx + 1 >= len(t["paragraphs"]):
        raise FlexError("E_NOT_FOUND", "no following paragraph", {"para": para_guid})
    p, q = t["paragraphs"][idx], t["paragraphs"][idx + 1]
    require_not_fragile(port, p)
    require_not_fragile(port, q)
    expect_segs = [s["guid"] for s in p["segments"]] + [s["guid"] for s in q["segments"]]
    if p["segments"] and not _ends_with_eos(p["contents"]):
        old = p["contents"]
        # A paragraph that ends in hard line breaks (U+2028, each its own label segment): the § goes BEFORE them, on
        # the last phrase with words. After them it was a segment of its own and the join rolled back (2026-10-17).
        cut = len(old)
        while cut > 0 and old[cut - 1] == LINE_SEP:
            cut -= 1
        head = old[:cut]
        ins = (" " if head and not head[-1].isspace() else "") + SECTION + (" " if cut == len(old) else "")
        _assign(port, p, head + ins + old[cut:], (cut, len(ins), 0))
        p = assert_invariant(port, text_guid, para_guid)
        if [s["guid"] for s in p["segments"]] != expect_segs[:len(p["segments"])]:
            raise FlexError("E_INVARIANT", "appending § changed P's segments", {"para": para_guid})
    port.merge_para_with_next(para_guid)
    p2 = assert_invariant(port, text_guid, para_guid)
    if [s["guid"] for s in p2["segments"]] != expect_segs:
        raise FlexError("E_INVARIANT", "a paragraph join lost a segment", {"para": para_guid, "expected": expect_segs,
                                                                           "got": [s["guid"] for s in p2["segments"]]})
    return para_guid


# ---- §6.5 word operations -----------------------------------------------------------------------
def split_word(port, text_guid, para_guid, seg_guid, word_index, offset):
    """Insert ONE space inside word `word_index` (an index into AnalysesRS) at code-point `offset`.
    [verified] only that word becomes two unanalysed WfiWordforms; every other analysis GUID kept;
    the invariant unchanged."""
    p = para_of(port, text_guid, para_guid)
    require_not_fragile(port, p)
    seg = next((s for s in p["segments"] if s["guid"] == seg_guid), None)
    if seg is None:
        raise FlexError("E_NOT_FOUND", "segment not in paragraph", {"seg": seg_guid})
    toks = word_token_ends(p, seg)
    if not (0 <= word_index < len(toks)) or toks[word_index][3]:
        raise FlexError("E_SCOPE", "not a word", {"index": word_index})
    a, b, form, _ = toks[word_index]
    if not (0 < offset < len(form)):
        raise FlexError("E_SCOPE", "offset not inside the word", {"offset": offset})
    if not _has_word(form[:offset]) or not _has_word(form[offset:]):
        raise FlexError("E_EMPTY_PHRASE", "each half needs a word-forming character", {"word": word_index})
    old = p["contents"]
    ich = a + offset
    new = old[:ich] + " " + old[ich:]
    _assign(port, p, new, (ich, 1, 0))
    p2 = assert_invariant(port, text_guid, para_guid)
    s2 = next(s for s in p2["segments"] if s["guid"] == seg_guid)
    before = [x["guid"] for x in seg["analyses"]]
    after = [x["guid"] for x in s2["analyses"]]
    if len(after) != len(before) + 1 or before[:word_index] != after[:word_index] or before[word_index + 1:] != after[word_index + 2:]:
        raise FlexError("E_INVARIANT", "a word split changed more than that word's analyses", {"seg": seg_guid})
    if any(s2["analyses"][i]["kind"] != "wordform" for i in (word_index, word_index + 1)):
        raise FlexError("E_INVARIANT", "the halves are not bare wordforms", {"seg": seg_guid})
    return s2["analyses"][word_index]["guid"], s2["analyses"][word_index + 1]["guid"]


def join_words(port, text_guid, para_guid, seg_guid, word_index):
    """Delete the whitespace between word `word_index` and the next (indices into AnalysesRS; two
    words parted only by whitespace) — split_word in reverse, ONE assignment. LCM's adjuster makes the
    joined word one unanalysed WfiWordform and keeps every other analysis GUID; the invariant holds.
    [mock] like the rest of §6.5 until the VM run (plan §15, V-1)."""
    p = para_of(port, text_guid, para_guid)
    require_not_fragile(port, p)
    seg = next((s for s in p["segments"] if s["guid"] == seg_guid), None)
    if seg is None:
        raise FlexError("E_NOT_FOUND", "segment not in paragraph", {"seg": seg_guid})
    toks = word_token_ends(p, seg)
    if not (0 <= word_index < len(toks) - 1) or toks[word_index][3] or toks[word_index + 1][3]:
        raise FlexError("E_SCOPE", "not two words", {"index": word_index})
    a_end, b_start = toks[word_index][1], toks[word_index + 1][0]
    old = p["contents"]
    gap = old[a_end:b_start]
    if not gap or gap.strip():
        raise FlexError("E_SCOPE", "only words parted by a space are joined", {"index": word_index})
    _assign(port, p, old[:a_end] + old[b_start:], (a_end, 0, b_start - a_end))
    p2 = assert_invariant(port, text_guid, para_guid)
    s2 = next((s for s in p2["segments"] if s["guid"] == seg_guid), None)
    if s2 is None:
        raise FlexError("E_INVARIANT", "a word join lost its phrase", {"seg": seg_guid})
    before = [x["guid"] for x in seg["analyses"]]
    after = [x["guid"] for x in s2["analyses"]]
    if len(after) != len(before) - 1 or before[:word_index] != after[:word_index] or before[word_index + 2:] != after[word_index + 1:]:
        raise FlexError("E_INVARIANT", "a word join changed more than those words' analyses", {"seg": seg_guid})
    if s2["analyses"][word_index]["kind"] != "wordform":
        raise FlexError("E_INVARIANT", "the joined word is not a bare wordform", {"seg": seg_guid})
    return s2["analyses"][word_index]["guid"]


def insert_word(port, text_guid, para_guid, seg_guid, at_index, text):
    """A new word before AnalysesRS[at_index] (or after the last). [verified] risks handled: the
    diff LCM computes is prefix/suffix minimal, so the expected diff is computed THE WAY LCM DOES
    before assigning; inserting a copy of a word next to itself moves the existing analysis onto the
    first copy, so after the write AnalysesRS is set to the intended mapping and verified."""
    p = para_of(port, text_guid, para_guid)
    require_not_fragile(port, p)
    seg = next((s for s in p["segments"] if s["guid"] == seg_guid), None)
    if seg is None:
        raise FlexError("E_NOT_FOUND", "segment not in paragraph", {"seg": seg_guid})
    word = nfd(text).strip()
    if not word or any(c.isspace() for c in word) or not _has_word(word):
        raise FlexError("E_SCOPE", "a word to insert must be one word with a letter in it", {"text": text})
    toks = word_token_ends(p, seg)
    old = p["contents"]
    if at_index < len(toks):
        ich = toks[at_index][0]
        piece = word + " "
    else:
        last = toks[-1] if toks else None
        ich = last[1] if last else seg["end"]
        piece = " " + word
    new = old[:ich] + piece + old[ich:]
    expect = lcm_diff(old, new)          # compute it the way LCM does — it may differ from (ich, len, 0)
    _assign(port, p, new, expect)
    p2 = assert_invariant(port, text_guid, para_guid)
    s2 = next(s for s in p2["segments"] if s["guid"] == seg_guid)
    before = [x["guid"] for x in seg["analyses"]]
    after = [x["guid"] for x in s2["analyses"]]
    if len(after) != len(before) + 1:
        raise FlexError("E_INVARIANT", "an insert did not add exactly one analysis", {"seg": seg_guid})
    # intended mapping: old analyses stay with their words; the new slot is a bare wordform
    intended = before[:at_index] + [None] + before[at_index:]
    for i, g in enumerate(intended):
        if g is not None and after[i] != g:
            port.set_analysis(seg_guid, i, g)
    p3 = assert_invariant(port, text_guid, para_guid)
    s3 = next(s for s in p3["segments"] if s["guid"] == seg_guid)
    final = [x["guid"] for x in s3["analyses"]]
    for i, g in enumerate(intended):
        if g is not None and final[i] != g:
            raise FlexError("E_INVARIANT", "could not restore an analysis after insert", {"seg": seg_guid, "index": i})
    if s3["analyses"][at_index]["kind"] != "wordform" or s3["analyses"][at_index]["form"] != text.strip():
        # the new slot must be a bare wordform of the inserted text
        if s3["analyses"][at_index]["form"] != text.strip():
            raise FlexError("E_INVARIANT", "the inserted word is not where intended", {"seg": seg_guid})
    return s3["analyses"][at_index]["guid"]


def replace_baseline(port, text_guid, para_guid, new_text, keep_analyses=True):
    """General baseline edit (plan §6.5): one minimal-diff assignment; analyses of tokens whose form
    is unchanged at their position inside the diff span are restored; verify. Segment count must not
    change (a structural change goes through the recipes above)."""
    p = para_of(port, text_guid, para_guid)
    require_not_fragile(port, p)
    old = p["contents"]
    new = nfd(new_text)
    if old == new:
        return
    ich, ins, dele = lcm_diff(old, new)
    snap = []
    for s in p["segments"]:
        for t, a in zip(word_token_ends(p, s), s["analyses"]):
            snap.append((t[2], a["guid"]))
    _assign(port, p, new, (ich, ins, dele))
    p2 = assert_invariant(port, text_guid, para_guid)
    if [s["guid"] for s in p2["segments"]] != [s["guid"] for s in p["segments"]]:
        raise FlexError("E_INVARIANT", "a baseline edit changed the segment structure; use split/join", {"para": para_guid})
    if keep_analyses:
        # LCS over forms between the snapshot and the new token list: matched tokens get their old analysis
        new_toks = []
        for s in p2["segments"]:
            for i, (t, a) in enumerate(zip(word_token_ends(p2, s), s["analyses"])):
                new_toks.append((s["guid"], i, t[2], a["guid"]))
        pairs = _lcs([x[0] for x in snap], [x[2] for x in new_toks])
        for oi, ni in pairs:
            sg, i, form, cur = new_toks[ni]
            if snap[oi][1] != cur:
                port.set_analysis(sg, i, snap[oi][1])
        assert_invariant(port, text_guid, para_guid)


def _lcs(a, b):
    n, m = len(a), len(b)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            dp[i][j] = dp[i + 1][j + 1] + 1 if a[i] == b[j] else max(dp[i + 1][j], dp[i][j + 1])
    out, i, j = [], 0, 0
    while i < n and j < m:
        if a[i] == b[j]:
            out.append((i, j))
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1
    return out
