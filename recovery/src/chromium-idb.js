/* chromium-idb.js — read Chromium's IndexedDB layout out of a LevelDB directory.
 *
 * Every IndexedDB database an origin owns lives in one LevelDB (<origin>.indexeddb.leveldb), with a
 * sibling folder (<origin>.indexeddb.blob) holding Blob/File contents as plain files. Keys carry a
 * compact (database, object store, index) prefix; this module decodes it and groups the records.
 *
 * Reference: content/browser/indexed_db/instance/leveldb/indexed_db_leveldb_coding.cc (Chromium).
 * Layout verified against Chrome 156's own files (2026-10).
 */
import { readLevelDb, varint, latin1 } from './leveldb.js';
import { unwrapIdbValue, deserialize } from './v8-value.js';

const DATABASE_NAME = 201;        // global metadata: origin + database name → database id
const OBJECT_STORE_META = 50;     // database metadata: store id + field → value
const STORE_NAME = 0;
const DATA_INDEX = 1;             // object-store records
const BLOB_INDEX = 3;             // a record's Blob/File list

function prefix(key) {
  const first = key[0];
  const lens = [(first >> 5) + 1, ((first >> 2) & 7) + 1, (first & 3) + 1];
  const ids = [];
  let p = 1;
  for (const n of lens) {
    if (p + n > key.length) return null;
    let v = 0;
    for (let i = 0; i < n; i++) v += key[p + i] * 2 ** (8 * i);
    ids.push(v);
    p += n;
  }
  return { db: ids[0], store: ids[1], index: ids[2], p };
}

function utf16be(bytes, p, chars) {
  let s = '';
  for (let i = 0; i < chars; i++) s += String.fromCharCode((bytes[p + 2 * i] << 8) | bytes[p + 2 * i + 1]);
  return s;
}

function stringWithLength(bytes, p) {
  let n;
  [n, p] = varint(bytes, p);
  if (p + 2 * n > bytes.length) throw new Error('string runs past the end of its key');
  return [utf16be(bytes, p, n), p + 2 * n];
}

/* An IndexedDB key (the record's primary key), decoded for display and matching. */
export function decodeKey(bytes, p = 0) {
  const t = bytes[p++];
  if (t === 1) return stringWithLength(bytes, p);
  if (t === 2 || t === 3) {
    const v = new DataView(bytes.buffer, bytes.byteOffset + p, 8).getFloat64(0, true);
    return [t === 2 ? new Date(v) : v, p + 8];
  }
  if (t === 4) {
    let n;
    [n, p] = varint(bytes, p);
    const out = [];
    for (let i = 0; i < n; i++) { let k; [k, p] = decodeKey(bytes, p); out.push(k); }
    return [out, p];
  }
  if (t === 6) { let n; [n, p] = varint(bytes, p); return [bytes.slice(p, p + n), p + n]; }
  if (t === 0) return [null, p];
  if (t === 5) return ['(min key)', p];
  throw new Error(`unknown key type ${t}`);
}

/* A record's external objects (the Blobs and Files inside it), in the order the value refers to
 * them by index. */
export function decodeExternals(bytes) {
  const out = [];
  let p = 0;
  while (p < bytes.length) {
    const kind = bytes[p++];
    if (kind === 2) {                           // a File System Access handle: a token, no bytes here
      let n;
      [n, p] = varint(bytes, p);
      p += n;
      out.push({ kind: 'handle' });
      continue;
    }
    if (kind !== 0 && kind !== 1) throw new Error(`unknown external object kind ${kind}`);
    let blobNumber;
    let type;
    let size;
    [blobNumber, p] = varint(bytes, p);
    [type, p] = stringWithLength(bytes, p);
    [size, p] = varint(bytes, p);
    const ext = { kind: kind === 1 ? 'file' : 'blob', blobNumber, type, size };
    if (kind === 1) {
      [ext.fileName, p] = stringWithLength(bytes, p);
      [ext.lastModified, p] = varint(bytes, p);
    }
    out.push(ext);
  }
  return out;
}

/* Where Chromium keeps a blob's bytes: <blob folder>/<database id, hex>/<byte 2 of the number,
 * two hex digits>/<number, hex>. */
export function blobPath(databaseId, blobNumber) {
  return `${databaseId.toString(16)}/${(Math.floor(blobNumber / 256) & 0xff).toString(16).padStart(2, '0')}/${blobNumber.toString(16)}`;
}

/* ldbFiles: one LevelDB directory's files (see readLevelDb).
 * blobFiles: Map<relative path inside the .blob folder, { bytes(), size }> — may be empty.
 *
 * Returns { databases: [{ id, name, origin, stores: [{ id, name, records }] }], problems, raw }
 * where each record is { key, keyText, version, bytes, externals, seq, older: [...] } — values
 * still serialized; decodeRecord() turns one into a JS value on demand. */
