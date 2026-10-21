"""V-10: the navigation guard on REAL WebView2 (plan §2.2) — Windows only, run by hand on the VM:

  python desktop/vm/test_navguard_e2e.py

Starts the local server with a test page on our origin that tries every escape:
location.href off-site, window.open, <a target=_blank>, an <iframe> to an external URL,
<meta http-equiv=refresh>, a form POST off-site, history.pushState to another origin, and a
download from a non-blob URL. os.startfile is replaced by a recording STUB (no browser opens).
PASS = the page stays on our origin, no second window exists, the stub recorded exactly the expected
http(s) URLs, and the download was cancelled. Also: relaunch keeps IndexedDB (private_mode=False);
a second launch on the taken port is refused by the nonce check.
"""
import json
import os
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

PAGE = """<!doctype html><meta charset=utf-8><title>navguard e2e</title>
<script>
const results = {};
window.__results = results;
async function run() {
  try { results.idbBefore = (await indexedDB.databases()).some((d) => d.name === 'persist-test'); } catch (e) { results.idbBefore = 'err ' + e; }
  try { indexedDB.open('persist-test', 1).onsuccess = (e) => { const db = e.target.result; results.idb = true; }; } catch (e) { results.idb = 'err ' + e; }
  try { const w = window.open('https://example.com/open', '_blank'); results.open = w === null ? 'null' : 'WINDOW'; } catch (e) { results.open = 'err'; }
  const a = document.createElement('a'); a.href = 'https://example.com/blank'; a.target = '_blank'; a.textContent = 'x'; document.body.appendChild(a); a.click();
  const f = document.createElement('iframe'); f.src = 'https://example.com/frame'; document.body.appendChild(f);
  f.onload = () => { try { results.iframe = f.contentWindow.location.href; } catch (e) { results.iframe = 'opaque'; } };
  try { history.pushState({}, '', 'https://example.com/push'); results.push = 'ALLOWED'; } catch (e) { results.push = 'refused'; }
  const dl = document.createElement('a'); dl.href = 'https://example.com/file.zip'; dl.download = 'f.zip'; document.body.appendChild(dl); dl.click();
  const form = document.createElement('form'); form.method = 'POST'; form.action = 'https://example.com/post'; form.target = '_blank'; document.body.appendChild(form);
  setTimeout(() => { form.submit(); }, 100);
  setTimeout(() => { document.title = 'done:' + location.origin; }, 800);
  setTimeout(() => { location.href = 'https://example.com/top'; }, 1200);
}
// The script sits before <body>: run() once the page is parsed, or document.body is null and the first
// appendChild throws (the first VM run, 2026-10-21, stopped there and tested only window.open).
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
</script><body>e2e</body>"""


def main():
    if sys.platform != "win32":
        sys.exit("Windows + WebView2 only (this is V-10)")
    import webview
    from flexshell import server, webview_hooks, navguard
    root = tempfile.mkdtemp(prefix="navguard-e2e-")
    with open(os.path.join(root, "index.html"), "w", encoding="utf-8") as f:
        f.write(PAGE)
    port = 8027
    srv = server.start(root, port=port)
    recorded = []
    stub = recorded.append
    assert server.probe_nonce(port) == srv.nonce, "nonce probe"
    try:
        server.start(root, port=port)
        raise SystemExit("FAIL: a second start on the taken port was not refused")
    except OSError as e:
        print("ok  second launch refused:", e)
    results = {}

    def on_start(window):
        webview_hooks.install(window, port, opener=stub, release=True)
        time.sleep(2.5)
        results["origin"] = window.evaluate_js("location.origin")
        results["title"] = window.evaluate_js("document.title")
        results["page"] = window.evaluate_js("JSON.stringify(window.__results)")
        results["windows"] = len(webview.windows)
        window.destroy()

    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = False   # as app.py: the guard decides, not pywebview
    webview.settings["ALLOW_DOWNLOADS"] = False
    window = webview.create_window("navguard e2e", srv.origin + "/", width=600, height=400)
    webview.start(on_start, window, gui="edgechromium", private_mode=False,
                  storage_path=os.path.join(tempfile.gettempdir(), "navguard-e2e-storage"))
    page = json.loads(results.get("page") or "{}")
    ok = True
    def check(cond, msg):
        nonlocal ok
        print(("ok  " if cond else "FAIL") + " " + msg)
        ok = ok and cond
    check(results.get("origin") == srv.origin, "page stayed on our origin (%s)" % results.get("origin"))
    check(str(results.get("title", "")).startswith("done:" + srv.origin), "no top-level navigation happened")
    check(results.get("windows") == 1, "no second window exists")
    check(page.get("open") == "null", "window.open returned null")
    check(page.get("iframe") in (None, "opaque"), "external iframe did not load")
    expected = {"https://example.com/open", "https://example.com/blank", "https://example.com/top", "https://example.com/post"}
    check(set(recorded) == expected, "OS-browser stub recorded exactly the expected URLs: %s" % sorted(recorded))
    check(all(navguard.external_url_ok(u) for u in recorded), "every handed-off URL is http(s)")
    check(page.get("push") == "refused", "history.pushState to another origin was refused")
    if page.get("idbBefore") is True:
        print("ok   IndexedDB 'persist-test' from the previous launch is still there (private_mode=False)")
    else:
        print("note IndexedDB 'persist-test' was not there yet (%r): run this test once more; that run must say ok"
              % page.get("idbBefore"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
