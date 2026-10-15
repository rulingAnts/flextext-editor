"""W8 — the disk read-back on synthetic .fwdata pairs (plan §5.4): self-closing rt, a length-changing
edit, tail handling, unexplained changes, ownership chains, count deltas, the file facts."""
import os

from flexshell import diskcheck as dc
from flexshell.lcm_mock import MockLcm, Obj


def write(path, objs, version=7000072):
    with open(path, "w", encoding="utf-8") as f:
        f.write(MockLcm.render_fwdata({o.guid: o for o in objs}, version))


def base_objects():
    lp = Obj("LangProject", guid="00000000-0000-0000-0000-000000000001", DateModified="2026-01-01")
    text = Obj("Text", owner=lp.guid, guid="00000000-0000-0000-0000-000000000002", Name={"en": "t"}, DateModified="x")
    st = Obj("StText", owner=text.guid, guid="00000000-0000-0000-0000-000000000003", Paragraphs=["00000000-0000-0000-0000-000000000004"], DateModified="x")
    para = Obj("StTxtPara", owner=st.guid, guid="00000000-0000-0000-0000-000000000004", Contents="aaa bbb.", Segments=["00000000-0000-0000-0000-000000000005"])
    seg = Obj("Segment", owner=para.guid, guid="00000000-0000-0000-0000-000000000005", BeginOffset=0, EndOffset=8, FreeTranslation={})
    le = Obj("LexEntry", owner=lp.guid, guid="00000000-0000-0000-0000-000000000006")     # self-closing rt
    return [lp, text, st, para, seg, le]


def test_self_closing_rt_is_seen_and_unchanged_files_diff_empty(tmp_path):
    a, b = str(tmp_path / "p.bak"), str(tmp_path / "p.fwdata")
    objs = base_objects()
    write(a, objs)
    write(b, objs)
    with open(b) as f:
        assert '<rt class="LexEntry" guid="00000000-0000-0000-0000-000000000006" ownerguid="00000000-0000-0000-0000-000000000001"/>' in f.read()
    d = dc.diff_rt(a, b)
    assert d["oldCount"] == 6 and d["newCount"] == 6 and not d["added"] and not d["removed"] and not d["changed"]
    assert d["headerVersion"] == 7000072


def test_length_changing_edit_is_located_exactly(tmp_path):
    a, b = str(tmp_path / "p.bak"), str(tmp_path / "p.fwdata")
    objs = base_objects()
    write(a, objs)
    seg = objs[4]
    seg["FreeTranslation"] = {"en": "a much longer free translation than before, shifting every later byte"}
    objs[0]["DateModified"] = "2026-02-02"
    write(b, objs)
    d = dc.diff_rt(a, b)
    assert set(d["changed"]) == {seg.guid, objs[0].guid}
    assert d["changed"][seg.guid][1]["fields"]["FreeTranslation"] == {"en": "a much longer free translation than before, shifting every later byte"}
    allowed = {"classes": {"Segment"}, "touchedOwners": {objs[1].guid}, "expect": {seg.guid: {"FreeTranslation": {"en": "a much longer free translation than before, shifting every later byte"}}}}
    assert dc.check(d, allowed, dc.load_rt(b)) == []


def test_tail_whitespace_does_not_count_as_a_change(tmp_path):
    a, b = str(tmp_path / "p.bak"), str(tmp_path / "p.fwdata")
    objs = base_objects()
    write(a, objs)
    with open(a) as f:
        txt = f.read()
    with open(b, "w") as f:
        f.write(txt.replace("</rt>\n", "</rt>\n\n   \n"))   # different inter-element whitespace only
    d = dc.diff_rt(a, b)
    assert not d["changed"] and not d["added"] and not d["removed"]


def test_unexplained_change_is_reported(tmp_path):
    a, b = str(tmp_path / "p.bak"), str(tmp_path / "p.fwdata")
    objs = base_objects()
    write(a, objs)
    objs[5]["LexemeForm"] = "sneaky"
    objs[4]["FreeTranslation"] = {"en": "ok"}
    write(b, objs)
    d = dc.diff_rt(a, b)
    problems = dc.check(d, {"classes": {"Segment"}, "touchedOwners": {objs[1].guid}}, dc.load_rt(b))
    assert [p["cls"] for p in problems] == ["LexEntry"] and "not allowed" in problems[0]["why"]


