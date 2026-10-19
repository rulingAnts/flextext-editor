/* recover.js — find FlexText's storage among a set of files and turn it into texts.
 *
 * Input is a flat list of files with relative paths, however they were picked: a folder chosen in
 * the browser, a folder dropped on the page, or (in tests) a directory read from disk. The list can
 * be a whole browser profile, just its IndexedDB folder, or a copy of either on a USB drive; this
 * module finds the parts it needs by their names and ignores everything else.
 *
 *   <origin>.indexeddb.leveldb/   the database files       (or WebStorage/<n>/IndexedDB/indexeddb.leveldb)
 *   <origin>.indexeddb.blob/      recordings and other Blobs, one plain file each
 *   Local Storage/leveldb/        every site's localStorage — the device settings live here
 *
 * Nothing here touches the DOM, so node runs it against real Chrome files in the tests.
 */
import { readIndexedDb, decodeEntry } from './chromium-idb.js';
import { readLocalStorage } from './local-storage.js';

export const SETTINGS_KEY = 'flextext-ws-settings';      // app.js SETTINGS_KEY
const EDITOR_DB = 'flextext-editor';                    // db.js DB_NAME
const DOCS = 'docs';
const MEDIA = 'media';

/* <scheme>_<host>_<port> (Chromium's origin identifier, also the folder name) → an origin URL.
 * Port 0 means the scheme's default. A storage-key suffix ("@1", "^…") is dropped. */
export function originFromIdentifier(id) {
  const m = /^([a-z][a-z0-9+.-]*)_(.+)_(\d+)$/i.exec(String(id || '').split(/[@^]/)[0]);
  if (!m) return String(id || '');
  return `${m[1]}://${m[2]}${m[3] !== '0' ? ':' + m[3] : ''}`;
}

/* Which suite app owned an origin. Only used for labels and for the one export rule that depends
 * on the app: the Audio Segmenter IS segmentation mode (app.js segmentationEnabled). */
export function appForOrigin(origin) {
  const host = String(origin || '').replace(/^[a-z]+:\/\//i, '').replace(/:\d+$/, '');
  const pick = (key, label) => ({ key, label });
  if (/segmenter/i.test(host)) return pick('segmenter', 'Flextext Audio Segmenter');
  if (/(^|[.-])record(er)?([.-]|$)/i.test(host)) return pick('recorder', 'Flextext Recorder');
  if (/consent/i.test(host)) return pick('consent', 'Flextext Consent Collector');
  if (/(^|[.-])pat([.-]|$)|paragraph/i.test(host)) return pick('paragraph', 'Flextext Paragraph Analysis Tool');
  if (/research/i.test(host)) return pick('researcher', 'Flextext Researcher');
  if (/crowd/i.test(host)) return pick('crowd', 'Flextext Crowd Recorder');
  if (/rulingants\.github\.io/i.test(host)) return pick('suite', 'Flextext (editor, recorder and researcher share this site)');
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host)) return pick('editor', 'Flextext (a local development copy)');
  return pick('editor', 'Flextext Editor');
}

function dirOf(path) { const i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); }
function baseOf(path) { const i = path.lastIndexOf('/'); return i < 0 ? path : path.slice(i + 1); }

