/* db.js — IndexedDB document library with autosave. */

const DB_NAME = 'flextext-editor';
const STORE = 'docs';
const MEDIA = 'media'; // audio blobs + waveform peaks, keyed by doc id

// Cross-window/app live-sync. All same-origin apps (editor, recorder, researcher) share one
// BroadcastChannel: a storage mutation here notifies the OTHER open windows to re-render, so a new
// or changed text — or a pushed setting — shows up everywhere with no manual refresh. One shared
// instance per window means a window never receives its OWN post (no redundant self-re-render).
const liveBC = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('flextext-live') : null;
export function broadcastLive(kind) { try { if (liveBC) liveBC.postMessage({ kind }); } catch { /* noop */ } }
export function onLive(fn) { if (liveBC) liveBC.onmessage = (e) => { try { fn(e.data && e.data.kind); } catch { /* noop */ } }; }

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('modified', 'modified');
      }
      if (!db.objectStoreNames.contains(MEDIA)) {
        db.createObjectStore(MEDIA); // out-of-line keys (doc id)
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise = null;
function getDB() {
  if (!dbPromise) dbPromise = open();
  return dbPromise;
}

// Close the cached connection so a full erase (eraseAllData) can deleteDatabase without onblocked.
export function close() {
  if (!dbPromise) return;
  const p = dbPromise; dbPromise = null;
  p.then((db) => { try { db.close(); } catch { /* noop */ } }).catch(() => {});
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function listDocs() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = tx(db, 'readonly').openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        const { id, title, modified, created, segCount, glossed } = cur.value;
        out.push({ id, title, modified, created, segCount, glossed });
        cur.continue();
      } else {
        out.sort((a, b) => (b.modified || 0) - (a.modified || 0));
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getDoc(id) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function putDoc(record) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').put(record);
    req.onsuccess = () => { broadcastLive('docs'); resolve(); };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteDoc(id) {
  const db = await getDB();
  await deleteMedia(id).catch(() => {});
  await deleteMedia('partial:' + id).catch(() => {}); // any in-progress download
  await deleteMedia('upload:' + id).catch(() => {});  // any in-progress upload
  await deleteMedia('consent:' + id).catch(() => {}); // recorded verbal assent
  await deleteMedia('consent-prompt:' + id).catch(() => {}); // frozen consent-prompt copy
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').delete(id);
    req.onsuccess = () => { broadcastLive('docs'); resolve(); };
    req.onerror = () => reject(req.error);
  });
}

/* ---- media (audio) attached to a doc ---- */

function mediaTx(db, mode) {
  return db.transaction(MEDIA, mode).objectStore(MEDIA);
}

// record: { blob, name, mimeType, sourceUrl, peaks, duration }
export async function putMedia(docId, record) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = mediaTx(db, 'readwrite').put(record, docId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getMedia(docId) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = mediaTx(db, 'readonly').get(docId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteMedia(docId) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = mediaTx(db, 'readwrite').delete(docId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function listMediaKeys() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = mediaTx(db, 'readonly').getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
