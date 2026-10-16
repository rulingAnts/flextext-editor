"""FlexPort — the abstract interface of EVERY LCM operation the shell uses (plan §13.1).

Two implementations: lcm_mock.py (pure Python, models the verified behaviours; runs on Linux) and
lcm_real.py (pythonnet + LibLCM; Windows, UNTESTED until the VM conformance run). The contract tests
in desktop/tests/contract are written against this interface and parameterised by backend, so the
same files prove the mock and the real thing agree.

Data crossing the port is PLAIN PYTHON (dicts, lists, str, int): no LCM objects leak out, so the
protocol, segmentation and gloss modules never touch pythonnet types and run unchanged on both.

Read models
-----------
counts()            → {className: int} for the classes W4 counts (plan §5.3 C5)
list_texts()        → [{guid, title, paras, segs, timedSegs, media:[{guid, uri, exists}], labelSegs,
                        created, modified (epoch ms: Text.DateCreated; the later of Text/StText.DateModified),
                        genres:[{guid, name}] (Text.GenresRC)}]
read_text(guid)     → {guid, title, paragraphs: [ParaRead], media: [{guid, uri}], vernWs, analWss}
  ParaRead          = {guid, contents, ws, segments: [SegRead]}
  SegRead           = {guid, begin, end, ft: {ws: text}, lt: {ws: text}, notes: [text],
                       analyses: [AnalysisRef], beginTime, endTime, mediaUri (guid|None),
                       speaker (guid|None), isLabel}
  AnalysisRef       = {guid, kind: 'wordform'|'analysis'|'gloss'|'punct', form, wordformGuid,
                       analysisGuid (for analysis/gloss), gloss: {ws: text} (for gloss),
                       forms: {ws: text} (every vernacular alternative; not for punct)}
                      `form` is the occurrence as its paragraph holds it: the wordform in the
                      paragraph's writing system, else in the default vernacular
writing_systems()   → {vern: [WsInfo], anal: [WsInfo]} — the CURRENT lists, in FLEx's order
  WsInfo            = {id, abbr, name, isDefault, rtl, graphite, wordForming (vern only)}
get_segments(text, ws) → [(ichMin, ichLim)] — the segment breaker's answer for a contents string
has_wordform(form, ws) → bool;  find_wordform(form, ws) → guid|None — the project's wordform with
                      that form in `ws` (the default vernacular when None)
get_diffs(old, new)    → (ich, cchInsert, cchDelete) — the diff LCM will compute for an assignment

Units of work
-------------
begin_uow(undo_label, redo_label) → handle;  commit(handle);  rollback(handle);  depth()
undo_item_count()  → FLEx's HISTORY ITEMS: the times the user could press Undo. ⚠ Not LCM's
                      UndoableActionCount, which counts every CHANGE in them — and a commit adds
                      DateModified changes of its own, so one save grows it by 2 or more (2026-10-16)
last_undo_text();  undo() → 'kuresSuccess'|'kuresFailed'|...;  redo()

Writes (inside a UOW only; the implementation raises outside one)
-----------------------------------------------------------------
set_contents(para_guid, text)                       — ONE Contents assignment (the adjuster runs)
split_para_at(para_guid, ich) → new_para_guid
merge_para_with_next(para_guid)
set_segment_times(seg_guid, begin|None, end|None)
set_segment_media(seg_guid, uri_guid|None)
set_segment_speaker(seg_guid, speaker_guid|None)
set_free_translation(seg_guid, ws, text);  set_literal_translation(seg_guid, ws, text)
set_analysis(seg_guid, index, analysis_guid)
find_trivial_analysis(wordform_guid) → guid|None;  create_trivial_analysis(wordform_guid) → guid
glosses_of(analysis_guid) → [{guid, forms: {ws: text}}]
gloss_ref_count(gloss_guid) → int (segments referencing it, whole project)
create_gloss(analysis_guid, forms) → guid;  set_gloss_form(gloss_guid, ws, text)
is_approved(analysis_guid) → bool;  set_evaluation(analysis_guid, approves=True)
user_agent() → {guid, missingEvaluations}: the agent approvals are recorded for, and how many of its
                      two evaluation objects (approves, disapproves) the next approval would CREATE
                      (CmAgent.SetEvaluation makes both when either is missing) — for the W8 check
create_media(text_guid, path) → (container_guid, uri_guid);  set_media_uri(uri_guid, path)
import_flextext(path) → [new_text_guid]   (FLEx's own importer, joins our UOW)

Session
-------
open(name, write) ; close_without_save() ; stop_save_timer() ; subscribe_log(handler)
are_multiple_apps_connected() ; has_unsaved_changes() ; save() ; complete_all_commits()
backup(comment) → path ; force_parse(para_guid) ; export_elan(text_guid) → xml str
fwdata_path() ; project_dir() ; model_version() ; versions() → {fw, lcm, model}
"""

from abc import ABC, abstractmethod

UNDO_SUCCESS = "kuresSuccess"
UNDO_FAILED = "kuresFailed"
UNDO_ERROR = "kuresError"
UNDO_REFRESH = "kuresRefresh"

# The classes W4/W8 count and allow (plan §5.3 C5, §5.4 table).
COUNTED_CLASSES = ("LexEntry", "LexSense", "MoForm", "WfiWordform", "WfiAnalysis", "WfiGloss",
                   "WfiMorphBundle", "PunctuationForm", "Text", "StText", "StTxtPara", "Segment",
                   "CmMediaContainer", "CmMediaURI")
