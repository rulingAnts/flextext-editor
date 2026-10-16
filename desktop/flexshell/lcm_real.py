"""FlexPort on pythonnet + LibLCM — WINDOWS ONLY, and ⚠ UNTESTED: this file was written in a cloud
session with no FieldWorks, from the call sequences verified on the VM (plans/flex-desktop-segmenter.md
§5.2, handoff §4). desktop/vm/run_conformance.py runs desktop/tests/contract against it on a
disposable copy; until that has passed, every method here is [unverified] as code, even where the
call it makes is [verified] as a call.

Verified call sequences encoded (FieldWorks 9.3.12, SIL.LCModel 11.0.0.55180, ModelVersion 7000072,
Python 3.13, pythonnet):
  open      FLExProject().OpenProject(name, writeEnabled=…, undoable=True)  — never undoable=False
            usm = IUndoStackManager(cache.ServiceLocator.GetService(IUndoStackManager)); usm.StopSaveTimer()
            (GetInstance[T] is not reachable from pythonnet)
  UOW       refuse if ah.CurrentDepth > 0; h = UndoableUnitOfWorkHelper(ah, undo, redo); …
            success → h.set_RollBack(False) (the property assignment silently leaves it rolling back);
            h.Dispose(). On exception leave RollBack true and Dispose; if Dispose throws and depth is 1,
            ah.Rollback(0).
  save      usm.Save() at depth 0, then ds = IDataSetup(cache.ServiceLocator.GetService(IDataSetup))
            (SIL.LCModel.Infrastructure); ds.GetType().GetMethod("CompleteAllCommits").Invoke(ds, None)
  backup    ProjectBackupService(cache, BackupProjectSettings(cache, None,
            FwDirectoryFinder.DefaultBackupDirectory, fwVersion)) with all Include* false, then
            .BackupProject(HeadlessThreadedProgress(), None) at depth 0
  peers     SharedBackendServices.AreMultipleApplicationsConnected(cache)
  import    clr.AddReference("ITextDll"); SIL.FieldWorks.IText.LinguaLinksImport(...)
            .ImportInterlinear(HeadlessThreadedProgress(), [path]) inside our UOW (it joins it)
  export    FLEx's InterlinearExporter, mode "elan" (mode "xml" drops all times)
  undo/redo ah.Undo() / ah.Redo() directly; require UndoResult.kuresSuccess
  reparse   ParagraphParser(cache).ForceParse(para)
  invariant [s.BeginOffset for s in para.SegmentsOS] == [x.IchMin for x in
            SegmentServices.GetSegments(para.Contents, cache.WritingSystemFactory)]
Every LCM call happens on ONE worker thread (worker.py); this class asserts it.

pythonnet RULES (audited 2026-10-14 against pyflexicon 4.13's own code + liblcm source, after six
VM launches each died on the next line — plan §2.4 items 9–10):
  - services/factories/repositories: ServiceLocator.GetService(IFoo) — the generic GetInstance<T>
    is not reachable; pyflexicon uses GetService in 40+ places.
  - an object by GUID: ServiceLocator.GetObject(System.Guid(g)) → typed ICmObject → _cast().
  - pythonnet respects .NET interface typing STRICTLY: an element of ParagraphsOS is an IStPara
    (no Contents, no SegmentsOS), of AnalysesRS an IAnalysis (no Form), .Owner an ICmObject.
    _cast(obj) = SIL.LCModel.I<ClassName>(obj), total (returns obj unchanged when it cannot).
  - IMultiString/IMultiUnicode: ITsString(ms.get_String(ws)).Text; the alternatives present are
    ms.AvailableWritingSystemIds. IStTxtPara.Contents is a bare ITsString: the writing system of
    run 0 is Contents.get_Properties(0).GetIntPropValues(1, 0)[0] (ktptWs == 1; out param → tuple).
  - `out` parameters come back as a tuple when omitted from the call (TryGetObject, BackupProject).
  - a CLR PROPERTY getter that throws surfaces as a bare TypeError: probe state, never catch types.
"""

import logging
import os
import threading

from . import mediafind
from .errors import FlexError
from .port import FlexPort, COUNTED_CLASSES, UNDO_SUCCESS, UNDO_FAILED, lcm_diff, nfd, nfc

LOG = logging.getLogger("flexshell.lcm_real")
UNTESTED = True   # flipped to False only by a passing desktop/vm/run_conformance.py (it edits the stamp, not this file)


class RealBackendFactory:
    def __init__(self, projects_dir=None):
        from . import fwfind
        self.projects_dir = projects_dir or fwfind.projects_dir()
        self._info = None

    def __call__(self):
        return RealLcm(self.projects_dir)

    def install_info(self):
        if self._info is None:
            from . import fwfind
            code = fwfind.code_dir()
            info = {"fwVersion": fwfind.fw_version(code), "lcmVersion": None, "modelVersion": None,
                    "projectsDir": self.projects_dir, "backend": "real", "codeDir": code}
            try:
                _load_assemblies(code)
                from SIL.LCModel import LcmCache   # type: ignore[import-not-found]
                info["modelVersion"] = int(LcmCache.ModelVersion)
                import System   # type: ignore[import-not-found]
                info["lcmVersion"] = str(System.Reflection.Assembly.GetAssembly(LcmCache).GetName().Version)
            except Exception as e:   # noqa: BLE001
                info["error"] = str(e)
            self._info = info
        return self._info


def _load_assemblies(code_dir):
    """Add FLEx's install folder to the assembly search path and load its own DLLs, so the model
    version always matches the user's FLEx (plan §12.1). LibLCM is NOT bundled."""
    import clr   # type: ignore[import-not-found]
    import sys
    if code_dir and code_dir not in sys.path:
        sys.path.append(code_dir)
    for asm in ("SIL.LCModel", "SIL.LCModel.Core", "SIL.LCModel.Utils", "SIL.LCModel.Infrastructure", "SIL.LCModel.DomainServices"):
        try:
            clr.AddReference(asm)
        except Exception:   # noqa: BLE001 — some are folded into others depending on version
            pass


