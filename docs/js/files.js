/* files.js — the FILE SYSTEM seam: a folder the researcher grants once, which the suite then reads
 * and writes without the browser's download-and-pick loop. plans/native-shell-capabilities.md §3
 * named it; plans/lameta-device.md §1–2 is what it is built for: the Researcher Panel, installed as
 * a PWA on Chrome or Edge, holds a lameta project's folder and treats its Sessions/ as a device.
 *
 * ⚠ CHROMIUM DESKTOP ONLY, today. The File System Access API (showDirectoryPicker, persistent
 * handles) exists in Chrome and Edge on a computer. Firefox and Safari expose no picker for a folder
 * on the researcher's disk — they have only the origin-private file system, which is not the disk —
 * and Android Chrome has no directory picker at all. folderCapability() says which, in words the UI
 * repeats rather than failing quietly. An INSTALLED app on current Chrome/Edge keeps a granted
 * folder across launches; a plain tab is asked once per browser session.
 *
 * ⚠ CLOUD-SYNCED FOLDERS NEVER JAM (Seth's rule for every desktop tool): ~/Documents may be iCloud
 * Drive or Google Drive, and a file that is not downloaded blocks its read until the bytes arrive —
 * for a minute, or forever offline. Every read here carries a timeout and reports `available:false`
 * instead of hanging whoever called; listings are names only, and stat never touches the bytes.
 *
 * THE SEAM. Everything the platform does is behind `caps`: the picker, permission queries, the
 * persistence store. A native shell (Tauri, Electron) hands in its own through setFilesPlatform —
 * the same handle-shaped objects, its own remembered-folder store — and nothing above this module
 * changes. Handles are duck-typed on purpose: `kind`, `name`, `values()`, `getFileHandle`,
 * `getDirectoryHandle`, `getFile`, `createWritable`, `queryPermission`, `requestPermission`,
 * `isSameEntry` — the API's own shape, which a shell can supply from the filesystem it owns.
 *
 * ⚠ NEVER precached, never statically imported: researcher-panel.js reaches this by `import()` so it
 * enters no offline shell (test/lameta-agent-isolation.test.mjs pins that). Nothing here touches the
 * sync module, IndexedDB names the editor uses, or any storage but its own database.
 */

const DB_NAME = 'flextext-files';
const DB_VERSION = 1;
const STORE = 'handles';
export const DEFAULT_TIMEOUT_MS = 15000;

