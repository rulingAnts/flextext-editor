"""The console tracing (trace.py; Seth, 2026-10-16: "we want very verbose TTY debugging output, at least for
now"): where the lines go, what quiets them, and that a .NET exception is printed whole."""
import io
import logging
import types

import pytest

from flexshell import trace
from flexshell.api import Api, exposed
from flexshell.errors import FlexError

LOGGERS = ("flexshell", "flexicon", "flexlibs2", "pywebview")


@pytest.fixture
def console(monkeypatch):
    """A fresh trace.setup() onto a string stream; every logger it touched put back afterwards."""
    saved = {n: (logging.getLogger(n).level, logging.getLogger(n).propagate, list(logging.getLogger(n).handlers)) for n in LOGGERS}
    monkeypatch.setattr(trace, "_handler", None)
    out = io.StringIO()

    def start(debug=None):
        if debug is None:
            monkeypatch.delenv("FLEXSHELL_DEBUG", raising=False)
        else:
            monkeypatch.setenv("FLEXSHELL_DEBUG", debug)
        trace.setup(out)
        return out
    yield start
    for n, (level, propagate, handlers) in saved.items():
        lg = logging.getLogger(n)
        lg.setLevel(level)
        lg.propagate = propagate
        lg.handlers[:] = handlers


def test_verbose_by_default_and_every_shell_line_reaches_the_console(console):
    out = console()
    logging.getLogger("flexshell.save").debug("W3 begin unit of work")
    logging.getLogger("flexicon.code.headless_ui").info("FLEx speaking")
    text = out.getvalue()
    assert "verbose console tracing on" in text
    assert "DEBUG flexshell.save: W3 begin unit of work" in text and "flexicon.code.headless_ui: FLEx speaking" in text


def test_flexshell_debug_0_quiets_it_to_warnings(console):
    out = console("0")
    logging.getLogger("flexshell.save").info("a step")
    logging.getLogger("flexshell.save").warning("rolling back")
    text = out.getvalue()
    assert "a step" not in text and "rolling back" in text


def test_a_dotnet_exception_is_printed_whole():
    """pythonnet surfaces a .NET exception with Message/StackTrace/InnerException; all of it is printed."""
    inner = types.SimpleNamespace(Message="Object reference not set", StackTrace="   at SIL.LCModel.X.Y()", InnerException=None,
                                  GetType=lambda: types.SimpleNamespace(FullName="System.NullReferenceException"))

    class ClrError(Exception):
        Message = "Exception has been thrown by the target of an invocation."
        StackTrace = "   at System.Reflection.Invoke()"
        InnerException = inner

        def GetType(self):
            return types.SimpleNamespace(FullName="System.Reflection.TargetInvocationException")
    try:
        raise ClrError("boom")
    except ClrError as e:
        text = trace.exc_text(e)
    assert text.startswith("System.Reflection.TargetInvocationException: Exception has been thrown")
    assert "at System.Reflection.Invoke()" in text and "inner System.NullReferenceException: Object reference not set" in text
    assert "at SIL.LCModel.X.Y()" in text and "Python traceback" in text and "raise ClrError" in text


def test_short_is_one_line_and_bounded():
    assert trace.short("a\nb") == "'a\\nb'"
    s = trace.short("x" * 1000, 50)
    assert len(s) < 80 and s.endswith("(1002 chars)")


def test_the_bridge_traces_calls_refusals_and_failures(console):
    out = console()

    class Fake:
        @exposed
        def ok(self, x):
            return {"n": x}

        @exposed
        def refuse(self):
            raise FlexError("E_SCOPE", "outside what this app may write", {"op": "x"})

        @exposed
        def crash(self):
            raise RuntimeError("a bug")
    f = Fake()
    assert f.ok(3) == {"ok": True, "result": {"n": 3}}
    assert f.refuse()["error"]["code"] == "E_SCOPE"
    assert f.crash()["error"]["code"] == "E_INTERNAL"
    text = out.getvalue()
    assert "page → ok(3)" in text and "page ← ok ok in" in text and "{'n': 3}" in text
    assert "page ← refuse refused in" in text and "E_SCOPE — outside what this app may write | detail {'op': 'x'}" in text
    assert "page ← crash FAILED in" in text and "RuntimeError: a bug" in text


def test_the_page_can_write_to_the_console_and_it_never_closes_a_project(console):
    out = console()
    api = object.__new__(Api)
    assert api.client_log("error", "page error: x is not defined") == {"ok": True, "result": True}
    assert api.client_log("warn", "[flex] E_INVARIANT: …") == {"ok": True, "result": True}
    text = out.getvalue()
    assert "ERROR flexshell.page: page error: x is not defined" in text and "WARNING flexshell.page: [flex] E_INVARIANT" in text
    assert "client_log" not in text, "the page's own lines are not traced as calls"
