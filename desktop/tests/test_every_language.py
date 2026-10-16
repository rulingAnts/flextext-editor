"""Every analysis writing system of a FLEx text, kept and editable (Seth, 2026-10-16: "If it edits a GUID
object (a word), it should ONLY change what we changed and leave everything else preserved. I don't want it
erasing data in other writing systems or languages when I edit ONE of them, or only letting me make changes
to one of them at a time.") — through the whole save: preview, one UOW, the in-UOW checks, the disk check,
the re-read. French is on the fixture's glosses and translations but is NOT one of the project's current
analysis writing systems: the app never shows it, and nothing may change it. Made-up fixtures."""
import copy

import pytest

from flexshell import model
from flexshell.errors import FlexError
from flexshell.lcm_mock import MockLcm
from flexshell.protocol import Session


@pytest.fixture
def world(tmp_path):
    projects = tmp_path / "Projects"
    projects.mkdir()
    MockLcm.create_project(str(projects), "copy-every", texts=[{"title": "every", "paragraphs": ["kkk lll kkk", "nnn ooo nnn"]}],
                           anal_wss=("en", "id"))
    (projects / "copy-every" / "flextext-disposable-copy.txt").write_text("x")
    b = MockLcm(str(projects))
    b.open("copy-every", write=True)
    tg = b.list_texts()[0]["guid"]
    t = b.read_text(tg)
    s0, s1 = t["paragraphs"][0]["segments"][0], t["paragraphs"][1]["segments"][0]
    h = b.begin_uow("fixture", "fixture")
    b.set_free_translation(s0["guid"], "en", "one")
    b.set_free_translation(s0["guid"], "id", "satu")
    b.set_free_translation(s0["guid"], "fr", "un")
    b.set_free_translation(s1["guid"], "en", "two")
    shared = b.create_gloss(b.create_trivial_analysis(s0["analyses"][0]["wordformGuid"]), {"en": "K-en", "id": "K-id", "fr": "K-fr"})
    b.set_analysis(s0["guid"], 0, shared)
    b.set_analysis(s0["guid"], 2, shared)
    b.set_analysis(s0["guid"], 1, b.create_gloss(b.create_trivial_analysis(s0["analyses"][1]["wordformGuid"]), {"en": "L-en", "id": "L-id"}))
    b.commit(h)
    b.save()
    b.close_project()
    port = MockLcm(str(projects))
    s = Session(port, "copy-every", write=True, copy_only=True, marker_ok=True)
    opened = s.open_text(tg)
    return {"port": port, "s": s, "tg": tg, "doc": opened["doc"], "rev": opened["baseRev"]}


def raw(port, tg):
    t = port.read_text(tg)
    return [{"ft": s["ft"], "words": [(a["form"], a["kind"], a.get("gloss") or {}) for a in s["analyses"]]}
            for p in t["paragraphs"] for s in p["segments"]]


def set_gloss_in(w, lang, text, prim):
    """The engine's setGlossIn: the slot holds its own language, every other one is its item."""
    if lang == (w.get("glsLang") or prim):
        w["gls"] = text
    else:
        w["preservedXML"] = [x for x in w.get("preservedXML") or [] if not ('type="gls"' in x and 'lang="%s"' % lang in x)]
        if text:
            w["preservedXML"].append(model._gls_item(lang, text))


def set_free_in(seg, lang, text, prim):
    if lang == (seg.get("freeLang") or prim):
        seg["free"] = text
    else:
        seg["postItemsXML"] = [x for x in seg.get("postItemsXML") or [] if not ('type="gls"' in x and 'lang="%s"' % lang in x)]
        if text:
            seg["postItemsXML"].append(model._gls_item(lang, text))


def post(doc, touched, fresh=()):
    """The engine's post-state: every language of every word and line; the occurrence promised except for
    the words `fresh` names ((line, word index)) — glossed anew or made by the save, LCM's to assign."""
    out = model.post_state_of(doc, touched)
    for pg, phrases in out.items():
        for ph in phrases:
            line = next(i for i, ln in enumerate(doc["paragraphs"]) if ln["segments"][0]["attrs"]["guid"] == ph["segGuid"])
            for k, wd in enumerate(ph["words"]):
                if (line, k) in fresh or wd["punct"]:
                    wd["analysisGuid"] = None
    return out