# Never changed by any shell write. WfiMorphBundle is NOT here: a new trivial analysis (as FLEx makes
# it) owns one bundle, so the preview announces that delta and W4 checks it exactly (plan §5.4 table).
NEVER_CHANGE = ("LexEntry", "LexSense", "MoForm")


class FlexPort(ABC):
    # ---- session ----
    @abstractmethod
    def open(self, name, write): ...
    @abstractmethod
    def close_without_save(self): ...
    @abstractmethod
    def stop_save_timer(self): ...
    @abstractmethod
    def subscribe_log(self, handler): ...
    @abstractmethod
    def are_multiple_apps_connected(self): ...
    @abstractmethod
    def has_unsaved_changes(self): ...
    @abstractmethod
    def save(self): ...
    @abstractmethod
    def complete_all_commits(self): ...
    @abstractmethod
    def backup(self, comment): ...
    @abstractmethod
    def fwdata_path(self): ...
    @abstractmethod
    def project_dir(self): ...
    @abstractmethod
    def linked_files_dir(self):
        """The project's LinkedFiles folder, absolute (LangProject.LinkedFilesRootDir; FLEx's default
        is <project folder>\\LinkedFiles) — where relative media links resolve and where recordings
        usually live (plan §8.4)."""
    @abstractmethod
    def model_version(self): ...
    @abstractmethod
    def versions(self): ...
    @abstractmethod
    def project_name(self): ...

    # ---- reads ----
    @abstractmethod
    def counts(self): ...
    @abstractmethod
    def list_texts(self): ...
    @abstractmethod
    def read_text(self, guid): ...
    @abstractmethod
    def writing_systems(self): ...
    @abstractmethod
    def get_segments(self, text, ws): ...
    @abstractmethod
    def get_diffs(self, old, new): ...
    @abstractmethod
    def force_parse(self, para_guid): ...
    @abstractmethod
    def export_elan(self, text_guid): ...
    @abstractmethod
    def has_punct_form(self, form): ...
    @abstractmethod
    def has_wordform(self, form, ws=None): ...
    @abstractmethod
    def find_wordform(self, form, ws=None): ...

    # ---- UOW ----
    @abstractmethod
    def begin_uow(self, undo_label, redo_label): ...
    @abstractmethod
    def commit(self, handle): ...
    @abstractmethod
    def rollback(self, handle): ...
    @abstractmethod
    def depth(self): ...
    @abstractmethod
    def undo_item_count(self): ...
    @abstractmethod
    def last_undo_text(self): ...
    @abstractmethod
    def undo(self): ...
    @abstractmethod
    def redo(self): ...

    # ---- writes ----
    @abstractmethod
    def set_contents(self, para_guid, text): ...
    @abstractmethod
    def split_para_at(self, para_guid, ich): ...
    @abstractmethod
    def merge_para_with_next(self, para_guid): ...
    @abstractmethod
    def set_segment_times(self, seg_guid, begin, end): ...
    @abstractmethod
    def set_segment_media(self, seg_guid, uri_guid): ...
    @abstractmethod
    def set_segment_speaker(self, seg_guid, speaker_guid): ...
    @abstractmethod
    def set_free_translation(self, seg_guid, ws, text): ...
    @abstractmethod
    def set_literal_translation(self, seg_guid, ws, text): ...
    @abstractmethod
    def set_analysis(self, seg_guid, index, analysis_guid): ...
    @abstractmethod
    def find_trivial_analysis(self, wordform_guid): ...
    @abstractmethod
    def create_trivial_analysis(self, wordform_guid): ...
    @abstractmethod
    def glosses_of(self, analysis_guid): ...
    @abstractmethod
    def gloss_ref_count(self, gloss_guid): ...
    @abstractmethod
    def create_gloss(self, analysis_guid, forms): ...
    @abstractmethod
    def set_gloss_form(self, gloss_guid, ws, text): ...
    @abstractmethod
    def is_approved(self, analysis_guid): ...
    @abstractmethod
    def set_evaluation(self, analysis_guid, approves=True): ...
    @abstractmethod
    def user_agent(self): ...
    @abstractmethod
    def create_media(self, text_guid, path): ...
    @abstractmethod
    def set_media_uri(self, uri_guid, path): ...
    @abstractmethod
    def import_flextext(self, path): ...


def lcm_diff(old, new):
    """The diff LCM computes for a string assignment: the longest common PREFIX, then the longest
    common SUFFIX of what remains → (ich, cchInsert, cchDelete). [verified] consequence (plan §6.5):
    inserting " xyz" after "abc" in "abc def" is reported as "xyz " at 4, one character later than
    intended; inserting a copy of a word next to itself leaves the EXISTING analysis on the first
    copy. Pure and shared by both backends' callers (the real one asks TsStringUtils as well and the
    protocol asserts the two agree)."""
    o, n = list(old), list(new)
    i = 0
    while i < len(o) and i < len(n) and o[i] == n[i]:
        i += 1
    j = 0
    while j < len(o) - i and j < len(n) - i and o[len(o) - 1 - j] == n[len(n) - 1 - j]:
        j += 1
    return (i, len(n) - i - j, len(o) - i - j)


def nfd(s):
    import unicodedata
    return unicodedata.normalize("NFD", s or "")


def nfc(s):
    import unicodedata
    return unicodedata.normalize("NFC", s or "")
