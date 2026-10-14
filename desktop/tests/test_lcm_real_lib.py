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


# Namespaces READ FROM SOURCE (liblcm src/, FieldWorks Src/, pyflexicon 4.13; 2026-10-14) — the sixth
# VM launch died on `IUndoStackManager` imported from .Infrastructure, a namespace written from
# memory. Every `from SIL… import` in lcm_real.py must agree with this table; a name not in it is a
# new call written from memory and fails here until its namespace has been read from source too.
SOURCE_NAMESPACES = {
    "IUndoStackManager": "SIL.LCModel", "LcmCache": "SIL.LCModel", "Opinions": "SIL.LCModel",
    "ITextRepository": "SIL.LCModel", "IStTxtParaRepository": "SIL.LCModel", "ISegmentRepository": "SIL.LCModel",
    "ICmObjectRepository": "SIL.LCModel", "IPunctuationFormRepository": "SIL.LCModel", "IWfiWordformRepository": "SIL.LCModel",
    "ILexEntryRepository": "SIL.LCModel", "ILexSenseRepository": "SIL.LCModel", "IMoFormRepository": "SIL.LCModel",
    "IWfiWordform": "SIL.LCModel", "IWfiAnalysis": "SIL.LCModel", "IWfiGloss": "SIL.LCModel", "IPunctuationForm": "SIL.LCModel",
    "ICmMediaContainerFactory": "SIL.LCModel", "ICmMediaURIFactory": "SIL.LCModel", "IWfiAnalysisFactory": "SIL.LCModel",
    "IWfiMorphBundleFactory": "SIL.LCModel", "IWfiGlossFactory": "SIL.LCModel",
    # generated repository interfaces: same namespace as the hand-written additions in
    # RepositoryInterfaceAdditions.cs (SIL.LCModel); pyflexicon imports IWfiAnalysisRepository from there
    "IWfiAnalysisRepository": "SIL.LCModel", "IWfiGlossRepository": "SIL.LCModel", "IWfiMorphBundleRepository": "SIL.LCModel",
    "IStTextRepository": "SIL.LCModel", "ICmMediaContainerRepository": "SIL.LCModel", "ICmMediaURIRepository": "SIL.LCModel",
    "IDataSetup": "SIL.LCModel.Infrastructure", "UndoableUnitOfWorkHelper": "SIL.LCModel.Infrastructure",
    "SharedBackendServices": "SIL.LCModel.DomainServices", "SegmentServices": "SIL.LCModel.DomainServices",
    "ParagraphParser": "SIL.LCModel.DomainServices",
    "ProjectBackupService": "SIL.LCModel.DomainServices.BackupRestore", "BackupProjectSettings": "SIL.LCModel.DomainServices.BackupRestore",
    "TsStringUtils": "SIL.LCModel.Core.Text",
    "FwDirectoryFinder": "SIL.FieldWorks.Common.FwUtils",
    "InterlinearExporter": "SIL.FieldWorks.IText", "LinguaLinksImport": "SIL.FieldWorks.IText",
    "InterlinVc": "SIL.FieldWorks.IText", "InterlinLineChoices": "SIL.FieldWorks.IText",
}


def test_every_dotnet_import_in_lcm_real_matches_the_source_namespaces():
    import ast
    import inspect
    tree = ast.parse(inspect.getsource(lcm_real))
    seen = {}
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom) and n.module and n.module.startswith("SIL"):
            for a in n.names:
                seen.setdefault(a.name, set()).add(n.module)
    wrong = {k: v for k, v in seen.items() if k not in SOURCE_NAMESPACES or v != {SOURCE_NAMESPACES[k]}}
    assert not wrong, "written from memory, not from source: %r" % wrong
    assert "IUndoStackManager" in seen and "FwDirectoryFinder" in seen
    src = inspect.getsource(lcm_real)
    assert "SIL.LCModel.Utils import" not in src, "HeadlessThreadedProgress is pyflexicon's; FwDirectoryFinder is FieldWorks'"
