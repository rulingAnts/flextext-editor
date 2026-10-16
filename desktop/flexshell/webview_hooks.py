"""WebView2 wiring for the navigation guard — WINDOWS ONLY, imported lazily by app.py (plan §2.2).

Everything decided here is decided by navguard.decide(); this module only connects CoreWebView2's
events to it. If the guard cannot be attached, install() raises and the shell refuses to show the
window.

TIMING (learned on the first VM launch, 2026-10-14): pywebview runs the function given to
`webview.start()` in a thread of its own the moment the GUI loop starts — BEFORE the native window
exists, and long before WebView2 has finished initialising. So install() first waits for the
window to be shown, then hops onto the UI thread and either attaches at once (CoreWebView2 already
there) or subscribes to CoreWebView2InitializationCompleted and attaches from inside that event,
right after pywebview's own handler and before the first navigation is dispatched. Destroying the
window while that initialisation is still running is what WebView2 reports as E_ABORT.

pywebview's own CoreWebView2 handlers run BEFORE ours (subscribed first), so attach() is written to
run after them: pywebview cancels every download (ALLOW_DOWNLOADS=False) and we re-allow our own
blobs with a Save dialog; pywebview turns every NewWindowRequested into a top-level navigation of
THIS window (app.py sets OPEN_EXTERNAL_LINKS_IN_BROWSER=False so it never opens a browser itself),
and we cancel that follow-up navigation because the new-window decision already handled the URL.
[unverified] on real WebView2 (V-10, desktop/vm/test_navguard_e2e.py).
"""

import logging
import ntpath
import os
import threading
import time

from . import navguard

LOG = logging.getLogger("flexshell.webview")   # trace.py: what the window and its browser did

RECENT_NEW_WINDOW_S = 2.0   # a NewWindowRequested URL is remembered this long (see attach())


def _open_in_os_browser(url, opener=None):
    """Hand an http(s) URL to the OS default browser. No fallback: if the OS refuses, nothing opens
    (plan §2.2 item 4). `opener` is replaced by a recording stub in tests."""
    if not navguard.external_url_ok(url):
        return False
    try:
        (opener or os.startfile)(url)   # type: ignore[attr-defined]  (Windows only)
        return True
    except OSError:
        return False


def attach(core, port, opener=None, release=True, chooser=None, now=time.monotonic):
    """Attach the guard to an initialised CoreWebView2 (duck-typed; tests pass fakes).

    Settings (release builds): no DevTools, no default context menus, no status bar, no browser
    accelerator keys (F5 / Ctrl+P / Ctrl+L go nowhere), zoom control left as is.
    `chooser(suggested_name) → path | None` asks the user where an allowed download goes.
    """
    settings = core.Settings
    settings.AreDevToolsEnabled = not release
    settings.AreDefaultContextMenusEnabled = False
    settings.IsStatusBarEnabled = False
    settings.AreBrowserAcceleratorKeysEnabled = False

    recent = {}   # url → when NewWindowRequested decided it (pywebview re-issues it as a navigation)

    def recently_decided(url):
        t = now()
        for u in [u for u, when in recent.items() if t - when > RECENT_NEW_WINDOW_S]:
            del recent[u]
        return recent.pop(url, None) is not None

    def on_nav(sender, args):
        url = str(args.Uri)
        if recently_decided(url):
            args.Cancel = True      # pywebview's load_url() after a NewWindowRequested we already handled
            return
        d = navguard.decide(url, navguard.KIND_TOP, port)
        _quietly(LOG.debug, "navigation to %s: %s", url[:200], d)
        if d == navguard.ALLOW:
            return
        args.Cancel = True
        if d == navguard.OPEN_EXTERNAL:
            _open_in_os_browser(url, opener)

    def on_frame_nav(sender, args):
        if navguard.decide(str(args.Uri), navguard.KIND_FRAME, port) != navguard.ALLOW:
            args.Cancel = True

    def on_new_window(sender, args):
        args.Handled = True   # never a second webview
        url = str(args.Uri)
        recent[url] = now()
        if navguard.decide(url, navguard.KIND_NEW_WINDOW, port) == navguard.OPEN_EXTERNAL:
            _open_in_os_browser(url, opener)

    def on_download(sender, args):
        src = str(args.DownloadOperation.Uri)
        args.Handled = True   # no download bubble either way
        if navguard.decide(src, navguard.KIND_DOWNLOAD, port) != navguard.ALLOW:
            args.Cancel = True
            return
        suggested = ntpath.basename(str(args.ResultFilePath or "")) or "export"   # always a Windows path
        path = chooser(suggested) if chooser else None
        if path:
            args.ResultFilePath = path
            args.Cancel = False   # pywebview's own handler (ALLOW_DOWNLOADS=False) cancelled it first
        else:
            args.Cancel = True

    def on_process_failed(sender, args):
        # a WebView2 browser or renderer process died: the console says which, and why, before anything
        # else happens to the window (2026-10-16: a shell that ended with no line said nothing at all)
        _quietly(LOG.error, "WebView2 process failed: %s, reason %s, exit code %s%s", _get(args, "ProcessFailedKind"),
                 _get(args, "Reason"), _get(args, "ExitCode"),
                 (" (%s)" % _get(args, "ProcessDescription")) if _get(args, "ProcessDescription") else "")

    core.NavigationStarting += on_nav
    core.FrameNavigationStarting += on_frame_nav
    core.NewWindowRequested += on_new_window
    core.DownloadStarting += on_download
    if hasattr(core, "ProcessFailed"):
        core.ProcessFailed += on_process_failed
    if not release and hasattr(core, "OpenDevToolsWindow"):
        core.OpenDevToolsWindow()   # F12 and the context menu stay off even in dev mode: this is the only way in
    return {"nav": on_nav, "frame": on_frame_nav, "new_window": on_new_window, "download": on_download}


