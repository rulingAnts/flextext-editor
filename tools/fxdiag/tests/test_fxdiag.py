"""fxdiag against a REAL Chromium profile: tests/fixtures/profile-fixture.zip was written by headless
Chromium (tests/make_profile.mjs — Playwright, a persistent context, made-up records at the suite's
production origin, built in the page by the engine's own parser), so the LevelDB, Blink and V8 encodings
and the record shape are the genuine ones. Everything in it is invented: two texts called "Fixture text
one/two", a 3000-byte blob of zeros as the recording, a fake auth token under a credential-named key.
Regenerate with `node tests/make_profile.mjs <dir>` and re-zip Default/IndexedDB + Default/Local
Storage/leveldb (no LOCK files) if Chromium's format ever moves."""
import json
import os
import zipfile
from pathlib import Path

import pytest

from fxdiag import profiles, report, snapshot, suite, reader

HERE = Path(__file__).parent


@pytest.fixture
def user_data(tmp_path):
    ud = tmp_path / "User Data"
    with zipfile.ZipFile(HERE / "fixtures" / "profile-fixture.zip") as z:
        z.extractall(ud)
    (ud / "Local State").write_text(json.dumps({"profile": {"info_cache": {"Default": {"name": "Tester"}}}}), encoding="utf-8")
    (ud / "Default" / "Preferences").write_text(json.dumps({"profile": {"name": "Tester"}, "web_apps": {"web_app_ids": {
        "abc": {"name": "FlexText Editor", "start_url": "https://rulingants.github.io/flextext-editor/", "install_time": "1"},
        "zzz": {"name": "Other", "start_url": "https://example.org/", "install_time": "1"}}}}), encoding="utf-8")
    return ud


def test_suite_knowledge():
    assert suite.is_suite_host("rulingants.github.io") and suite.is_suite_host("beta-record.flextext.app") and suite.is_suite_host("flextext.app")
    assert suite.is_suite_host("staging-flextext-editor.68mh29kgsd.workers.dev") and suite.is_suite_host("paragraph-analysis-tool.68mh29kgsd.workers.dev")
    assert suite.is_suite_host("consent-collector-beta.68mh29kgsd.workers.dev") and suite.is_suite_host("audio-segmenter.68mh29kgsd.workers.dev")
    assert not suite.is_suite_host("example.org") and not suite.is_suite_host("github.io") and not suite.is_suite_host("evil-flextext.app.example")
    assert not suite.is_suite_host("68mh29kgsd.workers.dev") and not suite.is_suite_host("other.workers.dev") and not suite.is_suite_host("x.68mh29kgsd.workers.dev.example")
    assert suite.parse_idb_folder("https_app.flextext.app_0.indexeddb.leveldb") == ("https", "app.flextext.app", "0")
    assert suite.parse_idb_folder("http_localhost_8012.indexeddb.blob") == ("http", "localhost", "8012")
    assert suite.origin_url("http", "localhost", "8012") == "http://localhost:8012" and suite.origin_url("https", "x.flextext.app", "0") == "https://x.flextext.app"
    assert suite.is_sensitive_key("flextext-researcher-auth") and suite.is_sensitive_key("flextext-sync-session") and suite.is_sensitive_key("flextext-admin-unlock")
    assert not suite.is_sensitive_key("flextext-ws-settings") and not suite.is_sensitive_key("flextext-device-id") and not suite.is_sensitive_key("flextext-lang")
    assert suite.is_suite_key("flextext-lang") and suite.is_suite_key("fxpa:working") and suite.is_suite_key("pa.joinSplit") and suite.is_suite_key("sfm.convert.mapping") and suite.is_suite_key("rp-anything")
    assert not suite.is_suite_key("theme") and not suite.is_suite_key("0x4AAAAAAA") and not suite.is_suite_key("")


