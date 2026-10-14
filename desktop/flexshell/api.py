"""The js_api object pywebview exposes as window.pywebview.api (plan §3).

ONE dispatcher: every public method is wrapped so that nothing ever raises into JS — the answer is
{ok: true, result} or {ok: false, error: {code, message, detail}}. Every LCM call runs on the single
worker thread; long operations return {jobId} and the engine polls job_status. Strings are NFC on
the JS side; the port normalises to NFD on the way in and NFC on the way out.

There is NO HTTP endpoint for any of this (plan §2.2 item 7): the bridge is in-process only.
"""

import functools
import os
import sys
import tempfile
import threading
import traceback

from . import FLEX_CONTRACT, SHELL_VERSION
from . import copyonly, prechecks
from .errors import FlexError
from .protocol import Session
from .server import MediaRegistry
from .worker import ProjectRegistry, Worker

# The relay workers the engine may talk to (CSP connect-src): production, and the staging worker a
# device opts into with ?devworker=staging (app.js DEFAULT_WORKER / STAGING_WORKER). Data, never content.
RELAY_ORIGINS = ("https://connect.flextext.app", "https://flextext-r2-worker-staging.68mh29kgsd.workers.dev")


def _ok(result):
    return {"ok": True, "result": result}


def _err(e):
    if isinstance(e, FlexError):
        return {"ok": False, "error": e.to_dict()}
    return {"ok": False, "error": {"code": "E_INTERNAL", "message": "%s: %s" % (type(e).__name__, e),
                                   "detail": {"trace": traceback.format_exc(limit=3)}}}


def exposed(fn):
    """Wrap a method: never raise into JS."""
    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        try:
            return _ok(fn(self, *args, **kwargs))
        except BaseException as e:   # noqa: BLE001
            return _err(e)
    wrapper.__exposed__ = True
    return wrapper


