"""The js_api object pywebview exposes as window.pywebview.api (plan §3).

ONE dispatcher: every public method is wrapped so that nothing ever raises into JS — the answer is
{ok: true, result} or {ok: false, error: {code, message, detail}}. Every LCM call runs on the single
worker thread; long operations return {jobId} and the engine polls job_status. Strings are NFC on
the JS side; the port normalises to NFD on the way in and NFC on the way out.

There is NO HTTP endpoint for any of this (plan §2.2 item 7): the bridge is in-process only.
"""

import functools
import logging
import os
import sys
import tempfile
import threading
import time
import traceback

from . import FLEX_CONTRACT, SHELL_VERSION
from . import copyonly, mediafind, prechecks, teamwrite, trace
from .errors import FlexError
from .protocol import Session
from .server import MediaRegistry
from .worker import ProjectRegistry, ThreadBound, Worker

# The relay workers the engine may talk to (CSP connect-src): production, and the staging worker a
# device opts into with ?devworker=staging (app.js DEFAULT_WORKER / STAGING_WORKER). Data, never content.
RELAY_ORIGINS = ("https://connect.flextext.app", "https://flextext-r2-worker-staging.68mh29kgsd.workers.dev")


def default_state_dir():
    """The shell's own data folder (beside pywebview's storage, app.storage_path)."""
    return os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "FlexTextSegmenterFLEx")


def _ok(result):
    return {"ok": True, "result": result}


def _err(e):
    if isinstance(e, FlexError):
        return {"ok": False, "error": e.to_dict()}
    return {"ok": False, "error": {"code": "E_INTERNAL", "message": "%s: %s" % (type(e).__name__, e),
                                   "detail": {"trace": traceback.format_exc(limit=3)}}}


TRACE = logging.getLogger("flexshell.bridge")
PAGE = logging.getLogger("flexshell.page")
# polled every 150 ms while a job runs (the worker traces each job's start, progress and end), and the
# page's own log lines (traced as what they say)
_QUIET = frozenset({"job_status", "client_log"})


def exposed(fn):
    """Wrap a method: never raise into JS. Every call is traced to the console with its arguments, how
    long it took and what it answered (trace.py); a refusal with its code, message and detail; an
    unexpected failure (a bug, not a refusal) with its whole exception, .NET parts included — the page
    shows one line, and the console is where a fix starts (Seth, 2026-10-16: "we want very verbose TTY
    debugging output, at least for now")."""
    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        name = fn.__name__
        loud = name not in _QUIET and TRACE.isEnabledFor(logging.DEBUG)
        t0 = time.monotonic()
        try:
            if loud:
                TRACE.debug("page → %s(%s)", name, ", ".join(trace.short(a, 240) for a in args))
        except Exception:   # noqa: BLE001 — a console that cannot be written never costs the answer
            pass
        try:
            result = fn(self, *args, **kwargs)
            try:
                if loud:
                    TRACE.debug("page ← %s ok in %d ms: %s", name, (time.monotonic() - t0) * 1000, trace.short(result, 300))
            except Exception:   # noqa: BLE001
                pass
            return _ok(result)
        except BaseException as e:   # noqa: BLE001
            out = _err(e)
            try:
                ms = (time.monotonic() - t0) * 1000
                if isinstance(e, FlexError):
                    TRACE.warning("page ← %s refused in %d ms: %s — %s%s", name, ms, e.code, e.message,
                                  (" | detail " + trace.short(e.detail, 1200)) if e.detail else "")
                else:
                    TRACE.error("page ← %s FAILED in %d ms:\n%s", name, ms, trace.exc_text(e))
            except Exception:   # noqa: BLE001
                pass
            return out
    wrapper.__exposed__ = True
    return wrapper


