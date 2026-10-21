"""Save to FLEx — the write protocol, as verified (plan §5). One Session per open project.

  C1–C6  open: prechecks done by the caller; OpenProject(undoable=True); StopSaveTimer at once; the
         headless-UI log captured (ANY ERROR poisons); peers → read-only; counts and fingerprints.
  W1     preview: no write. Stale base, scope, fragile paragraphs, empty phrases, warnings, the exact
         intended post-state and object-count deltas, a human change list, a token with an expiry.
  W2     mandatory verified backup at depth 0 (zip opens, testzip, holds <name>.fwdata with the right
         header version and the live file's rt count). Fail → E_BACKUP_FAILED, nothing written.
  W3     ONE UOW, labelled "Undo Save to FLEx (N changes)"; refuse if depth > 0; apply the ops
         through segmentation.py / glosses.py / the port — never flexicon's segment operations.
  W4     invariants inside the UOW: segmentation invariant on every touched paragraph; expected
         segment GUIDs; edited values read back; untouched paragraphs unchanged; object counts exactly
         the preview's; re-read == intended post-state. Any failure raises → rollback.
  W5     commit (set_RollBack(False) + Dispose on the real backend) or rollback; then depth 0 and
         UndoableActionCount +1 with the expected text (success) or unchanged (failure).
  W6     after any rollback: fingerprints == pre-state, else E_ROLLBACK_INCOMPLETE → poison.
  W7     Save at depth 0, CompleteAllCommits; any captured ERROR → E_SAVE_FAILED → poison.
  W8     disk read-back (.bak vs .fwdata, diskcheck.py); .tmp gone; mtime changed. Fail →
         E_DISK_CHECK_FAILED → poison → W9.
  W9     close WITHOUT saving; rename .fwdata → .fwdata.failed-<ts> (never delete); offer .bak or the
         W2 backup. Tell the user exactly what happened.
  W10    (optional, end of session) reopen read-only and recheck.
One Save to FLEx = one user action = one LCM UOW = one FLEx history item (Seth's undo rule).
"""

import logging
import os
import secrets
import shutil
import time
import traceback
import zipfile
import xml.etree.ElementTree as ET

from . import mediafind, trace
from . import diskcheck, glosses, model, segmentation as S
from .errors import FlexError, POISONING
from .lcm_mock import EOS_CHARS, LINE_SEP, SECTION, is_word_forming, tokenize
from .port import COUNTED_CLASSES, NEVER_CHANGE, UNDO_SUCCESS, nfc, nfd

SAVE = logging.getLogger("flexshell.save")   # every step of a save, and why one stopped (trace.py)
PREVIEW_TTL = 600.0
BACKUP_COMMENT = "FlexText Segmenter before save"

# plan §5.4 table: classes that may change per op
OP_CLASSES = {
    "ft.set": {"Segment"}, "lt.set": {"Segment"}, "times.set": {"Segment"},
    "phrase.split": {"StTxtPara", "Segment", "PunctuationForm"}, "phrase.join": {"StTxtPara", "Segment"},
    "phrase.moveBoundary": {"StTxtPara", "Segment", "PunctuationForm"},
    "para.split": {"StTxtPara", "StText", "Segment"}, "para.join": {"StTxtPara", "StText", "Segment", "PunctuationForm"},
    "phrase.toPara": {"StTxtPara", "StText", "Segment"}, "para.toPhrase": {"StTxtPara", "StText", "Segment", "PunctuationForm"},
    "word.split": {"StTxtPara", "Segment", "WfiWordform"}, "word.insert": {"StTxtPara", "Segment", "WfiWordform"},
    "word.join": {"StTxtPara", "Segment", "WfiWordform"},
    "baseline.replace": {"StTxtPara", "Segment", "WfiWordform", "PunctuationForm"},
    # WfiWordform is CHANGED (never added) by a gloss write: a new trivial analysis is owned by the
    # wordform and FLEx sets wf.Checksum = 0 (plan §7.2 step 4), so the wordform's rt differs on disk
    "gloss.set": {"Segment", "WfiGloss", "WfiAnalysis", "WfiMorphBundle", "WfiWordform"},
    "media.relink": {"CmMediaURI"}, "media.attach": {"Text", "CmMediaContainer", "CmMediaURI", "Segment"},
    "import": {"Text", "StText", "StTxtPara", "Segment", "WfiWordform", "WfiAnalysis", "WfiGloss", "WfiMorphBundle",
               "PunctuationForm", "CmMediaContainer", "CmMediaURI"},
}
STRUCTURAL = ("para.toPhrase", "para.join", "phrase.toPara", "para.split", "phrase.join", "phrase.split",
              "phrase.moveBoundary", "word.split", "word.join", "word.insert", "baseline.replace")
# ops that write a paragraph's words: only from a view of the words in the paragraph's own writing system
WORD_EDITS = ("word.split", "word.join", "word.insert", "baseline.replace")
# the ops that rewrite a paragraph's Contents or remake its segments — what a chart cell or text tag refers to
REWRITES = WORD_EDITS + ("phrase.split", "phrase.join", "phrase.moveBoundary", "phrase.toPara", "para.toPhrase", "para.split", "para.join")


def _para_holding(port, text_guid, seg_guid):
    """The paragraph that holds a segment now, inside the save's unit of work; None if no paragraph does."""
    for p in port.read_text(text_guid)["paragraphs"]:
        if any(s["guid"] == seg_guid for s in p["segments"]):
            return p["guid"]
    return None


def _resolve(absorbed, guid):
    """A paragraph guid as it stands now: followed through every join of this save that absorbed it (P3 → P2 → P1)."""
    seen = set()
    while guid in absorbed and guid not in seen:
        seen.add(guid)
        guid = absorbed[guid]
    return guid


def op_order(op):
    """Where an op runs: structure first, by kind (merges before splits), then content. A phrase.toPara
    marked afterSplit moves a phrase a split of this same save made (a Sentence break in the Matcher),
    so it runs after every phrase.split and before the kinds that follow them.

    A word's gloss runs BEFORE everything, on the text as it was checked out, where the op's (segGuid,
    index) were taken: every structural recipe keeps the analyses of the words it does not remake
    (segmentation.py), so the gloss travels with its word into whatever phrase or paragraph the save
    puts it in. The gloss of a word the save itself makes (`newWord`: a split's halves, an added or a
    joined word, a respelled one) runs LAST, once that word exists, at its place in the new phrase."""
    kind = op.get("op")
    if kind == "gloss.set":
        return len(STRUCTURAL) + 1 if op.get("newWord") else -1
    if kind == "phrase.toPara" and op.get("afterSplit"):
        return STRUCTURAL.index("phrase.split") + 0.5
    return STRUCTURAL.index(kind) if kind in STRUCTURAL else len(STRUCTURAL)


def gloss_changes(op):
    """A gloss.set op's {ws: text}: `forms` (every writing system edited for that word), or the older
    single `ws` + `value`."""
    forms = op.get("forms")
    if isinstance(forms, dict):
        return dict(forms)
    if op.get("ws") is not None:
        return {op["ws"]: op.get("value", "")}
    return {}


class _LogCapture(logging.Handler):
    def __init__(self, on_error):
        super().__init__()
        self.records = []
        self.on_error = on_error

    def emit(self, record):
        if record.name == "flexshell" or record.name.startswith("flexshell."):
            return   # the shell's own console lines (trace.py) are reports, never FLEx failing to save
        self.records.append(record)
        if record.levelno >= logging.ERROR:
            try:
                SAVE.error("FLEx logged an ERROR (%s): %s%s", record.name, record.getMessage(),
                           ("\n" + self.format(record)) if record.exc_info else "")
            except Exception:   # noqa: BLE001
                pass
            self.on_error(record)