def test_discover_finds_the_profile_its_origin_and_the_installed_app(user_data):
    stores = profiles.discover([user_data])
    assert len(stores) == 1
    s = stores[0]
    assert s.layout == "chromium" and s.profile_name == "Tester" and s.profile_dir == user_data / "Default"
    assert [o.origin for o in s.origins] == ["https://rulingants.github.io"] and s.origins[0].blob is not None
    assert s.local_storage == user_data / "Default" / "Local Storage" / "leveldb"
    suite_apps = [a for a in s.web_apps if a.get("suite")]
    assert len(suite_apps) == 1 and suite_apps[0]["name"] == "FlexText Editor"
    assert not [a for a in s.web_apps if a.get("name") == "Other" and a.get("suite")]


def test_discover_knows_the_three_layouts(tmp_path):
    flat = tmp_path / "flextext-desktop"
    (flat / "IndexedDB" / "https_app.flextext.app_0.indexeddb.leveldb").mkdir(parents=True)
    (flat / "Local Storage" / "leveldb").mkdir(parents=True)
    wv = tmp_path / "webview"
    (wv / "EBWebView" / "Default" / "IndexedDB" / "http_127.0.0.1_8017.indexeddb.leveldb").mkdir(parents=True)
    (wv / "EBWebView" / "Default" / "Preferences").write_text("{}", encoding="utf-8")
    other = tmp_path / "unrelated"
    (other / "Default" / "IndexedDB" / "https_example.org_0.indexeddb.leveldb").mkdir(parents=True)
    (other / "Default" / "Preferences").write_text("{}", encoding="utf-8")
    assert profiles.guess_layout(flat) == "flat" and profiles.guess_layout(wv) == "webview2" and profiles.guess_layout(other) == "chromium"
    stores = profiles.discover([flat, wv, other])
    by = {s.layout: s for s in stores}
    assert by["flat"].origins[0].origin == "https://app.flextext.app" and by["flat"].profile_name == "flextext-desktop"
    assert by["webview2"].origins[0].origin == "http://127.0.0.1:8017" and by["webview2"].profile_dir == wv / "EBWebView" / "Default"
    assert by["chromium"].origins == []   # listed because it was named explicitly, with nothing of ours in it


def test_candidate_dirs_are_per_platform_and_only_existing(tmp_path):
    home = tmp_path / "home"
    (home / "AppData" / "Local" / "Google" / "Chrome" / "User Data").mkdir(parents=True)
    (home / "AppData" / "Local" / "FlexTextSegmenterFLEx" / "webview").mkdir(parents=True)
    (home / "AppData" / "Roaming" / "flextext-desktop").mkdir(parents=True)
    got = profiles.candidate_user_data_dirs(home=home, platform="win32")
    assert [(a, l) for a, _, l in got] == [("Google Chrome", "chromium"), ("Flextext Desktop", "flat"), ("FlexText Segmenter for FLEx", "webview2")]
    (home / "Library" / "Application Support" / "Microsoft Edge").mkdir(parents=True)
    assert [a for a, _, _ in profiles.candidate_user_data_dirs(home=home, platform="darwin")] == ["Microsoft Edge"]
    (home / ".config" / "chromium").mkdir(parents=True)
    assert [a for a, _, _ in profiles.candidate_user_data_dirs(home=home, platform="linux")] == ["Chromium"]


def test_snapshot_copies_without_lock_and_reads_the_copy_not_the_original(user_data, tmp_path):
    store = profiles.discover([user_data])[0]
    (store.origins[0].leveldb / "LOCK").write_bytes(b"")
    before = {p: p.stat().st_mtime_ns for p in user_data.rglob("*") if p.is_file()}
    copy, problems, base = snapshot.take(store, tmp_path / "work")
    assert problems == [] and base == tmp_path / "work"
    assert copy.origins[0].leveldb.is_dir() and copy.origins[0].leveldb != store.origins[0].leveldb
    assert not (copy.origins[0].leveldb / "LOCK").exists() and (copy.origins[0].leveldb / "CURRENT").exists()
    r = reader.read_origin(copy.origins[0])
    assert r["problems"] == []
    assert {p: p.stat().st_mtime_ns for p in user_data.rglob("*") if p.is_file()} == before   # the original is untouched


