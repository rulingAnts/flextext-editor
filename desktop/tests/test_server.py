"""The local server: Host check, path confinement, the port nonce, media tokens with ranges, no
service worker, no non-GET methods (plan §2.2, §8.3). A real server on an ephemeral port."""
import http.client
import os
import socket

import pytest

from flexshell import server as srv


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


@pytest.fixture
def site(tmp_path):
    root = tmp_path / "engine"
    (root / "js").mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html><title>t</title>", encoding="utf-8")
    (root / "js" / "app.js").write_text("export const x = 1;", encoding="utf-8")
    (root / "sw.js").write_text("// a worker that must NOT be served", encoding="utf-8")
    (tmp_path / "outside.txt").write_text("secret", encoding="utf-8")
    media = tmp_path / "rec.wav"
    media.write_bytes(bytes(range(256)) * 4)   # 1024 bytes
    port = free_port()
    s = srv.start(str(root), port=port, connect_origins=["https://relay.example"])
    try:
        yield {"srv": s, "port": port, "root": root, "media": media, "tmp": tmp_path}
    finally:
        s.shutdown()
        s.server_close()


def get(port, path, headers=None, method="GET"):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    h = {"Host": "127.0.0.1:%d" % port}
    h.update(headers or {})
    c.request(method, path, headers=h)
    r = c.getresponse()
    body = r.read()
    c.close()
    return r.status, dict(r.getheaders()), body


def test_index_and_headers(site):
    st, h, body = get(site["port"], "/")
    assert st == 200 and b"<title>t</title>" in body
    assert h["Content-Security-Policy"].startswith("default-src 'self'")
    assert "connect-src 'self' https://relay.example" in h["Content-Security-Policy"]
    assert h["X-Content-Type-Options"] == "nosniff"
    assert "text/html" in h["Content-Type"]


def test_js_mime(site):
    st, h, _ = get(site["port"], "/js/app.js")
    assert st == 200 and h["Content-Type"].startswith(("application/javascript", "text/javascript"))


def test_host_header_must_match(site):
    assert get(site["port"], "/", {"Host": "localhost:%d" % site["port"]})[0] == 421
    assert get(site["port"], "/", {"Host": "127.0.0.1:%d" % (site["port"] + 1)})[0] == 421
    assert get(site["port"], "/", {"Host": "evil.example"})[0] == 421


def test_path_confinement(site):
    for p in ("/../outside.txt", "/js/../../outside.txt", "/%2e%2e/outside.txt", "/js/..%2f..%2foutside.txt", "/js%5c..%5c..%5coutside.txt"):
        st, _, body = get(site["port"], p)
        assert st in (404, 400) and b"secret" not in body, p


def test_no_directory_listing(site):
    assert get(site["port"], "/js/")[0] == 404
    assert get(site["port"], "/js")[0] == 404


def test_no_service_worker(site):
    assert get(site["port"], "/sw.js")[0] == 404


def test_nonce_route(site):
    st, _, body = get(site["port"], srv.NONCE_PATH)
    assert st == 200 and body.decode() == site["srv"].nonce and len(body) == 32
    assert srv.probe_nonce(site["port"]) == site["srv"].nonce


def test_second_start_on_the_same_port_is_refused_with_a_clear_message(site):
    with pytest.raises(OSError) as ei:
        srv.start(str(site["root"]), port=site["port"])
    assert "another FlexText Segmenter" in str(ei.value)


def test_unknown_port_holder_is_named_as_such(tmp_path):
    other = socket.socket()
    other.bind(("127.0.0.1", 0))
    other.listen(1)
    port = other.getsockname()[1]
    try:
        with pytest.raises(OSError) as ei:
            srv.start(str(tmp_path), port=port)
        assert "another program" in str(ei.value)
    finally:
        other.close()


def test_non_get_methods_refused(site):
    assert get(site["port"], "/", method="POST")[0] == 405
    assert get(site["port"], srv.NONCE_PATH, method="PUT")[0] == 405


def test_media_tokens_and_ranges(site):
    reg = site["srv"].media
    tok = reg.register(str(site["media"]))
    assert len(tok) == 32
    st, h, body = get(site["port"], "/media/" + tok)
    assert st == 200 and len(body) == 1024 and h["Accept-Ranges"] == "bytes"
    st, h, body = get(site["port"], "/media/" + tok, {"Range": "bytes=10-19"})
    assert st == 206 and body == bytes(range(10, 20)) and h["Content-Range"] == "bytes 10-19/1024"
    st, h, body = get(site["port"], "/media/" + tok, {"Range": "bytes=-4"})
    assert st == 206 and body == bytes([252, 253, 254, 255])
    st, _, _ = get(site["port"], "/media/" + tok, {"Range": "bytes=5000-"})
    assert st == 416


def test_media_unknown_or_malformed_token(site):
    assert get(site["port"], "/media/" + "0" * 32)[0] == 404
    assert get(site["port"], "/media/abc")[0] == 404
    assert get(site["port"], "/media/../index.html")[0] == 404


def test_media_tokens_die_with_the_session(site):
    reg = site["srv"].media
    tok = reg.register(str(site["media"]))
    assert get(site["port"], "/media/" + tok)[0] == 200
    reg.clear()
    assert get(site["port"], "/media/" + tok)[0] == 404


def test_media_registry_refuses_missing_files(site):
    with pytest.raises(FileNotFoundError):
        site["srv"].media.register(str(site["tmp"] / "nope.wav"))


def test_confine_pure():
    root = os.path.dirname(os.path.abspath(__file__))
    assert srv.confine(root, "/") == os.path.join(os.path.realpath(root), "index.html")
    assert srv.confine(root, "/../x") is None
    assert srv.confine(root, "/a\\b") is None
    assert srv.confine(root, "/%00") is None


def test_csp_has_no_off_origin_content_sources():
    csp = srv.csp_for(["https://relay.example"])
    for directive in ("script-src", "frame-src"):
        assert "https://" not in csp.split(directive)[-1].split(";")[0] if directive in csp else True
    assert "default-src 'self'" in csp and "object-src 'none'" in csp
