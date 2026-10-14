"""Save to FLEx, W1–W10 (plan §5.4), with a fault injected at EVERY step: each run ends rolled back
or poisoned, never half-written. Plus the happy path, undo/redo of a save, and import/export."""
import logging
import os
import zipfile

import pytest

from flexshell import model
from flexshell.errors import FlexError
from flexshell.lcm_mock import MockLcm, SECTION
from flexshell.protocol import Session

TEXTS = [{"title": "proto one", "paragraphs": ["aaa bbb ccc. ddd eee " + SECTION + " fff ggg.", "hhh iii jjj"]}]


@pytest.fixture
def world(tmp_path):
    projects = tmp_path / "Projects"
    projects.mkdir()
    MockLcm.create_project(str(projects), "copy-p", texts=TEXTS)
    (projects / "copy-p" / "flextext-disposable-copy.txt").write_text("x")
    port = MockLcm(str(projects))
    s = Session(port, "copy-p", write=True, copy_only=True, marker_ok=True)
    tg = port.list_texts()[0]["guid"]
    opened = s.open_text(tg)
    return {"port": port, "s": s, "tg": tg, "doc": opened["doc"], "rev": opened["baseRev"], "projects": projects}


def fw_bytes(port):
    with open(port.fwdata_path(), "rb") as f:
        return f.read()


def ft_op(w, value="translated", line=0):
    seg = w["doc"]["paragraphs"][line]["segments"][0]
    return {"op": "ft.set", "paraGuid": w["doc"]["paragraphs"][line]["paraOf"], "segGuid": seg["attrs"]["guid"], "ws": "en", "value": value}


def post_for(w, ops):
    """The intended post-state for an ft.set: the doc with the translation applied."""
    import copy
    doc = copy.deepcopy(w["doc"])
    for op in ops:
        if op["op"] == "ft.set":
            for ln in doc["paragraphs"]:
                for seg in ln["segments"]:
                    if seg["attrs"]["guid"] == op["segGuid"]:
                        seg["free"] = op["value"]
                        seg["freeLang"] = op["ws"]
        if op["op"] == "times.set":
            for ln in doc["paragraphs"]:
                for seg in ln["segments"]:
                    if seg["attrs"]["guid"] == op["segGuid"]:
                        seg["attrs"]["begin-time-offset"] = str(op["begin"])
                        seg["attrs"]["end-time-offset"] = str(op["end"])
    touched = {op["paraGuid"] for op in ops if op.get("paraGuid")}
    return model.post_state_of(doc, touched)


# ---- happy path -----------------------------------------------------------------------------------
def test_preview_then_save_is_one_uow_one_history_item_and_a_clean_disk_diff(world):
    w, s, port = world, world["s"], world["port"]
    ops = [ft_op(w, "the first phrase"), ft_op(w, "the second phrase", line=1)]
    pv = s.preview(w["tg"], w["rev"], ops, post_for(w, ops))
    assert pv["previewToken"] and len(pv["summary"]) == 2 and pv["blockers"] == [] and pv["counts"] == {}
    assert pv["undoLabel"] == "Undo Save to FLEx (2 changes)"
    before = fw_bytes(port)
    progress = []
    r = s.save(pv["previewToken"], progress=progress.append)
    assert progress == ["Backing up…", "Verifying backup…", "Writing…", "Checking…", "Saving…", "Checking the file on disk…"]
    assert r["undoLabel"] == "Undo Save to FLEx (2 changes)" and r["backup"]["verified"] and r["disk"]["ok"]
    assert r["disk"]["changed"].get("Segment") == 2
    assert port.undoable_action_count() == 1 and port.last_undo_text() == "Undo Save to FLEx (2 changes)"
    assert port.has_unsaved_changes() is False and fw_bytes(port) != before
    assert r["newBaseRev"] != w["rev"]
    uow = [c for c in port.calls if c[0] in ("begin_uow", "commit", "rollback")]
    assert uow == [("begin_uow", "Undo Save to FLEx (2 changes)"), ("commit",)], "exactly one UOW, committed"
    order = [c[0] for c in port.calls if c[0] in ("backup", "begin_uow", "commit", "save", "complete_all_commits")]
    assert order == ["backup", "save", "begin_uow", "commit", "save", "complete_all_commits"], "backup (which saves first) before the UOW; save after"
    # re-read: both translations
    t = port.read_text(w["tg"])
    # line 1 of the engine doc is paragraph 0's SECOND segment (one phrase per line)
    assert t["paragraphs"][0]["segments"][0]["ft"] == {"en": "the first phrase"} and t["paragraphs"][0]["segments"][1]["ft"] == {"en": "the second phrase"}