export async function readIndexedDb(ldbFiles) {
  const ldb = await readLevelDb(ldbFiles);
  const problems = [...ldb.problems];
  const dbs = new Map();
  const getDb = (id) => {
    if (!dbs.has(id)) dbs.set(id, { id, name: null, origin: null, stores: new Map() });
    return dbs.get(id);
  };
  const getStore = (db, id) => {
    if (!db.stores.has(id)) db.stores.set(id, { id, name: null, records: new Map() });
    return db.stores.get(id);
  };
  const externalsByKey = new Map();

  const visit = (e, isOlder) => {
    const key = e.key;
    const px = prefix(key);
    if (!px) return;
    try {
      if (px.db === 0 && px.store === 0 && px.index === 0) {
        if (key[px.p] === DATABASE_NAME && !e.deleted && !isOlder) {
          let p = px.p + 1;
          let origin;
          let name;
          [origin, p] = stringWithLength(key, p);
          [name, p] = stringWithLength(key, p);
          const [id] = varint(e.value, 0);
          const db = getDb(id);
          db.name = name;
          db.origin = origin;
        }
        return;
      }
      if (px.store === 0 && px.index === 0) {
        if (key[px.p] === OBJECT_STORE_META && !e.deleted && !isOlder) {
          let p = px.p + 1;
          let storeId;
          [storeId, p] = varint(key, p);
          if (key[p] === STORE_NAME) getStore(getDb(px.db), storeId).name = utf16be(e.value, 0, e.value.length / 2);
        }
        return;
      }
      const suffix = key.subarray(px.p);
      if (px.index === BLOB_INDEX) {
        const id = `${px.db}/${px.store}/${latin1(suffix)}`;
        if (!isOlder && !e.deleted) externalsByKey.set(id, e.value);
        else {
          if (!externalsByKey.has(id + '#older')) externalsByKey.set(id + '#older', []);
          if (!e.deleted) externalsByKey.get(id + '#older').push({ seq: e.seq, value: e.value });
        }
        return;
      }
      if (px.index !== DATA_INDEX) return;
      const store = getStore(getDb(px.db), px.store);
      const k = latin1(suffix);
      let rec = store.records.get(k);
      if (!rec) {
        let keyValue;
        try { [keyValue] = decodeKey(suffix, 0); } catch { keyValue = '(undecodable key)'; }
        rec = { key: keyValue, keyText: typeof keyValue === 'string' ? keyValue : JSON.stringify(keyValue), current: null, older: [] };
        store.records.set(k, rec);
      }
      const version = e.deleted ? null : varint(e.value, 0);
      const entry = {
        seq: e.seq,
        deleted: e.deleted,
        version: version ? version[0] : null,
        bytes: version ? e.value.subarray(version[1]) : null,
        file: e.file,
      };
      if (isOlder) rec.older.push(entry);
      else rec.current = entry;
    } catch (err) {
      problems.push(`a key could not be decoded: ${err.message}`);
    }
  };

  for (const e of ldb.current.values()) visit(e, false);
  for (const list of ldb.older.values()) for (const e of list) visit(e, true);

  for (const db of dbs.values()) {
    for (const store of db.stores.values()) {
      for (const [k, rec] of store.records) {
        const id = `${db.id}/${store.id}/${k}`;
        const ext = externalsByKey.get(id);
        try { rec.externals = ext ? decodeExternals(ext) : []; }
        catch (err) { rec.externals = []; problems.push(`blob list for ${rec.keyText}: ${err.message}`); }
        for (const x of rec.externals) if (x.blobNumber != null) x.path = blobPath(db.id, x.blobNumber);
        rec.older.sort((a, b) => b.seq - a.seq);
        // An older version may have had a different blob list; keep the matching one if it is still on disk.
        const olderExt = externalsByKey.get(id + '#older') || [];
        for (const o of rec.older) {
          const match = olderExt.filter((x) => x.seq <= o.seq).sort((a, b) => b.seq - a.seq)[0];
          try { o.externals = match ? decodeExternals(match.value) : rec.externals; } catch { o.externals = rec.externals; }
          for (const x of o.externals) if (x.blobNumber != null && !x.path) x.path = blobPath(db.id, x.blobNumber);
        }
      }
    }
  }

  return {
    databases: [...dbs.values()].map((db) => ({ ...db, stores: [...db.stores.values()] })),
    problems,
    filesRead: ldb.filesRead,
    manifest: ldb.manifest,
  };
}

/* One stored version of a record → { value, error, externals }. `readBlob(path)` returns a blob
 * file's bytes, or null when the blob folder is missing or lacks that file. */
export async function decodeEntry(entry, externals, readBlob) {
  if (!entry || entry.deleted || !entry.bytes) return { value: undefined, error: 'deleted' };
  let unwrapped;
  try {
    unwrapped = await unwrapIdbValue(entry.bytes, externals, readBlob ? (x) => readBlob(x.path) : null);
  } catch (e) {
    return { value: undefined, error: e.message };
  }
  const own = externals.filter((_, i) => !unwrapped.consumed.has(i));
  const out = deserialize(unwrapped.bytes, externals);
  return { ...out, externals: own };
}
