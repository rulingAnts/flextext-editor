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
import zipfile
import xml.etree.ElementTree as ET

from . import mediafind
from . import diskcheck, glosses, model, segmentation as S
from .errors import FlexError, POISONING
from .lcm_mock import EOS_CHARS, SECTION, is_word_forming, tokenize
from .port import COUNTED_CLASSES, NEVER_CHANGE, UNDO_SUCCESS, nfd

PREVIEW_TTL = 600.0
BACKUP_COMMENT = "FlexText Segmenter before save"

# plan §5.4 table: classes that may change per op
OP_CLASSES = {
    "ft.set": {"Segment"}, "lt.set": {"Segment"}, "times.set": {"Segment"},
    "phrase.split": {"StTxtPara", "Segment", "PunctuationForm"}, "phrase.join": {"StTxtPara", "Segment"},
    "phrase.moveBoundary": {"StTxtPara", "Segment"},
    "para.split": {"StTxtPara", "StText", "Segment"}, "para.join": {"StTxtPara", "StText", "Segment"},
    "phrase.toPara": {"StTxtPara", "StText", "Segment"}, "para.toPhrase": {"StTxtPara", "StText", "Segment"},
    "word.split": {"StTxtPara", "Segment", "WfiWordform"}, "word.insert": {"StTxtPara", "Segment", "WfiWordform"},
    "baseline.replace": {"StTxtPara", "Segment", "WfiWordform", "PunctuationForm"},
    # WfiWordform is CHANGED (never added) by a gloss write: a new trivial analysis is owned by the
    # wordform and FLEx sets wf.Checksum = 0 (plan §7.2 step 4), so the wordform's rt differs on disk
    "gloss.set": {"Segment", "WfiGloss", "WfiAnalysis", "WfiMorphBundle", "WfiWordform"},
    "media.relink": {"CmMediaURI"}, "media.attach": {"Text", "CmMediaContainer", "CmMediaURI", "Segment"},
    "import": {"Text", "StText", "StTxtPara", "Segment", "WfiWordform", "WfiAnalysis", "WfiGloss", "WfiMorphBundle",
               "PunctuationForm", "CmMediaContainer", "CmMediaURI"},
}
STRUCTURAL = ("para.toPhrase", "para.join", "phrase.toPara", "para.split", "phrase.join", "phrase.split",
              "phrase.moveBoundary", "word.split", "word.insert", "baseline.replace")