def test_reader_decodes_records_blobs_and_settings(user_data, tmp_path):
    copy, _, _ = snapshot.take(profiles.discover([user_data])[0], tmp_path / "w")
    r = reader.read_origin(copy.origins[0])
    stores = r["databases"]["flextext-editor"]["stores"]
    docs = {d["id"]: d for d in stores["docs"]["docs"]}
    assert set(docs) == {"doc-a", "doc-b"} and docs["doc-a"]["title"] == "Fixture text one"
    words = docs["doc-a"]["doc"]["paragraphs"][0]["segments"][0]["words"]
    assert "ipsum" in json.dumps(words) and len(words) == 3
    assert docs["doc-b"]["flex"]["textGuid"].endswith("0001") and len(docs["doc-a"]["doc"]["segments"]) == 1   # one span per paragraph (one line), two phrases inside it
    media = stores["media"]["media"]
    assert media["doc-a"] == {"kind": "blob", "size": 3000, "type": "audio/wav", "fileName": None}
    assert media["peaks:doc-a"]["kind"] == "value" and media["peaks:doc-a"]["fields"] == ["peaks"]
    assert stores["docs"]["count"] == 2 and stores["media"]["count"] == 2 and stores["docs"]["deserializeErrors"] == 0
    assert reader.read_blob(copy.origins[0], "media", "doc-a") == bytes(3000)
    assert reader.read_blob(copy.origins[0], "media", "peaks:doc-a") is None
    ls, problems = reader.read_local_storage(copy.local_storage, {"rulingants.github.io"})
    assert problems == []
    vals = ls["https://rulingants.github.io"]
    assert vals["flextext-ws-settings"] == {"vern": "xx", "vernName": "Made-up", "anal": "en", "segmentation": True}
    assert vals["flextext-device-id"] == "dev-0000-fixture"
    assert vals["flextext-researcher-auth"] == {"present": True, "length": 24}   # the fake token never leaves the profile
    assert "made-up-token" not in json.dumps(ls)


def test_sensitive_local_storage_keys_are_present_not_copied(monkeypatch, tmp_path):
    """The shaping rule, exercised directly: a credential-named key never carries its value."""
    class Rec:
        def __init__(self, k, v):
            self.script_key, self.value = k, v

    class FakeDb:
        def __init__(self, d): pass
        def iter_storage_keys(self): return ["https://app.flextext.app", "https://example.org"]
        def iter_records_for_storage_key(self, sk, include_deletions=False):
            return [Rec("flextext-researcher-auth", "SECRET-VALUE"), Rec("flextext-lang", "en"), Rec("flextext-lang", "id"), Rec("unrelated", "x")]
        def close(self): pass
    import types
    fake = types.SimpleNamespace(LocalStoreDb=FakeDb)
    monkeypatch.setattr(reader, "_ccl", lambda: (None, fake, None))
    d = tmp_path / "leveldb"; d.mkdir()
    out, problems = reader.read_local_storage(d, {"app.flextext.app"})
    assert problems == [] and set(out) == {"https://app.flextext.app"}
    assert out["https://app.flextext.app"] == {"flextext-researcher-auth": {"present": True, "length": 12}, "flextext-lang": "id"}
    assert "SECRET-VALUE" not in json.dumps(out)


