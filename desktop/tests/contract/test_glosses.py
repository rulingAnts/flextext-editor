"""Plan §7.2 branches (i)/(ii)/(iii) and D5–D7 as contract tests — and the rule over all of them
(Seth, 2026-10-16): a gloss change names the writing systems it changes, and EVERY other writing
system of that word's gloss is exactly as it was afterwards, shared gloss or not."""
import pytest

from flexshell import glosses as G
from flexshell.errors import FlexError
from .conftest import first_text

EN, ID = ["en"], ["en", "id"]


def seg_at(b, tg, pi=0, si=0):
    return b.read_text(tg)["paragraphs"][pi]["segments"][si]


def setup_glossed(b, forms_a=None, forms_b=None):
    """Give the first paragraph's words glosses: word 0 'aaa' (shared by two occurrences: the same
    wordform appears in paragraph 2 after an insert) and word 1 'bbb' (single use). `forms_*` are the
    glosses' writing systems (English only by default)."""
    forms_a = forms_a or {"en": "A-shared"}
    forms_b = forms_b or {"en": "B-single"}
    allowed = sorted(set(forms_a) | set(forms_b) | {"en"})
    tg = first_text(b)["guid"]
    t = b.read_text(tg)
    p1 = t["paragraphs"][1]
    h = b.begin_uow("setup", "setup")
    # make "aaa" appear in paragraph 2 too so a gloss can be shared
    b.set_contents(p1["guid"], p1["contents"] + " aaa")
    b.commit(h)
    t = b.read_text(tg)
    s0 = t["paragraphs"][0]["segments"][0]
    s1 = t["paragraphs"][1]["segments"][0]
    h = b.begin_uow("setup2", "setup2")
    G.set_gloss(b, tg, t["paragraphs"][0]["guid"], s0["guid"], 0, forms_a, allowed)
    b.commit(h)
    t = b.read_text(tg)
    g_shared = t["paragraphs"][0]["segments"][0]["analyses"][0]["guid"]
    an_aaa = t["paragraphs"][0]["segments"][0]["analyses"][0]["analysisGuid"]
    h = b.begin_uow("setup3", "setup3")
    idx = [a["form"] for a in s1["analyses"]].index("aaa")
    b.set_analysis(s1["guid"], idx, g_shared)   # second occurrence points at the same gloss
    G.set_gloss(b, tg, t["paragraphs"][0]["guid"], s0["guid"], 1, forms_b, allowed)
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
    plan = G.set_gloss(b, tg, p["guid"], s["guid"], 0, {"en": "first"}, ID)
    b.commit(h)
    assert plan["outcome"] == "newGloss" and plan["newAnalysis"] is True and plan["approved"] is True
    a = seg_at(b, tg)["analyses"][0]
    assert a["kind"] == "gloss" and a["gloss"] == {"en": "first"}
    after = b.counts()
    assert after["WfiAnalysis"] == counts["WfiAnalysis"] + 1 and after["WfiMorphBundle"] == counts["WfiMorphBundle"] + 1
    assert after["WfiGloss"] == counts["WfiGloss"] + 1 and after["WfiWordform"] == counts["WfiWordform"]
    for cls in ("LexEntry", "LexSense", "MoForm"):
        assert after[cls] == counts[cls]
    # the second time, the trivial analysis is REUSED, and English stays as it is
    h = b.begin_uow("u", "r")
    plan = G.set_gloss(b, tg, p["guid"], s["guid"], 0, {"id": "pertama"}, ID)
    b.commit(h)
    assert plan["outcome"] == "editInPlace" and b.counts()["WfiAnalysis"] == after["WfiAnalysis"]
    assert seg_at(b, tg)["analyses"][0]["gloss"] == {"en": "first", "id": "pertama"}