class Session:
    """Holds the port, the open-time snapshot, per-text fingerprints, previews, the FLEx history and
    the poison flag. Every method runs on the worker thread (api.py ensures it)."""

    def __init__(self, port, name, write, copy_only, marker_ok):
        self.port = port
        self.name = name
        self.write = write
        self.copy_only = copy_only
        self.poisoned = None           # FlexError that poisoned the session, or None
        self.previews = {}
        self.texts = {}                # textGuid → {"fp": {paraGuid: hash}, "baseRev", "read": readModel}
        self.backup_ok = None          # path of the verified backup that still predates every save
        self.history = []              # one entry per Save to FLEx (what undo_flex compares against)
        self.guess_cache = {}          # textGuid → port.guesses(text): FLEx's guesses change only when this session writes
        self.redo_history = []
        self.log = _LogCapture(self._on_error_log)
        self.wedged = False
        self.closed = False
        self.failed_file = None
        # C1–C6
        port.open(name, write)
        port.stop_save_timer()                            # C2 — the first thing after open [verified]
        port.subscribe_log(self.log)                      # C3
        if write and port.are_multiple_apps_connected():  # C4
            raise FlexError("E_PEERS_CONNECTED", "another program has this project open (a peer); read-only", {})
        self.counts0 = port.counts()                      # C5
        SAVE.info("session open: %s, %s; object counts %s", name, "read and write" if write else "read only", trace.short(self.counts0, 600))

    # ---- poison ------------------------------------------------------------------------------
    def _on_error_log(self, record):
        if not self.poisoned:
            self._poison(FlexError("E_SAVE_FAILED", "FLEx reported a problem: " + record.getMessage(), {"log": record.getMessage()}))

    def _poison(self, err):
        """§5.6: block every further call; dispose WITHOUT saving (never flexicon's CloseProject);
        keep the process alive to show the message. The error says so (`detail.closed`): the page tells
        the user the project was closed without saving, never that a change was merely rolled back."""
        if self.poisoned:
            return
        err.detail = dict(err.detail or {}, closed=True)
        try:
            SAVE.error("PROJECT CLOSED WITHOUT SAVING — %s: %s | detail %s\n  called from:\n    %s", err.code, err.message,
                       trace.short(err.detail, 2000), "".join(traceback.format_stack(limit=8)[:-1]).strip().replace("\n", "\n    "))
        except Exception:   # noqa: BLE001
            pass
        self.poisoned = err
        try:
            self.port.close_without_save()
        except Exception:   # noqa: BLE001
            pass
        self.closed = True

    def guard(self):
        if self.poisoned:
            raise FlexError("E_POISONED", "the project was closed without saving (%s: %s)%s; close it and open it again to carry on" % (
                                self.poisoned.code, self.poisoned.message,
                                ("; the file that failed the check was set aside as " + self.failed_file) if self.failed_file else ""),
                            {"cause": self.poisoned.to_dict(), "failedFile": self.failed_file, "backup": self.backup_ok, "closed": True})
        if self.closed:
            raise FlexError("E_NOT_FOUND", "no project is open", {})

    # ---- reads --------------------------------------------------------------------------------
    def open_text(self, text_guid, media_urls=None, ws=None):
        """The text in the engine's shape, in the writing systems chosen for it (`ws` = {vern, anal},
        from FLEx's own lists; the text's own when None — model.default_ws). The choice is remembered
        for this text: every later preview and check reads the text the same way."""
        self.guard()
        t = self.port.read_text(text_guid)
        chosen = self._checked_ws(t, ws) if ws else model.default_ws(t)
        fp = model.fingerprint_text(t)
        rev = model.base_rev(t)
        self.texts[text_guid] = {"fp": fp, "baseRev": rev, "read": t, "ws": chosen}
        # FLEx's guesses for the words this text has not analysed (shown in blue in FLEx): a display aid and
        # the base a typed gloss builds on — never a reason a text does not open
        guesses = self.guess_cache.get(text_guid)
        if guesses is None:
            try:
                guesses = self.guess_cache[text_guid] = self.port.guesses(text_guid)
            except Exception as e:   # noqa: BLE001
                SAVE.warning("no guesses for text %s: %s", text_guid, e)
                guesses = {}
        return {"doc": model.to_engine_doc(t, media_urls, chosen, guesses=guesses), "baseRev": rev, "ws": chosen,
                "wsDefault": model.default_ws(t), "wsUsage": model.text_ws_usage(t)}

    def text_ws(self, text_guid):
        """What a text uses and opens in, without opening it: {usage, default, current}."""
        self.guard()
        t = self.port.read_text(text_guid)
        entry = self.texts.get(text_guid) or {}
        return {"usage": model.text_ws_usage(t), "default": model.default_ws(t), "current": entry.get("ws")}

    def _checked_ws(self, t, ws):
        """Only FLEx's own writing systems: a current vernacular one (or one the text's paragraphs are
        in), and a current analysis one."""
        lists = self.port.writing_systems()
        verns = {w["id"] for w in lists["vern"]} | {p["ws"] for p in t["paragraphs"]}
        anals = {w["id"] for w in lists["anal"]}
        if not isinstance(ws, dict) or ws.get("vern") not in verns or ws.get("anal") not in anals:
            raise FlexError("E_SCOPE", "not a writing system of this project", {"ws": ws if isinstance(ws, dict) else None})
        return {"vern": ws["vern"], "anal": ws["anal"]}

    def close_text(self, text_guid):
        self.texts.pop(text_guid, None)

    # ---- W1 preview ---------------------------------------------------------------------------
    def preview(self, text_guid, base_rev, ops, post_state, chosen_wss=None):
        self.guard()
        if not self.write:
            raise FlexError("E_SCOPE", "the project is open read-only", {})
        entry = self.texts.get(text_guid)
        if not entry:
            raise FlexError("E_NOT_FOUND", "open the text first", {"text": text_guid})
        t = self.port.read_text(text_guid)
        if base_rev != entry["baseRev"] or model.base_rev(t) != entry["baseRev"]:
            raise FlexError("E_STALE_BASE", "the FLEx text changed since it was opened; reload and re-apply your edits", {})
        chosen = list(chosen_wss or t["analWss"] or ["en"])
        text_ws = entry.get("ws") or model.default_ws(t)
        paras = {p["guid"]: p for p in t["paragraphs"]}
        segs = {s["guid"]: (p, s) for p in t["paragraphs"] for s in p["segments"]}
        summary, warnings, blockers = [], [], []
        touched_paras = set()
        deltas = {c: 0 for c in COUNTED_CLASSES}
        classes = set()
        allowed_ops = set(OP_CLASSES) - {"import"}
        if not isinstance(ops, list):
            raise FlexError("E_SCOPE", "ops must be a list", {})
        # phrases and paragraphs this save itself makes (engine guids, aliased to LCM's when applied):
        # later ops may name them, and nothing else that is not in the text
        new_phrases = {op.get("newPhrase") for op in ops if isinstance(op, dict) and op.get("op") == "phrase.split" and op.get("newPhrase")}
        # the phrases this save splits, and each new piece → the phrase it was split from (back to a base phrase)
        split_subjects = {op.get("segGuid") for op in ops if isinstance(op, dict) and op.get("op") == "phrase.split"}
        split_from_phrase = {op["newPhrase"]: op.get("segGuid") for op in ops
                             if isinstance(op, dict) and op.get("op") == "phrase.split" and op.get("newPhrase")}
        new_paras = {op.get("newPara") for op in ops if isinstance(op, dict) and op.get("op") in ("phrase.toPara", "para.split") and op.get("newPara")}
        # FLEx makes the hard line break's PunctuationForm ONCE, the first time any op of this save writes a break (a
        # split, the paragraph toggle off, a § moved) — never once per op. This app writes no § (2026-10-21).
        section = {"new": not self.port.has_punct_form(LINE_SEP), "counted": False}
        # wordforms the save's word ops create, counted ONCE however many ops make the same form (FLEx
        # makes one), and handed to the gloss planner: a new word's gloss lands on that wordform
        made_forms = set()

        def new_wordform(form, ws):
            key = (nfc(form), ws)
            if key in made_forms or self.port.has_wordform(form, ws):
                return
            made_forms.add(key)
            deltas["WfiWordform"] += 1
        glossed, gloss_ops = set(), []

        def writes_section():
            if section["new"] and not section["counted"]:
                deltas["PunctuationForm"] += 1
                section["counted"] = True
        refs = self.port.paragraph_refs(text_guid)   # paragraphs a chart cell or a text tag refers to (E_CHART_REFS)
        order = [p["guid"] for p in t["paragraphs"]]
        merged_end = {}                     # paragraph → index of the last paragraph a join merged into it
        absorbed = {}                       # paragraph → the paragraphs this save's joins merge into it
        split_from = {}                     # a paragraph this save makes → the paragraph it is split from
        # every segment in document order: the n-th phrase.join on a segment absorbs the n-th one after it
        # (a paragraph join first puts the next paragraph's segments right after it, in the same order)
        flat = [s for p in t["paragraphs"] for s in p["segments"]]
        flat_para = [p for p in t["paragraphs"] for s in p["segments"]]
        at = {s["guid"]: i for i, s in enumerate(flat)}
        joins_on = {}
        for op in ops:
            kind = op.get("op")
            if kind not in allowed_ops:
                raise FlexError("E_SCOPE", "unknown or disallowed operation", {"op": kind})
            classes |= OP_CLASSES[kind]
            pg = op.get("paraGuid")
            sg = op.get("segGuid")
            if kind.startswith("media."):
                if kind == "media.relink":
                    uri = next((m for m in t["media"] if m["guid"] == op.get("uriGuid")), None)
                    if not uri:
                        raise FlexError("E_NOT_FOUND", "no such media link", {"uri": op.get("uriGuid")})
                    if mediafind.link_exists(uri["uri"], self.port.linked_files_dir()):
                        raise FlexError("E_MEDIA_PRESENT", "that recording exists; a link whose file exists is never retargeted", {})
                    if not op.get("path") or not os.path.isfile(op["path"]):
                        raise FlexError("E_MEDIA_FILE_MISSING", "the chosen file does not exist", {})
                    summary.append({"kind": "media.relink", "to": os.path.basename(op["path"])})
                else:
                    if t["media"]:
                        raise FlexError("E_MEDIA_PRESENT", "this text already has a media link; never attach a second one", {})
                    if not op.get("path") or not os.path.isfile(op["path"]):
                        raise FlexError("E_MEDIA_FILE_MISSING", "the recording file does not exist", {})
                    deltas["CmMediaContainer"] += 1
                    deltas["CmMediaURI"] += 1
                    summary.append({"kind": "media.attach", "file": os.path.basename(op["path"])})
                continue
            if pg not in paras:
                # a paragraph created earlier in this save (an alias) is allowed for later ops
                if not op.get("_alias") and pg not in new_paras:
                    raise FlexError("E_SCOPE", "paragraph not in this text", {"para": pg})
            if pg in paras:
                touched_paras.add(pg)
                S.require_not_fragile(self.port, paras[pg])
                if kind in REWRITES and pg in refs:
                    # a discourse chart or a text tag points into this paragraph's segments and words: a rewrite
                    # leaves that to LCM's AnalysisAdjuster, which Seth's notes (2026-10-17) saw get 7 of 876 wrong
                    raise FlexError("E_CHART_REFS", "a discourse chart or text tag refers to this paragraph; make this change in FLEx",
                                    {"para": pg, **refs[pg]})
            if sg is not None and sg not in segs and sg not in new_phrases:
                raise FlexError("E_SCOPE", "phrase not in this text", {"seg": sg})
            if sg in new_phrases and sg not in segs and kind not in ("phrase.split", "phrase.toPara", "ft.set", "times.set"):
                raise FlexError("E_SCOPE", "that change is not made on a phrase this save creates; save the split first", {"op": kind})
            if kind in ("ft.set", "lt.set") and op.get("ws") not in chosen:
                raise FlexError("E_SCOPE", "writing system is not one of the chosen analysis WSs", {"ws": op.get("ws")})
            if kind == "gloss.set" and any(w not in chosen for w in gloss_changes(op)):
                raise FlexError("E_SCOPE", "writing system is not one of the chosen analysis WSs",
                                {"ws": next(w for w in gloss_changes(op) if w not in chosen)})
            # words edited in a view of another vernacular writing system than the paragraph is written in
            # would be written into the paragraph as if they were its own text
            if kind in WORD_EDITS and pg in paras and paras[pg]["ws"] != text_ws["vern"]:
                raise FlexError("E_WS_WORDS", "the words are shown in %s; this paragraph is written in %s" % (text_ws["vern"], paras[pg]["ws"]),
                                {"shown": text_ws["vern"], "para": paras[pg]["ws"]})
            if kind == "phrase.split":
                deltas["Segment"] += 2          # the hard line break's own label segment, and the new phrase
                writes_section()
                summary.append({"kind": kind, "seg": sg})
            elif kind == "phrase.join":
                # ONE phrase whatever parts them: the hard line break(s) go with the phrase joined (its label segments
                # with it), an existing § goes; across a paragraph, the break the toggle-off writes goes again. The
                # n-th join on a phrase absorbs the n-th phrase after it (labels are not phrases).
                gone = 1
                if sg in at:
                    n = joins_on.get(sg, 0)
                    joins_on[sg] = n + 1
                    k = at[sg]
                    if flat[k]["isLabel"]:
                        raise FlexError("E_SCOPE", "a line break or a verse number is not a phrase to join", {"seg": sg, "lineBreak": True})
                    seen, i, between, prev_i = 0, k + 1, [], k
                    while i < len(flat):
                        if flat[i]["isLabel"]:
                            between.append(i)
                        else:
                            if seen == n:
                                break
                            seen, between, prev_i = seen + 1, [], i
                        i += 1
                    left = flat[prev_i]
                    if S._ends_with_eos(flat_para[prev_i]["contents"][left["begin"]:left["end"]]):
                        raise FlexError("E_SCOPE", "this phrase ends in real punctuation; change the text explicitly instead",
                                        {"seg": sg, "joinAtStop": True})
                    for li in between:
                        lp = flat_para[li]
                        if not S._is_break_label(lp, flat[li]):
                            raise FlexError("E_SCOPE", "a verse or chapter number sits between these phrases; change it in FLEx", {"seg": sg})
                    gone += len(between)
                    if i < len(flat) and flat_para[i]["guid"] != flat_para[prev_i]["guid"] and S.join_writes_break(flat_para[prev_i], flat_para[i]):
                        gone += 1                # the break paragraph_to_phrase writes, taken out again by this join
                deltas["Segment"] -= gone
                summary.append({"kind": kind, "seg": sg})
            elif kind in ("para.split", "phrase.toPara"):
                deltas["StTxtPara"] += 1
                if op.get("afterSplit") and sg in split_subjects:
                    deltas["Segment"] -= 1      # the split's own hard line break becomes the paragraph boundary
                elif op.get("afterSplit"):
                    # the LAST piece of a split: the boundary after it is its base phrase's own (a stop, a §, or line
                    # breaks), counted on the base paragraph (VM, 2026-10-21)
                    x = sg
                    while x in split_from_phrase:
                        x = split_from_phrase[x]
                    if x in segs:
                        p_, _ = segs[x]
                        k_ = next(i for i, s in enumerate(p_["segments"]) if s["guid"] == x)
                        _, run = S.boundary_after(p_, k_)
                        S._require_breaks(p_, run, sg)
                        deltas["Segment"] -= len(run)
                elif pg in paras and sg in segs and segs[sg][0]["guid"] == pg:
                    p_ = paras[pg]
                    k_ = next(i for i, s in enumerate(p_["segments"]) if s["guid"] == sg)
                    _, run = S.boundary_after(p_, k_)
                    S._require_breaks(p_, run, sg)
                    deltas["Segment"] -= len(run)
                if op.get("newPara"):
                    split_from[op["newPara"]] = pg
                summary.append({"kind": kind, "para": pg})
            elif kind in ("para.join", "para.toPhrase"):
                deltas["StTxtPara"] -= 1
                if pg in paras:             # paragraph_to_phrase writes a hard line break unless the paragraph ends in one
                    end = merged_end.get(pg, order.index(pg))
                    last = t["paragraphs"][end]
                    if end + 1 < len(order) and S.join_writes_break(last, t["paragraphs"][end + 1]):
                        deltas["Segment"] += 1
                        writes_section()
                    merged_end[pg] = end + 1
                    # the paragraph merged into it is touched too: it is gone afterwards, and a vanished
                    # "untouched" paragraph is exactly what the invariant check refuses
                    if end + 1 < len(order):
                        touched_paras.add(order[end + 1])
                        absorbed.setdefault(pg, set()).add(order[end + 1])
                        S.require_not_fragile(self.port, t["paragraphs"][end + 1])
                summary.append({"kind": kind, "para": pg})
            elif kind == "word.split":
                p, s = segs[sg]
                toks = S.word_token_ends(p, s)
                i, off = op.get("index"), op.get("offset")
                if not (isinstance(i, int) and 0 <= i < len(toks)) or toks[i][3]:
                    raise FlexError("E_SCOPE", "not a word", {"index": i})
                form = toks[i][2]
                if not (isinstance(off, int) and 0 < off < len(form)):
                    raise FlexError("E_SCOPE", "offset not inside the word", {})
                for half in (form[:off], form[off:]):
                    if not any(is_word_forming(c) for c in half):
                        raise FlexError("E_EMPTY_PHRASE", "each half of a split word needs a letter", {})
                    new_wordform(half, p["ws"])
                summary.append({"kind": kind, "word": form, "into": [form[:off], form[off:]]})
            elif kind == "word.join":
                p, s = segs[sg]
                toks = S.word_token_ends(p, s)
                i = op.get("index")
                if not (isinstance(i, int) and 0 <= i < len(toks) - 1) or toks[i][3] or toks[i + 1][3]:
                    raise FlexError("E_SCOPE", "not two words", {"index": i})
                gap = p["contents"][toks[i][1]:toks[i + 1][0]]
                if not gap or gap.strip():
                    raise FlexError("E_SCOPE", "only words parted by a space are joined", {"index": i})
                merged = toks[i][2] + toks[i + 1][2]
                new_wordform(merged, p["ws"])
                summary.append({"kind": kind, "words": [toks[i][2], toks[i + 1][2]], "into": merged})
            elif kind == "word.insert":
                w = (op.get("text") or "").strip()
                if not w or any(c.isspace() for c in w) or not any(is_word_forming(c) for c in w):
                    raise FlexError("E_SCOPE", "a word to insert must be one word with a letter", {})
                new_wordform(w, paras[pg]["ws"] if pg in paras else None)
                summary.append({"kind": kind, "word": w})
            elif kind == "baseline.replace":
                new = nfd(op.get("text") or "")
                old = paras[pg]["contents"]
                if len(self.port.get_segments(new, paras[pg]["ws"])) != len(paras[pg]["segments"]):
                    raise FlexError("E_SCOPE", "this text change alters the phrase structure; split or join instead", {"para": pg})
                old_forms = {tk[2] for tk in tokenize(old)}
                for tk in tokenize(new):
                    if tk[3]:
                        if not self.port.has_punct_form(tk[2]) and tk[2] not in old_forms:
                            deltas["PunctuationForm"] += 1
                            old_forms.add(tk[2])
                    elif tk[2] not in old_forms:
                        new_wordform(tk[2], paras[pg]["ws"])
                        old_forms.add(tk[2])
                summary.append({"kind": kind, "before": old, "after": new})
            elif kind == "gloss.set":
                # planned below, in the order the save runs them (glosses.Planner)
                if sg not in segs or not isinstance(op.get("index"), int):
                    raise FlexError("E_SCOPE", "no such word", {"seg": sg, "index": op.get("index")})
                if op.get("newWord") and not (isinstance(op.get("form"), str) and op["form"].strip()):
                    raise FlexError("E_SCOPE", "the gloss of a word this save makes names that word", {"seg": sg})
                key = (sg, op["index"], bool(op.get("newWord")))
                if key in glossed:
                    raise FlexError("E_SCOPE", "one gloss change per word", {"seg": sg, "index": op["index"]})
                glossed.add(key)
                gloss_ops.append(op)
            elif kind in ("ft.set", "lt.set"):
                cur = ((segs[sg][1]["ft"] if kind == "ft.set" else segs[sg][1]["lt"]).get(op["ws"], "")) if sg in segs else ""
                if cur != (op.get("value") or ""):
                    summary.append({"kind": kind, "seg": sg, "ws": op["ws"], "before": cur, "after": op.get("value", "")})
            elif kind == "times.set":
                summary.append({"kind": kind, "seg": sg, "begin": op.get("begin"), "end": op.get("end")})
                if op.get("begin") is not None and not t["media"] and not any(o.get("op") == "media.attach" for o in ops):
                    warnings.append({"code": "timesWithoutMedia", "seg": sg,
                                     "note": "FLEx keeps and exports times only with a media link (plan §8.1)"})
            elif kind == "phrase.moveBoundary":
                if sg in segs:              # a § moved becomes a hard line break: one label segment more
                    p_, s_ = segs[sg]
                    k_ = next(i for i, x in enumerate(p_["segments"]) if x["guid"] == sg)
                    _, labels_ = S.next_phrase(p_, k_)
                    if not labels_:
                        deltas["Segment"] += 1
                        writes_section()
                summary.append({"kind": kind, "seg": sg})
        # the glosses, each planned on what the ones before it leave — one Planner for the whole save
        planner = glosses.Planner(self.port, made_forms)
        for op in sorted(gloss_ops, key=op_order):
            p, s = segs[op["segGuid"]]
            if op.get("newWord"):
                plan = planner.plan(None, op["index"], gloss_changes(op), chosen, new_word=op["form"], ws=p["ws"])
            else:
                plan = planner.plan(s, op["index"], gloss_changes(op), chosen, guess=op.get("guess"))
            if plan["outcome"] == "unchanged":
                continue
            if plan.get("newAnalysis"):
                deltas["WfiAnalysis"] += 1
                deltas["WfiMorphBundle"] += 1
            if plan["outcome"] == "newGloss":
                deltas["WfiGloss"] += 1
            a = plan.get("analysisGuid")
            summary.append({"kind": "gloss.set", "seg": op["segGuid"], "index": op["index"], "outcome": plan["outcome"],
                            "fromGuess": bool(plan.get("fromGuess")),
                            "ws": plan["changed"], "newWord": bool(op.get("newWord")), "otherUses": plan.get("otherUses", 0),
                            "approves": plan["outcome"] != "unglossed" and bool(a) and (str(a).startswith("planned-") or not self.port.is_approved(a))})
        # post-state checks: empty phrases and internal EOS, per touched paragraph — on the marker-agnostic
        # form, which is also what the in-UOW comparison uses (model.normalize_post_state)
        if not isinstance(post_state, (dict, type(None))):
            raise FlexError("E_SCOPE", "post_state must be an object", {})
        post_state = model.normalize_post_state(post_state)

        def kept_label(pg, ph):
            """A label segment FLEx already has — a hard line break (U+2028), a line of only punctuation — sent back
            as it is, in its own paragraph or one this save merges into it. It has no letters and never had: D4 is
            about a phrase the ENGINE would make empty, and refusing this one refused every edit anywhere in a
            paragraph holding a line break (2026-10-17)."""
            hit = segs.get(ph.get("segGuid"))
            if not hit or not hit[1]["isLabel"]:
                return False
            p, s = hit
            # its paragraph, one merged into it, or — for a paragraph this save splits off — the one it comes from
            home, q, seen = {pg} | set(absorbed.get(pg, ())), pg, set()
            while q in split_from and q not in seen:
                seen.add(q)
                q = split_from[q]
                home |= {q} | set(absorbed.get(q, ()))
            if p["guid"] not in home:
                return False
            return [w.get("txt") or "" for w in ph.get("words") or []] == [model.word_form(a, text_ws["vern"]) for a in s["analyses"]]
        for pg, phrases in (post_state or {}).items():
            for ph in phrases:
                txt = ph.get("text") or ""
                if not any(is_word_forming(c) for c in txt) and not kept_label(pg, ph):
                    blockers.append({"code": "E_EMPTY_PHRASE", "para": pg, "seg": ph.get("segGuid"),
                                     "note": "a phrase with no letters cannot be a FLEx segment (D4)"})
                core = txt.rstrip().rstrip("".join(S.CLOSERS))
                inner = core[:-1] if core and core[-1] in EOS_CHARS else core
                for i, c in enumerate(inner):
                    if c in EOS_CHARS and c != "." and any(is_word_forming(x) for x in inner[i + 1:]):
                        warnings.append({"code": "internalEos", "para": pg, "seg": ph.get("segGuid"), "char": c})
                        break
        if blockers:
            raise FlexError("E_EMPTY_PHRASE", "a phrase with no letters cannot be saved to FLEx; type its words or merge it",
                            {"blockers": blockers, "warnings": warnings})
        token = secrets.token_hex(16)
        try:
            SAVE.info("preview %s: %d ops, %d changes, deltas %s, warnings %s", token[:8], len(ops), len(summary),
                      trace.short({k: v for k, v in deltas.items() if v}), trace.short(warnings, 600))
            for i, op in enumerate(ops):
                SAVE.debug("  op %d: %s", i + 1, trace.short(op, 700))
            for x in summary:
                SAVE.debug("  change: %s", trace.short(x, 500))
        except Exception:   # noqa: BLE001
            pass
        self.previews[token] = {
            "text": text_guid, "baseRev": base_rev, "ops": ops, "post": post_state or {}, "chosen": chosen, "ws": text_ws,
            "touched": touched_paras, "deltas": {k: v for k, v in deltas.items() if v}, "classes": classes,
            "fp": dict(entry["fp"]), "expires": time.time() + PREVIEW_TTL, "n": len(summary),
            "summary": summary, "warnings": warnings,
        }
        return {"previewToken": token, "summary": summary, "counts": self.previews[token]["deltas"], "warnings": warnings,
                "blockers": [], "backupDir": self.port.backup_dir() if hasattr(self.port, "backup_dir") else None,
                "undoLabel": "Undo Save to FLEx (%d changes)" % len(summary)}

    def _take_preview(self, token):
        pv = self.previews.pop(token, None)
        if not pv or pv["expires"] < time.time():
            raise FlexError("E_PREVIEW_EXPIRED", "the preview expired; open Save to FLEx again", {})
        entry = self.texts.get(pv["text"])
        if not entry or entry["baseRev"] != pv["baseRev"]:
            raise FlexError("E_STALE_BASE", "the text changed since the preview", {})
        return pv

    # ---- W2 backup ----------------------------------------------------------------------------
    def ensure_backup(self, progress=None):
        if self.backup_ok and os.path.isfile(self.backup_ok):
            return {"path": self.backup_ok, "verified": True, "reused": True}
        if progress:
            progress("Backing up…")
        if self.port.depth() != 0:
            raise FlexError("E_BACKUP_FAILED", "backup must run at depth 0", {})
        try:
            path = self.port.backup(BACKUP_COMMENT)
        except Exception as e:   # noqa: BLE001
            raise FlexError("E_BACKUP_FAILED", "FLEx's backup failed: %s" % e, {}) from e
        if progress:
            progress("Verifying backup…")
        self._verify_backup(path)
        self.backup_ok = path
        return {"path": path, "verified": True, "reused": False}

    def _verify_backup(self, path):
        live = self.port.fwdata_path()
        live_count = sum(1 for _ in diskcheck.iter_rt(live))
        live_version = diskcheck.header_version(live)
        try:
            with zipfile.ZipFile(path) as z:
                bad = z.testzip()
                if bad is not None:
                    raise FlexError("E_BACKUP_FAILED", "the backup zip is corrupt at %s" % bad, {"path": path})
                names = [n for n in z.namelist() if n.lower().endswith(".fwdata")]
                if not names or os.path.basename(names[0]) != os.path.basename(live):
                    raise FlexError("E_BACKUP_FAILED", "the backup does not hold the project's .fwdata", {"path": path})
                with z.open(names[0]) as f:
                    count, version = 0, None
                    for ev, el in ET.iterparse(f, events=("start", "end")):
                        if ev == "start" and el.tag == "languageproject" and version is None:
                            version = int(el.get("version") or 0)
                        elif ev == "end" and el.tag == "rt":
                            count += 1
                            el.clear()
        except (zipfile.BadZipFile, OSError, ET.ParseError) as e:
            raise FlexError("E_BACKUP_FAILED", "the backup cannot be read: %s" % e, {"path": path}) from e
        if version != live_version:
            raise FlexError("E_BACKUP_FAILED", "backup header version %s ≠ live %s" % (version, live_version), {})
        if count != live_count:
            raise FlexError("E_BACKUP_FAILED", "backup holds %d objects, live file %d" % (count, live_count), {})

    # ---- W3–W9 save ---------------------------------------------------------------------------
    def save(self, token, progress=None):
        self.guard()
        pv = self._take_preview(token)
        if self.copy_only:
            from . import copyonly
            copyonly.check_write_allowed(self.port.project_dir(), self.name, True)
        text_guid = pv["text"]
        t_before = self.port.read_text(text_guid)
        fp_before = model.fingerprint_text(t_before)
        if fp_before != pv["fp"]:
            raise FlexError("E_STALE_BASE", "the text changed since it was opened", {})
        SAVE.info("save %s: text %s, %d ops", token[:8], text_guid, len(pv["ops"]))
        backup = self.ensure_backup(progress)
        SAVE.info("W2 backup %s (verified%s)", backup.get("path"), ", reused" if backup.get("reused") else "")
        if progress:
            progress("Writing…")
        if self.port.depth() != 0:
            raise FlexError("E_INTERNAL", "a unit of work is already open", {"depth": self.port.depth()})
        counts_before = self.port.counts()
        actions_before = self.port.undo_item_count()
        undo_label = "Undo Save to FLEx (%d changes)" % pv["n"]
        redo_label = "Redo Save to FLEx (%d changes)" % pv["n"]
        alias = {}
        touched = set(pv["touched"])
        new_owners = set()
        agent_before = self.port.user_agent() or {}
        SAVE.info("W3 begin unit of work %r (FLEx history items before: %d)", undo_label, actions_before)
        h = self.port.begin_uow(undo_label, redo_label)
        try:
            self._apply_ops(text_guid, pv, alias, touched, new_owners)
            if progress:
                progress("Checking…")
            SAVE.info("W4 checking the result inside the unit of work")
            self._check_invariants(text_guid, pv, alias, touched, fp_before, counts_before, t_before)
            evaluations_made = self._evaluations_made(agent_before, any(o.get("op") == "gloss.set" for o in pv["ops"]))
            SAVE.info("W5 commit")
            self.port.commit(h)
        except Exception as e:   # noqa: BLE001 — anything → rollback
            err = e if isinstance(e, FlexError) else FlexError("E_INVARIANT", "the write failed: %s" % e, {"type": type(e).__name__})
            try:
                SAVE.warning("rolling back: %s — %s%s", err.code, err.message,
                             ("\n" + trace.exc_text(e)) if not isinstance(e, FlexError) else (" | detail " + trace.short(err.detail, 2000)))
            except Exception:   # noqa: BLE001
                pass
            try:
                if self.port.depth() > 0:
                    self.port.rollback(h)
            except Exception as e2:   # noqa: BLE001
                self._poison(FlexError("E_ROLLBACK_INCOMPLETE", "rollback itself failed: %s" % e2, {}))
                raise self.poisoned from e2
            # W6: everything back as it was?
            if self.port.depth() != 0 or self.port.undo_item_count() != actions_before:
                self._poison(FlexError("E_ROLLBACK_INCOMPLETE", "the undo stack is not as before the write", {}))
                raise self.poisoned
            t_after = self.port.read_text(text_guid)
            if model.fingerprint_text(t_after) != fp_before or self.port.counts() != counts_before:
                self._poison(FlexError("E_ROLLBACK_INCOMPLETE", "a rolled-back write left the text changed", {}))
                raise self.poisoned
            SAVE.info("rolled back cleanly: FLEx is as it was, nothing was written")
            raise err
        # W5 post-conditions: depth 0, ONE more FLEx history item, and it is ours (port.undo_item_count
        # counts history items — never LCM's UndoableActionCount, which counts every change in them)
        depth_after, items_after, text_after = self.port.depth(), self.port.undo_item_count(), self.port.last_undo_text()
        SAVE.info("W5 committed: depth %d, FLEx history items %d → %d, top item %r", depth_after, actions_before, items_after, text_after)
        if depth_after != 0 or items_after != actions_before + 1 or text_after != undo_label:
            self._poison(FlexError("E_INVARIANT", "the commit did not produce exactly one FLEx history item (depth %d, items %d → %d, "
                                   "top item %r, expected %r)" % (depth_after, actions_before, items_after, text_after, undo_label),
                                   {"depth": depth_after, "itemsBefore": actions_before, "itemsAfter": items_after,
                                    "undoText": text_after, "expected": undo_label}))
            raise self.poisoned
        fp_after = model.fingerprint_text(self.port.read_text(text_guid))
        allowed = {"classes": set(pv["classes"]), "touchedOwners": {text_guid} | new_owners, "countDeltas": dict(pv["deltas"]),
                   "referencedFrom": self._referenced_from(text_guid),
                   "newPunctForms": {LINE_SEP} if pv["deltas"].get("PunctuationForm", 0) > 0 else set()}
        if evaluations_made:
            # the first approval ever recorded in this project made the user agent's two evaluation objects
            # (CmAgent.SetEvaluation): new, owned by the agent, which changes too — and undone with the save
            allowed["classes"] |= {"CmAgent", "CmAgentEvaluation"}
            allowed["touchedOwners"].add(agent_before["guid"])
            allowed["countDeltas"]["CmAgentEvaluation"] = evaluations_made
        disk = self._save_and_check(progress, allowed, expect_fields=self._expected_fields(pv, alias))
        entry = self.texts[text_guid]
        entry["fp"] = fp_after
        entry["baseRev"] = model.base_rev(self.port.read_text(text_guid))
        self.history.append({"text": text_guid, "fpBefore": fp_before, "fpAfter": fp_after, "allowed": allowed, "label": undo_label,
                             "countsBefore": counts_before, "countsAfter": self.port.counts()})
        self.redo_history.clear()
        self.backup_ok = None    # after a save the next save backs up again
        SAVE.info("saved: %d changes, one FLEx history item %r; on disk %s", pv["n"], undo_label, trace.short(disk.get("changed"), 600))
        return {"undoLabel": undo_label, "backup": backup, "disk": disk, "newBaseRev": entry["baseRev"], "alias": alias,
                "saved": pv["n"]}

    def _evaluations_made(self, agent_before, may_approve):
        """How many of the user agent's evaluation objects this write created, measured inside the unit of
        work: CmAgent.SetEvaluation makes ApprovesOA and DisapprovesOA the first time either is needed
        [source: liblcm OverridesCellar.cs], so the first approval ever recorded in a project adds two.
        Measured at the write, never predicted at preview (another save in between may have made them).
        Only an approval can make them — a gloss op's, or FLEx's importer's — anything else is not ours."""
        after = self.port.user_agent() or {}
        made = int(agent_before.get("missingEvaluations") or 0) - int(after.get("missingEvaluations") or 0)
        if made < 0 or made > 2 or (made and not may_approve) or (made and after.get("guid") != agent_before.get("guid")):
            raise FlexError("E_INVARIANT", "the user agent's evaluations changed in a way this save does not explain",
                            {"before": agent_before, "after": after})
        if made:
            SAVE.info("W4 the first approval in this project made %d evaluation object(s) of the user agent %s", made, after.get("guid"))
        return made

    def _referenced_from(self, text_guid):
        refs = set()
        for p in self.port.read_text(text_guid)["paragraphs"]:
            for s in p["segments"]:
                for a in s["analyses"]:
                    refs.add(a["guid"])
                    if a.get("analysisGuid"):
                        refs.add(a["analysisGuid"])
                    if a.get("wordformGuid"):
                        refs.add(a["wordformGuid"])
        for p in self.port.read_text(text_guid)["paragraphs"]:
            for s in p["segments"]:
                for a in s["analyses"]:
                    if a.get("analysisGuid"):
                        ag = a["analysisGuid"]
                        # the analysis's bundles are owned by it (ownership chain covers them via referencedFrom)
                        refs.add(ag)
        return refs

    def _expected_fields(self, pv, alias):
        exp = {}
        for op in pv["ops"]:
            sg = alias.get(op.get("segGuid"), op.get("segGuid"))
            if op.get("op") == "times.set" and sg:
                d = exp.setdefault(sg, {})
                if op.get("begin") is not None:
                    d["BeginTimeOffset"] = str(int(op["begin"]))
                    d["EndTimeOffset"] = str(int(op["end"]))
            if op.get("op") == "ft.set" and sg and op.get("value"):
                # per writing system: the phrase's translations in the others are not this op's
                exp.setdefault(sg, {}).setdefault("FreeTranslation", {})[op["ws"]] = nfd(op["value"])
        return exp

    def _apply_ops(self, text_guid, pv, alias, touched, new_owners):
        port = self.port
        ops = sorted(pv["ops"], key=op_order)
        chosen = pv["chosen"]
        attached_uri = None
        absorbed = {}   # a paragraph a join of this save merged away → the paragraph that took it in
        for op in ops:
            kind = op["op"]
            pg = _resolve(absorbed, alias.get(op.get("paraGuid"), op.get("paraGuid")))
            sg = alias.get(op.get("segGuid"), op.get("segGuid"))
            if sg and kind in STRUCTURAL + WORD_EDITS:
                # The phrase is where it is NOW: an earlier paragraph split of this save may have moved it into the
                # paragraph it made (two Sentence breaks in one line: VM, 2026-10-21, E_NOT_FOUND "no following
                # segment", rolled back), as a join may have merged its paragraph away (`absorbed`).
                pg = _para_holding(port, text_guid, sg) or pg
            if kind == "phrase.split":
                times = op.get("times")
                new = S.split_phrase(port, text_guid, pg, sg, op["afterWordIndex"], new_times=tuple(map(tuple, times)) if times else None)
                if op.get("newPhrase"):
                    alias[op["newPhrase"]] = new
            elif kind == "phrase.join":
                S.join_phrases(port, text_guid, pg, sg, new_end_time=op.get("endTime"))
            elif kind == "phrase.moveBoundary":
                S.move_boundary(port, text_guid, pg, sg, op["afterWordIndex"])
            elif kind in ("para.split", "phrase.toPara"):
                newp = S.phrase_to_paragraph(port, text_guid, pg, sg)
                touched.add(newp)
                if op.get("newPara"):
                    alias[op["newPara"]] = newp
            elif kind in ("para.join", "para.toPhrase"):
                # The paragraph merged in is gone afterwards; an op later in this save that names it — the next
                # join of a chain (three paragraphs made one: join P1, then join P2, which now lives in P1) —
                # means the paragraph that took it in. Found on the VM, 2026-10-21: the second join of a chain
                # answered E_NOT_FOUND "no following paragraph" and the save rolled back. The preview already
                # counted chains (merged_end); the apply did not.
                order = [p["guid"] for p in port.read_text(text_guid)["paragraphs"]]
                i = order.index(pg) if pg in order else None
                S.paragraph_to_phrase(port, text_guid, pg)
                if i is not None and i + 1 < len(order):
                    absorbed[order[i + 1]] = pg
            elif kind == "word.split":
                S.split_word(port, text_guid, pg, sg, op["index"], op["offset"])
            elif kind == "word.join":
                S.join_words(port, text_guid, pg, sg, op["index"])
            elif kind == "word.insert":
                S.insert_word(port, text_guid, pg, sg, op["at"], op["text"])
            elif kind == "baseline.replace":
                S.replace_baseline(port, text_guid, pg, op["text"])
            elif kind == "ft.set":
                port.set_free_translation(sg, op["ws"], op.get("value") or "")
            elif kind == "lt.set":
                port.set_literal_translation(sg, op["ws"], op.get("value") or "")
            elif kind == "times.set":
                port.set_segment_times(sg, op.get("begin"), op.get("end"))
                if attached_uri and op.get("begin") is not None:
                    port.set_segment_media(sg, attached_uri)
                elif op.get("begin") is not None:
                    t = port.read_text(text_guid)
                    if t["media"] and not next(s for p in t["paragraphs"] for s in p["segments"] if s["guid"] == sg)["mediaUri"]:
                        port.set_segment_media(sg, t["media"][0]["guid"])   # times always ride with a media link (§8.1)
            elif kind == "gloss.set":
                glosses.set_gloss(port, text_guid, pg, sg, op["index"], gloss_changes(op), chosen,
                                  new_word=op["form"] if op.get("newWord") else None, guess=op.get("guess"))
            elif kind == "media.relink":
                port.set_media_uri(op["uriGuid"], op["path"])
            elif kind == "media.attach":
                cont, uri = port.create_media(text_guid, op["path"])
                attached_uri = uri
                new_owners.add(cont)
                # every timed segment of the text points at it (plan §8.1 / D9)
                for p in port.read_text(text_guid)["paragraphs"]:
                    for s in p["segments"]:
                        if s["beginTime"] is not None and not s["mediaUri"]:
                            port.set_segment_media(s["guid"], uri)

    def _check_invariants(self, text_guid, pv, alias, touched, fp_before, counts_before, t_before=None):
        port = self.port
        t = port.read_text(text_guid)
        paras = {p["guid"]: p for p in t["paragraphs"]}
        # 1. segmentation invariant on every touched paragraph
        for pg in list(touched):
            if pg in paras and not S.check_invariant(port, paras[pg]):
                raise FlexError("E_INVARIANT", S.INVARIANT_MSG, {"para": pg})
        # 4. untouched paragraphs unchanged
        fp_now = model.fingerprint_text(t)
        for pg, h in fp_before.items():
            if pg not in touched and fp_now.get(pg) != h:
                raise FlexError("E_INVARIANT", "an untouched paragraph changed", {"para": pg})
        # 5. counts: never-change classes exactly; the rest by the preview's deltas
        after = port.counts()
        for cls in NEVER_CHANGE:
            if after[cls] != counts_before[cls]:
                raise FlexError("E_INVARIANT", "%s count changed" % cls, {"before": counts_before[cls], "after": after[cls]})
        for cls in COUNTED_CLASSES:
            want = counts_before[cls] + pv["deltas"].get(cls, 0)
            if after[cls] != want:
                raise FlexError("E_INVARIANT", "%s count is %d, the preview said %d" % (cls, after[cls], want), {"cls": cls})
        # 2./3./6. re-read == intended post-state (segment GUIDs, words, FT/LT, times, kept analyses)
        if pv["post"]:
            intended = {}
            for pg, phrases in pv["post"].items():
                real_pg = alias.get(pg, pg)
                intended[real_pg] = [dict(ph, segGuid=alias.get(ph.get("segGuid"), ph.get("segGuid"))) for ph in phrases]
            ws = pv.get("ws") or model.default_ws(t)
            actual = model.read_model_post_state(t, set(intended), ws)
            visible = self._visible(pv, ws)
            problems = model.compare_post_state(intended, actual, primary=ws["anal"], visible=visible,
                                                others=self._other_translations(pv, t_before, visible))
            if problems:
                raise FlexError("E_INVARIANT", "re-read differs from the intended result: " + "; ".join(problems[:5]), {"problems": problems})

    @staticmethod
    def _visible(pv, ws):
        """The analysis writing systems the engine speaks for: every one it carries (to_engine_doc puts
        each current one in the doc, editable since 2026-10-16) — when its post-state says so by carrying
        per-word `glosses`; an older engine's spoke for the text's one analysis writing system only."""
        speaks_all = any(isinstance(w.get("glosses"), dict) for phrases in (pv.get("post") or {}).values()
                         for ph in phrases for w in (ph.get("words") or []))
        return set(pv.get("chosen") or []) | {ws["anal"]} if speaks_all else {ws["anal"]}

    @staticmethod
    def _other_translations(pv, t_before, visible):
        """What every translation the engine does not speak for must be after the save, per phrase
        that had them before: unchanged, unless an ft.set/lt.set of this save sets it, and not for a
        join's survivor (LCM joins every translation of the two with a space, plan §6.3)."""
        if t_before is None:
            return None
        joined = {o.get("segGuid") for o in pv["ops"] if o.get("op") == "phrase.join"}
        out = {}
        for p in t_before["paragraphs"]:
            for s in p["segments"]:
                if s["guid"] not in joined:
                    out[s["guid"]] = {"ft": {w: x for w, x in s["ft"].items() if x}, "lt": {w: x for w, x in s["lt"].items() if x}}
        for o in pv["ops"]:
            if o.get("op") in ("ft.set", "lt.set") and o.get("segGuid") in out and (o["op"] == "lt.set" or o.get("ws") not in visible):
                out[o["segGuid"]]["ft" if o["op"] == "ft.set" else "lt"][o["ws"]] = o.get("value") or ""
        return out

    def _save_and_check(self, progress, allowed, expect_fields=None):
        """W7 + W8, shared by save and undo/redo. Poisons on failure."""
        port = self.port
        self.guess_cache.clear()   # a write (or its undo) can change any word's guess, in any text
        if progress:
            progress("Saving…")
        fw = port.fwdata_path()
        mtime_before = os.stat(fw).st_mtime_ns
        n_err = len([r for r in self.log.records if r.levelno >= logging.ERROR])
        SAVE.info("W7 saving the project file %s", fw)
        try:
            port.save()
            port.complete_all_commits()
        except Exception as e:   # noqa: BLE001
            try:
                SAVE.error("W7 FLEx's save threw:\n%s", trace.exc_text(e))
            except Exception:   # noqa: BLE001
                pass
            self._poison(FlexError("E_SAVE_FAILED", "Save threw: %s" % e, {"type": type(e).__name__}))
            raise self.poisoned from e
        if self.poisoned or len([r for r in self.log.records if r.levelno >= logging.ERROR]) > n_err:
            if not self.poisoned:
                said = [r.getMessage() for r in self.log.records if r.levelno >= logging.ERROR][n_err:]
                self._poison(FlexError("E_SAVE_FAILED", "FLEx logged an error while saving: %s" % "; ".join(said[:3]), {"log": said[:10]}))
            self._w9(fw)
            raise self.poisoned
        if progress:
            progress("Checking the file on disk…")
        base = fw[:-len(".fwdata")]
        facts = diskcheck.files_after_save(fw, mtime_before)
        if not facts["tmpGone"] or not facts["mtimeChanged"] or not facts["bakExists"]:
            self._poison(FlexError("E_DISK_CHECK_FAILED", "the save left the files in an unexpected state", facts))
            self._w9(fw)
            raise self.poisoned
        d = diskcheck.diff_rt(base + ".bak", fw)
        a = dict(allowed)
        a["expect"] = expect_fields or {}
        SAVE.info("W8 disk read-back: %d objects added, %d removed, %d changed (allowed classes %s, count deltas %s)",
                  len(d["added"]), len(d["removed"]), len(d["changed"]), sorted(a.get("classes", ())), a.get("countDeltas"))
        for g, n in d["added"].items():
            SAVE.debug("  W8 added %s %s (owner %s)", n["cls"], g, n["owner"])
        for g, o in d["removed"].items():
            SAVE.debug("  W8 removed %s %s", o["cls"], g)
        for g, (o, n) in d["changed"].items():
            SAVE.debug("  W8 changed %s %s: %s", n["cls"], g,
                       sorted(k for k in set(o["fields"]) | set(n["fields"]) if o["fields"].get(k) != n["fields"].get(k)))
        problems = diskcheck.check(d, a, d.get("newMap") or diskcheck.load_rt(fw))
        if problems:
            for p in problems:
                SAVE.error("  W8 NOT EXPLAINED: %s", p)
            said = "; ".join("%s %s: %s" % (p["cls"], (p["guid"] or "")[:8], p["why"]) for p in problems[:3])
            self._poison(FlexError("E_DISK_CHECK_FAILED", "the file on disk changed in ways the preview did not allow: %s%s" % (
                said, " (and %d more)" % (len(problems) - 3) if len(problems) > 3 else ""), {"problems": problems[:20]}))
            self._w9(fw)
            raise self.poisoned
        if progress:
            progress("Running FLEx's own file check…")
        data_check = self._data_check(fw, base + ".bak")
        changed = {}
        for g, (o, n) in d["changed"].items():
            if n["cls"] in diskcheck.DATE_ONLY_OK and set(k for k in n["fields"] if o["fields"].get(k) != n["fields"].get(k)) <= {"DateModified"}:
                continue   # the DateModified stamps every save makes: not a change worth reporting
            changed[n["cls"]] = changed.get(n["cls"], 0) + 1
        for g, n in d["added"].items():
            changed[n["cls"]] = changed.get(n["cls"], 0) + 1
        for g, o in d["removed"].items():
            changed[o["cls"]] = changed.get(o["cls"], 0) + 1
        return {"ok": True, "changed": changed, "facts": facts, "dataCheck": data_check}

    def _data_check(self, fw, bak):
        """W8b: FLEx's own file check (FwDataFixer, port.check_data) over the SAVED file, after W8 has
        explained every byte that changed. A problem it reports is judged against the file from BEFORE
        the save (.bak): one the write introduced poisons the session and sets the file aside (W9) like
        any other failed check; one that was already there is reported — "preExisting" — never blamed on
        this save and never a reason to refuse it, because a project that FLEx has been running with a
        fixable fault would otherwise never accept a write again. A check that cannot RUN is not a clean
        check: it is said loudly (console, the saved toast) and the save stands on W8 alone."""
        try:
            found = self.port.check_data(fw)
        except Exception as e:   # noqa: BLE001
            SAVE.error("W8b FLEx's own file check (FwDataFixer) could not run: %s", trace.exc_text(e))
            return {"ran": False, "why": "%s: %s" % (type(e).__name__, str(e)[:200])}
        if not found:
            SAVE.info("W8b FwDataFixer: no problems in the saved file")
            return {"ran": True, "problems": 0, "preExisting": 0}
        try:
            before = set(self.port.check_data(bak))
        except Exception as e:   # noqa: BLE001
            SAVE.error("W8b FwDataFixer could not run on the file from before the save: %s", e)
            before = set()
        new = [p for p in found if p not in before]
        old = [p for p in found if p in before]
        for p in old:
            SAVE.warning("  W8b FwDataFixer, already in the file before this save: %s", p)
        if new:
            for p in new:
                SAVE.error("  W8b FwDataFixer, introduced by this save: %s", p)
            self._poison(FlexError("E_DATA_CHECK_FAILED", "FLEx's own file check found %d problem(s) the save introduced: %s%s" % (
                len(new), "; ".join(new[:3]), " (and %d more)" % (len(new) - 3) if len(new) > 3 else ""),
                {"problems": new[:20], "preExisting": len(old)}))
            self._w9(fw)
            raise self.poisoned
        return {"ran": True, "problems": 0, "preExisting": len(old), "preExistingSample": old[:5]}

    def _w9(self, fw):
        """Preserve the file that failed the check (never delete); the user chooses .bak or the backup."""
        try:
            stamp = time.strftime("%Y%m%d-%H%M%S")
            failed = fw + ".failed-" + stamp
            if os.path.exists(fw):
                os.rename(fw, failed)
                self.failed_file = failed
                SAVE.error("W9 the file that failed the check was set aside as %s; the file from before this save is %s",
                           failed, fw[:-len(".fwdata")] + ".bak")
        except OSError as e:
            SAVE.error("W9 could not set the file aside: %s", e)

    def recover(self, choice):
        """After W9: 'bak' copies <name>.bak → .fwdata (the pre-save file). The W2 backup is restored
        through FLEx (File ▸ Restore), which this only names."""
        if not self.poisoned:
            raise FlexError("E_SCOPE", "nothing to recover", {})
        fw = self.port.fwdata_path()
        bak = fw[:-len(".fwdata")] + ".bak"
        if choice == "bak":
            if os.path.exists(fw):
                raise FlexError("E_SCOPE", "a .fwdata already exists; nothing overwritten", {})
            if not os.path.exists(bak):
                raise FlexError("E_NOT_FOUND", "no .bak to restore", {})
            shutil.copy2(bak, fw)
            return {"restored": "bak", "fwdata": fw}
        return {"restored": None, "backup": self.backup_ok, "howTo": "FLEx ▸ File ▸ Restore, choose the backup named above"}

    # ---- §5.5 undo / redo of a save ----------------------------------------------------------
    def undo_save(self, progress=None):
        self.guard()
        if not self.history:
            raise FlexError("E_NOT_FOUND", "nothing to undo", {})
        if self.port.depth() != 0:
            raise FlexError("E_BUSY", "a unit of work is open", {})
        h = self.history[-1]
        r = self.port.undo()
        if r != UNDO_SUCCESS:
            self._poison(FlexError("E_ROLLBACK_INCOMPLETE", "FLEx's undo answered %s" % r, {}))
            raise self.poisoned
        if h.get("import"):
            # an undone import: the text is gone again; only the counts can be compared
            texts = {x["guid"] for x in self.port.list_texts()}
            if any(g in texts for g in h["allowed"]["touchedOwners"]) or self.port.counts() != h["countsBefore"]:
                self._poison(FlexError("E_ROLLBACK_INCOMPLETE", "undo did not remove the imported text", {}))
                raise self.poisoned
            t = None
        else:
            t = self.port.read_text(h["text"])
            if model.fingerprint_text(t) != h["fpBefore"] or self.port.counts() != h["countsBefore"]:
                self._poison(FlexError("E_ROLLBACK_INCOMPLETE", "undo did not restore the pre-save state", {}))
                raise self.poisoned
        # undoing a save REMOVES what the save added: the same class set, the count deltas negated
        undo_allowed = dict(h["allowed"], countDeltas={k: -v for k, v in h["allowed"].get("countDeltas", {}).items()})
        disk = self._save_and_check(progress, undo_allowed)
        self.history.pop()
        self.redo_history.append(h)
        entry = self.texts.get(h["text"]) if t is not None else None
        if entry:
            entry["fp"] = model.fingerprint_text(t)
            entry["baseRev"] = model.base_rev(t)
        return {"label": h["label"], "disk": disk, "newBaseRev": entry["baseRev"] if entry else None}

    def redo_save(self, progress=None):
        self.guard()
        if not self.redo_history:
            raise FlexError("E_NOT_FOUND", "nothing to redo", {})
        if self.port.depth() != 0:
            raise FlexError("E_BUSY", "a unit of work is open", {})
        h = self.redo_history[-1]
        r = self.port.redo()
        if r != UNDO_SUCCESS:
            self._poison(FlexError("E_ROLLBACK_INCOMPLETE", "FLEx's redo answered %s" % r, {}))
            raise self.poisoned
        if h.get("import"):
            texts = {x["guid"] for x in self.port.list_texts()}
            if not all(g in texts for g in h["allowed"]["touchedOwners"]) or self.port.counts() != h["countsAfter"]:
                self._poison(FlexError("E_ROLLBACK_INCOMPLETE", "redo did not restore the imported text", {}))
                raise self.poisoned
            t = None
        else:
            t = self.port.read_text(h["text"])
            if model.fingerprint_text(t) != h["fpAfter"] or self.port.counts() != h["countsAfter"]:
                self._poison(FlexError("E_ROLLBACK_INCOMPLETE", "redo did not restore the post-save state", {}))
                raise self.poisoned
        disk = self._save_and_check(progress, h["allowed"])
        self.redo_history.pop()
        self.history.append(h)
        entry = self.texts.get(h["text"]) if t is not None else None
        if entry:
            entry["fp"] = model.fingerprint_text(t)
            entry["baseRev"] = model.base_rev(t)
        return {"label": h["label"].replace("Undo", "Redo"), "disk": disk, "newBaseRev": entry["baseRev"] if entry else None}

    # ---- §9.1 import ----------------------------------------------------------------------------
    def import_preview(self, path):
        self.guard()
        if not self.write:
            raise FlexError("E_SCOPE", "the project is open read-only", {})
        try:
            root = ET.parse(path).getroot()
        except (ET.ParseError, OSError) as e:
            raise FlexError("E_IMPORT_INVALID", "not a readable .flextext: %s" % e, {}) from e
        if root.tag != "document":
            raise FlexError("E_IMPORT_INVALID", "root element is not <document>", {})
        texts, paras, phrases = 0, 0, 0
        warnings = []
        for it in root.findall("interlinear-text"):
            texts += 1
            has_media = it.find("media-files") is not None
            for p in it.iter("paragraph"):
                paras += 1
                for ph in p.iter("phrase"):
                    phrases += 1
                    txt = next((i.text or "" for i in ph.findall("item") if i.get("type") == "txt"), "")
                    if ph.get("begin-time-offset") is not None and (not has_media or ph.get("media-file") is None):
                        warnings.append({"code": "timesWithoutMedia", "phrase": ph.get("guid"), "note": "FLEx's importer drops these times [verified]"})
                    if not any(is_word_forming(c) for c in txt):
                        warnings.append({"code": "noWordChar", "phrase": ph.get("guid")})
                    core = txt.rstrip()
                    if any(c in EOS_CHARS and c != "." and any(is_word_forming(x) for x in core[i + 1:]) for i, c in enumerate(core[:-1])):
                        warnings.append({"code": "internalEos", "phrase": ph.get("guid")})
        if texts == 0:
            raise FlexError("E_IMPORT_INVALID", "the file holds no interlinear text", {})
        warnings.append({"code": "analysisIdentity", "note": "FLEx's importer does not keep analysis identity: glossed words get new analyses and glosses [verified]"})
        token = secrets.token_hex(16)
        self.previews[token] = {"import": path, "expires": time.time() + PREVIEW_TTL, "texts": texts,
                                "classes": OP_CLASSES["import"], "warnings": warnings}
        return {"previewToken": token, "texts": texts, "paras": paras, "phrases": phrases, "warnings": warnings, "blockers": []}

    def import_flextext(self, token, progress=None):
        self.guard()
        pv = self.previews.pop(token, None)
        if not pv or "import" not in pv or pv["expires"] < time.time():
            raise FlexError("E_PREVIEW_EXPIRED", "the import preview expired", {})
        if self.copy_only:
            from . import copyonly
            copyonly.check_write_allowed(self.port.project_dir(), self.name, True)
        backup = self.ensure_backup(progress)
        if progress:
            progress("Importing…")
        counts_before = self.port.counts()
        actions_before = self.port.undo_item_count()
        texts_before = {t["guid"] for t in self.port.list_texts()}
        agent_before = self.port.user_agent() or {}
        label = "Undo Import .flextext"
        SAVE.info("import: begin unit of work (FLEx history items before: %d)", actions_before)
        h = self.port.begin_uow(label, "Redo Import .flextext")
        try:
            new = self.port.import_flextext(pv["import"])
            if len(new) != pv["texts"]:
                raise FlexError("E_INVARIANT", "the importer created %d texts, the file holds %d" % (len(new), pv["texts"]), {})
            after = self.port.counts()
            for cls in NEVER_CHANGE:
                if after[cls] != counts_before[cls]:
                    raise FlexError("E_INVARIANT", "%s count changed on import" % cls, {})
            for g in new:
                for p in self.port.read_text(g)["paragraphs"]:
                    if not S.check_invariant(self.port, p):
                        raise FlexError("E_INVARIANT", "an imported paragraph fails the segmentation invariant", {"para": p["guid"]})
            evaluations_made = self._evaluations_made(agent_before, True)   # FLEx's importer may approve what it glosses
            self.port.commit(h)
        except Exception as e:   # noqa: BLE001
            err = e if isinstance(e, FlexError) else FlexError("E_IMPORT_INVALID", "import failed: %s" % e, {})
            try:
                SAVE.warning("import rolling back: %s — %s%s", err.code, err.message,
                             ("\n" + trace.exc_text(e)) if not isinstance(e, FlexError) else (" | detail " + trace.short(err.detail, 2000)))
            except Exception:   # noqa: BLE001
                pass
            if self.port.depth() > 0:
                self.port.rollback(h)
            if self.port.counts() != counts_before or {t["guid"] for t in self.port.list_texts()} != texts_before:
                self._poison(FlexError("E_ROLLBACK_INCOMPLETE", "a rolled-back import left objects behind", {}))
                raise self.poisoned
            raise err
        items_after = self.port.undo_item_count()
        SAVE.info("import committed: FLEx history items %d → %d, top item %r", actions_before, items_after, self.port.last_undo_text())
        if items_after != actions_before + 1:
            self._poison(FlexError("E_INVARIANT", "import did not produce exactly one history item (items %d → %d)" % (actions_before, items_after),
                                   {"itemsBefore": actions_before, "itemsAfter": items_after}))
            raise self.poisoned
        after = self.port.counts()
        deltas = {c: after[c] - counts_before[c] for c in COUNTED_CLASSES if after[c] != counts_before[c]}
        allowed = {"classes": set(OP_CLASSES["import"]), "touchedOwners": set(new), "countDeltas": deltas,
                   "referencedFrom": set().union(*(self._referenced_from(g) for g in new)) if new else set()}
        if evaluations_made:
            allowed["classes"] |= {"CmAgent", "CmAgentEvaluation"}
            allowed["touchedOwners"].add(agent_before["guid"])
            allowed["countDeltas"]["CmAgentEvaluation"] = evaluations_made
        disk = self._save_and_check(progress, allowed)
        self.history.append({"text": new[0] if new else None, "fpBefore": {}, "fpAfter": {}, "allowed": allowed, "label": label,
                             "countsBefore": counts_before, "countsAfter": after, "import": True})
        self.backup_ok = None
        return {"newTextGuids": new, "backup": backup, "disk": disk}

    # ---- §9.2 export ---------------------------------------------------------------------------
    def export_editor_bundle(self, text_guid, out_dir, media_paths=None):
        """`media_paths` = {uriGuid: path} the user resolved in the shell for links that point
        nowhere here (plan §8.4): the bundle carries the recording the app actually uses."""
        self.guard()
        t = self.port.read_text(text_guid)
        lf = self.port.linked_files_dir()
        media_paths = media_paths or {}
        xml = self.port.export_elan(text_guid)
        safe = "".join(c if c.isalnum() or c in " -_." else "_" for c in (t["title"] or "text")).strip() or "text"
        os.makedirs(out_dir, exist_ok=True)
        zip_path = os.path.join(out_dir, safe + ".zip")
        missing = []
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(safe + ".flextext", xml)
            for m in t["media"]:
                here = mediafind.link_path(m["uri"], lf)
                if not (here and os.path.isfile(here)):
                    here = media_paths.get(m["guid"])
                if here and os.path.isfile(here):
                    z.write(here, os.path.basename(here))
                else:
                    missing.append(m["guid"])
            if missing:
                z.writestr("MISSING-AUDIO.txt", "The following media links point at files not on this machine:\n" + "\n".join(missing))
        return {"zipPath": zip_path, "missingMedia": missing}

    # ---- §5.7 close ------------------------------------------------------------------------------
    def close(self):
        if self.poisoned or self.closed:
            self.closed = True
            return {"saved": False, "poisoned": bool(self.poisoned)}
        if self.port.has_unsaved_changes():
            # should never happen: every write goes through W7
            allowed = {"classes": set(), "touchedOwners": set(), "countDeltas": {}}
            self._save_and_check(None, allowed)
        self.port.close_without_save()
        self.closed = True
        return {"saved": False}
