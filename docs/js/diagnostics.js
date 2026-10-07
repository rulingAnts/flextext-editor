/* diagnostics.js — THE DIAGNOSTIC EXPORT: everything this app holds on this device, in one ZIP,
 * for a researcher or developer to read when a device is behaving in a way nobody can explain from
 * the outside.
 *
 * WHY THIS EXISTS (Seth, 2026-10-07). A researcher sent a coworker an audio file and the .flextext
 * he had segmented in the editor; on the coworker's laptop the Baseline tab showed the classic
 * textarea instead of the strips. Two screenshots over WhatsApp was all the evidence there was, and
 * the answer — one stored setting, `segmentation: false` — was invisible in both of them. The
 * device's report to the panel carries a settings snapshot, but only for a PAIRED device, only the
 * keys the panel knows to ask for, and only while the device can reach the worker. This file is the
 * other half: a dump the person holding the device can produce in a village with no signal and send
 * by whatever means they have, with every stored value in it, not just the ones somebody predicted
 * would matter.
 *
 * WHAT IS IN THE ZIP
 *   diagnostics.json  — the manifest: app + engine version, the page's origin and shell, the browser,
 *                       storage quota and use, the service worker and caches, the FULL settings blob,
 *                       every localStorage and sessionStorage entry, the IndexedDB inventory (texts,
 *                       recordings, side stores), the upload queue, and a list of every step that
 *                       failed while gathering. SECRETS REDACTED (see below).
 *   docs/NNN-<title>.json      — each text's complete stored record (the doc, its time spans, its
 *                                upload state) — the truth, byte for byte.
 *   docs/NNN-<title>.flextext  — the same text serialised the way Save does, so the work is
 *                                recoverable in FLEx or another editor without this app.
 *   media/…                    — the recordings and every derived or pending audio record, named by
 *                                kind (optional: a researcher sending a dump over a chat app wants
 *                                the 40 KB version).
 *   keys.json                  — ONLY when the person explicitly asked for the keys and confirmed the
 *                                warning: the raw values of every entry that had something redacted.
 *
 * ⚠ SECRETS ARE REDACTED BY DEFAULT, AND THE DEFAULT IS THE WHOLE DESIGN. The sync session holds
 * the install secret this device authenticates with and the Ki wrapped to its key; the researcher
 * auth entry holds a session token. A dump that carried those by accident would let whoever received
 * it act as this device toward the researcher's backend. So every stored value is parsed and any
 * field whose NAME says credential (secret, token, password, wrappedKey, privateKey…) is replaced by
 * `{ $redacted, bytes, sha256_8 }`: the fingerprint lets two dumps be compared ("same credential or
 * not?") without ever containing the credential. A plain-string entry under a key whose NAME says
 * credential is redacted whole. Unknown future keys are covered by the same name rules, which is the
 * point of matching names rather than listing keys.
 *
 * The install PRIVATE key cannot be exported at all — crypto.js generates it non-extractable — so
 * even keys.json only ever records that it is present. That is correct, not a gap: a device's
 * private key has nowhere legitimate to go.
 *
 * ⚠ NO STEP MAY TAKE THE EXPORT DOWN WITH IT. A device whose IndexedDB throws on one record is
 * exactly the device somebody wants a dump of. Every gather step is wrapped; a failure is recorded in
 * `errors` and the rest of the file is still built. The same rule as the panel's Download-all.
 *
 * PURE CORE, INJECTED EDGES. Redaction, naming, summaries and the manifest are plain functions on
 * plain data (node-testable, test/diagnostics-export.test.mjs). The browser gathering takes its
 * storage and serialiser through `deps` and reads only globals that it feature-detects, so the same
 * module runs in every shell of the suite — the editor, the satellites, and the panel's own origin.
 *
 * ⚠ SHELL ENTRY. This module is a static import of app.js, so it is listed in the editor's sw.js
 * SHELL and in every offline satellite's (test/shells-precache-startup-modules.test.mjs walks the
 * import graph). A diagnostic export must work offline: the device that needs one most is the one
 * that cannot reach anything. */