def test_report_zip_holds_manifests_and_texts_only_when_asked(user_data, tmp_path):
    stores = profiles.discover([user_data])
    out = tmp_path / "r.zip"
    summary = report.build(stores, out, texts="none", workdir=tmp_path / "w1")
    with zipfile.ZipFile(out) as z:
        names = set(z.namelist())
        assert {"report.json", "README.txt"} <= names and any(n.startswith("storage-") for n in names)
        assert not any(n.startswith("texts/") or n.startswith("media/") for n in names)
        body = json.loads(z.read(next(n for n in names if n.startswith("storage-"))))
        rows = {t["id"]: t for t in body["origins"][0]["texts"]}
        assert rows["doc-a"]["words"] == 4 and rows["doc-a"]["phrases"] == 2 and rows["doc-a"]["segments"] == 1 and rows["doc-a"]["media"]["doc-a"]["size"] == 3000
        assert rows["doc-a"]["hasDriveFolder"] is True and "folder-0000" not in json.dumps(rows)
        assert rows["doc-a"]["uploadState"] == {"upload": {"fields": ["state"]}} and rows["doc-b"]["flexTextGuid"].endswith("0001")
        manifest = z.read(next(n for n in names if n.startswith("storage-"))).decode()
        assert "lorem" not in manifest and "made-up-token" not in manifest   # a manifest carries no words and no credential
        assert body["localStorage"]["https://rulingants.github.io"]["flextext-ws-settings"]["vern"] == "xx"
        readme = z.read("README.txt").decode()
        assert "2 text(s)" in readme and "0 text record(s) included" in readme and "Android" in readme
    assert summary["stores"][0]["texts"] == 2 and summary["stores"][0]["textsIncluded"] == 0 and summary["copyProblems"] == []

    out2 = tmp_path / "r2.zip"
    report.build(stores, out2, texts=["doc-a"], with_audio=True, redact_titles=True, note="made for the test", workdir=tmp_path / "w2")
    with zipfile.ZipFile(out2) as z:
        names = set(z.namelist())
        texts = [n for n in names if n.startswith("texts/")]
        media = [n for n in names if n.startswith("media/")]
        assert len(texts) == 1 and texts[0].endswith("/doc-a.json") and len(media) == 1 and media[0].endswith("/doc-a.wav")
        assert json.loads(z.read(texts[0]))["title"] == "Fixture text one"
        assert len(z.read(media[0])) == 3000
        body = json.loads(z.read(next(n for n in names if n.startswith("storage-"))))
        assert all(t["title"].startswith("sha256:") for t in body["origins"][0]["texts"])
        assert "made for the test" in z.read("README.txt").decode()


def test_cli_scan_and_report(user_data, tmp_path, capsys, monkeypatch):
    from fxdiag import cli
    monkeypatch.chdir(tmp_path)
    assert cli.main(["scan", "--user-data-dir", str(user_data)]) == 0
    out = capsys.readouterr().out
    assert "Tester" in out and "https://rulingants.github.io" in out
    assert cli.main(["report", "--user-data-dir", str(user_data), "--out", str(tmp_path / "x.zip"), "--texts", "doc-b"]) == 0
    assert zipfile.ZipFile(tmp_path / "x.zip").namelist().count("report.json") == 1
    assert cli.main(["scan", "--user-data-dir", str(tmp_path / "nowhere")]) == 1


def test_only_the_suites_storage_is_read(user_data, tmp_path):
    """A foreign origin's IndexedDB folder beside ours, and foreign keys in Local Storage, never reach
    the report — by host filter and by key prefix, not by luck."""
    idb = user_data / "Default" / "IndexedDB"
    (idb / "https_example.org_0.indexeddb.leveldb").mkdir()
    (idb / "https_example.org_0.indexeddb.leveldb" / "CURRENT").write_text("MANIFEST-000001\n")
    stores = profiles.discover([user_data])
    assert [o.host for o in stores[0].origins] == ["rulingants.github.io"]
    out = tmp_path / "r.zip"
    report.build(stores, out, raw=True, workdir=tmp_path / "w")
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        assert not any("example.org" in n for n in names)
        raw = [n for n in names if n.startswith("raw/")]
        assert raw and all("/IndexedDB/https_rulingants.github.io_0.indexeddb." in n for n in raw)
        assert not any("Local Storage" in n for n in raw)   # the profile-wide localStorage LevelDB never travels
        body = json.loads(z.read(next(n for n in names if n.startswith("storage-"))))
        assert set(body["localStorage"]) == {"https://rulingants.github.io"}
    blob = json.dumps([n for n in names]) + "".join(zipfile.ZipFile(out).read(n).decode("utf-8", "replace") for n in names if n.endswith(".json") or n.endswith(".txt"))
    assert "example.org" not in blob