def ids(doc, line):
    ln = doc["paragraphs"][line]
    return ln["paraOf"], ln["segments"][0]["attrs"]["guid"]


def test_two_languages_on_one_word_and_the_third_kept(world):
    w, s, port = world, world["s"], world["port"]
    doc = copy.deepcopy(w["doc"])
    assert doc["analLang"] == "en" and doc["flex"]["anals"] == ["en", "id"]
    k0 = doc["paragraphs"][0]["segments"][0]["words"][0]
    assert model.word_gloss_map(k0, "en") == {"en": "K-en", "id": "K-id"}, "French is not in the doc: the app never shows it"
    set_gloss_in(k0, "en", "K-en2", "en")
    set_gloss_in(k0, "id", "K-id2", "en")
    set_free_in(doc["paragraphs"][0]["segments"][0], "en", "one!", "en")
    set_free_in(doc["paragraphs"][1]["segments"][0], "id", "dua", "en")
    set_gloss_in(doc["paragraphs"][1]["segments"][0]["words"][0], "id", "N-id", "en")
    p0, s0 = ids(doc, 0)
    p1, s1 = ids(doc, 1)
    ops = [{"op": "gloss.set", "paraGuid": p0, "segGuid": s0, "index": 0, "forms": {"en": "K-en2", "id": "K-id2"}},
           {"op": "ft.set", "paraGuid": p0, "segGuid": s0, "ws": "en", "value": "one!"},
           {"op": "ft.set", "paraGuid": p1, "segGuid": s1, "ws": "id", "value": "dua"},
           {"op": "gloss.set", "paraGuid": p1, "segGuid": s1, "index": 0, "forms": {"id": "N-id"}}]
    pv = s.preview(w["tg"], w["rev"], ops, post(doc, {p0, p1}, fresh={(0, 0), (1, 0)}))
    assert pv["counts"] == {"WfiGloss": 2, "WfiAnalysis": 1, "WfiMorphBundle": 1}, pv["counts"]
    gl = [x for x in pv["summary"] if x["kind"] == "gloss.set"]
    assert [(x["outcome"], x["ws"], x["otherUses"]) for x in gl] == [("newGloss", ["en", "id"], 1), ("newGloss", ["id"], 0)]
    assert {(x["ws"], x["after"]) for x in pv["summary"] if x["kind"] == "ft.set"} == {("en", "one!"), ("id", "dua")}
    r = s.save(pv["previewToken"])
    assert port.undo_item_count() == 1, "one save, one FLEx history item"
    after = raw(port, w["tg"])
    assert after[0]["words"][0][2] == {"en": "K-en2", "id": "K-id2", "fr": "K-fr"}, "French came along onto the new gloss"
    assert after[0]["words"][2][2] == {"en": "K-en", "id": "K-id", "fr": "K-fr"}, "the other copy keeps the gloss it shared"
    assert after[0]["words"][1][2] == {"en": "L-en", "id": "L-id"}
    assert after[1]["words"][0] == ("nnn", "gloss", {"id": "N-id"}) and after[1]["words"][2][1] == "wordform", "only the copy typed into"
    assert after[0]["ft"] == {"en": "one!", "id": "satu", "fr": "un"} and after[1]["ft"] == {"en": "two", "id": "dua"}
    assert r["disk"]["ok"]


def test_a_post_state_wrong_in_another_language_rolls_back(world):
    w, s, port = world, world["s"], world["port"]
    doc = copy.deepcopy(w["doc"])
    set_gloss_in(doc["paragraphs"][0]["segments"][0]["words"][1], "id", "L-id2", "en")
    p0, s0 = ids(doc, 0)
    before = raw(port, w["tg"])
    ops = [{"op": "gloss.set", "paraGuid": p0, "segGuid": s0, "index": 1, "forms": {"id": "L-idX"}}]   # the ops disagree
    pv = s.preview(w["tg"], w["rev"], ops, post(doc, {p0}, fresh={(0, 1)}))
    with pytest.raises(FlexError) as ei:
        s.save(pv["previewToken"])
    assert ei.value.code == "E_INVARIANT" and "gloss in id" in ei.value.message
    assert raw(port, w["tg"]) == before and port.undo_item_count() == 0


