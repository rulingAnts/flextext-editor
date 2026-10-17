"""FLEx's hard line breaks (2026-10-17). Shift+Enter in FLEx's Baseline inserts U+2028, and LCM makes every one its own
one-character label segment (liblcm SegmentBreaker: "Hard line break, always its own segment"), with no words. The shell
read each as an empty line, and then refused every save that touched its paragraph: the post-state held a phrase with no
letters (E_EMPTY_PHRASE), and joining it away — what that refusal suggested — rolled back half-way ("real punctuation").
The mock folded a break after a full stop into the sentence before it, so no test here could see any of it."""
import copy

import pytest

from flexshell import segmentation as S
from flexshell.errors import FlexError
from flexshell.lcm_mock import LINE_SEP, MockLcm, SECTION, segment_breaker
from flexshell.protocol import Session

LB = LINE_SEP


def test_a_line_break_is_its_own_segment_after_a_stop_too():
    cut = lambda t: [t[a:b] for a, b in segment_breaker(t)]
    assert cut("aaa bbb" + LB + "ccc ddd") == ["aaa bbb", LB, "ccc ddd"]
    assert cut("aaa bbb." + LB + "ccc ddd.") == ["aaa bbb.", LB, "ccc ddd."], "used to be one segment ending in the break"
    assert cut("aaa bbb. " + LB + "ccc") == ["aaa bbb. ", LB, "ccc"], "the space after the stop stays with its sentence"
    assert cut("aaa." + LB + LB + "bbb.") == ["aaa.", LB, LB, "bbb."]
    assert cut(LB + "aaa") == [LB, "aaa"] and cut("aaa." + LB) == ["aaa.", LB]
    assert cut("aaa. bbb. ccc") == ["aaa. ", "bbb. ", "ccc"], "no break: unchanged"


def world(tmp_path, paragraphs):
    projects = tmp_path / "Projects"
    projects.mkdir()
    MockLcm.create_project(str(projects), "copy-lb", texts=[{"title": "lb", "paragraphs": paragraphs}])
    (projects / "copy-lb" / "flextext-disposable-copy.txt").write_text("x")
    port = MockLcm(str(projects))
    s = Session(port, "copy-lb", write=True, copy_only=True, marker_ok=True)
    tg = port.list_texts()[0]["guid"]
    o = s.open_text(tg)
    return port, s, tg, o


def shape(port, tg):
    """Each paragraph's segments: "↵" for a hard line break, else its number of analyses."""
    return [["↵" if seg["isLabel"] else len(seg["analyses"]) for seg in p["segments"]] for p in port.read_text(tg)["paragraphs"]]


def post_of(doc, touched):
    """The intended post-state as the engine sends it (flex-ops.js postStateOf): every line of a touched paragraph,
    a line break included, in order."""
    out = {}
    for ln in doc["paragraphs"]:
        if ln.get("paraOf") not in touched:
            continue
        seg = ln["segments"][0]
        a = seg.get("attrs") or {}
        out.setdefault(ln["paraOf"], []).append({
            "segGuid": a.get("guid"), "text": " ".join(w["txt"] for w in seg["words"]),
            "words": [{"txt": w["txt"], "punct": bool(w.get("punct")), "gls": w.get("gls", ""), "analysisGuid": None} for w in seg["words"]],
            "ft": {seg.get("freeLang") or "en": seg["free"]} if seg.get("free") else {}, "lt": {},
            "begin": a.get("begin-time-offset"), "end": a.get("end-time-offset")})
    return out


def sg(line):
    return line["segments"][0]["attrs"]["guid"]


@pytest.mark.parametrize("para", ["aaa bbb" + LB + "ccc ddd.", "aaa bbb." + LB + "ccc ddd."])
def test_a_break_opens_as_a_line_of_its_own_read_only_its_one_word_the_break(tmp_path, para):
    """LCM gives a hard line break ONE analysis, a PunctuationForm whose form is U+2028 (Seth's FLEx direct-write
    notes, 2026-10-17: [source; ran]) — the mock gave it none, and the engine's fold, built on the mock, never saw
    a break as FLEx shows it."""
    port, s, tg, o = world(tmp_path, [para, "eee fff"])
    lines = o["doc"]["paragraphs"]
    br = lines[1]["segments"][0]
    assert br.get("readOnly") is True and br["baseline"] == ""
    assert [(w["txt"], w["punct"]) for w in br["words"]] == [(LB, True)]
    seg = port.read_text(tg)["paragraphs"][0]["segments"][1]
    assert seg["isLabel"] and [(a["kind"], a["form"]) for a in seg["analyses"]] == [("punct", LB)]
    assert shape(port, tg)[0][1] == "↵"


@pytest.mark.parametrize("para", ["aaa bbb" + LB + "ccc ddd.", "aaa bbb." + LB + "ccc ddd."])
@pytest.mark.parametrize("line", [0, 2])
def test_an_edit_in_a_paragraph_that_holds_a_line_break_saves(tmp_path, para, line):
    port, s, tg, o = world(tmp_path, [para, "eee fff"])
    doc = copy.deepcopy(o["doc"])
    ln = doc["paragraphs"][line]
    ln["segments"][0]["free"], ln["segments"][0]["freeLang"] = "a translation", "en"
    ops = [{"op": "ft.set", "paraGuid": ln["paraOf"], "segGuid": sg(ln), "ws": "en", "value": "a translation"}]
    pv = s.preview(tg, o["baseRev"], ops, post_of(doc, {ln["paraOf"]}))     # was E_EMPTY_PHRASE: the break has no letters
    s.save(pv["previewToken"])
    t = port.read_text(tg)
    assert t["paragraphs"][0]["segments"][line]["ft"].get("en") == "a translation"
    assert shape(port, tg)[0][1] == "↵", "the break is still there, its own segment"