def test_ownership_chain_outside_touched_text(tmp_path):
    a, b = str(tmp_path / "p.bak"), str(tmp_path / "p.fwdata")
    objs = base_objects()
    other_text = Obj("Text", owner=objs[0].guid, guid="00000000-0000-0000-0000-000000000007", Name={"en": "u"}, DateModified="x")
    other_st = Obj("StText", owner=other_text.guid, guid="00000000-0000-0000-0000-000000000008", Paragraphs=[], DateModified="x")
    other_para = Obj("StTxtPara", owner=other_st.guid, guid="00000000-0000-0000-0000-000000000009", Contents="zzz", Segments=[])
    objs += [other_text, other_st, other_para]
    write(a, objs)
    other_para["Contents"] = "zzz changed"
    write(b, objs)
    d = dc.diff_rt(a, b)
    problems = dc.check(d, {"classes": {"StTxtPara", "Segment"}, "touchedOwners": {objs[1].guid}}, dc.load_rt(b))
    assert len(problems) == 1 and problems[0]["why"] == "outside every touched text"
    assert dc.check(d, {"classes": {"StTxtPara", "Segment"}, "touchedOwners": {other_text.guid}}, dc.load_rt(b)) == []


def test_added_and_removed_with_count_deltas(tmp_path):
    a, b = str(tmp_path / "p.bak"), str(tmp_path / "p.fwdata")
    objs = base_objects()
    write(a, objs)
    new_seg = Obj("Segment", owner=objs[3].guid, guid="00000000-0000-0000-0000-00000000000a", BeginOffset=8, EndOffset=12, FreeTranslation={})
    pf = Obj("PunctuationForm", owner=objs[0].guid, guid="00000000-0000-0000-0000-00000000000b", Form="\u00a7")
    write(b, objs + [new_seg, pf])
    d = dc.diff_rt(a, b)
    allowed = {"classes": {"Segment", "PunctuationForm", "StTxtPara"}, "touchedOwners": {objs[1].guid},
               "referencedFrom": {pf.guid}, "countDeltas": {"Segment": 1, "PunctuationForm": 1}}
    assert dc.check(d, allowed, dc.load_rt(b)) == []
    allowed["countDeltas"] = {"Segment": 1}
    probs = dc.check(d, allowed, dc.load_rt(b))
    assert any("PunctuationForm" in str(p) and "preview said 0" in p["why"] for p in probs)
    write(b, objs[:4] + objs[5:])     # the segment removed
    d = dc.diff_rt(a, b)
    probs = dc.check(d, {"classes": {"Segment"}, "touchedOwners": {objs[1].guid}, "countDeltas": {"Segment": -1}}, dc.load_rt(b))
    assert probs == []


def test_date_only_changes_on_text_sttext_langproject_are_free(tmp_path):
    a, b = str(tmp_path / "p.bak"), str(tmp_path / "p.fwdata")
    objs = base_objects()
    write(a, objs)
    for o in objs[:3]:
        o["DateModified"] = "later"
    write(b, objs)
    d = dc.diff_rt(a, b)
    assert len(d["changed"]) == 3
    assert dc.check(d, {"classes": set()}, dc.load_rt(b)) == []
    objs[1]["Name"] = {"en": "renamed"}
    write(b, objs)
    d = dc.diff_rt(a, b)
    assert dc.check(d, {"classes": set()}, dc.load_rt(b))[0]["cls"] == "Text"


def test_field_expectation_mismatch(tmp_path):
    a, b = str(tmp_path / "p.bak"), str(tmp_path / "p.fwdata")
    objs = base_objects()
    write(a, objs)
    objs[4]["BeginTimeOffset"] = "1234"
    write(b, objs)
    d = dc.diff_rt(a, b)
    probs = dc.check(d, {"classes": {"Segment"}, "touchedOwners": {objs[1].guid}, "expect": {objs[4].guid: {"BeginTimeOffset": "1000"}}}, dc.load_rt(b))
    assert probs and "expected '1000'" in probs[0]["why"]