def _get(obj, name):
    """A .NET event argument's property, or None: an older WebView2 runtime lacks the newer ones."""
    try:
        return getattr(obj, name, None)
    except Exception:   # noqa: BLE001 — a throwing CLR getter
        return None


def _quietly(log, *args):
    try:
        log(*args)
    except Exception:   # noqa: BLE001 — a console line never costs the window
        pass


def trace_lifecycle(window):
    """Say in the console when the window is shown, loads its page, is asked to close and has closed. A
    shell that ends after "closing" was closed (its close button, Alt+F4, Windows); one that ends with
    neither line, or after "WebView2 process failed", died under it — so a vanished window is never a
    guess (2026-10-16). pywebview's events take `+=`; a handler returning None never cancels a close."""
    events = getattr(window, "events", None)
    if events is None:
        return []
    done = []
    for name, said in (("shown", "window shown"), ("loaded", "window: page loaded"),
                       ("closing", "window closing (its close button, Alt+F4, or Windows asked it to)"),
                       ("closed", "window closed")):
        ev = getattr(events, name, None)
        if ev is None or not hasattr(ev, "__iadd__"):
            continue

        def handler(*_a, _said=said, **_k):
            _quietly(LOG.info, _said)
        try:
            ev += handler
            done.append(name)
        except Exception:   # noqa: BLE001
            pass
    return done


def install(window, port, opener=None, release=True, timeout=30.0):
    """Attach the guard to pywebview's WinForms window. Blocks until it is attached (or raises).
    Call it from the function handed to webview.start(), i.e. off the UI thread."""
    if not window.events.shown.wait(timeout):
        raise RuntimeError("the window was not shown within %gs — the guard cannot be installed" % timeout)
    native = getattr(window, "native", None)
    if native is None:
        raise RuntimeError("no native window — the guard cannot be installed")
    wv = _webview2_control(native)
    if wv is None:
        raise RuntimeError("WebView2 control not reachable — the guard cannot be installed")

    done = threading.Event()
    result = {}

    def finish(core):
        try:
            result["handlers"] = attach(core, port, opener, release,
                                        chooser=lambda name: _save_dialog(native, name))
        except Exception as e:   # noqa: BLE001 — reported to the caller, which refuses to run
            result["error"] = "%s: %s" % (type(e).__name__, e)
        done.set()

    def on_ui_thread():
        core = getattr(wv, "CoreWebView2", None)
        if core is not None:
            finish(core)
            return

        def on_init(sender, args):
            if not getattr(args, "IsSuccess", True):
                result["error"] = "WebView2 initialisation failed: %s" % getattr(args, "InitializationException", "?")
                done.set()
                return
            finish(sender.CoreWebView2)

        wv.CoreWebView2InitializationCompleted += on_init

    _invoke(native, on_ui_thread)
    if not done.wait(timeout):
        raise RuntimeError("WebView2 did not initialise within %gs — the guard cannot be installed" % timeout)
    if "error" in result:
        raise RuntimeError(result["error"])
    return result["handlers"]


def _invoke(native, fn):
    """Run fn on the form's UI thread (WinForms Control.Invoke), as pywebview does for its own calls."""
    if not getattr(native, "InvokeRequired", False):
        fn()
        return
    import clr  # noqa: F401  (pythonnet; Windows only)
    from System import Func, Type
    native.Invoke(Func[Type](fn))


def _save_dialog(form, suggested):
    """Where an allowed download (one of the engine's own exports) goes. Runs on the UI thread inside
    the DownloadStarting event, like pywebview's own version. → path or None (cancelled)."""
    import clr  # noqa: F401
    clr.AddReference("System.Windows.Forms")
    import System.Windows.Forms as WinForms
    dialog = WinForms.SaveFileDialog()
    dialog.FileName = suggested
    dialog.RestoreDirectory = True
    dialog.Filter = "All files (*.*)|*.*"
    if dialog.ShowDialog(form) == WinForms.DialogResult.OK:
        return str(dialog.FileName)
    return None


def _webview2_control(native):
    """pywebview's BrowserForm holds the WebView2 WinForms control as `webview` (6.x: also
    `browser.webview`); the attribute path has moved between versions, so try the known ones."""
    for path in (("webview",), ("browser", "webview")):
        obj = native
        for name in path:
            obj = getattr(obj, name, None)
            if obj is None:
                break
        if obj is not None and hasattr(obj, "CoreWebView2InitializationCompleted"):
            return obj
    return None


def _core_webview2(native):
    """Kept for the VM list's wording: the initialised CoreWebView2 of the control, or None."""
    wv = _webview2_control(native)
    return getattr(wv, "CoreWebView2", None) if wv is not None else None
