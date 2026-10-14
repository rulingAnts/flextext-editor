"""The bridge object (plan §3): never raises into JS, hello() does no LCM work, the project
lifecycle, jobs, E_BUSY, E_POISONED, and the engine-doc shape open_text returns."""
import json
import os
import time

import pytest

from flexshell import FLEX_CONTRACT
from flexshell.api import Api, parse_line_choices
from flexshell.lcm_mock import MockBackendFactory, MockLcm, SECTION

TEXTS = [{"title": "api text", "paragraphs": ["aaa bbb " + SECTION + " ccc ddd.", "eee fff"]}]


@pytest.fixture
def api(tmp_path):
    projects = tmp_path / "Projects"
    projects.mkdir()
    MockLcm.create_project(str(projects), "copy-api", texts=TEXTS)
    (projects / "copy-api" / "flextext-disposable-copy.txt").write_text("x")
    MockLcm.create_project(str(projects), "prod", texts=TEXTS)
    MockLcm.create_project(str(projects), "shared", texts=TEXTS, sharing=True)
    engine = tmp_path / "engine"
    (engine / "js").mkdir(parents=True)
    (engine / "index.html").write_text("<!doctype html>")
    (engine / "js" / "i18n.js").write_text("export const ENGINE_VERSION = 'v999';")
    opened = []
    a = Api(MockBackendFactory(str(projects)), engine_root=str(engine), opener=opened.append,
            copy_text_fn=lambda t: True, pick_file_fn=lambda k, d=None: str(tmp_path / ("pick." + k)),
            state_dir=str(tmp_path / "state"))
    a._opened = opened
    yield a
    a._worker.stop()


def ok(r):
    assert r["ok"] is True, r
    return r["result"]


def err(r):
    assert r["ok"] is False, r
    return r["error"]


def wait(api, job):
    for _ in range(200):
        st = ok(api.job_status(job["jobId"]))
        if st["state"] in ("done", "error"):
            return st
        time.sleep(0.01)
    raise AssertionError("job did not finish")


def test_hello_is_pure(api):
    h = ok(api.hello())
    assert h["contract"] == FLEX_CONTRACT and h["copyOnly"] is True and h["engineVersion"] == "v999"
    assert h["capabilities"]["offsiteAuth"] is False and h["modelVersion"] == 7000072
    assert api._session is None and api._factory.last is None, "no LCM work"


def test_every_exposed_method_answers_the_envelope_and_never_raises(api):
    for name in ("list_texts", "close_project", "undo_flex", "redo_flex"):
        r = getattr(api, name)()
        assert set(r) == {"ok", "error"} and r["error"]["code"] in ("E_NOT_FOUND",), (name, r)
    r = api.open_text(None)
    assert r["ok"] is False
    r = api.job_status("nope")
    assert err(r)["code"] == "E_NOT_FOUND"
    r = api.open_project("copy-api", "sideways")
    assert err(r)["code"] == "E_SCOPE"
    r = api.copy_text(42)
    assert err(r)["code"] == "E_SCOPE"
    # an internal failure becomes E_INTERNAL with a trace, not an exception
    api._factory = None
    r = api.hello()
    assert r["ok"] is True   # hello tolerates a missing factory
    r = api.list_projects()
    assert r["ok"] is True


def test_list_projects_is_filesystem_only(api):
    projects = {p["name"]: p for p in ok(api.list_projects())}
    assert set(projects) == {"copy-api", "prod", "shared"}
    assert projects["copy-api"]["writable"] and projects["copy-api"]["disposableCopy"]
    assert projects["prod"]["reasons"] == ["E_COPY_ONLY"] and projects["prod"]["readable"]
    assert projects["shared"]["sharing"] and "E_SHARING_ON" in projects["shared"]["reasons"]
    assert api._factory.last is None, "never opens a project"