class Api:
    def __init__(self, backend_factory, engine_root=None, stamp_dir=None, projects_dir=None, export_dir=None,
                 worker=None, opener=None, copy_text_fn=None, pick_file_fn=None):
        self._factory = backend_factory
        self._engine_root = engine_root
        self._projects_dir = projects_dir or getattr(backend_factory, "projects_dir", None)
        self._copy_only = copyonly.is_copy_only(stamp_dir or engine_root)
        self.media = MediaRegistry()
        self.worker = worker or Worker(name="flexshell-lcm")
        self.registry = ProjectRegistry()
        self.session = None
        self.server = None
        self.window = None
        self._export_dir = export_dir or os.path.join(tempfile.gettempdir(), "FlexTextSegmenterFLEx", "exports")
        self._opener = opener
        self._copy_text = copy_text_fn
        self._pick_file = pick_file_fn
        self._lock = threading.Lock()

    # ---- wiring --------------------------------------------------------------------------------
    def attach_server(self, server):
        self.server = server
        self.media = server.media

    def set_window(self, window):
        self.window = window

    def connect_origins(self):
        return list(RELAY_ORIGINS)

    def _install_info(self):
        info = {"fwVersion": None, "lcmVersion": None, "modelVersion": None, "projectsDir": self._projects_dir, "backend": "none"}
        try:
            info.update(self._factory.install_info())
        except Exception:   # noqa: BLE001
            pass
        return info

    # ---- the bridge ----------------------------------------------------------------------------
    @exposed
    def hello(self):
        """No LCM work (plan §3)."""
        info = self._install_info()
        return {"contract": FLEX_CONTRACT, "shellVersion": SHELL_VERSION, "engineVersion": _engine_version(self._engine_root),
                "fwVersion": info.get("fwVersion"), "lcmVersion": info.get("lcmVersion"), "modelVersion": info.get("modelVersion"),
                "python": sys.version.split()[0], "copyOnly": self._copy_only,
                "capabilities": {"offsiteAuth": False, "clipboard": sys.platform == "win32", "fileDialog": self.window is not None,
                                 "write": True, "import": True, "export": True, "media": True}}

    @exposed
    def list_projects(self):
        """Pure filesystem (plan §5.3 B). Never opens a project."""
        info = self._install_info()
        root = self._projects_dir
        if not root or not os.path.isdir(root):
            return []
        out = []
        for name in sorted(os.listdir(root)):
            folder = os.path.join(root, name)
            if not os.path.isdir(folder) or not os.path.isfile(os.path.join(folder, name + ".fwdata")) and not os.path.isfile(os.path.join(folder, name + ".bak")):
                continue
            marker = copyonly.project_is_disposable_copy(folder, name)
            r = prechecks.check_project(folder, name, info.get("modelVersion"), copy_only=self._copy_only, marker_ok=marker)
            r["disposableCopy"] = marker
            out.append(r)
        return out

    @exposed
    def open_project(self, name, mode="read"):
        if mode not in ("read", "write"):
            raise FlexError("E_SCOPE", "mode must be read or write", {"mode": mode})
        if not isinstance(name, str) or not name or os.sep in name or "/" in name or name.startswith("."):
            raise FlexError("E_NOT_FOUND", "no such project", {})
        folder = os.path.join(self._projects_dir, name)
        if not os.path.isdir(folder):
            raise FlexError("E_NOT_FOUND", "no such project", {"project": name})
        info = self._install_info()
        marker = copyonly.project_is_disposable_copy(folder, name)
        report = prechecks.check_project(folder, name, info.get("modelVersion"), copy_only=self._copy_only and mode == "write", marker_ok=marker)
        if mode == "write":
            prechecks.require_write(report)
            copyonly.check_write_allowed(folder, name, self._copy_only)   # B6, fail closed
        else:
            prechecks.require_read(report)
        self.registry.claim(name)

        def job(j):
            port = self._factory()
            try:
                return Session(port, name, mode == "write", self._copy_only, marker)
            except Exception:
                try:
                    port.close_without_save()
                except Exception:   # noqa: BLE001
                    pass
                raise
        try:
            self.session = self.worker.run("open_project", job)
        except Exception:
            self.registry.release()
            raise
        ws = self.session.port.writing_systems()
        return {"session": name, "writable": mode == "write", "reasons": report["reasons"], "ws": ws,
                "printViewConfig": _print_view_config(folder), "glossWsDefaults": [w["id"] for w in ws["anal"][:1]],
                "versions": self.session.port.versions()}

    def _need_session(self):
        if not self.session:
            raise FlexError("E_NOT_FOUND", "no project is open", {})
        return self.session

    @exposed
    def close_project(self):
        s = self._need_session()
        try:
            r = self.worker.run("close_project", lambda j: s.close())
        finally:
            self.session = None
            self.registry.release()
            self.media.clear()
        return r

    @exposed
    def list_texts(self):
        s = self._need_session()
        return self.worker.run("list_texts", lambda j: (s.guard(), s.port.list_texts())[1])

    @exposed
    def open_text(self, text_guid):
        s = self._need_session()
        urls = {}
        for m in self.worker.run("media", lambda j: (s.guard(), s.port.read_text(text_guid)["media"])[1]):
            if m["uri"] and os.path.isfile(m["uri"]):
                urls[m["guid"]] = "/media/" + self.media.register(m["uri"])
        return self.worker.run("open_text", lambda j: s.open_text(text_guid, urls))

    @exposed
    def close_text(self, text_guid):
        s = self._need_session()
        return self.worker.run("close_text", lambda j: s.close_text(text_guid))

    @exposed
    def preview_save(self, text_guid, base_rev, ops, post_state=None, chosen_wss=None):
        s = self._need_session()
        return self.worker.run("preview_save", lambda j: s.preview(text_guid, base_rev, ops, post_state, chosen_wss))

    def _job(self, label, fn):
        job = self.worker.submit(label, fn, write=True)
        return {"jobId": job.id}

    @exposed
    def save_to_flex(self, preview_token):
        s = self._need_session()
        return self._job("save_to_flex", lambda j: s.save(preview_token, progress=lambda m: setattr(j, "progress", m)))

    @exposed
    def undo_flex(self):
        s = self._need_session()
        return self._job("undo_flex", lambda j: s.undo_save(progress=lambda m: setattr(j, "progress", m)))

    @exposed
    def redo_flex(self):
        s = self._need_session()
        return self._job("redo_flex", lambda j: s.redo_save(progress=lambda m: setattr(j, "progress", m)))

    @exposed
    def relink_preview(self, text_guid, uri_guid, new_path):
        s = self._need_session()
        entry = s.texts.get(text_guid)
        base_rev = entry["baseRev"] if entry else None
        return self.worker.run("relink_preview", lambda j: s.preview(text_guid, base_rev, [{"op": "media.relink", "uriGuid": uri_guid, "path": new_path}], {}))

    @exposed
    def export_editor_bundle(self, text_guid):
        s = self._need_session()
        return self._job("export_editor_bundle", lambda j: s.export_editor_bundle(text_guid, self._export_dir))

    @exposed
    def get_media(self, text_guid):
        s = self._need_session()
        media = self.worker.run("get_media", lambda j: (s.guard(), s.port.read_text(text_guid)["media"])[1])
        tracks = []
        for m in media:
            exists = bool(m["uri"]) and os.path.isfile(m["uri"])
            tracks.append({"uriGuid": m["guid"], "url": ("/media/" + self.media.register(m["uri"])) if exists else None, "exists": exists,
                           "name": os.path.basename(m["uri"] or "")})
        return {"tracks": tracks}

    @exposed
    def import_preview(self, path):
        s = self._need_session()
        return self.worker.run("import_preview", lambda j: s.import_preview(path))

    @exposed
    def import_flextext(self, preview_token):
        s = self._need_session()
        return self._job("import_flextext", lambda j: s.import_flextext(preview_token, progress=lambda m: setattr(j, "progress", m)))

    @exposed
    def recover(self, choice):
        s = self._need_session()
        return self.worker.run("recover", lambda j: s.recover(choice))

    @exposed
    def printview_data(self, seg_guid):
        s = self._need_session()
        return self.worker.run("printview_data", lambda j: _printview_data(s, seg_guid))

    @exposed
    def copy_text(self, text):
        if not isinstance(text, str):
            raise FlexError("E_SCOPE", "text must be a string", {})
        fn = self._copy_text
        if fn is None:
            from .clipboard import copy_text as fn   # type: ignore[assignment]
        return {"copied": bool(fn(text))}

    @exposed
    def pick_file(self, kind):
        if kind not in ("media", "flextext"):
            raise FlexError("E_SCOPE", "kind must be media or flextext", {})
        if self._pick_file:
            return {"path": self._pick_file(kind)}
        if not self.window:
            raise FlexError("E_INTERNAL", "no window to open a dialog from", {})
        import webview
        types = ("Audio (*.wav;*.mp3;*.flac;*.m4a;*.ogg;*.webm)",) if kind == "media" else ("FLEx interlinear text (*.flextext)",)
        r = self.window.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=False, file_types=types)
        return {"path": r[0] if r else None}

    @exposed
    def open_external(self, url):
        from . import navguard
        if not navguard.external_url_ok(url):
            raise FlexError("E_SCOPE", "only http(s) URLs are handed to the browser", {})
        from .webview_hooks import _open_in_os_browser
        return {"opened": _open_in_os_browser(url, self._opener)}

    @exposed
    def job_status(self, job_id):
        return self.worker.status(job_id)


