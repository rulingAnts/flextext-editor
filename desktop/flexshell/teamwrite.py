"""Writing to the TEAM'S project — not a disposable copy (Seth, 2026-10-18: "Instead of only writing to a
throwaway copy, what should happen is it should write a throwaway copy as a backup with a 'reverse/recover'
button if the database turns out to be broken. Have it remind the user to send and receive and confirm that
they have BEFORE it starts the attempted write operation … make a throwaway snapshot copy of their database
(not the backup/restore function) and then if the user says 'RECOVER!', ask them to confirm that they did a
send/receive before the changes and haven't done anything else since.").

Every protection a save already has stays in front of this: the lock check, FLEx's own verified backup
zip, one unit of work, the disk read-back, Undo Save to FLEx. This module adds what a shared project needs
around them, and verifies instead of asking wherever the filesystem can answer:

- `send_receive_info(folder)`: whether the project is under Send/Receive (a `.hg` store) and when it last
  moved — shown in the before-write checklist as "Last Send/Receive: N minutes ago", so a "yes, I did"
  from habit has a number beside it.
- `take_snapshot(...)`: a verbatim copy of the `.fwdata` — the ONE file a save writes — into the shell's
  own data folder (never inside the project folder, which Send/Receive and FLEx's backups both walk),
  with its hash and the Send/Receive store's state, taken once per write session before anything is
  written. Not FLEx's backup/restore: putting a file back verbatim needs no Restore dialog and no FLEx.
- `recover(...)`: puts that file back. It REFUSES when the Send/Receive store changed since the snapshot:
  the written data has then already gone to the team, and an old `.fwdata` put back would make the next
  Send/Receive revert the team's changes too (Chorus commits the file as it finds it). It WARNS when the
  `.fwdata` changed after this shell's last save (FLEx edits since): recovery discards them. The current
  file is set aside, never deleted. So the order after a save is: open in FLEx and check first, Send/Receive
  second — RECOVER is only clean between the two.

Pure filesystem; every function is a function of a project folder and the shell's state folder, so each
is unit-testable on synthetic folders (desktop/tests/test_teamwrite.py)."""

import hashlib
import json
import os
import shutil
import subprocess
import time

from .errors import FlexError

SNAPSHOTS = "snapshots"
KEEP = 8                        # snapshots kept per project (one per write since 2026-10-18); older ones go
HG_LOG_N = 25                   # Send/Receive commits recorded with a snapshot, for FLEx support if a project ever needs repair
# what a Send/Receive touches in the Mercurial store: a changeset arriving or leaving rewrites these
HG_FILES = ("store/00changelog.i", "store/00manifest.i", "dirstate", "store/undo", "branch", "undo.dirstate")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _stat(path):
    st = os.stat(path)
    return {"size": st.st_size, "mtimeNs": st.st_mtime_ns}


