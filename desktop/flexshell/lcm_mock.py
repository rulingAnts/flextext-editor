"""FlexPort in pure Python: a model of the LCM behaviours the shell depends on (plan §13.1).

EVERY behaviour here cites the VM result it encodes ([verified] / [source] / [unverified], as in the
plan). A behaviour the VM later contradicts is a bug in THIS file, to be fixed and re-run through the
contract tests; the mock is never the authority.

The project is a real folder on disk — `<name>/<name>.fwdata` in a FieldWorks-shaped XML
(`<languageproject version="N">` holding `<rt class guid ownerguid>` elements) — so prechecks.py and
diskcheck.py run against real files produced by the same code path the protocol exercises, and a
save goes temp → delete .bak → rename .fwdata→.bak → rename .tmp→.fwdata exactly as LCM's XML backend
does [source: XMLBackendProvider] (no fsync; a window exists with no .fwdata).

Fault injection (`backend.inject[...]`), each a verified failure mode:
  'save_error'      silent save failure: an ERROR log record, .tmp left behind, HasUnsavedChanges
                    false, disk unchanged — and the failed edit never reaches disk afterwards.
  'backup_truncate' the backup zip is written truncated (W2's verification must catch it).
  'undo_fail'       ah.Undo() restores only part of the state and answers kuresFailed.
  'peers'           AreMultipleApplicationsConnected() → true.
  'listener_throws' a change listener throws on commit (state stuck BroadcastingPropChanges → wedge).
  'raise_in_write'  the next write call raises (an exception thrown inside LCM).
  'external_mtime'  .fwdata was touched by another program before save ("modified by another
                    program": no exception, disk unchanged).
"""

import copy
import datetime as _dt
import json
import logging
import os
import re
import threading
import time
import unicodedata
import uuid
import zipfile
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape as _xesc

from . import mediafind
from .port import (FlexPort, COUNTED_CLASSES, UNDO_SUCCESS, UNDO_FAILED, lcm_diff, nfd, nfc)

MODEL_VERSION = 7000072
FW_VERSION = "9.3.12"
LCM_VERSION = "11.0.0.55180"
DEFAULT_USER_AGENT = "9303883a-ad5c-4ccf-97a5-4add391f8dcb"   # FLEx's default user agent guid [source]
SECTION = "§"
LINE_SEP = " "
LOG = logging.getLogger("flexshell.lcm_mock")

# ---------------------------------------------------------------------------------------------
# The segment breaker [source: SegmentBreaker in liblcm; plan §6.1]
# ---------------------------------------------------------------------------------------------
EOS_CHARS = set("!.?" + SECTION + "؟।॥‼‽⁇⁈⁉。！．？｡")
CLOSERS = set("\"'”’)]}»")


def is_word_forming(ch, extra=()):
    if ch in extra:
        return True
    cat = unicodedata.category(ch)
    return cat[0] in ("L", "M", "N") or ch in "'’ʼ‘-_=ʔ"


def segment_breaker(text, extra_word_chars=()):
    """→ [(ichMin, ichLim)] FLEx-style. A break falls after the whitespace following an EOS
    character; trailing closers stay with the earlier segment; a break needs a word-forming
    character before it and a later word-forming character; a period between digits, an exact
    three-dot ellipsis or a period after a period does not break; four do; U+2028 is its own
    one-character label segment [source]."""
    chars = list(text)
    n = len(chars)
    out = []
    start = 0
    saw_word = False
    i = 0

    def later_word(p):
        for k in range(p, n):
            if is_word_forming(chars[k], extra_word_chars) or chars[k] == LINE_SEP:
                return True
        return False

    while i < n:
        c = chars[i]
        if c == LINE_SEP:
            if i > start:
                out.append((start, i))
            out.append((i, i + 1))
            start = i + 1
            saw_word = False
            i += 1
            continue
        if is_word_forming(c, extra_word_chars):
            saw_word = True
            i += 1
            continue
        if c in EOS_CHARS:
            brk = True
            if c == ".":
                prev = chars[i - 1] if i > 0 else ""
                nxt = chars[i + 1] if i + 1 < n else ""
                run = 1
                while i + run < n and chars[i + run] == ".":
                    run += 1
                if prev.isdigit() and nxt.isdigit():
                    brk = False
                elif run == 3 or run == 2:
                    brk = False
                    i += run - 1
                elif run >= 4:
                    i += run - 1
            if brk and saw_word:
                j = i + 1
                while j < n and chars[j] in CLOSERS:
                    j += 1
                while j < n and chars[j].isspace():
                    j += 1
                if later_word(j):
                    out.append((start, j))
                    start = j
                    saw_word = False
                    i = j
                    continue
        i += 1
    if start < n:
        out.append((start, n))
    return out


def tokenize(text, extra=()):
    """FLEx-style tokens → [(ichMin, ichLim, form, isPunct)]; a run of punctuation is one token."""
    toks = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c.isspace():
            i += 1
            continue
        j = i
        if is_word_forming(c, extra):
            while j < n and is_word_forming(text[j], extra):
                j += 1
            toks.append((i, j, text[i:j], False))
        else:
            while j < n and not text[j].isspace() and not is_word_forming(text[j], extra) and text[j] != LINE_SEP:
                j += 1
            if j == i:   # U+2028
                j = i + 1
            toks.append((i, j, text[i:j], True))
        i = j
    return toks


# ---------------------------------------------------------------------------------------------
# Objects
# ---------------------------------------------------------------------------------------------
def _guid():
    return str(uuid.uuid4())


def _now():
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


class Obj(dict):
    """One LCM object: dict of fields plus `cls`, `guid`, `owner`. Plain data, deep-copyable."""

    def __init__(self, cls, owner=None, guid=None, **fields):
        super().__init__(fields)
        self.cls = cls
        self.guid = guid or _guid()
        self.owner = owner

    def __deepcopy__(self, memo):
        o = Obj(self.cls, self.owner, self.guid)
        for k, v in self.items():
            o[k] = copy.deepcopy(v, memo)
        return o


class _UowHandle:
    def __init__(self, undo, redo, snapshot, thread_id):
        self.undo = undo
        self.redo = redo
        self.snapshot = snapshot
        self.thread_id = thread_id
        self.state = "open"      # open | committed | rolledback | discarded


class LockRecursionException(RuntimeError):
    pass


class NullReferenceException(RuntimeError):
    pass


