"""FLEx's guesses (2026-10-16). A word a text has not analysed is shown by FLEx with its best guess from
elsewhere — blue in its interlinear, every writing system of it. Seth glossed three such words in Indonesian
in the app, where they showed blank; FLEx was showing English for them. The shell now reads FLEx's guess
(read-only, ranked as FLEx ranks), the page shows it, and a gloss typed into a guessed word builds on it:
the occurrence takes the guess itself when nothing differs, else a new gloss of the guessed analysis — the
guessed gloss, other words' gloss, is never edited. Made-up fixtures."""
import copy

import pytest

from flexshell import model
from flexshell.lcm_mock import MockLcm
from flexshell.protocol import Session


def build(projects, approve=True, extra=None):
    """Text "elsewhere": kkk glossed K (en) and approved, as FLEx leaves a glossed word. Text "here": kkk
    unanalysed — FLEx guesses K for it — and mmm, which FLEx has nothing for."""
    MockLcm.create_project(str(projects), "copy-guess", texts=[{"title": "elsewhere", "paragraphs": ["kkk lll"]},
                                                               {"title": "here", "paragraphs": ["kkk mmm"]}], anal_wss=("en", "id"))
    (projects / "copy-guess" / "flextext-disposable-copy.txt").write_text("x")
    b = MockLcm(str(projects))
    b.open("copy-guess", write=True)
    by = {t["title"]: t["guid"] for t in b.list_texts()}
    s0 = b.read_text(by["elsewhere"])["paragraphs"][0]["segments"][0]
    h = b.begin_uow("fixture", "fixture")
    an = b.create_trivial_analysis(s0["analyses"][0]["wordformGuid"])
    g = b.create_gloss(an, {"en": "K"})
    b.set_analysis(s0["guid"], 0, g)
    if approve:
        b.set_evaluation(an, True)
    if extra:
        extra(b, by)
    b.commit(h)
    b.save()
    b.close_project()
    return by, an, g


@pytest.fixture
def world(tmp_path):
    projects = tmp_path / "Projects"
    projects.mkdir()
    by, an, g = build(projects)
    port = MockLcm(str(projects))
    s = Session(port, "copy-guess", write=True, copy_only=True, marker_ok=True)
    opened = s.open_text(by["here"])
    return {"port": port, "s": s, "by": by, "an": an, "g": g, "doc": opened["doc"], "rev": opened["baseRev"]}


def word(doc, i):
    return doc["paragraphs"][0]["segments"][0]["words"][i]


def gloss_op(w, forms, i=0, guess=True):
    ln = w["doc"]["paragraphs"][0]
    op = {"op": "gloss.set", "paraGuid": ln["paraOf"], "segGuid": ln["segments"][0]["attrs"]["guid"], "index": i, "forms": forms}
    gs = word(w["doc"], i)["flex"].get("guess")
    if guess and gs:
        op["guess"] = {"analysisGuid": gs["analysisGuid"], "glossGuid": gs["glossGuid"]}
    return op


def post(w, forms, i=0):
    doc = copy.deepcopy(w["doc"])
    wd = word(doc, i)
    wd["gls"] = forms.get("en", "")
    wd["glsLang"] = "en"
    wd["preservedXML"] = [model._gls_item(l, t) for l, t in forms.items() if l != "en" and t]
    ln = doc["paragraphs"][0]
    out = model.post_state_of(doc, {ln["paraOf"]})
    out[ln["paraOf"]][0]["words"][i]["analysisGuid"] = None   # LCM's to assign
    return out


def occ(port, tg, i=0):
    return port.read_text(tg)["paragraphs"][0]["segments"][0]["analyses"][i]


def test_the_page_gets_flexs_guess_for_an_unanalysed_word_and_nothing_else(world):
    w = world
    k, m = word(w["doc"], 0), word(w["doc"], 1)
    assert k["flex"]["analysisKind"] == "wordform" and k["gls"] == "", "the word's own gloss: none (FLEx has none in this text)"
    assert k["flex"]["guess"] == {"analysisGuid": w["an"], "glossGuid": w["g"], "gloss": {"en": "K"}, "form": "kkk"}
    assert "guess" not in m["flex"], "a word FLEx has nothing for: no guess"
    there = w["s"].open_text(w["by"]["elsewhere"])["doc"]
    assert "guess" not in word(there, 0)["flex"], "an analysed word is its own, never a guess"