def test_a_label_the_engine_changed_is_still_judged(tmp_path):
    """The exemption is for FLEx's own label, sent back as it is — not for any empty phrase that names its guid."""
    port, s, tg, o = world(tmp_path, ["aaa" + LB + "bbb"])
    doc = copy.deepcopy(o["doc"])
    p = doc["paragraphs"][0]["paraOf"]
    post = post_of(doc, {p})
    post[p][1]["words"] = [{"txt": "*", "punct": True, "gls": "", "analysisGuid": None}]   # no letters, and not what FLEx has
    post[p][1]["text"] = "*"
    ops = [{"op": "ft.set", "paraGuid": p, "segGuid": sg(doc["paragraphs"][0]), "ws": "en", "value": "x"}]
    with pytest.raises(FlexError) as ei:
        s.preview(tg, o["baseRev"], ops, post)
    assert ei.value.code == "E_EMPTY_PHRASE"


@pytest.mark.parametrize("on", [0, 1])   # the line before the break absorbing it, or the break absorbing the line after
def test_a_join_across_a_line_break_is_refused_at_preview_by_name(tmp_path, on):
    port, s, tg, o = world(tmp_path, ["aaa bbb" + LB + "ccc ddd"])
    before = shape(port, tg)
    lines = o["doc"]["paragraphs"]
    ops = [{"op": "phrase.join", "paraGuid": lines[on]["paraOf"], "segGuid": sg(lines[on]), "endTime": None}]
    with pytest.raises(FlexError) as ei:
        s.preview(tg, o["baseRev"], ops, {})
    assert ei.value.code == "E_SCOPE" and ei.value.detail.get("lineBreak") is True
    assert shape(port, tg) == before


def test_the_join_recipe_itself_refuses_a_line_break(tmp_path):
    port, s, tg, o = world(tmp_path, ["aaa bbb" + LB + "ccc ddd"])
    lines = o["doc"]["paragraphs"]
    h = port.begin_uow("u", "r")
    try:
        with pytest.raises(FlexError) as ei:
            S.join_phrases(port, tg, lines[0]["paraOf"], sg(lines[0]))
        assert ei.value.code == "E_SCOPE" and ei.value.detail.get("lineBreak") is True, "was: 'this boundary is real punctuation'"
    finally:
        port.rollback(h)


@pytest.mark.parametrize("first", ["aaa bbb" + LB, "aaa bbb." + LB])
def test_a_paragraph_join_onto_one_that_ends_in_a_line_break_saves(tmp_path, first):
    """With no stop before the break, the § FLEx joins at goes BEFORE the break: after it, it was a segment of its own
    and the join rolled back ("appending § changed P's segments")."""
    port, s, tg, o = world(tmp_path, [first, "ccc ddd"])
    doc = copy.deepcopy(o["doc"])
    p1, p2 = doc["paragraphs"][0]["paraOf"], doc["paragraphs"][-1]["paraOf"]
    for ln in doc["paragraphs"]:
        ln["paraOf"] = p1
    pv = s.preview(tg, o["baseRev"], [{"op": "para.toPhrase", "paraGuid": p1}], post_of(doc, {p1, p2}))
    s.save(pv["previewToken"])
    t = port.read_text(tg)
    assert shape(port, tg) == [[3, "↵", 2]]
    if not first.rstrip(LB).endswith("."):
        assert t["paragraphs"][0]["contents"].startswith("aaa bbb " + SECTION + LB), "the § sits before the break"


def test_a_paragraph_join_onto_one_that_starts_with_a_line_break_saves(tmp_path):
    port, s, tg, o = world(tmp_path, ["aaa", LB + "bbb ccc"])
    doc = copy.deepcopy(o["doc"])
    p1, p2 = doc["paragraphs"][0]["paraOf"], doc["paragraphs"][-1]["paraOf"]
    for ln in doc["paragraphs"]:
        ln["paraOf"] = p1
    pv = s.preview(tg, o["baseRev"], [{"op": "para.toPhrase", "paraGuid": p1}], post_of(doc, {p1, p2}))
    s.save(pv["previewToken"])
    assert shape(port, tg) == [[2, "↵", 2]]


def test_a_paragraph_made_after_a_line_break_leaves_it_at_the_end_of_the_first(tmp_path):
    """Where the Matcher's Done puts a break (flextext.js unfoldFlexBreakLines): one before the line that now opens a
    paragraph stays at the end of the paragraph before — FLEx's own split leaves it there — and a later one moves with
    its paragraph. The shell accepts that later one in the paragraph this save makes."""
    port, s, tg, o = world(tmp_path, ["aaa" + LB + "bbb" + LB + "ccc"])
    doc = copy.deepcopy(o["doc"])
    lines = doc["paragraphs"]
    p1 = lines[0]["paraOf"]
    for ln in lines[2:]:
        ln["paraOf"] = "eng-p1"
    ops = [{"op": "phrase.toPara", "paraGuid": p1, "segGuid": sg(lines[1]), "newPara": "eng-p1"}]
    pv = s.preview(tg, o["baseRev"], ops, post_of(doc, {p1, "eng-p1"}))   # was E_EMPTY_PHRASE for the second break
    s.save(pv["previewToken"])
    assert shape(port, tg) == [[1, "↵"], [1, "↵", 1]]