class _LogCapture(logging.Handler):
    def __init__(self, on_error):
        super().__init__()
        self.records = []
        self.on_error = on_error

    def emit(self, record):
        self.records.append(record)
        if record.levelno >= logging.ERROR:
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

    # ---- poison ------------------------------------------------------------------------------
    def _on_error_log(self, record):
        if not self.poisoned:
            self._poison(FlexError("E_SAVE_FAILED", "FLEx reported a problem: " + record.getMessage(), {"log": record.getMessage()}))

    def _poison(self, err):
        """§5.6: block every further call; dispose WITHOUT saving (never flexicon's CloseProject);
        keep the process alive to show the message."""
        if self.poisoned:
            return
        self.poisoned = err
        try:
            self.port.close_without_save()
        except Exception:   # noqa: BLE001
            pass
        self.closed = True

    def guard(self):
        if self.poisoned:
            raise FlexError("E_POISONED", "the project session is closed after a failed write: %s. Your last good file is "
                            "preserved%s; your edits are still in the editor." % (
                                self.poisoned.message, (" as " + self.failed_file) if self.failed_file else ""),
                            {"cause": self.poisoned.to_dict(), "failedFile": self.failed_file, "backup": self.backup_ok})
        if self.closed:
            raise FlexError("E_NOT_FOUND", "no project is open", {})

    # ---- reads --------------------------------------------------------------------------------
    def open_text(self, text_guid, media_urls=None):
        self.guard()
        t = self.port.read_text(text_guid)
        fp = model.fingerprint_text(t)
        rev = model.base_rev(t)
        self.texts[text_guid] = {"fp": fp, "baseRev": rev, "read": t}
        return {"doc": model.to_engine_doc(t, media_urls), "baseRev": rev}

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
        paras = {p["guid"]: p for p in t["paragraphs"]}
        segs = {s["guid"]: (p, s) for p in t["paragraphs"] for s in p["segments"]}
        summary, warnings, blockers = [], [], []
        touched_paras = set()
        deltas = {c: 0 for c in COUNTED_CLASSES}
        classes = set()
        allowed_ops = set(OP_CLASSES) - {"import"}
        if not isinstance(ops, list):
            raise FlexError("E_SCOPE", "ops must be a list", {})
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
                if not op.get("_alias"):
                    raise FlexError("E_SCOPE", "paragraph not in this text", {"para": pg})
            if pg in paras:
                touched_paras.add(pg)
                S.require_not_fragile(self.port, paras[pg])
            if sg is not None and sg not in segs and not op.get("newPhrase"):
                raise FlexError("E_SCOPE", "phrase not in this text", {"seg": sg})
            if kind in ("ft.set", "lt.set", "gloss.set") and op.get("ws") not in chosen:
                raise FlexError("E_SCOPE", "writing system is not one of the chosen analysis WSs", {"ws": op.get("ws")})
            if kind == "phrase.split":
                deltas["Segment"] += 1
                if not self.port.has_punct_form(SECTION):
                    deltas["PunctuationForm"] += 1
                summary.append({"kind": kind, "seg": sg})
            elif kind == "phrase.join":
                deltas["Segment"] -= 1
                summary.append({"kind": kind, "seg": sg})
            elif kind in ("para.split", "phrase.toPara"):
                deltas["StTxtPara"] += 1
                summary.append({"kind": kind, "para": pg})
            elif kind in ("para.join", "para.toPhrase"):
                deltas["StTxtPara"] -= 1
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
                    if not self.port.has_wordform(half):
                        deltas["WfiWordform"] += 1
                summary.append({"kind": kind, "word": form, "into": [form[:off], form[off:]]})
            elif kind == "word.insert":
                w = (op.get("text") or "").strip()
                if not w or any(c.isspace() for c in w) or not any(is_word_forming(c) for c in w):
                    raise FlexError("E_SCOPE", "a word to insert must be one word with a letter", {})
                if not self.port.has_wordform(w):
                    deltas["WfiWordform"] += 1
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
                    elif tk[2] not in old_forms and not self.port.has_wordform(tk[2]):
                        deltas["WfiWordform"] += 1
                        old_forms.add(tk[2])
                summary.append({"kind": kind, "before": old, "after": new})
            elif kind == "gloss.set":
                p, s = segs[sg]
                plan = glosses.plan_gloss(self.port, s, op["index"], chosen, op["ws"], op.get("value", ""))
                if plan.get("newAnalysis"):
                    deltas["WfiAnalysis"] += 1
                    deltas["WfiMorphBundle"] += 1
                if plan["outcome"] == "newGloss":
                    deltas["WfiGloss"] += 1
                summary.append({"kind": kind, "seg": sg, "index": op["index"], "outcome": plan["outcome"],
                                "otherUses": plan.get("otherUses", 0), "approves": plan.get("analysisGuid") is not None and not (plan.get("analysisGuid") and self.port.is_approved(plan["analysisGuid"]))})
            elif kind in ("ft.set", "lt.set"):
                p, s = segs[sg]
                cur = (s["ft"] if kind == "ft.set" else s["lt"]).get(op["ws"], "")
                if cur != (op.get("value") or ""):
                    summary.append({"kind": kind, "seg": sg, "ws": op["ws"], "before": cur, "after": op.get("value", "")})
            elif kind == "times.set":
                summary.append({"kind": kind, "seg": sg, "begin": op.get("begin"), "end": op.get("end")})
                if op.get("begin") is not None and not t["media"] and not any(o.get("op") == "media.attach" for o in ops):
                    warnings.append({"code": "timesWithoutMedia", "seg": sg,
                                     "note": "FLEx keeps and exports times only with a media link (plan §8.1)"})
            elif kind == "phrase.moveBoundary":
                summary.append({"kind": kind, "seg": sg})
        # post-state checks: empty phrases and internal EOS, per touched paragraph
        for pg, phrases in (post_state or {}).items():
            for ph in phrases:
                txt = ph.get("text") or ""
                if not any(is_word_forming(c) for c in txt):
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
        self.previews[token] = {
            "text": text_guid, "baseRev": base_rev, "ops": ops, "post": post_state or {}, "chosen": chosen,
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
        backup = self.ensure_backup(progress)
        if progress:
            progress("Writing…")
        if self.port.depth() != 0:
            raise FlexError("E_INTERNAL", "a unit of work is already open", {"depth": self.port.depth()})
        counts_before = self.port.counts()
        actions_before = self.port.undoable_action_count()
        undo_label = "Undo Save to FLEx (%d changes)" % pv["n"]
        redo_label = "Redo Save to FLEx (%d changes)" % pv["n"]
        alias = {}
        touched = set(pv["touched"])
        new_owners = set()
        h = self.port.begin_uow(undo_label, redo_label)
        try:
            self._apply_ops(text_guid, pv, alias, touched, new_owners)
            if progress:
                progress("Checking…")
            self._check_invariants(text_guid, pv, alias, touched, fp_before, counts_before)
            self.port.commit(h)
        except Exception as e:   # noqa: BLE001 — anything → rollback
            err = e if isinstance(e, FlexError) else FlexError("E_INVARIANT", "the write failed: %s" % e, {"type": type(e).__name__})
            try:
                if self.port.depth() > 0:
                    self.port.rollback(h)
            except Exception as e2:   # noqa: BLE001
                self._poison(FlexError("E_ROLLBACK_INCOMPLETE", "rollback itself failed: %s" % e2, {}))
                raise self.poisoned from e2
            # W6: everything back as it was?
            if self.port.depth() != 0 or self.port.undoable_action_count() != actions_before:
                self._poison(FlexError("E_ROLLBACK_INCOMPLETE", "the undo stack is not as before the write", {}))
                raise self.poisoned
            t_after = self.port.read_text(text_guid)
            if model.fingerprint_text(t_after) != fp_before or self.port.counts() != counts_before:
                self._poison(FlexError("E_ROLLBACK_INCOMPLETE", "a rolled-back write left the text changed", {}))
                raise self.poisoned
            raise err
        # W5 post-conditions
        if self.port.depth() != 0 or self.port.undoable_action_count() != actions_before + 1 or self.port.last_undo_text() != undo_label:
            self._poison(FlexError("E_INVARIANT", "the commit did not produce exactly one FLEx history item", {}))
            raise self.poisoned
        fp_after = model.fingerprint_text(self.port.read_text(text_guid))
        allowed = {"classes": set(pv["classes"]), "touchedOwners": {text_guid} | new_owners, "countDeltas": dict(pv["deltas"]),
                   "referencedFrom": self._referenced_from(text_guid)}
        disk = self._save_and_check(progress, allowed, expect_fields=self._expected_fields(pv, alias))
        entry = self.texts[text_guid]
        entry["fp"] = fp_after
        entry["baseRev"] = model.base_rev(self.port.read_text(text_guid))
        self.history.append({"text": text_guid, "fpBefore": fp_before, "fpAfter": fp_after, "allowed": allowed, "label": undo_label,
                             "countsBefore": counts_before, "countsAfter": self.port.counts()})
        self.redo_history.clear()
        self.backup_ok = None    # after a save the next save backs up again
        return {"undoLabel": undo_label, "backup": backup, "disk": disk, "newBaseRev": entry["baseRev"], "alias": alias,
                "saved": pv["n"]}

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
                exp.setdefault(sg, {})["FreeTranslation"] = nfd(op["value"])
        return exp

    def _apply_ops(self, text_guid, pv, alias, touched, new_owners):
        port = self.port
        ops = sorted(pv["ops"], key=lambda o: STRUCTURAL.index(o["op"]) if o["op"] in STRUCTURAL else len(STRUCTURAL))
        chosen = pv["chosen"]
        attached_uri = None
        for op in ops:
            kind = op["op"]
            pg = alias.get(op.get("paraGuid"), op.get("paraGuid"))
            sg = alias.get(op.get("segGuid"), op.get("segGuid"))
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
                S.paragraph_to_phrase(port, text_guid, pg)
            elif kind == "word.split":
                S.split_word(port, text_guid, pg, sg, op["index"], op["offset"])
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
                glosses.set_gloss(port, text_guid, pg, sg, op["index"], chosen, op["ws"], op.get("value", ""))
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

    def _check_invariants(self, text_guid, pv, alias, touched, fp_before, counts_before):
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
            actual = model.read_model_post_state(t, set(intended))
            problems = model.compare_post_state(intended, actual)
            if problems:
                raise FlexError("E_INVARIANT", "re-read differs from the intended result: " + "; ".join(problems[:5]), {"problems": problems})

    def _save_and_check(self, progress, allowed, expect_fields=None):
        """W7 + W8, shared by save and undo/redo. Poisons on failure."""
        port = self.port
        if progress:
            progress("Saving…")
        fw = port.fwdata_path()
        mtime_before = os.stat(fw).st_mtime_ns
        n_err = len([r for r in self.log.records if r.levelno >= logging.ERROR])
        try:
            port.save()
            port.complete_all_commits()
        except Exception as e:   # noqa: BLE001
            self._poison(FlexError("E_SAVE_FAILED", "Save threw: %s" % e, {}))
            raise self.poisoned from e
        if self.poisoned or len([r for r in self.log.records if r.levelno >= logging.ERROR]) > n_err:
            if not self.poisoned:
                self._poison(FlexError("E_SAVE_FAILED", "FLEx logged an error while saving", {}))
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
        problems = diskcheck.check(d, a, diskcheck.load_rt(fw))
        if problems:
            self._poison(FlexError("E_DISK_CHECK_FAILED", "the file on disk changed in ways the preview did not allow",
                                   {"problems": problems[:20]}))
            self._w9(fw)
            raise self.poisoned
        changed = {}
        for g, (o, n) in d["changed"].items():
            if n["cls"] in diskcheck.DATE_ONLY_OK and set(k for k in n["fields"] if o["fields"].get(k) != n["fields"].get(k)) <= {"DateModified"}:
                continue   # the DateModified stamps every save makes: not a change worth reporting
            changed[n["cls"]] = changed.get(n["cls"], 0) + 1
        for g, n in d["added"].items():
            changed[n["cls"]] = changed.get(n["cls"], 0) + 1
        for g, o in d["removed"].items():
            changed[o["cls"]] = changed.get(o["cls"], 0) + 1
        return {"ok": True, "changed": changed, "facts": facts}

    def _w9(self, fw):
        """Preserve the file that failed the check (never delete); the user chooses .bak or the backup."""
        try:
            stamp = time.strftime("%Y%m%d-%H%M%S")
            failed = fw + ".failed-" + stamp
            if os.path.exists(fw):
                os.rename(fw, failed)
                self.failed_file = failed
        except OSError:
            pass

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
        actions_before = self.port.undoable_action_count()
        texts_before = {t["guid"] for t in self.port.list_texts()}
        label = "Undo Import .flextext"
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
            self.port.commit(h)
        except Exception as e:   # noqa: BLE001
            err = e if isinstance(e, FlexError) else FlexError("E_IMPORT_INVALID", "import failed: %s" % e, {})
            if self.port.depth() > 0:
                self.port.rollback(h)
            if self.port.counts() != counts_before or {t["guid"] for t in self.port.list_texts()} != texts_before:
                self._poison(FlexError("E_ROLLBACK_INCOMPLETE", "a rolled-back import left objects behind", {}))
                raise self.poisoned
            raise err
        if self.port.undoable_action_count() != actions_before + 1:
            self._poison(FlexError("E_INVARIANT", "import did not produce exactly one history item", {}))
            raise self.poisoned
        after = self.port.counts()
        deltas = {c: after[c] - counts_before[c] for c in COUNTED_CLASSES if after[c] != counts_before[c]}
        allowed = {"classes": set(OP_CLASSES["import"]), "touchedOwners": set(new), "countDeltas": deltas,
                   "referencedFrom": set().union(*(self._referenced_from(g) for g in new)) if new else set()}
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
