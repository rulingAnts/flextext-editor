"""Firefox and its relatives (Firefox, ESR, Developer Edition, LibreWolf, Waterfox): Gecko keeps storage
per ORIGIN under <profile>/storage/default/<scheme+++host[+port]>/ — `idb/<n>.sqlite` (+ `<n>.files/`) per
IndexedDB database, `ls/data.sqlite` for localStorage (LSNG) — and, before LSNG, one profile-wide
`webappsstore.sqlite`. Values are SQLite rows: IndexedDB `object_data.data` is Snappy-compressed
SpiderMonkey structured-clone; localStorage `data.value` is Snappy-compressed when `compression_type`
is 1. Profiles are listed in `profiles.ini`.

The codecs are moz-idb-edit's (Erin Yuki Schlarb, MPL-2.0; `mozidbedit.mozserial` the structured-clone
reader, `.mozsnappy` the Snappy decoder, `.mozidb.KeyCodec` the key encoding) — a git dependency, it is
not on PyPI. The SQL is ours, because its reader assumes one object store per database and the editor's
has two. A DOM Blob inside a record is not a SpiderMonkey type; when the decoder cannot read a value and
the row names files in `<n>.files/`, the row is reported as a blob with the files' sizes.

⚠ [unverified] on a real Firefox profile: no Firefox could be run where this was written. Discovery and
the localStorage reader are tested on synthetic layouts only; the IndexedDB reader's test runs only when
tests/fixtures/firefox-fixture.zip exists (make one with tests/make_profile.mjs and Playwright's Firefox
on a machine that has it). Read the console's `gecko` lines on the first real run.
"""

import configparser
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

from . import suite

ORIGIN_RE = re.compile(r"^(https?|file)\+\+\+([^+^]+)(?:\+(\d+))?(?:\^.*)?$")   # ^userContextId=… and other attrs stripped


def parse_origin_dir(name):
    """`https+++app.flextext.app` → ('https', 'app.flextext.app', None); `http+++localhost+8012` → port '8012'."""
    m = ORIGIN_RE.match(name)
    return (m.group(1), m.group(2), m.group(3)) if m else None


def candidate_roots(home, platform):
    """[(app, folder holding profiles.ini)] that exist for this OS."""
    home = Path(home)
    if platform == "win32":
        ra = Path(os.environ.get("APPDATA") or (home / "AppData" / "Roaming")) if home == Path(os.path.expanduser("~")) else home / "AppData" / "Roaming"
        cands = [("Firefox", ra / "Mozilla" / "Firefox"), ("LibreWolf", ra / "librewolf"), ("Waterfox", ra / "Waterfox")]
    elif platform == "darwin":
        asup = home / "Library" / "Application Support"
        cands = [("Firefox", asup / "Firefox"), ("LibreWolf", asup / "librewolf"), ("Waterfox", asup / "Waterfox")]
    else:
        cands = [("Firefox", home / ".mozilla" / "firefox"), ("Firefox (snap)", home / "snap" / "firefox" / "common" / ".mozilla" / "firefox"),
                 ("Firefox (flatpak)", home / ".var" / "app" / "org.mozilla.firefox" / ".mozilla" / "firefox"),
                 ("LibreWolf", home / ".librewolf"), ("Waterfox", home / ".waterfox")]
    return [(app, p) for app, p in cands if (p / "profiles.ini").is_file() or (p / "Profiles").is_dir()]


def profiles_in(root):
    """[(profile_dir, name)] from profiles.ini (Path= relative unless IsRelative=0); folders under
    Profiles/ that the ini does not name are listed too, by folder name."""
    root = Path(root)
    out, seen = [], set()
    ini = root / "profiles.ini"
    if ini.is_file():
        cp = configparser.RawConfigParser()
        try:
            cp.read(ini, encoding="utf-8")
            for sec in cp.sections():
                if not sec.lower().startswith("profile") or not cp.has_option(sec, "Path"):
                    continue
                raw = cp.get(sec, "Path")
                rel = cp.get(sec, "IsRelative", fallback="1") != "0"
                p = (root / raw) if rel else Path(raw)
                if p.is_dir() and str(p.resolve()) not in seen:
                    seen.add(str(p.resolve()))
                    out.append((p, cp.get(sec, "Name", fallback=p.name)))
        except (configparser.Error, OSError):
            pass
    prof = root / "Profiles"
    if prof.is_dir():
        for p in sorted(prof.iterdir()):
            if p.is_dir() and str(p.resolve()) not in seen and ((p / "storage").is_dir() or (p / "prefs.js").is_file()):
                seen.add(str(p.resolve()))
                out.append((p, p.name))
    return out


def suite_origins(profile_dir):
    """[(origin_url, host, origin_dir)] under storage/default whose host is the suite's."""
    base = Path(profile_dir) / "storage" / "default"
    out = []
    if not base.is_dir():
        return out
    for d in sorted(base.iterdir()):
        parsed = parse_origin_dir(d.name)
        if not parsed or not d.is_dir():
            continue
        scheme, host, port = parsed
        if suite.is_suite_host(host):
            out.append((suite.origin_url(scheme, host, port or "0"), host, d))
    return out


# ---- decoding ------------------------------------------------------------------------------------

def _codecs():
    try:
        from mozidbedit import mozidb, mozserial, mozsnappy
    except ImportError as e:   # pragma: no cover
        raise ImportError("moz-idb-edit is not installed (pip install flextext-fxdiag installs it; it needs git): %s" % e) from e
    return mozidb, mozserial, mozsnappy


