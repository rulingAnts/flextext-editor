"""Writing to the team's project (teamwrite.py; Seth, 2026-10-18): the snapshot of the .fwdata taken before a
write session, what RECOVER does with it, and what it refuses. Synthetic folders; the api-level flow runs the
real bridge over the mock FLEx."""
import json
import os
import time

import pytest

from flexshell import teamwrite
from flexshell.errors import FlexError


def project(root, name, body=b"<languageproject version=\"7000072\"/>", hg=True):
    p = root / name
    p.mkdir(parents=True)
    (p / (name + ".fwdata")).write_bytes(body)
    if hg:
        (p / ".hg" / "store").mkdir(parents=True)
        (p / ".hg" / "store" / "00changelog.i").write_bytes(b"c" * 40)
        (p / ".hg" / "dirstate").write_bytes(b"d" * 10)
    return p


def touch_hg(p, when=None):
    """A Send/Receive: the store's files change."""
    f = p / ".hg" / "store" / "00changelog.i"
    f.write_bytes(f.read_bytes() + b"cc")
    if when:
        os.utime(f, (when, when))


def test_send_receive_info_reads_the_store(tmp_path):
    p = project(tmp_path, "team")
    t = time.time() - 300
    touch_hg(p, t)
    info = teamwrite.send_receive_info(str(p))
    assert info["present"] is True and abs(info["lastActivity"] / 1000 - time.time()) < 400
    q = project(tmp_path, "alone", hg=False)
    assert teamwrite.send_receive_info(str(q)) == {"present": False, "lastActivity": None, "tip": None, "log": []}


def fake_hg(tmp_path, lines):
    """An `hg` that prints a log as Chorus's Mercurial would for our template."""
    hg = tmp_path / "bin" / "hg"
    hg.parent.mkdir(exist_ok=True)
    hg.write_text("#!/bin/sh\nif [ \"$3\" = log ]; then printf '" + "".join(l + "\\n" for l in lines) + "'; fi\n", encoding="utf-8")
    hg.chmod(0o755)
    return str(hg)


def test_the_send_receive_log_is_recorded_with_a_snapshot_and_its_tip_detects_a_send_receive(tmp_path):
    """Seth, 2026-10-18: "if our app can keep track of mercurial/Chorus edit commits/dates/times/IDs, that might help
    us have helpful data to report to FLEx support". Recorded with every snapshot; and the tip changing is a
    Send/Receive even if the store's files kept their sizes and times."""
    p = project(tmp_path, "team")
    hg1 = fake_hg(tmp_path, ["aaaa1111\t2026-10-18 09:00:00 +0700\tsomeone\t[FLEx] Send/Receive", "bbbb2222\t2026-10-17 18:00:00 +0700\tsomeone\tolder"])
    log = teamwrite.hg_log(str(p), hg=hg1)
    assert [e["id"] for e in log] == ["aaaa1111", "bbbb2222"] and log[0]["date"].startswith("2026-10-18") and log[0]["desc"] == "[FLEx] Send/Receive"
    assert teamwrite.hg_log(str(tmp_path / "nowhere"), hg=hg1) == [], "not a repository: no log, no error"
    assert teamwrite.hg_log(str(p), hg="/no/such/hg") == []
    state = tmp_path / "state"
    import flexshell.teamwrite as tw
    orig = tw.find_hg
    tw.find_hg = lambda code_dir=None: hg1
    try:
        m = teamwrite.take_snapshot(str(state), str(p), "team")
        assert m["hg"]["tip"] == "aaaa1111" and len(m["hgLog"]) == 2
        (p / "team.fwdata").write_bytes(b"written")
        teamwrite.note_write(str(state), "team", m["id"], str(p), "save")
        assert teamwrite.recover_plan(str(state), str(p), "team", "free")["refusal"] is None
        # a Send/Receive that moved the tip without touching the files we watch
        tw.find_hg = lambda code_dir=None: fake_hg(tmp_path, ["cccc3333\t2026-10-18 10:00:00 +0700\tsomeone\tnewer", "aaaa1111\t2026-10-18 09:00:00 +0700\tsomeone\t[FLEx] Send/Receive"])
        plan = teamwrite.recover_plan(str(state), str(p), "team", "free")
        assert plan["hgChanged"] and plan["refusal"] == "E_RECOVER_SENT_RECEIVED" and plan["hgLog"][0]["id"] == "cccc3333"
    finally:
        tw.find_hg = orig


