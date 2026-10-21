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
    # None in sys.modules makes `import` raise ImportError, so a REAL pyflexicon installed on this machine (the
    # Windows VM) can never stand in for a fake the test removed. Deleting the entry let the real one import.
    for n in ("flexicon", "flexlibs2", "flexlibs"):
        monkeypatch.setitem(sys.modules, n, None)
    return monkeypatch


def test_pyflexicon_is_preferred_and_flextools_flexlibs_is_never_used(mods):
    mods.setitem(sys.modules, "flexlibs", _fake("flexlibs", with_undoable=False))   # FLExTools', on the VM
    mods.setitem(sys.modules, "flexicon", _fake("flexicon", with_undoable=True))
    assert lcm_real._flexicon().__name__ == "flexicon"
    mods.setitem(sys.modules, "flexicon", None)
    mods.setitem(sys.modules, "flexlibs2", _fake("flexlibs2", with_undoable=True))
    assert lcm_real._flexicon().__name__ == "flexlibs2", "the deprecated alias still works"
    mods.setitem(sys.modules, "flexlibs2", None)
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
    "TsStringUtils": "SIL.LCModel.Core.Text", "ITsString": "SIL.LCModel.Core.KernelInterfaces",
    "IStTxtPara": "SIL.LCModel", "IWfiWordform": "SIL.LCModel", "IWfiAnalysis": "SIL.LCModel",
    "FwDataFixer": "SIL.LCModel.FixData",   # src/SIL.LCModel.FixData/FwDataFixer.cs (read 2026-10-19)
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


def test_cast_is_total_and_uses_the_classname_interface(monkeypatch):
    """pythonnet interface typing: _cast(obj) → SIL.LCModel.I<ClassName>(obj), unchanged when it cannot."""
    import types
    calls = []

    class ISegment:
        def __init__(self, obj):
            calls.append(obj)
            self.wrapped = obj

    def IBroken(obj):
        raise RuntimeError("CLR cast failed")
    lcm = types.ModuleType("SIL.LCModel")
    lcm.ISegment = ISegment
    lcm.IBroken = IBroken
    sil = types.ModuleType("SIL")
    sil.LCModel = lcm
    monkeypatch.setitem(sys.modules, "SIL", sil)
    monkeypatch.setitem(sys.modules, "SIL.LCModel", lcm)
    seg = types.SimpleNamespace(ClassName="Segment")
    out = lcm_real._cast(seg)
    assert isinstance(out, ISegment) and out.wrapped is seg
    unknown = types.SimpleNamespace(ClassName="NoSuchClass")
    assert lcm_real._cast(unknown) is unknown
    broken = types.SimpleNamespace(ClassName="Broken")
    assert lcm_real._cast(broken) is broken
    assert lcm_real._cast(None) is None and lcm_real._cast("x") == "x"


def test_services_come_from_getservice_never_getinstance():
    """pyflexicon's pattern everywhere; the generic GetInstance<T> is not reachable from pythonnet
    (seventh VM launch: 'ILcmServiceLocator' object has no attribute 'GetInstance')."""
    import ast
    import inspect
    import re
    src = inspect.getsource(lcm_real)
    lines = src.splitlines()
    for node in ast.walk(ast.parse(src)):   # blank every docstring / bare string statement
        if isinstance(node, ast.Expr) and isinstance(getattr(node, "value", None), ast.Constant) and isinstance(node.value.value, str):
            for i in range(node.lineno - 1, node.end_lineno):
                lines[i] = ""
    code = "\n".join(l.split("#", 1)[0] for l in lines)
    assert "GetInstance" not in code, "GetInstance in code (only docstrings may mention it)"
    assert "ServiceLocator.GetService(" in src and "ServiceLocator.GetObject(System.Guid(" in src
    assert "get_Properties(0).GetIntPropValues(1, 0)" in src, "run-0 writing system, pyflexicon's idiom"
    assert "ITsString(tss).Text" in src, "ITsString cast before .Text, pyflexicon's idiom"
    assert re.search(r"TryGetObject\(tss\)", src), "out parameter omitted → tuple"


# ---- 2026-10-16, the first saves to a real FLEx project (test_real_flex_findings.py has the protocol side) ----
def test_history_items_are_undo_bundles_never_the_changes_in_them():
    """W5 counts FLEx history ITEMS. LCM's UndoableActionCount sums the CHANGES in them, and ending a task
    adds DateModified changes of its own (UndoStack.EndUndoTaskCommon), so one save of one change grew it
    by 2 or more and W5 closed the project. UndoableSequenceCount is the number of undo bundles."""
    port = lcm_real.RealLcm("projects")
    # LCM's undo stack after ONE save of ONE change: one bundle — the change plus two DateModified stamps
    port.ah = types.SimpleNamespace(UndoableSequenceCount=1, UndoableActionCount=3, CurrentDepth=0)
    assert port.undo_item_count() == 1


def test_the_flex_error_watch_listens_to_pyflexicon_only_never_the_root_logger():
    import logging
    port = lcm_real.RealLcm("projects")
    got = []
    h = logging.Handler()
    h.emit = got.append
    root_before = list(logging.getLogger().handlers)
    port.subscribe_log(h)
    try:
        assert logging.getLogger().handlers == root_before, "never on the root logger"
        for name in ("pywebview", "flexshell.page", "some.other.library"):
            logging.getLogger(name).error("an error that is not FLEx failing to save")
        assert got == []
        logging.getLogger("flexicon.code.headless_ui").error("ConflictingSave")
        assert [r.getMessage() for r in got] == ["ConflictingSave"]
    finally:
        for name in ("flexicon", "flexlibs2", "FwLcmUI"):
            logging.getLogger(name).removeHandler(h)


