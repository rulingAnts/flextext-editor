"""webview_hooks on FAKE WebView2 objects (the real wiring is V-10 on the VM). Pins what the first
VM launch taught: install() must wait for the window and attach once CoreWebView2 exists, and the
handlers must coexist with pywebview's own (which run first)."""
import threading

import pytest

from flexshell import navguard, webview_hooks

PORT = 8017
OWN = "http://127.0.0.1:%d" % PORT


class Event:
    """.NET-style event: `+=` subscribes, fire() calls every handler."""
    def __init__(self):
        self.handlers = []

    def __iadd__(self, h):
        self.handlers.append(h)
        return self

    def fire(self, sender, args):
        for h in list(self.handlers):
            h(sender, args)


class Settings:
    AreDevToolsEnabled = True
    AreDefaultContextMenusEnabled = True
    IsStatusBarEnabled = True
    AreBrowserAcceleratorKeysEnabled = True


class Core:
    def __init__(self):
        self.Settings = Settings()
        self.NavigationStarting = Event()
        self.FrameNavigationStarting = Event()
        self.NewWindowRequested = Event()
        self.DownloadStarting = Event()


class Args:
    def __init__(self, **kw):
        self.Cancel = False
        self.Handled = False
        self.__dict__.update(kw)


class Download:
    def __init__(self, uri):
        self.Uri = uri


def _attached(opener=None, chooser=None, now=None):
    core = Core()
    kw = {"now": now} if now else {}
    h = webview_hooks.attach(core, PORT, opener=opener, release=True, chooser=chooser, **kw)
    return core, h


def test_release_settings_lock_the_browser_ui_down():
    core, _ = _attached()
    s = core.Settings
    assert (s.AreDevToolsEnabled, s.AreDefaultContextMenusEnabled, s.IsStatusBarEnabled,
            s.AreBrowserAcceleratorKeysEnabled) == (False, False, False, False)
    core2 = Core()
    webview_hooks.attach(core2, PORT, release=False)
    assert core2.Settings.AreDevToolsEnabled is True


def test_top_navigation_offsite_is_cancelled_and_handed_to_the_os_browser_once():
    opened = []
    core, _ = _attached(opener=opened.append)
    a = Args(Uri="https://example.com/x")
    core.NavigationStarting.fire(core, a)
    assert a.Cancel and opened == ["https://example.com/x"]
    own = Args(Uri=OWN + "/index.html")
    core.NavigationStarting.fire(core, own)
    assert not own.Cancel
    bad = Args(Uri="file:///C:/Windows/win.ini")
    core.NavigationStarting.fire(core, bad)
    assert bad.Cancel and opened == ["https://example.com/x"]


def test_new_window_is_decided_once_even_though_pywebview_reissues_it_as_a_navigation():
    """pywebview's own NewWindowRequested handler (runs first) calls load_url(uri) on THIS window.
    That follow-up NavigationStarting must be cancelled WITHOUT a second OS-browser open."""
    opened = []
    t = [100.0]
    core, _ = _attached(opener=opened.append, now=lambda: t[0])
    nw = Args(Uri="https://example.com/popup")
    core.NewWindowRequested.fire(core, nw)
    assert nw.Handled and opened == ["https://example.com/popup"]
    follow = Args(Uri="https://example.com/popup")
    core.NavigationStarting.fire(core, follow)
    assert follow.Cancel and opened == ["https://example.com/popup"], "no double open"
    # the memory is one-shot and short: the same URL later is an ordinary top navigation again
    again = Args(Uri="https://example.com/popup")
    core.NavigationStarting.fire(core, again)
    assert again.Cancel and opened == ["https://example.com/popup"] * 2
    # own-origin new window: refused by policy, and pywebview's follow-up navigation is cancelled too
    own = Args(Uri=OWN + "/")
    core.NewWindowRequested.fire(core, own)
    follow_own = Args(Uri=OWN + "/")
    core.NavigationStarting.fire(core, follow_own)
    assert own.Handled and follow_own.Cancel
    # a stale memory expires
    core.NewWindowRequested.fire(core, Args(Uri="https://example.com/old"))
    t[0] += webview_hooks.RECENT_NEW_WINDOW_S + 1
    late = Args(Uri="https://example.com/old")
    core.NavigationStarting.fire(core, late)
    assert late.Cancel and opened[-1] == "https://example.com/old" and opened.count("https://example.com/old") == 2


