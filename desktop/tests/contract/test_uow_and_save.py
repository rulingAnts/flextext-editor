"""Plan §5.2 facts, as contract tests: a UOW rolls back on exception; one commit = one undo item;
nested begin discards the outer; Save/backup inside a UOW roll it back; a silent save failure is
only an ERROR log; undo after a save; the auto-save timer; the thread wedge."""
import logging
import os
import threading
import zipfile

import pytest

from flexshell.port import UNDO_SUCCESS
from flexshell.model import fingerprint_text
from .conftest import first_text


class Capture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record)


def para0(b):
    t = b.read_text(first_text(b)["guid"])
    return t["paragraphs"][0]


def test_opening_creates_no_pending_changes(backend):
    assert backend.has_unsaved_changes() is False
    assert backend.depth() == 0 and backend.undo_item_count() == 0


def test_uow_commit_is_one_undo_item_and_rollback_restores_everything(backend):
    b = backend
    tg = first_text(b)["guid"]
    before = fingerprint_text(b.read_text(tg))
    counts = b.counts()
    p = para0(b)
    h = b.begin_uow("Undo X", "Redo X")
    b.set_free_translation(p["segments"][0]["guid"], "en", "a free translation")
    b.set_segment_times(p["segments"][0]["guid"], 100, 900)
    b.set_contents(p["guid"], p["contents"] + " zzz")
    assert b.depth() == 1
    b.rollback(h)
    assert b.depth() == 0
    assert fingerprint_text(b.read_text(tg)) == before, "rollback restores the fingerprint"
    assert b.counts() == counts and b.undo_item_count() == 0
    h = b.begin_uow("Undo Y", "Redo Y")
    b.set_free_translation(p["segments"][0]["guid"], "en", "kept")
    b.commit(h)
    assert b.undo_item_count() == 1 and b.last_undo_text() == "Undo Y"
    assert b.read_text(tg)["paragraphs"][0]["segments"][0]["ft"] == {"en": "kept"}


def test_exception_inside_lcm_rolls_back(backend):
    b = backend
    tg = first_text(b)["guid"]
    before = fingerprint_text(b.read_text(tg))
    p = para0(b)
    h = b.begin_uow("u", "r")
    b.set_free_translation(p["segments"][0]["guid"], "en", "x")
    if hasattr(b, "inject"):
        b.inject["raise_in_write"] = True
        with pytest.raises(RuntimeError):
            b.set_segment_times(p["segments"][0]["guid"], 1, 2)
    b.rollback(h)
    assert fingerprint_text(b.read_text(tg)) == before


# Raw LCM [verified, plan §5.2]: a nested BeginUndoTask, a Save or a BackupProject inside an open unit of work
# throws AND throws the open work away (the outer Dispose then throws too). The port refuses all three at
# CurrentDepth > 0 BEFORE LCM sees them, so the open unit of work stays as it was and can still be committed or
# rolled back by its owner. The VM conformance run (2026-10-21) found the mock modelling raw LCM instead.

def _open_with_one_edit(b):
    tg = first_text(b)["guid"]
    before = fingerprint_text(b.read_text(tg))
    p = para0(b)
    h = b.begin_uow("outer", "outer")
    b.set_free_translation(p["segments"][0]["guid"], "en", "outer edit")
    return tg, before, h, fingerprint_text(b.read_text(tg))


def test_nested_begin_is_refused_and_the_outer_stays_open(backend):
    b = backend
    tg, before, h, during = _open_with_one_edit(b)
    with pytest.raises(RuntimeError, match="Nested"):
        b.begin_uow("inner", "inner")
    assert b.depth() == 1 and fingerprint_text(b.read_text(tg)) == during, "the outer UOW is untouched"
    b.rollback(h)
    assert b.depth() == 0 and fingerprint_text(b.read_text(tg)) == before