/* entries: [{ path, size, blob }] — `blob` is a File/Blob (read lazily). */
export async function scanFiles(entries, { onProgress = () => {} } = {}) {
  const problems = [];
  const norm = entries.map((e) => ({ ...e, path: String(e.path).replace(/\\/g, '/').replace(/^\/+/, '') }));
  const byDir = new Map();
  for (const e of norm) {
    const d = dirOf(e.path);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(e);
  }
  const asLdbFiles = (list) => list.map((e) => ({ name: baseOf(e.path), size: e.size, bytes: async () => new Uint8Array(await e.blob.arrayBuffer()) }));

  const idbDirs = [...byDir.keys()].filter((d) => /(^|\/)([^/]+\.)?indexeddb\.leveldb$/i.test(d));
  const lsDirs = [...byDir.keys()].filter((d) => /(^|\/)Local Storage\/leveldb$/i.test(d));

  /* Blob folders: every file under a "*.indexeddb.blob" (or bucket "indexeddb.blob") folder, keyed
   * by its path inside that folder — which is exactly the path chromium-idb.js computes. */
  const blobRoots = new Map();
  for (const e of norm) {
    const m = /^(.*?(?:^|\/)(?:[^/]+\.)?indexeddb\.blob)\/(.+)$/i.exec(e.path);
    if (!m) continue;
    if (!blobRoots.has(m[1])) blobRoots.set(m[1], new Map());
    blobRoots.get(m[1]).set(m[2], e);
  }

  // Device settings for every origin we might need, read once from each Local Storage folder.
  const lsByOrigin = new Map();
  for (const d of lsDirs) {
    onProgress(`Reading settings in ${d}`);
    try {
      const ls = await readLocalStorage(asLdbFiles(byDir.get(d)));
      for (const [origin, kv] of ls.byOrigin) {
        if (kv.has(SETTINGS_KEY) && !lsByOrigin.has(origin)) lsByOrigin.set(origin, { raw: kv.get(SETTINGS_KEY), folder: d });
      }
      for (const p of ls.problems) problems.push(`${d}: ${p}`);
    } catch (e) {
      problems.push(`${d}: could not be read (${e.message})`);
    }
  }

  const areas = [];
  for (const d of idbDirs) {
    onProgress(`Reading ${d}`);
    let idb;
    try { idb = await readIndexedDb(asLdbFiles(byDir.get(d))); }
    catch (e) { problems.push(`${d}: could not be read (${e.message})`); continue; }
    const blobRoot = d.replace(/leveldb$/i, 'blob');
    const blobs = blobRoots.get(blobRoot) || null;
    const readBlob = async (p) => {
      const e = blobs && blobs.get(p);
      return e ? new Uint8Array(await e.blob.arrayBuffer()) : null;
    };
    const blobFile = (p) => (blobs && blobs.get(p)) || null;

    for (const db of idb.databases) {
      if (db.name !== EDITOR_DB) continue;
      const docs = db.stores.find((s) => s.name === DOCS);
      const media = db.stores.find((s) => s.name === MEDIA);
      if (!docs) continue;
      const fromFolder = /^([^/]*\/)*([^/]+)\.indexeddb\.leveldb$/i.exec(d);
      const origin = originFromIdentifier(fromFolder ? fromFolder[2] : db.origin);
      const ls = lsByOrigin.get(origin);
      let settings = {};
      let settingsNote = 'not found — writing systems come from each text';
      if (ls) {
        try { settings = JSON.parse(ls.raw) || {}; settingsNote = `from ${ls.folder}`; }
        catch { settingsNote = 'found but unreadable — writing systems come from each text'; }
      }
      const area = {
        folder: d,
        origin,
        app: appForOrigin(origin),
        settings,
        settingsNote,
        blobFolder: blobs ? blobRoot : null,
        texts: [],
        others: [],
        problems: idb.problems.map((p) => `${d}: ${p}`),
        filesRead: idb.filesRead,
      };

      const mediaByKey = new Map();
      if (media) {
        for (const rec of media.records.values()) {
          if (!rec.current || rec.current.deleted) continue;
          const dec = await decodeEntry(rec.current, rec.externals, readBlob);
          mediaByKey.set(String(rec.key), { key: String(rec.key), value: dec.value, error: dec.error, externals: dec.externals || [] });
        }
      }
      const attach = (k) => {
        const m = mediaByKey.get(k);
        if (!m) return null;
        m.claimed = true;
        return withBlob(m, blobFile);
      };

      for (const rec of docs.records.values()) {
        if (!rec.current || rec.current.deleted) continue;
        let dec = await decodeEntry(rec.current, rec.externals, readBlob);
        let fromOlder = null;
        if (!isUsableDoc(dec.value)) {
          // The newest version will not decode. Fall back to the newest earlier version that does,
          // and say so — never silently.
          for (const o of rec.older) {
            const od = await decodeEntry(o, o.externals || rec.externals, readBlob);
            if (isUsableDoc(od.value)) { fromOlder = { error: dec.error, seq: o.seq }; dec = od; break; }
          }
        }
        const value = dec.value && typeof dec.value === 'object' ? dec.value : null;
        const id = value && value.id != null ? String(value.id) : String(rec.key);
        const text = {
          id,
          key: rec.key,
          record: value,
          decodeError: dec.error || null,
          fromOlder,
          title: value ? String(value.title || (value.doc && value.doc.title) || '') : '',
          modified: value && Number(value.modified) || 0,
          created: value && Number(value.created) || 0,
          done: !!(value && value.done),
          pending: !!(value && value.pendingFlextext),
          stats: docStats(value && value.doc),
          media: attach(id),
          segwav: attach('segwav:' + id),
          consent: attach('consent:' + id),
          consentPrompt: attach('consent-prompt:' + id),
          queued: [],
          area,
        };
        for (const [k, m] of mediaByKey) {
          if (k === 'upload:' + id || k.startsWith('upload:media:' + id)) { m.claimed = true; text.queued.push(withBlob(m, blobFile)); }
        }
        area.texts.push(text);
      }
      for (const m of mediaByKey.values()) {
        if (m.claimed) continue;
        if (/^(partial|asset):/.test(m.key)) continue;              // half-downloaded copies, shared prompt audio
        const w = withBlob(m, blobFile);
        if (w.blob || (m.value && typeof m.value === 'object')) area.others.push(w);
      }
      area.texts.sort((a, b) => (b.modified || 0) - (a.modified || 0));
      areas.push(area);
    }
  }

  return { areas, problems, idbFolders: idbDirs, localStorageFolders: lsDirs };
}