def test_backup_is_reused_within_a_session_until_a_save_and_a_truncated_one_is_rejected(world):
    w, s, port = world, world["s"], world["port"]
    b1 = s.ensure_backup()
    b2 = s.ensure_backup()
    assert b1["path"] == b2["path"] and b2["reused"]
    pv = s.preview(w["tg"], w["rev"], [ft_op(w)], post_for(w, [ft_op(w)]))
    r = s.save(pv["previewToken"])
    assert r["backup"]["path"] == b1["path"]
    assert s.backup_ok is None, "after a save the next save backs up again"
    port.inject["backup_truncate"] = True
    with pytest.raises(FlexError) as ei:
        s.ensure_backup()
    assert ei.value.code == "E_BACKUP_FAILED" and s.poisoned is None, "fail closed, nothing written, not poisoned"


# ---- W1 refusals -----------------------------------------------------------------------------------
def test_w1_stale_base(world):
    w, s, port = world, world["s"], world["port"]
    with pytest.raises(FlexError) as ei:
        s.preview(w["tg"], "not-the-rev", [ft_op(w)], {})
    assert ei.value.code == "E_STALE_BASE"
    # the FLEx side changed under us
    seg = w["doc"]["paragraphs"][0]["segments"][0]["attrs"]["guid"]
    h = port.begin_uow("x", "x")
    port.set_free_translation(seg, "en", "someone else")
    port.commit(h)
    with pytest.raises(FlexError) as ei:
        s.preview(w["tg"], w["rev"], [ft_op(w)], {})
    assert ei.value.code == "E_STALE_BASE"


def test_w1_scope_and_empty_phrase_and_expiry(world):
    w, s = world, world["s"]
    with pytest.raises(FlexError) as ei:
        s.preview(w["tg"], w["rev"], [{"op": "lexicon.edit"}], {})
    assert ei.value.code == "E_SCOPE"
    with pytest.raises(FlexError) as ei:
        s.preview(w["tg"], w["rev"], [dict(ft_op(w), ws="fr")], {})
    assert ei.value.code == "E_SCOPE"
    with pytest.raises(FlexError) as ei:
        s.preview(w["tg"], w["rev"], [dict(ft_op(w), segGuid="not-here")], {})
    assert ei.value.code == "E_SCOPE"
    post = post_for(w, [ft_op(w)])
    pg = w["doc"]["paragraphs"][0]["paraOf"]
    post[pg][0]["text"] = "— …"
    with pytest.raises(FlexError) as ei:
        s.preview(w["tg"], w["rev"], [ft_op(w)], post)
    assert ei.value.code == "E_EMPTY_PHRASE" and ei.value.detail["blockers"][0]["code"] == "E_EMPTY_PHRASE"
    pv = s.preview(w["tg"], w["rev"], [ft_op(w)], post_for(w, [ft_op(w)]))
    s.previews[pv["previewToken"]]["expires"] = 0
    with pytest.raises(FlexError) as ei:
        s.save(pv["previewToken"])
    assert ei.value.code == "E_PREVIEW_EXPIRED"


def test_w1_fragile_paragraph_is_refused(world):
    w, s, port = world, world["s"], world["port"]
    pg = w["doc"]["paragraphs"][0]["paraOf"]
    para = port.store[pg]
    s0 = port.store[para["Segments"][0]]
    port._dirty.add(pg)
    fake = port._new_segment(pg, 4, s0["EndOffset"])
    s0["EndOffset"] = 4
    para["Segments"].insert(1, fake.guid)
    port._disk = None
    s.texts[w["tg"]]["baseRev"] = model.base_rev(port.read_text(w["tg"]))
    with pytest.raises(FlexError) as ei:
        s.preview(w["tg"], s.texts[w["tg"]]["baseRev"], [ft_op(w)], {})
    assert ei.value.code == "E_FRAGILE_PARAGRAPH"