def test_every_write_has_its_own_snapshot_and_an_earlier_one_can_be_chosen(tmp_path):
    """A second save of a text must not cost the first its way back (Seth, 2026-10-18, #4)."""
    p = project(tmp_path, "team", body=b"v0")
    state = tmp_path / "state"
    s0 = teamwrite.take_snapshot(str(state), str(p), "team", now=1_800_000_000)
    (p / "team.fwdata").write_bytes(b"v1")
    teamwrite.note_write(str(state), "team", s0["id"], str(p), "save")
    s1 = teamwrite.take_snapshot(str(state), str(p), "team", now=1_800_000_100)   # before the second write: the file as v1
    (p / "team.fwdata").write_bytes(b"v2")
    teamwrite.note_write(str(state), "team", s1["id"], str(p), "save")
    plan = teamwrite.recover_plan(str(state), str(p), "team", "free")
    assert [x["id"] for x in plan["snapshots"]] == [s1["id"], s0["id"]] and plan["snapshot"]["id"] == s1["id"], "newest first, the newest by default"
    plan0 = teamwrite.recover_plan(str(state), str(p), "team", "free", snapshot_id=s0["id"])
    assert plan0["snapshot"]["id"] == s0["id"] and plan0["refusal"] is None
    assert teamwrite.recover(str(state), str(p), "team", s1["id"], "free")["restored"] and (p / "team.fwdata").read_bytes() == b"v1", "the last write undone"
    assert teamwrite.recover(str(state), str(p), "team", s0["id"], "free")["restored"] and (p / "team.fwdata").read_bytes() == b"v0", "both undone"


def test_a_snapshot_is_the_file_verified_and_kept_outside_the_project(tmp_path):
    p = project(tmp_path, "team", body=b"x" * 5000)
    state = tmp_path / "state"
    m = teamwrite.take_snapshot(str(state), str(p), "team")
    assert m["project"] == "team" and m["fwdata"]["size"] == 5000 and m["hg"]["present"] and m["saves"] == []
    snap = os.path.join(m["dir"], "team.fwdata")
    assert os.path.isfile(snap) and teamwrite.sha256(snap) == m["fwdata"]["sha256"]
    assert not str(snap).startswith(str(p)), "never inside the project folder: Send/Receive and FLEx's backups walk it"
    assert not [x for x in p.iterdir() if "snapshot" in x.name.lower()]
    latest = teamwrite.latest_snapshot(str(state), "team")
    assert latest["id"] == m["id"]
    assert teamwrite.summary(latest) == {"id": m["id"], "takenAt": m["takenAt"], "saves": 0, "lastSaveAt": None, "bytes": 5000}
    assert "dir" not in teamwrite.summary(latest), "the page never learns a path"


def test_only_the_newest_snapshots_are_kept(tmp_path):
    p = project(tmp_path, "team")
    state = tmp_path / "state"
    ids = []
    for k in range(teamwrite.KEEP + 2):
        ids.append(teamwrite.take_snapshot(str(state), str(p), "team", now=1_800_000_000 + k * 100)["id"])
    kept = [m["id"] for m in teamwrite.list_snapshots(str(state), "team")]
    assert kept == ids[::-1][:teamwrite.KEEP]


def test_recover_puts_the_file_back_and_sets_the_current_one_aside(tmp_path):
    p = project(tmp_path, "team", body=b"before")
    state = tmp_path / "state"
    m = teamwrite.take_snapshot(str(state), str(p), "team")
    fw = p / "team.fwdata"
    fw.write_bytes(b"written by the shell")
    teamwrite.note_write(str(state), "team", m["id"], str(p), "save", "t1")
    plan = teamwrite.recover_plan(str(state), str(p), "team", "free")
    assert plan["refusal"] is None and plan["warnings"] == [] and plan["snapshot"]["saves"] == 1 and not plan["hgChanged"]
    r = teamwrite.recover(str(state), str(p), "team", m["id"], "free")
    assert r["restored"] is True and fw.read_bytes() == b"before"
    aside = tmp_path / "team" / os.path.basename(r["setAside"])
    assert aside.is_file() and aside.read_bytes() == b"written by the shell" and ".before-recover-" in aside.name
    again = teamwrite.recover_plan(str(state), str(p), "team", "free")
    assert again["alreadyThere"] and again["refusal"] == "E_NO_SNAPSHOT"
    assert teamwrite.recover(str(state), str(p), "team", m["id"], "free") == {"restored": False, "alreadyThere": True, "snapshot": m["id"]}