def test_a_write_that_would_drop_a_language_never_lands(world, monkeypatch):
    """A gloss written without French (a port that dropped it) is caught inside the UOW and rolled back."""
    w, s, port = world, world["s"], world["port"]
    doc = copy.deepcopy(w["doc"])
    set_gloss_in(doc["paragraphs"][0]["segments"][0]["words"][0], "en", "K-en2", "en")
    p0, s0 = ids(doc, 0)
    before = raw(port, w["tg"])
    pv = s.preview(w["tg"], w["rev"], [{"op": "gloss.set", "paraGuid": p0, "segGuid": s0, "index": 0, "forms": {"en": "K-en2"}}],
                   post(doc, {p0}, fresh={(0, 0)}))
    real = port.create_gloss
    monkeypatch.setattr(port, "create_gloss", lambda a, forms: real(a, {k: v for k, v in forms.items() if k != "fr"}))
    with pytest.raises(FlexError) as ei:
        s.save(pv["previewToken"])
    assert ei.value.code == "E_INVARIANT" and ei.value.detail.get("ws") == ["fr"]
    assert raw(port, w["tg"]) == before, "rolled back: French is still there, nothing else changed"


def test_the_same_unanalysed_word_twice_in_one_save(world):
    """The second copy finds the analysis the first one made, and reuses its gloss: the preview counts
    what FLEx makes, so the save is not refused for a count it got wrong."""
    w, s, port = world, world["s"], world["port"]
    doc = copy.deepcopy(w["doc"])
    words = doc["paragraphs"][1]["segments"][0]["words"]
    for k in (0, 2):
        set_gloss_in(words[k], "id", "N-id", "en")
    p1, s1 = ids(doc, 1)
    ops = [{"op": "gloss.set", "paraGuid": p1, "segGuid": s1, "index": k, "forms": {"id": "N-id"}} for k in (0, 2)]
    pv = s.preview(w["tg"], w["rev"], ops, post(doc, {p1}, fresh={(1, 0), (1, 2)}))
    assert pv["counts"] == {"WfiGloss": 1, "WfiAnalysis": 1, "WfiMorphBundle": 1}, pv["counts"]
    assert [x["outcome"] for x in pv["summary"]] == ["newGloss", "reuse"]
    s.save(pv["previewToken"])
    a = raw(port, w["tg"])[1]["words"]
    t = port.read_text(w["tg"])["paragraphs"][1]["segments"][0]["analyses"]
    assert a[0][2] == a[2][2] == {"id": "N-id"} and t[0]["guid"] == t[2]["guid"], "both copies point at the one new gloss"


def test_glosses_on_the_halves_of_a_split_word(world):
    """Space inside "ooo" in the Matcher, then a gloss typed on the second half: the gloss runs after the
    split, on the bare wordform it made, checked by its form."""
    w, s, port = world, world["s"], world["port"]
    doc = copy.deepcopy(w["doc"])
    seg = doc["paragraphs"][1]["segments"][0]
    a, b = {"txt": "o", "punct": False, "gls": "", "guid": "new-a"}, {"txt": "oo", "punct": False, "gls": "", "guid": "new-b"}
    set_gloss_in(b, "en", "OO-en", "en")
    set_gloss_in(b, "id", "OO-id", "en")
    seg["words"] = seg["words"][:1] + [a, b] + seg["words"][2:]
    p1, s1 = ids(doc, 1)
    ops = [{"op": "word.split", "paraGuid": p1, "segGuid": s1, "index": 1, "offset": 1},
           {"op": "gloss.set", "paraGuid": p1, "segGuid": s1, "index": 2, "forms": {"en": "OO-en", "id": "OO-id"}, "newWord": True, "form": "oo"}]
    pv = s.preview(w["tg"], w["rev"], ops, post(doc, {p1}, fresh={(1, 1), (1, 2)}))
    assert pv["counts"] == {"WfiWordform": 2, "WfiAnalysis": 1, "WfiMorphBundle": 1, "WfiGloss": 1}, pv["counts"]
    s.save(pv["previewToken"])
    words = raw(port, w["tg"])[1]["words"]
    assert [x[0] for x in words] == ["nnn", "o", "oo", "nnn"]
    assert words[1][1] == "wordform" and words[2] == ("oo", "gloss", {"en": "OO-en", "id": "OO-id"})
    # the same kind of op aimed at a word that is not a bare wordform of that form writes nothing
    s2 = Session(port, "copy-every", write=True, copy_only=True, marker_ok=True)
    o2 = s2.open_text(w["tg"])
    d2 = copy.deepcopy(o2["doc"])
    seg2 = d2["paragraphs"][1]["segments"][0]
    set_gloss_in(seg2["words"][2], "en", "OO-en2", "en")
    bad = [{"op": "gloss.set", "paraGuid": p1, "segGuid": s1, "index": 2, "forms": {"en": "OO-en2"}, "newWord": True, "form": "oo"}]
    pv2 = s2.preview(w["tg"], o2["baseRev"], bad, post(d2, {p1}, fresh={(1, 2)}))
    before = raw(port, w["tg"])
    with pytest.raises(FlexError) as ei:
        s2.save(pv2["previewToken"])
    assert ei.value.code == "E_INVARIANT" and raw(port, w["tg"]) == before, "not a word this save made: nothing written"