def test_downloads_only_our_blobs_and_only_where_the_user_says():
    asked = []
    core, _ = _attached(chooser=lambda name: asked.append(name) or "C:\\out\\" + name)
    # pywebview's handler (ALLOW_DOWNLOADS=False) has already set Cancel=True when ours runs
    ok = Args(DownloadOperation=Download("blob:" + OWN + "/uuid-1"), ResultFilePath="C:\\Users\\x\\Downloads\\text.zip", Cancel=True)
    core.DownloadStarting.fire(core, ok)
    assert ok.Cancel is False and ok.Handled and ok.ResultFilePath == "C:\\out\\text.zip" and asked == ["text.zip"]
    bad = Args(DownloadOperation=Download("https://example.com/f.zip"), ResultFilePath="f.zip", Cancel=True)
    core.DownloadStarting.fire(core, bad)
    assert bad.Cancel and bad.Handled and asked == ["text.zip"], "a refused download never asks"
    foreign_blob = Args(DownloadOperation=Download("blob:https://example.com/u"), ResultFilePath="x", Cancel=True)
    core.DownloadStarting.fire(core, foreign_blob)
    assert foreign_blob.Cancel
    core2, _ = _attached(chooser=lambda name: None)
    cancelled = Args(DownloadOperation=Download("blob:" + OWN + "/uuid-2"), ResultFilePath="a.zip", Cancel=True)
    core2.DownloadStarting.fire(core2, cancelled)
    assert cancelled.Cancel, "user cancelled the Save dialog"


# ---- install(): the timing that failed on the VM -------------------------------------------------

class FakeControl:
    def __init__(self, core=None):
        self.CoreWebView2 = core
        self.CoreWebView2InitializationCompleted = Event()


class FakeNative:
    InvokeRequired = False   # the fake has no UI thread; _invoke calls straight through

    def __init__(self, control):
        self.webview = control


class FakeWindow:
    def __init__(self, native, shown=True):
        self.native = native if shown else None
        self.events = type("E", (), {"shown": threading.Event()})()
        if shown:
            self.events.shown.set()


def test_install_waits_for_webview2_initialisation_then_attaches():
    ctl = FakeControl(core=None)
    win = FakeWindow(FakeNative(ctl))
    out = {}

    def run():
        out["h"] = webview_hooks.install(win, PORT, release=True, timeout=5)
    th = threading.Thread(target=run)
    th.start()
    for _ in range(200):
        if ctl.CoreWebView2InitializationCompleted.handlers:
            break
        th.join(0.01)
    assert ctl.CoreWebView2InitializationCompleted.handlers, "subscribed to InitializationCompleted"
    assert th.is_alive(), "install() blocks until WebView2 is ready"
    core = Core()
    ctl.CoreWebView2 = core
    ctl.CoreWebView2InitializationCompleted.fire(ctl, Args(IsSuccess=True))
    th.join(5)
    assert not th.is_alive() and set(out["h"]) == {"nav", "frame", "new_window", "download"}
    assert core.NavigationStarting.handlers and core.DownloadStarting.handlers


def test_install_attaches_at_once_when_webview2_is_already_there():
    core = Core()
    win = FakeWindow(FakeNative(FakeControl(core=core)))
    h = webview_hooks.install(win, PORT, timeout=5)
    assert h["nav"] in core.NavigationStarting.handlers


def test_install_refuses_when_initialisation_fails_or_the_window_never_shows():
    ctl = FakeControl(core=None)
    win = FakeWindow(FakeNative(ctl))
    err = {}

    def run():
        try:
            webview_hooks.install(win, PORT, timeout=5)
        except RuntimeError as e:
            err["e"] = str(e)
    th = threading.Thread(target=run)
    th.start()
    for _ in range(200):
        if ctl.CoreWebView2InitializationCompleted.handlers:
            break
        th.join(0.01)
    ctl.CoreWebView2InitializationCompleted.fire(ctl, Args(IsSuccess=False, InitializationException="E_ABORT"))
    th.join(5)
    assert "E_ABORT" in err["e"]
    with pytest.raises(RuntimeError, match="not shown"):
        webview_hooks.install(FakeWindow(None, shown=False), PORT, timeout=0.05)
    with pytest.raises(RuntimeError, match="WebView2 control"):
        webview_hooks.install(FakeWindow(object()), PORT, timeout=0.05)


def test_dev_mode_opens_devtools_itself_release_does_not():
    """Accelerator keys and context menus stay off in both modes, so DevTools can only come up
    if the shell opens them."""
    class DevCore(Core):
        def __init__(self):
            super().__init__()
            self.opened = 0

        def OpenDevToolsWindow(self):
            self.opened += 1
    c = DevCore()
    webview_hooks.attach(c, PORT, release=False)
    assert c.opened == 1 and c.Settings.AreDevToolsEnabled is True and c.Settings.AreBrowserAcceleratorKeysEnabled is False
    r = DevCore()
    webview_hooks.attach(r, PORT, release=True)
    assert r.opened == 0 and r.Settings.AreDevToolsEnabled is False