def test_flextext_export_uses_the_engines_writer(user_data, tmp_path):
    from fxdiag import flexexport
    ok, why = flexexport.availability()
    if not ok:
        pytest.skip("flextext export needs node and the engine: " + why)
    stores = profiles.discover([user_data])
    out = tmp_path / "r.zip"
    summary = report.build(stores, out, flextext=True, with_audio=True, workdir=tmp_path / "w")
    ex = summary["stores"][0]["exported"]
    assert ex == {"flextext": 2, "recordings": 1, "failed": []}, ex
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        fx = sorted(n for n in names if n.endswith(".flextext"))
        assert [n.rsplit("/", 1)[1] for n in fx] == ["Fixture text one.flextext", "Fixture text two.flextext"]
        xml = z.read(fx[0]).decode("utf-8")
        assert xml.startswith("<?xml") and "<interlinear-text" in xml and "lorem" in xml and "ipsum" in xml and "dolor" in xml
        assert 'type="title"' in xml and "Fixture text one" in xml and 'guid="11111111-1111-4111-8111-111111111111"' in xml
        assert "Fixture text one.wav" in xml                        # the media-files block names the recording beside it
        assert "begin-time-offset" in xml                           # the record carried segments: its times travel
        wav = [n for n in names if n.endswith("Fixture text one.wav")]
        assert len(wav) == 1 and len(z.read(wav[0])) == 3000
        readme = z.read("README.txt").decode()
        assert "2 .flextext file(s), 1 recording(s)" in readme
    assert summary["engineSerializer"] not in ("", "unknown")


def test_flextext_export_without_node_says_so(user_data, tmp_path, monkeypatch):
    from fxdiag import flexexport
    monkeypatch.setattr(flexexport, "find_node", lambda: None)
    stores = profiles.discover([user_data])
    out = tmp_path / "r.zip"
    summary = report.build(stores, out, flextext=True, workdir=tmp_path / "w")
    assert "Node.js" in summary["flextextUnavailable"]
    assert summary["stores"][0]["exported"]["flextext"] == 0 and len(summary["stores"][0]["exported"]["failed"]) == 2
    with zipfile.ZipFile(out) as z:
        assert "could not be written" in z.read("README.txt").decode()
        assert not any(n.endswith(".flextext") for n in z.namelist())


def test_filename_rules_match_the_engine():
    from fxdiag import flexexport
    assert flexexport.sanitize_base('a/b:c*d?"e<f>g|h') == "a_b_c_d_e_f_g_h"
    assert flexexport.sanitize_base("  x  ") == "x" and len(flexexport.sanitize_base("y" * 200)) == 120
    assert flexexport.ext_for("audio/webm;codecs=opus") == ".webm" and flexexport.ext_for("audio/wav") == ".wav"
    assert flexexport.ext_for("audio/wav", "one.MP3") == ".mp3" and flexexport.ext_for("application/octet-stream") == ""
    taken = set()
    assert [flexexport.unique_name("t", taken) for _ in range(3)] == ["t", "t (2)", "t (3)"]


# ---- Firefox family (gecko) — discovery and localStorage on SYNTHETIC layouts; see gecko.py's caveat ----

def _gecko_profile(tmp_path, with_ini=True):
    root = tmp_path / "Firefox"
    prof = root / "Profiles" / "abcd1234.default-release"
    for origin in ("https+++rulingants.github.io", "http+++localhost+8012", "https+++example.org", "https+++app.flextext.app^userContextId=2"):
        (prof / "storage" / "default" / origin / "idb").mkdir(parents=True)
    (prof / "prefs.js").write_text("// prefs", encoding="utf-8")
    if with_ini:
        (root / "profiles.ini").write_text("[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abcd1234.default-release\nDefault=1\n\n[General]\nStartWithLastProfile=1\n", encoding="utf-8")
    return root, prof


def test_gecko_origin_dir_names():
    from fxdiag import gecko
    assert gecko.parse_origin_dir("https+++rulingants.github.io") == ("https", "rulingants.github.io", None)
    assert gecko.parse_origin_dir("http+++localhost+8012") == ("http", "localhost", "8012")
    assert gecko.parse_origin_dir("https+++app.flextext.app^userContextId=2") == ("https", "app.flextext.app", None)
    assert gecko.parse_origin_dir("moz-extension+++abc") is None and gecko.parse_origin_dir("chrome") is None