import { makeZip } from './zip.js';

export const DIAG_FORMAT = 1;

/* ---------------- what is a secret ---------------- */

/* Field names, anywhere inside a stored JSON value, whose contents are a credential. Matched on the
 * NAME so a shape nobody has written yet is still covered. `wrappedKey` is ciphertext that only the
 * device's private key can open, and it still goes: key material is key material. */
export const SECRET_FIELD_RE = /secret|token|passw|credential|private[_-]?key|wrapped[_-]?key|api[_-]?key/i;
/* Storage KEY names that mark a non-JSON value as a credential in its entirety. */
export const SECRET_KEY_RE = /secret|token|auth|passw|credential/i;

export function isSecretField(name) { return SECRET_FIELD_RE.test(String(name || '')); }
export function isSecretKey(key) { return SECRET_KEY_RE.test(String(key || '')); }

/* SHA-256, first 8 hex characters. WebCrypto in the browser and in node ≥ 19 alike. A fingerprint is
 * for telling two values apart, never for recovering one. */
export async function webFingerprint(str) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) return 'unavailable';
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
  return [...new Uint8Array(buf)].slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function marker(value, fingerprint) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return { $redacted: true, bytes: s.length, sha256_8: await fingerprint(s) };
}

/* Replace every secret-named field in a parsed value, at any depth. Returns the redacted copy and
 * whether anything was replaced. Arrays are walked; primitives pass through. */
export async function redactDeep(value, fingerprint = webFingerprint) {
  let found = false;
  const walk = async (v) => {
    if (Array.isArray(v)) { const out = []; for (const x of v) out.push(await walk(x)); return out; }
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (isSecretField(k) && x !== null && x !== undefined && x !== '') { out[k] = await marker(x, fingerprint); found = true; }
        else out[k] = await walk(x);
      }
      return out;
    }
    return v;
  };
  return { value: await walk(value), found };
}

/* One storage entry → what the manifest shows for it. JSON values are parsed so the manifest reads
 * as structure rather than as an escaped string, then deep-redacted; a non-JSON value under a
 * credential-named key is redacted whole. `secret` is true when the ORIGINAL must go to keys.json. */
export async function redactEntry(key, raw, fingerprint = webFingerprint) {
  let parsed;
  let isJson = false;
  try { parsed = JSON.parse(raw); isJson = parsed !== null && typeof parsed === 'object'; } catch { /* a plain string */ }
  if (isJson) {
    const { value, found } = await redactDeep(parsed, fingerprint);
    return { value, secret: found };
  }
  if (isSecretKey(key) && raw !== '' && raw !== null && raw !== undefined) return { value: await marker(raw, fingerprint), secret: true };
  return { value: raw, secret: false };
}

/* A whole storage area ({ key: rawString }) → { redacted: { key: shown }, secrets: { key: raw } }.
 * `secrets` holds the untouched originals of only the entries that had something redacted — the
 * content of keys.json when, and only when, the person asked for it. */
export async function redactStorage(entries, fingerprint = webFingerprint) {
  const redacted = {};
  const secrets = {};
  for (const [k, raw] of Object.entries(entries || {})) {
    const r = await redactEntry(k, raw, fingerprint);
    redacted[k] = r.value;
    if (r.secret) secrets[k] = raw;
  }
  return { redacted, secrets };
}

/* ---------------- naming ---------------- */

export function safeName(s, max = 60) {
  const out = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return out || 'untitled';
}

const MIME_EXT = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'application/zip': 'zip', 'application/json': 'json' };
export function extFor(name, mimeType) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
  if (m) return m[1].toLowerCase();
  const mt = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return MIME_EXT[mt] || 'bin';
}

/* Media keys carry their kind as a prefix (`segwav:<docId>`, `consent:<docId>`…); the bare doc id is
 * the recording itself. See db.js mediaKeys. */
