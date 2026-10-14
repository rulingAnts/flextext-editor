"""mediafind (plan §8.4): resolving a FLEx media link the way FLEx does, the bounded search for a
recording whose link points nowhere here, and the memory of what the user chose. Made-up paths only."""
import json
import os
import pathlib

import pytest

from flexshell import mediafind as mf


# ---- resolving a link -------------------------------------------------------------------------------

@pytest.mark.parametrize("uri, want", [
    ("file:///C:/Recordings/My%20Session.wav", "C:\\Recordings\\My Session.wav"),   # FLEx reads links as URIs
    ("file://C:/Recordings/a.wav", "C:\\Recordings\\a.wav"),                        # a common malformation
    ("file://localhost/C:/Recordings/a.wav", "C:\\Recordings\\a.wav"),
    ("file://fileserver/share/rec/a.wav", "\\\\fileserver\\share\\rec\\a.wav"),     # UNC
    ("file:///home/someone/rec/a.wav", "/home/someone/rec/a.wav"),
    ("C:\\Recordings\\a.wav", "C:\\Recordings\\a.wav"),                             # plain absolute: as is
    ("\\\\fileserver\\share\\a.wav", "\\\\fileserver\\share\\a.wav"),
    ("/Users/someone/a.wav", "/Users/someone/a.wav"),
    ("http://example.org/a.wav", None),                                             # not a local file
    ("", None), ("   ", None), (None, None),
])
def test_link_path_absolute_and_uri_forms(uri, want):
    assert mf.link_path(uri, "/lf") == want


def test_relative_and_lf_links_resolve_under_linked_files():
    lf = os.path.join("x", "LinkedFiles")
    assert mf.link_path("%lf%\\AudioVisual\\a.wav", lf) == os.path.join(lf, "AudioVisual", "a.wav")
    assert mf.link_path("%LF%/AudioVisual/a.wav", lf) == os.path.join(lf, "AudioVisual", "a.wav")
    assert mf.link_path("AudioVisual\\a.wav", lf) == os.path.join(lf, "AudioVisual", "a.wav")
    assert mf.link_path("a.wav", lf) == os.path.join(lf, "a.wav")
    assert mf.link_path("..\\..\\a.wav", lf) is None, "a link never climbs out of LinkedFiles"
    assert mf.link_path("AudioVisual\\a.wav", None) is None, "no LinkedFiles folder known: nothing to resolve against"


@pytest.mark.parametrize("uri, name", [
    ("file:///C:/Recordings/My%20Session.wav", "My Session.wav"),
    ("C:\\Recordings\\Sub\\a.WAV", "a.WAV"),
    ("/Users/someone/b.mp3", "b.mp3"),
    ("%lf%\\AudioVisual\\c.wav", "c.wav"),
    ("http://example.org/d.wav", "d.wav"),
    ("", ""), (None, ""),
])
def test_link_name(uri, name):
    assert mf.link_name(uri) == name


def test_link_exists_through_a_file_uri(tmp_path):
    f = tmp_path / "rec one.wav"
    f.write_bytes(b"RIFF")
    assert mf.link_exists(pathlib.Path(f).as_uri()), "a file:/// link to an existing file EXISTS (FLEx's own reading)"
    assert mf.link_exists(str(f))
    assert not mf.link_exists(str(tmp_path / "missing.wav"))
    lf = tmp_path / "LinkedFiles" / "AudioVisual"
    lf.mkdir(parents=True)
    (lf / "r.wav").write_bytes(b"RIFF")
    assert mf.link_exists("AudioVisual\\r.wav", str(tmp_path / "LinkedFiles"))


def test_link_key_absolute_is_global_relative_is_per_project():
    a = mf.link_key("file:///C:/Rec/A.wav", "proj1")
    assert a == mf.link_key("C:\\Rec\\a.WAV", "another project"), "same recording whatever project or spelling"
    r1 = mf.link_key("AudioVisual\\a.wav", "proj1")
    assert r1 != mf.link_key("AudioVisual\\a.wav", "proj2"), "relative names collide across projects"
    assert r1 == mf.link_key("audiovisual/A.wav", "PROJ1")


def test_is_audio():
    assert mf.is_audio("x.WAV") and mf.is_audio("x.mp3") and mf.is_audio("x.flac")
    assert not mf.is_audio("x.txt") and not mf.is_audio("x.fwdata") and not mf.is_audio(None)
    assert mf.DIALOG_FILTER.startswith("Audio files (*.wav;") and mf.DIALOG_FILTER.endswith(")")


