/* db.js — IndexedDB document library with autosave. */

const DB_NAME = 'flextext-editor';
const STORE = 'docs';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('modified', 'modified');
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
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function deleteDoc(id) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