export function mediaKind(key) {
  const k = String(key || '');
  const i = k.indexOf(':');
  return i < 0 ? { kind: 'recording', docId: k } : { kind: k.slice(0, i), docId: k.slice(i + 1) };
}

const pad3 = (n) => String(n).padStart(3, '0');

/* ---------------- summaries ---------------- */

/* The same question applyBaseline asks (app.js docCarriesTime): does this text carry time alignment,
 * either as working spans or as FLEx offsets on its phrases? This is the field that explains a
 * "segmentation does not show" report in one glance. */
export function docAligned(doc) {
  if (!doc) return false;
  return (doc.segments || []).length > 0
    || (doc.paragraphs || []).some((p) => (p.segments || []).some((sg) => sg && sg.attrs && sg.attrs['begin-time-offset'] != null));
}

export function docSummary(rec) {
  const doc = (rec && rec.doc) || {};
  const paras = Array.isArray(doc.paragraphs) ? doc.paragraphs : [];
  let phrases = 0, texted = 0, words = 0, glossed = 0;
  for (const p of paras) for (const s of (p.segments || [])) {
    phrases++;
    if ((s.baseline || '').trim() || (s.words || []).length) texted++;
    for (const w of (s.words || [])) { if (!w.punct) { words++; if (w.gls) glossed++; } }
  }
  const spans = Array.isArray(doc.segments) ? doc.segments : [];
  const pending = spans.filter((s) => !s || s.timePending || !Number.isFinite(s.start) || !Number.isFinite(s.end)).length;
  return {
    id: rec.id, title: rec.title || '', created: rec.created || 0, modified: rec.modified || 0,
    done: !!rec.done, assigned: !!rec.assigned, audioLocked: !!rec.audioLocked,
    pendingAudio: rec.pendingAudio || '', pendingFlextext: !!rec.pendingFlextext, audioError: rec.audioError || '',
    uploadedFileId: rec.uploadedFileId || null, uploadedModified: rec.uploadedModified || 0,
    driveFolderId: rec.driveFolderId || null, mediaGuid: rec.mediaGuid || null, audioSource: rec.audioSource || '',
    vernLang: doc.vernLang || '', analLang: doc.analLang || '',
    paragraphs: paras.length, phrases, textedPhrases: texted, words, glossedWords: glossed,
    aligned: docAligned(doc), spans: spans.length, spansPending: pending,
    mediaXML: Array.isArray(doc.mediaXML) ? doc.mediaXML.length : 0,
  };
}

export function mediaSummary(key, rec) {
  const { kind, docId } = mediaKind(key);
  const blob = rec && rec.blob;
  return {
    key, kind, docId,
    name: (rec && rec.name) || '', mimeType: (rec && (rec.mimeType || (blob && blob.type))) || '',
    size: blob && typeof blob.size === 'number' ? blob.size : null,
    duration: rec && Number.isFinite(rec.duration) ? rec.duration : null,
    hasPeaks: !!(rec && rec.peaks), sourceUrl: (rec && rec.sourceUrl) || '',
    derived: !!(rec && rec.derived), srcName: (rec && rec.srcName) || '',
  };
}

/* ---------------- the manifest ---------------- */

export function buildManifest(g) {
  return {
    format: DIAG_FORMAT,
    generated: g.now || new Date().toISOString(),
    app: g.app || '', engineVersion: g.engineVersion || '', buildTag: g.buildTag || '', lang: g.lang || '',
    includesRecordings: !!g.includesRecordings,
    includesKeys: !!g.includesKeys,
    page: g.page || {},
    storage: g.storage || {},
    serviceWorker: g.serviceWorker || {},
    caches: g.caches || null,
    cachedApps: g.cachedApps || null,
    settings: g.settings || {},
    localStorage: g.localStorage || {},
    sessionStorage: g.sessionStorage || {},
    indexedDB: g.indexedDB || {},
    uploadQueue: g.uploadQueue || [],
    errors: g.errors || [],
  };
}

