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
import time
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
STRUCT = ["aaa bbb ccc", "ddd eee fff", "ggg hhh"]
WS_PARAS = ["aaa bbb ccc", "ddd eee fff"]
WS2_PARAS = ["kkk lll mmm", "nnn ooo"]
WS3_PARAS = ["kkk lll kkk", "nnn ooo"]
WS_NAMES = {"xx": "Example", "xx-x-ipa": "Example IPA", "en": "English", "id": "Indonesian"}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wav(path, seconds=5.0, rate=8000):
    """Three 1.2 s bursts of tone with 0.6 s pauses between them: what the Segmenter's cut-by-pauses
    needs to find three lines (segments.js GUESS_MIN_GAP_MS 350, GUESS_MIN_LINE_MS 900)."""
    import math
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = bytearray()
    for i in range(int(seconds * rate)):
        t = i / rate
        on = (t % 1.8) < 1.2
        v = int(8000 * math.sin(2 * math.pi * 220 * t)) if on else 0
        frames += int(v).to_bytes(2, "little", signed=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))
    return str(path)


class Clipboard:
    def __init__(self):
        self.text = None

    def __call__(self, text):
        self.text = text
        return True


class Picker:
    def __init__(self):
        self.answer = None
        self.calls = []

    def __call__(self, kind, start_dir=""):
        self.calls.append([kind, start_dir])
        return self.answer


def flex_edit(projects, project, title, edits):
    """FLEx changes a text while the shell has let go of it (the check-in merge, plan §4.5): free
    translations and word glosses, through the mock backend as FLEx would make them."""
    b = MockLcm(projects)
    b.open(project, write=True)
    try:
        guid = next(t["guid"] for t in b.list_texts() if t["title"] == title)
        segs = [s for p in b.read_text(guid)["paragraphs"] for s in p["segments"]]
        h = b.begin_uow("FLEx", "FLEx")
        for e in edits:
            s = segs[e["line"]]
            if e["kind"] == "ft":
                b.set_free_translation(s["guid"], e["ws"], e["value"])
            elif e["kind"] == "gloss":
                a = s["analyses"][e["word"]]
                b.set_analysis(s["guid"], e["word"], b.create_gloss(b.create_trivial_analysis(a["wordformGuid"]), {e["ws"]: e["value"]}))
        b.commit(h)
        b.save()
    finally:
        b.close_project()
    return True