/* ─── capability ──────────────────────────────────────────────────────────────────────────────── */
const g = () => (typeof globalThis !== 'undefined' ? globalThis : {});
const isMobileUA = (ua) => /Android|iPhone|iPad|iPod|Mobile/i.test(String(ua || ''));
const browserName = (ua) => {
  const s = String(ua || '');
  if (/Edg\//.test(s)) return 'Edge';
  if (/OPR\//.test(s)) return 'Opera';
  if (/Chrome\//.test(s)) return 'Chrome';
  if (/Firefox\//.test(s)) return 'Firefox';
  if (/Safari\//.test(s)) return 'Safari';
  return '';
};

const WEB_CAPS = {
  /* Can this platform hand us a folder on the disk at all, and why not when not? The answers are
   * the web's, pessimistic; a shell overrides `capability` with its own truth. */
  capability() {
    const w = g();
    const nav = w.navigator || {};
    const ua = nav.userAgent || '';
    const browser = browserName(ua);
    const installed = !!(w.matchMedia && w.matchMedia('(display-mode: standalone)').matches);
    if (isMobileUA(ua)) return { ok: false, why: 'mobile', browser, installed };
    if (w.isSecureContext === false) return { ok: false, why: 'insecure', browser, installed };
    if (typeof w.showDirectoryPicker !== 'function') return { ok: false, why: 'no-picker', browser, installed };
    return { ok: true, why: '', browser, installed };
  },
  /* The picker. `id` lets the browser reopen the last-used location for this purpose; `mode`
   * readwrite asks for write access up front, one prompt instead of two. */
  pickFolder({ id = 'flextext', mode = 'readwrite', startIn = 'documents' } = {}) {
    const w = g();
    return w.showDirectoryPicker({ id, mode, startIn });
  },
  async permissionState(handle, mode = 'readwrite') {
    if (!handle || typeof handle.queryPermission !== 'function') return 'prompt';
    try { return await handle.queryPermission({ mode }); } catch { return 'prompt'; }
  },
  async requestPermission(handle, mode = 'readwrite') {
    if (!handle || typeof handle.requestPermission !== 'function') return false;
    try { return (await handle.requestPermission({ mode })) === 'granted'; } catch { return false; }
  },
  /* Remembered folders: IndexedDB is the ONE place a handle can be persisted on the web. Its own
   * database, so nothing here can collide with the editor's sync database or the panel's stores. */
  async store(op, key, value) {
    const w = g();
    if (!w.indexedDB) throw new Error('no IndexedDB');
    const db = await new Promise((resolve, reject) => {
      const req = w.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, op === 'get' ? 'readonly' : 'readwrite');
        const st = tx.objectStore(STORE);
        const req = op === 'get' ? st.get(key) : op === 'put' ? st.put(value, key) : st.delete(key);
        req.onsuccess = () => resolve(op === 'get' ? (req.result === undefined ? null : req.result) : true);
        req.onerror = () => reject(req.error || new Error('IndexedDB ' + op + ' failed'));
      });
    } finally { db.close(); }
  },
};
let caps = WEB_CAPS;
/** A native shell declares what it really can do. Omitted keys keep the web's answer. */
export function setFilesPlatform(p) { caps = p ? { ...WEB_CAPS, ...p } : WEB_CAPS; }

/** { ok, why: '' | 'mobile' | 'insecure' | 'no-picker', browser, installed } */
export function folderCapability() { return caps.capability(); }
/** Ask the person for a folder. Rejects with AbortError when they cancel — callers treat that as no news. */
export function pickFolder(opts) { return caps.pickFolder(opts); }
export function permissionState(handle, mode) { return caps.permissionState(handle, mode); }
export function requestFolderPermission(handle, mode) { return caps.requestPermission(handle, mode); }

/* ─── remembered folders ──────────────────────────────────────────────────────────────────────── */
/** Persist a handle under `key` with a little metadata ({ name, at, ...meta }). */
export async function rememberFolder(key, handle, meta = {}) {
  return caps.store('put', key, { handle, name: handle && handle.name, at: Date.now(), ...meta });
}
/** { handle, name, at, ...meta } or null. The handle may need requestFolderPermission before use. */
export async function recallFolder(key) {
  try { return await caps.store('get', key); } catch { return null; }
}
export async function forgetFolder(key) {
  try { return await caps.store('delete', key); } catch { return false; }
}
/* Small records that belong WITH the folders (a link's install identity, an index of links): the
 * same store, so a folder and what was done with it live and die together. Structured-cloneable
 * values only. */
export async function stashPut(key, value) { return caps.store('put', key, value); }
export async function stashGet(key) { try { return await caps.store('get', key); } catch { return null; } }
export async function stashDelete(key) { try { return await caps.store('delete', key); } catch { return false; } }

/* ─── timeouts ────────────────────────────────────────────────────────────────────────────────── */
export class FilesTimeout extends Error {
  constructor(what, ms) { super(`${what || 'file operation'} did not finish in ${ms} ms`); this.code = 'FILES_TIMEOUT'; this.what = what; this.ms = ms; }
}
/** Race a promise against the clock. The loser keeps running; the caller has already moved on. */
export function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS, what = '') {
  if (!ms || ms <= 0) return Promise.resolve(promise);
  let timer = null;
  const clock = new Promise((_, reject) => { timer = setTimeout(() => reject(new FilesTimeout(what, ms)), ms); });
  return Promise.race([Promise.resolve(promise), clock]).finally(() => clearTimeout(timer));
}

/* ─── directories ─────────────────────────────────────────────────────────────────────────────── */
/** Names only, never bytes: [{ name, kind: 'file' | 'directory' }], sorted by name. */
export async function listDir(dir, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const read = async () => {
    const out = [];
    for await (const entry of dir.values()) out.push({ name: entry.name, kind: entry.kind });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };
  return withTimeout(read(), timeoutMs, 'listing ' + (dir && dir.name));
}
/** A child directory handle, or null when absent (create: false) — never a throw for "not there". */
export async function getDir(dir, name, { create = false } = {}) {
  try { return await dir.getDirectoryHandle(name, { create }); }
  catch (e) { if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return null; throw e; }
}
/** Ensure a nested path exists ("flextext" or "a/b/c"), returning the deepest handle. */
export async function ensureDir(dir, path) {
  let cur = dir;
  for (const part of String(path || '').split('/').filter(Boolean)) cur = await cur.getDirectoryHandle(part, { create: true });
  return cur;
}
/** A child file handle, or null when absent. */
export async function getFileEntry(dir, name) {
  try { return await dir.getFileHandle(name); }
  catch (e) { if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return null; throw e; }
}

/* ─── files ───────────────────────────────────────────────────────────────────────────────────── */
/* Metadata WITHOUT bytes: size and modified time from the File object, which the browser answers
 * from its own index. A placeholder in a cloud folder answers this too; only reading its bytes
 * would block. `available:false` means the answer did not come in time — never a hang. */
export async function statFile(dir, name, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const fh = await withTimeout(getFileEntry(dir, name), timeoutMs, 'finding ' + name);
  if (!fh) return null;
  try {
    const f = await withTimeout(fh.getFile(), timeoutMs, 'stat ' + name);
    return { name, size: f.size, modified: f.lastModified || 0, type: f.type || '', available: true };
  } catch (e) {
    if (e && e.code === 'FILES_TIMEOUT') return { name, size: 0, modified: 0, type: '', available: false };
    throw e;
  }
}
/* The bytes, as 'blob' | 'text' | 'arrayBuffer'. A cloud placeholder that cannot deliver in time
 * throws FilesTimeout, and the caller marks the file "not downloaded yet" rather than waiting. */
export async function readFile(dir, name, { as = 'blob', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const fh = await withTimeout(getFileEntry(dir, name), timeoutMs, 'finding ' + name);
  if (!fh) return null;
  const f = await withTimeout(fh.getFile(), timeoutMs, 'opening ' + name);
  if (as === 'blob') return f;
  const bytes = as === 'text' ? f.text() : f.arrayBuffer();
  return withTimeout(bytes, timeoutMs, 'reading ' + name);
}
/* Written through a writable stream and committed on close — Chromium writes to a temporary file
 * and swaps it in, so a crash mid-write leaves the old file, never a torn one. `data` is a Blob,
 * a string, or an ArrayBuffer/typed array. */
export async function writeFile(dir, name, data, { timeoutMs = 0 } = {}) {
  const write = async () => {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try { await w.write(data); } catch (e) { try { await w.abort(); } catch { /* already failing */ } throw e; }
    await w.close();
    return true;
  };
  return timeoutMs ? withTimeout(write(), timeoutMs, 'writing ' + name) : write();
}
/** Whether two handles point at the same entry (a remembered folder vs. a freshly picked one). */
export async function sameEntry(a, b) {
  if (!a || !b) return false;
  try { return await a.isSameEntry(b); } catch { return false; }
}
