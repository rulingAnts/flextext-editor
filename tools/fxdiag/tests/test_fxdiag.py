"""fxdiag against a REAL Chromium profile: tests/fixtures/profile-fixture.zip was written by headless
Chromium (tests/make_profile.mjs — Playwright, a persistent context, made-up records at the suite's
production origin), so the LevelDB, Blink and V8 encodings are the genuine ones. Everything in it is
invented: two texts called "Fixture text one/two", a 3000-byte blob of zeros as the recording.
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
    assert not suite.is_suite_host("example.org") and not suite.is_suite_host("github.io") and not suite.is_suite_host("evil-flextext.app.example")
    assert suite.parse_idb_folder("https_app.flextext.app_0.indexeddb.leveldb") == ("https", "app.flextext.app", "0")
    assert suite.parse_idb_folder("http_localhost_8012.indexeddb.blob") == ("http", "localhost", "8012")
    assert suite.origin_url("http", "localhost", "8012") == "http://localhost:8012" and suite.origin_url("https", "x.flextext.app", "0") == "https://x.flextext.app"
    assert suite.is_sensitive_key("flextext-researcher-auth") and suite.is_sensitive_key("flextext-sync-session") and suite.is_sensitive_key("flextext-admin-unlock")
    assert not suite.is_sensitive_key("flextext-ws-settings") and not suite.is_sensitive_key("flextext-device-id") and not suite.is_sensitive_key("flextext-lang")


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
    assert docs["doc-a"]["doc"]["paragraphs"][0]["words"][1]["txt"] == "ipsum" and docs["doc-b"]["flex"]["textGuid"].endswith("0001")
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
        assert rows["doc-a"]["words"] == 2 and rows["doc-a"]["segments"] == 1 and rows["doc-a"]["media"]["doc-a"]["size"] == 3000
        assert rows["doc-a"]["uploadState"] == {"upload": {"fields": ["state"]}} and rows["doc-b"]["flexTextGuid"].endswith("0001")
        assert "lorem" not in z.read(next(n for n in names if n.startswith("storage-"))).decode()   # a manifest carries no words
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