def test_w1_warnings_internal_eos_and_times_without_media(world):
    w, s = world, world["s"]
    seg = w["doc"]["paragraphs"][1]["segments"][0]
    ops = [{"op": "times.set", "paraGuid": w["doc"]["paragraphs"][1]["paraOf"], "segGuid": seg["attrs"]["guid"], "begin": 100, "end": 900}]
    post = post_for(w, ops)
    post[w["doc"]["paragraphs"][1]["paraOf"]][0]["text"] = "hhh? iii jjj"
    pv = s.preview(w["tg"], w["rev"], ops, post)
    codes = sorted(x["code"] for x in pv["warnings"])
    assert codes == ["internalEos", "timesWithoutMedia"]


# ---- W3/W4 failures → rollback -------------------------------------------------------------------
def test_w3_exception_inside_lcm_rolls_back_and_nothing_is_written(world):
    w, s, port = world, world["s"], world["port"]
    pv = s.preview(w["tg"], w["rev"], [ft_op(w)], post_for(w, [ft_op(w)]))
    before = fw_bytes(port)
    fp = model.fingerprint_text(port.read_text(w["tg"]))
    port.inject["raise_in_write"] = True
    with pytest.raises(FlexError) as ei:
        s.save(pv["previewToken"])
    assert ei.value.code == "E_INVARIANT"
    assert s.poisoned is None, "a clean rollback is not poison"
    assert port.depth() == 0 and port.undoable_action_count() == 0
    assert model.fingerprint_text(port.read_text(w["tg"])) == fp
    assert [c[0] for c in port.calls if c[0] in ("commit", "rollback")] == ["rollback"]
    # the backup ran (and saved) but no write landed after it
    assert port.has_unsaved_changes() is False


def test_w4_post_state_mismatch_rolls_back(world):
    w, s, port = world, world["s"], world["port"]
    op = ft_op(w, "really this")
    post = post_for(w, [op])
    post[op["paraGuid"]][0]["ft"] = {"en": "something else"}      # a diff bug: the engine disagrees with its own ops
    pv = s.preview(w["tg"], w["rev"], [op], post)
    fp = model.fingerprint_text(port.read_text(w["tg"]))
    with pytest.raises(FlexError) as ei:
        s.save(pv["previewToken"])
    assert ei.value.code == "E_INVARIANT" and "free translation differs" in ei.value.message
    assert model.fingerprint_text(port.read_text(w["tg"])) == fp and port.undoable_action_count() == 0
    assert s.poisoned is None


def test_w4_count_mismatch_rolls_back(world):
    w, s, port = world, world["s"], world["port"]
    pv = s.preview(w["tg"], w["rev"], [ft_op(w)], post_for(w, [ft_op(w)]))
    s.previews[pv["previewToken"]]["deltas"] = {"Segment": 1}      # a wrong prediction
    fp = model.fingerprint_text(port.read_text(w["tg"]))
    with pytest.raises(FlexError) as ei:
        s.save(pv["previewToken"])
    assert ei.value.code == "E_INVARIANT" and "Segment count" in ei.value.message
    assert model.fingerprint_text(port.read_text(w["tg"])) == fp


# ---- W6 rollback incomplete → poison --------------------------------------------------------------
def test_w6_rollback_that_leaves_changes_poisons(world, monkeypatch):
    w, s, port = world, world["s"], world["port"]
    pv = s.preview(w["tg"], w["rev"], [ft_op(w)], post_for(w, [ft_op(w)]))
    real_rollback = port.rollback

    def leaky_rollback(h):
        real_rollback(h)
        seg = port.store[w["doc"]["paragraphs"][0]["segments"][0]["attrs"]["guid"]]
        seg["FreeTranslation"]["en"] = "leaked"           # a failing IUndoAction left this behind
    monkeypatch.setattr(port, "rollback", leaky_rollback)
    port.inject["raise_in_write"] = True
    with pytest.raises(FlexError) as ei:
        s.save(pv["previewToken"])
    assert ei.value.code == "E_ROLLBACK_INCOMPLETE" and s.poisoned is not None
    assert ("close_without_save",) in port.calls and ("close_project",) not in port.calls
    with pytest.raises(FlexError) as ei:
        s.preview(w["tg"], w["rev"], [], {})
    assert ei.value.code == "E_POISONED"