def _engine_version(root):
    try:
        with open(os.path.join(root, "js", "i18n.js"), "r", encoding="utf-8") as f:
            import re
            m = re.search(r"ENGINE_VERSION\s*=\s*['\"]([^'\"]+)['\"]", f.read())
            return m.group(1) if m else None
    except (OSError, TypeError):
        return None


def _print_view_config(folder):
    """ConfigurationSettings\\db$local$Settings.xml → key db$local$InterlinConfig_v3_Doc_PrintView
    (fallback _v2_): `InterlinLineChoices_v3,<flid>%<ws>%<True|False>[%name],…` (plan §10 item 1).
    [verified] the key exists and decodes on FW 9.3.12."""
    import xml.etree.ElementTree as ET
    p = os.path.join(folder, "ConfigurationSettings", "db$local$Settings.xml")
    if not os.path.isfile(p):
        return None
    try:
        root = ET.parse(p).getroot()
    except (ET.ParseError, OSError):
        return None
    vals = {}
    for el in root.iter():
        k = el.get("key") or el.get("name")
        if k and (el.text or el.get("value")):
            vals[k] = el.get("value") or el.text
    for key in ("db$local$InterlinConfig_v3_Doc_PrintView", "db$local$InterlinConfig_v2_Doc_PrintView"):
        v = vals.get(key)
        if v:
            return parse_line_choices(v)
    return None


def parse_line_choices(value):
    parts = value.split(",")
    lines = []
    for spec in parts[1:]:
        bits = spec.split("%")
        if len(bits) < 2:
            continue
        try:
            flid = int(bits[0])
        except ValueError:
            continue
        lines.append({"flid": flid, "ws": bits[1], "enabled": (bits[2].lower() == "true") if len(bits) > 2 else True,
                      "name": bits[3] if len(bits) > 3 else None})
    return {"version": parts[0], "lines": lines}


def _printview_data(s, seg_guid):
    """Plain data for docs/js/printview-tsv.js (plan §10): the segment's analyses with forms and
    glosses per WS, FT/LT/notes, its paragraph and segment numbers, the WS abbreviations."""
    s.guard()
    ws = s.port.writing_systems()
    for t in s.port.list_texts():
        rt = s.port.read_text(t["guid"])
        for pi, p in enumerate(rt["paragraphs"]):
            for si, seg in enumerate(p["segments"]):
                if seg["guid"] == seg_guid:
                    return {"textGuid": t["guid"], "paraNumber": pi + 1, "segNumber": si + 1, "segsInPara": len(p["segments"]),
                            "words": [{"form": a["form"], "punct": a["kind"] == "punct", "glosses": a.get("gloss") or {},
                                       "kind": a["kind"]} for a in seg["analyses"]],
                            "free": seg["ft"], "lit": seg["lt"], "notes": [{"text": n, "ws": (rt["analWss"] or ["en"])[0]} for n in seg["notes"]],
                            "ws": ws, "isLabel": seg["isLabel"]}
    raise FlexError("E_NOT_FOUND", "segment not found", {"seg": seg_guid})