def test_save_inside_uow_is_refused_and_the_uow_stays_open(backend):
    b = backend
    tg, before, h, during = _open_with_one_edit(b)
    with pytest.raises(RuntimeError, match="Commit at wrong place"):
        b.save()
    assert b.depth() == 1 and fingerprint_text(b.read_text(tg)) == during
    b.commit(h)
    assert b.depth() == 0 and b.undo_item_count() == 1


def test_backup_inside_uow_is_refused_and_the_uow_stays_open(backend):
    b = backend
    tg, before, h, during = _open_with_one_edit(b)
    with pytest.raises(RuntimeError):
        b.backup("inside")
    assert b.depth() == 1 and fingerprint_text(b.read_text(tg)) == during
    b.rollback(h)
    assert b.depth() == 0 and fingerprint_text(b.read_text(tg)) == before


def test_close_without_save_with_a_uow_open_releases_the_project_and_writes_nothing(backend):
    """A session closed while a unit of work is still open (a poisoned save that never got as far as its rollback)
    must still dispose: on real LCM, Dispose with the undo stack's lock held threw SynchronizationLockException
    (VM, 2026-10-21) and left the project held by a cache nobody could close. The open work is thrown away in
    memory first; nothing reaches the disk, and the project opens again."""
    b = backend
    fw = b.fwdata_path()
    with open(fw, "rb") as f:
        on_disk = f.read()
    _open_with_one_edit(b)
    name = b.project_name()
    b.close_without_save()
    with open(fw, "rb") as f:
        assert f.read() == on_disk
    b.open(name, write=True)
    b.stop_save_timer()
    assert b.depth() == 0 and b.has_unsaved_changes() is False


def test_backup_at_depth_0_writes_a_verifiable_zip(backend):
    b = backend
    path = b.backup("FlexText Segmenter before save")
    assert os.path.isfile(path) and path.endswith(".fwbackup")
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None
        names = z.namelist()
        assert any(n.endswith(".fwdata") for n in names)
        data = z.read([n for n in names if n.endswith(".fwdata")][0])
        assert b"<languageproject" in data


def test_save_writes_tmp_bak_fwdata_and_undo_after_save_is_a_net_empty_diff(backend):
    b = backend
    tg = first_text(b)["guid"]
    p = para0(b)
    fw = b.fwdata_path()
    base = fw[:-len(".fwdata")]
    with open(fw, "rb") as f:
        original = f.read()
    h = b.begin_uow("u", "r")
    b.set_free_translation(p["segments"][0]["guid"], "en", "saved once")
    b.commit(h)
    assert b.has_unsaved_changes() is True
    assert b.save() is not False
    # LCM writes on its own commit thread: read the disk only after it is done, as protocol W7 does. Without this
    # the real run (VM, 2026-10-21) read the FIRST save's file after the second save and saw its edit still there.
    b.complete_all_commits()
    assert b.has_unsaved_changes() is False
    assert not os.path.exists(base + ".tmp") and os.path.exists(base + ".bak")
    with open(base + ".bak", "rb") as f:
        assert f.read() == original, ".bak is exactly the pre-save file"
    assert b.undo() == UNDO_SUCCESS
    assert b.read_text(tg)["paragraphs"][0]["segments"][0]["ft"] == {}
    b.save()
    b.complete_all_commits()
    with open(fw, "rb") as f:
        after = f.read()
    # net-empty apart from DateModified stamps
    strip = lambda s: b"".join(line for line in s.splitlines() if b"DateModified" not in line)  # noqa: E731
    assert strip(after) == strip(original)