def test_user_agent_says_how_many_evaluations_the_first_approval_would_create():
    port = lcm_real.RealLcm("projects")
    agent = types.SimpleNamespace(Guid="agent-guid", ApprovesOA=None, DisapprovesOA=None)
    port.cache = types.SimpleNamespace(LanguageProject=types.SimpleNamespace(DefaultUserAgent=agent))
    assert port.user_agent() == {"guid": "agent-guid", "missingEvaluations": 2}
    agent.ApprovesOA = object()
    assert port.user_agent()["missingEvaluations"] == 1
    agent.DisapprovesOA = object()
    assert port.user_agent() == {"guid": "agent-guid", "missingEvaluations": 0}


class _Tss:
    def __init__(self, text):
        self.Text = text


class _Multi:
    """IMultiUnicode: writing system handle → ITsString (an absent one reads as an empty string, as in LCM)."""
    def __init__(self, alts=None):
        self.alts = {h: _Tss(t) for h, t in (alts or {}).items()}

    @property
    def AvailableWritingSystemIds(self):
        return [h for h, v in self.alts.items() if v.Text]

    def get_String(self, h):
        return self.alts.get(int(h)) or _Tss("")

    def set_String(self, h, tss):
        self.alts[int(h)] = tss


class _Owning(list):
    def __init__(self, owner):
        super().__init__()
        self.owner = owner

    def Add(self, x):
        self.append(x)
        x.Owner = self.owner


@pytest.fixture
def analyses(monkeypatch):
    """Just enough LCM for the trivial-analysis calls: pass-through interfaces, two vernacular writing
    systems (handle 1 the default, handle 2 a second orthography), a wordform found by guid."""
    def passthrough(o):
        return o
    lcm = types.ModuleType("SIL.LCModel")
    for n in ("IWfiWordform", "IWfiAnalysis", "IWfiMorphBundle"):
        setattr(lcm, n, passthrough)
    lcm.IWfiAnalysisFactory, lcm.IWfiMorphBundleFactory = "IWfiAnalysisFactory", "IWfiMorphBundleFactory"
    ki = types.ModuleType("SIL.LCModel.Core.KernelInterfaces")
    ki.ITsString = passthrough
    core = types.ModuleType("SIL.LCModel.Core")
    core.KernelInterfaces = ki
    lcm.Core = core
    sil = types.ModuleType("SIL")
    sil.LCModel = lcm
    system = types.ModuleType("System")
    system.Guid = str
    for name, mod in {"SIL": sil, "SIL.LCModel": lcm, "SIL.LCModel.Core": core, "SIL.LCModel.Core.KernelInterfaces": ki, "System": system}.items():
        monkeypatch.setitem(sys.modules, name, mod)
    objects = {}
    made = []

    def new_analysis():
        an = types.SimpleNamespace(ClassName="WfiAnalysis", Guid="an-%d" % len(made), CategoryRA=None, Owner=None)
        an.MorphBundlesOS = _Owning(an)
        made.append(an)
        return an

    def new_bundle():
        return types.SimpleNamespace(ClassName="WfiMorphBundle", Form=_Multi(), MorphRA=None, MsaRA=None, SenseRA=None, InflTypeRA=None)
    factories = {"IWfiAnalysisFactory": types.SimpleNamespace(Create=new_analysis),
                 "IWfiMorphBundleFactory": types.SimpleNamespace(Create=new_bundle)}
    wsm = types.SimpleNamespace(Get=lambda h: types.SimpleNamespace(Id={1: "xx", 2: "xx-Latn"}[int(h)]))
    sl = types.SimpleNamespace(GetService=lambda k: factories[k], GetObject=lambda g: objects[str(g)], WritingSystemManager=wsm)
    port = lcm_real.RealLcm("projects")
    port.cache = types.SimpleNamespace(ServiceLocator=sl, DefaultVernWs=1)

    def wordform(guid, alts):
        wf = types.SimpleNamespace(ClassName="WfiWordform", Guid=guid, Form=_Multi(alts), Checksum=5)
        wf.AnalysesOC = _Owning(wf)
        objects[guid] = wf
        return wf
    return types.SimpleNamespace(port=port, wordform=wordform, made=made)


def test_a_new_trivial_analysis_names_the_word_in_every_writing_system_it_has(analyses):
    port = analyses.port
    wf = analyses.wordform("wf-both", {1: "dari", 2: "DARI"})
    port.create_trivial_analysis("wf-both")
    an = analyses.made[-1]
    assert an.Owner is wf and wf.Checksum == 0, "owned by the wordform; FLEx's checksum reset"
    assert port._multi(an.MorphBundlesOS[0].Form) == {"xx": "dari", "xx-Latn": "DARI"}
    assert port._is_trivial(an) and port.find_trivial_analysis("wf-both") == an.Guid
    # a word written ONLY in the second orthography: its bundle is not left empty
    analyses.wordform("wf-second", {2: "KOTA"})
    port.create_trivial_analysis("wf-second")
    assert port._multi(analyses.made[-1].MorphBundlesOS[0].Form) == {"xx-Latn": "KOTA"}


def test_an_analysis_is_trivial_only_when_its_bundle_matches_the_word_in_every_writing_system(analyses):
    port = analyses.port
    analyses.wordform("wf-second", {2: "KOTA"})
    port.create_trivial_analysis("wf-second")
    an = analyses.made[-1]
    assert port._is_trivial(an)
    # a real analysis of that word (a different bundle form in ITS writing system) must not be taken for the
    # bare one: comparing the default vernacular only saw two empty strings and called them equal
    an.MorphBundlesOS[0].Form.set_String(2, _Tss("KO-TA"))
    assert not port._is_trivial(an)
    assert port.find_trivial_analysis("wf-second") is None
