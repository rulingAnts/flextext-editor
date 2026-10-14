"""End-to-end harness (test-only, never shipped): the REAL bridge object (Api) over the mock FLEx
backend, the REAL local server serving the REAL staged engine, and a test-only RPC port that a headless
Chromium reaches through Playwright's exposeFunction — standing in for pywebview's js_api, which only
exists on Windows. The shipped shell has no HTTP endpoint for FLEx operations (plan §2.2 item 7); this
one lives in desktop/tests and is started only by test_e2e_*.py.

Made-up fixtures: projects, texts and recordings are generated here."""
import json
import os
import pathlib
import socket
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP = os.path.dirname(os.path.dirname(HERE))
REPO = os.path.dirname(DESKTOP)
sys.path.insert(0, DESKTOP)
sys.path.insert(0, os.path.join(DESKTOP, "build"))

from flexshell import server as srv                           # noqa: E402
from flexshell.api import Api                                  # noqa: E402
from flexshell.lcm_mock import MockBackendFactory, MockLcm     # noqa: E402
import stage_engine                                            # noqa: E402

OLD_LINK = "C:\\Old Machine\\Recordings\\Session-01.wav"
PARAS = ["aaa bbb ccc.", "ddd eee fff.", "ggg hhh."]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wav(path, seconds=3.0, rate=8000):
    """A short tone with two pauses, so the Cut tab has something to show."""
    import math
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = bytearray()
    for i in range(int(seconds * rate)):
        t = i / rate
        on = (t % 1.0) < 0.7
        v = int(8000 * math.sin(2 * math.pi * 220 * t)) if on else 0
        frames += int(v).to_bytes(2, "little", signed=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))
    return str(path)


class Picker:
    def __init__(self):
        self.answer = None
        self.calls = []

    def __call__(self, kind, start_dir=""):
        self.calls.append([kind, start_dir])
        return self.answer


def start(tmp):
    tmp = pathlib.Path(tmp)
    projects = tmp / "Projects"
    projects.mkdir(parents=True)
    texts = [{"title": "Missing link text", "paragraphs": PARAS, "media": [OLD_LINK]},
             {"title": "No link text", "paragraphs": PARAS}]
    MockLcm.create_project(str(projects), "media-proj", texts=texts)
    MockLcm.create_project(str(projects), "media-copy", texts=texts)
    MockLcm.create_project(str(projects), "media-write", texts=texts)          # a marked disposable copy: writes allowed
    (projects / "media-write" / "flextext-disposable-copy.txt").write_text("disposable copy for the e2e test")
    in_lf = wav(projects / "media-proj" / "LinkedFiles" / "AudioVisual" / "session-01.WAV")
    elsewhere = wav(tmp / "Elsewhere" / "another-name.wav")
    engine = stage_engine.stage(str(tmp / "engine"), "audio-segmenter", os.path.join(REPO, "docs"))
    picker = Picker()
    api = Api(MockBackendFactory(str(projects)), engine_root=engine, pick_file_fn=picker,
              state_dir=str(tmp / "state"), export_dir=str(tmp / "exports"))
    port = free_port()
    shell = srv.start(engine, port=port, connect_origins=api._connect_origins(), media=api._media)
    api._attach_server(shell)

    class Rpc(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            method, args = req.get("method", ""), req.get("args") or []
            if method == "__pick":                       # the test sets what the "dialog" answers next
                picker.answer = args[0] if args else None
                out = {"ok": True}
            elif method == "__pickCalls":
                out = {"ok": True, "result": picker.calls}
            elif method.startswith("_") or not callable(getattr(api, method, None)):
                out = {"ok": False, "error": {"code": "E_INTERNAL", "message": "no such method " + method}}
            else:
                out = getattr(api, method)(*args)        # the @exposed wrapper: never raises
            body = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    rpc = ThreadingHTTPServer(("127.0.0.1", free_port()), Rpc)
    threading.Thread(target=rpc.serve_forever, daemon=True).start()

    def stop():
        rpc.shutdown()
        rpc.server_close()
        shell.shutdown()
        shell.server_close()
        api._worker.stop()

    info = {"origin": shell.origin, "rpc": "http://127.0.0.1:%d/" % rpc.server_address[1],
            "inLinkedFiles": in_lf, "elsewhere": elsewhere, "oldLink": OLD_LINK, "projects": str(projects)}
    return info, stop