def flex_read(projects, project, title):
    """What FLEx holds for a text, read straight from its file — every writing system of every gloss and
    translation, the ones the app never shows included: [{ft, lt, words: [{form, kind, gloss}]}] per phrase."""
    b = MockLcm(projects)
    b.open(project, write=False)
    try:
        guid = next(t["guid"] for t in b.list_texts() if t["title"] == title)
        return [{"ft": s["ft"], "lt": s["lt"], "words": [{"form": a.get("form"), "kind": a["kind"], "gloss": a.get("gloss") or {}}
                                                          for a in s["analyses"]]}
                for p in b.read_text(guid)["paragraphs"] for s in p["segments"]]
    finally:
        b.close_without_save()


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
    # the Matcher's ✂ and ⤴ on a FLEx text: phrases with free translations and no stops (so FLEx can join
    # them), and a link that resolves; a marked disposable copy, so writes are allowed
    MockLcm.create_project(str(projects), "struct-write", texts=[{"title": "Struct text", "paragraphs": STRUCT, "media": [in_lf]}])
    (projects / "struct-write" / "flextext-disposable-copy.txt").write_text("disposable copy for the e2e test")
    b = MockLcm(str(projects))
    b.open("struct-write", write=True)
    doc = b.read_text(b.list_texts()[0]["guid"])
    h = b.begin_uow("fixture", "fixture")
    for i, para in enumerate(doc["paragraphs"]):
        for seg in para["segments"]:
            b.set_free_translation(seg["guid"], "en", "the free translation of line %d" % (i + 1))
    b.commit(h)
    b.save()
    b.close_project()
    # the text list's sort and filter: genres and FLEx dates (made up)
    MockLcm.create_project(str(projects), "list-proj", texts=[
        {"title": "Text 10", "paragraphs": ["aaa bbb"], "media": [in_lf], "genres": ["Narrative"], "created": "2024-03-01 00:00:00.000"},
        {"title": "Text 9", "paragraphs": ["ccc ddd"], "media": [in_lf], "genres": ["Narrative", "Procedural"], "created": "2024-01-01 00:00:00.000"},
        {"title": "\u00c1gua", "paragraphs": ["eee fff"], "media": [in_lf], "created": "2024-02-01 00:00:00.000"},
        {"title": "bridge", "paragraphs": ["ggg hhh"], "media": [in_lf], "genres": ["Procedural"], "created": "2023-12-01 00:00:00.000"},
    ])
    # the check-in merge: FLEx changes the text between the check-out and the check-in
    MockLcm.create_project(str(projects), "merge-write", texts=[{"title": "Merge text", "paragraphs": STRUCT, "media": [in_lf]}])
    (projects / "merge-write" / "flextext-disposable-copy.txt").write_text("disposable copy for the e2e test")
    b = MockLcm(str(projects))
    b.open("merge-write", write=True)
    doc = b.read_text(b.list_texts()[0]["guid"])
    h = b.begin_uow("fixture", "fixture")
    for i, para in enumerate(doc["paragraphs"]):
        b.set_free_translation(para["segments"][0]["guid"], "en", "line %d" % (i + 1))
    b.commit(h)
    b.save()
    b.close_project()
    # per-text writing systems: two vernacular (an IPA alternative for one word) and two analysis writing
    # systems, translated and glossed in both — Indonesian more, so the text opens in it. "Glossed text" is
    # glossed and translated in Indonesian, one word in English too: what an older build, which read FLEx's
    # FIRST analysis writing system only, showed with no glosses and no translations at all.
    MockLcm.create_project(str(projects), "ws-write", texts=[{"title": "Two languages", "paragraphs": WS_PARAS, "media": [in_lf]},
                                                             {"title": "Glossed text", "paragraphs": WS2_PARAS, "media": [in_lf]}],
                           vern_wss=("xx", "xx-x-ipa"), anal_wss=("en", "id"), ws_names=WS_NAMES)
    (projects / "ws-write" / "flextext-disposable-copy.txt").write_text("disposable copy for the e2e test")
    b = MockLcm(str(projects))
    b.open("ws-write", write=True)
    by_title = {x["title"]: x["guid"] for x in b.list_texts()}
    t = b.read_text(by_title["Two languages"])
    s0, s1 = t["paragraphs"][0]["segments"][0], t["paragraphs"][1]["segments"][0]
    h = b.begin_uow("fixture", "fixture")
    b.set_free_translation(s0["guid"], "en", "first in English")
    b.set_free_translation(s0["guid"], "id", "pertama")
    b.set_free_translation(s1["guid"], "id", "kedua")
    an = b.create_trivial_analysis(s0["analyses"][0]["wordformGuid"])
    b.set_analysis(s0["guid"], 0, b.create_gloss(an, {"en": "A-en", "id": "A-id"}))
    t2 = b.read_text(by_title["Glossed text"])
    for k, para in enumerate(t2["paragraphs"]):
        seg = para["segments"][0]
        b.set_free_translation(seg["guid"], "id", ["satu", "dua"][k])
        for i, a in enumerate(seg["analyses"]):
            form = a["form"].upper()[0]
            glosses = {"id": form + "-id", **({"en": form + "-en"} if (k, i) == (0, 0) else {})}
            b.set_analysis(seg["guid"], i, b.create_gloss(b.create_trivial_analysis(a["wordformGuid"]), glosses))
    b.commit(h)
    b.add_form_alternative("eee", "xx-x-ipa", "\u025b\u025b\u025b")
    b.save()
    b.close_project()
    # every analysis writing system kept and editable (2026-10-16): English and Indonesian are the project's
    # current ones; French is on some glosses and translations but NOT current — the app never shows it, and
    # a save must leave it exactly as it is. "kkk" twice in line 1, sharing one gloss.
    MockLcm.create_project(str(projects), "ws-all", texts=[{"title": "Every language", "paragraphs": WS3_PARAS, "media": [in_lf]}],
                           anal_wss=("en", "id"), ws_names=WS_NAMES)
    (projects / "ws-all" / "flextext-disposable-copy.txt").write_text("disposable copy for the e2e test")
    b = MockLcm(str(projects))
    b.open("ws-all", write=True)
    t = b.read_text(b.list_texts()[0]["guid"])
    s0, s1 = t["paragraphs"][0]["segments"][0], t["paragraphs"][1]["segments"][0]
    h = b.begin_uow("fixture", "fixture")
    b.set_free_translation(s0["guid"], "en", "one")
    b.set_free_translation(s0["guid"], "id", "satu")
    b.set_free_translation(s0["guid"], "fr", "un")
    b.set_free_translation(s1["guid"], "en", "two")
    shared = b.create_gloss(b.create_trivial_analysis(s0["analyses"][0]["wordformGuid"]), {"en": "K-en", "id": "K-id", "fr": "K-fr"})
    b.set_analysis(s0["guid"], 0, shared)
    b.set_analysis(s0["guid"], 2, shared)
    b.set_analysis(s0["guid"], 1, b.create_gloss(b.create_trivial_analysis(s0["analyses"][1]["wordformGuid"]), {"en": "L-en", "id": "L-id"}))
    b.commit(h)
    b.save()
    b.close_project()
    # FLEx's guesses (2026-10-16): "kkk" glossed and approved in one text, unanalysed in another — FLEx shows its
    # guess there — and that text timed 0–3 s of a 5 s recording, so the Matcher has audio past its last line
    MockLcm.create_project(str(projects), "guess-write", texts=[{"title": "Glossed elsewhere", "paragraphs": ["kkk lll", "nnn ppp"]},
                                                                {"title": "Guessed here", "paragraphs": ["kkk mmm", "nnn ooo"], "media": [in_lf]}],
                           anal_wss=("en", "id"), ws_names=WS_NAMES)
    (projects / "guess-write" / "flextext-disposable-copy.txt").write_text("disposable copy for the e2e test")
    b = MockLcm(str(projects))
    b.open("guess-write", write=True)
    by_title = {x["title"]: x["guid"] for x in b.list_texts()}
    there = b.read_text(by_title["Glossed elsewhere"])["paragraphs"]
    t = b.read_text(by_title["Guessed here"])
    h = b.begin_uow("fixture", "fixture")
    for line, gloss in ((0, "K-en"), (1, "N-en")):        # kkk and nnn glossed and approved there
        s0 = there[line]["segments"][0]
        an = b.create_trivial_analysis(s0["analyses"][0]["wordformGuid"])
        b.set_analysis(s0["guid"], 0, b.create_gloss(an, {"en": gloss}))
        b.set_evaluation(an, True)
    for k, para in enumerate(t["paragraphs"]):
        b.set_segment_times(para["segments"][0]["guid"], k * 1500, (k + 1) * 1500)
        b.set_segment_media(para["segments"][0]["guid"], t["media"][0]["guid"])
    b.commit(h)
    b.save()
    b.close_project()
    engine = stage_engine.stage(str(tmp / "engine"), "audio-segmenter", os.path.join(REPO, "docs"))
    picker = Picker()
    clip = Clipboard()
    slow = {}                                            # method → seconds: a real FLEx takes this long
    api = Api(MockBackendFactory(str(projects)), engine_root=engine, pick_file_fn=picker, copy_text_fn=clip,
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
            elif method == "__clipboard":
                out = {"ok": True, "result": clip.text}
            elif method == "__lock":                     # FLEx opens (True) or closes (False) a project: its lock file
                lock = projects / args[0] / (args[0] + ".fwdata.lock")
                if args[1]:
                    lock.write_text(json.dumps({"PID": os.getpid(), "ProcessName": "FieldWorks"}), encoding="utf-8")
                elif lock.exists():
                    lock.unlink()
                out = {"ok": True}
            elif method == "__flexEdit":                 # FLEx edits a text while the shell has let go of it
                out = {"ok": True, "result": flex_edit(str(projects), *args)}
            elif method == "__flexRead":                 # what FLEx's file holds, every writing system
                out = {"ok": True, "result": flex_read(str(projects), *args)}
            elif method == "__slow":                     # the test makes one shell method slow (or fast again)
                slow[args[0]] = float(args[1]) / 1000.0
                out = {"ok": True}
            elif method.startswith("_") or not callable(getattr(api, method, None)):
                out = {"ok": False, "error": {"code": "E_INTERNAL", "message": "no such method " + method}}
            else:
                if slow.get(method):
                    time.sleep(slow[method])
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
