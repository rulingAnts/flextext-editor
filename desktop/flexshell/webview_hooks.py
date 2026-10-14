"""WebView2 wiring for the navigation guard — WINDOWS ONLY, imported lazily by app.py (plan §2.2).

Everything decided here is decided by navguard.decide(); this module only connects CoreWebView2's
events to it. If any hook cannot be installed, install() raises and the shell refuses to show the
window. [unverified] on real WebView2 (V-10, desktop/vm/test_navguard_e2e.py).
"""

import os

from . import navguard


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


def install(window, port, opener=None, release=True):
    """Attach the guard to pywebview's WinForms window (`window.native` → CoreWebView2).

    Settings (release builds): no DevTools, no default context menus, no status bar, no browser
    accelerator keys (F5 / Ctrl+P / Ctrl+L go nowhere), zoom control left as is.
    """
    native = getattr(window, "native", None)
    if native is None:
        raise RuntimeError("no native window — the guard cannot be installed")
    core = _core_webview2(native)
    if core is None:
        raise RuntimeError("CoreWebView2 not reachable — the guard cannot be installed")

    settings = core.Settings
    settings.AreDevToolsEnabled = not release
    settings.AreDefaultContextMenusEnabled = False
    settings.IsStatusBarEnabled = False
    settings.AreBrowserAcceleratorKeysEnabled = False

    def on_nav(sender, args):
        d = navguard.decide(str(args.Uri), navguard.KIND_TOP, port)
        if d == navguard.ALLOW:
            return
        args.Cancel = True
        if d == navguard.OPEN_EXTERNAL:
            _open_in_os_browser(str(args.Uri), opener)

    def on_frame_nav(sender, args):
        if navguard.decide(str(args.Uri), navguard.KIND_FRAME, port) != navguard.ALLOW:
            args.Cancel = True

    def on_new_window(sender, args):
        args.Handled = True   # never a second webview
        if navguard.decide(str(args.Uri), navguard.KIND_NEW_WINDOW, port) == navguard.OPEN_EXTERNAL:
            _open_in_os_browser(str(args.Uri), opener)

    def on_download(sender, args):
        src = str(args.DownloadOperation.Uri)
        if navguard.decide(src, navguard.KIND_DOWNLOAD, port) != navguard.ALLOW:
            args.Cancel = True
            args.Handled = True

    core.NavigationStarting += on_nav
    core.FrameNavigationStarting += on_frame_nav
    core.NewWindowRequested += on_new_window
    core.DownloadStarting += on_download
    return {"nav": on_nav, "frame": on_frame_nav, "new_window": on_new_window, "download": on_download}


def _core_webview2(native):
    """pywebview's EdgeChromium form holds the WebView2 control; reach CoreWebView2 through it.
    The attribute path has changed between pywebview versions, so try the known ones."""
    for path in (("web_view", "CoreWebView2"), ("browser", "web_view", "CoreWebView2"), ("CoreWebView2",)):
        obj = native
        ok = True
        for name in path:
            obj = getattr(obj, name, None)
            if obj is None:
                ok = False
                break
        if ok:
            return obj
    return None