function isUsableDoc(v) {
  return !!(v && typeof v === 'object' && v.doc && Array.isArray(v.doc.paragraphs));
}

/* A media-store record plus the Blob it points at, if that blob's file was among the chosen files. */
function withBlob(m, blobFile) {
  const v = m.value && typeof m.value === 'object' ? m.value : {};
  const ref = v.blob && v.blob.__external ? v.blob : null;
  const info = ref && ref.info;
  const file = info && info.path ? blobFile(info.path) : null;
  const type = (info && info.type) || v.mimeType || v.mime || '';
  return {
    key: m.key,
    value: v,
    error: m.error,
    name: v.name || (info && info.fileName) || '',
    mimeType: v.mimeType || v.mime || (info && info.type) || '',
    size: info ? info.size : 0,
    expected: !!ref,
    blobPath: info ? info.path : null,
    // A fresh Blob with the stored MIME type over the on-disk file — the same bytes, read lazily.
    blob: file ? new Blob([file.blob], { type }) : null,
  };
}

/* Lines / words / glossed words, for the list. Counted from the doc so the numbers are right even
 * for records written before the app stored its own counts. */
export function docStats(doc) {
  const out = { lines: 0, words: 0, glossed: 0, freeTranslations: 0 };
  if (!doc || !Array.isArray(doc.paragraphs)) return out;
  for (const p of doc.paragraphs) {
    let lineHasText = false;
    for (const s of p.segments || []) {
      if (String(s.baseline || '').trim()) lineHasText = true;
      if (String(s.free || '').trim()) out.freeTranslations++;
      for (const w of s.words || []) {
        if (w.punct) continue;
        out.words++;
        if (String(w.gls || '').trim()) out.glossed++;
      }
    }
    if (lineHasText) out.lines++;
  }
  return out;
}

/* The baseline + free translation of each line, for the on-screen preview. */
export function previewLines(doc, max = Infinity) {
  const out = [];
  for (const p of (doc && doc.paragraphs) || []) {
    for (const s of p.segments || []) {
      if (out.length >= max) return out;
      out.push({ baseline: String(s.baseline || ''), free: String(s.free || ''),
        words: (s.words || []).filter((w) => !w.punct).map((w) => ({ txt: String(w.txt || ''), gls: String(w.gls || '') })) });
    }
  }
  return out;
}
