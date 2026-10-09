/* leveldb.js — read a LevelDB directory the way Chromium leaves it on disk, with no LevelDB.
 *
 * Chromium keeps IndexedDB and localStorage in LevelDB. This module turns one such directory
 * (MANIFEST-*, CURRENT, *.log, *.ldb/*.sst) into the set of keys and values it holds. It never
 * writes anything, and it works on COPIES as happily as on the live folder.
 *
 * Formats: https://github.com/google/leveldb/blob/main/doc/log_format.md
 *          https://github.com/google/leveldb/blob/main/doc/table_format.md
 *
 * ⚠ THE NEWEST WORK IS USUALLY IN THE .log, NOT IN A TABLE. LevelDB writes every change to the
 * write-ahead log first and only later folds it into a sorted table. A text edited this afternoon
 * and never compacted exists ONLY in the log, so a reader that skipped it would hand back
 * yesterday's version of exactly the work somebody is trying to rescue. Both are read, and for
 * every key the entry with the highest sequence number wins — which is LevelDB's own rule.
 *
 * ⚠ AND THE MANIFEST DECIDES WHICH FILES ARE STILL PART OF THE DATABASE. After a compaction the
 * input tables can linger on disk for a moment. Reading them as live would resurrect anything
 * deleted in between (a text the user deleted would come back). So the CURRENT view is built from
 * the files the MANIFEST still lists; every other file found is read too, but only into `older`,
 * where a person can choose to look at it. With no readable MANIFEST every file counts as live —
 * over-recovering beats under-recovering in a recovery tool.
 */
import { snappyUncompress } from './snappy.js';

const LOG_BLOCK = 32768;
const TABLE_MAGIC = [0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb];

/* ---------- small binary helpers ---------- */

export function varint(buf, pos) {
  let v = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new Error('varint runs past the end of its buffer');
    const b = buf[pos++];
    v += (b & 0x7f) * mul;
    if (!(b & 0x80)) return [v, pos];
    mul *= 128;
  }
  throw new Error('varint longer than 10 bytes');
}

function u32(buf, pos) {
  return (buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16)) + buf[pos + 3] * 0x1000000;
}

export function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
}

/* CRC32C (Castagnoli), as LevelDB uses it, plus its "mask" so a CRC of data containing CRCs is
 * not trivially self-referential. */