def test_typing_another_language_into_a_guessed_word_keeps_the_guess_beside_it(world):
    """Seth's case: English guessed, Indonesian typed. The guess comes along (the page adopted it); a NEW
    gloss of the guessed analysis holds both; the guessed gloss and the word elsewhere are untouched."""
    w, s, port = world, world["s"], world["port"]
    forms = {"en": "K", "id": "K-id"}
    pv = s.preview(w["by"]["here"], w["rev"], [gloss_op(w, forms)], post(w, forms))
    x = pv["summary"][0]
    assert (x["outcome"], x["fromGuess"], x["approves"]) == ("newGloss", True, False)
    assert pv["counts"] == {"WfiGloss": 1}, "a gloss, never an analysis: the guessed one is used"
    r = s.save(pv["previewToken"])
    assert r["disk"]["ok"]
    a = occ(port, w["by"]["here"])
    assert a["kind"] == "gloss" and a["analysisGuid"] == w["an"] and a["gloss"] == {"en": "K", "id": "K-id"}
    assert a["guid"] != w["g"]
    assert {g["guid"]: g["forms"] for g in port.glosses_of(w["an"])}[w["g"]] == {"en": "K"}, "the guessed gloss is never edited"
    assert occ(port, w["by"]["elsewhere"])["guid"] == w["g"], "the word elsewhere keeps its gloss"


def test_typing_exactly_the_guess_confirms_it(world):
    w, s, port = world, world["s"], world["port"]
    counts = port.counts()
    pv = s.preview(w["by"]["here"], w["rev"], [gloss_op(w, {"en": "K"})], post(w, {"en": "K"}))
    assert (pv["summary"][0]["outcome"], pv["summary"][0]["fromGuess"]) == ("reuse", True) and pv["counts"] == {}
    s.save(pv["previewToken"])
    assert occ(port, w["by"]["here"])["guid"] == w["g"], "the occurrence takes FLEx's guess itself"
    assert port.counts() == counts, "nothing made"


def test_a_guess_nobody_approved_is_approved_when_a_word_takes_it(tmp_path):
    projects = tmp_path / "Projects"
    projects.mkdir()
    by, an, g = build(projects, approve=False)   # chosen in a text, never approved: still FLEx's first guess
    port = MockLcm(str(projects))
    s = Session(port, "copy-guess", write=True, copy_only=True, marker_ok=True)
    opened = s.open_text(by["here"])
    w = {"port": port, "s": s, "by": by, "doc": opened["doc"], "rev": opened["baseRev"]}
    assert word(w["doc"], 0)["flex"]["guess"]["analysisGuid"] == an
    pv = s.preview(by["here"], w["rev"], [gloss_op(w, {"en": "K"})], post(w, {"en": "K"}))
    assert pv["summary"][0]["approves"] is True
    s.save(pv["previewToken"])
    assert port.is_approved(an)


def test_a_guess_flex_no_longer_has_plans_the_word_as_unguessed(world):
    w, s = world, world["s"]
    op = gloss_op(w, {"en": "K", "id": "K-id"})
    op["guess"] = {"analysisGuid": "00000000-0000-4000-8000-000000000000", "glossGuid": None}   # gone
    pv = s.preview(w["by"]["here"], w["rev"], [op], post(w, {"en": "K", "id": "K-id"}))
    assert pv["summary"][0]["fromGuess"] is False
    op["guess"] = {"analysisGuid": w["an"], "glossGuid": "11111111-1111-4111-8111-111111111111"}   # not that analysis's gloss
    assert s.preview(w["by"]["here"], w["rev"], [op], post(w, {"en": "K", "id": "K-id"}))["summary"][0]["fromGuess"] is False


