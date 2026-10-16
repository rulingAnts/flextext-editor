"""ONE LCM worker thread, ONE open project per process, ONE job at a time (plan §2.3).

[verified] a unit of work begun on one thread and disposed on another leaves the first thread
holding UndoStack's write lock: every later UOW fails with LockRecursionException and Save() throws
NullReferenceException — the session is wedged. pywebview calls js_api methods on assorted threads,
so EVERY LCM call is enqueued here and the caller waits on a Future. The thread is COM-initialised
as STA on Windows (FLEx's own convention; that it matters for these calls is [unverified], V-10).
"""

import logging
import queue
import threading
import time
import uuid
from concurrent.futures import Future

from . import trace
from .errors import FlexError

JOBS = logging.getLogger("flexshell.job")
PORT = logging.getLogger("flexshell.flex")


class Job:
    __slots__ = ("id", "label", "fn", "future", "state", "progress", "created")

    def __init__(self, label, fn):
        self.id = uuid.uuid4().hex
        self.label = label
        self.fn = fn
        self.future = Future()
        self.state = "queued"       # queued | running | done | error
        self.progress = None        # free text the UI shows ("Backing up…")
        self.created = time.time()

    def status(self):
        d = {"state": self.state, "label": self.label, "progress": self.progress}
        if self.state == "done":
            d["result"] = self.future.result()
        elif self.state == "error":
            e = self.future.exception()
            d["error"] = e.to_dict() if isinstance(e, FlexError) else {"code": "E_INTERNAL", "message": str(e)}
        return d


class Worker:
    """A single daemon thread draining a FIFO queue. `run(label, fn)` blocks until fn has run on the
    worker (the ordinary path for a js_api call); `submit(label, fn)` returns the Job for polling.
    While a WRITE job is running, another write request is refused with E_BUSY instead of queued —
    the user asked for one thing at a time and a queued second save could run against a world the
    first one changed."""

    def __init__(self, name="flexshell-lcm", init=None):
        self._q = queue.Queue()
        self._jobs = {}
        self._lock = threading.Lock()
        self._busy_write = None
        self._init = init
        self.thread = threading.Thread(target=self._loop, name=name, daemon=True)
        self.thread_id = None
        self._started = threading.Event()
        self.thread.start()
        self._started.wait(5)

    # ---- the loop -------------------------------------------------------------------------
    def _loop(self):
        self.thread_id = threading.get_ident()
        _com_init_sta()
        if self._init:
            try:
                self._init()
            except Exception:   # the first job reports what went wrong; the thread must keep serving
                pass
        self._started.set()
        while True:
            job = self._q.get()
            if job is None:
                return
            job.state = "running"
            t0 = time.monotonic()
            _quietly(JOBS.debug, "job %s [%s] started", job.label, job.id[:8])
            try:
                job.future.set_result(job.fn(job))
                job.state = "done"
                _quietly(JOBS.debug, "job %s [%s] done in %d ms", job.label, job.id[:8], (time.monotonic() - t0) * 1000)
            except BaseException as e:   # noqa: BLE001 — every exception becomes a job error
                job.future.set_exception(e)
                job.state = "error"
                # a job's failure reaches the page only through job_status: say it HERE, in full
                ms = (time.monotonic() - t0) * 1000
                if isinstance(e, FlexError):
                    _quietly(JOBS.warning, "job %s [%s] ended in %d ms with %s — %s%s", job.label, job.id[:8], ms, e.code, e.message,
                             (" | detail " + trace.short(e.detail, 2000)) if e.detail else "")
                else:
                    _quietly(JOBS.error, "job %s [%s] FAILED in %d ms:\n%s", job.label, job.id[:8], ms, trace.exc_text(e))
            finally:
                with self._lock:
                    if self._busy_write is job:
                        self._busy_write = None

    # ---- submission ---------------------------------------------------------------------
    def submit(self, label, fn, write=False):
        job = Job(label, fn)
        with self._lock:
            if write:
                if self._busy_write is not None and self._busy_write.state in ("queued", "running"):
                    raise FlexError("E_BUSY", "another change is still being saved", {"job": self._busy_write.id})
                self._busy_write = job
            self._jobs[job.id] = job
            self._prune()
        self._q.put(job)
        return job

    def run(self, label, fn, write=False, timeout=None):
        if threading.get_ident() == self.thread_id:
            return fn(None)          # already on the worker (a job calling a helper): no deadlock
        job = self.submit(label, fn, write=write)
        return job.future.result(timeout)

    def status(self, job_id):
        with self._lock:
            job = self._jobs.get(job_id)
        if not job:
            raise FlexError("E_NOT_FOUND", "no such job", {"jobId": job_id})
        return job.status()

    def _prune(self, keep=200):
        if len(self._jobs) <= keep:
            return
        done = sorted((j for j in self._jobs.values() if j.state in ("done", "error")), key=lambda j: j.created)
        for j in done[: len(self._jobs) - keep]:
            self._jobs.pop(j.id, None)

    def assert_on_worker(self):
        """Called by the LCM layer before any LCM call: the thread rule, enforced not assumed."""
        if threading.get_ident() != self.thread_id:
            raise RuntimeError("LCM call off the worker thread")

    def stop(self):
        self._q.put(None)


