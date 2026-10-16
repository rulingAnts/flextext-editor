"""What keeps the move to a shell that loads the live engine cheap (plans/flex-shell-live-path.md).

Not a migration: nothing here changes what the shell serves. These pin the few things that, if they
drifted now, would turn that later move from a change to a few functions into a data rescue."""

import os

from flexshell import app, navguard, server


def test_the_shells_origin_and_data_folder_never_change(monkeypatch):
    """IndexedDB and localStorage belong to an ORIGIN, and WebView2 keeps them in this folder. Every
    check-out — a FLEx text with work not yet saved back to FLEx — lives there and nowhere else. A
    later shell, whatever it loads, must be able to open THIS origin in THIS folder once more to carry
    that work across (plan §3.1); a port or folder changed in passing would strand it instead."""
    assert server.DEFAULT_PORT == 8017
    assert navguard.own_origin(server.DEFAULT_PORT) == "http://127.0.0.1:8017"
    monkeypatch.setenv("LOCALAPPDATA", os.path.join("C:", os.sep, "Users", "u", "AppData", "Local"))
    assert app.storage_path() == os.path.join("C:", os.sep, "Users", "u", "AppData", "Local",
                                              "FlexTextSegmenterFLEx", "webview")


def test_media_urls_are_made_in_one_place():
    """Where a recording is served from is the shell's decision, made in api._media_url alone (plan
    §3.2): the engine treats the URL as opaque. A second spelling of the path anywhere in api.py
    would be a second place to find and change on the day the page's origin is not the server's."""
    src = open(os.path.join(os.path.dirname(app.__file__), "api.py"), encoding="utf-8").read()
    assert '"/media/"' not in src and "'/media/'" not in src, "spelled out instead of MEDIA_PREFIX"
    assert src.count("self._media.register(") == 1, "a media token minted outside _media_url"
    assert "return MEDIA_PREFIX + self._media.register(path)" in src
    assert server.MEDIA_PREFIX == "/media/"