def test_flexs_ranking_chosen_in_texts_then_approval_then_guid(tmp_path):
    """AnalysisGuessServices: an analysis chosen in texts (by how often) before any unused one; among the
    unused, human-approved before no opinion; human-disapproved never; then GUID. The gloss: the one
    chosen most often."""
    projects = tmp_path / "Projects"
    projects.mkdir()
    MockLcm.create_project(str(projects), "copy-rank", texts=[{"title": "t", "paragraphs": ["zzz yyy", "zzz zzz", "zzz"]}])
    b = MockLcm(str(projects))
    b.open("copy-rank", write=True)
    tg = b.list_texts()[0]["guid"]
    t = b.read_text(tg)
    segs = [p["segments"][0] for p in t["paragraphs"]]
    wf = segs[0]["analyses"][0]["wordformGuid"]
    h = b.begin_uow("fixture", "fixture")
    a_approved = b.create_trivial_analysis(wf)
    b.set_evaluation(a_approved, True)
    b.create_gloss(a_approved, {"en": "approved"})
    a_rejected = b.create_trivial_analysis(wf)
    b.set_evaluation(a_rejected, False)
    b.commit(h)
    # nothing chosen yet: the human-approved one; the human-disapproved one never
    g = b.guesses(tg)
    assert g[segs[0]["guid"]][0]["analysisGuid"] == a_approved
    # an analysis chosen in a text outranks every unused one, approved or not; its most-chosen gloss leads
    h = b.begin_uow("fixture", "fixture")
    a_used = b.create_trivial_analysis(wf)
    g1 = b.create_gloss(a_used, {"en": "used once"})
    g2 = b.create_gloss(a_used, {"en": "used twice"})
    b.set_analysis(segs[1]["guid"], 0, g1)
    b.set_analysis(segs[1]["guid"], 1, g2)
    b.set_analysis(segs[2]["guid"], 0, g2)
    b.commit(h)
    g = b.guesses(tg)
    assert g[segs[0]["guid"]][0] == {"analysisGuid": a_used, "glossGuid": g2, "gloss": {"en": "used twice"}}
    assert segs[1]["guid"] not in g and segs[2]["guid"] not in g, "analysed occurrences have no guess"
    assert 1 not in g[segs[0]["guid"]], "yyy: nothing to guess from"
    # the guess is read-only: guessing writes nothing
    before = b.counts()
    b.guesses(tg)
    assert b.counts() == before and b.depth() == 0


def test_guesses_are_read_once_per_text_until_this_session_writes(world, monkeypatch):
    w, s, port = world, world["s"], world["port"]
    calls = []
    real = port.guesses
    monkeypatch.setattr(port, "guesses", lambda tg: calls.append(tg) or real(tg))
    s.open_text(w["by"]["here"])
    s.open_text(w["by"]["here"])
    assert calls == [], "the first open (the fixture's) already read them; re-opening reads nothing again"
    forms = {"en": "K", "id": "K-id"}
    s.save(s.preview(w["by"]["here"], w["rev"], [gloss_op(w, forms)], post(w, forms))["previewToken"])
    after = s.open_text(w["by"]["here"])["doc"]
    assert calls == [w["by"]["here"]], "a save can change any word's guess: read again"
    assert "guess" not in word(after, 0)["flex"], "the word is glossed now: no guess"


def test_a_failing_guess_never_stops_a_text_opening(world, monkeypatch):
    w, s, port = world, world["s"], world["port"]
    s.guess_cache.clear()

    def boom(tg):
        raise RuntimeError("FLEx threw")
    monkeypatch.setattr(port, "guesses", boom)
    doc = s.open_text(w["by"]["here"])["doc"]
    assert "guess" not in word(doc, 0)["flex"] and word(doc, 0)["txt"] == "kkk"


def test_a_language_the_project_no_longer_uses_rides_along_from_the_guess(tmp_path):
    """The page adopts only FLEx's current analysis writing systems (a save may name no other); the shell
    builds T from the guessed gloss as FLEx holds it, so French — on the guess, not current — comes along."""
    projects = tmp_path / "Projects"
    projects.mkdir()

    def french(b, by):
        an = b.read_text(by["elsewhere"])["paragraphs"][0]["segments"][0]["analyses"][0]["analysisGuid"]
        b.set_gloss_form(b.glosses_of(an)[0]["guid"], "fr", "K-fr")
    by, an, g = build(projects, extra=french)
    port = MockLcm(str(projects))
    s = Session(port, "copy-guess", write=True, copy_only=True, marker_ok=True)
    opened = s.open_text(by["here"])
    w = {"port": port, "s": s, "by": by, "doc": opened["doc"], "rev": opened["baseRev"]}
    assert word(w["doc"], 0)["flex"]["guess"]["gloss"] == {"en": "K", "fr": "K-fr"}
    forms = {"en": "K", "id": "K-id"}                     # what the page sends: current languages only
    s.save(s.preview(by["here"], w["rev"], [gloss_op(w, forms)], post(w, forms))["previewToken"])
    assert occ(port, by["here"])["gloss"] == {"en": "K", "fr": "K-fr", "id": "K-id"}
    assert {x["guid"]: x["forms"] for x in port.glosses_of(an)}[g] == {"en": "K", "fr": "K-fr"}, "the guessed gloss untouched"
