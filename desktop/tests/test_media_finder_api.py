"""The shell's media finder through the bridge (plan §8.4): a FLEx text whose recording link points
nowhere on this machine gets its recording from the project's own folders, a remembered choice, or
the native dialog — in a READ-ONLY session, with nothing written to FLEx. Made-up paths only."""
import os
import pathlib
import time
import wave
import zipfile

import pytest

from flexshell.api import Api
from flexshell.lcm_mock import MockBackendFactory, MockLcm

OLD_LINK = "C:\\Old Machine\\Recordings\\Session-01.wav"     # a path from another machine
PARAS = ["aaa bbb ccc.", "ddd eee."]


def wav(path, seconds=0.5, rate=8000):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(seconds * rate))
    return str(path)


def ok(r):
    assert r["ok"] is True, r
    return r["result"]


def err(r):
    assert r["ok"] is False, r
    return r["error"]


class Picker:
    """Stands in for the native dialog: returns `answer`, records the folder it was opened in."""
    def __init__(self):
        self.answer = None
        self.opened_in = []

    def __call__(self, kind, start_dir=""):
        self.opened_in.append((kind, start_dir))
        return self.answer


@pytest.fixture
def env(tmp_path):
    projects = tmp_path / "Projects"
    projects.mkdir()
    present = wav(tmp_path / "elsewhere" / "present.wav")
    texts = [{"title": "missing link", "paragraphs": PARAS, "media": [OLD_LINK]},
             {"title": "file uri link", "paragraphs": PARAS, "media": [pathlib.Path(present).as_uri()]},
             {"title": "no link", "paragraphs": PARAS}]
    MockLcm.create_project(str(projects), "media-proj", texts=texts)
    MockLcm.create_project(str(projects), "media-copy", texts=texts)
    # FLEx's default home for recordings: <project>\LinkedFiles\AudioVisual — the name differs in case only
    in_lf = wav(projects / "media-proj" / "LinkedFiles" / "AudioVisual" / "session-01.WAV")
    picker = Picker()
    engine = tmp_path / "engine"
    (engine / "js").mkdir(parents=True)
    (engine / "index.html").write_text("<!doctype html>")
    (engine / "js" / "i18n.js").write_text("export const ENGINE_VERSION = 'v999';")
    api = Api(MockBackendFactory(str(projects)), engine_root=str(engine), pick_file_fn=picker,
              state_dir=str(tmp_path / "state"), export_dir=str(tmp_path / "exports"))
    yield {"api": api, "picker": picker, "tmp": tmp_path, "in_lf": in_lf, "present": present, "projects": projects}
    api._worker.stop()


def texts_by_title(api):
    return {t["title"]: t for t in ok(api.list_texts())}


def test_a_read_only_session_finds_the_recording_in_linked_files(env):
    api = env["api"]
    assert ok(api.hello())["capabilities"]["mediaFinder"] is True
    assert ok(api.open_project("media-proj", "read"))["writable"] is False
    t = texts_by_title(api)["missing link"]
    assert t["media"][0]["exists"] is False
    found = ok(api.find_media(t["guid"]))
    link = found["links"][0]
    assert link["exists"] is False and link["url"] is None and link["name"] == "Session-01.wav"
    assert [c["path"] for c in link["candidates"]] == [env["in_lf"]], "same name, case-insensitive, in LinkedFiles"
    assert link["candidates"][0]["remembered"] is False and link["candidates"][0]["size"] > 44
    assert found["startDir"].endswith(os.path.join("LinkedFiles", "AudioVisual"))
    used = ok(api.use_media(t["guid"], link["uriGuid"], env["in_lf"]))
    assert used["url"].startswith("/media/") and api._media.lookup(used["url"][len("/media/"):]) == env["in_lf"]
    assert used["linkName"] == "Session-01.wav" and used["linkExists"] is False
    assert os.path.isfile(env["tmp"] / "state" / "media-map.json"), "the choice is remembered on this machine"
    # nothing was written to FLEx: the link is still the old one, and the project is unchanged on disk
    assert texts_by_title(api)["missing link"]["media"][0]["exists"] is False
    assert api._worker.run("probe", lambda j: api._session.port.has_unsaved_changes()) is False