/* The zip's entries, from already-gathered parts. Strings are UTF-8 encoded by makeZip; media data
 * is the stored Blob. Names are unique by construction (index prefix) so two texts with one title
 * cannot overwrite each other. */
export function planEntries({ manifest, docs = [], media = [], keys = null }) {
  const entries = [{ name: 'diagnostics.json', data: JSON.stringify(manifest, null, 1) }];
  docs.forEach((d, i) => {
    const base = `docs/${pad3(i + 1)}-${safeName(d.rec.title || d.rec.id)}`;
    entries.push({ name: base + '.json', data: JSON.stringify(d.rec, null, 1) });
    if (typeof d.xml === 'string') entries.push({ name: base + '.flextext', data: d.xml });
  });
  media.forEach((m, i) => {
    const { kind } = mediaKind(m.key);
    const dir = kind === 'recording' ? 'media' : `media/${safeName(kind, 20)}`;
    entries.push({ name: `${dir}/${pad3(i + 1)}-${safeName(m.title || m.key)}.${extFor(m.rec.name, m.rec.mimeType)}`, data: m.rec.blob });
  });
  if (keys) entries.push({ name: 'keys.json', data: JSON.stringify(keys, null, 1) });
  return entries;
}

export function zipFileName(app, engineVersion, now = new Date()) {
  const d = now.toISOString().replace(/[-:]/g, '').replace(/T(\d{4})\d{2}\.\d+Z$/, '-$1');
  return `flextext-diagnostics-${safeName(app || 'app', 20)}-${safeName(engineVersion || 'v', 12)}-${d}.zip`;
}

/* ---------------- gathering (browser) ---------------- */

const w = () => (typeof globalThis !== 'undefined' ? globalThis : {});

function storageEntries(area) {
  const out = {};
  try {
    for (let i = 0; i < area.length; i++) {
      const k = area.key(i);
      if (k === null) continue;
      out[k] = area.getItem(k);
    }
  } catch { /* private mode: whatever was read stands */ }
  return out;
}

/* Side stores other modules own (the sync private key, an unsent crowd package, remembered folders).
 * ⚠ OPENED ONLY WHEN KNOWN TO EXIST: indexedDB.open(name) on a name that does not exist CREATES an
 * empty database, which a diagnostic read must never do. Firefox has no indexedDB.databases(), and
 * there the counts are reported as unknown rather than guessed. */
