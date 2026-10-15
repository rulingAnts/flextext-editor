"""Per-text writing systems (plan §7.4): what a text uses, what it opens in, the choice from FLEx's own
lists, words in another vernacular alternative, one analysis writing system edited and the others kept —
and the save path honouring all of it. Made-up fixtures."""
import copy

import pytest

from flexshell import model
from flexshell.errors import FlexError
from flexshell.lcm_mock import MockLcm
from flexshell.protocol import Session

NAMES = {"xx": "Example", "xx-x-ipa": "Example (IPA)", "en": "English", "id": "Indonesian"}


def engine_post(doc, touched):
    """The intended post-state as the ENGINE sends it (flex-ops.js postStateOf): every word, one free
    translation — in the text's analysis writing system — and no literal translation."""
    out = {}
    for ln in doc["paragraphs"]:
        pg = ln.get("paraOf")
        if pg not in touched:
            continue
        seg = ln["segments"][0]
        a = seg.get("attrs") or {}
        out.setdefault(pg, []).append({
            "segGuid": a.get("guid"), "text": " ".join(w["txt"] for w in seg["words"]),
            "words": [{"txt": w["txt"], "punct": bool(w.get("punct")), "gls": w.get("gls", ""), "analysisGuid": None} for w in seg["words"]],
            "ft": {seg.get("freeLang") or doc["analLang"]: seg["free"]} if seg.get("free") else {}, "lt": {},
            "begin": a.get("begin-time-offset"), "end": a.get("end-time-offset")})
    return out


@pytest.fixture
def ws_world(tmp_path):
    """Two vernacular and two analysis writing systems. Text "two": glossed and translated in both
    analysis writing systems, Indonesian more. Text "ipa": its paragraph written in the IPA alternative."""
    projects = tmp_path / "Projects"
    projects.mkdir()
    MockLcm.create_project(str(projects), "copy-ws", texts=[
        {"title": "two", "paragraphs": ["aaa bbb ccc", "ddd eee"]},
        {"title": "ipa", "paragraphs": ["fff ggg"], "ws": "xx-x-ipa"},
    ], vern_wss=("xx", "xx-x-ipa"), anal_wss=("en", "id"), ws_names=NAMES)
    (projects / "copy-ws" / "flextext-disposable-copy.txt").write_text("x")
    b = MockLcm(str(projects))
    b.open("copy-ws", write=True)
    two = next(t["guid"] for t in b.list_texts() if t["title"] == "two")
    t = b.read_text(two)
    h = b.begin_uow("fixture", "fixture")
    s0, s1 = t["paragraphs"][0]["segments"][0], t["paragraphs"][1]["segments"][0]
    b.set_free_translation(s0["guid"], "en", "first in English")
    b.set_free_translation(s0["guid"], "id", "pertama")
    b.set_free_translation(s1["guid"], "id", "kedua")
    b.set_literal_translation(s1["guid"], "en", "second, literally")
    an = b.create_trivial_analysis(s0["analyses"][0]["wordformGuid"])
    g = b.create_gloss(an, {"en": "A-en", "id": "A-id"})
    b.set_analysis(s0["guid"], 0, g)
    b.commit(h)
    b.add_form_alternative("bbb", "xx-x-ipa", "ɓɓɓ")
    b.save()
    b.close_project()
    port = MockLcm(str(projects))
    s = Session(port, "copy-ws", write=True, copy_only=True, marker_ok=True)
    ipa = next(t["guid"] for t in port.list_texts() if t["title"] == "ipa")
    return {"port": port, "s": s, "two": two, "ipa": ipa}


def test_writing_systems_carry_flex_names_and_both_vernaculars(ws_world):
    ws = ws_world["port"].writing_systems()
    assert [(w["id"], w["name"], w["isDefault"]) for w in ws["vern"]] == [("xx", "Example", True), ("xx-x-ipa", "Example (IPA)", False)]
    assert [(w["id"], w["name"]) for w in ws["anal"]] == [("en", "English"), ("id", "Indonesian")]


def test_what_a_text_uses_and_what_it_opens_in(ws_world):
    s = ws_world["s"]
    r = s.text_ws(ws_world["two"])
    assert r["usage"]["vern"] == {"xx": 2}
    assert r["usage"]["anal"] == {"en": {"ft": 1, "lt": 1, "gloss": 1}, "id": {"ft": 2, "lt": 0, "gloss": 1}}
    assert r["default"] == {"vern": "xx", "anal": "id"}, "the analysis writing system the text uses most"
    assert r["current"] is None, "asking does not open the text"
    assert s.text_ws(ws_world["ipa"])["default"] == {"vern": "xx-x-ipa", "anal": "en"}, "its paragraph's own; FLEx's first analysis when nothing is translated"


def test_the_doc_shows_one_analysis_writing_system_and_carries_the_others_read_only(ws_world):
    s = ws_world["s"]
    o = s.open_text(ws_world["two"])
    doc = o["doc"]
    assert o["ws"] == {"vern": "xx", "anal": "id"} and doc["vernLang"] == "xx" and doc["analLang"] == "id"
    assert doc["flex"]["ws"] == {"vern": "xx", "anal": "id"}
    seg0 = doc["paragraphs"][0]["segments"][0]
    assert seg0["free"] == "pertama" and seg0["freeLang"] == "id"
    assert seg0["postItemsXML"] == ['<item type="gls" lang="en">first in English</item>']
    w0 = seg0["words"][0]
    assert w0["gls"] == "A-id" and w0["glsLang"] == "id" and w0["preservedXML"] == ['<item type="gls" lang="en">A-en</item>']
    o2 = s.open_text(ws_world["two"], ws={"vern": "xx", "anal": "en"})
    seg0 = o2["doc"]["paragraphs"][0]["segments"][0]
    assert seg0["free"] == "first in English" and seg0["words"][0]["gls"] == "A-en" and o2["baseRev"] == o["baseRev"], \
        "another analysis writing system is another view of the same FLEx text"
    assert s.texts[ws_world["two"]]["ws"] == {"vern": "xx", "anal": "en"}, "the choice is remembered for the text"


