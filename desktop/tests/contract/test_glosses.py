"""Plan §7.2 branches (i)/(ii)/(iii) and D5–D7 as contract tests."""
import pytest

from flexshell import glosses as G
from flexshell.errors import FlexError
from .conftest import first_text


def seg_at(b, tg, pi=0, si=0):
    return b.read_text(tg)["paragraphs"][pi]["segments"][si]


def setup_glossed(b):
    """Give the first paragraph's words glosses: word 0 'A' (single use), word 1 'B' shared by two
    occurrences (the same wordform appears in paragraph 2 after an insert)."""
    tg = first_text(b)["guid"]
    t = b.read_text(tg)
    p0, p1 = t["paragraphs"][0], t["paragraphs"][1]
    s0 = p0["segments"][0]
    h = b.begin_uow("setup", "setup")
    # make "aaa" appear in paragraph 2 too so a gloss can be shared
    b.set_contents(p1["guid"], p1["contents"] + " aaa")
    b.commit(h)
    t = b.read_text(tg)
    s0 = t["paragraphs"][0]["segments"][0]
    s1 = t["paragraphs"][1]["segments"][0]
    h = b.begin_uow("setup2", "setup2")
    G.set_gloss(b, tg, t["paragraphs"][0]["guid"], s0["guid"], 0, ["en"], "en", "A-shared")
    b.commit(h)
    t = b.read_text(tg)
    g_shared = t["paragraphs"][0]["segments"][0]["analyses"][0]["guid"]
    an_aaa = t["paragraphs"][0]["segments"][0]["analyses"][0]["analysisGuid"]
    h = b.begin_uow("setup3", "setup3")
    idx = [a["form"] for a in s1["analyses"]].index("aaa")
    b.set_analysis(s1["guid"], idx, g_shared)   # second occurrence points at the same gloss
    G.set_gloss(b, tg, t["paragraphs"][0]["guid"], s0["guid"], 1, ["en"], "en", "B-single")
    b.commit(h)
    return tg, t["paragraphs"][0]["guid"], s0["guid"], s1["guid"], idx, g_shared, an_aaa


def test_unanalysed_word_gets_a_trivial_analysis_and_a_new_gloss(backend):
    b = backend
    tg = first_text(b)["guid"]
    t = b.read_text(tg)
    p, s = t["paragraphs"][0], t["paragraphs"][0]["segments"][0]
    assert s["analyses"][0]["kind"] == "wordform"
    counts = b.counts()
    h = b.begin_uow("u", "r")
    plan = G.set_gloss(b, tg, p["guid"], s["guid"], 0, ["en", "id"], "en", "first")
    b.commit(h)
    assert plan["outcome"] == "newGloss" and plan["newAnalysis"] is True and plan["approved"] is True
    a = seg_at(b, tg)["analyses"][0]
    assert a["kind"] == "gloss" and a["gloss"] == {"en": "first"}
    after = b.counts()
    assert after["WfiAnalysis"] == counts["WfiAnalysis"] + 1 and after["WfiMorphBundle"] == counts["WfiMorphBundle"] + 1
    assert after["WfiGloss"] == counts["WfiGloss"] + 1 and after["WfiWordform"] == counts["WfiWordform"]
    for cls in ("LexEntry", "LexSense", "MoForm"):
        assert after[cls] == counts[cls]
    # the second time, the trivial analysis is REUSED
    h = b.begin_uow("u", "r")
    plan = G.set_gloss(b, tg, p["guid"], s["guid"], 0, ["en", "id"], "id", "pertama")
    b.commit(h)
    assert plan["outcome"] == "editInPlace" and b.counts()["WfiAnalysis"] == after["WfiAnalysis"]
    assert seg_at(b, tg)["analyses"][0]["gloss"] == {"en": "first", "id": "pertama"}