def test_a_gloss_and_a_phrase_split_in_one_save(world):
    """A word glossed AND moved into a new phrase by a split in the same save: the gloss is set first, on
    the text as checked out; the split keeps the word's analysis, so the gloss goes with it."""
    w, s, port = world, world["s"], world["port"]
    doc = copy.deepcopy(w["doc"])
    ln = doc["paragraphs"][0]
    seg = ln["segments"][0]
    p0, s0 = ln["paraOf"], seg["attrs"]["guid"]
    set_gloss_in(seg["words"][1], "id", "L-id2", "en")
    seg2 = copy.deepcopy(seg)
    seg2["attrs"] = {"guid": "engine-new"}
    seg2["words"] = seg["words"][1:]
    seg2["baseline"] = "lll kkk"
    seg2["free"], seg2["freeLang"], seg2["postItemsXML"] = "", None, []
    seg2["flex"] = {"paraGuid": p0, "segGuid": "engine-new", "notes": []}
    seg["words"] = seg["words"][:1]
    seg["baseline"] = "kkk"
    doc["paragraphs"].insert(1, {"guid": "ln-new", "paraOf": p0, "segments": [seg2], "flex": {"paraGuid": p0, "segGuid": "engine-new"}})
    ops = [{"op": "gloss.set", "paraGuid": p0, "segGuid": s0, "index": 1, "forms": {"id": "L-id2"}},
           {"op": "phrase.split", "paraGuid": p0, "segGuid": s0, "afterWordIndex": 0, "newPhrase": "engine-new", "times": None}]
    pv = s.preview(w["tg"], w["rev"], ops, post(doc, {p0}, fresh={(1, 0)}))
    r = s.save(pv["previewToken"])
    t = port.read_text(w["tg"])["paragraphs"][0]["segments"]
    assert [x["guid"] for x in t] == [s0, r["alias"]["engine-new"]]
    assert t[1]["analyses"][0]["form"] == "lll" and t[1]["analyses"][0]["gloss"] == {"en": "L-en", "id": "L-id2"}, "the gloss went with its word"
    assert t[1]["analyses"][1]["gloss"] == {"en": "K-en", "id": "K-id", "fr": "K-fr"}


def test_scope_a_language_outside_the_projects_list_and_one_change_per_word(world):
    w, s = world, world["s"]
    p0, s0 = ids(w["doc"], 0)
    with pytest.raises(FlexError) as ei:
        s.preview(w["tg"], w["rev"], [{"op": "gloss.set", "paraGuid": p0, "segGuid": s0, "index": 0, "forms": {"fr": "x"}}], {})
    assert ei.value.code == "E_SCOPE", "French is not one of the project's analysis writing systems: never written"
    with pytest.raises(FlexError) as ei:
        s.preview(w["tg"], w["rev"], [{"op": "gloss.set", "paraGuid": p0, "segGuid": s0, "index": 0, "forms": {"en": "a"}},
                                      {"op": "gloss.set", "paraGuid": p0, "segGuid": s0, "index": 0, "forms": {"id": "b"}}], {})
    assert ei.value.code == "E_SCOPE", "one op per word, naming every language changed"
    pv = s.preview(w["tg"], w["rev"], [{"op": "gloss.set", "paraGuid": p0, "segGuid": s0, "index": 1, "ws": "id", "value": "L-id2"}], {})
    assert [x["ws"] for x in pv["summary"]] == [["id"]], "an older engine's op (ws + value) still reads"