class Api:
    def __init__(self, backend_factory, engine_root=None, stamp_dir=None, projects_dir=None, export_dir=None,
                 worker=None, opener=None, copy_text_fn=None, pick_file_fn=None, state_dir=None):
        self._factory = backend_factory
        self._engine_root = engine_root
        self._projects_dir = projects_dir or getattr(backend_factory, "projects_dir", None)
        self._copy_only = copyonly.is_copy_only(stamp_dir or engine_root)
        self._state_dir = state_dir or default_state_dir()
        self._snapshot = None   # teamwrite snapshot of the write session open now (a team project), else None
        self._media = MediaRegistry()
        self._worker = worker or Worker(name="flexshell-lcm")
        self._registry = ProjectRegistry()
        self._session = None
        self._server = None
        self._window = None
        self._export_dir = export_dir or os.path.join(tempfile.gettempdir(), "FlexTextSegmenterFLEx", "exports")
        self._opener = opener
        self._copy_text = copy_text_fn
        self._pick_file = pick_file_fn
        self._lock = threading.Lock()
        # plan §8.4: what the user chose for links that point nowhere here (this machine only)
        self._memory = mediafind.MediaMemory(os.path.join(state_dir or default_state_dir(), "media-map.json"))
        self._offered = set()   # paths the shell itself proposed this session — the only ones use_media accepts
        self._adopted = {}      # text guid → {uriGuid or "": path} the user resolved this session

    # ---- wiring --------------------------------------------------------------------------------
    # ⚠ EVERYTHING pywebview can reach from this object without a leading underscore is exposed to the
    # page as window.pywebview.api.<name>, RECURSIVELY (util.parse_api_js walks every public attribute:
    # a public `worker` would hand JS worker.run()). So: every public member is an @exposed method and
    # nothing else — attributes and wiring are underscored. test_api pins the rule. Learned on the VM
    # (2026-10-14): a public `window` sent the walker into WinForms' AccessibilityObject.Bounds.Empty…
    # until "maximum recursion depth exceeded".
    def _attach_server(self, server):
        self._server = server
        self._media = server.media

    def _set_window(self, window):
        self._window = window

    def _connect_origins(self):
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
                "capabilities": {"offsiteAuth": False, "clipboard": sys.platform == "win32", "fileDialog": self._window is not None,
                                 "write": True, "import": True, "export": True, "media": True, "mediaFinder": True,
                                 "wsChoice": True, "wordJoin": True}}

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
            # a TEAM project (not a marked copy) is written through the before-write checklist and a snapshot
            # (teamwrite.py); the page shows the checklist first, and offers Recover… while a snapshot exists
            r["team"] = not marker
            r["sendReceive"] = teamwrite.send_receive_info(folder)
            r["snapshot"] = teamwrite.summary(teamwrite.latest_snapshot(self._state_dir, name))
            out.append(r)
        self._report_projects(out)
        return out

    def _report_projects(self, listing):
        """One console line per project whose state changed since the last listing: whether it can be read
        and written here, and what stops it — so "Open for writing is off" has its reason in the console
        too (2026-10-16). This machine's project names, in this machine's console; nothing leaves it."""
        now = {r["name"]: ("write" if r["writable"] else "read" if r["readable"] else "none", tuple(r["reasons"])) for r in listing}
        last = getattr(self, "_listed", {})
        try:
            for name, (can, why) in sorted(now.items()):
                if last.get(name) != (can, why):
                    sys.stderr.write("[flexshell] project %r: %s%s\n" % (name, {"write": "read and write", "read": "read only",
                                                                                 "none": "cannot open"}[can],
                                                                           (" — " + ", ".join(why)) if why else ""))
        except Exception:   # noqa: BLE001
            pass
        self._listed = now

    @exposed
    def write_plan(self, name):
        """What opening a project for writing involves (teamwrite.py): whether it is the team's project or a
        marked copy, its Send/Receive store and when it last moved, sharing, the snapshot it would take, and the
        snapshot there already. Pure filesystem."""
        folder = self._project_folder(name)
        info = self._install_info()
        marker = copyonly.project_is_disposable_copy(folder, name)
        r = prechecks.check_project(folder, name, info.get("modelVersion"), copy_only=self._copy_only, marker_ok=marker)
        fw = os.path.join(folder, name + ".fwdata")
        return {"name": name, "team": not marker, "sharing": r["sharing"], "lock": r["lock"], "reasons": r["reasons"],
                "writable": r["writable"], "writableWithChecklist": r["writableWithChecklist"],
                "sendReceive": teamwrite.send_receive_info(folder),
                "fwdataBytes": os.path.getsize(fw) if os.path.isfile(fw) else 0,
                "free": prechecks.free_space(self._state_dir if os.path.isdir(self._state_dir) else folder),
                "snapshot": teamwrite.summary(teamwrite.latest_snapshot(self._state_dir, name))}

    @exposed
    def open_project(self, name, mode="read", confirm=None):
        """`confirm` (write mode, a team project or sharing on): {sentReceived: bool, appsClosed: bool} — the
        before-write checklist the user confirmed (teamwrite.py). A team project opens for writing only with
        both, and only after a verified snapshot of its .fwdata; a marked copy needs neither."""
        if mode not in ("read", "write"):
            raise FlexError("E_SCOPE", "mode must be read or write", {"mode": mode})
        if not isinstance(name, str) or not name or os.sep in name or "/" in name or name.startswith("."):
            raise FlexError("E_NOT_FOUND", "no such project", {})
        if self._session is not None:   # before the pre-checks, which would otherwise report OUR OWN lock as another program's
            raise FlexError("E_ALREADY_OPEN", "a project is already open in this shell", {"open": self._registry.open_name})
        folder = os.path.join(self._projects_dir, name)
        if not os.path.isdir(folder):
            raise FlexError("E_NOT_FOUND", "no such project", {"project": name})
        info = self._install_info()
        marker = copyonly.project_is_disposable_copy(folder, name)
        report = prechecks.check_project(folder, name, info.get("modelVersion"), copy_only=self._copy_only and mode == "write", marker_ok=marker)
        confirm = confirm if isinstance(confirm, dict) else {}
        confirmed = set()
        if mode == "write":
            team = not marker
            if confirm.get("appsClosed") is True:
                confirmed.add("E_SHARING_ON")   # FLEx and every other program closed: the lock file's blind spot, covered
            prechecks.require_write(report, confirmed)
            copyonly.check_write_allowed(folder, name, self._copy_only)   # B6: a locked-down build, marked copies only
            if team and not (confirm.get("sentReceived") is True and confirm.get("appsClosed") is True):
                # fail closed: the team's project is written only after the checklist, whatever the page did
                raise FlexError("E_NEEDS_CONFIRM", "Send/Receive, then close FLEx and every other program using the project, and confirm both first",
                                {"project": name, "team": True})
        else:
            prechecks.require_read(report)
        self._registry.claim(name)
        snapshot = None
        if mode == "write" and not marker:
            try:
                snapshot = teamwrite.take_snapshot(self._state_dir, folder, name)   # before anything is written; refuses rather than skips
            except Exception:
                self._registry.release()
                raise

        def job(j):
            # EVERY port call on the worker thread, this read-back included: the eighth VM launch read
            # writing_systems() on the bridge thread after the open, the guard fired, and the session
            # it left open held the project's lock until the shell was restarted.
            port = ThreadBound(self._factory(), self._worker)
            try:
                session = Session(port, name, mode == "write", self._copy_only, marker)
                return session, port.writing_systems(), port.versions()
            except Exception:
                try:
                    port.close_without_save()
                except Exception:   # noqa: BLE001
                    pass
                raise
        try:
            self._session, ws, versions = self._worker.run("open_project", job)
        except Exception:
            self._registry.release()
            raise
        self._snapshot = snapshot
        return {"session": name, "writable": mode == "write", "reasons": report["reasons"], "ws": ws,
                "printViewConfig": _print_view_config(folder), "glossWsDefaults": [w["id"] for w in ws["anal"][:1]],
                "versions": versions, "team": not marker, "snapshot": teamwrite.summary(snapshot)}

    def _noted(self, s, what, fn, text_guid=None):
        """A write job on a team project: after it, the file's hash goes into the snapshot's record, so RECOVER
        can tell this shell's writes from FLEx's later edits (teamwrite.note_write)."""
        snap, name, state_dir = self._snapshot, self._registry.open_name, self._state_dir

        def run(j):
            r = fn(j)
            if snap:
                try:
                    teamwrite.note_write(state_dir, name, snap["id"], s.port.project_dir(), what, text_guid)
                except Exception:   # noqa: BLE001 — the write succeeded; a missing note costs a warning at recover time
                    pass
            return r
        return run

    @exposed
    def recover_plan(self, name):
        """What RECOVER would do to a project, and what stops it (teamwrite.recover_plan). Reads only."""
        folder = self._project_folder(name)
        if self._session is not None and self._registry.open_name == name:
            raise FlexError("E_ALREADY_OPEN", "close the project here first", {"open": name})
        lock, _info = prechecks.read_lock(folder, name)
        return teamwrite.recover_plan(self._state_dir, folder, name, lock)

    @exposed
    def recover_snapshot(self, name, snapshot_id):
        """RECOVER: put the snapshot's .fwdata back (teamwrite.recover): only with the project closed here and in FLEx,
        and only while no Send/Receive has happened since the snapshot."""
        folder = self._project_folder(name)
        if self._session is not None and self._registry.open_name == name:
            raise FlexError("E_ALREADY_OPEN", "close the project here first", {"open": name})
        lock, _info = prechecks.read_lock(folder, name)
        return teamwrite.recover(self._state_dir, folder, name, str(snapshot_id or ""), lock)

    def _project_folder(self, name):
        if not isinstance(name, str) or not name or os.sep in name or "/" in name or name.startswith("."):
            raise FlexError("E_NOT_FOUND", "no such project", {})
        folder = os.path.join(self._projects_dir or "", name)
        if not os.path.isfile(os.path.join(folder, name + ".fwdata")):
            raise FlexError("E_NOT_FOUND", "no such project", {"project": name})
        return folder

    @exposed
    def copy_plan(self, name):
        """What "Make a copy to write to…" would make of a project (plan §12.3). Reads only."""
        self._project_folder(name)
        return copyonly.copy_plan(self._projects_dir, name)

    @exposed
    def make_copy(self, name):
        """A disposable copy of a project, beside it, marked so this build may write to it, its Send/Receive
        repository left behind (plan §12.3) — a job. Only with no project open here, and the project free:
        a copy of a project something is saving could be a copy of half a save."""
        folder = self._project_folder(name)
        if self._session is not None:
            raise FlexError("E_ALREADY_OPEN", "close the project open here first", {"open": self._registry.open_name})
        lock, _info = prechecks.read_lock(folder, name)
        if lock == prechecks.LOCK_FLEX:
            raise FlexError("E_FLEX_HOLDS_PROJECT", prechecks.MESSAGES["E_FLEX_HOLDS_PROJECT"], {"project": name})
        if lock in (prechecks.LOCK_OTHER, prechecks.LOCK_BUSY):
            raise FlexError("E_LOCKED_OTHER", prechecks.MESSAGES["E_LOCKED_OTHER"], {"project": name})
        if prechecks.file_state(folder, name)["crashedSave"]:
            raise FlexError("E_CRASHED_SAVE_STATE", prechecks.MESSAGES["E_CRASHED_SAVE_STATE"], {"project": name})
        new = copyonly.copy_name(self._projects_dir, name)
        return self._job("make_copy", lambda j: copyonly.make_disposable_copy(self._projects_dir, name, new,
                                                                              progress=lambda p: setattr(j, "progress", p)))

    def _need_session(self):
        if not self._session:
            raise FlexError("E_NOT_FOUND", "no project is open", {})
        return self._session

    @exposed
    def close_project(self):
        s = self._need_session()
        try:
            r = self._worker.run("close_project", lambda j: s.close())
        finally:
            self._session = None
            self._snapshot = None
            self._registry.release()
            self._media.clear()
            with self._lock:
                self._offered.clear()
                self._adopted.clear()
        return r

    @exposed
    def list_texts(self):
        s = self._need_session()
        return self._worker.run("list_texts", lambda j: (s.guard(), s.port.list_texts())[1])

    @exposed
    def open_text(self, text_guid, ws=None):
        """The text in the engine's shape. `ws` = {vern, anal} chosen for this text from FLEx's own lists
        (plan §7.4); omitted, the text's own (what it is written and translated in)."""
        s = self._need_session()
        media, lf = self._worker.run("media", lambda j: (s.guard(), (s.port.read_text(text_guid)["media"], s.port.linked_files_dir()))[1])
        urls = {}
        for m in media:
            here = mediafind.link_path(m["uri"], lf)
            if here and os.path.isfile(here):
                urls[m["guid"]] = "/media/" + self._media.register(here)
        return self._worker.run("open_text", lambda j: s.open_text(text_guid, urls, ws))

    @exposed
    def text_ws(self, text_guid):
        """What one text uses, by writing system, and what it opens in — for choosing (plan §7.4)."""
        s = self._need_session()
        return self._worker.run("text_ws", lambda j: s.text_ws(text_guid))

    # ---- finding a recording whose FLEx link points nowhere here (plan §8.4) -------------------------
    # Pure filesystem; nothing here writes to FLEx, so it works in a read-only session. The engine
    # copies the chosen file into its own storage; FLEx's link is fixed only by a later Save to FLEx.
    def _text_media(self, s, text_guid):
        return self._worker.run("find_media", lambda j: (s.guard(), (s.port.read_text(text_guid)["media"],
                                                                     s.port.linked_files_dir(), s.port.project_dir()))[1])

    def _offer(self, path):
        with self._lock:
            self._offered.add(os.path.normcase(os.path.realpath(path)))

    def _start_dir(self, lf, project_dir):
        for d in self._memory.folders()[:1] + [os.path.join(lf or "", "AudioVisual"), lf, project_dir]:
            if d and os.path.isdir(d):
                return d
        return ""

    @exposed
    def find_media(self, text_guid):
        """For each media link of the text: whether it resolves here and, when it does not, where a
        file of that name might be — the file the user chose for this link before (if it still
        exists), then a bounded search of the folders recordings were found in, LinkedFiles and the
        project folder. Candidates are offers only: nothing is served until use_media."""
        s = self._need_session()
        media, lf, project_dir = self._text_media(s, text_guid)
        links = []
        for m in media:
            here = mediafind.link_path(m["uri"], lf)
            name = mediafind.link_name(m["uri"])
            entry = {"uriGuid": m["guid"], "link": m["uri"] or "", "name": name, "exists": False, "url": None, "candidates": []}
            if here and os.path.isfile(here):
                entry.update(exists=True, url="/media/" + self._media.register(here), path=here)
            else:
                found = []
                before = self._memory.lookup(m["uri"], s.name)
                if before:
                    found.append(mediafind.describe(before, remembered=True))
                roots = [(f, 1) for f in self._memory.folders()] + [(lf, 3), (project_dir, 2)]
                if here and os.path.isdir(os.path.dirname(here)):
                    roots.append((os.path.dirname(here), 0))
                seen = {os.path.normcase(os.path.realpath(c["path"])) for c in found}
                for p in mediafind.search(name, roots):
                    if os.path.normcase(os.path.realpath(p)) not in seen and mediafind.is_audio(p):
                        found.append(mediafind.describe(p))
                for c in found:
                    self._offer(c["path"])
                entry["candidates"] = found[:mediafind.MAX_CANDIDATES]
            links.append(entry)
        return {"links": links, "startDir": self._start_dir(lf, project_dir)}

    def _adopt(self, s, text_guid, uri_guid, path):
        """Serve a recording the user accepted for this text, and remember it (plan §8.4)."""
        media, lf, _pd = self._text_media(s, text_guid)
        link = None
        if uri_guid:
            m = next((x for x in media if x["guid"] == uri_guid), None)
            if m is None:
                raise FlexError("E_NOT_FOUND", "no such media link", {"uri": uri_guid})
            link = m["uri"]
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            raise FlexError("E_MEDIA_FILE_MISSING", "the chosen file does not exist", {})
        if not mediafind.is_audio(path):
            raise FlexError("E_MEDIA_NOT_AUDIO", "the chosen file is not a recording this app can use", {"ext": os.path.splitext(path)[1]})
        url = "/media/" + self._media.register(path)
        try:
            self._memory.remember(link, path, s.name)
        except OSError:
            pass   # a memory that cannot be written costs a question next time, never this choice
        with self._lock:
            self._adopted.setdefault(text_guid, {})[uri_guid or ""] = path
        return {"path": path, "url": url, "name": os.path.basename(path), "size": os.path.getsize(path),
                "uriGuid": uri_guid, "linkName": mediafind.link_name(link) if link else "",
                "linkExists": mediafind.link_exists(link, lf) if link else False}

    @exposed
    def use_media(self, text_guid, uri_guid, path):
        """Adopt a recording for this text: serve it and remember it. Only a file the shell itself
        offered — a find_media candidate or a choose_media pick — so a page cannot name an arbitrary
        file. The ONE place a choice is remembered: a pick the user then turns down is never reused."""
        s = self._need_session()
        if not isinstance(path, str) or not path:
            raise FlexError("E_SCOPE", "path must be a string", {})
        with self._lock:
            offered = os.path.normcase(os.path.realpath(path)) in self._offered
        if not offered:
            raise FlexError("E_SCOPE", "that file was not offered by the shell; choose it with the file dialog", {})
        return self._adopt(s, text_guid, uri_guid, path)

    @exposed
    def choose_media(self, text_guid, uri_guid=None):
        """The native file dialog, opened where recordings were found before (else LinkedFiles). The
        pick is checked and OFFERED, not adopted: the page may still ask the user (a name that differs
        from FLEx's link) before use_media. → {path: None} when the user cancels."""
        s = self._need_session()
        media, lf, project_dir = self._text_media(s, text_guid)
        if uri_guid and not any(m["guid"] == uri_guid for m in media):   # before any dialog is shown
            raise FlexError("E_NOT_FOUND", "no such media link", {"uri": uri_guid})
        path = self._pick("media", self._start_dir(lf, project_dir))
        if not path:
            return {"path": None}
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            raise FlexError("E_MEDIA_FILE_MISSING", "the chosen file does not exist", {})
        if not mediafind.is_audio(path):
            raise FlexError("E_MEDIA_NOT_AUDIO", "the chosen file is not a recording this app can use", {"ext": os.path.splitext(path)[1]})
        self._offer(path)
        return mediafind.describe(path)

    @exposed
    def forget_media(self, text_guid):
        """Forget the recording chosen for this text (plan §8.4, a reset): the file remembered for each
        of its links, and what this session adopted for it — so the next open finds it again, or asks.
        The shell's own memory only: FLEx and the files themselves are untouched. A link outside this
        machine is one recording whatever project carries it, so a copy of the project forgets it too."""
        s = self._need_session()
        media, _lf, _pd = self._text_media(s, text_guid)
        forgot = 0
        for m in media:
            try:
                forgot += 1 if self._memory.forget(m["uri"], s.name) else 0
            except OSError:
                pass   # a memory that cannot be written still offers the old choice; it asks before using it
        with self._lock:
            self._adopted.pop(text_guid, None)
        return {"forgot": forgot}

    @exposed
    def close_text(self, text_guid):
        s = self._need_session()
        return self._worker.run("close_text", lambda j: s.close_text(text_guid))

    @exposed
    def preview_save(self, text_guid, base_rev, ops, post_state=None, chosen_wss=None):
        s = self._need_session()
        return self._worker.run("preview_save", lambda j: s.preview(text_guid, base_rev, ops, post_state, chosen_wss))

    def _job(self, label, fn):
        job = self._worker.submit(label, fn, write=True)
        return {"jobId": job.id}

    @exposed
    def save_to_flex(self, preview_token):
        s = self._need_session()
        return self._job("save_to_flex", self._noted(s, "save", lambda j: s.save(preview_token, progress=lambda m: setattr(j, "progress", m))))

    @exposed
    def undo_flex(self):
        s = self._need_session()
        return self._job("undo_flex", self._noted(s, "undo", lambda j: s.undo_save(progress=lambda m: setattr(j, "progress", m))))

    @exposed
    def redo_flex(self):
        s = self._need_session()
        return self._job("redo_flex", self._noted(s, "redo", lambda j: s.redo_save(progress=lambda m: setattr(j, "progress", m))))

    @exposed
    def relink_preview(self, text_guid, uri_guid, new_path):
        s = self._need_session()
        entry = s.texts.get(text_guid)
        base_rev = entry["baseRev"] if entry else None
        return self._worker.run("relink_preview", lambda j: s.preview(text_guid, base_rev, [{"op": "media.relink", "uriGuid": uri_guid, "path": new_path}], {}))

    @exposed
    def export_editor_bundle(self, text_guid):
        s = self._need_session()
        with self._lock:
            chosen = dict(self._adopted.get(text_guid, {}))
        return self._job("export_editor_bundle", lambda j: s.export_editor_bundle(text_guid, self._export_dir, chosen))

    @exposed
    def get_media(self, text_guid):
        s = self._need_session()
        media, lf = self._worker.run("get_media", lambda j: (s.guard(), (s.port.read_text(text_guid)["media"], s.port.linked_files_dir()))[1])
        tracks = []
        for m in media:
            here = mediafind.link_path(m["uri"], lf)
            exists = bool(here) and os.path.isfile(here)
            tracks.append({"uriGuid": m["guid"], "url": ("/media/" + self._media.register(here)) if exists else None, "exists": exists,
                           "name": mediafind.link_name(m["uri"])})
        return {"tracks": tracks}

    @exposed
    def import_preview(self, path):
        s = self._need_session()
        return self._worker.run("import_preview", lambda j: s.import_preview(path))

    @exposed
    def import_flextext(self, preview_token):
        s = self._need_session()
        return self._job("import_flextext", self._noted(s, "import", lambda j: s.import_flextext(preview_token, progress=lambda m: setattr(j, "progress", m))))

    @exposed
    def recover(self, choice):
        s = self._need_session()
        return self._worker.run("recover", lambda j: s.recover(choice))

    @exposed
    def printview_data(self, seg_guid):
        s = self._need_session()
        return self._worker.run("printview_data", lambda j: _printview_data(s, seg_guid))

    @exposed
    def copy_text(self, text):
        if not isinstance(text, str):
            raise FlexError("E_SCOPE", "text must be a string", {})
        fn = self._copy_text
        if fn is None:
            from .clipboard import copy_text as fn   # type: ignore[assignment]
        return {"copied": bool(fn(text))}

    def _pick(self, kind, start_dir=""):
        if self._pick_file:
            return self._pick_file(kind, start_dir)
        if not self._window:
            raise FlexError("E_INTERNAL", "no window to open a dialog from", {})
        import webview
        types = (mediafind.DIALOG_FILTER,) if kind == "media" else ("FLEx interlinear text (*.flextext)",)
        # FileDialog.OPEN (pywebview 5+); OPEN_DIALOG is deprecated and warns on every call (VM, 2026-10-15)
        fd = getattr(webview, "FileDialog", None)
        kind_open = fd.OPEN if fd is not None else webview.OPEN_DIALOG
        r = self._window.create_file_dialog(kind_open, directory=start_dir or "", allow_multiple=False, file_types=types)
        return r[0] if r else None

    @exposed
    def pick_file(self, kind):
        if kind not in ("media", "flextext"):
            raise FlexError("E_SCOPE", "kind must be media or flextext", {})
        return {"path": self._pick(kind)}

    @exposed
    def open_external(self, url):
        from . import navguard
        if not navguard.external_url_ok(url):
            raise FlexError("E_SCOPE", "only http(s) URLs are handed to the browser", {})
        from .webview_hooks import _open_in_os_browser
        return {"opened": _open_in_os_browser(url, self._opener)}

    @exposed
    def job_status(self, job_id):
        return self._worker.status(job_id)

    @exposed
    def client_log(self, level, message):
        """A line from the page — an error it caught, a failure it showed the user — printed in this
        console beside the shell's own (trace.py). Nothing is stored or sent anywhere."""
        lv = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING, "warning": logging.WARNING,
              "error": logging.ERROR}.get(str(level or "").lower(), logging.INFO)
        PAGE.log(lv, "%s", str(message)[:8000])
        return True


def _engine_version(root):
    """The staged engine's version: the stamp stage_engine writes (engine-version.json), else the
    engine's own ENGINE_VERSION. The engine is staged at <root>/flextext-editor/ — reading <root>/js/
    found nothing, and hello() always answered None."""
    import json
    import re
    try:
        with open(os.path.join(root, "engine-version.json"), "r", encoding="utf-8") as f:
            v = json.load(f).get("engineVersion")
            if v:
                return v
    except (OSError, TypeError, ValueError, AttributeError):
        pass
    for rel in (("flextext-editor", "js", "i18n.js"), ("js", "i18n.js")):
        try:
            with open(os.path.join(root, *rel), "r", encoding="utf-8") as f:
                m = re.search(r"ENGINE_VERSION\s*=\s*['\"]([^'\"]+)['\"]", f.read())
                if m:
                    return m.group(1)
        except (OSError, TypeError):
            continue
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
