"""Seth's undo rule, on the FLEx side (plan §4.4, §13.1): one Save to FLEx = one FLEx history item,
however many objects it touches; one Undo restores everything; one Redo redoes all of it. (The
editor-side half — one Matcher action = one ring item — is test/word-split-insert.test.mjs.)"""
import pytest

from flexshell import model
from flexshell.lcm_mock import MockLcm, SECTION
from flexshell.protocol import Session

TEXT = [{"title": "undo text", "paragraphs": ["aaa bbb " + SECTION + " ccc ddd " + SECTION + " eee fff."]}]


def test_many_objects_one_item_one_undo_one_redo(tmp_path):
    projects = tmp_path / "P"
    projects.mkdir()
    MockLcm.create_project(str(projects), "copy-u", texts=TEXT)
    (projects / "copy-u" / "flextext-disposable-copy.txt").write_text("x")
    port = MockLcm(str(projects))
    s = Session(port, "copy-u", write=True, copy_only=True, marker_ok=True)
    tg = port.list_texts()[0]["guid"]
    o = s.open_text(tg)
    doc = o["doc"]
    ops = []
    import copy
    intended = copy.deepcopy(doc)
    for i, ln in enumerate(doc["paragraphs"]):
        seg = ln["segments"][0]
        ops.append({"op": "ft.set", "paraGuid": ln["paraOf"], "segGuid": seg["attrs"]["guid"], "ws": "en", "value": "line %d" % i})
        ops.append({"op": "times.set", "paraGuid": ln["paraOf"], "segGuid": seg["attrs"]["guid"], "begin": i * 1000, "end": i * 1000 + 900})
        ops.append({"op": "gloss.set", "paraGuid": ln["paraOf"], "segGuid": seg["attrs"]["guid"], "index": 0, "ws": "en", "value": "G%d" % i})
        iseg = intended["paragraphs"][i]["segments"][0]
        iseg["free"], iseg["freeLang"] = "line %d" % i, "en"
        iseg["attrs"]["begin-time-offset"], iseg["attrs"]["end-time-offset"] = str(i * 1000), str(i * 1000 + 900)
        iseg["words"][0]["gls"] = "G%d" % i
        iseg["words"][0]["flex"]["analysisGuid"] = None   # a new gloss object: its guid is LCM's
    post = model.post_state_of(intended)
    fp0 = model.fingerprint_text(port.read_text(tg))
    c0 = port.counts()
    pv = s.preview(tg, o["baseRev"], ops, post)
    assert len(pv["summary"]) == 9
    assert pv["counts"] == {"WfiAnalysis": 3, "WfiMorphBundle": 3, "WfiGloss": 3}
    r = s.save(pv["previewToken"])
    assert port.undoable_action_count() == 1, "nine edits, ONE FLEx history item"
    assert port.last_undo_text() == "Undo Save to FLEx (9 changes)"
    fp1 = model.fingerprint_text(port.read_text(tg))
    c1 = port.counts()
    assert fp1 != fp0 and c1["WfiGloss"] == c0["WfiGloss"] + 3
    s.undo_save()
    assert model.fingerprint_text(port.read_text(tg)) == fp0 and port.counts() == c0, "ONE undo restores every object"
    assert port.undoable_action_count() == 0
    s.redo_save()
    assert model.fingerprint_text(port.read_text(tg)) == fp1 and port.counts() == c1, "ONE redo redoes all of it"
    assert port.undoable_action_count() == 1
    t = port.read_text(tg)
    assert [sg["ft"]["en"] for p in t["paragraphs"] for sg in p["segments"]] == ["line 0", "line 1", "line 2"]
    assert [sg["analyses"][0]["gloss"]["en"] for p in t["paragraphs"] for sg in p["segments"]] == ["G0", "G1", "G2"]


def test_two_saves_are_two_items_and_undo_walks_them_back_one_at_a_time(tmp_path):
    projects = tmp_path / "P"
    projects.mkdir()
    MockLcm.create_project(str(projects), "copy-v", texts=TEXT)
    (projects / "copy-v" / "flextext-disposable-copy.txt").write_text("x")
    port = MockLcm(str(projects))
    s = Session(port, "copy-v", write=True, copy_only=True, marker_ok=True)
    tg = port.list_texts()[0]["guid"]
    o = s.open_text(tg)
    ln = o["doc"]["paragraphs"][0]
    seg = ln["segments"][0]["attrs"]["guid"]
    fps = [model.fingerprint_text(port.read_text(tg))]
    rev = o["baseRev"]
    for v in ("first", "second"):
        pv = s.preview(tg, rev, [{"op": "ft.set", "paraGuid": ln["paraOf"], "segGuid": seg, "ws": "en", "value": v}], {})
        r = s.save(pv["previewToken"])
        rev = r["newBaseRev"]
        fps.append(model.fingerprint_text(port.read_text(tg)))
    assert port.undoable_action_count() == 2
    s.undo_save()
    assert model.fingerprint_text(port.read_text(tg)) == fps[1]
    s.undo_save()
    assert model.fingerprint_text(port.read_text(tg)) == fps[0]
    assert port.undoable_action_count() == 0