def test_open_write_read_close_lifecycle(api):
    r = ok(api.open_project("copy-api", "write"))
    assert r["writable"] and r["ws"]["vern"][0]["id"] == "xx" and r["glossWsDefaults"] == ["en"]
    assert err(api.open_project("copy-api", "write"))["code"] == "E_ALREADY_OPEN"
    texts = ok(api.list_texts())
    assert len(texts) == 1 and texts[0]["title"] == "api text" and texts[0]["segs"] == 3
    assert ok(api.close_project()) == {"saved": False}
    assert err(api.list_texts())["code"] == "E_NOT_FOUND"
    # production-like project: copy-only refuses write, allows read
    assert err(api.open_project("prod", "write"))["code"] == "E_COPY_ONLY"
    r = ok(api.open_project("prod", "read"))
    assert r["writable"] is False
    ok(api.close_project())
    assert err(api.open_project("shared", "write"))["code"] == "E_SHARING_ON"
    ok(api.open_project("shared", "read"))
    ok(api.close_project())
    assert err(api.open_project("../etc", "read"))["code"] == "E_NOT_FOUND"


def test_open_text_returns_the_engine_doc_shape(api):
    ok(api.open_project("copy-api", "write"))
    tg = ok(api.list_texts())[0]["guid"]
    r = ok(api.open_text(tg))
    doc = r["doc"]
    assert r["baseRev"] and doc["flex"]["textGuid"] == tg and doc["vernLang"] == "xx" and doc["analLang"] == "en"
    assert len(doc["paragraphs"]) == 3, "one phrase per line"
    assert len({ln["paraOf"] for ln in doc["paragraphs"]}) == 2, "paraOf carries the FLEx paragraph"
    l0 = doc["paragraphs"][0]["segments"][0]
    assert l0["attrs"]["guid"] == l0["flex"]["segGuid"] and l0["baseline"] == "aaa bbb " + SECTION
    assert l0["words"][-1]["boundaryMarker"] is True and l0["words"][-1]["punct"] is True
    assert l0["words"][0]["flex"]["analysisKind"] == "wordform"
    assert doc["segments"][0] == {"start": 0, "end": 0, "timePending": True}
    assert doc["paragraphs"][1]["segments"][0]["baseline"] == "ccc ddd."
    ok(api.close_text(tg))


def test_preview_save_job_and_undo_redo_through_the_bridge(api):
    ok(api.open_project("copy-api", "write"))
    tg = ok(api.list_texts())[0]["guid"]
    r = ok(api.open_text(tg))
    doc = r["doc"]
    seg = doc["paragraphs"][0]["segments"][0]
    op = {"op": "ft.set", "paraGuid": doc["paragraphs"][0]["paraOf"], "segGuid": seg["attrs"]["guid"], "ws": "en", "value": "hello"}
    pv = ok(api.preview_save(tg, r["baseRev"], [op], None))
    assert pv["summary"][0]["kind"] == "ft.set"
    job = ok(api.save_to_flex(pv["previewToken"]))
    st = wait(api, job)
    assert st["state"] == "done" and st["result"]["undoLabel"] == "Undo Save to FLEx (1 changes)"
    assert st["result"]["disk"]["ok"]
    st = wait(api, ok(api.undo_flex()))
    assert st["state"] == "done" and st["result"]["label"].startswith("Undo Save to FLEx")
    st = wait(api, ok(api.redo_flex()))
    assert st["state"] == "done"
    assert ok(api.list_texts())[0]["guid"] == tg
    # a failed job reports its error through job_status
    st = wait(api, ok(api.save_to_flex("expired-token")))
    assert st["state"] == "error" and st["error"]["code"] == "E_PREVIEW_EXPIRED"


def test_poisoned_session_answers_e_poisoned_until_closed(api):
    ok(api.open_project("copy-api", "write"))
    tg = ok(api.list_texts())[0]["guid"]
    r = ok(api.open_text(tg))
    from flexshell.errors import FlexError
    api._session._poison(FlexError("E_SAVE_FAILED", "test", {}))
    assert err(api.list_texts())["code"] == "E_POISONED"
    assert err(api.preview_save(tg, r["baseRev"], [], None))["code"] == "E_POISONED"
    e = err(api.open_text(tg))
    assert e["code"] == "E_POISONED" and "edits are still in the editor" in e["message"]
    assert ok(api.close_project())["poisoned"] is True
    assert api._factory.last.calls.count(("close_project",)) == 0