def test_use_media_accepts_only_what_the_shell_offered(env):
    api = env["api"]
    ok(api.open_project("media-proj", "read"))
    t = texts_by_title(api)["missing link"]
    e = err(api.use_media(t["guid"], t["media"][0]["guid"], env["present"]))
    assert e["code"] == "E_SCOPE", "an existing audio file the shell never offered is refused"
    assert err(api.use_media(t["guid"], t["media"][0]["guid"], None))["code"] == "E_SCOPE"


def test_choose_media_validates_what_the_dialog_returns(env):
    api, picker = env["api"], env["picker"]
    ok(api.open_project("media-proj", "read"))
    t = texts_by_title(api)["missing link"]
    ug = t["media"][0]["guid"]
    picker.answer = None
    assert ok(api.choose_media(t["guid"], ug)) == {"path": None}, "cancelled"
    assert picker.opened_in[-1] == ("media", os.path.join(str(env["projects"]), "media-proj", "LinkedFiles", "AudioVisual"))
    notes = env["tmp"] / "notes.txt"
    notes.write_text("x")
    picker.answer = str(notes)
    assert err(api.choose_media(t["guid"], ug))["code"] == "E_MEDIA_NOT_AUDIO"
    picker.answer = str(env["tmp"] / "gone.wav")
    assert err(api.choose_media(t["guid"], ug))["code"] == "E_MEDIA_FILE_MISSING"
    picker.answer = env["present"]
    r = ok(api.choose_media(t["guid"], ug))
    assert r["path"] == env["present"] and r["name"] == "present.wav" and "url" not in r, "a pick is an offer, not adopted"
    assert not os.path.exists(env["tmp"] / "state" / "media-map.json"), "nothing remembered before the user accepts it"
    picker.answer = None
    ok(api.choose_media(t["guid"], ug))
    assert picker.opened_in[-1][1].endswith(os.path.join("LinkedFiles", "AudioVisual")), "a turned-down pick moves nothing"
    used = ok(api.use_media(t["guid"], ug, r["path"]))
    assert used["url"].startswith("/media/") and used["path"] == env["present"]
    ok(api.choose_media(t["guid"], ug))
    assert picker.opened_in[-1][1] == os.path.dirname(env["present"]), "the dialog now opens where the last recording was found"
    assert err(api.choose_media(t["guid"], "no-such-link"))["code"] == "E_NOT_FOUND"


def test_a_text_with_no_link_can_still_get_a_recording(env):
    api, picker = env["api"], env["picker"]
    ok(api.open_project("media-proj", "read"))
    t = texts_by_title(api)["no link"]
    assert ok(api.find_media(t["guid"]))["links"] == []
    picker.answer = env["present"]
    r = ok(api.choose_media(t["guid"], None))
    u = ok(api.use_media(t["guid"], None, r["path"]))
    assert u["uriGuid"] is None and u["linkName"] == "" and u["url"].startswith("/media/")


def test_a_choice_is_offered_first_next_time_even_in_a_copy_of_the_project(env):
    api, picker = env["api"], env["picker"]
    ok(api.open_project("media-proj", "read"))
    t = texts_by_title(api)["missing link"]
    picker.answer = env["present"]                     # the user picked a different file than the search found
    pick = ok(api.choose_media(t["guid"], t["media"][0]["guid"]))
    ok(api.use_media(t["guid"], t["media"][0]["guid"], pick["path"]))
    ok(api.close_project())
    ok(api.open_project("media-copy", "read"))         # same link, another project (a disposable copy)
    t2 = texts_by_title(api)["missing link"]
    cands = ok(api.find_media(t2["guid"]))["links"][0]["candidates"]
    assert cands[0]["path"] == env["present"] and cands[0]["remembered"] is True
    assert ok(api.use_media(t2["guid"], t2["media"][0]["guid"], cands[0]["path"]))["path"] == env["present"]