def test_gecko_discovery_lists_profiles_and_suite_origins_only(tmp_path):
    from fxdiag import gecko
    root, prof = _gecko_profile(tmp_path)
    assert gecko.profiles_in(root) == [(prof, "default-release")]
    assert sorted(h for _, h, _ in gecko.suite_origins(prof)) == ["app.flextext.app", "localhost", "rulingants.github.io"]
    assert profiles.guess_layout(root) == "gecko" and profiles.guess_layout(prof) == "gecko"
    stores = profiles.discover([root])
    assert len(stores) == 1 and stores[0].layout == "gecko" and stores[0].profile_name == "default-release"
    assert sorted(o.origin for o in stores[0].origins) == ["http://localhost:8012", "https://app.flextext.app", "https://rulingants.github.io"]
    assert all(o.kind == "gecko" for o in stores[0].origins)
    # no profiles.ini: the Profiles/ folders are still found
    root2, prof2 = _gecko_profile(tmp_path / "noini", with_ini=False)
    assert gecko.profiles_in(root2) == [(prof2, prof2.name)]


def test_gecko_candidate_roots_per_platform(tmp_path):
    from fxdiag import gecko
    home = tmp_path / "h"
    (home / "AppData" / "Roaming" / "Mozilla" / "Firefox").mkdir(parents=True)
    (home / "AppData" / "Roaming" / "Mozilla" / "Firefox" / "profiles.ini").write_text("", encoding="utf-8")
    (home / "AppData" / "Roaming" / "librewolf" / "Profiles").mkdir(parents=True)
    assert [a for a, _ in gecko.candidate_roots(home, "win32")] == ["Firefox", "LibreWolf"]
    (home / ".mozilla" / "firefox").mkdir(parents=True)
    (home / ".mozilla" / "firefox" / "profiles.ini").write_text("", encoding="utf-8")
    assert [a for a, _ in gecko.candidate_roots(home, "linux")] == ["Firefox"]
    assert [a for a, _, l in profiles.candidate_user_data_dirs(home=home, platform="linux") if l == "gecko"] == ["Firefox"]


def test_gecko_local_storage_reader_on_a_synthetic_lsng_file(tmp_path):
    """⚠ Self-consistency only: the schema (key, utf16_length, compression_type, value) and the Snappy
    framing are written from the Firefox source as remembered, not from a real profile. A real
    data.sqlite that reads differently is the finding this test cannot make."""
    import sqlite3
    pytest.importorskip("mozidbedit")
    import cramjam
    from fxdiag import gecko
    origin = tmp_path / "https+++app.flextext.app"
    (origin / "ls").mkdir(parents=True)
    con = sqlite3.connect(origin / "ls" / "data.sqlite")
    con.execute("CREATE TABLE data (key TEXT PRIMARY KEY, utf16_length INTEGER NOT NULL, compression_type INTEGER NOT NULL, last_access_time INTEGER NOT NULL DEFAULT 0, value BLOB NOT NULL)")
    settings = json.dumps({"vern": "xx", "anal": "en"})
    comp = bytes(cramjam.snappy.compress_raw(settings.encode("utf-8")))
    con.execute("INSERT INTO data VALUES (?,?,?,?,?)", ("flextext-ws-settings", len(settings), 1, 0, comp))
    con.execute("INSERT INTO data VALUES (?,?,?,?,?)", ("flextext-device-id", 8, 0, 0, b"dev-0001"))
    con.execute("INSERT INTO data VALUES (?,?,?,?,?)", ("flextext-researcher-auth", 6, 0, 0, b"secret"))
    con.execute("INSERT INTO data VALUES (?,?,?,?,?)", ("theme", 4, 0, 0, b"dark"))
    con.commit(); con.close()
    vals, problems = gecko.read_local_storage(origin)
    assert problems == [] and vals["flextext-ws-settings"] == settings and vals["flextext-device-id"] == "dev-0001" and vals["theme"] == "dark"
    shaped = reader.shape_keys(vals)
    assert shaped == {"flextext-ws-settings": {"vern": "xx", "anal": "en"}, "flextext-device-id": "dev-0001", "flextext-researcher-auth": {"present": True, "length": 6}}


