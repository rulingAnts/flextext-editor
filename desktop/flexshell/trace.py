"""Verbose console tracing (Seth, 2026-10-16: "we want very verbose TTY debugging output, at least for now").

Everything the shell does on the user's behalf is printed to the console it runs in: each bridge call
from the page and its answer, each job, each call into FLEx with its arguments and how long it took,
each step of a save and every check it makes — and, when FLEx throws, the whole .NET exception (type,
message, inner exceptions, stack). Page errors are forwarded here too (api.client_log). `FLEXSHELL_DEBUG=0`
quiets it to warnings. This machine's data, in this machine's console; nothing leaves it.

⚠ The shell's own lines go to the `flexshell` logger, which the session's FLEx-error watch never listens
to (lcm_real.subscribe_log listens to pyflexicon's loggers only): a line this module prints at ERROR is a
report, never a reason to close a project."""

import logging
import os
import sys
import traceback

LOG = logging.getLogger("flexshell")
_FMT = "%(asctime)s.%(msecs)03d %(threadName)-16s %(levelname)-5s %(name)s: %(message)s"
_handler = None


def verbose():
    return os.environ.get("FLEXSHELL_DEBUG", "1").strip().lower() not in ("0", "off", "false", "no", "quiet")


def setup(stream=None):
    """Route the shell's, pyflexicon's and pywebview's log lines to the console. Idempotent."""
    global _handler
    if _handler is not None:
        return verbose()
    _handler = logging.StreamHandler(stream or sys.stderr)
    _handler.setFormatter(logging.Formatter(_FMT, "%H:%M:%S"))
    loud = verbose()
    for name, level in (("flexshell", logging.DEBUG if loud else logging.WARNING),
                        ("flexicon", logging.DEBUG if loud else logging.INFO),        # FLEx itself speaking
                        ("flexlibs2", logging.DEBUG if loud else logging.INFO),
                        ("pywebview", logging.INFO if loud else logging.WARNING)):
        lg = logging.getLogger(name)
        lg.addHandler(_handler)
        lg.setLevel(level)
        lg.propagate = False
    LOG.info("verbose console tracing %s (FLEXSHELL_DEBUG=0 quiets it)", "on" if loud else "off")
    return loud


def short(x, limit=400):
    """A compact, single-line repr for a log line."""
    try:
        s = repr(x)
    except Exception:   # noqa: BLE001
        s = "<%s>" % type(x).__name__
    s = s.replace("\n", "\\n")
    return s if len(s) <= limit else s[:limit] + "… (%d chars)" % len(s)


def exc_text(e, with_traceback=True):
    """Everything an exception says, a .NET one included: type, message, each inner exception, the .NET
    stack trace(s), then the Python traceback."""
    lines = ["%s: %s" % (_type_name(e), _message(e))]
    seen, inner, depth = set(), e, 0
    while inner is not None and depth < 8 and id(inner) not in seen:
        seen.add(id(inner))
        st = _attr(inner, "StackTrace")
        if st:
            lines.append("  .NET stack (%s):\n    %s" % (_type_name(inner), str(st).strip().replace("\n", "\n    ")))
        nxt = _attr(inner, "InnerException")
        if nxt is not None:
            lines.append("  inner %s: %s" % (_type_name(nxt), _message(nxt)))
        inner, depth = nxt, depth + 1
    if with_traceback:
        tb = "".join(traceback.format_exception(type(e), e, e.__traceback__)) if getattr(e, "__traceback__", None) else ""
        if tb.strip():
            lines.append("  Python traceback:\n    " + tb.strip().replace("\n", "\n    "))
    return "\n".join(lines)


def _attr(o, name):
    try:
        return getattr(o, name, None)
    except Exception:   # noqa: BLE001 — a throwing CLR getter
        return None


def _type_name(o):
    try:
        t = o.GetType()   # a .NET object: its full CLR type name
        return str(t.FullName)
    except Exception:   # noqa: BLE001
        return type(o).__name__


def _message(o):
    m = _attr(o, "Message")
    if m:
        return str(m)
    try:
        return str(o)
    except Exception:   # noqa: BLE001
        return "?"
