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
"""

import logging
import os
import threading

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


class RealLcm(FlexPort):
    def __init__(self, projects_dir):
        self.projects_dir = projects_dir
        self.project = None       # flexlibs/pyflexicon FLExProject
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
        try:
            from flexlibs import FLExProject          # pyflexicon's import name on current installs
        except ImportError:
            from flexicon import FLExProject   # type: ignore[no-redef]  # the older import name seen on the VM
        _load_assemblies(None)
        self.project = FLExProject()
        self.project.OpenProject(name, writeEnabled=bool(write), undoable=True)   # never undoable=False [verified]
        self.cache = self.project.project
        from SIL.LCModel.Infrastructure import IUndoStackManager   # type: ignore[import-not-found]
        self.usm = IUndoStackManager(self.cache.ServiceLocator.GetService(IUndoStackManager))
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
        self.usm.StopSaveTimer()

    def subscribe_log(self, handler):
        """Attach to flexicon's headless-UI logger: any ERROR record is the only signal of a silent save
        failure [verified]."""
        for name in ("flexlibs", "flexicon", "FwLcmUI", ""):
            logging.getLogger(name).addHandler(handler)
        self._handlers.append(handler)

    def are_multiple_apps_connected(self):
        self._t()
        from SIL.LCModel import SharedBackendServices   # type: ignore[import-not-found]
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
        ds = IDataSetup(self.cache.ServiceLocator.GetService(IDataSetup))
        ds.GetType().GetMethod("CompleteAllCommits").Invoke(ds, None)

    def backup(self, comment):
        self._t()
        if self.ah.CurrentDepth > 0:
            raise RuntimeError("BackupProject inside a unit of work")
        from SIL.LCModel.DomainServices.BackupRestore import ProjectBackupService, BackupProjectSettings   # type: ignore[import-not-found]
        from SIL.LCModel.Utils import FwDirectoryFinder   # type: ignore[import-not-found]
        from SIL.LCModel.Utils import HeadlessThreadedProgress   # type: ignore[import-not-found]
        from . import fwfind
        settings = BackupProjectSettings(self.cache, None, FwDirectoryFinder.DefaultBackupDirectory, fwfind.fw_version() or "9.3")
        settings.Comment = comment or ""
        for flag in ("IncludeConfigurationSettings", "IncludeLinkedFiles", "IncludeSupportingFiles", "IncludeSpellCheckAdditions", "IncludeMediaFiles", "IncludeFonts", "IncludeKeyboards"):
            if hasattr(settings, flag):
                setattr(settings, flag, False)
        svc = ProjectBackupService(self.cache, settings)
        path = svc.BackupProject(HeadlessThreadedProgress(), None)
        return str(path) if path else os.path.join(str(FwDirectoryFinder.DefaultBackupDirectory), "")

    def backup_dir(self):
        from SIL.LCModel.Utils import FwDirectoryFinder   # type: ignore[import-not-found]
        return str(FwDirectoryFinder.DefaultBackupDirectory)

    def fwdata_path(self):
        return os.path.join(self.project_dir(), self._name + ".fwdata")

    def project_dir(self):
        return os.path.join(self.projects_dir, self._name)

    def project_name(self):
        return self._name

    def model_version(self):
        from SIL.LCModel import LcmCache   # type: ignore[import-not-found]
        return int(LcmCache.ModelVersion)

    def versions(self):
        from . import fwfind
        return {"fw": fwfind.fw_version(), "lcm": None, "model": self.model_version(), "backend": "real", "untested": UNTESTED}

    # ---- reads -----------------------------------------------------------------------------------
    def _repo(self, iface):
        return self.cache.ServiceLocator.GetInstance(iface)

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
        return {cls: int(self._repo(repos[cls]).Count) for cls in COUNTED_CLASSES}

    def writing_systems(self):
        self._t()
        wsf = self.cache.ServiceLocator.WritingSystems
        def one(ws, default):
            extra = []
            try:
                for ch in (ws.CharacterSets or []):
                    if getattr(ch, "Type", "") == "main":
                        extra.extend([c for c in ch.Characters if c and not c.isspace()])
            except Exception:   # noqa: BLE001
                pass
            return {"id": str(ws.Id), "abbr": str(ws.Abbreviation), "isDefault": default, "rtl": bool(ws.RightToLeftScript),
                    "graphite": bool(getattr(ws, "IsGraphiteEnabled", False)), "wordForming": extra}
        vern = [one(w, w == wsf.DefaultVernacularWritingSystem) for w in wsf.CurrentVernacularWritingSystems]
        anal = [one(w, w == wsf.DefaultAnalysisWritingSystem) for w in wsf.CurrentAnalysisWritingSystems]
        return {"vern": vern, "anal": anal}

    def _ws_id(self, handle):
        return str(self.cache.ServiceLocator.WritingSystemManager.Get(handle).Id)

    def _ws_handle(self, ws_id):
        return int(self.cache.ServiceLocator.WritingSystemManager.GetWsFromStr(ws_id))

    def _multi(self, ms):
        out = {}
        for i in range(ms.StringCount):
            tss = ms.GetStringFromIndex(i, None)
            ws = tss.get_WritingSystemAt(0) if tss.Length else None
        for handle in list(ms.AvailableWritingSystemIds):
            s = ms.get_String(handle)
            if s is not None and s.Length:
                out[self._ws_id(handle)] = nfc(str(s.Text))
        return out

    def _analysis_ref(self, obj):
        from SIL.LCModel import IWfiWordform, IWfiAnalysis, IWfiGloss, IPunctuationForm   # type: ignore[import-not-found]
        vern = self.cache.DefaultVernWs
        g = str(obj.Guid)
        if IPunctuationForm(obj) is not None if hasattr(obj, "ClassID") and obj.ClassName == "PunctuationForm" else False:
            return {"guid": g, "kind": "punct", "form": nfc(str(obj.Form.Text))}
        cn = obj.ClassName
        if cn == "PunctuationForm":
            return {"guid": g, "kind": "punct", "form": nfc(str(obj.Form.Text))}
        if cn == "WfiWordform":
            return {"guid": g, "kind": "wordform", "form": nfc(str(obj.Form.get_String(vern).Text)), "wordformGuid": g}
        if cn == "WfiAnalysis":
            wf = obj.Owner
            return {"guid": g, "kind": "analysis", "form": nfc(str(wf.Form.get_String(vern).Text)), "wordformGuid": str(wf.Guid), "analysisGuid": g}
        if cn == "WfiGloss":
            an = obj.Owner
            wf = an.Owner
            return {"guid": g, "kind": "gloss", "form": nfc(str(wf.Form.get_String(vern).Text)), "wordformGuid": str(wf.Guid),
                    "analysisGuid": str(an.Guid), "gloss": self._multi(obj.Form)}
        return {"guid": g, "kind": cn, "form": ""}

    def _seg_read(self, para, seg):
        return {"guid": str(seg.Guid), "begin": int(seg.BeginOffset), "end": int(seg.EndOffset),
                "ft": self._multi(seg.FreeTranslation), "lt": self._multi(seg.LiteralTranslation),
                "notes": [nfc(str(n.Content.BestAnalysisAlternative.Text)) for n in seg.NotesOS],
                "analyses": [self._analysis_ref(a) for a in seg.AnalysesRS],
                "beginTime": str(seg.BeginTimeOffset) if seg.BeginTimeOffset else None,
                "endTime": str(seg.EndTimeOffset) if seg.EndTimeOffset else None,
                "mediaUri": str(seg.MediaURIRA.Guid) if seg.MediaURIRA is not None else None,
                "speaker": str(seg.SpeakerRA.Guid) if seg.SpeakerRA is not None else None,
                "isLabel": bool(seg.IsLabel)}

    def list_texts(self):
        self._t()
        from SIL.LCModel import ITextRepository   # type: ignore[import-not-found]
        out = []
        for t in self._repo(ITextRepository).AllInstances():
            st = t.ContentsOA
            paras = list(st.ParagraphsOS) if st is not None else []
            segs = [s for p in paras for s in p.SegmentsOS]
            media = []
            if t.MediaFilesOA is not None:
                for u in t.MediaFilesOA.MediaURIsOC:
                    media.append({"guid": str(u.Guid), "uri": str(u.MediaURI or ""), "exists": os.path.isfile(str(u.MediaURI or ""))})
            out.append({"guid": str(t.Guid), "title": nfc(str(t.Name.BestAnalysisAlternative.Text)), "paras": len(paras), "segs": len(segs),
                        "timedSegs": sum(1 for s in segs if s.BeginTimeOffset), "media": media, "labelSegs": sum(1 for s in segs if s.IsLabel)})
        return out

    def _text(self, guid):
        import System   # type: ignore[import-not-found]
        from SIL.LCModel import ITextRepository   # type: ignore[import-not-found]
        return self._repo(ITextRepository).GetObject(System.Guid(guid))

    def _para(self, guid):
        import System   # type: ignore[import-not-found]
        from SIL.LCModel import IStTxtParaRepository   # type: ignore[import-not-found]
        return self._repo(IStTxtParaRepository).GetObject(System.Guid(guid))

    def _segment(self, guid):
        import System   # type: ignore[import-not-found]
        from SIL.LCModel import ISegmentRepository   # type: ignore[import-not-found]
        return self._repo(ISegmentRepository).GetObject(System.Guid(guid))

    def _obj(self, guid):
        import System   # type: ignore[import-not-found]
        from SIL.LCModel import ICmObjectRepository   # type: ignore[import-not-found]
        return self._repo(ICmObjectRepository).GetObject(System.Guid(guid))

    def read_text(self, guid):
        self._t()
        t = self._text(guid)
        wsf = self.cache.ServiceLocator.WritingSystems
        paras = []
        for p in t.ContentsOA.ParagraphsOS:
            contents = p.Contents
            ws = self._ws_id(contents.get_WritingSystemAt(0)) if contents.Length else self._ws_id(self.cache.DefaultVernWs)
            paras.append({"guid": str(p.Guid), "contents": nfc(str(contents.Text or "")), "ws": ws,
                          "segments": [self._seg_read(p, s) for s in p.SegmentsOS], "style": str(p.StyleName or "") or None})
        media = []
        if t.MediaFilesOA is not None:
            for u in t.MediaFilesOA.MediaURIsOC:
                media.append({"guid": str(u.Guid), "uri": str(u.MediaURI or "")})
        return {"guid": guid, "title": nfc(str(t.Name.BestAnalysisAlternative.Text)), "paragraphs": paras, "media": media,
                "mediaContainer": str(t.MediaFilesOA.Guid) if t.MediaFilesOA is not None else None,
                "vernWs": str(wsf.DefaultVernacularWritingSystem.Id), "analWss": [str(w.Id) for w in wsf.CurrentAnalysisWritingSystems]}

    def get_segments(self, text, ws):
        self._t()
        from SIL.LCModel.DomainServices import SegmentServices   # type: ignore[import-not-found]
        from SIL.LCModel.Core.Text import TsStringUtils   # type: ignore[import-not-found]
        tss = TsStringUtils.MakeString(nfd(text), self._ws_handle(ws))
        return [(int(x.IchMin), int(x.IchLim)) for x in SegmentServices.GetSegments(tss, self.cache.WritingSystemFactory)]

    def get_diffs(self, old, new):
        """TsStringUtils.GetDiffsInTsStrings → (ich, cchInsert, cchDelete). Falls back to lcm_diff
        when the static method is not reachable; the protocol compares the two anyway."""
        self._t()
        try:
            from SIL.LCModel.Core.Text import TsStringUtils   # type: ignore[import-not-found]
            ws = self.cache.DefaultVernWs
            a = TsStringUtils.MakeString(nfd(old), ws)
            b = TsStringUtils.MakeString(nfd(new), ws)
            ich, ins, dele = 0, 0, 0
            r = TsStringUtils.GetDiffsInTsStrings(a, b, ich, ins, dele)
            if isinstance(r, tuple) and len(r) >= 4:
                return (int(r[1]), int(r[2]), int(r[3]))
        except Exception:   # noqa: BLE001
            pass
        return lcm_diff(nfd(old), nfd(new))

    def has_punct_form(self, form):
        self._t()
        from SIL.LCModel import IPunctuationFormRepository   # type: ignore[import-not-found]
        return any(nfd(str(p.Form.Text)) == nfd(form) for p in self._repo(IPunctuationFormRepository).AllInstances())

    def has_wordform(self, form):
        self._t()
        from SIL.LCModel import IWfiWordformRepository   # type: ignore[import-not-found]
        from SIL.LCModel.Core.Text import TsStringUtils   # type: ignore[import-not-found]
        tss = TsStringUtils.MakeString(nfd(form), self.cache.DefaultVernWs)
        wf = None
        try:
            ok, wf = self._repo(IWfiWordformRepository).TryGetObject(tss, wf)
            return bool(ok)
        except Exception:   # noqa: BLE001
            return any(nfd(str(w.Form.get_String(self.cache.DefaultVernWs).Text)) == nfd(form) for w in self._repo(IWfiWordformRepository).AllInstances())

    def force_parse(self, para_guid):
        self._t()
        from SIL.LCModel.DomainServices import ParagraphParser   # type: ignore[import-not-found]
        ParagraphParser(self.cache).ForceParse(self._para(para_guid))

    def export_elan(self, text_guid):
        """FLEx's InterlinearExporter, mode `elan` [verified: mode xml drops all times]. The exporter
        lives in ITextDll (FieldWorks, not liblcm); its constructor signature is [unverified]."""
        self._t()
        import clr   # type: ignore[import-not-found]
        clr.AddReference("ITextDll")
        import System   # type: ignore[import-not-found]
        from SIL.FieldWorks.IText import InterlinearExporter   # type: ignore[import-not-found]
        from System.IO import StringWriter   # type: ignore[import-not-found]
        from System.Xml import XmlWriter, XmlWriterSettings   # type: ignore[import-not-found]
        sw = StringWriter()
        settings = XmlWriterSettings()
        settings.Indent = True
        xw = XmlWriter.Create(sw, settings)
        t = self._text(text_guid)
        exporter = InterlinearExporter.Create("elan", self.cache, xw, t.ContentsOA, None, None)
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
        h = UndoableUnitOfWorkHelper(self.ah, undo_label, redo_label)
        self._handle = h
        return h

    def commit(self, handle):
        self._t()
        handle.set_RollBack(False)   # ⚠ NOT `handle.RollBack = False`: that silently keeps rolling back [verified]
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
            handle.Dispose()          # RollBack left true → the UOW is rolled back
        except Exception:
            if self.ah.CurrentDepth == 1:
                self.ah.Rollback(0)
            raise
        finally:
            self._handle = None

    def depth(self):
        self._t()
        return int(self.ah.CurrentDepth)

    def undoable_action_count(self):
        self._t()
        return int(self.ah.UndoableActionCount)

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
    def _tss(self, text, ws_handle):
        from SIL.LCModel.Core.Text import TsStringUtils   # type: ignore[import-not-found]
        return TsStringUtils.MakeString(nfd(text), ws_handle) if text else TsStringUtils.EmptyString(ws_handle)

    def set_contents(self, para_guid, text):
        """ONE Contents assignment with NULL properties for the inserted run (it inherits the previous
        run, so the diff stays minimal) — built by editing the existing TsString rather than replacing
        the whole string with a fresh one, so run properties are kept."""
        self._t()
        p = self._para(para_guid)
        old = p.Contents
        old_text = str(old.Text or "")
        ich, ins, dele = lcm_diff(old_text, nfd(text))
        bldr = old.GetBldr()
        bldr.Replace(ich, ich + dele, nfd(text)[ich:ich + ins], None)   # null props → inherits
        p.Contents = bldr.GetString()

    def split_para_at(self, para_guid, ich):
        self._t()
        newp = self._para(para_guid).SplitParaAt(int(ich))
        return str(newp.Guid)

    def merge_para_with_next(self, para_guid):
        self._t()
        self._para(para_guid).MergeParaWithNext()

    def set_segment_times(self, seg_guid, begin, end):
        self._t()
        s = self._segment(seg_guid)
        s.BeginTimeOffset = "" if begin is None else str(int(begin))
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
        s.AnalysesRS[int(index)] = self._obj(analysis_guid)

    def _is_trivial(self, an):
        if an.CategoryRA is not None:
            return False
        bundles = list(an.MorphBundlesOS)
        if not bundles:
            return True
        if len(bundles) != 1:
            return False
        mb = bundles[0]
        wf = an.Owner
        vern = self.cache.DefaultVernWs
        return (mb.MorphRA is None and mb.MsaRA is None and mb.SenseRA is None and mb.InflTypeRA is None
                and str(mb.Form.get_String(vern).Text or "") == str(wf.Form.get_String(vern).Text or ""))

    def find_trivial_analysis(self, wordform_guid):
        self._t()
        wf = self._obj(wordform_guid)
        for an in wf.AnalysesOC:
            if self._is_trivial(an):
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
        vern = self.cache.DefaultVernWs
        mb.Form.set_String(vern, wf.Form.get_String(vern))
        wf.Checksum = 0
        return str(an.Guid)

    def glosses_of(self, analysis_guid):
        self._t()
        return [{"guid": str(g.Guid), "forms": self._multi(g.Form)} for g in self._obj(analysis_guid).MeaningsOC]

    def gloss_ref_count(self, gloss_guid):
        self._t()
        g = self._obj(gloss_guid)
        n = 0
        for ref in g.ReferringObjects:
            if ref.ClassName == "Segment":
                n += sum(1 for a in ref.AnalysesRS if str(a.Guid) == gloss_guid)
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
        an = self._obj(analysis_guid)
        agent = self.cache.LanguageProject.DefaultUserAgent
        try:
            from SIL.LCModel import Opinions   # type: ignore[import-not-found]
            return an.GetAgentOpinion(agent) == Opinions.approves
        except Exception:   # noqa: BLE001
            return any(str(e.Owner.Guid) == str(agent.Guid) and e.Approves for e in an.EvaluationsRC)

    def set_evaluation(self, analysis_guid, approves=True):
        """SetAgentOpinion(DefaultUserAgent, approves) as FLEx does; exact objects added [unverified, V-12]."""
        self._t()
        from SIL.LCModel import Opinions   # type: ignore[import-not-found]
        an = self._obj(analysis_guid)
        an.SetAgentOpinion(self.cache.LanguageProject.DefaultUserAgent, Opinions.approves if approves else Opinions.disapproves)

    def create_media(self, text_guid, path):
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
        """FLEx's own importer inside OUR UOW (it joins it) [verified]."""
        self._t()
        import clr   # type: ignore[import-not-found]
        clr.AddReference("ITextDll")
        import System   # type: ignore[import-not-found]
        from SIL.FieldWorks.IText import LinguaLinksImport   # type: ignore[import-not-found]
        from SIL.LCModel.Utils import HeadlessThreadedProgress   # type: ignore[import-not-found]
        from SIL.LCModel import ITextRepository   # type: ignore[import-not-found]
        before = {str(t.Guid) for t in self._repo(ITextRepository).AllInstances()}
        imp = LinguaLinksImport(self.cache, None, None)
        imp.ImportInterlinear(HeadlessThreadedProgress(), System.Array[System.Object]([path]))
        after = {str(t.Guid) for t in self._repo(ITextRepository).AllInstances()}
        return sorted(after - before)