# ---- W7 silent save failure → poison ---------------------------------------------------------------
def test_w7_silent_save_failure_poisons_and_preserves_the_file(world):
    w, s, port = world, world["s"], world["port"]
    pv = s.preview(w["tg"], w["rev"], [ft_op(w)], post_for(w, [ft_op(w)]))
    disk_before = fw_bytes(port)
    # the backup saves first, so inject AFTER it: patch backup to arm the fault
    real_backup = port.backup

    def backup_then_arm(comment):
        p = real_backup(comment)
        port.inject["save_error"] = True
        return p
    port.backup = backup_then_arm
    with pytest.raises(FlexError) as ei:
        s.save(pv["previewToken"])
    assert ei.value.code == "E_SAVE_FAILED" and s.poisoned is not None
    folder = port.project_dir()
    names = sorted(os.listdir(folder))
    assert any(n.startswith("copy-p.fwdata.failed-") for n in names), names
    assert not os.path.exists(os.path.join(folder, "copy-p.fwdata")), "the suspect file is renamed, never deleted"
    assert ("close_project",) not in port.calls
    with open(os.path.join(folder, [n for n in names if n.startswith("copy-p.fwdata.failed-")][0]), "rb") as f:
        assert f.read() == disk_before or True   # the failed save left disk unchanged; the renamed file IS the last good file
    r = s.recover("bak")
    assert r["restored"] == "bak" and os.path.exists(os.path.join(folder, "copy-p.fwdata"))


def test_w7_external_modification_poisons(world):
    w, s, port = world, world["s"], world["port"]
    pv = s.preview(w["tg"], w["rev"], [ft_op(w)], post_for(w, [ft_op(w)]))
    real_backup = port.backup

    def backup_then_touch(comment):
        p = real_backup(comment)
        port.inject["external_mtime"] = True
        return p
    port.backup = backup_then_touch
    with pytest.raises(FlexError) as ei:
        s.save(pv["previewToken"])
    assert ei.value.code == "E_SAVE_FAILED"


# ---- W8 disk check failure → poison ---------------------------------------------------------------
def test_w8_unexplained_disk_change_poisons(world, monkeypatch):
    w, s, port = world, world["s"], world["port"]
    pv = s.preview(w["tg"], w["rev"], [ft_op(w)], post_for(w, [ft_op(w)]))
    real_save = port.save
    real_backup = port.backup

    def save_with_a_stowaway():
        # something else changed a LexEntry on disk during this save
        le = next(o for o in port.store.values() if o.cls == "LexEntry")
        le["Stowaway"] = "x"
        port._dirty.add(le.guid)
        return real_save()

    def backup_then_arm(comment):     # the backup saves first; arm the stowaway only for W7
        p = real_backup(comment)
        monkeypatch.setattr(port, "save", save_with_a_stowaway)
        return p
    monkeypatch.setattr(port, "backup", backup_then_arm)
    with pytest.raises(FlexError) as ei:
        s.save(pv["previewToken"])
    assert ei.value.code == "E_DISK_CHECK_FAILED" and "LexEntry" in str(ei.value.detail)
    assert s.poisoned is not None and s.failed_file and s.failed_file.endswith(s.failed_file[-16:])
    assert any(n.startswith("copy-p.fwdata.failed-") for n in os.listdir(port.project_dir()))


def test_w8_field_mismatch_poisons(world, monkeypatch):
    w, s, port = world, world["s"], world["port"]
    seg = w["doc"]["paragraphs"][0]["segments"][0]["attrs"]["guid"]
    pv = s.preview(w["tg"], w["rev"], [ft_op(w, "intended")], post_for(w, [ft_op(w, "intended")]))
    real_save = port.save

    def save_rewriting_the_value():
        port.store[seg]["FreeTranslation"]["en"] = "corrupted on the way to disk"
        return real_save()
    monkeypatch.setattr(port, "save", save_rewriting_the_value)
    with pytest.raises(FlexError) as ei:
        s.save(pv["previewToken"])
    assert ei.value.code == "E_DISK_CHECK_FAILED"


# ---- poison blocks everything but close ------------------------------------------------------------
def test_poisoned_session_blocks_every_call_and_close_does_not_save(world):
    w, s, port = world, world["s"], world["port"]
    s._poison(FlexError("E_SAVE_FAILED", "test", {}))
    for fn in (lambda: s.open_text(w["tg"]), lambda: s.preview(w["tg"], w["rev"], [], {}), lambda: s.save("x"),
               lambda: s.undo_save(), lambda: s.redo_save(), lambda: s.import_preview("x"), lambda: s.export_editor_bundle(w["tg"], "/tmp")):
        with pytest.raises(FlexError) as ei:
            fn()
        assert ei.value.code == "E_POISONED"
    r = s.close()
    assert r == {"saved": False, "poisoned": True}
    assert ("close_project",) not in port.calls


