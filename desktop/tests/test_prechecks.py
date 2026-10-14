"""B — prechecks on synthetic folders (plan §5.3): lock JSON variants, an unreadable lock, a stale
PID, sharing on/off, crashed-save leftovers, the version header, disk space, cloud folders."""
import json
import os
import stat

import pytest

from flexshell import prechecks as pc
from flexshell.errors import FlexError
from flexshell.lcm_mock import MockLcm, MODEL_VERSION


@pytest.fixture
def proj(tmp_path):
    projects = tmp_path / "Projects"
    projects.mkdir()
    folder = MockLcm.create_project(str(projects), "copy-x", texts=[{"title": "t", "paragraphs": ["aaa bbb."]}])
    return folder


def lock(folder, name, pid, pname="FieldWorks"):
    with open(os.path.join(folder, name + ".fwdata.lock"), "w", encoding="utf-8") as f:
        json.dump({"__type": "SimpleFileLock", "PID": pid, "ProcessName": pname, "Timestamp": 638000000000000000}, f)


def test_clean_copy_is_writable(proj):
    r = pc.check_project(proj, "copy-x", MODEL_VERSION, drive_type=lambda p: 3, free=lambda p: 10**12)
    assert r["writable"] and r["reasons"] == [] and r["lock"] == "free" and not r["sharing"]
    assert r["headerVersion"] == MODEL_VERSION and r["readable"]
    pc.require_write(r)


def test_lock_held_by_fieldworks(proj):
    lock(proj, "copy-x", 4242, "FieldWorks")
    state, info = pc.read_lock(proj, "copy-x", pid_alive=lambda p: p == 4242)
    assert state == "flex" and info["PID"] == 4242
    r = pc.check_project(proj, "copy-x", MODEL_VERSION, pid_alive=lambda p: True, drive_type=lambda p: 3, free=lambda p: 10**12)
    assert "E_FLEX_HOLDS_PROJECT" in r["reasons"] and not r["readable"]
    with pytest.raises(FlexError) as ei:
        pc.require_write(r)
    assert ei.value.code == "E_FLEX_HOLDS_PROJECT" and "Close FLEx" in ei.value.message


def test_lock_held_by_another_process_and_stale(proj):
    lock(proj, "copy-x", 777, "python")
    assert pc.read_lock(proj, "copy-x", pid_alive=lambda p: True)[0] == "other"
    assert pc.read_lock(proj, "copy-x", pid_alive=lambda p: False)[0] == "stale"
    r = pc.check_project(proj, "copy-x", MODEL_VERSION, pid_alive=lambda p: False, drive_type=lambda p: 3, free=lambda p: 10**12)
    assert r["writable"] and r["lock"] == "stale", "a stale lock is taken over by LCM [source; V-8]"


def test_lock_process_name_from_pid_when_json_lacks_it(proj):
    with open(os.path.join(proj, "copy-x.fwdata.lock"), "w") as f:
        json.dump({"PID": 5}, f)
    assert pc.read_lock(proj, "copy-x", pid_alive=lambda p: True, process_name=lambda p: "FieldWorks.exe")[0] == "flex"
    assert pc.read_lock(proj, "copy-x", pid_alive=lambda p: True, process_name=lambda p: "notepad")[0] == "other"


def test_lock_garbage_json(proj):
    with open(os.path.join(proj, "copy-x.fwdata.lock"), "w") as f:
        f.write("not json")
    state, info = pc.read_lock(proj, "copy-x")
    assert state == "stale" and "raw" in info


@pytest.mark.skipif(os.name == "nt" or os.geteuid() == 0, reason="permission bits are not enforced for root / on Windows")
def test_unreadable_lock_is_busy(proj):
    lock(proj, "copy-x", 1)
    p = os.path.join(proj, "copy-x.fwdata.lock")
    os.chmod(p, 0)
    try:
        assert pc.read_lock(proj, "copy-x")[0] == "busy"
    finally:
        os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)


def test_sharing_on_blocks_write_but_not_read(tmp_path):
    projects = tmp_path / "P"
    projects.mkdir()
    folder = MockLcm.create_project(str(projects), "shared", texts=[], sharing=True)
    assert pc.sharing_on(folder)
    r = pc.check_project(folder, "shared", MODEL_VERSION, drive_type=lambda p: 3, free=lambda p: 10**12)
    assert r["reasons"] == ["E_SHARING_ON"] and r["readable"]
    pc.require_read(r)
    with pytest.raises(FlexError) as ei:
        pc.require_write(r)
    assert ei.value.code == "E_SHARING_ON" and "Project Properties" in ei.value.message