def _flexicon():
    """pyflexicon — import name `flexicon` (4.x; `flexlibs2` is its deprecated alias). Every verified
    call sequence in the plan ran against it. ⚠ NEVER FLExTools' `flexlibs`: a different library that
    may sit on the same machine (it did on the VM, 2026-10-14, and was picked up first), whose
    OpenProject has no `undoable` and opens one session-long non-undoable task — the write protocol
    cannot run on it. The signature check makes a wrong library a clear refusal, not a TypeError."""
    mod = None
    for name in ("flexicon", "flexlibs2"):
        try:
            mod = __import__(name)
            break
        except ImportError:
            continue
    if mod is None:
        raise FlexError("E_INTERNAL", "pyflexicon is not installed (py -m pip install pyflexicon); "
                        "the FLEx shell does not use FLExTools' flexlibs", {"library": "pyflexicon"})
    import inspect
    try:
        params = inspect.signature(mod.FLExProject.OpenProject).parameters
    except (AttributeError, TypeError, ValueError):
        params = {}
    if "undoable" not in params or "writeEnabled" not in params:
        raise FlexError("E_INTERNAL", "the installed %s is not pyflexicon 4.x (FLExProject.OpenProject has no "
                        "`undoable`); install pyflexicon" % mod.__name__, {"library": mod.__name__})
    return mod


_initialised = False


def _initialise_once(fx):
    """FLExInitialize() once per process before the first open — registry, ICU and the SLDR
    (offline). Without it liblcm finds the SLDR down, renames the project's .ldml files to
    .ldml.bad and re-synthesises its writing systems on every open (pyflexicon #249) — a write to
    the project folder even in a read-only session, so it is not optional. FLExCleanup() at exit."""
    global _initialised
    if _initialised:
        return
    fx.FLExInitialize()
    _initialised = True
    import atexit
    atexit.register(_cleanup_quietly, fx)


def _cleanup_quietly(fx):
    try:
        fx.FLExCleanup()
    except Exception:   # noqa: BLE001 — teardown; nothing left to protect
        pass


def _fw_directory_finder():
    """FwDirectoryFinder is a FieldWorks type (SIL.FieldWorks.Common.FwUtils, FwUtils.dll), not a
    liblcm one [source]; pyflexicon's FLExGlobals already references FwUtils, this is the backstop."""
    import clr   # type: ignore[import-not-found]
    try:
        clr.AddReference("FwUtils")
    except Exception:   # noqa: BLE001 — already referenced by flexicon
        pass
    from SIL.FieldWorks.Common.FwUtils import FwDirectoryFinder   # type: ignore[import-not-found]
    return FwDirectoryFinder


def _map_open_error(e):
    """pyflexicon's open-time exceptions → our codes (matched by class name so the module need not
    be importable on Linux). Anything else is returned unchanged."""
    n = type(e).__name__
    msg = str(e) or n
    if n == "FP_FileLockedError":
        return FlexError("E_LOCKED_OTHER", "the project is locked by another program", {"lib": msg})
    if n == "FP_MigrationRequired":
        return FlexError("E_MODEL_OLDER", "the project needs FLEx's own data migration first — open it in FLEx once", {"lib": msg})
    if n == "FP_FileNotFoundError":
        return FlexError("E_NOT_FOUND", "no such project", {"lib": msg})
    if n == "FP_ProjectError":
        return FlexError("E_INTERNAL", "FLEx could not open the project: " + msg, {"lib": msg})
    return e


def _epoch_ms(dt):
    """A .NET DateTime (LCM's DateCreated / DateModified) → epoch milliseconds (UTC), or None when unset."""
    if dt is None:
        return None
    try:
        ms = (int(dt.ToUniversalTime().Ticks) - 621355968000000000) // 10000
    except Exception:   # noqa: BLE001
        return None
    return ms if ms > 0 else None


def _cast(obj):
    """pythonnet respects .NET interface typing strictly (pyflexicon lcm_casting): an element of a
    collection or an .Owner is typed as the base interface and exposes nothing of the concrete one.
    Cast by ClassName to SIL.LCModel.I<ClassName>; TOTAL — anything that cannot be cast is returned
    unchanged (an unrecognised class, no ClassName, a CLR cast failure)."""
    name = getattr(obj, "ClassName", None)
    if not name:
        return obj
    try:
        import SIL.LCModel as lcm   # type: ignore[import-not-found]
        iface = getattr(lcm, "I" + str(name), None)
        return iface(obj) if iface is not None else obj
    except Exception:   # noqa: BLE001 — total by design
        return obj