def hg_state(folder):
    """{present, lastActivity (epoch ms) | None, sig: {relpath: [size, mtime_ns]}} of the project's `.hg`.
    `sig` is what a later Send/Receive changes; `lastActivity` is the newest of those files."""
    hg = os.path.join(folder, ".hg")
    if not os.path.isdir(hg):
        return {"present": False, "lastActivity": None, "sig": {}}
    sig, newest = {}, None
    for rel in HG_FILES:
        p = os.path.join(hg, *rel.split("/"))
        if os.path.isfile(p):
            st = _stat(p)
            sig[rel] = [st["size"], st["mtimeNs"]]
            newest = max(newest or 0, st["mtimeNs"])
    try:
        newest = max(newest or 0, os.stat(hg).st_mtime_ns)
    except OSError:
        pass
    return {"present": True, "lastActivity": (newest // 1_000_000) if newest else None, "sig": sig}


_REGISTRY = object()


def find_hg(code_dir=None, bridge_dir=_REGISTRY):
    """The Mercurial FLEx's own Send/Receive runs on this store: FLEx Bridge's (`<InstallationDir>\\mercurial\\hg.exe`,
    from the registry), else one under FieldWorks' own folder. None when neither is there — the log is then simply
    not recorded.

    ⚠ NEVER an `hg` from PATH (VM, 2026-10-21). FieldWorks 9 ships no Mercurial of its own (`<RootCodeDir>\\Mercurial`
    does not exist); the `hg` on PATH there was the user's own TortoiseHg — a different, newer Mercurial, with its own
    config and extensions. Even `hg log` can write cache files inside `.hg`, and anything a different Mercurial writes
    into the team's store is a risk to the next Send/Receive. Only FLEx Bridge's own copy touches it."""
    from . import fwfind
    bd = fwfind.flexbridge_dir() if bridge_dir is _REGISTRY else bridge_dir
    cands = []
    if bd:
        cands.append(os.path.join(bd, "mercurial", "hg.exe"))
    if code_dir:
        cands.append(os.path.join(code_dir, "Mercurial", "hg.exe"))
    for c in cands:
        if os.path.isfile(c):
            return c
    return None


def hg_config_path(hg):
    """HGRCPATH for `hg`: ONLY the config shipped beside it — FLEx Bridge's `mercurial.ini` (its extensions, SIL's
    fixutf8 among them) and `default.d` — never the user's own `%USERPROFILE%\\mercurial.ini`, which TortoiseHg's
    settings dialog writes and FLEx Bridge's hg.exe would otherwise read too. The repository's own `.hg\\hgrc` is
    read whatever this says, as it is for FLEx Bridge. Empty (no config files at all) when nothing is there."""
    d = os.path.dirname(os.path.abspath(hg))
    parts = [p for p in (os.path.join(d, "mercurial.ini"), os.path.join(d, "default.d")) if os.path.exists(p)]
    return os.pathsep.join(parts)


def hg_log(folder, code_dir=None, n=HG_LOG_N, hg=None):
    """The project's Send/Receive history, newest first: [{id, date, user, desc}] — Seth, 2026-10-18: "if our app can
    keep track of mercurial/Chorus edit commits/dates/times/IDs, that might help us have helpful data to report to
    FLEx support if we need to recover a thoroughly broken project." Best effort: [] whenever hg is missing, slow, or
    the folder is not a repository. Never raises."""
    hg = hg or find_hg(code_dir)
    if not hg or not os.path.isdir(os.path.join(folder, ".hg")):
        return []
    env = dict(os.environ, HGPLAIN="1", HGENCODING="utf-8", HGRCPATH=hg_config_path(hg))
    try:
        r = subprocess.run([hg, "-R", folder, "log", "-l", str(n), "--template", "{node}\t{date|isodatesec}\t{author}\t{desc|firstline}\n"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20, env=env)
    except (OSError, subprocess.SubprocessError):
        return []
    if r.returncode != 0:
        return []
    out = []
    for line in r.stdout.splitlines():
        parts = line.split("\t", 3)
        if len(parts) == 4 and parts[0]:
            out.append({"id": parts[0], "date": parts[1], "user": parts[2], "desc": parts[3]})
    return out


def send_receive_info(folder, code_dir=None, log=None):
    st = hg_state(folder)
    log = hg_log(folder, code_dir) if log is None and st["present"] else (log or [])
    return {"present": st["present"], "lastActivity": st["lastActivity"], "tip": (log[0] if log else None), "log": log[:5]}


def snapshot_root(state_dir, name):
    return os.path.join(state_dir, SNAPSHOTS, name)


def _meta_path(d):
    return os.path.join(d, "meta.json")


def _read_meta(d):
    try:
        with open(_meta_path(d), "r", encoding="utf-8") as f:
            m = json.load(f)
        return m if isinstance(m, dict) and m.get("id") else None
    except (OSError, ValueError):
        return None


def _write_meta(d, meta):
    tmp = _meta_path(d) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
    os.replace(tmp, _meta_path(d))


def list_snapshots(state_dir, name):
    """Newest first. A folder without a readable meta.json or without its file is not a snapshot."""
    root = snapshot_root(state_dir, name)
    if not os.path.isdir(root):
        return []
    out = []
    for d in os.listdir(root):
        full = os.path.join(root, d)
        m = _read_meta(full)
        if m and os.path.isfile(os.path.join(full, m.get("file", ""))):
            m["dir"] = full
            out.append(m)
    out.sort(key=lambda m: m.get("takenAt", 0), reverse=True)
    return out


def latest_snapshot(state_dir, name):
    s = list_snapshots(state_dir, name)
    return s[0] if s else None


def summary(meta):
    """What the page is told about a snapshot: never a path (the shell's own folder is its business)."""
    if not meta:
        return None
    return {"id": meta["id"], "takenAt": meta["takenAt"], "saves": len(meta.get("saves", [])),
            "lastSaveAt": (meta["saves"][-1]["at"] if meta.get("saves") else None), "bytes": meta["fwdata"]["size"]}


def take_snapshot(state_dir, folder, name, now=None, code_dir=None):
    """Copy `<folder>/<name>.fwdata` into the shell's state folder, verified by hash, with the Send/Receive
    store's state beside it. Refuses (E_BACKUP_FAILED) rather than leaving a snapshot that is not the file:
    the write session that would follow is then refused too (api.open_project)."""
    fw = os.path.join(folder, name + ".fwdata")
    if not os.path.isfile(fw):
        raise FlexError("E_NOT_FOUND", "no .fwdata to snapshot", {"project": name})
    t = now or time.time()
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(t))
    root = snapshot_root(state_dir, name)
    d = os.path.join(root, stamp)
    n = 2
    while os.path.exists(d):
        d = os.path.join(root, "%s-%d" % (stamp, n))
        n += 1
    free = shutil.disk_usage(state_dir if os.path.isdir(state_dir) else os.path.dirname(os.path.abspath(state_dir)) or ".").free
    size = os.path.getsize(fw)
    if free < size * 1.2 + 64 * 1024 * 1024:
        raise FlexError("E_DISK_SPACE", "not enough free space for a snapshot of the project file", {"bytes": size})
    os.makedirs(d, exist_ok=True)
    try:
        before = sha256(fw)
        dst = os.path.join(d, name + ".fwdata")
        shutil.copy2(fw, dst)
        if sha256(dst) != before or sha256(fw) != before:   # the copy is the file, and the file did not move under us
            raise FlexError("E_BACKUP_FAILED", "the snapshot does not match the project file", {"project": name})
        hg = hg_state(folder)
        log = hg_log(folder, code_dir) if hg["present"] else []
        hg["tip"] = log[0]["id"] if log else None
        meta = {"id": os.path.basename(d), "project": name, "takenAt": int(t * 1000), "file": name + ".fwdata",
                "fwdata": {"sha256": before, **_stat(fw)}, "hg": hg, "hgLog": log, "saves": []}
        _write_meta(d, meta)
    except BaseException:
        shutil.rmtree(d, ignore_errors=True)
        raise
    for old in list_snapshots(state_dir, name)[KEEP:]:
        shutil.rmtree(old["dir"], ignore_errors=True)
    meta["dir"] = d
    return meta


def note_write(state_dir, name, snap_id, folder, what, text_guid=None):
    """After a write this shell made (a save, an undo, a redo, an import): the file's hash now, so recover
    can tell FLEx's own later edits from ours."""
    root = snapshot_root(state_dir, name)
    d = os.path.join(root, snap_id)
    meta = _read_meta(d)
    if not meta:
        return None
    fw = os.path.join(folder, name + ".fwdata")
    entry = {"at": int(time.time() * 1000), "what": what}
    if text_guid:
        entry["textGuid"] = text_guid
    if os.path.isfile(fw):
        entry["sha256"] = sha256(fw)
    meta.setdefault("saves", []).append(entry)
    _write_meta(d, meta)
    return meta


def recover_plan(state_dir, folder, name, lock, meta=None, snapshot_id=None, code_dir=None):
    """What RECOVER would do, and what stops it. `lock` is prechecks.read_lock's state. `snapshot_id` picks one of
    the project's snapshots (`snapshots` lists them all, newest first); the newest otherwise."""
    all_snaps = list_snapshots(state_dir, name)
    if meta is None:
        meta = next((m for m in all_snaps if m["id"] == snapshot_id), None) if snapshot_id else (all_snaps[0] if all_snaps else None)
    now_hg = hg_state(folder)
    log = hg_log(folder, code_dir) if now_hg["present"] else []
    out = {"project": name, "snapshot": summary(meta), "snapshots": [summary(m) for m in all_snaps], "refusal": None, "warnings": [],
           "hgChanged": False, "fwdataChangedSinceWrite": False, "alreadyThere": False,
           "sendReceive": send_receive_info(folder, code_dir, log), "hgLog": log[:5]}
    if not meta:
        out["refusal"] = "E_NO_SNAPSHOT"
        return out
    fw = os.path.join(folder, name + ".fwdata")
    tip_then, tip_now = meta["hg"].get("tip"), (log[0]["id"] if log else None)
    if meta["hg"].get("present") and (now_hg["sig"] != meta["hg"].get("sig") or (tip_then and tip_now and tip_then != tip_now)):
        out["hgChanged"] = True
        out["refusal"] = "E_RECOVER_SENT_RECEIVED"
    if lock in ("flex", "other", "busy"):
        out["refusal"] = out["refusal"] or ("E_FLEX_HOLDS_PROJECT" if lock == "flex" else "E_LOCKED_OTHER")
    if os.path.isfile(fw):
        now = sha256(fw)
        if now == meta["fwdata"]["sha256"]:
            out["alreadyThere"] = True
            out["refusal"] = out["refusal"] or "E_NO_SNAPSHOT"   # nothing to recover: the file IS the snapshot
        last = next((s.get("sha256") for s in reversed(meta.get("saves", [])) if s.get("sha256")), None)
        if last and now != last:
            out["fwdataChangedSinceWrite"] = True
            out["warnings"].append("fwdataChangedSinceWrite")
        if not meta.get("saves"):
            out["warnings"].append("nothingWrittenHere")
    return out


def recover(state_dir, folder, name, snap_id, lock, now=None, code_dir=None):
    """Put the snapshot's `.fwdata` back, verified by hash; the current file is set aside beside it as
    `<name>.fwdata.before-recover-<stamp>`, never deleted. Refuses as recover_plan says (the page asked
    the user with that plan in front of them; a refusal here is the world having changed since)."""
    metas = {m["id"]: m for m in list_snapshots(state_dir, name)}
    meta = metas.get(snap_id)
    if not meta:
        raise FlexError("E_NO_SNAPSHOT", "no such snapshot", {"project": name, "snapshot": snap_id})
    plan = recover_plan(state_dir, folder, name, lock, meta, code_dir=code_dir)
    if plan["refusal"] and not plan["alreadyThere"]:
        raise FlexError(plan["refusal"], {"E_RECOVER_SENT_RECEIVED": "a Send/Receive happened since the snapshot: the written data has gone to the team",
                                          "E_FLEX_HOLDS_PROJECT": "FieldWorks has this project open. Close FLEx first.",
                                          "E_LOCKED_OTHER": "another program holds this project"}.get(plan["refusal"], plan["refusal"]),
                        {"project": name, "snapshot": snap_id})
    if plan["alreadyThere"]:
        return {"restored": False, "alreadyThere": True, "snapshot": snap_id}
    fw = os.path.join(folder, name + ".fwdata")
    src = os.path.join(meta["dir"], meta["file"])
    if sha256(src) != meta["fwdata"]["sha256"]:
        raise FlexError("E_BACKUP_FAILED", "the snapshot file no longer matches its record", {"snapshot": snap_id})
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(now or time.time()))
    aside = None
    if os.path.isfile(fw):
        aside = fw + ".before-recover-" + stamp
        n = 2
        while os.path.exists(aside):
            aside = fw + ".before-recover-%s-%d" % (stamp, n)
            n += 1
        os.replace(fw, aside)
    try:
        shutil.copy2(src, fw)
        if sha256(fw) != meta["fwdata"]["sha256"]:
            raise FlexError("E_BACKUP_FAILED", "the recovered file does not match the snapshot", {"snapshot": snap_id})
    except BaseException:
        # put the set-aside file back: the project is never left without a .fwdata
        try:
            if os.path.exists(fw):
                os.remove(fw)
            if aside and os.path.exists(aside):
                os.replace(aside, fw)
        except OSError:
            pass
        raise
    # FLEx's own .tmp of a save that did not finish would read as a crashed save: it is from after the snapshot
    tmp = os.path.join(folder, name + ".tmp")
    if os.path.isfile(tmp):
        os.replace(tmp, tmp + ".before-recover-" + stamp)
    meta.setdefault("recovered", []).append({"at": int(time.time() * 1000), "setAside": os.path.basename(aside) if aside else None,
                                             "hgLog": plan.get("hgLog", [])})
    _write_meta(meta["dir"], {k: v for k, v in meta.items() if k != "dir"})
    return {"restored": True, "snapshot": snap_id, "setAside": aside}
