"""B — prechecks, pure filesystem, before any LCM call (plan §5.3). Every check is a function of a
project folder and a few facts about the machine, so each is unit-testable on synthetic folders.

`check_project(folder, name, mode, installed_model_version, ...)` → {writable, reasons[], lock, ...}
for list_projects; `require_write(...)` raises the FIRST blocking FlexError for open_project('write').
"""

import json
import os
import re
import xml.etree.ElementTree as ET

from .errors import FlexError

LOCK_FREE, LOCK_FLEX, LOCK_OTHER, LOCK_STALE, LOCK_BUSY = "free", "flex", "other", "stale", "busy"
CLOUD_MARKERS = ("onedrive", "icloud", "google drive", "googledrive", "dropbox", "my drive")
# A Parallels shared Mac folder appears under \\Mac\Home\… or as a mapped drive with that UNC behind it.
PARALLELS_MARKERS = ("\\\\mac\\", "/mac/home", "\\\\psf\\")


# ---- B1 lock -----------------------------------------------------------------------------------
def read_lock(folder, name, pid_alive=None, process_name=None):
    """→ (state, info). The lock is `<name>.fwdata.lock`, JSON with __type, PID, ProcessName,
    Timestamp (.NET ticks) [verified shape]. A sharing violation reading it is what an EXCLUSIVE
    holder looks like → 'busy' [verified]. `pid_alive(pid)` and `process_name(pid)` are injected
    (os-specific); defaults answer from this machine."""
    path = os.path.join(folder, name + ".fwdata.lock")
    if not os.path.exists(path):
        return LOCK_FREE, None
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()
    except PermissionError:
        return LOCK_BUSY, {"path": path}
    except OSError as e:
        if getattr(e, "winerror", None) in (32, 33):   # ERROR_SHARING_VIOLATION / LOCK_VIOLATION
            return LOCK_BUSY, {"path": path}
        return LOCK_BUSY, {"path": path, "error": str(e)}
    try:
        info = json.loads(raw) if raw.strip() else {}
    except ValueError:
        info = {"raw": raw[:200]}
    pid = info.get("PID")
    alive = (pid_alive or _pid_alive)(pid) if isinstance(pid, int) else False
    if not alive:
        return LOCK_STALE, info     # LCM takes a stale lock over [source; takeover unverified, V-8]
    pname = str(info.get("ProcessName") or ((process_name or (lambda p: ""))(pid)) or "")
    if re.search(r"fieldworks|flex", pname, re.I):
        return LOCK_FLEX, info
    return LOCK_OTHER, info


def _pid_alive(pid):
    try:
        if os.name == "nt":
            import ctypes
            k = ctypes.windll.kernel32   # type: ignore[attr-defined]
            h = k.OpenProcess(0x1000, False, int(pid))   # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                return False
            code = ctypes.c_ulong()
            ok = k.GetExitCodeProcess(h, ctypes.byref(code))
            k.CloseHandle(h)
            return bool(ok) and code.value == 259   # STILL_ACTIVE
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError):
        return False


# ---- B2 sharing ----------------------------------------------------------------------------------
def sharing_on(folder):
    """`SharedSettings\\LexiconSettings.plsx` with projectSharing="true" [verified]: the lock file
    is then NOT a reliable signal (later openers join as peers without touching it)."""
    p = os.path.join(folder, "SharedSettings", "LexiconSettings.plsx")
    if not os.path.isfile(p):
        return False
    try:
        root = ET.parse(p).getroot()
    except (ET.ParseError, OSError):
        return False
    return str(root.get("projectSharing", "")).lower() == "true"


# ---- B3 file state -------------------------------------------------------------------------------
def file_state(folder, name):
    fw = os.path.join(folder, name + ".fwdata")
    bak = os.path.join(folder, name + ".bak")
    tmp = os.path.join(folder, name + ".tmp")
    st = {"fwdata": os.path.isfile(fw), "bak": os.path.isfile(bak), "tmp": os.path.isfile(tmp), "readOnly": False}
    if st["fwdata"]:
        st["readOnly"] = not os.access(fw, os.W_OK)
        st["sizeBytes"] = os.path.getsize(fw)
    st["crashedSave"] = st["tmp"] or (st["bak"] and not st["fwdata"])
    return st


def on_cloud_folder(path):
    p = path.replace("/", "\\").lower()
    return any(m in p for m in CLOUD_MARKERS) or any(m in p for m in PARALLELS_MARKERS)


def on_local_fixed_drive(path, drive_type=None):
    """Windows: GetDriveTypeW == DRIVE_FIXED (3). Elsewhere: true unless the path is UNC/network-
    shaped. `drive_type` is injected in tests."""
    if drive_type is not None:
        return drive_type(path) == 3
    if os.name != "nt":
        return not path.startswith("\\\\")
    try:
        import ctypes
        drive = os.path.splitdrive(os.path.abspath(path))[0] + "\\"
        return ctypes.windll.kernel32.GetDriveTypeW(drive) == 3   # type: ignore[attr-defined]
    except Exception:   # noqa: BLE001
        return False


# ---- B4 model version ----------------------------------------------------------------------------
def header_version(fwdata_path):
    """`<languageproject version="N">` read from the first few KB — never the whole 25 MB file."""
    try:
        with open(fwdata_path, "rb") as f:
            head = f.read(4096).decode("utf-8", "replace")
    except OSError:
        return None
    m = re.search(r'<languageproject[^>]*\sversion="(\d+)"', head)
    return int(m.group(1)) if m else None