def _quietly(log, *args):
    """A trace line that can never cost the job (trace.py)."""
    try:
        log(*args)
    except Exception:   # noqa: BLE001
        pass


def _summary(name, r):
    """A port call's answer, briefly: a text read is its shape, a count list is itself."""
    try:
        if name == "read_text" and isinstance(r, dict):
            segs = sum(len(p.get("segments") or []) for p in r.get("paragraphs") or [])
            return "%d paragraphs, %d phrases, %d media" % (len(r.get("paragraphs") or []), segs, len(r.get("media") or []))
        if name == "list_texts" and isinstance(r, list):
            return "%d texts" % len(r)
        return trace.short(r, 300)
    except Exception:   # noqa: BLE001
        return "?"


def _com_init_sta():
    """CoInitializeEx(COINIT_APARTMENTTHREADED) on Windows; a no-op elsewhere. Lazy, never imported
    at module load, so this file runs on Linux."""
    try:
        import ctypes
        import sys
        if sys.platform != "win32":
            return
        ole32 = ctypes.windll.ole32  # type: ignore[attr-defined]
        ole32.CoInitializeEx(None, 0x2)
    except Exception:   # noqa: BLE001
        pass


class ThreadBound:
    """A port that may be used ONLY on the worker's thread — the one-thread rule (plan §2.3,
    handoff §4: a unit of work begun on one thread and touched on another wedges the session) made
    unconditional and testable. Every callable attribute of the wrapped port is checked at call time
    and raises the same RuntimeError the real port raises, so the MOCK enforces the rule in the suite
    and an off-worker call fails on Linux instead of on the VM (eighth launch, 2026-10-14: api.py read
    writing_systems() on pywebview's bridge thread after the worker had opened the project)."""

    def __init__(self, port, worker):
        object.__setattr__(self, "_port", port)
        object.__setattr__(self, "_worker", worker)

    def __getattr__(self, name):
        attr = getattr(object.__getattribute__(self, "_port"), name)
        if not callable(attr):
            return attr
        worker = object.__getattribute__(self, "_worker")

        def bound(*a, **kw):
            if threading.get_ident() != worker.thread_id:
                raise RuntimeError("LCM call off the worker thread (would wedge the session): " + name)
            # every call into FLEx, traced (trace.py): what was asked, what came back, how long it took —
            # and when FLEx throws, the whole exception, .NET stack and inner exceptions included
            t0 = time.monotonic()
            try:
                r = attr(*a, **kw)
            except BaseException as e:   # noqa: BLE001
                ms = (time.monotonic() - t0) * 1000
                if isinstance(e, FlexError):
                    _quietly(PORT.warning, "%s(%s) refused in %d ms: %s — %s", name, _args(a, kw), ms, e.code, e.message)
                else:
                    _quietly(PORT.error, "%s(%s) THREW in %d ms:\n%s", name, _args(a, kw), ms, trace.exc_text(e))
                raise
            if PORT.isEnabledFor(logging.DEBUG):   # a big answer is never formatted for a console that is quiet
                _quietly(PORT.debug, "%s(%s) → %s in %d ms", name, _args(a, kw), _summary(name, r), (time.monotonic() - t0) * 1000)
            return r
        return bound

    def __setattr__(self, name, value):
        setattr(object.__getattribute__(self, "_port"), name, value)


def _args(a, kw):
    try:
        parts = [trace.short(x, 160) for x in a] + ["%s=%s" % (k, trace.short(v, 160)) for k, v in kw.items()]
        return ", ".join(parts)
    except Exception:   # noqa: BLE001
        return "…"


class ProjectRegistry:
    """One open project per process (plan §2.3). [verified] a second OpenProject of the same project
    inside one process succeeds — LCM's lock is per process — so the shell must refuse it itself."""

    def __init__(self):
        self._lock = threading.Lock()
        self.open_name = None

    def claim(self, name):
        with self._lock:
            if self.open_name is not None:
                raise FlexError("E_ALREADY_OPEN", "a project is already open in this shell", {"open": self.open_name})
            self.open_name = name

    def release(self):
        with self._lock:
            self.open_name = None