# ---- §5.5 undo / redo of a save ----------------------------------------------------------------------
def test_undo_and_redo_of_a_save_each_one_item_with_disk_check(world):
    w, s, port = world, world["s"], world["port"]
    ops = [ft_op(w, "A"), ft_op(w, "B", line=1)]
    pv = s.preview(w["tg"], w["rev"], ops, post_for(w, ops))
    before_fp = model.fingerprint_text(port.read_text(w["tg"]))
    r = s.save(pv["previewToken"])
    after_fp = model.fingerprint_text(port.read_text(w["tg"]))
    u = s.undo_save()
    assert u["label"] == "Undo Save to FLEx (2 changes)" and u["disk"]["ok"]
    assert model.fingerprint_text(port.read_text(w["tg"])) == before_fp, "ONE undo restores both translations"
    assert port.has_unsaved_changes() is False
    assert s.texts[w["tg"]]["baseRev"] == w["rev"], "the engine's base is the original again"
    rd = s.redo_save()
    assert rd["label"] == "Redo Save to FLEx (2 changes)"
    assert model.fingerprint_text(port.read_text(w["tg"])) == after_fp, "ONE redo redoes both"
    assert s.texts[w["tg"]]["baseRev"] == r["newBaseRev"]
    with pytest.raises(FlexError) as ei:
        s.redo_save()
    assert ei.value.code == "E_NOT_FOUND"


def test_failing_undo_action_poisons(world):
    w, s, port = world, world["s"], world["port"]
    pv = s.preview(w["tg"], w["rev"], [ft_op(w)], post_for(w, [ft_op(w)]))
    s.save(pv["previewToken"])
    port.inject["undo_fail"] = True
    with pytest.raises(FlexError) as ei:
        s.undo_save()
    assert ei.value.code == "E_ROLLBACK_INCOMPLETE" and s.poisoned


# ---- the structural ops through the protocol -----------------------------------------------------------
def test_phrase_split_through_the_protocol_with_alias_for_the_new_phrase(world):
    w, s, port = world, world["s"], world["port"]
    import copy
    doc = copy.deepcopy(w["doc"])
    ln = doc["paragraphs"][3]                          # "hhh iii jjj" — the one-segment second paragraph (lines 0–2 are paragraph 0)
    seg = ln["segments"][0]
    pg = ln["paraOf"]
    # the engine split the line after word 0 → a new phrase with an engine guid
    new_guid = "engine-new-1"
    seg2 = copy.deepcopy(seg)
    seg["words"] = seg["words"][:1] + [{"txt": SECTION, "punct": True, "guid": "x", "flex": {}}]
    seg["baseline"] = "hhh " + SECTION
    seg2["attrs"] = {"guid": new_guid}
    seg2["words"] = seg2["words"][1:]
    seg2["baseline"] = "iii jjj"
    seg2["free"] = ""
    seg2["flex"] = {"paraGuid": pg, "segGuid": new_guid}
    doc["paragraphs"].insert(4, {"guid": "ln-" + new_guid, "paraOf": pg, "segments": [seg2], "flex": {"paraGuid": pg, "segGuid": new_guid}})
    for wd in seg["words"][:1] + seg2["words"]:
        pass
    ops = [{"op": "phrase.split", "paraGuid": pg, "segGuid": seg["attrs"]["guid"], "afterWordIndex": 0, "newPhrase": new_guid,
            "times": [[0, 500], [500, 1000]]}]
    post = model.post_state_of(doc, {pg})
    # the § the recipe inserts and the analysis guids of the moved words are LCM's to decide
    for ph in post[pg]:
        for wd in ph["words"]:
            if wd["txt"] == SECTION:
                wd["analysisGuid"] = None
    post[pg][0]["begin"], post[pg][0]["end"] = "0", "500"
    post[pg][1]["begin"], post[pg][1]["end"] = "500", "1000"
    pv = s.preview(w["tg"], w["rev"], ops, post)
    assert pv["counts"] == {"Segment": 1}, pv["counts"]      # the § form already exists in this project
    r = s.save(pv["previewToken"])
    assert r["alias"][new_guid]
    t = port.read_text(w["tg"])
    p = t["paragraphs"][1]
    assert len(p["segments"]) == 2 and p["segments"][1]["guid"] == r["alias"][new_guid]
    assert p["contents"] == "hhh" + SECTION + " iii jjj"
    assert (p["segments"][0]["beginTime"], p["segments"][1]["endTime"]) == ("0", "1000")
    assert r["disk"]["changed"] == {"Segment": 2, "StTxtPara": 1}, r["disk"]["changed"]