def test_single_use_gloss_is_edited_in_place_shared_gloss_gets_a_new_one(backend):
    b = backend
    tg, pg, s0, s1, idx, g_shared, an_aaa = setup_glossed(b)
    # (ii) single-use: edit in place
    g_single = seg_at(b, tg)["analyses"][1]["guid"]
    h = b.begin_uow("u", "r")
    plan = G.set_gloss(b, tg, pg, s0, 1, {"en": "B-edited"}, EN)
    b.commit(h)
    assert plan["outcome"] == "editInPlace"
    assert seg_at(b, tg)["analyses"][1]["guid"] == g_single and seg_at(b, tg)["analyses"][1]["gloss"] == {"en": "B-edited"}
    # shared: new gloss, the OTHER occurrence untouched
    assert b.gloss_ref_count(g_shared) == 2
    counts = b.counts()
    h = b.begin_uow("u", "r")
    plan = G.set_gloss(b, tg, pg, s0, 0, {"en": "A-mine"}, EN)
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
    G.set_gloss(b, tg, pg, s0, 0, {"en": "A-mine"}, EN)      # now A has two glosses
    b.commit(h)
    counts = b.counts()
    h = b.begin_uow("u", "r")
    plan = G.set_gloss(b, tg, pg, s0, 0, {"en": "A-shared"}, EN)   # back to the shared value
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
    plan = G.set_gloss(b, tg, pg, s0, 1, {"en": ""}, EN)
    b.commit(h)
    assert plan["outcome"] == "unglossed"
    a = seg_at(b, tg)["analyses"][1]
    assert a["kind"] == "analysis" and a["guid"] == an
    assert b.counts() == counts, "the old gloss is never deleted (D5)"


# ---- every writing system the change does not name stays as it was -------------------------------
def test_a_shared_gloss_edited_in_one_ws_keeps_the_others_on_the_new_gloss(backend):
    b = backend
    tg, pg, s0, s1, idx, g_shared, an_aaa = setup_glossed(b, forms_a={"en": "A-shared", "id": "A-id"})
    h = b.begin_uow("u", "r")
    plan = G.set_gloss(b, tg, pg, s0, 0, {"en": "A-mine"}, ID)
    b.commit(h)
    assert plan["outcome"] == "newGloss" and plan["changed"] == ["en"]
    assert seg_at(b, tg)["analyses"][0]["gloss"] == {"en": "A-mine", "id": "A-id"}, "Indonesian came along"
    assert seg_at(b, tg, 1)["analyses"][idx]["gloss"] == {"en": "A-shared", "id": "A-id"}, "the other occurrence is untouched"


def test_a_ws_the_change_does_not_name_is_kept_even_where_the_save_may_not_write_it(backend):
    """The occurrence's gloss has Indonesian; the save may write English only — Indonesian is still
    the word's after the save, on the new gloss as on the old one."""
    b = backend
    tg, pg, s0, s1, idx, g_shared, an_aaa = setup_glossed(b, forms_a={"en": "A-shared", "id": "A-id"})
    h = b.begin_uow("u", "r")
    plan = G.set_gloss(b, tg, pg, s0, 0, {"en": "A-mine"}, EN)
    b.commit(h)
    assert plan["outcome"] == "newGloss"
    assert seg_at(b, tg)["analyses"][0]["gloss"] == {"en": "A-mine", "id": "A-id"}
    with pytest.raises(FlexError) as ei:     # …and it is never written by a change the save may not make
        G.plan_gloss(b, seg_at(b, tg), 0, {"id": "x"}, EN)
    assert ei.value.code == "E_SCOPE"


def test_editing_in_place_writes_only_the_ws_that_changed(backend):
    b = backend
    tg, pg, s0, *_ = setup_glossed(b, forms_b={"en": "B-single", "id": "B-id"})
    g = seg_at(b, tg)["analyses"][1]["guid"]
    calls = len(getattr(b, "calls", []))
    h = b.begin_uow("u", "r")
    plan = G.set_gloss(b, tg, pg, s0, 1, {"en": "B-single", "id": "B-baru"}, ID)   # English sent unchanged
    b.commit(h)
    assert plan["outcome"] == "editInPlace" and plan["changes"] == {"id": "B-baru"} and plan["changed"] == ["id"]
    assert seg_at(b, tg)["analyses"][1]["guid"] == g and seg_at(b, tg)["analyses"][1]["gloss"] == {"en": "B-single", "id": "B-baru"}
    if hasattr(b, "calls"):
        assert [c for c in b.calls[calls:] if c[0] == "set_gloss_form"] == [("set_gloss_form", g, "id")]