def _decode_value(data, file_ids, files_dir, mozserial, mozsnappy):
    """Python value, or None with a reason, for one object_data row."""
    import io
    try:
        if file_ids and str(file_ids).startswith("."):          # the structured clone itself lives in a file
            with open(Path(files_dir) / str(file_ids)[1:], "rb") as f:
                return mozserial.Reader(io.BufferedReader(mozsnappy.Decompressor(f))).read(), None
        raw = bytes(mozsnappy.decompress_raw(data)) if data else b""   # cramjam Buffer → bytes
        return mozserial.Reader(io.BufferedReader(io.BytesIO(raw))).read(), None
    except Exception as e:   # noqa: BLE001 — a DOM Blob, a newer tag, a damaged row: reported, never fatal
        return None, "%s: %s" % (type(e).__name__, str(e)[:160])


def _files_for(file_ids, files_dir):
    out = []
    for tok in str(file_ids or "").split():
        p = Path(files_dir) / tok.lstrip(".")
        try:
            out.append({"id": tok, "size": p.stat().st_size if p.is_file() else None})
        except OSError:
            out.append({"id": tok, "size": None})
    return out


def read_idb_folder(idb_dir):
    """{dbName: {"stores": {storeName: {"count", "records": [(key, value|None, meta)]}}}} for every suite
    database in <origin>/idb/. Raw records; reader.py shapes them like the Chromium ones."""
    mozidb, mozserial, mozsnappy = _codecs()
    out, problems = {}, []
    idb_dir = Path(idb_dir)
    if not idb_dir.is_dir():
        return out, problems
    for sq in sorted(idb_dir.glob("*.sqlite")):
        try:
            con = sqlite3.connect("file:%s?mode=ro&immutable=1" % sq.as_posix(), uri=True)
        except sqlite3.Error as e:
            problems.append("%s: cannot open: %s" % (sq.name, e))
            continue
        try:
            name = con.execute("SELECT name FROM database").fetchone()
            name = name[0] if name else None
            if not name or not suite.is_suite_db(name):
                continue
            stores = {r[0]: r[1] for r in con.execute("SELECT id, name FROM object_store")}
            db = {"stores": {}}
            files_dir = sq.with_suffix(".files")
            for sid, sname in stores.items():
                recs = []
                for key, data, file_ids in con.execute("SELECT key, data, file_ids FROM object_data WHERE object_store_id=?", (sid,)):
                    try:
                        k = mozidb.KeyCodec.decode(key)
                    except Exception as e:   # noqa: BLE001
                        k = "<undecoded key: %s>" % e
                    value, why = _decode_value(data, file_ids, files_dir, mozserial, mozsnappy)
                    recs.append((k, value, {"why": why, "files": _files_for(file_ids, files_dir) if file_ids else []}))
                db["stores"][sname] = {"count": len(recs), "records": recs}
            out[name] = db
        except sqlite3.Error as e:
            problems.append("%s: %s" % (sq.name, e))
        finally:
            con.close()
    return out, problems


def read_local_storage(origin_dir):
    """{key: value} from <origin>/ls/data.sqlite (LSNG). Snappy when compression_type == 1; the value is
    UTF-8 when utf16_length matches its decoded length, else UTF-16LE — Gecko stores the shorter form."""
    _, _, mozsnappy = _codecs()
    db = Path(origin_dir) / "ls" / "data.sqlite"
    out, problems = {}, []
    if not db.is_file():
        return out, problems
    try:
        con = sqlite3.connect("file:%s?mode=ro&immutable=1" % db.as_posix(), uri=True)
    except sqlite3.Error as e:
        return out, ["ls/data.sqlite: cannot open: %s" % e]
    try:
        cols = [r[1] for r in con.execute("PRAGMA table_info(data)")]
        has_comp, has_len = "compression_type" in cols, "utf16_length" in cols
        q = "SELECT key, value%s%s FROM data" % (", compression_type" if has_comp else "", ", utf16_length" if has_len else "")
        for row in con.execute(q):
            key, value = row[0], row[1]
            comp = row[2] if has_comp else 0
            u16 = row[3] if has_len else None
            try:
                raw = bytes(value) if isinstance(value, (bytes, bytearray, memoryview)) else str(value).encode("utf-8")
                if comp == 1:
                    raw = bytes(mozsnappy.decompress_raw(raw))   # cramjam hands back its own Buffer, not bytes
                text = raw.decode("utf-8") if (u16 is None or len(raw) == u16 or len(raw.decode("utf-8", "ignore")) == u16) else raw.decode("utf-16-le")
            except Exception as e:   # noqa: BLE001
                problems.append("ls key %r: %s" % (key, e))
                continue
            out[str(key)] = text
    except sqlite3.Error as e:
        problems.append("ls/data.sqlite: %s" % e)
    finally:
        con.close()
    return out, problems


def read_legacy_webappsstore(profile_dir, hosts):
    """Pre-LSNG localStorage: <profile>/webappsstore.sqlite, scope = reversed host + ':scheme:port'."""
    db = Path(profile_dir) / "webappsstore.sqlite"
    out = {}
    if not db.is_file():
        return out, []
    try:
        con = sqlite3.connect("file:%s?mode=ro&immutable=1" % db.as_posix(), uri=True)
    except sqlite3.Error as e:
        return out, ["webappsstore.sqlite: cannot open: %s" % e]
    try:
        for scope, key, value in con.execute("SELECT scope, key, value FROM webappsstore2"):
            parts = str(scope).split(":")
            host = parts[0][::-1].lstrip(".")
            scheme = parts[1] if len(parts) > 1 else "https"
            if host in hosts or suite.is_suite_host(host):
                out.setdefault("%s://%s" % (scheme, host), {})[str(key)] = str(value)
    except sqlite3.Error as e:
        return out, ["webappsstore.sqlite: %s" % e]
    finally:
        con.close()
    return out, []
