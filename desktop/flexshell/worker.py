"""ONE LCM worker thread, ONE open project per process, ONE job at a time (plan §2.3).

[verified] a unit of work begun on one thread and disposed on another leaves the first thread
holding UndoStack's write lock: every later UOW fails with LockRecursionException and Save() throws
NullReferenceException — the session is wedged. pywebview calls js_api methods on assorted threads,
so EVERY LCM call is enqueued here and the caller waits on a Future. The thread is COM-initialised
as STA on Windows (FLEx's own convention; that it matters for these calls is [unverified], V-10).
"""

import queue
import threading
import time
import uuid
from concurrent.futures import Future

from .errors import FlexError


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
            try:
                job.future.set_result(job.fn(job))
                job.state = "done"
            except BaseException as e:   # noqa: BLE001 — every exception becomes a job error
                job.future.set_exception(e)
                job.state = "error"
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