def test_gecko_indexeddb_reader_against_a_real_firefox_profile_if_one_is_on_hand(tmp_path):
    """Runs only when tests/fixtures/firefox-fixture.zip exists (a Firefox profile written by
    tests/make_profile.mjs with FXDIAG_BROWSER=firefox on a machine that has Playwright's Firefox)."""
    fx = HERE / "fixtures" / "firefox-fixture.zip"
    if not fx.is_file():
        pytest.skip("no Firefox fixture — gecko IndexedDB reading stays [unverified]")
    pytest.importorskip("mozidbedit")
    root = tmp_path / "ff"
    with zipfile.ZipFile(fx) as z:
        z.extractall(root)
    stores = profiles.discover([root])
    assert stores and stores[0].layout == "gecko"
    out = tmp_path / "r.zip"
    summary = report.build(stores, out, texts="all", with_audio=True, workdir=tmp_path / "w")
    assert summary["stores"][0]["texts"] == 2, summary


# ---- the USB exchange package ----

def test_pack_builds_a_package_the_app_can_import(user_data, tmp_path):
    from fxdiag import flexexport, pack
    ok, why = flexexport.availability()
    if not ok:
        pytest.skip(why)
    stores = profiles.discover([user_data])
    rep = tmp_path / "r.zip"
    report.build(stores, rep, flextext=True, with_audio=True, workdir=tmp_path / "w")
    out = tmp_path / "usb" / "device-7"
    m = pack.build([rep], out, device="device 7", assign={"vern": "xx", "vernName": "Made-up", "anal": "en", "upload": "folder-0000"},
                   delete=[{"id": "doc-old", "title": "An old one"}], note="for the test", zip_it=True)
    files = sorted(p.name for p in out.iterdir())
    assert files == ["Fixture text one.flextext", "Fixture text one.wav", "Fixture text two.flextext", "MANIFEST.json", "README.txt", "assign.html"]
    mf = json.loads((out / "MANIFEST.json").read_text(encoding="utf-8"))
    assert mf["format"] == "flextext-usb-exchange" and mf["device"] == "device 7"
    assert {t["file"]: t["recordings"] for t in mf["texts"]} == {"Fixture text one.flextext": ["Fixture text one.wav"], "Fixture text two.flextext": []}
    assert mf["texts"][0]["guid"] == "11111111-1111-4111-8111-111111111111" and mf["texts"][0]["title"] == "Fixture text one"
    assert mf["assignUrl"] == "https://app.flextext.app/?vern=xx&vernName=Made-up&anal=en&upload=folder-0000"
    assert mf["delete"] == [{"id": "doc-old", "title": "An old one"}]
    assert "fxdiag never writes into a browser" in (out / "README.txt").read_text(encoding="utf-8")
    import html as _html
    assert mf["assignUrl"] in _html.unescape((out / "assign.html").read_text(encoding="utf-8"))
    assert zipfile.ZipFile(str(out) + ".zip").namelist().count("MANIFEST.json") == 1
    assert (out / "Fixture text one.wav").stat().st_size == 3000


def test_pack_from_loose_files_and_cli(tmp_path, monkeypatch, capsys):
    from fxdiag import cli
    src = tmp_path / "loose"
    src.mkdir()
    (src / "A text.flextext").write_text('<?xml version="1.0"?><document><interlinear-text guid="33333333-3333-4333-8333-333333333333"><item type="title" lang="en">A &amp; B</item></interlinear-text></document>', encoding="utf-8")
    (src / "A text.webm").write_bytes(b"\0" * 10)
    (src / "unrelated.txt").write_text("x", encoding="utf-8")
    assert cli.main(["pack", str(src), "--out", str(tmp_path / "pkg"), "--device", "d", "--assign", "vern=xx", "--delete", "id-1:Old title"]) == 0
    names = sorted(p.name for p in (tmp_path / "pkg").iterdir())
    assert names == ["A & B.flextext", "A & B.webm", "MANIFEST.json", "README.txt", "assign.html"]
    assert "Old title" in capsys.readouterr().out
    assert cli.main(["pack", str(src), "--out", str(tmp_path / "pkg2"), "--assign", "novalue"]) == 2
