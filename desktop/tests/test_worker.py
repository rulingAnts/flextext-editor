"""The single worker thread: everything runs on one thread, one write job at a time, exceptions
become job errors, one project per process (plan §2.3)."""
import threading
import time

import pytest

from flexshell.errors import FlexError
from flexshell.worker import ProjectRegistry, Worker


@pytest.fixture
def w():
    w = Worker(name="t-worker")
    yield w
    w.stop()


def test_runs_on_the_worker_thread(w):
    ids = set()
    for _ in range(5):
        ids.add(w.run("tid", lambda job: threading.get_ident()))
    assert ids == {w.thread_id}
    assert w.thread_id != threading.get_ident()


def test_jobs_are_serialised_in_order(w):
    order = []

    def mk(n):
        def fn(job):
            time.sleep(0.01)
            order.append(n)
            return n
        return fn
    jobs = [w.submit("j%d" % n, mk(n)) for n in range(6)]
    assert [j.future.result(5) for j in jobs] == list(range(6))
    assert order == list(range(6))


def test_exceptions_become_job_errors_not_crashes(w):
    def boom(job):
        raise FlexError("E_INVARIANT", "nope", {"x": 1})
    job = w.submit("boom", boom)
    with pytest.raises(FlexError):
        job.future.result(5)
    st = w.status(job.id)
    assert st["state"] == "error" and st["error"] == {"code": "E_INVARIANT", "message": "nope", "detail": {"x": 1}}
    # the thread is still alive and serving
    assert w.run("after", lambda job: 7) == 7


def test_plain_exception_is_e_internal(w):
    job = w.submit("boom", lambda job: 1 / 0)
    with pytest.raises(ZeroDivisionError):
        job.future.result(5)
    assert w.status(job.id)["error"]["code"] == "E_INTERNAL"


def test_second_write_while_one_runs_is_busy(w):
    gate = threading.Event()

    def slow(job):
        job.progress = "writing"
        gate.wait(5)
        return "done"
    j1 = w.submit("save", slow, write=True)
    time.sleep(0.05)
    assert w.status(j1.id)["state"] == "running" and w.status(j1.id)["progress"] == "writing"
    with pytest.raises(FlexError) as ei:
        w.submit("save2", lambda job: None, write=True)
    assert ei.value.code == "E_BUSY"
    # a READ while a write runs is queued, not refused
    j3 = w.submit("read", lambda job: "r")
    gate.set()
    assert j1.future.result(5) == "done" and j3.future.result(5) == "r"
    # and the next write is accepted
    assert w.run("save3", lambda job: "ok", write=True) == "ok"


def test_status_of_unknown_job(w):
    with pytest.raises(FlexError) as ei:
        w.status("nope")
    assert ei.value.code == "E_NOT_FOUND"


def test_assert_on_worker(w):
    with pytest.raises(RuntimeError):
        w.assert_on_worker()
    assert w.run("ok", lambda job: (w.assert_on_worker(), True)[1]) is True


def test_run_from_the_worker_itself_does_not_deadlock(w):
    assert w.run("outer", lambda job: w.run("inner", lambda j2: 5)) == 5


def test_one_project_per_process():
    r = ProjectRegistry()
    r.claim("A")
    with pytest.raises(FlexError) as ei:
        r.claim("A")
    assert ei.value.code == "E_ALREADY_OPEN"
    with pytest.raises(FlexError):
        r.claim("B")
    r.release()
    r.claim("B")