def test_recover_refuses_after_a_send_receive_and_while_flex_holds_the_project(tmp_path):
    """The written data has gone to the team: an old file put back would make the next Send/Receive revert
    the team's changes too. Refused, never asked."""
    p = project(tmp_path, "team", body=b"before")
    state = tmp_path / "state"
    m = teamwrite.take_snapshot(str(state), str(p), "team")
    (p / "team.fwdata").write_bytes(b"written")
    teamwrite.note_write(str(state), "team", m["id"], str(p), "save")
    assert teamwrite.recover_plan(str(state), str(p), "team", "flex")["refusal"] == "E_FLEX_HOLDS_PROJECT"
    with pytest.raises(FlexError) as ei:
        teamwrite.recover(str(state), str(p), "team", m["id"], "flex")
    assert ei.value.code == "E_FLEX_HOLDS_PROJECT"
    touch_hg(p)
    plan = teamwrite.recover_plan(str(state), str(p), "team", "free")
    assert plan["hgChanged"] and plan["refusal"] == "E_RECOVER_SENT_RECEIVED"
    with pytest.raises(FlexError) as ei:
        teamwrite.recover(str(state), str(p), "team", m["id"], "free")
    assert ei.value.code == "E_RECOVER_SENT_RECEIVED"
    assert (p / "team.fwdata").read_bytes() == b"written", "nothing touched"
    q = project(tmp_path, "alone", body=b"before", hg=False)
    m2 = teamwrite.take_snapshot(str(state), str(q), "alone")
    (q / "alone.fwdata").write_bytes(b"written")
    assert teamwrite.recover_plan(str(state), str(q), "alone", "free")["refusal"] is None, "no Send/Receive, nothing to have gone anywhere"
    assert teamwrite.recover(str(state), str(q), "alone", m2["id"], "free")["restored"]


def test_recover_warns_about_flex_edits_since_the_last_write_here(tmp_path):
    p = project(tmp_path, "team", body=b"before")
    state = tmp_path / "state"
    m = teamwrite.take_snapshot(str(state), str(p), "team")
    (p / "team.fwdata").write_bytes(b"written")
    teamwrite.note_write(str(state), "team", m["id"], str(p), "save")
    (p / "team.fwdata").write_bytes(b"written, then edited in FLEx")
    plan = teamwrite.recover_plan(str(state), str(p), "team", "free")
    assert plan["refusal"] is None and plan["fwdataChangedSinceWrite"] and plan["warnings"] == ["fwdataChangedSinceWrite"]
    p2 = project(tmp_path, "team2", body=b"before")
    m2 = teamwrite.take_snapshot(str(state), str(p2), "team2")
    (p2 / "team2.fwdata").write_bytes(b"edited in FLEx only")
    plan2 = teamwrite.recover_plan(str(state), str(p2), "team2", "free")
    assert plan2["warnings"] == ["nothingWrittenHere"], "no write of this shell to undo: only FLEx's own changes would go"
    assert teamwrite.recover_plan(str(state), str(p), "nope", "free")["refusal"] == "E_NO_SNAPSHOT"
    with pytest.raises(FlexError) as ei:
        teamwrite.recover(str(state), str(p), "team", "no-such-id", "free")
    assert ei.value.code == "E_NO_SNAPSHOT"


def test_a_damaged_snapshot_never_replaces_the_file(tmp_path):
    p = project(tmp_path, "team", body=b"before")
    state = tmp_path / "state"
    m = teamwrite.take_snapshot(str(state), str(p), "team")
    (p / "team.fwdata").write_bytes(b"written")
    with open(os.path.join(m["dir"], "team.fwdata"), "ab") as f:
        f.write(b"rot")
    with pytest.raises(FlexError) as ei:
        teamwrite.recover(str(state), str(p), "team", m["id"], "free")
    assert ei.value.code == "E_BACKUP_FAILED"
    assert (p / "team.fwdata").read_bytes() == b"written" and not [x for x in p.iterdir() if "before-recover" in x.name]


