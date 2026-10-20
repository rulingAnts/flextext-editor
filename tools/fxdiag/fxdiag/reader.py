"""Decode a copied profile's suite storage with ccl_chromium_reader (CCL Solutions Group, MIT).

IndexedDB values are Blink-wrapped V8 serializations; a Blob in a record is an index into the
`.indexeddb.blob` folder beside the LevelDB. The library resolves both. We read only databases whose
name starts with `flextext` and only localStorage keys that do; for the editor's database the `docs`
records come back whole (they are the texts) and the `media` store is reduced to a manifest (key →
blob size and type, or the JSON size of a value such as waveform peaks). Other suite databases
(sync, files, crowd) are counted, with their keys — their values are not copied, since the sync store
is where the device's wrapped keys live.
"""

import json
from pathlib import Path

from . import suite


def _ccl():
    try:
        from ccl_chromium_reader import ccl_chromium_indexeddb, ccl_chromium_localstorage
        from ccl_chromium_reader.serialization_formats import ccl_blink_value_deserializer
    except ImportError as e:   # pragma: no cover — the dependency is declared; this names it when missing
        raise ImportError("ccl_chromium_reader is not installed (pip install flextext-fxdiag installs it; it needs git): %s" % e) from e
    return ccl_chromium_indexeddb, ccl_chromium_localstorage, ccl_blink_value_deserializer


