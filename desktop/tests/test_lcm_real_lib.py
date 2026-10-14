"""lcm_real's library loading and open-error mapping, with FAKE modules (the rest of lcm_real needs
Windows + FLEx). Pins the fifth VM launch's lesson: FLExTools' `flexlibs` was imported first and its
OpenProject has no `undoable`."""
import sys
import types

import pytest

from flexshell import lcm_real
from flexshell.errors import FlexError


def _fake(name, with_undoable):
    m = types.ModuleType(name)

    class FLExProject:
        if with_undoable:
            def OpenProject(self, projectName, writeEnabled=False, undoable=True, strict_transactions=False, ui=None, progress=None):
                pass
        else:
            def OpenProject(self, projectName, writeEnabled=False):
                pass
    m.FLExProject = FLExProject
    return m


@pytest.fixture
def mods(monkeypatch):
    for n in ("flexicon", "flexlibs2", "flexlibs"):
        monkeypatch.delitem(sys.modules, n, raising=False)
    return monkeypatch


def test_pyflexicon_is_preferred_and_flextools_flexlibs_is_never_used(mods):
    mods.setitem(sys.modules, "flexlibs", _fake("flexlibs", with_undoable=False))   # FLExTools', on the VM
    mods.setitem(sys.modules, "flexicon", _fake("flexicon", with_undoable=True))
    assert lcm_real._flexicon().__name__ == "flexicon"
    mods.delitem(sys.modules, "flexicon")
    mods.setitem(sys.modules, "flexlibs2", _fake("flexlibs2", with_undoable=True))
    assert lcm_real._flexicon().__name__ == "flexlibs2", "the deprecated alias still works"
    mods.delitem(sys.modules, "flexlibs2")
    with pytest.raises(FlexError) as ei:   # only FLExTools' flexlibs left: refused by name, not imported
        lcm_real._flexicon()
    assert ei.value.code == "E_INTERNAL" and "pyflexicon" in ei.value.message


def test_a_library_without_undoable_is_refused_before_any_open(mods):
    mods.setitem(sys.modules, "flexicon", _fake("flexicon", with_undoable=False))
    with pytest.raises(FlexError) as ei:
        lcm_real._flexicon()
    assert "undoable" in ei.value.message


def test_open_errors_map_to_codes():
    def err(name, msg="x"):
        return type(name, (Exception,), {})(msg)
    assert lcm_real._map_open_error(err("FP_FileLockedError")).code == "E_LOCKED_OTHER"
    assert lcm_real._map_open_error(err("FP_MigrationRequired")).code == "E_MODEL_OLDER"
    assert lcm_real._map_open_error(err("FP_FileNotFoundError")).code == "E_NOT_FOUND"
    e = lcm_real._map_open_error(err("FP_ProjectError", "boom"))
    assert e.code == "E_INTERNAL" and "boom" in e.message
    other = ValueError("v")
    assert lcm_real._map_open_error(other) is other


def test_initialise_runs_once_and_registers_cleanup(monkeypatch):
    calls = []
    fx = types.SimpleNamespace(FLExInitialize=lambda: calls.append("init"), FLExCleanup=lambda: calls.append("cleanup"))
    registered = []
    monkeypatch.setattr(lcm_real, "_initialised", False)
    import atexit
    monkeypatch.setattr(atexit, "register", lambda fn, *a: registered.append((fn, a)))
    lcm_real._initialise_once(fx)
    lcm_real._initialise_once(fx)
    assert calls == ["init"] and len(registered) == 1
    registered[0][0](*registered[0][1])
    assert calls == ["init", "cleanup"]
