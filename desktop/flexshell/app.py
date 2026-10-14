"""Entry point: start the local server, create the one window, install the navigation guard,
run (plan §2). Windows only at runtime; importing this module on Linux is fine (lazy imports)."""

import os
import sys

from . import SHELL_VERSION
from .server import DEFAULT_PORT, start as start_server, probe_nonce


def storage_path():
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(base, "FlexTextSegmenterFLEx", "webview")


def engine_root():
    """The staged engine: inside the installed package (a pip install stages it at build time, see
    setup.py), beside the executable (PyInstaller --onedir), or in the source tree's build folder.
    FLEXSHELL_ENGINE overrides (a folder holding a staged engine's index.html)."""
    env = os.environ.get("FLEXSHELL_ENGINE")
    here = os.path.dirname(os.path.abspath(sys.argv[0] if getattr(sys, "frozen", False) else __file__))
    for cand in ([env] if env else []) + [os.path.join(here, "engine"), os.path.join(here, "..", "build", "engine")]:
        if cand and os.path.isfile(os.path.join(cand, "index.html")):
            return os.path.realpath(cand)
    raise SystemExit("engine bundle not found — pip install from the repository (which stages it), or run "
                     "desktop/build/stage_engine.py and set FLEXSHELL_ENGINE")


def startup_line(root):
    """One console line naming the build: shell version, engine version, source commit (from
    engine-version.json, written by stage_engine). The first thing to read when a fix "did not
    take" — pip has been seen to keep an older install while resolving a newer commit."""
    import json
    info = {}
    try:
        with open(os.path.join(root, "engine-version.json"), "r", encoding="utf-8") as f:
            info = json.load(f)
    except (OSError, ValueError):
        pass
    return "FlexText Segmenter for FLEx: shell %s, engine %s, source %s" % (
        SHELL_VERSION, info.get("engineVersion") or "?", info.get("source") or "?")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    port = int(os.environ.get("FLEXSHELL_PORT", DEFAULT_PORT))
    if sys.platform != "win32":
        raise SystemExit("The FLEx shell runs on Windows only (WebView2 + LibLCM). Tests run anywhere: "
                         "python -m pytest desktop/tests")
    import webview   # pywebview — lazy: the test suite must import this package without it

    from .api import Api
    from .lcm_real import RealBackendFactory

    root = engine_root()
    sys.stderr.write(startup_line(root) + "\n")
    api = Api(backend_factory=RealBackendFactory(), engine_root=root)
    srv = start_server(root, port=port, connect_origins=api.connect_origins(), media=api.media)
    api.attach_server(srv)

    # pywebview must never open a browser itself: a NewWindowRequested becomes a navigation of THIS
    # window instead, which the guard then decides (webview_hooks module docstring).
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = False
    webview.settings["ALLOW_DOWNLOADS"] = False   # the guard re-allows our own blobs, with a Save dialog

    window = webview.create_window("FlexText Segmenter for FLEx", srv.origin + "/", js_api=api,
                                   width=1280, height=860, text_select=True)

    def install_guard():
        # Runs in pywebview's own thread as soon as the GUI loop starts, before the window exists;
        # install() waits for the window and attaches on the UI thread when WebView2 is ready.
        from . import webview_hooks
        try:
            webview_hooks.install(window, port, release=not os.environ.get("FLEXSHELL_DEVTOOLS") == "1")
        except Exception as e:   # noqa: BLE001 — refuse to run unguarded
            sys.stderr.write("navigation guard could not be installed: %s\n" % e)
            window.destroy()
            os._exit(2)   # SystemExit here would end only this thread; the GUI loop must not survive
        api.set_window(window)

    # private_mode=False + storage_path: pywebview's default private mode would wipe IndexedDB on exit.
    # gui='edgechromium' only: refuse any other backend (plan §2.2 item 3).
    webview.start(install_guard, gui="edgechromium", private_mode=False, storage_path=storage_path(), debug=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