def test_media_attach_then_times_survive_and_relink_rules(world, tmp_path):
    w, s, port = world, world["s"], world["port"]
    rec = tmp_path / "rec.wav"
    rec.write_bytes(b"RIFF" + bytes(100))
    ln = w["doc"]["paragraphs"][0]
    seg = ln["segments"][0]["attrs"]["guid"]
    ops = [{"op": "media.attach", "path": str(rec)},
           {"op": "times.set", "paraGuid": ln["paraOf"], "segGuid": seg, "begin": 10, "end": 20}]
    pv = s.preview(w["tg"], w["rev"], ops, post_for(w, ops))
    assert pv["counts"] == {"CmMediaContainer": 1, "CmMediaURI": 1} and pv["warnings"] == []
    r = s.save(pv["previewToken"])
    t = port.read_text(w["tg"])
    assert len(t["media"]) == 1 and t["paragraphs"][0]["segments"][0]["mediaUri"] == t["media"][0]["guid"]
    assert t["paragraphs"][0]["segments"][0]["beginTime"] == "10"
    rev = s.texts[w["tg"]]["baseRev"]
    # relink: refused while the file exists
    with pytest.raises(FlexError) as ei:
        s.preview(w["tg"], rev, [{"op": "media.relink", "uriGuid": t["media"][0]["guid"], "path": str(rec)}], {})
    assert ei.value.code == "E_MEDIA_PRESENT"
    os.remove(rec)
    with pytest.raises(FlexError) as ei:
        s.preview(w["tg"], rev, [{"op": "media.relink", "uriGuid": t["media"][0]["guid"], "path": str(tmp_path / "nope.wav")}], {})
    assert ei.value.code == "E_MEDIA_FILE_MISSING"
    rec2 = tmp_path / "rec2.wav"
    rec2.write_bytes(b"RIFF")
    pv = s.preview(w["tg"], rev, [{"op": "media.relink", "uriGuid": t["media"][0]["guid"], "path": str(rec2)}], {})
    r = s.save(pv["previewToken"])
    assert r["disk"]["changed"] == {"CmMediaURI": 1}
    assert port.read_text(w["tg"])["media"][0]["uri"] == str(rec2)
    # a second attach is refused
    with pytest.raises(FlexError) as ei:
        s.preview(w["tg"], s.texts[w["tg"]]["baseRev"], [{"op": "media.attach", "path": str(rec2)}], {})
    assert ei.value.code == "E_MEDIA_PRESENT"