def test_sharing_file_without_the_flag_is_off(proj):
    ss = os.path.join(proj, "SharedSettings")
    os.makedirs(ss)
    with open(os.path.join(ss, "LexiconSettings.plsx"), "w") as f:
        f.write('<ProjectLexiconSettings projectSharing="false"/>')
    assert not pc.sharing_on(proj)


def test_crashed_save_states(proj):
    open(os.path.join(proj, "copy-x.tmp"), "w").close()
    r = pc.check_project(proj, "copy-x", MODEL_VERSION, drive_type=lambda p: 3, free=lambda p: 10**12)
    assert "E_CRASHED_SAVE_STATE" in r["reasons"] and not r["readable"]
    os.remove(os.path.join(proj, "copy-x.tmp"))
    os.rename(os.path.join(proj, "copy-x.fwdata"), os.path.join(proj, "copy-x.bak"))
    r = pc.check_project(proj, "copy-x", MODEL_VERSION, drive_type=lambda p: 3, free=lambda p: 10**12)
    assert r["reasons"] == ["E_CRASHED_SAVE_STATE"], "a .bak without a .fwdata is a crashed save, never auto-repaired"


def test_missing_fwdata(tmp_path):
    (tmp_path / "empty").mkdir()
    r = pc.check_project(str(tmp_path / "empty"), "empty", MODEL_VERSION, drive_type=lambda p: 3)
    assert r["reasons"] == ["E_NOT_FOUND"] and not r["readable"]


def test_model_version_newer_and_older(proj):
    r = pc.check_project(proj, "copy-x", MODEL_VERSION - 1, drive_type=lambda p: 3, free=lambda p: 10**12)
    assert "E_MODEL_NEWER" in r["reasons"] and not r["readable"]
    r = pc.check_project(proj, "copy-x", MODEL_VERSION + 1, drive_type=lambda p: 3, free=lambda p: 10**12)
    assert "E_MODEL_OLDER" in r["reasons"] and not r["readable"]


def test_header_version_reads_only_the_head(proj):
    assert pc.header_version(os.path.join(proj, "copy-x.fwdata")) == MODEL_VERSION
    assert pc.header_version(os.path.join(proj, "nope.fwdata")) is None


def test_disk_space_and_drives_and_cloud(proj):
    size = os.path.getsize(os.path.join(proj, "copy-x.fwdata"))
    r = pc.check_project(proj, "copy-x", MODEL_VERSION, drive_type=lambda p: 3, free=lambda p: size * 2)
    assert r["reasons"] == ["E_DISK_SPACE"]
    r = pc.check_project(proj, "copy-x", MODEL_VERSION, drive_type=lambda p: 4, free=lambda p: 10**12)   # DRIVE_REMOTE
    assert r["reasons"] == ["E_NOT_LOCAL_DISK"]
    assert pc.on_cloud_folder(r"C:\Users\x\OneDrive\Projects\y")
    assert pc.on_cloud_folder("/Users/x/Library/Mobile Documents/iCloud~Projects")
    assert pc.on_cloud_folder(r"\\Mac\Home\Documents\FLEx")
    assert not pc.on_cloud_folder(r"C:\ProgramData\SIL\FieldWorks\Projects\y")


def test_readonly_file(proj):
    p = os.path.join(proj, "copy-x.fwdata")
    os.chmod(p, stat.S_IRUSR)
    try:
        r = pc.check_project(proj, "copy-x", MODEL_VERSION, drive_type=lambda p: 3, free=lambda p: 10**12)
        if os.geteuid() != 0:
            assert "E_READONLY_FILE" in r["reasons"]
    finally:
        os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)


def test_copy_only_reason(proj):
    r = pc.check_project(proj, "copy-x", MODEL_VERSION, drive_type=lambda p: 3, free=lambda p: 10**12, copy_only=True, marker_ok=False)
    assert r["reasons"] == ["E_COPY_ONLY"]
    r = pc.check_project(proj, "copy-x", MODEL_VERSION, drive_type=lambda p: 3, free=lambda p: 10**12, copy_only=True, marker_ok=True)
    assert r["writable"]


def test_every_reason_has_a_message():
    for code in ("E_FLEX_HOLDS_PROJECT", "E_LOCKED_OTHER", "E_LOCK_BUSY", "E_SHARING_ON", "E_CRASHED_SAVE_STATE",
                 "E_READONLY_FILE", "E_NOT_LOCAL_DISK", "E_CLOUD_FOLDER", "E_MODEL_NEWER", "E_MODEL_OLDER", "E_DISK_SPACE"):
        assert code in pc.MESSAGES