def test_files_after_save(tmp_path):
    fw = tmp_path / "p.fwdata"
    fw.write_text("x")
    before = os.stat(fw).st_mtime_ns
    (tmp_path / "p.tmp").write_text("partial")
    r = dc.files_after_save(str(fw), before)
    assert r["tmpGone"] is False and r["mtimeChanged"] is False
    os.remove(tmp_path / "p.tmp")
    (tmp_path / "p.bak").write_text("old")
    fw.write_text("xy")
    os.utime(fw, ns=(before + 10**9, before + 10**9))
    r = dc.files_after_save(str(fw), before)
    assert r == {"tmpGone": True, "mtimeChanged": True, "bakExists": True}


def test_real_mock_save_pair_round_trips_through_the_validator(tmp_path):
    projects = tmp_path / "P"
    projects.mkdir()
    MockLcm.create_project(str(projects), "copy-d", texts=[{"title": "t", "paragraphs": ["aaa bbb ccc. ddd eee \u00a7 fff."]}])
    b = MockLcm(str(projects))
    b.open("copy-d", write=True)
    tg = b.list_texts()[0]["guid"]
    seg = b.read_text(tg)["paragraphs"][0]["segments"][0]
    h = b.begin_uow("u", "r")
    b.set_free_translation(seg["guid"], "en", "written by the test, long enough to change the file length")
    b.commit(h)
    b.save()
    fw = b.fwdata_path()
    d = dc.diff_rt(fw[:-7] + ".bak", fw)
    allowed = {"classes": {"Segment"}, "touchedOwners": {tg}, "expect": {seg["guid"]: {"FreeTranslation": {"en": "written by the test, long enough to change the file length"}}}}
    assert dc.check(d, allowed, dc.load_rt(fw)) == []


def test_a_new_section_form_nothing_references_is_explained_only_when_the_preview_allowed_it():
    """A paragraph join writes a § only for the phrase join to delete it: FLEx's new § PunctuationForm is
    then referenced by no segment. That one form, and only when the preview counted it, is explained."""
    def added(form):
        return {"added": {"pf": {"cls": "PunctuationForm", "owner": None, "fields": {"Form": form}, "hash": "h"}}, "removed": {}, "changed": {}}
    allowed = {"classes": {"PunctuationForm"}, "touchedOwners": {"text"}, "countDeltas": {"PunctuationForm": 1}}
    assert dc.check(added("§"), dict(allowed, newPunctForms={"§"})) == []
    assert [p["why"] for p in dc.check(added("§"), allowed)] == ["new object outside every touched text"]
    assert [p["why"] for p in dc.check(added(","), dict(allowed, newPunctForms={"§"}))] == ["new object outside every touched text"]


def test_a_multilingual_field_is_expected_per_writing_system(tmp_path):
    """A phrase translated in two analysis writing systems: an ft.set in one names that one only. The
    old joined form ("English|Indonesian") failed the check and POISONED a save that had succeeded."""
    a, b = str(tmp_path / "p.bak"), str(tmp_path / "p.fwdata")
    objs = base_objects()
    seg = objs[4]
    seg["FreeTranslation"] = {"en": "kept", "id": "lama"}
    write(a, objs)
    seg["FreeTranslation"] = {"en": "kept", "id": "baru"}
    write(b, objs)
    d = dc.diff_rt(a, b)
    allowed = {"classes": {"Segment"}, "touchedOwners": {objs[1].guid}}
    rt = dc.load_rt(b)
    assert dc.check(d, dict(allowed, expect={seg.guid: {"FreeTranslation": {"id": "baru"}}}), rt) == []
    assert [p["why"][:24] for p in dc.check(d, dict(allowed, expect={seg.guid: {"FreeTranslation": {"id": "other"}}}), rt)] == ["field FreeTranslation is"]
