"""Copy-only builds — lifted 2026-10-18 (Seth: the team project is to be written, through teamwrite.py's
checklist and snapshot). The stamp is now the LOCK-DOWN: exactly {"copyOnly": true} makes a build copy-only
again; anything else, the old lift stamp included, means writable."""
import json

import pytest

from flexshell import copyonly
from flexshell.errors import FlexError


def test_no_stamp_means_writable(tmp_path):
    assert copyonly.is_copy_only(None) is False
    assert copyonly.is_copy_only(str(tmp_path)) is False


@pytest.mark.parametrize("content", ['{"copyOnly": "true"}', '{"copyOnly": 1}', 'true', '{"copyOnly": true, "x": 1}', 'not json', '{}',
                                     '{"copyOnlyLifted": true}'])
def test_anything_but_the_exact_lock_down_stamp_is_writable(tmp_path, content):
    (tmp_path / copyonly.STAMP_FILE).write_text(content, encoding="utf-8")
    assert copyonly.is_copy_only(str(tmp_path)) is False


def test_the_exact_lock_down_stamp_makes_it_copy_only(tmp_path):
    (tmp_path / copyonly.STAMP_FILE).write_text(json.dumps({"copyOnly": True}), encoding="utf-8")
    assert copyonly.is_copy_only(str(tmp_path)) is True


def test_marker_file_allows_a_copy(tmp_path):
    proj = tmp_path / "Proj-copy"
    proj.mkdir()
    with pytest.raises(FlexError) as ei:
        copyonly.check_write_allowed(str(proj), "Proj-copy", copy_only=True)
    assert ei.value.code == "E_COPY_ONLY"
    (proj / copyonly.MARKER_FILE).write_text("disposable", encoding="utf-8")
    copyonly.check_write_allowed(str(proj), "Proj-copy", copy_only=True)   # no raise


def test_protected_name_beats_the_marker(tmp_path):
    proj = tmp_path / "Prod"
    proj.mkdir()
    (proj / copyonly.MARKER_FILE).write_text("x", encoding="utf-8")
    assert copyonly.project_is_disposable_copy(str(proj), "Prod", protected={"Prod"}) is False


def test_release_build_writes_anywhere(tmp_path):
    copyonly.check_write_allowed(str(tmp_path), "Any", copy_only=False)


# ---- Make a copy to write to (plan §12.3) ----------------------------------------------------------------
def _project(root, name):
    p = root / name
    (p / "LinkedFiles" / "AudioVisual").mkdir(parents=True)
    (p / (name + ".fwdata")).write_text("<languageproject/>", encoding="utf-8")
    (p / (name + ".bak")).write_text("the save before last", encoding="utf-8")
    (p / "LinkedFiles" / "AudioVisual" / "rec.wav").write_bytes(b"RIFF" + b"\0" * 60)
    (p / "WritingSystemStore").mkdir()
    (p / "WritingSystemStore" / "xx.ldml").write_text("<ldml/>", encoding="utf-8")
    # Send/Receive: the team's repository, the LIFT bridge's, Chorus's notes — and a lock nobody holds
    (p / ".hg" / "store").mkdir(parents=True)
    (p / ".hg" / "store" / "data").write_text("history", encoding="utf-8")
    (p / ".hgignore").write_text("*.lock", encoding="utf-8")
    (p / "OtherRepositories" / "x_LIFT" / ".hg").mkdir(parents=True)
    (p / (name + ".fwdata.ChorusNotes")).write_text("<notes/>", encoding="utf-8")
    (p / (name + ".fwdata.lock")).write_text("{}", encoding="utf-8")
    return p


def test_a_copy_to_write_to_leaves_send_receive_behind_and_the_original_untouched(tmp_path):
    src = _project(tmp_path, "Proj")
    before = sorted((str(f.relative_to(src)), f.read_bytes()) for f in src.rglob("*") if f.is_file())
    plan = copyonly.copy_plan(str(tmp_path), "Proj")
    assert plan["name"] == "Proj - copy for writing" and plan["files"] == 3 and plan["bytes"] > 64
    seen = []
    r = copyonly.make_disposable_copy(str(tmp_path), "Proj", plan["name"], progress=seen.append, today="2026-10-16")
    assert r == {"name": "Proj - copy for writing"}
    dst = tmp_path / "Proj - copy for writing"
    got = sorted(str(f.relative_to(dst)).replace("\\", "/") for f in dst.rglob("*") if f.is_file())
    assert got == ["LinkedFiles/AudioVisual/rec.wav", "Proj - copy for writing.fwdata", "WritingSystemStore/xx.ldml",
                   copyonly.MARKER_FILE], "renamed to match its folder; no repository, no notes, no lock, no .bak"
    assert copyonly.project_is_disposable_copy(str(dst), "Proj - copy for writing")
    assert "Send/Receive" in (dst / copyonly.MARKER_FILE).read_text(encoding="utf-8")
    assert seen[-1] == {"i": 3, "n": 3}
    assert sorted((str(f.relative_to(src)), f.read_bytes()) for f in src.rglob("*") if f.is_file()) == before, "the original is only read"
    assert copyonly.copy_name(str(tmp_path), "Proj") == "Proj - copy for writing 2", "the next copy takes the next name"


def test_a_copy_cut_short_leaves_nothing_that_looks_like_a_project(tmp_path, monkeypatch):
    _project(tmp_path, "Proj")
    calls = []

    def copy2(a, b):
        calls.append(a)
        if len(calls) == 2:
            raise OSError("disk went away")
        return shutil_copy2(a, b)
    import shutil
    shutil_copy2 = shutil.copy2
    monkeypatch.setattr(copyonly.shutil, "copy2", copy2)
    with pytest.raises(OSError):
        copyonly.make_disposable_copy(str(tmp_path), "Proj", "Proj - copy for writing")
    assert sorted(p.name for p in tmp_path.iterdir()) == ["Proj"], "no copy, and no half of one"


def test_a_copy_needs_room(tmp_path, monkeypatch):
    _project(tmp_path, "Proj")
    import collections
    monkeypatch.setattr(copyonly.shutil, "disk_usage", lambda p: collections.namedtuple("U", "total used free")(1, 1, 10))
    with pytest.raises(FlexError) as ei:
        copyonly.make_disposable_copy(str(tmp_path), "Proj", "Proj - copy for writing")
    assert ei.value.code == "E_DISK_SPACE"
