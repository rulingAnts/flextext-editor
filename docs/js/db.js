/* db.js — IndexedDB document library with autosave. */

// Pure, imports nothing, and already in every SHELL that lists this file — so no new precache path.
import { storableSegments } from './segments.js';

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
        // pendingFlextext rides along (v332) so the list can show "still arriving" and refuse to
        // open a text whose content is in flight -- without a second read per row.
        // pendingAudio rides along too: renderDocList's assigned-audio arrival branch (progress
        // bar + ticker) keys on it, and without it in this projection that branch was DEAD — an
        // arriving recording showed a plain row, no bar, ever (found auditing issue #11's list).
        // The consent fields ride along for the same reason as the two above: the Consent
        // Collector groups by speaker and shows a per-text permission state, and reading the whole
        // record per row to learn them would be a second read for every text on the device.
        // consentReceipt is carried whole because the state depends on what was COLLECTED
        // (responseTypes), not merely on the receipt existing — a receipt promising a recorded
        // answer whose clip never arrived is incomplete, and only the receipt says so.
        const { id, title, modified, created, segCount, glossed, done, pendingFlextext, pendingAudio,
          consentSpeaker, consentReceipt, consentClip, doc, matchDraft,
          assigned, audioLocked, uploadedFileId, uploadedModified, audioError } = cur.value;
        /* ⚠ spanCount IS NOT segCount. segCount is docStats' count of PHRASES — how much text the
         * doc holds. The Audio Segmenter needs the count of AUDIO SPANS, which is a different
         * number living in a different place (doc.segments, the field the Cut tab writes), and
         * reading segCount for it made a text with 30 typed lines and no cuts report itself as
         * fully segmented. Counted here from the record the cursor has already deserialized, so it
         * costs nothing, and counted ALIGNED-only because a timePending span is a placeholder for
         * a cut nobody has made yet. ⚠ And a text whose spans are ALL estimates counts as uncut
         * (v717 — app.js docIsUncut's rule): an even spread is a guess at where lines might go, not
         * segmenting anyone did. `timeEstimated` is the derived copy every v717 operation keeps equal
         * to isEstimate, so this projection needs no import. */
        const segs = (doc && Array.isArray(doc.segments)) ? doc.segments : [];
        const aligned = segs.filter((s) => s && !s.timePending
          && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
        const spanCount = aligned.every((s) => s.timeEstimated) ? 0 : aligned.length;
        out.push({ id, title, modified, created, segCount, glossed, done, pendingFlextext: !!pendingFlextext, pendingAudio: pendingAudio || '',
          consentSpeaker: consentSpeaker || '', consentReceipt: consentReceipt || null,
          consentClip: consentClip || '', spanCount,
          // Where the text came from and whether the researcher has it — read by the satellites'
          // lists, which have no other way to say "sent". Already deserialized; costs nothing.
          assigned: !!assigned, audioLocked: !!audioLocked, audioError: audioError || '',
          uploadedFileId: uploadedFileId || null, uploadedModified: uploadedModified || 0,
          // ⚠ A FLAG, never the draft itself: it holds every line's words, and the list would then
          // carry the whole corpus in memory to render one caption.
          hasDraft: !!(matchDraft && Array.isArray(matchDraft.spans)) });
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

/* WHAT A RECORD LOOKS LIKE IN STORAGE (v718 — plans/time-gaps-and-estimates.md §2, case 5, BM1).
 *
 * Placeholders — untimed lines drawn evenly in their gap (segments.js spreadUntimed) — live in the open
 * record's doc.segments, in memory, so every tab and ticker sees one array. They must never be stored:
 * a stored placeholder would be indistinguishable from a time somebody set, and would go out in the
 * next export as one. So they are removed HERE, the one door every write passes through — all of
 * putDoc's callers (persist, saveQuiet, the remembered tab, the Segmenter's draft and Done, downloads,
 * merges) — rather than at each of them, where the next caller added would be the one that forgot.
 *
 * ⚠ ON A SHALLOW COPY. The record passed in is very often `current`, the open text itself: stripping
 * it in place would make every placeholder vanish from the screen at the next autosave. Only the doc
 * and the Segmenter's draft are copied, and only their span arrays are rebuilt; everything else is the
 * caller's own object, as before. The draft's rows keep their own shape ({ start: 0, end: 0 }). */
export function storableRecord(record) {
  if (!record || typeof record !== 'object') return record;
  let out = record;
  if (record.doc && Array.isArray(record.doc.segments)) {
    out = { ...out, doc: { ...record.doc, segments: storableSegments(record.doc.segments) } };
  }
  if (record.matchDraft && Array.isArray(record.matchDraft.spans)) {
    out = { ...out, matchDraft: { ...record.matchDraft, spans: storableSegments(record.matchDraft.spans, { matcher: true }) } };
  }
  return out;
}

export async function putDoc(record) {
  const db = await getDB();
  const stored = storableRecord(record);   // ⚠ the ONE chokepoint — see storableRecord
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').put(stored);
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

/* WHICH DOCS HAVE A RECORDING ON THIS DEVICE — the one authoritative answer, in one transaction.
 *
 * ⚠ THERE IS NO FIELD FOR THIS ON THE DOC RECORD. `rec.mediaName` looks like one and is never
 * written by anything: every mediaName in the sources is a local export option. The Audio
 * Segmenter gated its Open button on it, so every text on a real device reported "no recording
 * attached" and could not be opened at all — the app was unusable on anything but a hand-made
 * fixture. `audioSource` is closer but lies in the other direction: it survives on the record
 * after the media is deleted, and it is absent on texts stored before it existed.
 *
 * The media store IS the fact. getAllKeys is one read for the whole library rather than a getMedia
 * per row, and the doc's own recording is stored under the bare doc id (consent clips, prompt
 * clips and the derived segmentation WAV all carry a `<kind>:` prefix, so they cannot be mistaken
 * for one). */
export async function mediaKeys() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = mediaTx(db, 'readonly').getAllKeys();
    req.onsuccess = () => resolve(new Set((req.result || []).filter((k) => typeof k === 'string' && !k.includes(':'))));
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