class MockLcm(FlexPort):
    """One instance = one process's LCM. `inject` is the fault-injection dict."""

    def __init__(self, projects_dir, extra_word_chars=()):
        self.projects_dir = os.path.abspath(projects_dir)
        self.inject = {}
        self.store = {}            # guid → Obj
        self._disk = None          # the store as last WRITTEN to disk (shadow for the silent-failure model)
        self._dirty = set()
        self._deleted = set()
        self._uow = None
        self._undo = []            # [(undo_label, redo_label, before, after)]
        self._redo = []
        self._open = False
        self._name = None
        self._write = False
        self._log_handlers = []
        self._timer_running = True
        self._wedged = False
        self._fwdata_mtime = None
        self.extra_word_chars = tuple(extra_word_chars)
        self.calls = []            # a trace for tests ("what did the protocol do, in what order")
        self.thread_check = None   # optional callable: asserts the current thread is the worker

    # ======================= project folder helpers (fixtures + prechecks) ===================
    @staticmethod
    def project_folder(projects_dir, name):
        return os.path.join(os.path.abspath(projects_dir), name)

    @classmethod
    def create_project(cls, projects_dir, name, texts=(), sharing=False, model_version=MODEL_VERSION,
                       vern_ws="xx", anal_wss=("en",), media_files=()):
        """Write a fresh project folder. `texts` = [{"title": str, "paragraphs": [str, ...],
        "media": [path, ...]}]. Segments and analyses are derived as FLEx's parser would."""
        folder = cls.project_folder(projects_dir, name)
        os.makedirs(folder, exist_ok=True)
        m = cls(projects_dir)
        m._name = name
        m._write = True
        m._vern = vern_ws
        m._anal = list(anal_wss)
        lp = Obj("LangProject", DateModified=_now(), VernWs=vern_ws, AnalWss=list(anal_wss))
        m.store[lp.guid] = lp
        m._lp = lp.guid
        # a few lexicon objects so the never-change counts are non-trivial
        for _ in range(3):
            le = Obj("LexEntry", owner=lp.guid)
            m.store[le.guid] = le
            ls = Obj("LexSense", owner=le.guid)
            m.store[ls.guid] = ls
            mf = Obj("MoForm", owner=le.guid)
            m.store[mf.guid] = mf
        for spec in texts:
            m._create_text(spec)
        m._disk = None
        m._dirty = set(m.store)
        m._write_fwdata(model_version=model_version)
        if sharing:
            ss = os.path.join(folder, "SharedSettings")
            os.makedirs(ss, exist_ok=True)
            with open(os.path.join(ss, "LexiconSettings.plsx"), "w", encoding="utf-8") as f:
                f.write('<?xml version="1.0" encoding="utf-8"?>\n<ProjectLexiconSettings projectSharing="true" />\n')
        return folder

    def _create_text(self, spec):
        text = Obj("Text", owner=self._lp, Name={"en": spec.get("title", "Text")}, DateModified=_now())
        self.store[text.guid] = text
        st = Obj("StText", owner=text.guid, Paragraphs=[], DateModified=_now())
        self.store[st.guid] = st
        text["Contents"] = st.guid
        text["MediaFiles"] = None
        self._mark(text.guid, st.guid)
        for path in spec.get("media", ()):
            self._attach_media(text.guid, path)
        for ptxt in spec.get("paragraphs", ()):
            para = Obj("StTxtPara", owner=st.guid, Contents=nfd(ptxt), Ws=self._vern, Segments=[], StyleName=None)
            self.store[para.guid] = para
            st["Paragraphs"].append(para.guid)
            self._reparse(para.guid, fresh=True)
        return text.guid

    def _attach_media(self, text_guid, path):
        text = self.store[text_guid]
        if not text.get("MediaFiles"):
            cont = Obj("CmMediaContainer", owner=text_guid, MediaURIs=[], OffsetType="")
            self.store[cont.guid] = cont
            text["MediaFiles"] = cont.guid
        cont = self.store[text["MediaFiles"]]
        uri = Obj("CmMediaURI", owner=cont.guid, MediaURI=path)
        self.store[uri.guid] = uri
        cont["MediaURIs"].append(uri.guid)
        self._mark(text_guid, cont.guid, uri.guid)
        return cont.guid, uri.guid

    # ======================= internal model mechanics ========================================
    def _mark(self, *guids):
        for g in guids:
            self._dirty.add(g)
            o = self.store.get(g)
            # every save touches the owning Text/StText DateModified and LangProject [verified: diff table]
            while o is not None and o.cls not in ("Text", "LangProject"):
                o = self.store.get(o.owner)
            if o is not None and o.cls == "Text":
                o["DateModified"] = _now()
                self._dirty.add(o.guid)
                st = self.store.get(o["Contents"])
                if st:
                    st["DateModified"] = _now()
                    self._dirty.add(st.guid)

    def _find_or_create_wordform(self, form):
        form = nfd(form)
        for o in self.store.values():
            if o.cls == "WfiWordform" and o["Form"].get(self._vern) == form:
                return o.guid
        wf = Obj("WfiWordform", owner=self._lp, Form={self._vern: form}, Checksum=0)
        self.store[wf.guid] = wf
        self._mark(wf.guid)
        return wf.guid

    def _find_or_create_punct(self, form):
        form = nfd(form)
        for o in self.store.values():
            if o.cls == "PunctuationForm" and o["Form"] == form:
                return o.guid
        pf = Obj("PunctuationForm", owner=self._lp, Form=form)
        self.store[pf.guid] = pf
        self._mark(pf.guid)
        return pf.guid

    def _analysis_form(self, aguid):
        o = self.store.get(aguid)
        if o is None:
            return None
        if o.cls == "PunctuationForm":
            return o["Form"]
        if o.cls == "WfiWordform":
            return o["Form"].get(self._vern)
        if o.cls == "WfiAnalysis":
            return self.store[o.owner]["Form"].get(self._vern)
        if o.cls == "WfiGloss":
            return self.store[self.store[o.owner].owner]["Form"].get(self._vern)
        return None

    def _bare(self, tok):
        return self._find_or_create_punct(tok[2]) if tok[3] else self._find_or_create_wordform(tok[2])

    def _new_segment(self, para_guid, begin, end):
        seg = Obj("Segment", owner=para_guid, BeginOffset=begin, EndOffset=end, FreeTranslation={},
                  LiteralTranslation={}, Notes=[], Analyses=[], BeginTimeOffset=None, EndTimeOffset=None,
                  MediaURI=None, Speaker=None)
        self.store[seg.guid] = seg
        self._mark(seg.guid)
        return seg

    def _delete(self, guid):
        o = self.store.pop(guid, None)
        if o is None:
            return
        self._deleted.add(guid)
        self._dirty.discard(guid)
        for v in list(o.values()):
            if isinstance(v, list):
                for g in v:
                    if isinstance(g, str) and g in self.store and self.store[g].owner == guid:
                        self._delete(g)

    def _reparse(self, para_guid, fresh=False):
        """ForceParse: segment ranges from the breaker; existing segment objects REUSED BY ORDER, not by
        offset [verified]; extra segments deleted with their FT and times; analyses kept where the
        token form still matches, else bare."""
        para = self.store[para_guid]
        text = para["Contents"]
        ranges = segment_breaker(text, self.extra_word_chars)
        old = [self.store[g] for g in para["Segments"] if g in self.store]
        segs = []
        for i, (b, e) in enumerate(ranges):
            if i < len(old):
                seg = old[i]
                seg["BeginOffset"], seg["EndOffset"] = b, e
            else:
                seg = self._new_segment(para_guid, b, e)
            toks = tokenize(text[b:e], self.extra_word_chars)
            prev = list(seg["Analyses"])
            new_an = []
            for k, tok in enumerate(toks):
                if k < len(prev) and self._analysis_form(prev[k]) == nfd(tok[2]):
                    new_an.append(prev[k])
                else:
                    new_an.append(self._bare(tok))
            if new_an != seg["Analyses"]:
                seg["Analyses"] = new_an
                self._mark(seg.guid)
            if seg["BeginOffset"] >= seg["EndOffset"]:   # a zero-length segment is deleted [verified]
                self._delete(seg.guid)
                continue
            segs.append(seg.guid)
        for seg in old[len(ranges):]:
            self._delete(seg.guid)   # with its FT and times [verified]
        if para["Segments"] != segs:
            para["Segments"] = segs
            self._mark(para_guid)
        return segs

    def _adjust(self, para_guid, new_text):
        """The AnalysisAdjuster for ONE Contents assignment [source: AnalysisAdjuster; verified
        outcomes in plan §6.3–§6.5]: segment count unchanged → every object kept in order (a one-
        assignment boundary move keeps both GUIDs, FTs and times); more segments → new ones created
        inside the modified region (segment k keeps GUID/FT/notes/start time, the new one has an
        empty FT); fewer → the later ones merge into the first (FT/LT joined with a space, notes
        moved, the merged segment's GUID/times/media/speaker gone). Words inside the diff span become
        bare wordforms; everything outside it keeps its analysis GUID."""
        para = self.store[para_guid]
        old_text = para["Contents"]
        ich, ins, dele = lcm_diff(old_text, new_text)
        if ins == 0 and dele == 0:
            return
        delta = ins - dele
        old_segs = [self.store[g] for g in para["Segments"]]
        old_ranges = [(s["BeginOffset"], s["EndOffset"]) for s in old_segs]
        new_ranges = segment_breaker(new_text, self.extra_word_chars)
        # analyses by OLD token start, for carrying across: a token is carried only when the old
        # token at that position has the SAME end and form — a word the edit cut in two, or
        # glued to, is re-tokenised and becomes bare [verified: word split → two bare wordforms]
        old_by_start = {}
        for s, (b, e) in zip(old_segs, old_ranges):
            toks = tokenize(old_text[b:e], self.extra_word_chars)
            for k, tok in enumerate(toks):
                if k < len(s["Analyses"]):
                    old_by_start[b + tok[0]] = (b + tok[1], nfd(tok[2]), s["Analyses"][k])

        def carried(start_old, end_old, form):
            c = old_by_start.get(start_old)
            return c[2] if c and c[0] == end_old and c[1] == nfd(form) else None
        para["Contents"] = new_text
        self._mark(para_guid)

        if len(new_ranges) == len(old_ranges):
            mapping = list(zip(old_segs, new_ranges))
            merged_into = {}
        else:
            before = 0
            while (before < len(old_ranges) and before < len(new_ranges)
                   and old_ranges[before][1] <= ich and old_ranges[before] == new_ranges[before]):
                before += 1
            after = 0
            while (after < len(old_ranges) - before and after < len(new_ranges) - before
                   and old_ranges[-1 - after][0] >= ich + dele
                   and (old_ranges[-1 - after][0] + delta, old_ranges[-1 - after][1] + delta) == new_ranges[-1 - after]):
                after += 1
            mid_old = old_segs[before:len(old_segs) - after]
            mid_new = new_ranges[before:len(new_ranges) - after]
            mapping = list(zip(old_segs[:before], new_ranges[:before]))
            merged_into = {}
            for k, rng in enumerate(mid_new):
                if k < len(mid_old):
                    mapping.append((mid_old[k], rng))
                else:
                    mapping.append((None, rng))
            if len(mid_old) > len(mid_new) and mid_new:
                keeper = mid_old[len(mid_new) - 1]
                for s in mid_old[len(mid_new):]:
                    merged_into[s.guid] = keeper
            elif len(mid_old) > len(mid_new):
                keeper = old_segs[before - 1] if before else None
                for s in mid_old:
                    merged_into[s.guid] = keeper
            mapping += list(zip(old_segs[len(old_segs) - after:], new_ranges[len(new_ranges) - after:]))

        # merges first (so the keeper's FT is extended before analyses are rebuilt)
        for guid, keeper in merged_into.items():
            s = self.store[guid]
            if keeper is not None:
                for field in ("FreeTranslation", "LiteralTranslation"):
                    for ws, txt in s[field].items():
                        a = keeper[field].get(ws, "")
                        keeper[field][ws] = (a + " " + txt).strip() if a and txt else (a or txt)
                keeper["Notes"] = keeper["Notes"] + s["Notes"]   # notes moved [verified]
                self._mark(keeper.guid)
            self._delete(guid)
        new_seg_guids = []
        for seg, (b, e) in mapping:
            if seg is None:
                seg = self._new_segment(para_guid, b, e)
            else:
                if (seg["BeginOffset"], seg["EndOffset"]) != (b, e):
                    seg["BeginOffset"], seg["EndOffset"] = b, e
                    self._mark(seg.guid)
            toks = tokenize(new_text[b:e], self.extra_word_chars)
            an = []
            for tok in toks:
                tb, te = b + tok[0], b + tok[1]
                if te <= ich:
                    an.append(carried(tb, te, tok[2]) or self._bare(tok))
                elif tb >= ich + ins:
                    an.append(carried(tb - delta, te - delta, tok[2]) or self._bare(tok))
                else:
                    an.append(self._bare(tok))   # inside the diff span: bare [verified]
            if an != seg["Analyses"]:
                seg["Analyses"] = an
                self._mark(seg.guid)
            new_seg_guids.append(seg.guid)
        para["Segments"] = new_seg_guids

    # ======================= UOW mechanics ====================================================
    def _require_uow(self):
        if self._wedged:
            raise LockRecursionException("UndoStack write lock held by another thread")
        if self._uow is None or self._uow.state != "open":
            raise RuntimeError("write outside a unit of work")
        if self.inject.pop("raise_in_write", False):
            raise RuntimeError("injected: exception thrown inside LCM")
        if self.thread_check:
            self.thread_check()

    def _snapshot(self):
        return (copy.deepcopy(self.store), set(self._dirty), set(self._deleted))

    def _restore(self, snap):
        store, dirty, deleted = snap
        self.store = copy.deepcopy(store)
        self._dirty = set(dirty)
        self._deleted = set(deleted)

    def begin_uow(self, undo_label, redo_label):
        self.calls.append(("begin_uow", undo_label))
        if self._wedged:
            raise LockRecursionException("UndoStack write lock held by another thread")
        if self._uow is not None and self._uow.state == "open":
            # [verified] a nested BeginUndoTask throws AND discards the outer UOW's changes
            outer = self._uow
            self._restore(outer.snapshot)
            outer.state = "discarded"
            raise RuntimeError("Nested tasks are not supported")
        self._uow = _UowHandle(undo_label, redo_label, self._snapshot(), threading.get_ident())
        return self._uow

    def depth(self):
        return 1 if (self._uow is not None and self._uow.state == "open") else 0

    def _check_thread(self, handle):
        if handle.thread_id != threading.get_ident():
            # [verified] disposing on another thread wedges the session
            self._wedged = True
            handle.state = "rolledback"
            self._uow = None
            raise LockRecursionException("UOW disposed on a different thread: session wedged")

    def commit(self, handle):
        self.calls.append(("commit",))
        if handle is not self._uow or handle.state != "open":
            raise RuntimeError("EndUndoTask: no open task (outer discarded?)")
        self._check_thread(handle)
        if self.inject.get("listener_throws"):
            # a throwing IVwNotifyChange leaves the undo stack in BroadcastingPropChanges [unverified, V-7]
            self._wedged = True
            handle.state = "rolledback"
            self._uow = None
            raise RuntimeError("change listener threw: state stuck in BroadcastingPropChanges")
        after = self._snapshot()
        self._undo.append((handle.undo, handle.redo, handle.snapshot, after))
        self._redo.clear()
        handle.state = "committed"
        self._uow = None

    def rollback(self, handle):
        self.calls.append(("rollback",))
        if handle is not self._uow or handle.state != "open":
            raise RuntimeError("Rollback: no open task")
        self._check_thread(handle)
        self._restore(handle.snapshot)
        handle.state = "rolledback"
        self._uow = None

    def undoable_action_count(self):
        return len(self._undo)

    def last_undo_text(self):
        return self._undo[-1][0] if self._undo else None

    def undo(self):
        self.calls.append(("undo",))
        if self.depth() > 0:
            raise RuntimeError("Undo inside a task")
        if not self._undo:
            return UNDO_FAILED
        undo_label, redo_label, before, after = self._undo.pop()
        if self.inject.get("undo_fail"):
            # [unverified, V-4] a failing IUndoAction: half the objects restored, kuresFailed answered
            store, dirty, deleted = before
            keys = sorted(store)
            half = {k: copy.deepcopy(store[k]) for k in keys[: len(keys) // 2]}
            for k, v in half.items():
                self.store[k] = v
            self._dirty |= set(half)
            self._redo.append((undo_label, redo_label, before, after))
            return UNDO_FAILED
        cur = self._snapshot()
        self._restore(before)
        self._dirty |= self._differing(cur[0], self.store)
        self._deleted |= set(cur[0]) - set(self.store)
        self._redo.append((undo_label, redo_label, before, after))
        return UNDO_SUCCESS

    def redo(self):
        self.calls.append(("redo",))
        if self.depth() > 0:
            raise RuntimeError("Redo inside a task")
        if not self._redo:
            return UNDO_FAILED
        item = self._redo.pop()
        cur = self._snapshot()
        self._restore(item[3])
        self._dirty |= self._differing(cur[0], self.store)
        self._deleted |= set(cur[0]) - set(self.store)
        self._undo.append(item)
        return UNDO_SUCCESS

    @staticmethod
    def _differing(a, b):
        out = set()
        for g in set(a) | set(b):
            if a.get(g) != b.get(g) or (g in a) != (g in b):
                out.add(g)
        return out

    # ======================= session ==========================================================
    def open(self, name, write):
        self.calls.append(("open", name, write))
        folder = self.project_folder(self.projects_dir, name)
        path = os.path.join(folder, name + ".fwdata")
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        self._name = name
        self._write = bool(write)
        self._read_fwdata(path)
        self._disk = copy.deepcopy(self.store)
        self._dirty = set()
        self._deleted = set()
        self._undo, self._redo = [], []
        self._open = True
        self._timer_running = True
        self._fwdata_mtime = os.stat(path).st_mtime_ns
        return True

    def close_without_save(self):
        """LcmCache.Dispose() without Save(): [source] saves nothing — [unverified] as the poisoned-
        close path (V-5). The mock writes nothing here, which is the behaviour the shell relies on."""
        self.calls.append(("close_without_save",))
        self._open = False
        self._uow = None
        self.store = {}

    def close_project(self):
        """flexicon's CloseProject(): SAVES whenever write-enabled, even after an exception
        [verified]. The shell never calls this on a poisoned session; it exists so a test can prove
        the hazard."""
        self.calls.append(("close_project",))
        if self._write:
            self.save()
        self.close_without_save()

    def stop_save_timer(self):
        self.calls.append(("stop_save_timer",))
        self._timer_running = False

    def timer_tick(self):
        """The auto-save timer [verified: 1 s timer, ≥10 s since last save, ≥2 s idle; rewrote .fwdata
        10.6 s after a commit]. Tests call it to model a tick; after StopSaveTimer it does nothing."""
        if self._timer_running and self._open and self._write and self.depth() == 0:
            self.save()
            return True
        return False

    def subscribe_log(self, handler):
        self._log_handlers.append(handler)

    def _log(self, level, msg):
        rec = logging.LogRecord("FwLcmUI", level, __file__, 0, msg, None, None)
        for h in self._log_handlers:
            h.handle(rec)

    def are_multiple_apps_connected(self):
        return bool(self.inject.get("peers"))

    def has_unsaved_changes(self):
        return bool(self._dirty or self._deleted)

    def save(self):
        """[verified] inside a UOW: throws 'Commit at wrong place' and rolls the UOW back.
        [verified] silent failure: no exception, HasUnsavedChanges false, disk unchanged, .tmp left,
        only an ERROR log record — and the next save drops the failed edit."""
        self.calls.append(("save",))
        if self._wedged:
            raise NullReferenceException("undo stack: object reference not set (wedged)")
        if self.depth() > 0:
            h = self._uow
            self._restore(h.snapshot)
            h.state = "rolledback"
            self._uow = None
            raise RuntimeError("Commit at wrong place")
        path = self.fwdata_path()
        if self.inject.get("external_mtime") or (self._fwdata_mtime is not None and os.path.exists(path)
                                                 and os.stat(path).st_mtime_ns != self._fwdata_mtime):
            self.inject.pop("external_mtime", None)
            self._log(logging.ERROR, "The project file was modified by another program; changes were not saved")
            self._dirty.clear()
            self._deleted.clear()
            return False
        if self.inject.get("save_error"):
            self.inject.pop("save_error", None)
            tmp = path.replace(".fwdata", ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                f.write("<!-- partial -->")
            self._log(logging.ERROR, "Unable to save: the backup file is in use by another process")
            self._dirty.clear()
            self._deleted.clear()
            return False
        self._write_fwdata()
        return True

    def complete_all_commits(self):
        self.calls.append(("complete_all_commits",))

    def backup(self, comment):
        """ProjectBackupService.BackupProject [verified]: saves first, writes FLEx's own .fwbackup
        (a zip holding <name>.fwdata). Inside a UOW it throws and rolls the UOW back [verified]."""
        self.calls.append(("backup", comment))
        if self.depth() > 0:
            h = self._uow
            self._restore(h.snapshot)
            h.state = "rolledback"
            self._uow = None
            raise RuntimeError("BackupProject inside a unit of work")
        self.save()
        bdir = self.backup_dir()
        os.makedirs(bdir, exist_ok=True)
        stamp = _dt.datetime.now().strftime("%Y-%m-%d %H%M")
        out = os.path.join(bdir, "%s %s.fwbackup" % (self._name, stamp))
        n = 1
        while os.path.exists(out):
            n += 1
            out = os.path.join(bdir, "%s %s (%d).fwbackup" % (self._name, stamp, n))
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(self.fwdata_path(), self._name + ".fwdata")
            z.writestr("BackupSettings.xml", "<BackupSettings><Comment>%s</Comment></BackupSettings>" % _xesc(comment or ""))
        if self.inject.get("backup_truncate"):
            with open(out, "r+b") as f:
                f.truncate(max(10, os.path.getsize(out) // 3))
        return out

    def backup_dir(self):
        return os.path.join(self.projects_dir, "_Backups")

    def fwdata_path(self):
        return os.path.join(self.project_folder(self.projects_dir, self._name), self._name + ".fwdata")

    def project_dir(self):
        return self.project_folder(self.projects_dir, self._name)

    def linked_files_dir(self):
        return os.path.join(self.project_dir(), "LinkedFiles")

    def project_name(self):
        return self._name

    def model_version(self):
        return MODEL_VERSION

    def versions(self):
        return {"fw": FW_VERSION, "lcm": LCM_VERSION, "model": MODEL_VERSION, "backend": "mock"}

    # ======================= fwdata XML =======================================================
    def _write_fwdata(self, model_version=MODEL_VERSION):
        """temp → delete .bak → rename .fwdata→.bak → rename .tmp→.fwdata [source]. Writes
        disk-shadow + dirty objects, so a silently failed save's edits never reach disk [verified]."""
        if self._disk is None:
            data = copy.deepcopy(self.store)
        else:
            data = self._disk
            for g in self._deleted:
                data.pop(g, None)
            for g in self._dirty:
                if g in self.store:
                    data[g] = copy.deepcopy(self.store[g])
        lp = next((o for o in data.values() if o.cls == "LangProject"), None)
        if lp is not None:
            lp["DateModified"] = _now()
        path = self.fwdata_path()
        tmp = path[:-len(".fwdata")] + ".tmp"
        bak = path[:-len(".fwdata")] + ".bak"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(self.render_fwdata(data, model_version))
        if os.path.exists(bak):
            os.remove(bak)
        if os.path.exists(path):
            os.rename(path, bak)
        os.rename(tmp, path)
        self._disk = data
        self._dirty = set()
        self._deleted = set()
        self._fwdata_mtime = os.stat(path).st_mtime_ns

    @staticmethod
    def render_fwdata(data, model_version=MODEL_VERSION):
        lines = ['<?xml version="1.0" encoding="utf-8"?>', '<languageproject version="%d">' % model_version]
        for g in sorted(data):
            o = data[g]
            attrs = 'class="%s" guid="%s"' % (o.cls, o.guid)
            if o.owner:
                attrs += ' ownerguid="%s"' % o.owner
            body = MockLcm._render_fields(o)
            if body:
                lines.append("<rt %s>%s</rt>" % (attrs, body))
            else:
                lines.append("<rt %s/>" % attrs)   # self-closing rt exist in real files [verified]
        lines.append("</languageproject>")
        return "\n".join(lines) + "\n"

    @staticmethod
    def _render_fields(o):
        parts = []
        for k in sorted(o):
            v = o[k]
            if v is None:
                continue
            if isinstance(v, dict):
                if not v:
                    continue
                runs = "".join('<AStr ws="%s"><Run ws="%s">%s</Run></AStr>' % (_xesc(ws), _xesc(ws), _xesc(t)) for ws, t in sorted(v.items()))
                parts.append("<%s>%s</%s>" % (k, runs, k))
            elif isinstance(v, list):
                if not v:
                    continue
                if all(isinstance(x, str) and re.fullmatch(r"[0-9a-f-]{36}", x) for x in v):
                    parts.append("<%s>%s</%s>" % (k, "".join('<objsur guid="%s" t="r"/>' % x for x in v), k))
                else:
                    parts.append("<%s>%s</%s>" % (k, "".join("<Str><Run>%s</Run></Str>" % _xesc(str(x)) for x in v), k))
            elif isinstance(v, bool):
                parts.append('<%s val="%s"/>' % (k, "true" if v else "false"))
            elif isinstance(v, int):
                parts.append('<%s val="%d"/>' % (k, v))
            elif isinstance(v, str) and re.fullmatch(r"[0-9a-f-]{36}", v):
                parts.append('<%s><objsur guid="%s" t="r"/></%s>' % (k, v, k))
            else:
                parts.append("<%s><Uni>%s</Uni></%s>" % (k, _xesc(str(v)), k))
        return "".join(parts)

    def _read_fwdata(self, path):
        tree = ET.parse(path)
        root = tree.getroot()
        self.store = {}
        for rt in root.iter("rt"):
            o = Obj(rt.get("class"), rt.get("ownerguid"), rt.get("guid"))
            for fld in rt:
                k = fld.tag
                if fld.get("val") is not None:
                    val = fld.get("val")
                    o[k] = True if val == "true" else False if val == "false" else int(val)
                elif fld.find("AStr") is not None:
                    o[k] = {a.get("ws"): "".join(r.text or "" for r in a.iter("Run")) for a in fld.findall("AStr")}
                elif fld.find("objsur") is not None:
                    gs = [x.get("guid") for x in fld.findall("objsur")]
                    o[k] = gs if (len(gs) > 1 or k in ("Segments", "Paragraphs", "MediaURIs", "Analyses", "Meanings", "MorphBundles", "Evaluations", "AnalWss")) else gs[0]
                elif fld.find("Str") is not None:
                    o[k] = ["".join(r.text or "" for r in s.iter("Run")) for s in fld.findall("Str")]
                elif fld.find("Uni") is not None:
                    o[k] = fld.find("Uni").text or ""
            self.store[o.guid] = o
        # list-valued fields that may have been written empty (omitted) need defaults
        for o in self.store.values():
            if o.cls == "Segment":
                for k in ("FreeTranslation", "LiteralTranslation"):
                    o.setdefault(k, {})
                for k in ("Notes", "Analyses"):
                    o.setdefault(k, [])
                for k in ("BeginTimeOffset", "EndTimeOffset", "MediaURI", "Speaker"):
                    o.setdefault(k, None)
                for k in ("BeginTimeOffset", "EndTimeOffset"):
                    if isinstance(o[k], int):
                        o[k] = str(o[k])
            elif o.cls == "StTxtPara":
                o.setdefault("Segments", [])
                o.setdefault("Contents", "")
            elif o.cls == "StText":
                o.setdefault("Paragraphs", [])
            elif o.cls == "Text":
                o.setdefault("MediaFiles", None)
            elif o.cls == "WfiAnalysis":
                o.setdefault("Meanings", [])
                o.setdefault("MorphBundles", [])
                o.setdefault("Evaluations", [])
                o.setdefault("Category", None)
            elif o.cls == "CmMediaContainer":
                o.setdefault("MediaURIs", [])
            elif o.cls == "LangProject":
                o.setdefault("AnalWss", ["en"])
                self._lp = o.guid
                self._vern = o.get("VernWs", "xx")
                self._anal = list(o["AnalWss"]) if isinstance(o["AnalWss"], list) else [o["AnalWss"]]
        if not hasattr(self, "_lp"):
            raise RuntimeError("no LangProject in " + path)

    # ======================= reads ============================================================
    def counts(self):
        out = {c: 0 for c in COUNTED_CLASSES}
        for o in self.store.values():
            if o.cls in out:
                out[o.cls] += 1
        return out

    def writing_systems(self):
        return {"vern": [{"id": self._vern, "abbr": self._vern, "isDefault": True, "rtl": False, "graphite": False,
                          "wordForming": list(self.extra_word_chars)}],
                "anal": [{"id": a, "abbr": a, "isDefault": i == 0, "rtl": False, "graphite": False} for i, a in enumerate(self._anal)]}

    def _texts(self):
        return [o for o in self.store.values() if o.cls == "Text"]

    def list_texts(self):
        out = []
        for t in self._texts():
            st = self.store[t["Contents"]]
            paras = [self.store[g] for g in st["Paragraphs"]]
            segs = [self.store[g] for p in paras for g in p["Segments"]]
            media = []
            if t.get("MediaFiles"):
                for ug in self.store[t["MediaFiles"]]["MediaURIs"]:
                    u = self.store[ug]
                    media.append({"guid": ug, "uri": u["MediaURI"], "exists": mediafind.link_exists(u["MediaURI"], self.linked_files_dir())})
            out.append({"guid": t.guid, "title": nfc(t["Name"].get("en", "")), "paras": len(paras), "segs": len(segs),
                        "timedSegs": sum(1 for s in segs if s["BeginTimeOffset"] is not None),
                        "media": media, "labelSegs": sum(1 for s in segs if self._is_label(s))})
        return out

    def _is_label(self, seg):
        para = self.store[seg.owner]
        txt = para["Contents"][seg["BeginOffset"]:seg["EndOffset"]]
        return txt == LINE_SEP

    def _analysis_ref(self, aguid):
        o = self.store.get(aguid)
        if o is None:
            return {"guid": aguid, "kind": "missing", "form": ""}
        if o.cls == "PunctuationForm":
            return {"guid": aguid, "kind": "punct", "form": nfc(o["Form"])}
        if o.cls == "WfiWordform":
            return {"guid": aguid, "kind": "wordform", "form": nfc(o["Form"].get(self._vern, "")), "wordformGuid": aguid}
        if o.cls == "WfiAnalysis":
            wf = self.store[o.owner]
            return {"guid": aguid, "kind": "analysis", "form": nfc(wf["Form"].get(self._vern, "")), "wordformGuid": wf.guid, "analysisGuid": aguid}
        if o.cls == "WfiGloss":
            an = self.store[o.owner]
            wf = self.store[an.owner]
            return {"guid": aguid, "kind": "gloss", "form": nfc(wf["Form"].get(self._vern, "")), "wordformGuid": wf.guid,
                    "analysisGuid": an.guid, "gloss": {ws: nfc(t) for ws, t in o["Form"].items()}}
        return {"guid": aguid, "kind": o.cls, "form": ""}

    def read_text(self, guid):
        t = self.store.get(guid)
        if t is None or t.cls != "Text":
            raise KeyError(guid)
        st = self.store[t["Contents"]]
        paras = []
        for pg in st["Paragraphs"]:
            p = self.store[pg]
            segs = []
            for sg in p["Segments"]:
                s = self.store[sg]
                segs.append({"guid": sg, "begin": s["BeginOffset"], "end": s["EndOffset"],
                             "ft": {ws: nfc(x) for ws, x in s["FreeTranslation"].items()},
                             "lt": {ws: nfc(x) for ws, x in s["LiteralTranslation"].items()},
                             "notes": [nfc(x) for x in s["Notes"]],
                             "analyses": [self._analysis_ref(a) for a in s["Analyses"]],
                             "beginTime": s["BeginTimeOffset"], "endTime": s["EndTimeOffset"],
                             "mediaUri": s["MediaURI"], "speaker": s["Speaker"], "isLabel": self._is_label(s)})
            paras.append({"guid": pg, "contents": nfc(p["Contents"]), "ws": p["Ws"], "segments": segs, "style": p.get("StyleName")})
        media = []
        if t.get("MediaFiles"):
            for ug in self.store[t["MediaFiles"]]["MediaURIs"]:
                media.append({"guid": ug, "uri": self.store[ug]["MediaURI"]})
        return {"guid": guid, "title": nfc(t["Name"].get("en", "")), "paragraphs": paras, "media": media,
                "mediaContainer": t.get("MediaFiles"), "vernWs": self._vern, "analWss": list(self._anal)}

    def has_punct_form(self, form):
        return any(o.cls == "PunctuationForm" and o["Form"] == nfd(form) for o in self.store.values())

    def has_wordform(self, form):
        return any(o.cls == "WfiWordform" and o["Form"].get(self._vern) == nfd(form) for o in self.store.values())

    def get_segments(self, text, ws):
        return segment_breaker(nfd(text), self.extra_word_chars)

    def get_diffs(self, old, new):
        return lcm_diff(nfd(old), nfd(new))

    def force_parse(self, para_guid):
        self.calls.append(("force_parse", para_guid))
        self._require_uow()
        return self._reparse(para_guid)

    # ======================= writes ===========================================================
    def set_contents(self, para_guid, text):
        self.calls.append(("set_contents", para_guid))
        self._require_uow()
        self._adjust(para_guid, nfd(text))

    def split_para_at(self, para_guid, ich):
        """StTxtPara.SplitParaAt [verified]: segments beginning at/after ich move whole; a split
        MID-segment creates a new segment with a DUPLICATE of the FT and no times."""
        self.calls.append(("split_para_at", para_guid, ich))
        self._require_uow()
        para = self.store[para_guid]
        st = self.store[para.owner]
        text = para["Contents"]
        new = Obj("StTxtPara", owner=st.guid, Contents=text[ich:], Ws=para["Ws"], Segments=[], StyleName=para.get("StyleName"))
        self.store[new.guid] = new
        idx = st["Paragraphs"].index(para_guid)
        st["Paragraphs"].insert(idx + 1, new.guid)
        keep, move = [], []
        for sg in para["Segments"]:
            s = self.store[sg]
            if s["EndOffset"] <= ich:
                keep.append(sg)
            elif s["BeginOffset"] >= ich:
                s["BeginOffset"] -= ich
                s["EndOffset"] -= ich
                s.owner = new.guid
                move.append(sg)
            else:
                # mid-segment: first part stays, second part is a new segment with a duplicate FT
                toks = tokenize(text[s["BeginOffset"]:s["EndOffset"]], self.extra_word_chars)
                cut = ich - s["BeginOffset"]
                left_an = [a for k, a in enumerate(s["Analyses"]) if k < len(toks) and toks[k][1] <= cut]
                right_an = [a for k, a in enumerate(s["Analyses"]) if k < len(toks) and toks[k][0] >= cut]
                s["EndOffset"] = ich
                s["Analyses"] = left_an
                keep.append(sg)
                ns = self._new_segment(new.guid, 0, len(text) - ich)
                ns["FreeTranslation"] = dict(s["FreeTranslation"])
                ns["LiteralTranslation"] = dict(s["LiteralTranslation"])
                ns["Analyses"] = right_an
                move.append(ns.guid)
        para["Contents"] = text[:ich]
        para["Segments"] = keep
        new["Segments"] = move
        self._mark(para_guid, new.guid, st.guid, *move)
        self._reparse(para_guid)
        self._reparse(new.guid)
        return new.guid

    def merge_para_with_next(self, para_guid):
        """StTxtPara.MergeParaWithNext [verified]: Q's text is appended; without an EOS at the join
        P's last and Q's first segments merge (second's times deleted, FTs concatenated); Q's
        paragraph GUID and style are lost."""
        self.calls.append(("merge_para_with_next", para_guid))
        self._require_uow()
        para = self.store[para_guid]
        st = self.store[para.owner]
        idx = st["Paragraphs"].index(para_guid)
        if idx + 1 >= len(st["Paragraphs"]):
            raise RuntimeError("no next paragraph")
        q = self.store[st["Paragraphs"][idx + 1]]
        offset = len(para["Contents"])
        moved = []
        for sg in q["Segments"]:
            s = self.store[sg]
            s["BeginOffset"] += offset
            s["EndOffset"] += offset
            s.owner = para_guid
            moved.append(sg)
        para["Contents"] = para["Contents"] + q["Contents"]
        para["Segments"] = para["Segments"] + moved
        q["Segments"] = []
        st["Paragraphs"].remove(q.guid)
        self._delete(q.guid)
        self._mark(para_guid, st.guid, *moved)
        # re-derive breaks: adjacent segments with no EOS between them merge (keeper = the earlier)
        ranges = segment_breaker(para["Contents"], self.extra_word_chars)
        segs = [self.store[g] for g in para["Segments"]]
        if len(ranges) < len(segs):
            out = []
            ri = 0
            for s in segs:
                if ri < len(ranges) and s["BeginOffset"] == ranges[ri][0] and (not out or out[-1] is not None):
                    out.append(s)
                    ri += 1
                else:
                    keeper = out[-1]
                    for field in ("FreeTranslation", "LiteralTranslation"):
                        for ws, txt in s[field].items():
                            a = keeper[field].get(ws, "")
                            keeper[field][ws] = (a + " " + txt).strip() if a and txt else (a or txt)
                    keeper["Notes"] = keeper["Notes"] + s["Notes"]
                    keeper["Analyses"] = keeper["Analyses"] + s["Analyses"]
                    self._delete(s.guid)
            para["Segments"] = [s.guid for s in out]
        self._reparse(para_guid)

    def _seg(self, seg_guid):
        s = self.store.get(seg_guid)
        if s is None or s.cls != "Segment":
            raise KeyError(seg_guid)
        return s

    def set_segment_times(self, seg_guid, begin, end):
        self.calls.append(("set_segment_times", seg_guid, begin, end))
        self._require_uow()
        s = self._seg(seg_guid)
        s["BeginTimeOffset"] = None if begin is None else str(int(begin))
        s["EndTimeOffset"] = None if end is None else str(int(end))
        self._mark(seg_guid)

    def set_segment_media(self, seg_guid, uri_guid):
        self.calls.append(("set_segment_media", seg_guid, uri_guid))
        self._require_uow()
        s = self._seg(seg_guid)
        s["MediaURI"] = uri_guid
        self._mark(seg_guid)

    def set_segment_speaker(self, seg_guid, speaker_guid):
        self._require_uow()
        s = self._seg(seg_guid)
        s["Speaker"] = speaker_guid
        self._mark(seg_guid)

    def set_free_translation(self, seg_guid, ws, text):
        self.calls.append(("set_free_translation", seg_guid, ws))
        self._require_uow()
        s = self._seg(seg_guid)
        s["FreeTranslation"][ws] = nfd(text)
        if not s["FreeTranslation"][ws]:
            del s["FreeTranslation"][ws]
        self._mark(seg_guid)

    def set_literal_translation(self, seg_guid, ws, text):
        self.calls.append(("set_literal_translation", seg_guid, ws))
        self._require_uow()
        s = self._seg(seg_guid)
        s["LiteralTranslation"][ws] = nfd(text)
        if not s["LiteralTranslation"][ws]:
            del s["LiteralTranslation"][ws]
        self._mark(seg_guid)

    def set_analysis(self, seg_guid, index, analysis_guid):
        self.calls.append(("set_analysis", seg_guid, index, analysis_guid))
        self._require_uow()
        s = self._seg(seg_guid)
        if not (0 <= index < len(s["Analyses"])):
            raise IndexError(index)
        if analysis_guid not in self.store:
            raise KeyError(analysis_guid)
        s["Analyses"][index] = analysis_guid
        self._mark(seg_guid)

    def _is_trivial(self, an):
        if an.get("Category"):
            return False
        wf = self.store[an.owner]
        mbs = [self.store[g] for g in an["MorphBundles"]]
        if not mbs:
            return True
        return len(mbs) == 1 and all(mbs[0].get(k) is None for k in ("Morph", "Msa", "Sense", "InflType")) \
            and mbs[0].get("Form", {}).get(self._vern) == wf["Form"].get(self._vern)

    def find_trivial_analysis(self, wordform_guid):
        for o in self.store.values():
            if o.cls == "WfiAnalysis" and o.owner == wordform_guid and self._is_trivial(o):
                return o.guid
        return None

    def create_trivial_analysis(self, wordform_guid):
        """As FLEx does [source; the path is unverified on the VM, V-12]: WfiAnalysis + one
        WfiMorphBundle whose Form is the wordform; wf.Checksum = 0."""
        self.calls.append(("create_trivial_analysis", wordform_guid))
        self._require_uow()
        wf = self.store[wordform_guid]
        an = Obj("WfiAnalysis", owner=wordform_guid, Meanings=[], MorphBundles=[], Evaluations=[], Category=None)
        self.store[an.guid] = an
        mb = Obj("WfiMorphBundle", owner=an.guid, Form=dict(wf["Form"]), Morph=None, Msa=None, Sense=None, InflType=None)
        self.store[mb.guid] = mb
        an["MorphBundles"] = [mb.guid]
        wf["Checksum"] = 0
        wf.setdefault("Analyses", [])
        wf["Analyses"] = wf["Analyses"] + [an.guid] if isinstance(wf["Analyses"], list) else [an.guid]
        self._mark(an.guid, mb.guid, wordform_guid)
        return an.guid

    def glosses_of(self, analysis_guid):
        an = self.store[analysis_guid]
        return [{"guid": g, "forms": {ws: nfc(t) for ws, t in self.store[g]["Form"].items()}} for g in an["Meanings"] if g in self.store]

    def gloss_ref_count(self, gloss_guid):
        n = 0
        for o in self.store.values():
            if o.cls == "Segment":
                n += sum(1 for a in o["Analyses"] if a == gloss_guid)
        return n

    def create_gloss(self, analysis_guid, forms):
        self.calls.append(("create_gloss", analysis_guid))
        self._require_uow()
        an = self.store[analysis_guid]
        g = Obj("WfiGloss", owner=analysis_guid, Form={ws: nfd(t) for ws, t in forms.items() if t})
        self.store[g.guid] = g
        an["Meanings"] = an["Meanings"] + [g.guid]
        self._mark(g.guid, analysis_guid)
        return g.guid

    def set_gloss_form(self, gloss_guid, ws, text):
        self.calls.append(("set_gloss_form", gloss_guid, ws))
        self._require_uow()
        g = self.store[gloss_guid]
        if text:
            g["Form"][ws] = nfd(text)
        else:
            g["Form"].pop(ws, None)
        self._mark(gloss_guid)

    def is_approved(self, analysis_guid):
        an = self.store[analysis_guid]
        return DEFAULT_USER_AGENT in an["Evaluations"]

    def set_evaluation(self, analysis_guid, approves=True):
        """SetEvaluation(A, approves) as FLEx does [verified behaviour; the exact objects added are
        unverified, V-12: the mock records the agent on the analysis]."""
        self.calls.append(("set_evaluation", analysis_guid, approves))
        self._require_uow()
        an = self.store[analysis_guid]
        ev = [e for e in an["Evaluations"] if e != DEFAULT_USER_AGENT]
        if approves:
            ev.append(DEFAULT_USER_AGENT)
        an["Evaluations"] = ev
        self._mark(analysis_guid)

    def create_media(self, text_guid, path):
        self.calls.append(("create_media", text_guid))
        self._require_uow()
        return self._attach_media(text_guid, path)

    def set_media_uri(self, uri_guid, path):
        self.calls.append(("set_media_uri", uri_guid))
        self._require_uow()
        u = self.store[uri_guid]
        if u.cls != "CmMediaURI":
            raise KeyError(uri_guid)
        u["MediaURI"] = path
        self._mark(uri_guid)

    # ======================= import / export ==================================================
    def import_flextext(self, path):
        """FLEx's LinguaLinksImport.ImportInterlinear, modelled [verified outcomes, plan §9.1]: joins
        our UOW; writes § after every phrase without end-of-sentence punctuation; keeps a phrase's
        times only when the phrase has a media-file (and the text a media-files block); does NOT keep
        analysis identity — new wordforms/analyses/glosses are created for glossed words.
        [unverified] whether the importer writes "word§" or "word §": the mock writes " §"."""
        self.calls.append(("import_flextext", path))
        self._require_uow()
        tree = ET.parse(path)
        root = tree.getroot()
        new_texts = []
        for it in root.findall("interlinear-text"):
            title = ""
            for item in it.findall("item"):
                if item.get("type") == "title":
                    title = item.text or ""
            spec_media = []
            media_map = {}
            mf = it.find("media-files")
            if mf is not None:
                for m in mf.findall("media"):
                    media_map[m.get("guid")] = m.get("location")
            tg = self._create_text({"title": title, "paragraphs": [], "media": []})
            text = self.store[tg]
            st = self.store[text["Contents"]]
            uri_for = {}
            for mg, loc in media_map.items():
                _, ug = self._attach_media(tg, loc)
                uri_for[mg] = ug
            for pEl in it.iter("paragraph"):
                phrases = []
                for ph in pEl.iter("phrase"):
                    txt = ""
                    for item in ph.findall("item"):
                        if item.get("type") == "txt":
                            txt = item.text or ""
                    words = []
                    for w in ph.iter("word"):
                        wt, wg, punct = None, {}, False
                        for item in w.findall("item"):
                            if item.get("type") == "txt":
                                wt = item.text or ""
                            elif item.get("type") == "punct":
                                wt = item.text or ""
                                punct = True
                            elif item.get("type") == "gls":
                                wg[item.get("lang") or "en"] = item.text or ""
                        words.append((wt or "", wg, punct))
                    ft = {}
                    for item in ph.findall("item"):
                        if item.get("type") == "gls":
                            ft[item.get("lang") or "en"] = item.text or ""
                    phrases.append({"txt": txt, "words": words, "ft": ft, "b": ph.get("begin-time-offset"),
                                    "e": ph.get("end-time-offset"), "m": ph.get("media-file")})
                parts = []
                for p in phrases:
                    t = p["txt"].strip()
                    if t and not (t[-1] in EOS_CHARS or (t[-1] in CLOSERS and len(t) > 1 and t[-2] in EOS_CHARS)):
                        t = t + " " + SECTION
                    parts.append(t)
                contents = " ".join(x for x in parts if x)
                para = Obj("StTxtPara", owner=st.guid, Contents=nfd(contents), Ws=self._vern, Segments=[], StyleName=None)
                self.store[para.guid] = para
                st["Paragraphs"].append(para.guid)
                self._mark(para.guid)
                self._reparse(para.guid, fresh=True)
                segs = [self.store[g] for g in para["Segments"]]
                for p, s in zip(phrases, segs):
                    for ws, t in p["ft"].items():
                        if t:
                            s["FreeTranslation"][ws] = nfd(t)
                    if p["b"] is not None and p["e"] is not None and p["m"] in uri_for:
                        s["BeginTimeOffset"], s["EndTimeOffset"] = str(int(p["b"])), str(int(p["e"]))
                        s["MediaURI"] = uri_for[p["m"]]
                    # glosses: new objects, identity not preserved [verified: 19/52 got a different gloss]
                    lex = [w for w in p["words"] if not w[2]]
                    k = 0
                    for i, a in enumerate(s["Analyses"]):
                        ref = self._analysis_ref(a)
                        if ref["kind"] == "punct":
                            continue
                        if k < len(lex) and lex[k][1] and any(lex[k][1].values()):
                            wf = ref["wordformGuid"]
                            an = self.create_trivial_analysis(wf)
                            g = self.create_gloss(an, lex[k][1])
                            s["Analyses"][i] = g
                        k += 1
                    self._mark(s.guid)
            new_texts.append(tg)
        return new_texts

    def export_elan(self, text_guid):
        """FLEx's InterlinearExporter in mode `elan` [verified]: times + media-file ONLY on segments
        with MediaURIRA; phrase guid = segment guid; § written as a phrase-final punct item."""
        self.calls.append(("export_elan", text_guid))
        t = self.read_text(text_guid)
        out = ['<?xml version="1.0" encoding="utf-8"?>', '<document version="2" exportTarget="elan">',
               '<interlinear-text guid="%s">' % text_guid, '<item type="title" lang="en">%s</item>' % _xesc(t["title"])]
        if t["media"]:
            out.append('<media-files offset-type="">')
            for m in t["media"]:
                out.append('<media guid="%s" location="%s"/>' % (m["guid"], _xesc(m["uri"] or "")))
            out.append('</media-files>')
        out.append("<paragraphs>")
        for p in t["paragraphs"]:
            out.append('<paragraph guid="%s"><phrases>' % p["guid"])
            for s in p["segments"]:
                attrs = ' guid="%s"' % s["guid"]
                if s["mediaUri"] and s["beginTime"] is not None:
                    attrs += ' begin-time-offset="%s" end-time-offset="%s" media-file="%s"' % (s["beginTime"], s["endTime"], s["mediaUri"])
                out.append("<phrase%s>" % attrs)
                out.append('<item type="txt" lang="%s">%s</item>' % (p["ws"], _xesc(p["contents"][s["begin"]:s["end"]].strip())))
                out.append("<words>")
                for a in s["analyses"]:
                    if a["kind"] == "punct":
                        out.append('<word><item type="punct" lang="%s">%s</item></word>' % (p["ws"], _xesc(a["form"])))
                    else:
                        g = "".join('<item type="gls" lang="%s">%s</item>' % (ws, _xesc(x)) for ws, x in sorted(a.get("gloss", {}).items()))
                        out.append('<word guid="%s"><item type="txt" lang="%s">%s</item>%s</word>' % (a["guid"], p["ws"], _xesc(a["form"]), g))
                out.append("</words>")
                for ws, x in sorted(s["ft"].items()):
                    out.append('<item type="gls" lang="%s">%s</item>' % (ws, _xesc(x)))
                out.append("</phrase>")
            out.append("</phrases></paragraph>")
        out.append("</paragraphs></interlinear-text></document>")
        return "\n".join(out) + "\n"


class MockBackendFactory:
    """What api.py asks for a backend. `projects_dir` is where the mock keeps its folders."""

    def __init__(self, projects_dir, extra_word_chars=()):
        self.projects_dir = projects_dir
        self.extra_word_chars = extra_word_chars
        self.last = None

    def __call__(self):
        self.last = MockLcm(self.projects_dir, self.extra_word_chars)
        return self.last

    def install_info(self):
        return {"fwVersion": FW_VERSION, "lcmVersion": LCM_VERSION, "modelVersion": MODEL_VERSION,
                "projectsDir": self.projects_dir, "backend": "mock"}