const CRC32C = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32c(chunks) {
  let c = 0xffffffff;
  for (const bytes of chunks) for (let i = 0; i < bytes.length; i++) c = CRC32C[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function unmask(masked) {
  const rot = (masked - 0xa282ead8) >>> 0;
  return ((rot >>> 17) | (rot << 15)) >>> 0;
}

/* ---------- the write-ahead log (also the MANIFEST's format) ---------- */

/* Physical records → logical records. A record that fails its checksum is dropped, as LevelDB's
 * own recovery drops it: it is the half-written tail of a browser that was closed mid-write, and
 * parsing it would put garbage into a text. `problems` says how many were dropped. */
export function logRecords(bytes, problems = [], label = 'log') {
  const out = [];
  let pending = null;
  let pos = 0;
  while (pos + 7 <= bytes.length) {
    const inBlock = pos % LOG_BLOCK;
    if (LOG_BLOCK - inBlock < 7) { pos += LOG_BLOCK - inBlock; continue; }
    const crc = u32(bytes, pos);
    const len = bytes[pos + 4] | (bytes[pos + 5] << 8);
    const type = bytes[pos + 6];
    if (type === 0 && len === 0 && crc === 0) { pos += LOG_BLOCK - inBlock; continue; } // zero-filled tail
    const start = pos + 7;
    const end = start + len;
    if (end > bytes.length || inBlock + 7 + len > LOG_BLOCK) {
      problems.push(`${label}: last record is incomplete (${bytes.length - start} of ${len} bytes) — ignored`);
      break;
    }
    const data = bytes.subarray(start, end);
    pos = end;
    if (crc32c([bytes.subarray(start - 1, start), data]) !== unmask(crc)) {
      problems.push(`${label}: a record at byte ${start - 7} failed its checksum — ignored`);
      pending = null;
      continue;
    }
    if (type === 1) { out.push(data); pending = null; }
    else if (type === 2) pending = [data];
    else if (type === 3) { if (pending) pending.push(data); }
    else if (type === 4) {
      if (pending) {
        pending.push(data);
        const total = pending.reduce((n, c) => n + c.length, 0);
        const joined = new Uint8Array(total);
        let o = 0;
        for (const c of pending) { joined.set(c, o); o += c.length; }
        out.push(joined);
      }
      pending = null;
    } else {
      problems.push(`${label}: unknown record type ${type} at byte ${start - 7} — skipped`);
      pending = null;
    }
  }
  return out;
}

function writeBatchEntries(rec, emit) {
  const seq = u32(rec, 0) + u32(rec, 4) * 0x100000000;
  const count = u32(rec, 8);
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const tag = rec[pos++];
    let klen;
    [klen, pos] = varint(rec, pos);
    const key = rec.subarray(pos, pos + klen);
    pos += klen;
    if (tag === 1) {
      let vlen;
      [vlen, pos] = varint(rec, pos);
      emit(key, seq + i, 1, rec.subarray(pos, pos + vlen));
      pos += vlen;
    } else if (tag === 0) {
      emit(key, seq + i, 0, null);
    } else {
      throw new Error(`write batch: unknown entry tag ${tag}`);
    }
  }
}

/* ---------- sorted tables (.ldb / .sst) ---------- */

function blockContents(file, offset, size, problems, label) {
  if (offset + size + 5 > file.length) throw new Error(`block at ${offset} runs past the end of the file`);
  const raw = file.subarray(offset, offset + size);
  const type = file[offset + size];
  const stored = u32(file, offset + size + 1);
  if (crc32c([raw, file.subarray(offset + size, offset + size + 1)]) !== unmask(stored)) {
    problems.push(`${label}: block at byte ${offset} failed its checksum — read anyway`);
  }
  if (type === 0) return raw;
  if (type === 1) return snappyUncompress(raw);
  throw new Error(`block compression type ${type} is not supported`);
}

function* blockEntries(block) {
  if (block.length < 4) return;
  const restarts = u32(block, block.length - 4);
  const limit = block.length - 4 - 4 * restarts;
  if (limit < 0) throw new Error('block restart array is larger than the block');
  let pos = 0;
  let last = new Uint8Array(0);
  while (pos < limit) {
    let shared;
    let unshared;
    let vlen;
    [shared, pos] = varint(block, pos);
    [unshared, pos] = varint(block, pos);
    [vlen, pos] = varint(block, pos);
    const key = new Uint8Array(shared + unshared);
    key.set(last.subarray(0, shared));
    key.set(block.subarray(pos, pos + unshared), shared);
    pos += unshared;
    const value = block.subarray(pos, pos + vlen);
    pos += vlen;
    last = key;
    yield [key, value];
  }
}

function tableEntries(file, emit, problems, label) {
  if (file.length < 48) throw new Error('too short to be a table');
  for (let i = 0; i < 8; i++) {
    if (file[file.length - 8 + i] !== TABLE_MAGIC[i]) throw new Error('not a LevelDB table (bad magic number)');
  }
  const footer = file.subarray(file.length - 48);
  let p = 0;
  let idxOff;
  let idxSize;
  [, p] = varint(footer, p);          // metaindex offset — the bloom filter, not needed
  [, p] = varint(footer, p);          // metaindex size
  [idxOff, p] = varint(footer, p);
  [idxSize, p] = varint(footer, p);
  const index = blockContents(file, idxOff, idxSize, problems, label);
  for (const [, handle] of blockEntries(index)) {
    let q = 0;
    let off;
    let size;
    [off, q] = varint(handle, q);
    [size, q] = varint(handle, q);
    let data;
    try { data = blockContents(file, off, size, problems, label); }
    catch (e) { problems.push(`${label}: data block at ${off} unreadable (${e.message}) — skipped`); continue; }
    for (const [ikey, value] of blockEntries(data)) {
      if (ikey.length < 8) continue;
      const t = ikey.length - 8;
      const lo = u32(ikey, t);
      const hi = u32(ikey, t + 4);
      emit(ikey.subarray(0, t), Math.floor(lo / 256) + hi * 0x1000000, lo & 0xff, value);
    }
  }
}

/* ---------- MANIFEST: which files are live ---------- */

function manifestState(records) {
  const live = new Set();
  let logNumber = null;
  let prevLogNumber = 0;
  for (const rec of records) {
    let p = 0;
    while (p < rec.length) {
      let tag;
      [tag, p] = varint(rec, p);
      if (tag === 1) { let n; [n, p] = varint(rec, p); p += n; }                          // comparator
      else if (tag === 2) [logNumber, p] = varint(rec, p);                                 // log number
      else if (tag === 3 || tag === 4) [, p] = varint(rec, p);                             // next file / last seq
      else if (tag === 5) { let n; [, p] = varint(rec, p); [n, p] = varint(rec, p); p += n; } // compact pointer
      else if (tag === 6) { let num; [, p] = varint(rec, p); [num, p] = varint(rec, p); live.delete(num); }
      else if (tag === 7) {
        let num;
        let n;
        [, p] = varint(rec, p);
        [num, p] = varint(rec, p);
        [, p] = varint(rec, p);
        [n, p] = varint(rec, p); p += n;
        [n, p] = varint(rec, p); p += n;
        live.add(num);
      } else if (tag === 9) [prevLogNumber, p] = varint(rec, p);
      else throw new Error(`unknown MANIFEST tag ${tag}`);
    }
  }
  return { live, logNumber, prevLogNumber };
}

/* ---------- the directory ---------- */

/* files: [{ name, bytes(): Promise<Uint8Array> }] — the contents of ONE LevelDB directory.
 *
 * Returns {
 *   current: Map<latin1(key), { key, seq, deleted, value, file }>  — what the database holds now
 *   older:   Map<latin1(key), [{ seq, deleted, value, file }]>     — superseded versions still on disk
 *   problems: string[], filesRead: string[], manifest: boolean
 * } */
export async function readLevelDb(files) {
  const problems = [];
  const byName = new Map(files.map((f) => [f.name, f]));
  let state = null;
  try {
    const current = byName.get('CURRENT');
    if (current) {
      const name = new TextDecoder().decode(await current.bytes()).trim();
      const mf = byName.get(name);
      if (mf) state = manifestState(logRecords(await mf.bytes(), problems, name));
      else problems.push(`CURRENT names ${name}, which is not in this folder — reading every file as live`);
    } else {
      problems.push('no CURRENT file — reading every file as live');
    }
  } catch (e) {
    problems.push(`MANIFEST unreadable (${e.message}) — reading every file as live`);
    state = null;
  }

  const isLive = (num, kind) => {
    if (!state) return true;
    if (kind === 'table') return state.live.has(num);
    return state.logNumber == null || num >= state.logNumber || num === state.prevLogNumber;
  };

  const all = [];
  const filesRead = [];
  const ordered = files
    .map((f) => {
      const m = /^(\d+)\.(log|ldb|sst)$/.exec(f.name);
      return m ? { f, num: Number(m[1]), kind: m[2] === 'log' ? 'log' : 'table' } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.num - b.num);
  for (const { f, num, kind } of ordered) {
    const live = isLive(num, kind);
    let bytes;
    try { bytes = await f.bytes(); }
    catch (e) { problems.push(`${f.name}: could not be read (${e.message})`); continue; }
    if (!bytes.length) continue;
    const emit = (key, seq, type, value) => all.push({ key, seq, deleted: type === 0, value, file: f.name, live });
    try {
      if (kind === 'log') {
        for (const rec of logRecords(bytes, problems, f.name)) {
          try { writeBatchEntries(rec, emit); }
          catch (e) { problems.push(`${f.name}: a write batch could not be decoded (${e.message})`); }
        }
      } else {
        tableEntries(bytes, emit, problems, f.name);
      }
      filesRead.push(f.name + (live ? '' : ' (no longer listed in the MANIFEST)'));
    } catch (e) {
      problems.push(`${f.name}: ${e.message}`);
    }
  }

  const current = new Map();
  const older = new Map();
  for (const e of all) {
    const k = latin1(e.key);
    if (e.live) {
      const have = current.get(k);
      if (!have || e.seq > have.seq) {
        if (have) pushOlder(older, k, have);
        current.set(k, e);
      } else if (e.seq < have.seq) {
        pushOlder(older, k, e);
      }
    } else {
      pushOlder(older, k, e);
    }
  }
  return { current, older, problems, filesRead, manifest: !!state };
}

function pushOlder(older, k, e) {
  let list = older.get(k);
  if (!list) older.set(k, (list = []));
  if (!list.some((x) => x.seq === e.seq)) list.push(e);
}