def test_single_use_gloss_is_edited_in_place_shared_gloss_gets_a_new_one(backend):
    b = backend
    tg, pg, s0, s1, idx, g_shared, an_aaa = setup_glossed(b)
    # (ii) single-use: edit in place
    g_single = seg_at(b, tg)["analyses"][1]["guid"]
    h = b.begin_uow("u", "r")
    plan = G.set_gloss(b, tg, pg, s0, 1, ["en"], "en", "B-edited")
    b.commit(h)
    assert plan["outcome"] == "editInPlace"
    assert seg_at(b, tg)["analyses"][1]["guid"] == g_single and seg_at(b, tg)["analyses"][1]["gloss"] == {"en": "B-edited"}
    # shared: new gloss, the OTHER occurrence untouched
    assert b.gloss_ref_count(g_shared) == 2
    counts = b.counts()
    h = b.begin_uow("u", "r")
    plan = G.set_gloss(b, tg, pg, s0, 0, ["en"], "en", "A-mine")
    b.commit(h)
    assert plan["outcome"] == "newGloss" and plan["otherUses"] == 1
    me = seg_at(b, tg)["analyses"][0]
    other = seg_at(b, tg, 1)["analyses"][idx]
    assert me["guid"] != g_shared and me["gloss"] == {"en": "A-mine"} and me["analysisGuid"] == an_aaa
    assert other["guid"] == g_shared and other["gloss"] == {"en": "A-shared"}
    assert b.counts()["WfiGloss"] == counts["WfiGloss"] + 1 and b.counts()["WfiAnalysis"] == counts["WfiAnalysis"]


def test_reuse_an_equal_gloss_writes_nothing(backend):
    b = backend
    tg, pg, s0, s1, idx, g_shared, an_aaa = setup_glossed(b)
    h = b.begin_uow("u", "r")
    G.set_gloss(b, tg, pg, s0, 0, ["en"], "en", "A-mine")      # now A has two glosses
    b.commit(h)
    counts = b.counts()
    h = b.begin_uow("u", "r")
    plan = G.set_gloss(b, tg, pg, s0, 0, ["en"], "en", "A-shared")   # back to the shared value
    b.commit(h)
    assert plan["outcome"] == "reuse" and plan["glossGuid"] == g_shared
    assert b.counts() == counts, "nothing created; the replaced single-use gloss is left (D8)"
    assert seg_at(b, tg)["analyses"][0]["guid"] == g_shared


def test_clearing_every_ws_points_back_at_the_analysis(backend):
    b = backend
    tg, pg, s0, *_ = setup_glossed(b)
    an = seg_at(b, tg)["analyses"][1]["analysisGuid"]
    counts = b.counts()
    h = b.begin_uow("u", "r")
    plan = G.set_gloss(b, tg, pg, s0, 1, ["en"], "en", "")
    b.commit(h)
    assert plan["outcome"] == "unglossed"
    a = seg_at(b, tg)["analyses"][1]
    assert a["kind"] == "analysis" and a["guid"] == an
    assert b.counts() == counts, "the old gloss is never deleted (D5)"


def test_punctuation_and_concurrency_refusals(backend):
    b = backend
    tg = first_text(b)["guid"]
    t = b.read_text(tg)
    p, s = t["paragraphs"][0], t["paragraphs"][0]["segments"][0]
    h = b.begin_uow("u", "r")
    with pytest.raises(FlexError) as ei:
        G.set_gloss(b, tg, p["guid"], s["guid"], len(s["analyses"]) - 1, ["en"], "en", "x")   # the "."
    assert ei.value.code == "E_SCOPE"
    with pytest.raises(FlexError) as ei:
        G.set_gloss(b, tg, p["guid"], s["guid"], 0, ["en"], "fr", "x")
    assert ei.value.code == "E_SCOPE"
    snap = dict(s)
    snap["_text"] = "something else"
    with pytest.raises(FlexError) as ei:
        G.set_gloss(b, tg, p["guid"], s["guid"], 0, ["en"], "en", "x", snapshot_seg=snap)
    assert ei.value.code == "E_STALE_BASE"
    b.rollback(h)


def test_plan_without_writing(backend):
    b = backend
    tg = first_text(b)["guid"]
    s = seg_at(b, tg)
    counts = b.counts()
    plan = G.plan_gloss(b, s, 0, ["en"], "en", "x")
    assert plan["outcome"] == "newGloss" and plan["needsAnalysis"] is True
    assert b.counts() == counts and b.depth() == 0