def test_a_snapshot_that_does_not_match_the_file_is_refused_and_leaves_nothing(tmp_path, monkeypatch):
    p = project(tmp_path, "team", body=b"before")
    state = tmp_path / "state"
    real = teamwrite.sha256
    calls = {"n": 0}

    def flaky(path):          # the file moves under the copy
        calls["n"] += 1
        return real(path) if calls["n"] != 2 else "0" * 64
    monkeypatch.setattr(teamwrite, "sha256", flaky)
    with pytest.raises(FlexError) as ei:
        teamwrite.take_snapshot(str(state), str(p), "team")
    assert ei.value.code == "E_BACKUP_FAILED"
    assert teamwrite.list_snapshots(str(state), "team") == []


# ---- through the bridge: the real Api over the mock FLEx ------------------------------------------------------
from flexshell import model                                       # noqa: E402
from flexshell.api import Api                                      # noqa: E402
from flexshell.lcm_mock import MockBackendFactory, MockLcm         # noqa: E402

TEXTS = [{"title": "team text", "paragraphs": ["aaa bbb ccc.", "ddd eee"]}]


def ok(r):
    assert r["ok"] is True, r
    return r["result"]


def err(r):
    assert r["ok"] is False, r
    return r["error"]


def wait(api, job):
    for _ in range(300):
        st = ok(api.job_status(job["jobId"]))
        if st["state"] in ("done", "error"):
            return st
        time.sleep(0.01)
    raise AssertionError("job did not finish")


@pytest.fixture
def api(tmp_path):
    projects = tmp_path / "Projects"
    projects.mkdir()
    folder = MockLcm.create_project(str(projects), "team", texts=TEXTS)
    (projects / "team" / ".hg" / "store").mkdir(parents=True)
    (projects / "team" / ".hg" / "store" / "00changelog.i").write_bytes(b"c" * 40)
    engine = tmp_path / "engine"
    (engine / "js").mkdir(parents=True)
    (engine / "index.html").write_text("<!doctype html>")
    (engine / "js" / "i18n.js").write_text("export const ENGINE_VERSION = 'v999';")
    a = Api(MockBackendFactory(str(projects)), engine_root=str(engine), state_dir=str(tmp_path / "state"))
    a._folder = folder
    yield a
    a._worker.stop()


def save_a_translation(api, value):
    tx = ok(api.list_texts())[0]
    o = ok(api.open_text(tx["guid"]))
    ln = o["doc"]["paragraphs"][0]
    seg = ln["segments"][0]
    seg["free"], seg["freeLang"] = value, "en"
    op = {"op": "ft.set", "paraGuid": ln["paraOf"], "segGuid": seg["attrs"]["guid"], "ws": "en", "value": value}
    pv = ok(api.preview_save(tx["guid"], o["baseRev"], [op], model.post_state_of(o["doc"], {ln["paraOf"]})))
    st = wait(api, ok(api.save_to_flex(pv["previewToken"])))
    assert st["state"] == "done", st
    return tx["guid"]


def test_the_team_project_write_session_snapshot_save_close_recover(api, tmp_path):
    plan = ok(api.write_plan("team"))
    assert plan["team"] and plan["writableWithChecklist"] and plan["sendReceive"]["present"] and plan["snapshot"] is None and plan["fwdataBytes"] > 0
    fw = tmp_path / "Projects" / "team" / "team.fwdata"
    before = fw.read_bytes()
    r = ok(api.open_project("team", "write", {"sentReceived": True, "appsClosed": True}))
    assert r["team"] and r["snapshot"]["saves"] == 0
    assert err(api.recover_plan("team"))["code"] == "E_ALREADY_OPEN", "never while the project is open here"
    tg = save_a_translation(api, "one")
    assert fw.read_bytes() != before
    listed = {p["name"]: p for p in ok(api.list_projects())}
    assert listed["team"]["snapshot"]["saves"] == 1, "the save is in the snapshot's record"
    ok(api.close_project())
    plan = ok(api.recover_plan("team"))
    assert plan["refusal"] is None and plan["warnings"] == [] and plan["snapshot"]["saves"] == 1
    r = ok(api.recover_snapshot("team", plan["snapshot"]["id"]))
    assert r["restored"] and fw.read_bytes() == before, "FLEx's file is the one from before the write session"
    aside = [x for x in (tmp_path / "Projects" / "team").iterdir() if ".before-recover-" in x.name]
    assert len(aside) == 1 and aside[0].read_bytes() != before, "what was there is set aside, never deleted"
    # the project opens again, with the translation gone
    ok(api.open_project("team", "read"))
    o = ok(api.open_text(tg))
    assert o["doc"]["paragraphs"][0]["segments"][0]["free"] == ""
    ok(api.close_project())
    assert ok(api.recover_plan("team"))["alreadyThere"]