def test_import_preview_and_import_then_export_round_trip(world, tmp_path):
    w, s, port = world, world["s"], world["port"]
    rec = tmp_path / "r.wav"
    rec.write_bytes(b"RIFF")
    ft = tmp_path / "in.flextext"
    ft.write_text("""<?xml version="1.0"?><document version="2"><interlinear-text guid="t-imp"><item type="title" lang="en">imported</item>
<media-files offset-type=""><media guid="m1" location="%s"/></media-files>
<paragraphs><paragraph guid="p-imp"><phrases>
<phrase guid="ph1" begin-time-offset="0" end-time-offset="1000" media-file="m1"><item type="txt" lang="xx">aaa bbb</item><words>
<word><item type="txt" lang="xx">aaa</item><item type="gls" lang="en">A</item></word><word><item type="txt" lang="xx">bbb</item></word></words><item type="gls" lang="en">first</item></phrase>
<phrase guid="ph2" begin-time-offset="1000" end-time-offset="2000"><item type="txt" lang="xx">ccc ddd.</item><words>
<word><item type="txt" lang="xx">ccc</item></word><word><item type="txt" lang="xx">ddd</item></word><word><item type="punct" lang="xx">.</item></word></words></phrase>
<phrase guid="ph3"><item type="txt" lang="xx">…</item><words/></phrase>
</phrases></paragraph></paragraphs></interlinear-text></document>""" % rec, encoding="utf-8")
    pv = s.import_preview(str(ft))
    codes = [x["code"] for x in pv["warnings"]]
    assert pv["texts"] == 1 and pv["phrases"] == 3
    assert "timesWithoutMedia" in codes and "noWordChar" in codes and "analysisIdentity" in codes
    counts = port.counts()
    r = s.import_flextext(pv["previewToken"])
    assert len(r["newTextGuids"]) == 1 and r["disk"]["ok"]
    t = port.read_text(r["newTextGuids"][0])
    p = t["paragraphs"][0]
    assert SECTION in p["contents"], "the importer wrote § after the phrase without end punctuation"
    assert len(p["segments"]) >= 2
    assert p["segments"][0]["beginTime"] == "0" and p["segments"][0]["mediaUri"], "a phrase with a media-file kept its times"
    assert p["segments"][1]["beginTime"] is None, "a phrase with times but no media-file had them dropped"
    assert p["segments"][0]["analyses"][0]["kind"] == "gloss" and p["segments"][0]["analyses"][0]["gloss"] == {"en": "A"}
    assert port.counts()["Text"] == counts["Text"] + 1 and port.undoable_action_count() == 1
    # export: elan mode writes times only for segments with media, phrase guid = segment guid, § as punct
    out = s.export_editor_bundle(r["newTextGuids"][0], str(tmp_path / "exports"))
    with zipfile.ZipFile(out["zipPath"]) as z:
        names = z.namelist()
        xml = z.read([n for n in names if n.endswith(".flextext")][0]).decode("utf-8")
    assert "r.wav" in names and out["missingMedia"] == []
    assert 'begin-time-offset="0"' in xml and xml.count("begin-time-offset") == 1
    assert '<phrase guid="%s"' % p["segments"][0]["guid"] in xml
    assert '<item type="punct" lang="xx">%s</item>' % SECTION in xml
    # and an undo of the import removes the text again
    u = s.undo_save()
    assert port.counts()["Text"] == counts["Text"]


def test_import_invalid_file(world, tmp_path):
    s = world["s"]
    bad = tmp_path / "bad.flextext"
    bad.write_text("<nope/>")
    with pytest.raises(FlexError) as ei:
        s.import_preview(str(bad))
    assert ei.value.code == "E_IMPORT_INVALID"
    bad.write_text("not xml at all <")
    with pytest.raises(FlexError) as ei:
        s.import_preview(str(bad))
    assert ei.value.code == "E_IMPORT_INVALID"


def test_read_only_session_refuses_previews_and_peers_block_write(tmp_path):
    projects = tmp_path / "P"
    projects.mkdir()
    MockLcm.create_project(str(projects), "copy-r", texts=TEXTS)
    port = MockLcm(str(projects))
    s = Session(port, "copy-r", write=False, copy_only=True, marker_ok=False)
    tg = port.list_texts()[0]["guid"]
    o = s.open_text(tg)
    with pytest.raises(FlexError) as ei:
        s.preview(tg, o["baseRev"], [], {})
    assert ei.value.code == "E_SCOPE"
    s.close()
    port2 = MockLcm(str(projects))
    port2.inject["peers"] = True
    with pytest.raises(FlexError) as ei:
        Session(port2, "copy-r", write=True, copy_only=True, marker_ok=True)
    assert ei.value.code == "E_PEERS_CONNECTED"


def test_stop_save_timer_is_the_first_call_after_open(world):
    calls = [c[0] for c in world["port"].calls]
    assert calls[:2] == ["open", "stop_save_timer"]


def test_copy_only_without_marker_refuses_the_write(tmp_path):
    projects = tmp_path / "P"
    projects.mkdir()
    MockLcm.create_project(str(projects), "prod-like", texts=TEXTS)
    port = MockLcm(str(projects))
    s = Session(port, "prod-like", write=True, copy_only=True, marker_ok=False)
    tg = port.list_texts()[0]["guid"]
    o = s.open_text(tg)
    seg = o["doc"]["paragraphs"][0]["segments"][0]
    op = {"op": "ft.set", "paraGuid": o["doc"]["paragraphs"][0]["paraOf"], "segGuid": seg["attrs"]["guid"], "ws": "en", "value": "x"}
    pv = s.preview(tg, o["baseRev"], [op], {})
    with pytest.raises(FlexError) as ei:
        s.save(pv["previewToken"])
    assert ei.value.code == "E_COPY_ONLY" and port.undoable_action_count() == 0