class RealLcm(FlexPort):
    def __init__(self, projects_dir):
        self.projects_dir = projects_dir
        self.project = None       # pyflexicon FLExProject (flexicon)
        self.cache = None
        self.ah = None            # IActionHandler
        self.usm = None           # IUndoStackManager
        self._name = None
        self._write = False
        self._open = False
        self._thread = None
        self._handlers = []
        self._handle = None

    # ---- thread rule -------------------------------------------------------------------------
    def _t(self):
        if self._thread is None:
            self._thread = threading.get_ident()
        elif self._thread != threading.get_ident():
            raise RuntimeError("LCM call off the worker thread (would wedge the session)")

    # ---- session -------------------------------------------------------------------------------
    def open(self, name, write):
        self._t()
        fx = _flexicon()
        _initialise_once(fx)
        _load_assemblies(None)
        self.project = fx.FLExProject()
        # The full .fwdata path when the project sits in OUR projects folder (which is what
        # list_projects enumerated); the bare name falls back to FLEx's default location.
        fwdata = os.path.join(self.projects_dir, name, name + ".fwdata") if self.projects_dir else ""
        target = fwdata if fwdata and os.path.isfile(fwdata) else name
        try:
            # headless UI + data migration disabled are pyflexicon's defaults [source]; never undoable=False [verified]
            self.project.OpenProject(target, writeEnabled=bool(write), undoable=True)
        except Exception as e:   # noqa: BLE001
            mapped = _map_open_error(e)
            if mapped is e:
                raise
            raise mapped from e
        self.cache = self.project.project
        from SIL.LCModel import IUndoStackManager   # type: ignore[import-not-found]  # InterfaceDeclarations.cs: SIL.LCModel, NOT .Infrastructure
        # pyflexicon: usm = self.ObjectRepository(IUndoStackManager) == ServiceLocator.GetService(…)
        self.usm = self.cache.ServiceLocator.GetService(IUndoStackManager)
        self.ah = self.cache.ActionHandlerAccessor
        self._name = name
        self._write = bool(write)
        self._open = True
        return True

    def close_without_save(self):
        """LcmCache.Dispose() without Save() [source: saves nothing; unverified as the poisoned-close
        path, V-5]. Deliberately NOT flexicon's CloseProject(), which saves [verified]."""
        self._t()
        if self.cache is not None:
            try:
                self.cache.Dispose()
            finally:
                self.cache = None
                self.project = None
                self._open = False

    def stop_save_timer(self):
        self._t()
        self.usm.StopSaveTimer()   # IUndoStackManager.StopSaveTimer [source: InterfaceDeclarations.cs]

    def subscribe_log(self, handler):
        """Attach to flexicon's headless-UI logger (flexicon.code.headless_ui logs ERROR on
        ReportException / ReportDuplicateGuids / ConflictingSave): any ERROR record is the only
        signal of a silent save failure [verified]. ⚠ pyflexicon's loggers ONLY — never the root
        logger: an ERROR anywhere in the process (the page bridge, the web view, this shell's own
        console tracing) is not FLEx reporting a failed save, and must never close a project."""
        for name in ("flexicon", "flexlibs2", "FwLcmUI"):
            logging.getLogger(name).addHandler(handler)
        self._handlers.append(handler)

    def are_multiple_apps_connected(self):
        self._t()
        from SIL.LCModel.DomainServices import SharedBackendServices   # type: ignore[import-not-found]
        return bool(SharedBackendServices.AreMultipleApplicationsConnected(self.cache))

    def has_unsaved_changes(self):
        self._t()
        return bool(self.usm.HasUnsavedChanges)

    def save(self):
        self._t()
        if self.ah.CurrentDepth > 0:
            raise RuntimeError("Save at depth > 0 (Commit at wrong place)")
        self.usm.Save()
        return True

    def complete_all_commits(self):
        self._t()
        from SIL.LCModel.Infrastructure import IDataSetup   # type: ignore[import-not-found]
        ds = self.cache.ServiceLocator.GetService(IDataSetup)
        ds.GetType().GetMethod("CompleteAllCommits").Invoke(ds, None)   # [verified] via reflection

    def backup(self, comment):
        self._t()
        if self.ah.CurrentDepth > 0:
            raise RuntimeError("BackupProject inside a unit of work")
        from SIL.LCModel.DomainServices.BackupRestore import ProjectBackupService, BackupProjectSettings   # type: ignore[import-not-found]
        FwDirectoryFinder = _fw_directory_finder()
        HeadlessThreadedProgress = _flexicon().HeadlessThreadedProgress   # pyflexicon's own (headless_ui), not a liblcm type
        from . import fwfind
        settings = BackupProjectSettings(self.cache, None, FwDirectoryFinder.DefaultBackupDirectory, fwfind.fw_version() or "9.3")
        if hasattr(settings, "Comment"):
            settings.Comment = comment or ""
        for flag in ("IncludeConfigurationSettings", "IncludeLinkedFiles", "IncludeSupportingFiles", "IncludeSpellCheckAdditions", "IncludeMediaFiles", "IncludeFonts", "IncludeKeyboards"):
            if hasattr(settings, flag):
                setattr(settings, flag, False)
        svc = ProjectBackupService(self.cache, settings)
        # bool BackupProject(IThreadedProgress, out string backupFile) [source]: with the out
        # parameter omitted pythonnet returns (ok, path)
        r = svc.BackupProject(HeadlessThreadedProgress())
        ok, path = (r[0], r[1]) if isinstance(r, tuple) else (bool(r), None)
        if not ok or not path:
            raise RuntimeError("BackupProject did not report a backup file")
        return str(path)

    def backup_dir(self):
        return str(_fw_directory_finder().DefaultBackupDirectory)

    def fwdata_path(self):
        return os.path.join(self.project_dir(), self._name + ".fwdata")

    def project_dir(self):
        return os.path.join(self.projects_dir, self._name)

    def linked_files_dir(self):
        """LangProject.LinkedFilesRootDir: a model property whose override returns the absolute path,
        <ProjectFolder>\\LinkedFiles unless set [source: OverridesLangProj.cs]; pyflexicon reads
        lp.LinkedFilesRootDir the same way (FLExProject.GetLinkedFilesDir)."""
        self._t()
        try:
            d = str(self.cache.LanguageProject.LinkedFilesRootDir or "")
        except Exception:   # noqa: BLE001 — a throwing CLR property getter surfaces as a bare TypeError
            d = ""          # (pyflexicon EXCEPTION_HANDLING.md); the default folder is the right fallback
        return d or os.path.join(self.project_dir(), "LinkedFiles")

    def project_name(self):
        return self._name

    def model_version(self):
        from SIL.LCModel import LcmCache   # type: ignore[import-not-found]
        return int(LcmCache.ModelVersion)

    def versions(self):
        from . import fwfind
        return {"fw": fwfind.fw_version(), "lcm": None, "model": self.model_version(), "backend": "real", "untested": UNTESTED}

    # ---- pythonnet idioms (module docstring) -----------------------------------------------------
    def _repo(self, iface):
        return self.cache.ServiceLocator.GetService(iface)

    def _lookup(self, guid):
        """ServiceLocator.GetObject(Guid) → ICmObject, cast to its concrete interface."""
        import System   # type: ignore[import-not-found]
        return _cast(self.cache.ServiceLocator.GetObject(System.Guid(str(guid))))

    _text = _para = _segment = _obj = _lookup

    def _tss_text(self, tss):
        """ITsString → str ('' for null), via the explicit ITsString cast pyflexicon applies."""
        if tss is None:
            return ""
        from SIL.LCModel.Core.KernelInterfaces import ITsString   # type: ignore[import-not-found]
        return nfc(str(ITsString(tss).Text or ""))

    def _multi(self, ms):
        """Every non-empty alternative of an IMultiString/IMultiUnicode: {ws id: text}."""
        out = {}
        if ms is None:
            return out
        for handle in list(ms.AvailableWritingSystemIds):
            text = self._tss_text(ms.get_String(handle))
            if text:
                out[self._ws_id(handle)] = text
        return out

    def _best(self, ms):
        return self._tss_text(ms.BestAnalysisAlternative) if ms is not None else ""

    def _run0_ws(self, tss):
        """Writing system of run 0 of a bare ITsString (pyflexicon ParagraphOperations idiom):
        get_Properties(0).GetIntPropValues(ktptWs=1, out var) → (value, var)."""
        if tss is None or not tss.Length:
            return int(self.cache.DefaultVernWs)
        r = tss.get_Properties(0).GetIntPropValues(1, 0)
        return int(r[0] if isinstance(r, tuple) else r)

    def _ws_id(self, handle):
        return str(self.cache.ServiceLocator.WritingSystemManager.Get(int(handle)).Id)

    def _ws_handle(self, ws_id):
        h = int(self.cache.ServiceLocator.WritingSystemManager.GetWsFromStr(ws_id))
        if h <= 0:
            raise FlexError("E_SCOPE", "unknown writing system", {"ws": ws_id})
        return h

    def _tss(self, text, ws_handle):
        from SIL.LCModel.Core.Text import TsStringUtils   # type: ignore[import-not-found]
        return TsStringUtils.MakeString(nfd(text or ""), int(ws_handle))

    # ---- reads -----------------------------------------------------------------------------------
    def counts(self):
        self._t()
        from SIL.LCModel import (ILexEntryRepository, ILexSenseRepository, IMoFormRepository, IWfiWordformRepository,   # type: ignore[import-not-found]
                                 IWfiAnalysisRepository, IWfiGlossRepository, IWfiMorphBundleRepository,
                                 IPunctuationFormRepository, ITextRepository, IStTextRepository, IStTxtParaRepository,
                                 ISegmentRepository, ICmMediaContainerRepository, ICmMediaURIRepository)
        repos = {"LexEntry": ILexEntryRepository, "LexSense": ILexSenseRepository, "MoForm": IMoFormRepository,
                 "WfiWordform": IWfiWordformRepository, "WfiAnalysis": IWfiAnalysisRepository, "WfiGloss": IWfiGlossRepository,
                 "WfiMorphBundle": IWfiMorphBundleRepository, "PunctuationForm": IPunctuationFormRepository, "Text": ITextRepository,
                 "StText": IStTextRepository, "StTxtPara": IStTxtParaRepository, "Segment": ISegmentRepository,
                 "CmMediaContainer": ICmMediaContainerRepository, "CmMediaURI": ICmMediaURIRepository}
        return {cls: int(self._repo(repos[cls]).Count) for cls in COUNTED_CLASSES}   # IRepository<T>.Count [source]

    def writing_systems(self):
        self._t()
        wsc = self.cache.ServiceLocator.WritingSystems   # IWritingSystemContainer [source]

        def one(ws, default):
            extra = []
            try:
                for ch in (ws.CharacterSets or []):
                    if str(getattr(ch, "Type", "")) == "main":
                        extra.extend([str(c) for c in ch.Characters if str(c) and not str(c).isspace()])
            except Exception:   # noqa: BLE001 — CharacterSets is SIL.WritingSystems territory; optional
                pass
            try:   # WritingSystemDefinition.DisplayLabel — what FLEx's own lists show [source]
                name = str(ws.DisplayLabel or "")
            except Exception:   # noqa: BLE001 — a label is comfort, the id is the identity
                name = ""
            return {"id": str(ws.Id), "abbr": str(ws.Abbreviation or ""), "name": name or str(ws.Abbreviation or "") or str(ws.Id),
                    "isDefault": default, "rtl": bool(ws.RightToLeftScript), "graphite": bool(getattr(ws, "IsGraphiteEnabled", False)),
                    "wordForming": extra}
        dv, da = wsc.DefaultVernacularWritingSystem, wsc.DefaultAnalysisWritingSystem
        vern = [one(w, w.Handle == dv.Handle) for w in wsc.CurrentVernacularWritingSystems]
        anal = [one(w, w.Handle == da.Handle) for w in wsc.CurrentAnalysisWritingSystems]
        return {"vern": vern, "anal": anal}

    def _paras(self, text):
        """IStTxtPara for every paragraph (ParagraphsOS yields the base IStPara)."""
        from SIL.LCModel import IStTxtPara   # type: ignore[import-not-found]
        st = text.ContentsOA
        return [IStTxtPara(p) for p in st.ParagraphsOS] if st is not None else []

    def _media_uris(self, text):
        """[(ICmMediaURI, path)] — MediaFilesOA is reached on the cast text (pyflexicon R4 note)."""
        cont = getattr(text, "MediaFilesOA", None)
        if cont is None:
            return []
        return [(u, str(u.MediaURI or "")) for u in cont.MediaURIsOC]

    def _analysis_ref(self, obj, ws_handle=None):
        """`form` is the occurrence as its paragraph holds it (the paragraph's writing system; the
        default vernacular when the wordform has nothing there); `forms` every vernacular alternative
        the wordform has (IMultiUnicode), for a text shown in another vernacular writing system."""
        from SIL.LCModel import IWfiWordform, IWfiAnalysis   # type: ignore[import-not-found]
        obj = _cast(obj)
        vern = int(ws_handle) if ws_handle else int(self.cache.DefaultVernWs)
        g = str(obj.Guid)
        cn = str(obj.ClassName)
        if cn == "PunctuationForm":
            return {"guid": g, "kind": "punct", "form": self._tss_text(obj.Form)}

        def wf_fields(wf):
            form = self._tss_text(wf.Form.get_String(vern)) or self._tss_text(wf.Form.get_String(self.cache.DefaultVernWs))
            return {"form": form, "forms": self._multi(wf.Form), "wordformGuid": str(wf.Guid)}
        if cn == "WfiWordform":
            return {"guid": g, "kind": "wordform", **wf_fields(obj)}
        if cn == "WfiAnalysis":
            return {"guid": g, "kind": "analysis", **wf_fields(IWfiWordform(obj.Owner)), "analysisGuid": g}
        if cn == "WfiGloss":
            an = IWfiAnalysis(obj.Owner)
            return {"guid": g, "kind": "gloss", **wf_fields(IWfiWordform(an.Owner)), "analysisGuid": str(an.Guid),
                    "gloss": self._multi(obj.Form)}
        return {"guid": g, "kind": cn, "form": ""}

    def _seg_read(self, para, seg, ws_handle=None):
        seg = _cast(seg)
        return {"guid": str(seg.Guid), "begin": int(seg.BeginOffset), "end": int(seg.EndOffset),
                "ft": self._multi(seg.FreeTranslation), "lt": self._multi(seg.LiteralTranslation),
                "notes": [self._best(_cast(n).Content) for n in seg.NotesOS],
                "analyses": [self._analysis_ref(a, ws_handle) for a in seg.AnalysesRS],
                "beginTime": str(seg.BeginTimeOffset) if seg.BeginTimeOffset else None,   # Unicode in the model
                "endTime": str(seg.EndTimeOffset) if seg.EndTimeOffset else None,
                "mediaUri": str(seg.MediaURIRA.Guid) if seg.MediaURIRA is not None else None,
                "speaker": str(seg.SpeakerRA.Guid) if seg.SpeakerRA is not None else None,
                "isLabel": bool(seg.IsLabel)}

    def list_texts(self):
        self._t()
        from SIL.LCModel import ITextRepository   # type: ignore[import-not-found]
        out = []
        for t in self._repo(ITextRepository).AllInstances():
            t = _cast(t)
            paras = self._paras(t)
            segs = [_cast(s) for p in paras for s in p.SegmentsOS]
            lf = self.linked_files_dir()
            media = [{"guid": str(u.Guid), "uri": path, "exists": mediafind.link_exists(path, lf)} for u, path in self._media_uris(t)]
            st = t.ContentsOA
            stamps = [x for x in (_epoch_ms(getattr(t, "DateModified", None)), _epoch_ms(getattr(st, "DateModified", None) if st is not None else None)) if x is not None]
            out.append({"guid": str(t.Guid), "title": self._best(t.Name), "paras": len(paras), "segs": len(segs),
                        "timedSegs": sum(1 for s in segs if s.BeginTimeOffset), "media": media,
                        "labelSegs": sum(1 for s in segs if s.IsLabel),
                        # for sorting and filtering the list (plan §11.1): FLEx's own dates and genres
                        "created": _epoch_ms(getattr(t, "DateCreated", None)), "modified": max(stamps) if stamps else None,
                        "genres": self._genres(t)})
        return out

    def _genres(self, text):
        """IText.GenresRC: the text's genres from the project's genre list, {guid, name}."""
        out = []
        try:
            for g in text.GenresRC:
                g = _cast(g)
                out.append({"guid": str(g.Guid), "name": self._best(g.Name)})
        except Exception:   # noqa: BLE001 — the list's sort and filter are comfort; never fail a listing for them
            LOG.warning("genres not read for a text")
        return out

    def read_text(self, guid):
        self._t()
        t = self._text(guid)
        wsc = self.cache.ServiceLocator.WritingSystems
        paras = []
        for p in self._paras(t):
            contents = p.Contents
            wsh = self._run0_ws(contents)
            paras.append({"guid": str(p.Guid), "contents": self._tss_text(contents), "ws": self._ws_id(wsh),
                          "segments": [self._seg_read(p, s, wsh) for s in p.SegmentsOS], "style": str(p.StyleName or "") or None})
        media = [{"guid": str(u.Guid), "uri": path} for u, path in self._media_uris(t)]
        cont = getattr(t, "MediaFilesOA", None)
        return {"guid": str(guid), "title": self._best(t.Name), "paragraphs": paras, "media": media,
                "mediaContainer": str(cont.Guid) if cont is not None else None,
                "vernWs": str(wsc.DefaultVernacularWritingSystem.Id), "analWss": [str(w.Id) for w in wsc.CurrentAnalysisWritingSystems]}

    def get_segments(self, text, ws):
        self._t()
        from SIL.LCModel.DomainServices import SegmentServices   # type: ignore[import-not-found]
        tss = self._tss(text, self._ws_handle(ws))
        # extension method GetSegments(this ITsString, ILgWritingSystemFactory) called statically [source]
        return [(int(x.IchMin), int(x.IchLim)) for x in SegmentServices.GetSegments(tss, self.cache.WritingSystemFactory)]

    def get_diffs(self, old, new):
        """TsStringUtils.GetDiffsInTsStrings(old, new) → TsStringDiffInfo (null when identical) [source];
        lcm_diff when the call is not reachable — the protocol compares the two anyway."""
        self._t()
        try:
            from SIL.LCModel.Core.Text import TsStringUtils   # type: ignore[import-not-found]
            ws = self.cache.DefaultVernWs
            r = TsStringUtils.GetDiffsInTsStrings(self._tss(old, ws), self._tss(new, ws))
            if r is None:
                return (0, 0, 0)
            return (int(r.IchFirstDiff), int(r.CchInsert), int(r.CchDeleteFromOld))
        except Exception:   # noqa: BLE001
            pass
        return lcm_diff(nfd(old), nfd(new))

    def has_punct_form(self, form):
        self._t()
        from SIL.LCModel import IPunctuationFormRepository   # type: ignore[import-not-found]
        return any(nfd(self._tss_text(p.Form)) == nfd(form) for p in self._repo(IPunctuationFormRepository).AllInstances())

    def has_wordform(self, form, ws=None):
        return self.find_wordform(form, ws) is not None

    def find_wordform(self, form, ws=None):
        self._t()
        from SIL.LCModel import IWfiWordformRepository   # type: ignore[import-not-found]
        repo = self._repo(IWfiWordformRepository)
        tss = self._tss(form, self._ws_handle(ws) if ws else self.cache.DefaultVernWs)
        # bool TryGetObject(ITsString, out IWfiWordform) [source]: the out parameter omitted → (ok, wf)
        r = repo.TryGetObject(tss)
        ok, wf = (r[0], r[1]) if isinstance(r, tuple) else (r, None)
        return str(wf.Guid) if ok and wf is not None else None

    def force_parse(self, para_guid):
        self._t()
        from SIL.LCModel.DomainServices import ParagraphParser   # type: ignore[import-not-found]
        ParagraphParser(self.cache).ForceParse(self._para(para_guid))   # ParagraphParser(LcmCache); ForceParse(IStTxtPara) [source]

    def export_elan(self, text_guid):
        """FLEx's InterlinearExporter, mode `elan` [verified: mode xml drops all times], built as
        FLEx's InterlinearExportDialog builds it [source]: ExportDisplay() dereferences the view
        constructor, so a real InterlinVc with DefaultChoices; root object = the text's StText.
        Which lines the elan export then carries is [unverified] (V-1)."""
        self._t()
        import clr   # type: ignore[import-not-found]
        clr.AddReference("ITextDll")
        from SIL.FieldWorks.IText import InterlinearExporter, InterlinVc, InterlinLineChoices   # type: ignore[import-not-found]
        from System.IO import StringWriter   # type: ignore[import-not-found]
        from System.Xml import XmlWriter, XmlWriterSettings   # type: ignore[import-not-found]
        sw = StringWriter()
        settings = XmlWriterSettings()
        settings.Indent = True
        xw = XmlWriter.Create(sw, settings)
        t = self._text(text_guid)
        vc = InterlinVc(self.cache)
        choices = InterlinLineChoices.DefaultChoices(self.cache.LanguageProject, int(self.cache.DefaultVernWs), int(self.cache.DefaultAnalWs))
        vc.LineChoices = choices
        exporter = InterlinearExporter.Create("elan", self.cache, xw, t.ContentsOA, choices, vc)
        exporter.WriteBeginDocument()
        exporter.ExportDisplay()
        exporter.WriteEndDocument()
        xw.Close()
        return str(sw.ToString())

    # ---- UOW ---------------------------------------------------------------------------------------
    def begin_uow(self, undo_label, redo_label):
        self._t()
        if self.ah.CurrentDepth > 0:
            raise RuntimeError("Nested tasks are not supported")
        from SIL.LCModel.Infrastructure import UndoableUnitOfWorkHelper   # type: ignore[import-not-found]
        h = UndoableUnitOfWorkHelper(self.ah, undo_label, redo_label)   # pyflexicon undoable_operation.py does the same
        self._handle = h
        return h

    def commit(self, handle):
        self._t()
        handle.set_RollBack(False)   # ⚠ NOT `handle.RollBack = False`: that silently keeps rolling back [verified; pyflexicon agrees]
        try:
            handle.Dispose()
        except Exception:
            if self.ah.CurrentDepth == 1:
                self.ah.Rollback(0)
            raise
        finally:
            self._handle = None

    def rollback(self, handle):
        self._t()
        try:
            handle.set_RollBack(True)
            handle.Dispose()          # RollBack true → the UOW is rolled back
        except Exception:
            if self.ah.CurrentDepth == 1:
                self.ah.Rollback(0)
            raise
        finally:
            self._handle = None

    def depth(self):
        self._t()
        return int(self.ah.CurrentDepth)

    def undo_item_count(self):
        """FLEx's history items — IActionHandler.UndoableSequenceCount, the number of undo bundles (the
        times the user could press Undo). ⚠ NEVER UndoableActionCount: the same-sounding property sums the
        CHANGES in every bundle (liblcm UndoStack.cs: m_undoBundles.Sum(uow => uow.Changes.Count)), and
        ending a task adds DateModified changes of its own (EndUndoTaskCommon), so a save of ONE change
        grew it by 2 or more — W5 read that as a second history item and closed the project unsaved
        (2026-10-16, the first real saves). [source: UndoStack.cs; declared on IActionHandler in
        SIL.LCModel.Core, checked in the 10.1.0 assembly]"""
        self._t()
        return int(self.ah.UndoableSequenceCount)

    def last_undo_text(self):
        self._t()
        try:
            return str(self.ah.GetUndoText())
        except Exception:   # noqa: BLE001
            return None

    def _undo_result(self, r):
        s = str(r)
        return UNDO_SUCCESS if "kuresSuccess" in s or s == "0" else (UNDO_FAILED if "Failed" in s else s)

    def undo(self):
        self._t()
        if self.ah.CurrentDepth > 0:
            raise RuntimeError("Undo inside a task")
        return self._undo_result(self.ah.Undo())

    def redo(self):
        self._t()
        if self.ah.CurrentDepth > 0:
            raise RuntimeError("Redo inside a task")
        return self._undo_result(self.ah.Redo())

    # ---- writes ------------------------------------------------------------------------------------
    def set_contents(self, para_guid, text):
        """ONE Contents assignment, built by editing the existing TsString so untouched runs keep
        their properties; the replaced range takes the writing system of run 0 — pyflexicon's
        SetBaselineText idiom (bldr.ReplaceTsString + MakeString), minimal diff from lcm_diff."""
        self._t()
        p = self._para(para_guid)
        old = p.Contents
        old_text = str(old.Text or "") if old is not None else ""
        ich, ins, dele = lcm_diff(old_text, nfd(text))
        bldr = old.GetBldr()
        bldr.ReplaceTsString(ich, ich + dele, self._tss(nfd(text)[ich:ich + ins], self._run0_ws(old)))
        p.Contents = bldr.GetString()

    def split_para_at(self, para_guid, ich):
        self._t()
        newp = self._para(para_guid).SplitParaAt(int(ich))   # IStTxtPara SplitParaAt(int) [source]
        return str(newp.Guid)

    def merge_para_with_next(self, para_guid):
        self._t()
        self._para(para_guid).MergeParaWithNext()   # [source]

    def set_segment_times(self, seg_guid, begin, end):
        self._t()
        s = self._segment(seg_guid)
        s.BeginTimeOffset = "" if begin is None else str(int(begin))   # Unicode in the model
        s.EndTimeOffset = "" if end is None else str(int(end))

    def set_segment_media(self, seg_guid, uri_guid):
        self._t()
        self._segment(seg_guid).MediaURIRA = self._obj(uri_guid) if uri_guid else None

    def set_segment_speaker(self, seg_guid, speaker_guid):
        self._t()
        self._segment(seg_guid).SpeakerRA = self._obj(speaker_guid) if speaker_guid else None

    def set_free_translation(self, seg_guid, ws, text):
        self._t()
        h = self._ws_handle(ws)
        self._segment(seg_guid).FreeTranslation.set_String(h, self._tss(text, h))

    def set_literal_translation(self, seg_guid, ws, text):
        self._t()
        h = self._ws_handle(ws)
        self._segment(seg_guid).LiteralTranslation.set_String(h, self._tss(text, h))

    def set_analysis(self, seg_guid, index, analysis_guid):
        self._t()
        s = self._segment(seg_guid)
        s.AnalysesRS[int(index)] = self._obj(analysis_guid)   # pyflexicon SetAnalysis writes the indexer the same way

    def _is_trivial(self, an):
        """No category and at most one bundle that names nothing but the word itself — in EVERY
        writing system the bundle has a form in (a text in a second vernacular writing system has
        nothing in the default one, where a one-system comparison was always equal)."""
        from SIL.LCModel import IWfiWordform   # type: ignore[import-not-found]
        if an.CategoryRA is not None:
            return False
        bundles = [_cast(b) for b in an.MorphBundlesOS]
        if not bundles:
            return True
        if len(bundles) != 1:
            return False
        mb = bundles[0]
        if not (mb.MorphRA is None and mb.MsaRA is None and mb.SenseRA is None and mb.InflTypeRA is None):
            return False
        wf_forms = self._multi(IWfiWordform(an.Owner).Form)
        return all(wf_forms.get(ws, "") == text for ws, text in self._multi(mb.Form).items() if text)

    def find_trivial_analysis(self, wordform_guid):
        self._t()
        wf = self._obj(wordform_guid)
        for an in wf.AnalysesOC:
            if self._is_trivial(_cast(an)):
                return str(an.Guid)
        return None

    def create_trivial_analysis(self, wordform_guid):
        """As FLEx does [source; unverified on the VM, V-12]."""
        self._t()
        from SIL.LCModel import IWfiAnalysisFactory, IWfiMorphBundleFactory   # type: ignore[import-not-found]
        wf = self._obj(wordform_guid)
        an = self._repo(IWfiAnalysisFactory).Create()
        wf.AnalysesOC.Add(an)
        mb = self._repo(IWfiMorphBundleFactory).Create()
        an.MorphBundlesOS.Add(mb)
        # the bundle names the word in every writing system the wordform has (only the default
        # vernacular's left a word of a second vernacular writing system with an empty bundle)
        for h in list(wf.Form.AvailableWritingSystemIds):
            mb.Form.set_String(int(h), wf.Form.get_String(int(h)))
        wf.Checksum = 0
        return str(an.Guid)

    def glosses_of(self, analysis_guid):
        self._t()
        return [{"guid": str(g.Guid), "forms": self._multi(g.Form)} for g in self._obj(analysis_guid).MeaningsOC]

    # ---- FLEx's guesses (read-only) ------------------------------------------------------------------
    def guesses(self, text_guid):
        """FLEx's best guess for each word of the text that has no analysis of its own — what FLEx's
        interlinear shows in blue — computed READ-ONLY with FLEx's ranking (liblcm AnalysisGuessServices):
        an analysis chosen in texts first, by how often (analysis or one of its glosses); else
        human-approved, parser-approved, computer-made, no opinion, parser-disapproved; never a
        human-disapproved one; ties by GUID. Then that analysis's gloss chosen most often in texts, else
        its first by GUID. ⚠ NEVER through AnalysisGuessServices itself: its GetBestGuess creates computer
        analyses from the lexicon (GenerateEntryGuesses, in a NON-undoable unit of work) — a write inside a
        read, outside the save protocol. FLEx also weighs the words either side; this does not, so where
        FLEx's choice hangs on context, the two can differ.
        → {segGuid: {index: {analysisGuid, glossGuid|None, gloss: {ws: text}}}}"""
        self._t()
        lp = self.cache.LanguageProject
        agents = {"parser": getattr(lp, "DefaultParserAgent", None), "computer": getattr(lp, "DefaultComputerAgent", None)}
        memo, out = {}, {}
        for p in self._paras(self._text(text_guid)):
            for seg in p.SegmentsOS:
                seg = _cast(seg)
                for i, a in enumerate(seg.AnalysesRS):
                    if str(a.ClassName) != "WfiWordform":
                        continue
                    g = str(a.Guid)
                    if g not in memo:
                        try:
                            memo[g] = self._best_guess(_cast(a), agents)
                        except Exception as e:   # noqa: BLE001 — a guess is a display aid, never a reason to fail a read
                            LOG.warning("no guess for wordform %s: %s", g, e)
                            memo[g] = None
                    if memo[g]:
                        out.setdefault(str(seg.Guid), {})[i] = memo[g]
        return out

    def _uses(self, obj):
        """How many times segments point at `obj` (an analysis or a gloss) — FLEx's 'chosen in texts'."""
        h = int(obj.Hvo)
        n = 0
        for ref in obj.ReferringObjects:   # HashSet<ICmObject> [source]
            if str(ref.ClassName) == "Segment":
                n += sum(1 for x in _cast(ref).AnalysesRS if int(x.Hvo) == h)
        return n

    @staticmethod
    def _human_opinion(an):
        """AnalysisGuessServices.IsHumanApproved/IsHumanDisapproved: the last evaluation by a human agent
        decides (True/False), None when no human has an opinion [source]."""
        op = None
        for ev in an.EvaluationsRC:
            ev = _cast(ev)
            if bool(ev.Human):
                op = bool(ev.Approves)
        return op

    def _best_guess(self, wf, agents):
        from SIL.LCModel import Opinions   # type: ignore[import-not-found]
        analyses = [_cast(a) for a in wf.AnalysesOC]
        chosen_a, chosen_g = {}, {}
        for an in analyses:
            n = self._uses(an)
            for gl in an.MeaningsOC:
                k = self._uses(gl)
                if k:
                    chosen_g[str(gl.Guid)] = k
                    n += k
            if n:
                chosen_a[str(an.Guid)] = n

        def opinion(an, agent):
            if agent is None:
                return None
            o = an.GetAgentOpinion(agent)
            return True if o == Opinions.approves else False if o == Opinions.disapproves else None
        best = None
        for an in analyses:
            ag = str(an.Guid)
            if ag in chosen_a:
                key = (-7, -chosen_a[ag], ag)
            else:
                human = self._human_opinion(an)
                if human is False:
                    continue
                parser = opinion(an, agents["parser"])
                prio = 6 if human else 5 if parser else 2 if parser is False else 4 if opinion(an, agents["computer"]) else 3
                key = (-prio, -1, ag)
            if best is None or key < best[0]:
                best = (key, an)
        if best is None:
            return None
        an = best[1]
        gbest = None
        for gl in an.MeaningsOC:
            gl = _cast(gl)
            gg = str(gl.Guid)
            key = (-2, -chosen_g[gg], gg) if gg in chosen_g else (-1, -1, gg)
            if gbest is None or key < gbest[0]:
                gbest = (key, gl)
        return {"analysisGuid": str(an.Guid), "glossGuid": str(gbest[1].Guid) if gbest else None,
                "gloss": self._multi(gbest[1].Form) if gbest else {}}

    def owner_of(self, guid):
        """The owning object's guid, or None — None too for an object that no longer exists (a guess
        named at preview that FLEx has since deleted)."""
        self._t()
        try:
            o = self._obj(guid).Owner
        except Exception:   # noqa: BLE001 — GetObject throws for an unknown guid
            return None
        return str(o.Guid) if o is not None else None

    def gloss_ref_count(self, gloss_guid):
        self._t()
        g = self._obj(gloss_guid)
        n = 0
        for ref in g.ReferringObjects:   # HashSet<ICmObject> [source]
            if str(ref.ClassName) == "Segment":
                n += sum(1 for a in _cast(ref).AnalysesRS if str(a.Guid) == str(gloss_guid))
        return n

    def create_gloss(self, analysis_guid, forms):
        self._t()
        from SIL.LCModel import IWfiGlossFactory   # type: ignore[import-not-found]
        an = self._obj(analysis_guid)
        g = self._repo(IWfiGlossFactory).Create()
        an.MeaningsOC.Add(g)
        for ws, text in forms.items():
            if text:
                h = self._ws_handle(ws)
                g.Form.set_String(h, self._tss(text, h))
        return str(g.Guid)

    def set_gloss_form(self, gloss_guid, ws, text):
        self._t()
        h = self._ws_handle(ws)
        self._obj(gloss_guid).Form.set_String(h, self._tss(text, h))

    def is_approved(self, analysis_guid):
        self._t()
        from SIL.LCModel import Opinions   # type: ignore[import-not-found]
        an = self._obj(analysis_guid)
        agent = self.cache.LanguageProject.DefaultUserAgent
        return an.GetAgentOpinion(agent) == Opinions.approves   # IWfiAnalysis.GetAgentOpinion [source: InterfaceAdditions.cs]

    def set_evaluation(self, analysis_guid, approves=True):
        """IWfiAnalysis.SetAgentOpinion(DefaultUserAgent, …) [source; pyflexicon writes the same
        opinion through ICmAgent.SetEvaluation]; exact objects added [unverified, V-12]."""
        self._t()
        from SIL.LCModel import Opinions   # type: ignore[import-not-found]
        an = self._obj(analysis_guid)
        an.SetAgentOpinion(self.cache.LanguageProject.DefaultUserAgent, Opinions.approves if approves else Opinions.disapproves)

    def user_agent(self):
        """LanguageProject.DefaultUserAgent, and how many of ApprovesOA/DisapprovesOA are still missing:
        CmAgent.SetEvaluation creates BOTH the first time either is needed [source: liblcm
        OverridesCellar.cs], so the first approval ever made in a project adds two CmAgentEvaluation
        objects, owned by the agent — which the W8 disk check must expect."""
        self._t()
        agent = self.cache.LanguageProject.DefaultUserAgent
        if agent is None:
            return {"guid": None, "missingEvaluations": 0}
        agent = _cast(agent)
        missing = (1 if agent.ApprovesOA is None else 0) + (1 if agent.DisapprovesOA is None else 0)
        return {"guid": str(agent.Guid), "missingEvaluations": missing}

    def create_media(self, text_guid, path):
        """As pyflexicon TextOperations does [source]: ICmMediaContainerFactory for MediaFilesOA,
        ICmMediaURIFactory elements added to MediaURIsOC BEFORE MediaURI is set."""
        self._t()
        from SIL.LCModel import ICmMediaContainerFactory, ICmMediaURIFactory   # type: ignore[import-not-found]
        t = self._text(text_guid)
        if t.MediaFilesOA is None:
            t.MediaFilesOA = self._repo(ICmMediaContainerFactory).Create()
        uri = self._repo(ICmMediaURIFactory).Create()
        t.MediaFilesOA.MediaURIsOC.Add(uri)
        uri.MediaURI = path   # path form (absolute vs LinkedFiles-relative) [unverified, V-11]
        return str(t.MediaFilesOA.Guid), str(uri.Guid)

    def set_media_uri(self, uri_guid, path):
        self._t()
        self._obj(uri_guid).MediaURI = path

    def import_flextext(self, path):
        """FLEx's own importer inside OUR UOW (it joins it) [verified]. LinguaLinksImport(cache,
        tempDir, rootDir); ImportInterlinear(IThreadedProgress, object[] {path}) [source]."""
        self._t()
        import clr   # type: ignore[import-not-found]
        clr.AddReference("ITextDll")
        import System   # type: ignore[import-not-found]
        from SIL.FieldWorks.IText import LinguaLinksImport   # type: ignore[import-not-found]
        HeadlessThreadedProgress = _flexicon().HeadlessThreadedProgress
        from SIL.LCModel import ITextRepository   # type: ignore[import-not-found]
        before = {str(t.Guid) for t in self._repo(ITextRepository).AllInstances()}
        imp = LinguaLinksImport(self.cache, None, None)
        imp.ImportInterlinear(HeadlessThreadedProgress(), System.Array[System.Object]([path]))
        after = {str(t.Guid) for t in self._repo(ITextRepository).AllInstances()}
        return sorted(after - before)