async function sideStoreKeys(name, store) {
  const idb = w().indexedDB;
  const db = await new Promise((res, rej) => { const r = idb.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked')); });
  try {
    if (!db.objectStoreNames.contains(store)) return { store, present: false, keys: [] };
    const keys = await new Promise((res, rej) => { const r = db.transaction(store, 'readonly').objectStore(store).getAllKeys(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); });
    return { store, present: true, keys: keys.map((k) => String(k)) };
  } finally { try { db.close(); } catch { /* noop */ } }
}

/* Just the size of what "Include the recordings" would add — for the checkbox label, before the
 * person decides. Blobs read from IndexedDB know their size without their bytes being touched. */
export async function estimateMediaBytes(db) {
  let total = 0;
  const keys = await db.listMediaKeys().catch(() => []);
  for (const k of keys) {
    const rec = await db.getMedia(k).catch(() => null);
    if (rec && rec.blob && typeof rec.blob.size === 'number') total += rec.blob.size;
  }
  return total;
}

/* deps: { db, serialize(rec) → string, listCachedApps() → Promise, nativePlatform(), nativeEngineInfo(),
 *         app, engineVersion, buildTag, lang, settings }
 * opts: { includeRecordings, includeKeys }
 * onProgress(stage, i, n) — stage ∈ 'device' | 'texts' | 'media' | 'zip'. */
export async function gatherDiagnostics(deps, opts = {}, onProgress = () => {}) {
  const errors = [];
  const fail = (where, err) => { errors.push({ where, message: String((err && err.message) || err || 'unknown') }); };
  const step = async (where, fn, fallback = null) => { try { return await fn(); } catch (err) { fail(where, err); return fallback; } };
  const g = w();
  const nav = g.navigator || {};
  const loc = g.location || {};
  const now = new Date();
  onProgress('device', 0, 0);

  const page = {
    origin: loc.origin || '', path: loc.pathname || '', hash: loc.hash ? '(present)' : '',
    standalone: !!(g.matchMedia && (() => { try { return g.matchMedia('(display-mode: standalone)').matches; } catch { return false; } })()),
    online: typeof nav.onLine === 'boolean' ? nav.onLine : null,
    ua: nav.userAgent || '', language: nav.language || '', languages: Array.isArray(nav.languages) ? nav.languages.slice(0, 6) : [],
    platform: await step('nativePlatform', () => deps.nativePlatform ? deps.nativePlatform() : null),
    nativeEngine: await step('nativeEngineInfo', () => deps.nativeEngineInfo ? deps.nativeEngineInfo() : null),
    memoryGB: nav.deviceMemory || null, cores: nav.hardwareConcurrency || null,
    screen: g.screen ? { w: g.screen.width, h: g.screen.height, dpr: g.devicePixelRatio || 1 } : null,
    timezone: await step('timezone', () => Intl.DateTimeFormat().resolvedOptions().timeZone, ''),
  };
  const storage = {
    estimate: await step('storage.estimate', async () => (nav.storage && nav.storage.estimate) ? await nav.storage.estimate().then((e) => ({ usage: e.usage, quota: e.quota })) : null),
    persisted: await step('storage.persisted', async () => (nav.storage && nav.storage.persisted) ? await nav.storage.persisted() : null),
  };
  const serviceWorker = await step('serviceWorker', async () => {
    const sw = nav.serviceWorker;
    if (!sw) return { supported: false };
    const regs = sw.getRegistrations ? await sw.getRegistrations() : [];
    return {
      supported: true,
      controller: sw.controller ? sw.controller.scriptURL : null,
      registrations: regs.map((r) => ({ scope: r.scope, active: r.active ? r.active.scriptURL : null, waiting: !!r.waiting, installing: !!r.installing })),
    };
  }, null);
  const cacheNames = await step('caches', async () => (g.caches ? await g.caches.keys() : null), null);
  const cachedApps = await step('cachedApps', async () => (deps.listCachedApps ? await deps.listCachedApps() : null), null);

  const ls = await step('localStorage', () => storageEntries(g.localStorage), {});
  const ss = await step('sessionStorage', () => storageEntries(g.sessionStorage), {});
  const lsR = await redactStorage(ls);
  const ssR = await redactStorage(ss);
  const settingsR = await redactDeep(deps.settings || {});

  // ---- the editor's IndexedDB: texts, then recordings ----
  const db = deps.db;
  const docs = [];
  const docRows = [];
  const metas = await step('db.listDocs', () => db.listDocs(), []);
  for (let i = 0; i < metas.length; i++) {
    onProgress('texts', i + 1, metas.length);
    const meta = metas[i];
    const rec = await step(`db.getDoc ${meta.id}`, () => db.getDoc(meta.id), null);
    if (!rec) { docRows.push({ id: meta.id, title: meta.title || '', unreadable: true }); continue; }
    const row = await step(`docSummary ${meta.id}`, () => docSummary(rec), { id: rec.id, title: rec.title || '', unreadable: true });
    const xml = deps.serialize ? await step(`serialize ${meta.id}`, () => deps.serialize(rec), null) : null;
    row.file = `docs/${pad3(docs.length + 1)}-${safeName(rec.title || rec.id)}.json`;
    row.flextext = typeof xml === 'string';
    docRows.push(row);
    docs.push({ rec, xml });
  }
  const mediaRows = [];
  const media = [];
  const mkeys = await step('db.listMediaKeys', () => db.listMediaKeys(), []);
  const titleOf = new Map(docRows.map((r) => [r.id, r.title]));
  for (let i = 0; i < mkeys.length; i++) {
    onProgress('media', i + 1, mkeys.length);
    const key = String(mkeys[i]);
    const rec = await step(`db.getMedia ${key}`, () => db.getMedia(key), null);
    const row = rec ? mediaSummary(key, rec) : { key, ...mediaKind(key), unreadable: true };
    if (rec && rec.blob && opts.includeRecordings) {
      const { kind, docId } = mediaKind(key);
      row.file = `${kind === 'recording' ? 'media' : 'media/' + safeName(kind, 20)}/${pad3(media.length + 1)}-${safeName(titleOf.get(docId) || key)}.${extFor(rec.name, rec.mimeType)}`;
      media.push({ key, rec, title: titleOf.get(docId) || '' });
    }
    mediaRows.push(row);
  }
  for (const r of docRows) r.hasMedia = mediaRows.some((m) => m.kind === 'recording' && m.docId === r.id && !m.unreadable);

  // ---- side stores, only where indexedDB.databases() can say they exist ----
  const idb = g.indexedDB;
  const dbNames = await step('indexedDB.databases', async () => (idb && idb.databases ? (await idb.databases()).map((d) => ({ name: d.name, version: d.version })) : null), null);
  const side = {};
  if (Array.isArray(dbNames)) {
    const has = (n) => dbNames.some((d) => d.name === n);
    side.sync = has('flextext-sync') ? await step('flextext-sync', async () => { const r = await sideStoreKeys('flextext-sync', 'keys'); return { installPrivateKey: r.keys.includes('install-private-key'), exportable: false, keys: r.keys }; }, null) : { installPrivateKey: false, absent: true };
    side.crowd = has('flextext-crowd') ? await step('flextext-crowd', async () => ({ pending: (await sideStoreKeys('flextext-crowd', 'pending')).keys.length }), null) : { absent: true };
    side.files = has('flextext-files') ? await step('flextext-files', async () => ({ handles: (await sideStoreKeys('flextext-files', 'handles')).keys }), null) : { absent: true };
  } else {
    side.note = 'indexedDB.databases() unavailable in this browser: side stores not inspected';
  }

  const uploadQueue = mediaRows.filter((m) => m.kind === 'upload').map((m) => ({ docId: m.docId, name: m.name, size: m.size }));

  const manifest = buildManifest({
    now: now.toISOString(), app: deps.app, engineVersion: deps.engineVersion, buildTag: deps.buildTag, lang: deps.lang,
    includesRecordings: !!opts.includeRecordings, includesKeys: !!opts.includeKeys,
    page, storage, serviceWorker, caches: cacheNames, cachedApps,
    settings: settingsR.value, localStorage: lsR.redacted, sessionStorage: ssR.redacted,
    indexedDB: { databases: dbNames, docs: docRows, media: mediaRows, ...side },
    uploadQueue, errors,
  });
  const keys = opts.includeKeys
    ? { warning: 'CREDENTIALS. Whoever holds this file can act as this device toward its researcher. Delete it when the question is answered.',
        localStorage: lsR.secrets, sessionStorage: ssR.secrets,
        settingsRaw: settingsR.found ? deps.settings : undefined,
        installPrivateKey: 'non-extractable by design; cannot be exported' }
    : null;
  return { manifest, docs, media, keys, name: zipFileName(deps.app, deps.engineVersion, now) };
}

/* Gather, then zip. Throws only what makeZip throws (ZIP_TOO_LARGE); everything else lands in the
 * manifest's `errors`. */
export async function buildDiagnosticsZip(deps, opts = {}, onProgress = () => {}) {
  const got = await gatherDiagnostics(deps, opts, onProgress);
  onProgress('zip', 0, 0);
  const entries = planEntries(got);
  const blob = await makeZip(entries);
  return { blob, name: got.name, manifest: got.manifest, entries: entries.length };
}
