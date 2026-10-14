"""stage_engine.py fails on off-origin subresources and lays the bundle out as the server expects."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build"))
import stage_engine as se  # noqa: E402


def test_scan_finds_every_kind_of_off_origin_content(tmp_path):
    (tmp_path / "a.html").write_text('<script src="https://cdn.example/x.js"></script><link rel=stylesheet href="//fonts.example/f.css"><iframe src="https://e.example/"></iframe><script src="js/ok.js"></script>')
    (tmp_path / "b.js").write_text("import x from 'https://esm.example/x.js';\nimport y from './y.js';\n// https://doc.example in a comment is fine\nconst z = await import('https://z.example/z.js');")
    (tmp_path / "c.css").write_text('@import url("https://fonts.example/a.css"); .a{background:url(img/a.png)} .b{src:url(data:font/woff;base64,AAAA)}')
    bad = se.scan(str(tmp_path))
    kinds = sorted((k, r) for _, k, r in bad)
    assert ("script", "https://cdn.example/x.js") in kinds
    assert ("link", "//fonts.example/f.css") in kinds
    assert ("iframe", "https://e.example/") in kinds
    assert ("js-import", "https://esm.example/x.js") in kinds
    assert ("js-dynamic-import", "https://z.example/z.js") in kinds
    assert ("css-import", "https://fonts.example/a.css") in kinds
    assert not any(r.startswith(("data:", "js/", "./", "img/")) for _, _, r in bad)


def test_off_origin_rule():
    assert se.off_origin("https://x.example/a.js") and se.off_origin("//x.example/a.js") and se.off_origin("ftp://x")
    assert not se.off_origin("js/app.js") and not se.off_origin("/flextext-editor/js/app.js") and not se.off_origin("data:text/plain,x")
    assert not se.off_origin("blob:http://127.0.0.1:8017/x") and not se.off_origin("#top")


def test_stage_the_real_engine(tmp_path):
    out = se.stage(str(tmp_path / "engine"))
    assert os.path.isfile(os.path.join(out, "index.html")), "the satellite shell at /"
    assert os.path.isfile(os.path.join(out, "flextext-editor", "js", "app.js")), "the engine at /flextext-editor/"
    assert not os.path.exists(os.path.join(out, "sw.js")) and not os.path.exists(os.path.join(out, "flextext-editor", "sw.js")), "no service workers"
    assert os.path.isfile(os.path.join(out, "engine-version.json"))
    import json
    with open(os.path.join(out, "engine-version.json")) as f:
        assert json.load(f)["engineVersion"].startswith("v")
