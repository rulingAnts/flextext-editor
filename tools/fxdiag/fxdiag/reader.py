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


def read_origin(origin):
    """→ {origin, databases: {name: {...}}, problems: [str]} for one copied OriginStorage."""
    idb_mod, _, blink = _ccl()
    out = {"origin": origin.origin, "host": origin.host, "appHint": origin.app_hint, "databases": {}, "problems": []}
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
            shaped = {}
            for k, v in sorted(latest.items()):
                if suite.is_sensitive_key(k):
                    shaped[k] = {"present": True, "length": len(v or "")}
                elif k == suite.SETTINGS_KEY:
                    try:
                        shaped[k] = json.loads(v)
                    except (TypeError, ValueError):
                        shaped[k] = v
                else:
                    shaped[k] = v
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
