"""The navigation guard, table-driven (plan §2.2). Every row is a URL the shell might be asked to
show, with the ONE decision the policy must give. Fail-closed is the rule, so anything not plainly
our own origin is refused or handed out."""
import pytest

from flexshell import navguard as ng

PORT = 8017
TOP, FRAME, NEW, DL = ng.KIND_TOP, ng.KIND_FRAME, ng.KIND_NEW_WINDOW, ng.KIND_DOWNLOAD
# the userinfo trick: our host and port before an "@", so the real host is elsewhere. Built from parts
# so no literal of the credentials-in-a-URL shape sits in the repo (check-secrets.sh refuses that shape).
USERINFO = "http://127.0.0.1:8017" + "@evil.example/"

TABLE = [
    # own origin
    ("http://127.0.0.1:8017/", TOP, ng.ALLOW),
    ("http://127.0.0.1:8017/index.html?x=1#h", TOP, ng.ALLOW),
    ("http://127.0.0.1:8017/js/app.js", FRAME, ng.ALLOW),
    ("about:blank", TOP, ng.ALLOW),
    ("about:blank", FRAME, ng.ALLOW),
    # another port, localhost, ::1 — other ORIGINS, so other IndexedDBs: refused as top-level content
    ("http://127.0.0.1:8018/", TOP, ng.OPEN_EXTERNAL),
    ("http://127.0.0.1/", TOP, ng.OPEN_EXTERNAL),
    ("http://localhost:8017/", TOP, ng.OPEN_EXTERNAL),
    ("http://[::1]:8017/", TOP, ng.OPEN_EXTERNAL),
    ("https://127.0.0.1:8017/", TOP, ng.OPEN_EXTERNAL),
    # look-alike hosts
    ("http://127.0.0.1.evil.example:8017/", TOP, ng.OPEN_EXTERNAL),
    (USERINFO, TOP, ng.OPEN_EXTERNAL),                                   # userinfo trick
    (USERINFO, FRAME, ng.REFUSE),
    ("http://127%2e0%2e0%2e1:8017/", TOP, ng.OPEN_EXTERNAL),             # percent-encoded host
    ("HTTP://127.0.0.1:8017/", TOP, ng.ALLOW),                           # scheme case is insignificant (urlsplit lowers it)
    ("http://127.0.0.1:08017/", TOP, ng.OPEN_EXTERNAL),                  # the netloc must be spelled plainly
    ("http://xn--80ak6aa92e.com/", TOP, ng.OPEN_EXTERNAL),               # IDN host
    ("http://пример.рф/", TOP, ng.OPEN_EXTERNAL),
    # off-site content
    ("https://example.com/", TOP, ng.OPEN_EXTERNAL),
    ("https://example.com/", FRAME, ng.REFUSE),
    ("https://example.com/", NEW, ng.OPEN_EXTERNAL),
    ("http://127.0.0.1:8017/", NEW, ng.REFUSE),                          # never a second webview, even of ourselves
    # schemes that go nowhere
    ("file:///C:/", TOP, ng.REFUSE),
    ("file:///C:/", NEW, ng.REFUSE),
    ("ftp://example.com/", TOP, ng.REFUSE),
    ("javascript:alert(1)", TOP, ng.REFUSE),
    ("javascript:alert(1)", NEW, ng.REFUSE),
    ("ms-settings:", TOP, ng.REFUSE),
    ("data:text/html,<script>1</script>", TOP, ng.REFUSE),               # data: top-level is refused
    ("data:text/html,<p>x</p>", FRAME, ng.ALLOW),                        # as a frame from our own page it is allowed
    # blob: only from our own origin, and only as frame or download
    ("blob:http://127.0.0.1:8017/0f0e-1", FRAME, ng.ALLOW),
    ("blob:http://127.0.0.1:8017/0f0e-1", TOP, ng.REFUSE),
    ("blob:http://127.0.0.1:8017/0f0e-1", DL, ng.ALLOW),
    ("blob:https://example.com/0f0e-1", FRAME, ng.REFUSE),
    ("blob:https://example.com/0f0e-1", DL, ng.REFUSE),
    ("blob:http://127.0.0.1:8018/0f0e-1", DL, ng.REFUSE),
    ("blob:" + USERINFO + "0f0e-1", DL, ng.REFUSE),
    # downloads from anywhere but our blobs
    ("https://example.com/file.zip", DL, ng.REFUSE),
    ("http://127.0.0.1:8017/file.zip", DL, ng.REFUSE),                   # even our own static files: exports are blobs
    ("data:application/zip;base64,AAAA", DL, ng.REFUSE),
    # garbage
    ("", TOP, ng.REFUSE),
    ("   ", TOP, ng.REFUSE),
    ("http://127.0.0.1:8017/\n", TOP, ng.REFUSE),
    ("http://127.0.0.1:8017/a\\b", TOP, ng.REFUSE),
    ("http://127.0.0.1:8017/", "bogus-kind", ng.REFUSE),
]


@pytest.mark.parametrize("url,kind,expected", TABLE)
def test_decide(url, kind, expected):
    assert ng.decide(url, kind, PORT) == expected


def test_non_string_is_refused():
    assert ng.decide(None, TOP, PORT) == ng.REFUSE
    assert ng.decide(42, TOP, PORT) == ng.REFUSE


def test_port_is_part_of_the_identity():
    assert ng.decide("http://127.0.0.1:8017/", TOP, 8018) == ng.OPEN_EXTERNAL
    assert ng.decide("http://127.0.0.1:8018/", TOP, 8018) == ng.ALLOW


@pytest.mark.parametrize("url,ok", [
    ("https://example.com/x", True), ("http://example.com", True),
    ("file:///C:/", False), ("javascript:1", False), ("", False), (None, False),
    ("https://example.com/\n", False), ("mailto:a@b.c", False), ("http://", False),
])
def test_external_url_ok(url, ok):
    assert ng.external_url_ok(url) is ok