def test_two_saves_two_snapshots_through_the_bridge(api, tmp_path):
    fw = tmp_path / "Projects" / "team" / "team.fwdata"
    v0 = fw.read_bytes()
    r = ok(api.open_project("team", "write", {"sentReceived": True, "appsClosed": True}))
    first = r["snapshot"]["id"]
    tx = ok(api.list_texts())[0]
    def save(value):
        o = ok(api.open_text(tx["guid"]))
        ln = o["doc"]["paragraphs"][0]
        seg = ln["segments"][0]
        seg["free"], seg["freeLang"] = value, "en"
        op = {"op": "ft.set", "paraGuid": ln["paraOf"], "segGuid": seg["attrs"]["guid"], "ws": "en", "value": value}
        pv = ok(api.preview_save(tx["guid"], o["baseRev"], [op], model.post_state_of(o["doc"], {ln["paraOf"]})))
        st = wait(api, ok(api.save_to_flex(pv["previewToken"])))
        assert st["state"] == "done", st
        return st["result"]
    r1 = save("one")
    assert r1["snapshot"]["id"] == first, "the file was unchanged since the open: the open's snapshot serves the first save"
    v1 = fw.read_bytes()
    r2 = save("two")
    assert r2["snapshot"]["id"] != first and r2["snapshot"]["saves"] == 1, "the file changed: the second save gets a snapshot of its own"
    ok(api.close_project())
    plan = ok(api.recover_plan("team"))
    assert [x["id"] for x in plan["snapshots"]] == [r2["snapshot"]["id"], first]
    assert ok(api.recover_snapshot("team", r2["snapshot"]["id"]))["restored"] and fw.read_bytes() == v1
    assert ok(api.recover_snapshot("team", first))["restored"] and fw.read_bytes() == v0
    assert ok(api.recover_plan("team", first))["alreadyThere"]


def test_a_send_receive_after_the_write_blocks_recover_through_the_bridge(api, tmp_path):
    ok(api.open_project("team", "write", {"sentReceived": True, "appsClosed": True}))
    save_a_translation(api, "one")
    ok(api.close_project())
    f = tmp_path / "Projects" / "team" / ".hg" / "store" / "00changelog.i"
    f.write_bytes(f.read_bytes() + b"cc")
    plan = ok(api.recover_plan("team"))
    assert plan["refusal"] == "E_RECOVER_SENT_RECEIVED"
    assert err(api.recover_snapshot("team", plan["snapshot"]["id"]))["code"] == "E_RECOVER_SENT_RECEIVED"
    lock = tmp_path / "Projects" / "team" / "team.fwdata.lock"
    lock.write_text(json.dumps({"PID": os.getpid(), "ProcessName": "FieldWorks"}), encoding="utf-8")
    assert err(api.recover_snapshot("team", plan["snapshot"]["id"]))["code"] in ("E_FLEX_HOLDS_PROJECT", "E_RECOVER_SENT_RECEIVED")


def test_a_marked_copy_needs_no_checklist_and_takes_no_snapshot(api, tmp_path):
    projects = tmp_path / "Projects"
    MockLcm.create_project(str(projects), "copy-t", texts=TEXTS)
    (projects / "copy-t" / "flextext-disposable-copy.txt").write_text("x")
    r = ok(api.open_project("copy-t", "write"))
    assert r["writable"] and r["team"] is False and r["snapshot"] is None
    ok(api.close_project())
    assert ok(api.recover_plan("copy-t"))["refusal"] == "E_NO_SNAPSHOT"