def test_silent_save_failure_is_only_an_error_log_and_drops_the_edit(backend):
    b = backend
    if not hasattr(b, "inject"):
        pytest.skip("fault injection is a mock facility; on the VM this is V-3/V-5 territory")
    tg = first_text(b)["guid"]
    p = para0(b)
    cap = Capture()
    b.subscribe_log(cap)
    fw = b.fwdata_path()
    with open(fw, "rb") as f:
        before = f.read()
    h = b.begin_uow("u", "r")
    b.set_free_translation(p["segments"][0]["guid"], "en", "lost edit")
    b.commit(h)
    b.inject["save_error"] = True
    r = b.save()                                  # no exception
    assert r is False
    assert b.has_unsaved_changes() is False, "HasUnsavedChanges lies"
    assert any(x.levelno >= logging.ERROR for x in cap.records), "the only signal is an ERROR record"
    with open(fw, "rb") as f:
        assert f.read() == before, "disk unchanged"
    assert os.path.exists(fw[:-len(".fwdata")] + ".tmp"), ".tmp left behind"
    # the next successful save drops the failed edit
    h = b.begin_uow("u2", "r2")
    b.set_free_translation(p["segments"][1]["guid"], "en", "newer edit")
    b.commit(h)
    assert b.save() is True
    b2 = type(b)(b.projects_dir)
    b2.open(b.project_name(), write=False)
    segs = b2.read_text(tg)["paragraphs"][0]["segments"]
    assert segs[1]["ft"] == {"en": "newer edit"} and segs[0]["ft"] == {}, "the failed edit never reached disk"


def test_timer_saves_until_stopped(backend):
    b = backend
    if not hasattr(b, "timer_tick"):
        pytest.skip("timer modelling is a mock facility (V-2 on the VM)")
    b._timer_running = True
    p = para0(b)
    h = b.begin_uow("u", "r")
    b.set_free_translation(p["segments"][0]["guid"], "en", "x")
    b.commit(h)
    assert b.timer_tick() is True and b.has_unsaved_changes() is False
    b.stop_save_timer()
    h = b.begin_uow("u", "r")
    b.set_free_translation(p["segments"][0]["guid"], "en", "y")
    b.commit(h)
    assert b.timer_tick() is False and b.has_unsaved_changes() is True


def test_dispose_on_another_thread_wedges_the_session(backend):
    b = backend
    if not hasattr(b, "inject"):
        pytest.skip("deliberately not run against real LCM: it would wedge the copy's session")
    p = para0(b)
    h = b.begin_uow("u", "r")
    b.set_free_translation(p["segments"][0]["guid"], "en", "x")
    err = []

    def other():
        try:
            b.commit(h)
        except Exception as e:   # noqa: BLE001
            err.append(type(e).__name__)
    t = threading.Thread(target=other)
    t.start()
    t.join()
    assert err == ["LockRecursionException"]
    with pytest.raises(Exception, match="LockRecursion|lock"):
        b.begin_uow("after", "after")
    with pytest.raises(Exception, match="NullReference|wedged"):
        b.save()


def test_close_project_saves_even_after_an_exception_so_the_shell_never_calls_it_when_poisoned(backend):
    b = backend
    if not hasattr(b, "inject"):
        pytest.skip("mock-only demonstration of flexicon's CloseProject hazard")
    tg = first_text(b)["guid"]
    p = para0(b)
    h = b.begin_uow("u", "r")
    b.set_free_translation(p["segments"][0]["guid"], "en", "half done")
    b.commit(h)
    b.close_project()
    b2 = type(b)(b.projects_dir)
    b2.open(b.project_name(), write=False)
    assert b2.read_text(tg)["paragraphs"][0]["segments"][0]["ft"] == {"en": "half done"}


def test_close_without_save_leaves_disk_untouched(backend):
    b = backend
    tg = first_text(b)["guid"]
    p = para0(b)
    fw = b.fwdata_path()
    mtime = os.stat(fw).st_mtime_ns
    with open(fw, "rb") as f:
        before = f.read()
    h = b.begin_uow("u", "r")
    b.set_free_translation(p["segments"][0]["guid"], "en", "never saved")
    b.commit(h)
    b.close_without_save()
    assert os.stat(fw).st_mtime_ns == mtime
    with open(fw, "rb") as f:
        assert f.read() == before