def test_words_in_another_vernacular_alternative_fall_back_where_there_is_none(ws_world):
    s = ws_world["s"]
    doc = s.open_text(ws_world["two"], ws={"vern": "xx-x-ipa", "anal": "en"})["doc"]
    assert [w["txt"] for w in doc["paragraphs"][0]["segments"][0]["words"]] == ["aaa", "ɓɓɓ", "ccc"]
    assert doc["vernLang"] == "xx-x-ipa"
    ipa = s.open_text(ws_world["ipa"])["doc"]
    assert [w["txt"] for w in ipa["paragraphs"][0]["segments"][0]["words"]] == ["fff", "ggg"], \
        "a paragraph in the IPA alternative shows its own words, not the default vernacular's (empty) ones"


def test_only_flexs_own_writing_systems_can_be_chosen(ws_world):
    s = ws_world["s"]
    for bad in ({"vern": "zz", "anal": "en"}, {"vern": "xx", "anal": "fr"}, {"vern": "xx"}, "en"):
        with pytest.raises(FlexError) as ei:
            s.open_text(ws_world["two"], ws=bad)
        assert ei.value.code == "E_SCOPE"


def test_word_edits_shown_in_another_vernacular_are_refused(ws_world):
    s = ws_world["s"]
    o = s.open_text(ws_world["two"], ws={"vern": "xx-x-ipa", "anal": "en"})
    ln = o["doc"]["paragraphs"][0]
    op = {"op": "word.split", "paraGuid": ln["paraOf"], "segGuid": ln["segments"][0]["attrs"]["guid"], "index": 0, "offset": 1}
    with pytest.raises(FlexError) as ei:
        s.preview(ws_world["two"], o["baseRev"], [op], {})
    assert ei.value.code == "E_WS_WORDS" and ei.value.detail == {"shown": "xx-x-ipa", "para": "xx"}
    # times are not words: they save from any view
    o = s.open_text(ws_world["two"], ws={"vern": "xx-x-ipa", "anal": "en"})
    doc = copy.deepcopy(o["doc"])
    seg = doc["paragraphs"][0]["segments"][0]
    seg["attrs"]["begin-time-offset"], seg["attrs"]["end-time-offset"] = "0", "400"
    t_op = {"op": "times.set", "paraGuid": ln["paraOf"], "segGuid": seg["attrs"]["guid"], "begin": 0, "end": 400}
    pv = s.preview(ws_world["two"], o["baseRev"], [t_op], engine_post(doc, {ln["paraOf"]}))
    assert s.save(pv["previewToken"])["saved"] == 1


def test_a_save_writes_the_chosen_analysis_writing_system_and_keeps_every_other(ws_world):
    """The rollback this fixes: the engine's post-state carries ONE free translation; FLEx's re-read
    carries every one — so any save touching a phrase translated in two writing systems rolled back."""
    s, port = ws_world["s"], ws_world["port"]
    o = s.open_text(ws_world["two"], ws={"vern": "xx", "anal": "id"})
    doc = copy.deepcopy(o["doc"])
    ln0, ln1 = doc["paragraphs"]
    seg0, seg1 = ln0["segments"][0], ln1["segments"][0]
    seg0["free"] = "pertama, diubah"
    seg0["words"][0]["gls"] = "A-id2"
    seg1["attrs"]["begin-time-offset"], seg1["attrs"]["end-time-offset"] = "100", "900"
    ops = [{"op": "ft.set", "paraGuid": ln0["paraOf"], "segGuid": seg0["attrs"]["guid"], "ws": "id", "value": "pertama, diubah"},
           {"op": "gloss.set", "paraGuid": ln0["paraOf"], "segGuid": seg0["attrs"]["guid"], "index": 0, "ws": "id", "value": "A-id2"},
           {"op": "times.set", "paraGuid": ln1["paraOf"], "segGuid": seg1["attrs"]["guid"], "begin": 100, "end": 900}]
    pv = s.preview(ws_world["two"], o["baseRev"], ops, engine_post(doc, {ln0["paraOf"], ln1["paraOf"]}))
    s.save(pv["previewToken"])
    t = port.read_text(ws_world["two"])
    s0, s1 = t["paragraphs"][0]["segments"][0], t["paragraphs"][1]["segments"][0]
    assert s0["ft"] == {"en": "first in English", "id": "pertama, diubah"}
    assert s1["ft"] == {"id": "kedua"} and s1["lt"] == {"en": "second, literally"} and (s1["beginTime"], s1["endTime"]) == ("100", "900")
    assert s0["analyses"][0]["gloss"].get("id") == "A-id2" and s0["analyses"][0]["gloss"].get("en") == "A-en", \
        "the gloss in the other writing system is kept"


def test_the_comparison_still_catches_a_change_to_a_translation_the_engine_does_not_show():
    before = {"s1": {"ft": {"en": "kept"}, "lt": {}}}
    want = {"P": [{"segGuid": "s1", "words": [], "ft": {"id": "x"}, "lt": {}, "begin": None, "end": None}]}
    have = {"P": [{"segGuid": "s1", "words": [], "ft": {"id": "x", "en": "CHANGED"}, "lt": {}, "begin": None, "end": None}]}
    assert model.compare_post_state(want, have, primary="id", others=before) == ["paragraph P phrase 0: free translation in en changed"]
    have["P"][0]["ft"]["en"] = "kept"
    assert model.compare_post_state(want, have, primary="id", others=before) == []