def test_two_ws_changed_at_once_are_one_new_gloss(backend):
    b = backend
    tg, pg, s0, s1, idx, g_shared, an_aaa = setup_glossed(b, forms_a={"en": "A-shared", "id": "A-id"})
    counts = b.counts()
    h = b.begin_uow("u", "r")
    plan = G.set_gloss(b, tg, pg, s0, 0, {"en": "A-two", "id": "A-dua"}, ID)
    b.commit(h)
    assert plan["outcome"] == "newGloss" and plan["changed"] == ["en", "id"]
    assert seg_at(b, tg)["analyses"][0]["gloss"] == {"en": "A-two", "id": "A-dua"}
    assert b.counts()["WfiGloss"] == counts["WfiGloss"] + 1


def test_clearing_one_ws_keeps_the_gloss_in_the_others(backend):
    b = backend
    tg, pg, s0, *_ = setup_glossed(b, forms_b={"en": "B-single", "id": "B-id"})
    h = b.begin_uow("u", "r")
    plan = G.set_gloss(b, tg, pg, s0, 1, {"en": ""}, ID)
    b.commit(h)
    assert plan["outcome"] == "editInPlace"
    a = seg_at(b, tg)["analyses"][1]
    assert a["kind"] == "gloss" and a["gloss"] == {"id": "B-id"}


def test_reuse_needs_the_gloss_equal_in_every_ws(backend):
    """A gloss of the analysis equal in English but without the word's Indonesian is NOT the word's
    gloss: reusing it would drop Indonesian. The one equal in both is reused."""
    b = backend
    tg, pg, s0, s1, idx, g_shared, an_aaa = setup_glossed(b, forms_a={"en": "A-shared", "id": "A-id"})
    h = b.begin_uow("u", "r")
    english_only = b.create_gloss(an_aaa, {"en": "A-other"})
    both = b.create_gloss(an_aaa, {"en": "A-other", "id": "A-id"})
    b.commit(h)
    plan = G.plan_gloss(b, seg_at(b, tg), 0, {"en": "A-other"}, ID)
    assert plan["outcome"] == "reuse" and plan["glossGuid"] == both and plan["glossGuid"] != english_only
    h = b.begin_uow("u", "r")
    G.set_gloss(b, tg, pg, s0, 0, {"en": "A-other"}, ID)
    b.commit(h)
    assert seg_at(b, tg)["analyses"][0]["guid"] == both


def test_an_unchanged_gloss_writes_nothing(backend):
    b = backend
    tg, pg, s0, *_ = setup_glossed(b, forms_b={"en": "B-single", "id": "B-id"})
    counts = b.counts()
    h = b.begin_uow("u", "r")
    plan = G.set_gloss(b, tg, pg, s0, 1, {"id": "B-id"}, ID)
    b.commit(h)
    assert plan["outcome"] == "unchanged" and b.counts() == counts


def test_punctuation_and_concurrency_refusals(backend):
    b = backend
    tg = first_text(b)["guid"]
    t = b.read_text(tg)
    p, s = t["paragraphs"][0], t["paragraphs"][0]["segments"][0]
    h = b.begin_uow("u", "r")
    with pytest.raises(FlexError) as ei:
        G.set_gloss(b, tg, p["guid"], s["guid"], len(s["analyses"]) - 1, {"en": "x"}, EN)   # the "."
    assert ei.value.code == "E_SCOPE"
    with pytest.raises(FlexError) as ei:
        G.set_gloss(b, tg, p["guid"], s["guid"], 0, {"fr": "x"}, EN)
    assert ei.value.code == "E_SCOPE"
    with pytest.raises(FlexError) as ei:
        G.set_gloss(b, tg, p["guid"], s["guid"], 0, {}, EN)
    assert ei.value.code == "E_SCOPE"
    snap = dict(s)
    snap["_text"] = "something else"
    with pytest.raises(FlexError) as ei:
        G.set_gloss(b, tg, p["guid"], s["guid"], 0, {"en": "x"}, EN, snapshot_seg=snap)
    assert ei.value.code == "E_STALE_BASE"
    b.rollback(h)