def test_get_media_registers_tokens_and_reports_missing(api, tmp_path):
    rec = tmp_path / "a.wav"
    rec.write_bytes(b"RIFF")
    projects = api._projects_dir
    MockLcm.create_project(projects, "copy-m", texts=[{"title": "m", "paragraphs": ["aaa"], "media": [str(rec), str(tmp_path / "gone.wav")]}])
    (tmp_path / "Projects" / "copy-m" / "flextext-disposable-copy.txt").write_text("x")
    ok(api.open_project("copy-m", "read"))
    tg = ok(api.list_texts())[0]["guid"]
    m = ok(api.get_media(tg))
    assert len(m["tracks"]) == 2
    assert m["tracks"][0]["exists"] and m["tracks"][0]["url"].startswith("/media/") and len(api._media) == 1
    assert m["tracks"][1]["exists"] is False and m["tracks"][1]["url"] is None
    doc = ok(api.open_text(tg))["doc"]
    assert doc["flex"]["media"][0]["url"].startswith("/media/")
    ok(api.close_project())
    assert len(api._media) == 0, "tokens die with the project session"


def test_misc_bridge_calls(api):
    assert ok(api.copy_text("x\ty")) == {"copied": True}
    assert ok(api.pick_file("media"))["path"].endswith("pick.media")
    assert err(api.pick_file("anything"))["code"] == "E_SCOPE"
    assert ok(api.open_external("https://example.com/x")) == {"opened": True} and api._opened == ["https://example.com/x"]
    assert err(api.open_external("file:///C:/"))["code"] == "E_SCOPE" and api._opened == ["https://example.com/x"]


def test_print_view_config_parser():
    cfg = parse_line_choices("InterlinLineChoices_v3,5062001%fr%True,5060001%en%True%Word Gloss,-61%en%True,-65%en%False")
    assert cfg["version"] == "InterlinLineChoices_v3" and len(cfg["lines"]) == 4
    assert cfg["lines"][1] == {"flid": 5060001, "ws": "en", "enabled": True, "name": "Word Gloss"}
    assert cfg["lines"][3]["enabled"] is False


def test_printview_data(api):
    ok(api.open_project("copy-api", "read"))
    tg = ok(api.list_texts())[0]["guid"]
    doc = ok(api.open_text(tg))["doc"]
    seg = doc["paragraphs"][1]["segments"][0]["attrs"]["guid"]
    d = ok(api.printview_data(seg))
    assert d["paraNumber"] == 1 and d["segNumber"] == 2 and d["segsInPara"] == 2
    assert [w["form"] for w in d["words"]] == ["ccc", "ddd", "."] and d["words"][2]["punct"]
    assert err(api.printview_data("nope"))["code"] == "E_NOT_FOUND"


def _pywebview_surface(obj, base="", seen=None, out=None, depth=0):
    """pywebview's util.parse_api_js walk, reimplemented: every attribute WITHOUT a leading underscore
    is exposed to the page — methods as functions, other objects RECURSIVELY. → {full_name: kind}."""
    import inspect
    seen = set() if seen is None else seen
    out = {} if out is None else out
    if id(obj) in seen or depth > 6:
        return out
    seen.add(id(obj))
    for name in dir(obj):
        if name.startswith("_"):
            continue
        attr = getattr(obj, name)
        full = base + "." + name if base else name
        if inspect.ismethod(attr) or inspect.isfunction(attr):
            out[full] = "exposed" if getattr(attr, "__exposed__", False) else "METHOD"
        elif inspect.isclass(attr) or (not callable(attr) and hasattr(attr, "__module__")):
            out[full] = "OBJECT"
            _pywebview_surface(attr, full, seen, out, depth + 1)
    return out


