"""Copy-only dev builds (plan §12.3). Until Seth signs off on the VM results, every build refuses
write mode unless the project folder carries the disposable-copy marker — and the flag is read the
way electron/src/flags.js reads its DevTools flag: anything but an explicit release stamp means
copy-only. Fail closed."""

import json
import os
import shutil
import time

MARKER_FILE = "flextext-disposable-copy.txt"
STAMP_FILE = "release-stamp.json"
# Names a copy may never carry: a project with one of these names is treated as production even
# with a marker file beside it (someone copied the marker, not the project).
PROTECTED_NAMES = frozenset()   # filled per deployment from settings; the default protects nothing by name


def is_copy_only(stamp_dir=None):
    """True unless `<stamp_dir>/release-stamp.json` holds exactly {"copyOnlyLifted": true}."""
    if not stamp_dir:
        return True
    p = os.path.join(stamp_dir, STAMP_FILE)
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return True
    return not (isinstance(data, dict) and data.get("copyOnlyLifted") is True and len(data) == 1)


def project_is_disposable_copy(project_dir, project_name=None, protected=PROTECTED_NAMES):
    if project_name and project_name in protected:
        return False
    try:
        return os.path.isfile(os.path.join(project_dir, MARKER_FILE))
    except OSError:
        return False


def check_write_allowed(project_dir, project_name, copy_only):
    """Raises FlexError('E_COPY_ONLY') when a copy-only build is asked to write to a project that is
    not a marked disposable copy."""
    from .errors import FlexError
    if copy_only and not project_is_disposable_copy(project_dir, project_name):
        raise FlexError("E_COPY_ONLY",
                        "This build writes only to a disposable copy. Make one with FLEx closed (copy "
                        "the project folder, rename the .fwdata to match, add %s) and open that." % MARKER_FILE,
                        {"marker": MARKER_FILE})


# ---- Make a copy to write to (plan §12.3) ------------------------------------------------------------
# Seth, 2026-10-16: "So far audio segmenter can't write at all yet. Now's the time to start changing
# that." This build writes only to a marked copy, and one made by hand (copy the folder with FLEx closed,
# rename the .fwdata to match, add the marker) is easy to get wrong in a way that matters: it carries the
# project's Send/Receive repository, so a Send/Receive from the copy could send test writes to the team's
# shared project. The copy made here leaves Send/Receive behind.
COPY_SUFFIX = " - copy for writing"
LEAVE_DIRS = frozenset({".hg", "OtherRepositories"})        # Send/Receive: the project's and the LIFT bridge's
LEAVE_SUFFIXES = (".lock", ".tmp", ".ChorusNotes")           # a lock, a save in progress, Send/Receive notes


def copy_name(projects_dir, name):
    """The copy's name, beside the original: '<name> - copy for writing', then ' 2', ' 3'…"""
    base = name + COPY_SUFFIX
    cand, n = base, 2
    while os.path.exists(os.path.join(projects_dir, cand)) or os.path.exists(os.path.join(projects_dir, cand + ".partial")):
        cand, n = "%s %d" % (base, n), n + 1
    return cand


def _files_to_copy(src, name):
    files, total = [], 0
    for root, dirs, fnames in os.walk(src):
        dirs[:] = sorted(d for d in dirs if d not in LEAVE_DIRS)
        rel_root = os.path.relpath(root, src)
        for f in sorted(fnames):
            if f.endswith(LEAVE_SUFFIXES) or f == ".hgignore" or f == MARKER_FILE:
                continue
            if rel_root == "." and f == name + ".bak":   # FLEx's copy of the save before last: not the project
                continue
            p = os.path.join(root, f)
            files.append((p, os.path.normpath(os.path.join(rel_root, f))))
            total += os.path.getsize(p)
    return files, total


def copy_plan(projects_dir, name):
    """What a copy of `name` would be — its name, files, bytes (Send/Receive left out) and the free space
    where it would go. Reads only."""
    files, total = _files_to_copy(os.path.join(projects_dir, name), name)
    return {"name": copy_name(projects_dir, name), "files": len(files), "bytes": total,
            "free": shutil.disk_usage(projects_dir).free}


def make_disposable_copy(projects_dir, name, new_name, progress=None, today=None):
    """Copy the project folder to `new_name` beside it — into `<new_name>.partial` first, renamed when
    complete, so a copy cut short never looks like a project — renaming `<name>.*` at its top to
    `<new_name>.*` (FLEx finds a project by its folder and its .fwdata sharing one name), and mark it.
    The original is only read. → {name}"""
    from .errors import FlexError
    src = os.path.join(projects_dir, name)
    dst = os.path.join(projects_dir, new_name)
    tmp = dst + ".partial"
    files, total = _files_to_copy(src, name)
    if shutil.disk_usage(projects_dir).free < total * 1.1 + 64 * 1024 * 1024:
        raise FlexError("E_DISK_SPACE", "not enough free space for the copy", {"bytes": total})
    if os.path.exists(dst) or os.path.exists(tmp):
        raise FlexError("E_SCOPE", "a folder of that name is already there", {"name": new_name})
    try:
        for i, (path, rel) in enumerate(files):
            out = rel
            if os.path.dirname(rel) in ("", ".") and rel.startswith(name + "."):
                out = new_name + rel[len(name):]
            q = os.path.join(tmp, out)
            os.makedirs(os.path.dirname(q), exist_ok=True)
            shutil.copy2(path, q)
            if progress:
                progress({"i": i + 1, "n": len(files)})
        with open(os.path.join(tmp, MARKER_FILE), "w", encoding="utf-8") as f:
            f.write("A disposable copy of the FLEx project \"%s\", made %s by the FlexText Segmenter shell to test "
                    "writing to FLEx. Its Send/Receive repository was left behind: do not set up Send/Receive on "
                    "this copy. Delete this folder when you are done with it.\n" % (name, today or time.strftime("%Y-%m-%d")))
        os.rename(tmp, dst)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return {"name": new_name}
