"""Copy first, read the copy. A LevelDB a browser holds open is being written to; parsing it in place
would race the writer and, worse, a careless reader could take its LOCK. So the storage folders this
tool needs — each suite origin's IndexedDB folder pair and the profile's Local Storage — are copied
into a temporary folder, LOCK files left behind, and that copy is what reader.py opens. A file the
OS would not let us copy (a sharing violation on Windows while Chrome runs) is recorded, not fatal:
the report says which files were missing so a short read is never mistaken for a complete one."""

import shutil
import tempfile
from pathlib import Path

from .profiles import OriginStorage, ProfileStore


def _copytree(src, dst, problems):
    src, dst = Path(src), Path(dst)
    dst.mkdir(parents=True, exist_ok=True)
    for p in sorted(src.rglob("*")):
        rel = p.relative_to(src)
        if p.is_dir():
            (dst / rel).mkdir(parents=True, exist_ok=True)
            continue
        if p.name == "LOCK":
            continue
        try:
            shutil.copy2(p, dst / rel)
        except OSError as e:
            problems.append({"file": str(p), "error": "%s: %s" % (type(e).__name__, e)})


def take(store: ProfileStore, workdir=None):
    """Copy the store's suite storage under `workdir` (a fresh temp folder by default). Returns a new
    ProfileStore whose paths point into the copy, plus the list of files that could not be copied."""
    base = Path(workdir) if workdir else Path(tempfile.mkdtemp(prefix="fxdiag-"))
    problems = []
    copy = ProfileStore(app=store.app, layout=store.layout, user_data_dir=store.user_data_dir, profile_dir=store.profile_dir,
                        profile_name=store.profile_name, web_apps=list(store.web_apps), notes=list(store.notes))
    for o in store.origins:
        lv = base / store.slug / "IndexedDB" / o.leveldb.name
        _copytree(o.leveldb, lv, problems)
        bl = None
        if o.blob is not None:
            bl = base / store.slug / "IndexedDB" / o.blob.name
            _copytree(o.blob, bl, problems)
        copy.origins.append(OriginStorage(origin=o.origin, host=o.host, leveldb=lv, blob=bl, app_hint=o.app_hint))
    if store.local_storage is not None:
        ls = base / store.slug / "Local Storage" / "leveldb"
        _copytree(store.local_storage, ls, problems)
        copy.local_storage = ls
    return copy, problems, base