# ---- the bounded search -----------------------------------------------------------------------------

def _touch(p, data=b"RIFF"):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return str(p)


def test_search_exact_name_first_case_insensitive_then_same_stem(tmp_path):
    a = tmp_path / "A"
    b = tmp_path / "B"
    exact = _touch(b / "deep" / "Session-01.WAV")
    near = _touch(a / "session-01.mp3")
    _touch(a / "session-01.txt")                       # same stem, not audio: never offered
    _touch(a / "session-02.wav")                       # another name
    got = mf.search("session-01.wav", [(str(a), 1), (str(b), 2)])
    assert got == [exact, near], got


def test_search_respects_depth_budget_and_symlinks(tmp_path):
    root = tmp_path / "root"
    deep = _touch(root / "l1" / "l2" / "l3" / "x.wav")
    assert mf.search("x.wav", [(str(root), 2)]) == [], "depth 2 does not reach level 3"
    assert mf.search("x.wav", [(str(root), 3)]) == [deep]
    for i in range(50):
        _touch(root / ("f%02d.txt" % i))
    assert mf.search("x.wav", [(str(root), 3)], max_entries=10) == [], "the entry budget bounds the walk"
    other = tmp_path / "elsewhere"
    target = _touch(other / "y.wav")
    try:
        os.symlink(str(other), str(root / "link"), target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("no symlinks here")
    assert mf.search("y.wav", [(str(root), 3)]) == [], "a symlinked folder is not followed"
    assert mf.search("y.wav", [(str(other), 0), (str(other), 0)]) == [target], "duplicates removed"


def test_search_survives_missing_and_unreadable_roots(tmp_path):
    assert mf.search("x.wav", [(str(tmp_path / "nope"), 3), (None, 1)]) == []
    assert mf.search("", [(str(tmp_path), 3)]) == []


# ---- the memory -------------------------------------------------------------------------------------

def test_memory_remembers_links_and_folders_across_instances(tmp_path):
    store = tmp_path / "state" / "media-map.json"
    rec = _touch(tmp_path / "found" / "a.wav")
    m = mf.MediaMemory(str(store))
    assert m.lookup("C:\\Old\\a.wav") is None and m.folders() == []
    m.remember("C:\\Old\\a.wav", rec, "proj")
    assert m.lookup("file:///C:/Old/A.WAV", "another") == os.path.abspath(rec), "absolute link: any project, any spelling"
    m2 = mf.MediaMemory(str(store))
    assert m2.lookup("C:\\Old\\a.wav") == os.path.abspath(rec)
    assert m2.folders() == [os.path.dirname(os.path.abspath(rec))]
    assert not os.path.exists(str(store) + ".tmp"), "written atomically"
    os.remove(rec)
    assert m2.lookup("C:\\Old\\a.wav") is None, "a remembered file that is gone is not offered"


def test_memory_relative_links_are_per_project_and_folders_are_mru_capped(tmp_path):
    m = mf.MediaMemory(str(tmp_path / "m.json"))
    r1 = _touch(tmp_path / "p1" / "a.wav")
    m.remember("AudioVisual\\a.wav", r1, "proj1")
    assert m.lookup("AudioVisual\\a.wav", "proj1") == os.path.abspath(r1)
    assert m.lookup("AudioVisual\\a.wav", "proj2") is None
    for i in range(mf.MAX_FOLDERS + 3):
        m.remember(None, _touch(tmp_path / ("d%02d" % i) / "x.wav"))
    fs = m.folders()
    assert len(fs) == mf.MAX_FOLDERS and fs[0].endswith("d%02d" % (mf.MAX_FOLDERS + 2)), "most recent first, capped"
    m.remember(None, str(tmp_path / ("d%02d" % (mf.MAX_FOLDERS + 2)) / "x.wav"))
    assert len(m.folders()) == mf.MAX_FOLDERS, "re-remembering a folder does not duplicate it"


def test_memory_sets_a_damaged_file_aside(tmp_path):
    store = tmp_path / "m.json"
    store.write_text("{ not json")
    m = mf.MediaMemory(str(store))
    assert m.folders() == [] and os.path.exists(str(store) + ".bad")
    m.remember(None, _touch(tmp_path / "f" / "a.wav"))
    assert json.loads(store.read_text())["version"] == 1