def _json_size(v):
    try:
        return len(json.dumps(v, default=str, ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError):
        return None


def _key_value(k):
    v = getattr(k, "value", k)
    return v if isinstance(v, (str, int, float)) else repr(v)


def _shape_media_value(v, blob_info=None):
    if blob_info is not None:
        return {"kind": "blob", **blob_info}
    return {"kind": "value", "jsonBytes": _json_size(v), "fields": sorted(v.keys())[:20] if isinstance(v, dict) else type(v).__name__}


def read_gecko_origin(origin):
    """The Firefox-family twin of read_origin: gecko.read_idb_folder's raw records shaped the same way.
    [unverified] on a real profile — gecko.py."""
    from . import gecko
    out = {"origin": origin.origin, "host": origin.host, "appHint": origin.app_hint, "kind": "gecko", "databases": {}, "problems": []}
    try:
        dbs, problems = gecko.read_idb_folder(Path(origin.leveldb) / "idb")
    except Exception as e:   # noqa: BLE001
        out["problems"].append("Firefox IndexedDB could not be read: %s: %s" % (type(e).__name__, e))
        return out
    out["problems"].extend(problems)
    for name, db in dbs.items():
        entry = {"stores": {}}
        for sname, st in db["stores"].items():
            recs = {"count": st["count"], "keys": [], "docs": [], "media": {}, "deserializeErrors": 0}
            for key, value, meta in st["records"]:
                if value is None and meta.get("why") and not meta.get("files"):
                    recs["deserializeErrors"] += 1
                if name == suite.DOCS_DB and sname == "docs" and isinstance(value, dict):
                    recs["docs"].append(value)
                elif name == suite.DOCS_DB and sname == "media":
                    if meta.get("files"):
                        sizes = [f["size"] for f in meta["files"] if f.get("size") is not None]
                        recs["media"][str(key)] = {"kind": "blob", "size": sum(sizes) if sizes else None, "type": None, "fileName": None,
                                                  "files": meta["files"], "undecoded": value is None}
                    elif value is not None:
                        recs["media"][str(key)] = _shape_media_value(value)
                    else:
                        recs["media"][str(key)] = {"kind": "unknown", "error": meta.get("why")}
                elif len(recs["keys"]) < 200:
                    recs["keys"].append(key if isinstance(key, (str, int, float)) else repr(key))
            for k in ("docs", "media", "keys"):
                if not recs[k]:
                    recs.pop(k)
            entry["stores"][sname] = recs
        out["databases"][name] = entry
    return out


def read_origin(origin):
    """→ {origin, databases: {name: {...}}, problems: [str]} for one copied OriginStorage."""
    if getattr(origin, "kind", "chromium") == "gecko":
        return read_gecko_origin(origin)
    idb_mod, _, blink = _ccl()
    out = {"origin": origin.origin, "host": origin.host, "appHint": origin.app_hint, "kind": "chromium", "databases": {}, "problems": []}
    try:
        wrapped = idb_mod.WrappedIndexDB(origin.leveldb, origin.blob)
    except Exception as e:   # noqa: BLE001 — a corrupt or foreign folder is a finding, not a crash
        out["problems"].append("IndexedDB could not be opened: %s: %s" % (type(e).__name__, e))
        return out
    try:
        for dbid in wrapped.database_ids:
            if not suite.is_suite_db(dbid.name):
                continue
            db = wrapped[dbid.dbid_no]
            entry = {"stores": {}}
            for sname in db.object_store_names:
                store = db.get_object_store_by_name(sname)
                recs = {"count": 0, "keys": [], "docs": [], "media": {}, "deserializeErrors": 0}
                bad = []
                for rec in store.iterate_records(live_only=True, bad_deserializer_data_handler=lambda k, raw: bad.append(_key_value(k))):
                    recs["count"] += 1
                    key = _key_value(rec.key)
                    if dbid.name == suite.DOCS_DB and sname == "docs" and isinstance(rec.value, dict):
                        recs["docs"].append(rec.value)
                    elif dbid.name == suite.DOCS_DB and sname == "media":
                        v = rec.value
                        if isinstance(v, blink.BlobIndex):
                            try:
                                info = rec.resolve_blob_index(v)
                                recs["media"][str(key)] = {"kind": "blob", "size": info.size, "type": info.mime_type, "fileName": info.file_name}
                            except Exception as e:   # noqa: BLE001
                                recs["media"][str(key)] = {"kind": "blob", "error": "%s: %s" % (type(e).__name__, e)}
                        else:
                            recs["media"][str(key)] = {"kind": "value", "jsonBytes": _json_size(v),
                                                       "fields": sorted(v.keys())[:20] if isinstance(v, dict) else type(v).__name__}
                    else:
                        if len(recs["keys"]) < 200:
                            recs["keys"].append(key)
                recs["deserializeErrors"] = len(bad)
                if not recs["docs"]:
                    recs.pop("docs")
                if not recs["media"]:
                    recs.pop("media")
                if not recs["keys"]:
                    recs.pop("keys")
                entry["stores"][sname] = recs
            out["databases"][dbid.name] = entry
    except Exception as e:   # noqa: BLE001
        out["problems"].append("while reading records: %s: %s" % (type(e).__name__, e))
    finally:
        try:
            wrapped.close()
        except Exception:   # noqa: BLE001
            pass
    return out


def read_blob(origin, store_name, key):
    """The bytes of one Blob record (a recording), for --with-audio. None if it is not a blob."""
    if getattr(origin, "kind", "chromium") == "gecko":
        return _read_gecko_blob(origin, store_name, key)
    idb_mod, _, blink = _ccl()
    wrapped = idb_mod.WrappedIndexDB(origin.leveldb, origin.blob)
    try:
        for dbid in wrapped.database_ids:
            if dbid.name != suite.DOCS_DB:
                continue
            store = wrapped[dbid.dbid_no].get_object_store_by_name(store_name)
            for rec in store.iterate_records(live_only=True):
                if _key_value(rec.key) == key and isinstance(rec.value, blink.BlobIndex):
                    return rec.get_blob_stream(rec.value).read()
    finally:
        wrapped.close()
    return None


def _read_gecko_blob(origin, store_name, key):
    """A Firefox Blob record's bytes: the files the row names in <db>.files/, concatenated in order.
    [unverified] that a one-Blob record names exactly one file; the manifest lists them all."""
    from . import gecko
    dbs, _ = gecko.read_idb_folder(Path(origin.leveldb) / "idb")
    st = dbs.get(suite.DOCS_DB, {}).get("stores", {}).get(store_name)
    if not st:
        return None
    for k, value, meta in st["records"]:
        if str(k) == str(key) and meta.get("files"):
            out = b""
            for f in meta["files"]:
                for sq in sorted((Path(origin.leveldb) / "idb").glob("*.files")):
                    p = sq / str(f["id"]).lstrip(".")
                    if p.is_file():
                        out += p.read_bytes()
                        break
            return out or None
    return None


def shape_keys(latest):
    """The localStorage shaping rule, shared by both engines: suite keys only, credential-named keys as
    present + length, the settings key parsed."""
    shaped = {}
    for k, v in sorted(latest.items()):
        if not suite.is_suite_key(k):
            continue
        if suite.is_sensitive_key(k):
            shaped[k] = {"present": True, "length": len(v or "")}
        elif k == suite.SETTINGS_KEY:
            try:
                shaped[k] = json.loads(v)
            except (TypeError, ValueError):
                shaped[k] = v
        else:
            shaped[k] = v
    return shaped


def read_gecko_local_storage(copy):
    """{origin: {key: …}} for a copied gecko store: each origin's ls/data.sqlite, then the legacy file."""
    from . import gecko
    out, problems = {}, []
    for o in copy.origins:
        try:
            vals, probs = gecko.read_local_storage(o.leveldb)
        except Exception as e:   # noqa: BLE001
            problems.append("%s localStorage: %s: %s" % (o.origin, type(e).__name__, e))
            continue
        problems.extend("%s: %s" % (o.origin, p) for p in probs)
        shaped = shape_keys(vals)
        if shaped:
            out[o.origin] = shaped
    legacy = Path(getattr(copy, "copy_root", "")) / "webappsstore.sqlite" if getattr(copy, "copy_root", None) else None
    if legacy and legacy.is_file():
        vals, probs = gecko.read_legacy_webappsstore(legacy.parent, {o.host for o in copy.origins})
        problems.extend(probs)
        for origin, kv in vals.items():
            shaped = shape_keys(kv)
            if shaped:
                out.setdefault(origin + " (legacy webappsstore)", {}).update(shaped)
    return out, problems


def read_local_storage(leveldb_dir, hosts):
    """{origin: {key: value | {present: true, length: n}}} for the suite's keys on the given hosts.
    Keys whose names say they hold a credential are reported present, never copied."""
    _, ls_mod, _ = _ccl()
    out, problems = {}, []
    if leveldb_dir is None or not Path(leveldb_dir).is_dir():
        return out, ["no Local Storage folder"]
    try:
        db = ls_mod.LocalStoreDb(Path(leveldb_dir))
    except Exception as e:   # noqa: BLE001
        return out, ["Local Storage could not be opened: %s: %s" % (type(e).__name__, e)]
    try:
        for storage_key in db.iter_storage_keys():
            host = storage_key.split("://", 1)[-1].split("/")[0].split(":")[0]
            if host not in hosts and not suite.is_suite_host(host):
                continue
            latest = {}
            for rec in db.iter_records_for_storage_key(storage_key, include_deletions=False):
                if not suite.is_suite_key(rec.script_key):
                    continue
                latest[rec.script_key] = rec.value   # records come in sequence order: the last live write wins
            shaped = shape_keys(latest)
            if shaped:
                out[storage_key] = shaped
    except Exception as e:   # noqa: BLE001
        problems.append("while reading Local Storage: %s: %s" % (type(e).__name__, e))
    finally:
        try:
            db.close()
        except Exception:   # noqa: BLE001
            pass
    return out, problems