def test_forget_media_drops_the_remembered_choice_so_the_next_open_asks_again(env):
    """A reset that forgets the recording (plan §8.4): the remembered file is no longer offered as
    remembered, in this project or a copy, and nothing in FLEx or on disk changes."""
    api, picker = env["api"], env["picker"]
    ok(api.open_project("media-proj", "read"))
    t = texts_by_title(api)["missing link"]
    picker.answer = env["present"]
    pick = ok(api.choose_media(t["guid"], t["media"][0]["guid"]))
    ok(api.use_media(t["guid"], t["media"][0]["guid"], pick["path"]))
    assert ok(api.find_media(t["guid"]))["links"][0]["candidates"][0]["remembered"] is True
    assert ok(api.forget_media(t["guid"])) == {"forgot": 1}
    cands = ok(api.find_media(t["guid"]))["links"][0]["candidates"]
    assert not any(c["remembered"] for c in cands), "offered again only as something the search found"
    assert os.path.isfile(env["present"]), "the file itself is untouched"
    assert ok(api.forget_media(t["guid"])) == {"forgot": 0}, "nothing left to forget"
    assert ok(api.forget_media(texts_by_title(api)["no link"]["guid"])) == {"forgot": 0}, "a text with no link: nothing remembered"
    ok(api.close_project())
    ok(api.open_project("media-copy", "read"))
    t2 = texts_by_title(api)["missing link"]
    assert not any(c["remembered"] for c in ok(api.find_media(t2["guid"]))["links"][0]["candidates"]), \
        "a link from another machine is one recording whatever project carries it: the copy forgot it too"


def test_a_file_uri_link_that_exists_is_served_without_asking(env):
    api = env["api"]
    ok(api.open_project("media-proj", "read"))
    t = texts_by_title(api)["file uri link"]
    assert t["media"][0]["exists"] is True, "file:/// links are read as FLEx reads them"
    doc = ok(api.open_text(t["guid"]))["doc"]
    url = doc["flex"]["media"][0]["url"]
    assert url and api._media.lookup(url[len("/media/"):]) == env["present"]
    link = ok(api.find_media(t["guid"]))["links"][0]
    assert link["exists"] is True and link["candidates"] == []


def test_closing_the_project_forgets_the_offers(env):
    api = env["api"]
    ok(api.open_project("media-proj", "read"))
    t = texts_by_title(api)["missing link"]
    ok(api.find_media(t["guid"]))
    ok(api.close_project())
    ok(api.open_project("media-proj", "read"))
    t = texts_by_title(api)["missing link"]
    assert err(api.use_media(t["guid"], t["media"][0]["guid"], env["in_lf"]))["code"] == "E_SCOPE"


def test_the_export_bundle_carries_the_recording_the_app_uses(env):
    api = env["api"]
    ok(api.open_project("media-proj", "read"))
    t = texts_by_title(api)["missing link"]
    ok(api.open_text(t["guid"]))
    link = ok(api.find_media(t["guid"]))["links"][0]
    ok(api.use_media(t["guid"], link["uriGuid"], env["in_lf"]))
    job = ok(api.export_editor_bundle(t["guid"]))
    for _ in range(500):
        st = ok(api.job_status(job["jobId"]))
        if st["state"] in ("done", "error"):
            break
        time.sleep(0.01)
    assert st["state"] == "done", st
    names = zipfile.ZipFile(st["result"]["zipPath"]).namelist()
    assert "session-01.WAV" in names and "MISSING-AUDIO.txt" not in names, names


def test_the_native_dialog_uses_filedialog_open_not_the_deprecated_constant(env, monkeypatch):
    """pywebview 6 warns on every use of OPEN_DIALOG (seen on the VM, 2026-10-15): FileDialog.OPEN."""
    import sys
    import types
    fake = types.ModuleType("webview")

    class FileDialog:
        OPEN = 10

    fake.FileDialog = FileDialog

    def deprecated(name):
        raise AssertionError("deprecated pywebview constant used: " + name)
    fake.__getattr__ = deprecated
    monkeypatch.setitem(sys.modules, "webview", fake)
    seen = {}

    class Window:
        def create_file_dialog(self, dialog_type, directory="", allow_multiple=False, file_types=()):
            seen.update(kind=dialog_type, directory=directory, types=file_types)
            return (env["present"],)
    api = Api(MockBackendFactory(str(env["projects"])), engine_root=str(env["tmp"] / "engine"), state_dir=str(env["tmp"] / "state2"))
    try:
        api._set_window(Window())
        ok(api.open_project("media-proj", "read"))
        t = texts_by_title(api)["missing link"]
        r = ok(api.choose_media(t["guid"], t["media"][0]["guid"]))
        assert r["path"] == env["present"]
        assert seen["kind"] == 10 and seen["types"][0].startswith("Audio files (")
        assert seen["directory"].endswith(os.path.join("LinkedFiles", "AudioVisual"))
    finally:
        api._worker.stop()