def test_plan_without_writing(backend):
    b = backend
    tg = first_text(b)["guid"]
    s = seg_at(b, tg)
    counts = b.counts()
    plan = G.plan_gloss(b, s, 0, {"en": "x"}, EN)
    assert plan["outcome"] == "newGloss" and plan["needsAnalysis"] is True
    assert b.counts() == counts and b.depth() == 0


# ---- one save, many words: the Planner sees what the ops before it make ------------------------------
def test_the_planner_counts_one_analysis_for_two_copies_of_an_unanalysed_word(backend):
    """Gloss the same unanalysed word twice in one save: the first makes its analysis, the second
    finds it — and reuses the first's gloss when it is the same. Planned and applied agree."""
    b = backend
    tg = first_text(b)["guid"]
    t = b.read_text(tg)
    p1 = t["paragraphs"][1]
    h = b.begin_uow("setup", "setup")
    b.set_contents(p1["guid"], p1["contents"] + " aaa")
    b.commit(h)
    t = b.read_text(tg)
    p0, p1 = t["paragraphs"][0], t["paragraphs"][1]
    s0, s1 = p0["segments"][0], p1["segments"][0]
    idx = [a["form"] for a in s1["analyses"]].index("aaa")
    assert s0["analyses"][0]["kind"] == "wordform" and s1["analyses"][idx]["kind"] == "wordform"
    pl = G.Planner(b)
    first = pl.plan(s0, 0, {"en": "same"}, EN)
    second = pl.plan(s1, idx, {"en": "same"}, EN)
    assert first["outcome"] == "newGloss" and first["newAnalysis"] is True
    assert second["outcome"] == "reuse" and not second.get("newAnalysis"), "the first copy's analysis and gloss"
    third_pl = G.Planner(b)
    third_pl.plan(s0, 0, {"en": "one"}, EN)
    other = third_pl.plan(s1, idx, {"en": "two"}, EN)
    assert other["outcome"] == "newGloss" and not other.get("newAnalysis"), "a second gloss of the analysis the first made"
    counts = b.counts()
    h = b.begin_uow("u", "r")
    G.set_gloss(b, tg, p0["guid"], s0["guid"], 0, {"en": "same"}, EN)
    G.set_gloss(b, tg, p1["guid"], s1["guid"], idx, {"en": "same"}, EN)
    b.commit(h)
    after = b.counts()
    assert after["WfiAnalysis"] - counts["WfiAnalysis"] == 1 and after["WfiGloss"] - counts["WfiGloss"] == 1


def test_the_planner_sees_a_gloss_an_earlier_op_edited_or_started_sharing(backend):
    b = backend
    tg, pg, s0, s1, idx, g_shared, an_aaa = setup_glossed(b)
    t = b.read_text(tg)
    seg0, seg1 = t["paragraphs"][0]["segments"][0], t["paragraphs"][1]["segments"][0]
    pl = G.Planner(b)
    # the paragraph-2 copy leaves the shared gloss for a new one; the shared gloss is then single-use
    a = pl.plan(seg1, idx, {"en": "A-two"}, EN)
    assert a["outcome"] == "newGloss"
    b_ = pl.plan(seg0, 0, {"en": "A-edited"}, EN)
    assert b_["outcome"] == "editInPlace", "one reference left: the first copy edits it in place"
    pl2 = G.Planner(b)
    pl2.plan(seg0, 0, {"en": "A-edited"}, EN)            # shared: a new gloss for this copy
    c = pl2.plan(seg1, idx, {"en": "A-edited"}, EN)      # …which the other copy then reuses
    assert c["outcome"] == "reuse"