# ---- B5 disk space -------------------------------------------------------------------------------
def free_space(path):
    try:
        import shutil
        return shutil.disk_usage(path).free
    except OSError:
        return 0


# ---- the composite -------------------------------------------------------------------------------
def check_project(folder, name, installed_model_version, pid_alive=None, process_name=None,
                  drive_type=None, free=None, copy_only=False, marker_ok=None):
    """Everything list_projects reports and open_project('write') enforces. Never opens the project."""
    reasons = []
    st = file_state(folder, name)
    fw = os.path.join(folder, name + ".fwdata")
    lock, lockinfo = read_lock(folder, name, pid_alive, process_name)
    share = sharing_on(folder)
    hv = header_version(fw) if st["fwdata"] else None
    local = on_local_fixed_drive(folder, drive_type)
    cloud = on_cloud_folder(folder)
    space = (free or free_space)(folder) if st["fwdata"] else 0
    if not st["fwdata"]:
        reasons.append("E_CRASHED_SAVE_STATE" if st["bak"] else "E_NOT_FOUND")
    elif st["crashedSave"]:
        reasons.append("E_CRASHED_SAVE_STATE")
    if lock == LOCK_FLEX:
        reasons.append("E_FLEX_HOLDS_PROJECT")
    elif lock == LOCK_OTHER:
        reasons.append("E_LOCKED_OTHER")
    elif lock == LOCK_BUSY:
        reasons.append("E_LOCK_BUSY")
    if share:
        reasons.append("E_SHARING_ON")
    if st.get("readOnly"):
        reasons.append("E_READONLY_FILE")
    if not local:
        reasons.append("E_NOT_LOCAL_DISK")
    if cloud:
        reasons.append("E_CLOUD_FOLDER")
    if hv is not None and installed_model_version is not None:
        if hv > installed_model_version:
            reasons.append("E_MODEL_NEWER")
        elif hv < installed_model_version:
            reasons.append("E_MODEL_OLDER")
    if st["fwdata"] and space < 3 * st.get("sizeBytes", 0):
        reasons.append("E_DISK_SPACE")
    if copy_only and marker_ok is not None and not marker_ok:
        reasons.append("E_COPY_ONLY")
    return {"name": name, "sizeBytes": st.get("sizeBytes", 0), "headerVersion": hv, "sharing": share, "lock": lock,
            "lockInfo": {k: lockinfo.get(k) for k in ("PID", "ProcessName")} if isinstance(lockinfo, dict) else None,
            "crashedSave": bool(st["crashedSave"]), "localFixedDrive": local, "cloudSynced": cloud,
            "readOnlyFile": bool(st.get("readOnly")), "writable": not reasons, "reasons": reasons,
            # writable once the before-write checklist is confirmed (every reason is one it covers)
            "writableWithChecklist": all(r in CONFIRMABLE for r in reasons),
            # read mode is allowed with sharing on, and with a stale lock; everything else blocks it too
            "readable": st["fwdata"] and not st["crashedSave"] and lock not in (LOCK_FLEX, LOCK_OTHER, LOCK_BUSY)
                        and not any(r in reasons for r in ("E_MODEL_NEWER", "E_MODEL_OLDER"))}


MESSAGES = {
    "E_FLEX_HOLDS_PROJECT": "FieldWorks has this project open. Close FLEx first.",
    "E_LOCKED_OTHER": "Another program holds this project's lock file.",
    "E_LOCK_BUSY": "The project's lock file is held exclusively by another process.",
    "E_SHARING_ON": "Project sharing is on for this project. Turn it off in FLEx (Project Properties ▸ Sharing) before writing from here; reading is fine.",
    "E_CRASHED_SAVE_STATE": "A previous save did not finish (a .tmp or an orphan .bak is present). Open the project in FLEx to recover it; nothing is repaired automatically.",
    "E_READONLY_FILE": "The project file is read-only.",
    "E_NOT_LOCAL_DISK": "The project is not on a fixed local drive.",
    "E_CLOUD_FOLDER": "The project is inside a cloud-synced folder; a sync could rewrite it mid-save.",
    "E_MODEL_NEWER": "This project was saved by a newer FieldWorks. Open it in FLEx first.",
    "E_MODEL_OLDER": "This project needs data migration. Open it in FLEx first; the shell never migrates.",
    "E_DISK_SPACE": "Not enough free disk space (needs three times the project file size).",
    "E_NOT_FOUND": "No .fwdata file in this project folder.",
    "E_COPY_ONLY": "This build writes only to a marked disposable copy.",
}


# A reason the before-write checklist covers (teamwrite.py): sharing on means the lock file cannot tell whether
# FLEx or another program holds the project, so the user closes them and says so — and C4 (peers connected,
# checked once the project is open) still refuses when one is there after all.
CONFIRMABLE = frozenset({"E_SHARING_ON"})


def require_write(report, confirmed=()):
    for code in report["reasons"]:
        if code in CONFIRMABLE and code in confirmed:
            continue
        raise FlexError(code, MESSAGES.get(code, code), {"project": report["name"], "reasons": report["reasons"]})


def require_read(report):
    if not report["readable"]:
        for code in report["reasons"]:
            if code != "E_SHARING_ON":
                raise FlexError(code, MESSAGES.get(code, code), {"project": report["name"], "reasons": report["reasons"]})
        raise FlexError("E_NOT_FOUND", "the project cannot be opened", {"project": report["name"]})