def test_the_page_can_reach_only_exposed_methods(api):
    """What pywebview hands the page as window.pywebview.api is EXACTLY the @exposed methods: no
    attribute, no wiring method, nothing nested (a public `worker` would give JS worker.run(); a
    public `window` recursed into WinForms until 'maximum recursion depth exceeded' on the VM)."""
    import types

    class FakeWindow:   # as after webview_hooks.install(): the api holds pywebview's window
        native = types.SimpleNamespace(AccessibilityObject=object())
    api._set_window(FakeWindow())
    api._attach_server(types.SimpleNamespace(media=api._media, origin="http://127.0.0.1:1", stop=lambda: None))
    surface = _pywebview_surface(api)
    bad = {k: v for k, v in surface.items() if v != "exposed"}
    assert not bad, "reachable from the page but not an @exposed method: %r" % bad
    assert {"hello", "list_projects", "open_project", "save_to_flex", "job_status"} <= set(surface)


def _pywebview_surface(obj, base="", seen=None, out=None, depth=0):
    """pywebview's util.parse_api_js walk, reimplemented: every attribute WITHOUT a leading underscore
    is exposed to the page — methods as functions, other objects RECURSIVELY. → {full_name: kind}."""
    import inspect
    seen = set() if seen is None else seen
    out = {} if out is None else out
    if id(obj) in seen or depth > 6:
        return out
    seen.add(id(obj))
    for name in dir(obj):
        if name.startswith("_"):
            continue
        attr = getattr(obj, name)
        full = base + "." + name if base else name
        if inspect.ismethod(attr) or inspect.isfunction(attr):
            out[full] = "exposed" if getattr(attr, "__exposed__", False) else "METHOD"
        elif inspect.isclass(attr) or (not callable(attr) and hasattr(attr, "__module__")):
            out[full] = "OBJECT"
            _pywebview_surface(attr, full, seen, out, depth + 1)
    return out


def test_the_page_can_reach_only_exposed_methods(api):
    """What pywebview hands the page as window.pywebview.api is EXACTLY the @exposed methods: no
    attribute, no wiring method, nothing nested (a public `worker` would give JS worker.run(); a
    public `window` recursed into WinForms until 'maximum recursion depth exceeded' on the VM)."""
    import types

    class FakeWindow:   # as after webview_hooks.install(): the api holds pywebview's window
        native = types.SimpleNamespace(AccessibilityObject=object())
    api._set_window(FakeWindow())
    api._attach_server(types.SimpleNamespace(media=api._media, origin="http://127.0.0.1:1", stop=lambda: None))
    surface = _pywebview_surface(api)
    bad = {k: v for k, v in surface.items() if v != "exposed"}
    assert not bad, "reachable from the page but not an @exposed method: %r" % bad
    assert {"hello", "list_projects", "open_project", "save_to_flex", "job_status"} <= set(surface)


def test_every_port_call_runs_on_the_worker_thread(api):
    """The mock enforces the one-thread rule through ThreadBound exactly as the real port does, so an
    off-worker call fails here, not on the VM (eighth launch: writing_systems() on the bridge thread)."""
    ok(api.open_project("copy-api", "read"))
    port = api._session.port
    with pytest.raises(RuntimeError, match="off the worker thread"):
        port.writing_systems()
    assert api._worker.run("probe", lambda j: port.writing_systems())["vern"], "the same call on the worker works"
    ok(api.close_project())


def test_a_failed_open_releases_the_project_and_a_second_open_is_refused_while_one_is_live(api, monkeypatch):
    from flexshell import api as api_mod
    real_session = api_mod.Session

    class Boom(real_session):
        def __init__(self, port, *a, **kw):
            super().__init__(port, *a, **kw)
            raise RuntimeError("read-back failed after the open")
    monkeypatch.setattr(api_mod, "Session", Boom)
    r = api.open_project("copy-api", "read")
    assert r["ok"] is False and "read-back failed" in r["error"]["message"]
    assert api._session is None and api._registry.open_name is None, "the open was undone: no session, no claim"
    monkeypatch.setattr(api_mod, "Session", real_session)
    assert api._factory.last.calls.count(("open", "copy-api", False)) == 1
    ok(api.open_project("copy-api", "read"))   # the lock was released: this open succeeds
    r2 = api.open_project("copy-api", "read")
    assert r2["ok"] is False and r2["error"]["code"] == "E_ALREADY_OPEN", r2
    ok(api.close_project())
