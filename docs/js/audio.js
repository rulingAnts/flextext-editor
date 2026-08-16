/* audio.js — audio attachments for texts: download, storage, and the
 * waveform player shown on the Baseline (Ketik) tab.
 *
 * Audio can arrive three ways:
 *   1. A direct URL to an audio file on any CORS-friendly host.
 *   2. A relay URL (Google Apps Script web app) that returns
 *      JSON { name, mimeType, data: <base64> } — used so researchers can
 *      host recordings in their own Google Drive with normal link sharing.
 *   3. A local file the user picks ("Attach audio…").
 *
 * Blobs and decoded waveform peaks live in IndexedDB (db.js media store),
 * so after the first download everything works offline.
 */

import WaveSurfer from './vendor/wavesurfer.esm.js';
import * as db from './db.js';
// The ONE file-naming rule (v3). A downloaded file is named from the STORY TITLE, never from the
// URL's last path segment — which for a private /v1/textfile/<token> delivery URL is the opaque
// token, and that token used to become the stored media name and poison every derived export.
import { storedMediaName, nameFromDisposition, nameFromUrl } from './seg-exports.js';

/* ---------------- Google Drive link parsing ---------------- */

// Accepts any common Drive share-link shape and returns the file id, or null.
export function driveFileId(text) {
  const s = String(text).trim();
  let m = s.match(/drive\.google\.com\/file\/d\/([\w-]{10,})/);
  if (m) return m[1];
  // v327: drive.USERCONTENT.google.com too — the direct-download host driveLink() itself builds.
  // Without it a pasted download link extracted NO id, so the relay resolve short-circuited and
  // the device dead-fetched the raw URL (no CORS) — the same retry-forever trap as the share-link
  // bug, for audio and flextext assignments alike.
  m = s.match(/drive(?:\.usercontent)?\.google\.com\/(?:open|uc|download)\?[^#]*\bid=([\w-]{10,})/);
  if (m) return m[1];
  if (/^[\w-]{20,}$/.test(s)) return s; // a bare file id
  return null;
}

export function isProbablyUrl(text) {
  return /^https?:\/\//i.test(String(text).trim());
}

/* ---------------- Download ---------------- */

function base64ToBlob(b64, mimeType) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || 'application/octet-stream' });
}

// Refuse a download that clearly won't fit on the device (blob + decoded
// peaks + IndexedDB overhead ≈ 2.5× the transfer size, conservatively).
async function checkSpace(bytesNeeded) {
  if (!bytesNeeded || !navigator.storage?.estimate) return;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (quota && quota - usage < bytesNeeded * 2.5) {
      const e = new Error('Not enough storage space on this device');
      e.storageFull = true;
      throw e;
    }
  } catch (e) {
    if (e.storageFull) throw e; // estimate() itself failing is non-fatal
  }
}

// Fetch audio from a URL. Understands both raw audio responses and the
// relay's JSON-base64 envelope. Streams the body so the caller can show
// progress: onProgress(loadedBytes, totalBytes|0). Returns
// { blob, name, mimeType }.
// `title` (optional) is what the stored file is NAMED after — see storedMediaName. Callers that
// know what the file IS should pass it; without one the name falls back to the response's own
// Content-Disposition, then the URL tail, and never to a delivery token.
export async function fetchAudio(url, onProgress, title = '') {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const ctype = (resp.headers.get('content-type') || '').toLowerCase();
  // Content-Length is CORS-safelisted, so this works cross-origin. It may be
  // absent (chunked) or smaller than what we read (gzip) — callers clamp.
  const total = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
  await checkSpace(total);

  let bodyBlob;
  if (resp.body?.getReader) {
    const reader = resp.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      if (onProgress) onProgress(loaded, total);
    }
    bodyBlob = new Blob(chunks);
  } else {
    bodyBlob = await resp.blob();
  }

  if (ctype.includes('json') || ctype.startsWith('text/plain')) {
    const body = JSON.parse(await bodyBlob.text());
    if (body.error) throw new Error(body.error);
    if (!body.data) throw new Error('Unexpected response (no audio data)');
    return {
      blob: base64ToBlob(body.data, body.mimeType),
      name: body.name || 'audio',
      mimeType: body.mimeType || 'application/octet-stream',
    };
  }
  const mimeType = ctype.split(';')[0] || 'audio/mpeg';
  const name = storedMediaName({
    title, disposition: resp.headers.get('content-disposition') || '', url, mime: mimeType });
  return { blob: new Blob([bodyBlob], { type: mimeType }), name, mimeType };
}

/* ---------------- Resumable, pausable downloads ----------------
 * Bytes are persisted to IndexedDB chunk by chunk, so a connection glitch —
 * or even closing the app — never loses what was already received. Relay
 * URLs are fetched in small ranged chunks (each one independently
 * retryable); direct URLs resume with HTTP Range where the server supports
 * it. Pause aborts the network cleanly; resume continues from the saved
 * offset; reset starts over.
 */

// Each relay chunk is a separate Apps Script invocation (~2-4 s of overhead
// per call), so chunks should be as big as the connection can survive.
// Chunk size adapts AIMD-style: every successful chunk doubles it (up to
// MAX), every failure halves it (down to MIN) — smooth connections converge
// on few big requests, flaky ones on small cheap-to-retry ones. The first
// chunk stays small for a fast start and the relay's format sniff.
const RELAY_CHUNK_FIRST = 512 * 1024;
const RELAY_CHUNK_MIN = 128 * 1024;
const RELAY_CHUNK_MAX = 3 * 1024 * 1024; // base64 reply ≈ 4 MB, safe for Apps Script
const SAVE_EVERY = 256 * 1024;      // persist partial progress this often
const RETRIES = 3;                  // per-chunk attempts before giving up

const partialKey = (docId) => 'partial:' + docId;
const activeDownloads = new Map();  // docId -> AudioDownload

export function getDownload(docId) { return activeDownloads.get(docId) || null; }

export class AudioDownload {
  // onState({ status: 'downloading'|'paused'|'error'|'done', received, total })
  // `title` is the STORY TITLE — what the completed media file is named after (see _complete).
  constructor(docId, url, onState, title = '') {
    this.docId = docId;
    this.url = url;
    this.title = title;
    this.onState = onState;
    this.status = 'downloading';
    this.received = 0;
    this.total = 0;
    this.abortCtl = null;
    this.donePromise = null;
    this._gen = 0; // run generation: invalidates loops superseded by reset/resume
    this.chunkSize = RELAY_CHUNK_FIRST;
  }

  emit() {
    this.onState({
      status: this.status,
      received: this.received,
      total: this.total,
      storage: !!this.storageIssue,
      error: this.errorMessage || '',
    });
  }

  pause() {
    if (this.status !== 'downloading') return;
    this.status = 'paused';
    this.abortCtl?.abort();
    this.emit();
  }

  resume() {
    if (this.status === 'downloading') return;
    this.start();
  }

  async reset() {
    this.status = 'paused';
    this.abortCtl?.abort();
    await db.deleteMedia(partialKey(this.docId)).catch(() => {});
    this.received = 0;
    this.total = 0;
    this.start();
  }

  // Begin/continue downloading. Resolves with the media record on success,
  // or null when paused / out of attempts (partial progress is kept).
  start() {
    this.status = 'downloading';
    this.storageIssue = false;
    const run = ++this._gen;
    activeDownloads.set(this.docId, this);
    this.donePromise = this._runWithRetries(run)
      .finally(() => {
        if (this._gen === run && (this.status === 'done' || this.status === 'error')) {
          activeDownloads.delete(this.docId);
        }
      });
    return this.donePromise;
  }

  async _runWithRetries(run) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._run(run);
      } catch (e) {
        if (this._gen !== run) return null;                  // superseded by reset/resume
        if (this.status === 'paused') return null;           // user pause
        if (e.storageFull || e.name === 'QuotaExceededError') {
          // Device is full: pause (keeping the partial), tell the user to
          // free up space, and let them resume once they have.
          this.status = 'paused';
          this.storageIssue = true;
          this.emit();
          return null;
        }
        if (e.fatal) {
          this.status = 'error';
          this.errorMessage = e.message; // e.g. relay refusing a WAV
          this.emit();
          throw e;
        }
        // Transient failure: assume a shaky connection and shrink chunks so
        // each retry risks less.
        this.chunkSize = Math.max(RELAY_CHUNK_MIN, Math.floor(this.chunkSize / 2));
        if (attempt + 1 >= RETRIES) {
          this.status = 'error';                             // keep partial
          // Carry a reason so the UI shows "couldn't download — will retry",
          // never the misleading "not downloaded yet" (which reads as in-progress).
          this.errorMessage = e.message || 'download_failed';
          this.emit();
          return null;
        }
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        if (this._gen !== run || this.status !== 'downloading') return null;
      }
    }
  }

  async _loadPartial() {
    const part = await db.getMedia(partialKey(this.docId)).catch(() => null);
    if (part && part.sourceUrl === this.url) return part;
    return { blobs: [], received: 0, total: 0, name: '', mimeType: '', sourceUrl: this.url };
  }

  async _savePartial(part) {
    await db.putMedia(partialKey(this.docId), part);
  }

  /* THE NAMING CHOKEPOINT. Every completion path routes through here, so the story title wins over
   * whatever the transport observed — including a `part.name` PERSISTED by a pre-v3 build, which is
   * how a text whose partial download carried a token name heals itself simply by finishing. */
  async _complete(blob, observedName, mimeType) {
    const name = storedMediaName({ title: this.title, name: observedName, url: this.url, mime: mimeType });
    const media = { blob, name, mimeType, sourceUrl: this.url, peaks: null, duration: null };
    await db.putMedia(this.docId, media);
    await db.deleteMedia(partialKey(this.docId)).catch(() => {});
    this.status = 'done';
    this.received = blob.size;
    this.total = blob.size;
    this.emit();
    return media;
  }

  _isRelayUrl() {
    return /script\.google(?:usercontent)?\.com\/macros\//.test(this.url) ||
      /\/exec(\?|$)/.test(this.url);
  }

  async _run(run) {
    const part = await this._loadPartial();
    if (this._gen !== run) return null;
    this.received = part.received;
    this.total = part.total;
    this.emit();
    return this._isRelayUrl() ? this._runRelay(part, run) : this._runDirect(part, run);
  }

  /* Relay: fetch base64 JSON chunks (?start=&len=). An old (v1) relay
   * ignores those params and returns the whole file — detected by the
   * missing `total` field. */
  async _runRelay(part, run) {
    for (;;) {
      if (this._gen !== run || this.status !== 'downloading') return null;
      this.abortCtl = new AbortController();
      const sep = this.url.includes('?') ? '&' : '?';
      const len = part.received === 0
        ? Math.min(this.chunkSize, RELAY_CHUNK_FIRST)
        : this.chunkSize;
      const resp = await fetch(
        `${this.url}${sep}start=${part.received}&len=${len}`,
        { signal: this.abortCtl.signal });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const body = await resp.json();
      if (body.error) { const e = new Error(body.error); e.fatal = true; throw e; }
      if (!body.data) { const e = new Error('Unexpected relay response'); e.fatal = true; throw e; }
      const chunk = base64ToBlob(body.data, body.mimeType);

      if (body.total == null) {
        // v1 relay: the whole file arrived in one response.
        await checkSpace(chunk.size);
        return this._complete(chunk, body.name || 'audio', body.mimeType || 'audio/mpeg');
      }

      if (this._gen !== run) return null;
      if (part.received === 0) await checkSpace(body.total);
      part.blobs.push(chunk);
      part.received += chunk.size;
      part.total = body.total;
      // Chunk arrived intact: trust the connection with a bigger one.
      this.chunkSize = Math.min(RELAY_CHUNK_MAX, this.chunkSize * 2);
      part.name = body.name || part.name || 'audio';
      part.mimeType = body.mimeType || part.mimeType || 'audio/mpeg';
      await this._savePartial(part);
      this.received = part.received;
      this.total = part.total;
      this.emit();

      if (body.eof || part.received >= part.total) {
        return this._complete(new Blob(part.blobs, { type: part.mimeType }),
          part.name, part.mimeType);
      }
    }
  }

  /* Direct URL: stream, persisting progress; resume via HTTP Range when the
   * server supports it (206), otherwise start over transparently. */
  async _runDirect(part, run) {
    this.abortCtl = new AbortController();
    const headers = part.received > 0 ? { Range: `bytes=${part.received}-` } : {};
    let resp;
    try {
      resp = await fetch(this.url, { headers, signal: this.abortCtl.signal });
    } catch (e) {
      if (part.received > 0 && this.status === 'downloading') {
        // Possibly a CORS preflight rejection of the Range header — retry full.
        part = { ...part, blobs: [], received: 0 };
        await this._savePartial(part);
        this.abortCtl = new AbortController();
        resp = await fetch(this.url, { signal: this.abortCtl.signal });
      } else throw e;
    }
    if (!resp.ok && resp.status !== 206) {
      // Surface the relay/Worker's own error code (too_large, origin_not_allowed,
      // unauthorized, …) instead of a bare status, and treat 4xx as PERMANENT —
      // retrying a 401/403/404/413 just wastes ~13s and still ends in failure.
      let msg = 'HTTP ' + resp.status;
      if ((resp.headers.get('content-type') || '').toLowerCase().includes('json')) {
        try { const b = await resp.json(); if (b && b.error) msg = b.error; } catch { /* keep status */ }
      }
      const e = new Error(msg);
      if (resp.status >= 400 && resp.status < 500) e.fatal = true;
      throw e;
    }

    if (part.received > 0 && resp.status !== 206) {
      // Server doesn't do ranges — it's sending the whole file again.
      part.blobs = [];
      part.received = 0;
    }
    const ctype = (resp.headers.get('content-type') || '').toLowerCase();
    if (resp.status === 206) {
      const cr = resp.headers.get('content-range') || '';
      const m = cr.match(/\/(\d+)\s*$/);
      if (m) part.total = parseInt(m[1], 10);
    } else {
      part.total = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
    }
    if (part.received === 0 && part.total) await checkSpace(part.total);

    // JSON envelope from a non-relay URL (rare) — no resumability, one shot.
    if (ctype.includes('json')) {
      const body = await resp.json();
      if (body.error) { const e = new Error(body.error); e.fatal = true; throw e; }
      return this._complete(base64ToBlob(body.data, body.mimeType),
        body.name || 'audio', body.mimeType || 'audio/mpeg');
    }

    part.mimeType = part.mimeType || ctype.split(';')[0] || 'audio/mpeg';
    // What the TRANSPORT observed, in trust order — a stated Content-Disposition, else a URL tail
    // that actually looks like a filename. Never the raw last segment: that is the delivery token.
    // _complete still prefers the story title over both.
    part.name = part.name ||
      nameFromDisposition(resp.headers.get('content-disposition') || '') ||
      nameFromUrl(this.url);

    const reader = resp.body.getReader();
    let sinceSave = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (this._gen !== run || this.status !== 'downloading') return null;
      if (done) break;
      part.blobs.push(value);
      part.received += value.byteLength;
      sinceSave += value.byteLength;
      this.received = part.received;
      this.total = Math.max(part.total, 0);
      if (sinceSave >= SAVE_EVERY) {
        sinceSave = 0;
        await this._savePartial(part);
      }
      this.emit();
    }
    return this._complete(new Blob(part.blobs, { type: part.mimeType }),
      part.name, part.mimeType);
  }
}

// Start (or resume) the download for a doc. Resolves to the media record on
// success, null if paused or temporarily failed (partial progress retained).
export function downloadAudioForDoc(rec, url, onState) {
  const existing = activeDownloads.get(rec.id);
  if (existing && existing.status === 'downloading') return existing.donePromise;
  // The story title names the file (v3) — the record already has it, and it is the only source
  // that is meaningful to a human opening the folder later.
  const dl = new AudioDownload(rec.id, url, onState, rec.title || '');
  return dl.start();
}

// Discard saved partial progress for a doc (used by "start over").
export function clearPartial(docId) {
  return db.deleteMedia(partialKey(docId)).catch(() => {});
}

/* ---------------- Cached global asset (consent prompt audio) ----------------
 * A single app-wide audio clip stored under a fixed key. Re-downloaded and
 * OVERWRITTEN whenever the researcher's URL changes; otherwise served from
 * the cached blob forever (offline). Returns the stored media record.
 */
// `title` names the cached file (v3) — the consent prompt is delivered by the same private-token
// URL as an assignment, so without it the shared clip was stored under the delivery token and that
// name went straight into every local save's zip.
export async function ensureAsset(key, url, identity, title = '') {
  if (!url) return null;
  // `identity` is a STABLE marker of "which file is this" (e.g. the Drive file id) —
  // unlike `url`, which also carries the relay token + worker base and changes dev↔prod
  // or on token rotation. Same identity → keep the cached blob (no re-download, works
  // fully offline); a new identity → fetch fresh. Falls back to the URL if no identity.
  const id = identity || url;
  const existing = await db.getMedia(key).catch(() => null);
  if (existing && existing.sourceId === id && existing.blob) return existing;
  const { blob, name, mimeType } = await fetchAudio(url, null, title);
  const rec = { blob, name, mimeType, sourceUrl: url, sourceId: id };
  await db.putMedia(key, rec);
  return rec;
}

export function getAsset(key) {
  return db.getMedia(key).catch(() => null);
}

/* ---------------- Pre-flight probe (researcher side) ----------------
 * Before a task link is generated, fetch just the head of the audio and
 * validate it, so the researcher sees "this is a WAV" / "too big" / "not
 * shared" immediately — instead of the coworker discovering it later.
 */

// The Worker's /drive proxy caches and serves up to 512 MB per file (with HTTP
// Range, so downloads stream + resume). The old 15 MB ceiling was an Apps Script
// relay limit and no longer applies. Bigger than this → host on your own R2 and
// paste a direct link (see the "larger than ~500 MB" note in Settings).
const PROBE_MAX = 512 * 1024 * 1024;

// AIFF is the one common audio container our players (Chromium/Firefox) can't
// open, so we flag it — the researcher converts it now instead of the coworker
// hitting a dead player later. WAV + FLAC play fine and are NOT rejected: the old
// "reject any uncompressed WAV" rule was an Apps Script bandwidth holdover (the
// 150 MB/day relay cap) and no longer applies now the Worker streams files.
function headLooksAiff(bytes, mime) {
  if (/aiff|x-aiff/i.test(String(mime || ''))) return true;
  if (bytes && bytes.length >= 12) {
    const tag = (off) => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
    if (tag(0) === 'FORM' && (tag(8) === 'AIFF' || tag(8) === 'AIFC')) return true;
  }
  return false;
}

function probeError(code, extra) {
  const e = new Error(code);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

// Returns { name, size, mime }. Throws Error with .code in
// {'cantPlay','big','notAudio'} for playability/size failures, or a plain Error.
export async function probeAudioUrl(url) {
  const isRelay = /script\.google(?:usercontent)?\.com\/macros\//.test(url) || /\/exec(\?|$)/.test(url);
  if (isRelay) {
    const sep = url.includes('?') ? '&' : '?';
    const resp = await fetch(`${url}${sep}start=0&len=16384`);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const body = await resp.json();
    if (body.error) throw new Error(body.error);
    if (!body.data) throw new Error('Unexpected relay response');
    const blob = base64ToBlob(body.data, body.mimeType);
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (headLooksAiff(head, body.mimeType)) throw probeError('cantPlay');
    const size = body.total != null ? body.total : blob.size; // v1 relay: whole file came back
    if (size > PROBE_MAX) throw probeError('big', { mb: Math.round(size / 1048576) });
    return { name: body.name || '', size, mime: body.mimeType || '' };
  }
  // Direct URL (incl. the Worker's /drive proxy): read just the first chunk,
  // then abort. A timeout guards against a connection that accepts but never
  // responds (DNS black-hole / packet loss on a field network) — otherwise the
  // researcher's "Checking…" could hang for the browser's multi-minute default.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let resp;
  try {
    resp = await fetch(url, { signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    throw ctl.signal.aborted ? new Error('Timed out — check the connection and try again.') : e;
  }
  if (!resp.ok) {
    clearTimeout(timer);
    // The Worker rejects oversize files with 413 {error:'too_large', size}.
    // Map that to the friendly "too big" message, not a bare "HTTP 413".
    if (resp.status === 413) {
      let mb = Math.round(PROBE_MAX / 1048576);
      try { const b = await resp.json(); if (b && b.size) mb = Math.round(b.size / 1048576); } catch { /* keep estimate */ }
      throw probeError('big', { mb });
    }
    let msg = 'HTTP ' + resp.status;
    if ((resp.headers.get('content-type') || '').toLowerCase().includes('json')) {
      try { const b = await resp.json(); if (b && b.error) msg = b.error; } catch { /* keep status */ }
    }
    throw new Error(msg);
  }
  const mime = (resp.headers.get('content-type') || '').split(';')[0];
  const size = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
  let head = new Uint8Array(0);
  try {
    const { value } = await resp.body.getReader().read();
    if (value) head = value.subarray(0, 12);
  } catch (e) {
    // v325: the 20s abort covers the WHOLE probe, but the remap above wrapped only fetch() —
    // so our own timeout during the body read surfaced as a raw "NetworkError" (Sentani field
    // report). Same remap here: a self-inflicted abort must never read as a network failure.
    clearTimeout(timer);
    throw ctl.signal.aborted ? new Error('Timed out — check the connection and try again.') : e;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  if (headLooksAiff(head, mime)) throw probeError('cantPlay');
  // A folder share link (HTML page) or a wrong file (XML/JSON/text) comes back
  // as a document, not audio — reject it now so the researcher fixes the link,
  // not the coworker at playback. (octet-stream is left alone: many CDNs serve
  // real audio that way.)
  if (/^(text\/|application\/(json|xml|xhtml))/i.test(mime)) throw probeError('notAudio', { mime });
  if (size > PROBE_MAX) throw probeError('big', { mb: Math.round(size / 1048576) });
  const name = nameFromDisposition(resp.headers.get('content-disposition') || '') || nameFromUrl(url);
  return { name, size, mime };
}

// Fetch a whole (small) file via the relay's chunk protocol, or directly for a
// non-relay URL. Used for task-attached flextext files (XML, tens of KB), so we
// keep it simple: no persistence/resume (cf. the audio downloader above, which
// needs both for large media). Returns { name, mime, blob }.
export async function fetchFileViaUrl(url) {
  const isRelay = /script\.google(?:usercontent)?\.com\/macros\//.test(url) || /\/exec(\?|$)/.test(url);
  if (!isRelay) {
    // Timeout guard (like probeAudioUrl) so a black-holed host on a flaky field network can't hang the
    // caller for the browser's multi-minute default — e.g. the researcher's assign-link check.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let resp;
    try { resp = await fetch(url, { signal: ctl.signal }); }
    catch (e) { clearTimeout(timer); throw ctl.signal.aborted ? new Error('Timed out — check the connection and try again.') : e; }
    clearTimeout(timer);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const blob = await resp.blob();
    const name = nameFromDisposition(resp.headers.get('content-disposition') || '') || nameFromUrl(url);
    return { name, mime: (resp.headers.get('content-type') || '').split(';')[0], blob };
  }
  const sep = url.includes('?') ? '&' : '?';
  const parts = [];
  let received = 0, total = null, name = '', mime = '';
  for (let guard = 0; guard < 200; guard++) {
    const resp = await fetch(`${url}${sep}start=${received}&len=1048576`);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const body = await resp.json();
    if (body.error) { const e = new Error(body.error); e.fatal = true; throw e; }
    if (!body.data) { const e = new Error('Unexpected relay response'); e.fatal = true; throw e; }
    const chunk = base64ToBlob(body.data, body.mimeType);
    parts.push(chunk);
    received += chunk.size;
    name = body.name || name;
    mime = body.mimeType || mime;
    if (body.total == null) break;                 // v1 relay: whole file in one response
    total = body.total;
    if (body.eof || received >= total) break;
  }
  return { name, mime, blob: new Blob(parts, { type: mime }) };
}

/* ---------------- Player ---------------- */

const ZOOM_MIN = 1;     // px per second (fit-ish)
const ZOOM_MAX = 300;

export class Player {
  /**
   * @param {HTMLElement} root - container with the expected sub-elements
   * @param {(media: object) => void} onPeaks - called once peaks are computed
   *   so the caller can persist them.
   */
  constructor(root, { onPeaks, onRemove, labels, onSeekInteraction }) {
    this.root = root;
    this.onPeaks = onPeaks;
    this.labels = labels;
    // Called when the USER seeks by touching the waveform itself (not by any of our own seekMs
    // calls) — the host decides what that means; see the Player construction in app.js.
    this.onSeekInteraction = onSeekInteraction;
    this.ws = null;
    this.objectUrl = null;

    this.el = {
      wave: root.querySelector('.player-wave'),
      play: root.querySelector('.player-play'),
      back: root.querySelector('.player-back'),
      speed: root.querySelector('.player-speed'),
      zoom: root.querySelector('.player-zoom'),
      time: root.querySelector('.player-time'),
      status: root.querySelector('.player-status'),
      remove: root.querySelector('.player-remove'),
      progress: root.querySelector('.player-progress'),
      fill: root.querySelector('.player-progress-fill'),
    };

    // clearSpan first: after playing one segment, the transport must go back to normal continuous
    // playback. Without this the main play button would still stop at the previous span's end,
    // which reads as "the player is broken".
    this.el.play.addEventListener('click', () => { this.clearSpan(); this.ws?.playPause(); });
    this.el.back.addEventListener('click', () => {
      if (this.ws) this.ws.setTime(Math.max(0, this.ws.getCurrentTime() - 3));
    });
    this.el.speed.addEventListener('change', () => {
      this.ws?.setPlaybackRate(parseFloat(this.el.speed.value), true);
    });
    this.el.zoom.addEventListener('input', () => {
      if (!this.ws) return;
      try { this.ws.zoom(parseFloat(this.el.zoom.value)); } catch { /* not ready yet */ }
    });
    this.el.remove.addEventListener('click', () => onRemove && onRemove());
  }

  // Download feedback: a bar with percentage when the size is known,
  // an animated indeterminate bar otherwise.
  showProgress(text, fraction) {
    this.root.hidden = false;
    this.el.status.textContent = text;
    this.el.status.hidden = false;
    this.el.progress.hidden = false;
    if (fraction == null) {
      this.el.progress.classList.add('indeterminate');
      this.el.fill.style.width = '30%';
    } else {
      this.el.progress.classList.remove('indeterminate');
      this.el.fill.style.width = Math.round(fraction * 100) + '%';
    }
  }

  hideProgress() {
    this.el.progress.hidden = true;
    this.el.progress.classList.remove('indeterminate');
    this.el.fill.style.width = '0%';
  }

  async load(media) {
    this.destroyWs();
    this.hideProgress();
    this.root.hidden = false;
    this.el.status.textContent = this.labels.preparing;
    this.el.status.hidden = false;

    // Recorded for the failure path: on a poor connection a truncated download is the likeliest
    // reason playback fails, and `total` (from the download's content-length) is the only evidence
    // available. A stored media record that never carried one leaves this undefined, which the
    // error handler treats as "cannot tell" rather than guessing.
    this._srcBytes = (media.blob && media.blob.size) || null;
    this._expectedBytes = media.total != null ? media.total : null;
    this._srcKind = (media.mimeType || media.blob && media.blob.type) || 'unknown';
    this.objectUrl = URL.createObjectURL(media.blob);
    const opts = {
      container: this.el.wave,
      url: this.objectUrl,
      height: 72,
      waveColor: '#9db4d4',
      progressColor: '#1f4f8f',
      cursorColor: '#c0392b',
      cursorWidth: 2,
      normalize: true,
      autoScroll: true,
      autoCenter: true,
      minPxPerSec: ZOOM_MIN,
      /* ⚠ NO DEBOUNCE ON DRAG-TO-SEEK. `dragToSeek: true` defers the real seek by 200ms after the
       * last pointermove (while paused), moving only the progress bar in the meantime — so for a
       * fifth of a second after the user lets go, `getCurrentTime()` still reports where the drag
       * STARTED. That is invisible in a player and dangerous in this app: on the Cut tab an Enter
       * pressed straight after a drag reads the stale playhead and puts the cut back at the old
       * position, and the strips scroll to the old line. Zero makes the seek land with the gesture.
       * (v360's pause-on-interaction made the window wider, because the 0ms while-playing path no
       * longer applies once we have paused.) */
      dragToSeek: { debounceTime: 0 },
    };
    /* ⚠ PEAKS SUPPLIED ⇒ WAVESURFER NEVER DECODES, so this load has NO decoded audio to share.
     * Remembered because `getDecodedData()` does not say so: it hands back a SYNTHETIC buffer built
     * from these 12000 display peaks, whose `sampleRate` is length/duration (≈136 Hz on a 90-second
     * take). See decodedBuffer() for what that cost. */
    this._peaksOnly = !!(media.peaks && media.duration);
    if (this._peaksOnly) {
      opts.peaks = media.peaks;
      opts.duration = media.duration;
    }
    this.ws = WaveSurfer.create(opts);

    this.ws.on('ready', (duration) => {
      /* ⚠ RE-APPLY THE CHOSEN SPEED TO THE FRESH ENGINE — on 'ready', NOT after create(). A new
       * wavesurfer always starts at 1×, but the speed <select> lives in the dock and keeps its
       * value across every rebuild (doc opens, media swaps, the reloads behind tab switches), so
       * the UI said Slow while the audio played full speed and the user's only clue was their ears
       * (Seth, 2026-08-17: "the selected playspeed setting isn't the active playspeed setting").
       * The first version of this fix ran right after create() and the regression test caught it
       * still failing: a rate set before the media loads does not survive to playback. 'ready' is
       * the moment the media exists, and it fires on every load — the right chokepoint. The select
       * is the single source of truth; the change handler is deliberately the only other
       * setPlaybackRate call. */
      try {
        const rate = parseFloat(this.el.speed?.value || '1');
        if (rate && rate !== 1) this.ws.setPlaybackRate(rate, true);
      } catch { /* no media (peaks-only shell) — nothing to slow down yet */ }
      this.el.status.hidden = true;
      this.updateTime();
      // Boundary marks need the duration, and a set() that arrived before the load did is still
      // remembered on the instance — so re-draw them here rather than losing them to the race.
      this.renderBoundaries();
      // First load: persist decoded peaks so future opens skip decoding.
      if (!media.peaks && this.onPeaks) {
        try {
          const peaks = this.ws.exportPeaks({ maxLength: 12000 });
          media.peaks = peaks;
          media.duration = duration || this.ws.getDuration();
          this.onPeaks(media);
        } catch { /* peaks caching is best-effort */ }
      }
      // Initial zoom: fit the whole file in the visible width.
      const fit = Math.max(ZOOM_MIN,
        this.el.wave.clientWidth / Math.max(1, this.ws.getDuration()));
      this.el.zoom.min = String(Math.floor(fit));
      this.el.zoom.max = String(ZOOM_MAX);
      this.el.zoom.value = String(Math.floor(fit));
    });
    this.ws.on('error', (err) => {
      // Raw demuxer text ("DEMUXER_ERROR_COULD_NOT_OPEN") means nothing to a field user, so the
      // message stays plain — but it must not be USELESS either.
      //
      // ⚠ A WAVEFORM CAN DRAW WHILE PLAYBACK FAILS: the wave is rendered from CACHED PEAKS, while
      // playback goes through a media element. Seeing a wave therefore proves the file was decodable
      // ONCE, not that the bytes present now are complete. On a poor connection the overwhelmingly
      // likely cause is a TRUNCATED DOWNLOAD, and telling someone "could not play this file" sends
      // them looking for a format problem they do not have.
      //
      // So: say the likely cause in plain words, and put the technical detail at console.ERROR — it
      // was console.warn before, which is filtered out of most consoles by default and is why the
      // first report of this came back as "developer tools showed nothing in particular".
      console.error('[flextext] audio playback failed:', err, {
        src: this._srcKind || 'unknown', bytes: this._srcBytes ?? 'unknown',
      });
      const truncated = this._srcBytes != null && this._expectedBytes != null
        && this._srcBytes < this._expectedBytes;
      this.el.status.textContent = truncated
        ? (this.labels.errorTruncated || this.labels.error)
        : this.labels.error;
      this.el.status.hidden = false;
    });
    this.ws.on('play', () => { this.el.play.textContent = '⏸'; this._rewound = false; });
    this.ws.on('pause', () => { this.el.play.textContent = '▶'; });
    /* v332 (Seth): reaching the END rewinds to the START of whatever was playing — the span's own
     * start for a segment, 0 for the whole file. A playhead left parked at the end made the next
     * Space resume from the last CLICKED position instead of replaying from the top, and pressing
     * play at the very end reads as "nothing happened". `_spanHome` (not the resume position) is
     * the target, so "click halfway, play to the end, play again" replays the whole segment.
     *
     * ⚠ A span ending exactly at the file's end reaches BOTH: wavesurfer emits a final
     * timeupdate(duration) and THEN 'finish', so the span watcher has already rewound to the
     * segment by the time this runs — and clearSpan has dropped `_spanHome`, so recomputing here
     * would slam the playhead to 0. `_rewound` (reset on every 'play') says "already handled". */
    this.ws.on('finish', () => {
      this.el.play.textContent = '▶';
      if (this._rewound) return;
      const home = this._spanHome;
      this.clearSpan();
      try { this.ws.setTime(Number.isFinite(home) ? home : 0); } catch { /* not ready */ }
    });
    this.ws.on('timeupdate', () => this.updateTime());
    /* ⚠ 'interaction' IS THE USER'S OWN SEEK, and nothing else: wavesurfer emits it only from a
     * click or drag on the waveform, never from our setTime()/seekMs() calls. That distinction is
     * the whole reason this hook can pause playback safely — a handler on 'seeking' would also fire
     * for the seeks our own code makes (a strip's ▶, a join's playhead move, span rewind) and would
     * pause the player in the middle of doing what it was told. */
    this.ws.on('interaction', () => { try { this.onSeekInteraction?.(); } catch { /* host's problem */ } });
  }

  showPending(message) {
    this.destroyWs();
    this.hideProgress();
    this.root.hidden = false;
    this.el.status.textContent = message;
    this.el.status.hidden = false;
  }

  updateTime() {
    if (!this.ws) return;
    const fmt = (s) => {
      s = Math.max(0, Math.floor(s));
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    };
    this.el.time.textContent =
      fmt(this.ws.getCurrentTime()) + ' / ' + fmt(this.ws.getDuration());
  }

  /* Current playhead in MILLISECONDS, or null when there is no media.
   * ms because the whole segment model, flextext offsets and EAF TIME_SLOTs are all integer ms —
   * converting once here keeps float seconds from leaking into stored time codes. */
  playheadMs() {
    if (!this.ws) return null;
    try { return Math.round(this.ws.getCurrentTime() * 1000); } catch { return null; }
  }

  /** Media length in ms, or null. Used to clamp the last segment's end. */
  durationMs() {
    if (!this.ws) return null;
    try {
      const d = this.ws.getDuration();
      return Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null;
    } catch { return null; }
  }

  /* Play just [startMs, endMs) — one segment — then stop.
   *
   * ⚠ NO REGIONS PLUGIN, DELIBERATELY. wavesurfer's regions plugin would add a vendor dependency
   * and an editable-region UI we explicitly do NOT want (dragging must stay scrub-only; boundaries
   * are created by text edits, never by dragging). Seeking + watching timeupdate does the whole job.
   *
   * The stop watcher is stored on the instance and cleared by any new call, pause, or destroy, so
   * overlapping span plays can never leave two watchers fighting over the transport.
   */
  /** The player's OWN decoded audio, when available — the segment strips derive their peaks from
   * this so display and transport share one timeline. Two independent decodes of a compressed file
   * can disagree by tens of ms about where zero is (encoder priming), which surfaces as 'the
   * waveform is a tiny bit behind the audio' when chopping by ear.
   *
   * ⚠ NULL WHEN THE LOAD WAS PEAKS-ONLY — and that is the whole point of `_peaksOnly` (Seth's
   * Snakes_We_Eat.m4a, 2026-08-14: "guess isn't working"). The FIRST load of a recording decodes and
   * caches 12000 display peaks on the media record; every load after that hands those peaks to
   * wavesurfer so it can draw without decoding again. `getDecodedData()` still returns something —
   * a fake AudioBuffer wrapping exactly those 12000 samples, `sampleRate = 12000 / duration`. It is
   * a picture of the audio, not the audio.
   *
   * Handing that to ensurePeaks was silently catastrophic: it built a 177000-bucket array from
   * 12000 samples, so 93% of the buckets were ZERO, the amplitude percentiles that decide "pause vs
   * speech" both landed on zero, and ✨ Guess refused with "no clear pauses" on the very recording
   * it had just cut into 21 lines minutes earlier. Reproduced exactly: guess, reload, guess again.
   * Returning null instead costs one decode on re-open and gives the real waveform back. */
  decodedBuffer() {
    if (this._peaksOnly) return null;
    try { return this.ws?.getDecodedData?.() || null; } catch { return null; }
  }

  /* ── Segment boundary marks on the dock waveform (the Cut tab's map) ─────────────────────────
   * Seth, 2026-08-13: "I only wanted the top player to add lines representing segment boundaries.
   * They should be thick enough to be visible and light gray, and dotted, but not so thick that the
   * waveform becomes crazy busy." The Cut tab had grown a SECOND whole-file waveform of its own to
   * carry these; that duplication is gone and the marks live on the one player instead.
   *
   * ⚠ THEY GO INSIDE WAVESURFER'S OWN WRAPPER, POSITIONED IN PER CENT. That is what makes them
   * survive zoom and scroll for nothing: the wrapper is the full zoomed width and scrolls with the
   * waveform, so a percentage is the same instant of audio at every zoom level. Marks drawn over
   * the CONTAINER instead would slide out of register the moment the user touches the zoom slider.
   *
   * ⚠ The wrapper lives in a SHADOW ROOT, which app.css cannot reach — these styles are inline on
   * purpose, not by carelessness. Keep them here rather than "tidying" them into the stylesheet.
   *
   * They are pure decoration: pointer-events none, so the whole waveform stays a seek surface. */
  setBoundaries(list) {
    this._bounds = Array.isArray(list) ? list.filter((n) => Number.isFinite(n)) : [];
    this.renderBoundaries();
  }

  /* How many marks are actually on screen right now, or -1 if the layer has been thrown away with
   * its waveform. The Cut tab's ticker compares this against the number of spans it expects and
   * re-pushes when they disagree — the same belt-and-braces the strip canvases get from
   * fixStaleWave, and for the same reason: a redraw that loses them would otherwise stay lost until
   * the next edit, with no error anywhere. */
  boundaryCount() {
    const l = this._boundLayer;
    return l && l.isConnected ? l.children.length : -1;
  }

  renderBoundaries() {
    let wrap = null;
    try { wrap = this.ws?.getWrapper?.() || null; } catch { wrap = null; }
    if (!wrap) return;
    // A reload builds a new wavesurfer (and a new wrapper), leaving the old layer detached.
    let layer = this._boundLayer;
    if (!layer || layer.parentNode !== wrap) {
      layer = document.createElement('div');
      layer.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:4;';
      wrap.appendChild(layer);
      this._boundLayer = layer;
    }
    layer.replaceChildren();
    let dur = 0;
    try { dur = this.ws.getDuration() || 0; } catch { dur = 0; }
    if (!dur || !this._bounds || !this._bounds.length) return;
    for (const ms of this._bounds) {
      const f = (ms / 1000) / dur;
      if (!(f > 0) || f >= 1) continue;     // 0 and the file end are edges, not boundaries
      const b = document.createElement('span');
      b.style.cssText = 'position:absolute;top:0;bottom:0;width:0;'
        + 'border-left:2px dotted rgba(108,118,133,.85);';
      b.style.left = (f * 100) + '%';
      layer.appendChild(b);
    }
  }

  /** Park the playhead at an absolute position WITHOUT changing play/pause state — strip
   * click-to-position and scrubbing. If a span watcher is active it is cleared: a manual seek is
   * the user taking the transport, and a stale boundary must not pause them later. */
  seekMs(ms) {
    if (!this.ws || !Number.isFinite(ms)) return;
    this.clearSpan();
    try { this.ws.setTime(Math.max(0, ms) / 1000); } catch { /* not ready */ }
  }

  /** Is audio actually rolling right now? The strip buttons render play/pause from this. */
  playing() { try { return !!(this.ws && this.ws.isPlaying()); } catch { return false; } }

  /* Play CONTINUOUSLY from `ms` (or from wherever the playhead is), with NO span watcher — so
   * playback runs straight through every boundary.
   *
   * ⚠ This is the CUT TAB's SECOND transport, and only its (Seth, 2026-08-13: "it's OK for playback
   * to just keep going through segment boundaries … on the cut tab only. The baseline and gloss tabs
   * should retain their current behavior"). Cutting is judged by ear across a seam, and a transport
   * that stops dead at every cut makes that impossible.
   *
   * ⚠ IT IS NOT WHAT A LINE'S ▶ DOES, on any tab (Seth, refining it the same day: "if the user
   * clicks a segment play button, play-through behavior shouldn't happen … but spacebar or the big
   * player play button will play through"). A row button answers "is this span right?" and must
   * stop at the span's end — that is playSpan. This one answers "does this seam sound right?" and
   * belongs to Space and to the dock's own ⏵. Two questions, two controls; collapsing them into one
   * takes away the ability to hear a single span in isolation. */
  playThrough(ms) {
    if (!this.ws) return;
    this.clearSpan();
    if (Number.isFinite(ms)) { try { this.ws.setTime(Math.max(0, ms) / 1000); } catch { /* not ready */ } }
    try { this.ws.play(); } catch { /* autoplay blocked — the user gesture path handles it */ }
  }

  /** Pause IN PLACE — the playhead stays exactly where it is, which is the whole point: the user
   * parks it, then presses Enter to break the segment there. clearSpan so a stale span watcher
   * cannot later pause a resumed continuous play at an old boundary. */
  pause() {
    try { this.ws && this.ws.pause(); } catch { /* noop */ }
    this.clearSpan();
  }

  /* homeMs (v332) is where the span REWINDS to when it finishes, which is not always where it
   * starts playing: "resume from the parked playhead" calls this with startMs = the click position
   * but the segment's real start as home, so finishing the segment rewinds to the segment, not to
   * the click. Omit it and home == start (the old behaviour). */
  playSpan(startMs, endMs, homeMs) {
    if (!this.ws || !Number.isFinite(startMs)) return;
    this.clearSpan();
    const start = Math.max(0, startMs / 1000);
    const end = Number.isFinite(endMs) && endMs > startMs ? endMs / 1000 : null;
    const home = Number.isFinite(homeMs) ? Math.max(0, homeMs / 1000) : start;
    this._spanHome = home;

    try { this.ws.setTime(start); } catch { /* seek unsupported/not ready */ }

    if (end !== null) {
      // A tiny epsilon: timeupdate fires on a coarse cadence (~50ms measured), so waiting for
      // >= end overshoots. MEASURED against real wavesurfer: asking to stop at 4000ms stopped at
      // 4031ms — a ~30ms sliver of the next segment, which is one glottal pulse and inaudible in
      // speech. Erring early is the honest side; do not chase exactness with a rAF loop for this.
      const stopAt = Math.max(start, end - 0.02);
      const onTick = () => {
        if (!this.ws) return this.clearSpan();
        if (this.ws.getCurrentTime() >= stopAt) {
          try { this.ws.pause(); } catch { /* noop */ }
          /* v326 (Seth): a finished SPAN rewinds to ITS OWN start — a playhead parked on the
           * boundary reads as "on the next segment", and the natural next action is "play this
           * line again". v332: to `home`, not to `start` — see the homeMs note above. */
          try { this.ws.setTime(home); } catch { /* noop */ }
          this._rewound = true;      // tells the 'finish' handler this run is already parked

          this.clearSpan();
        }
      };
      // wavesurfer 7's on() RETURNS an unsubscribe function; older/other builds expose un().
      // Keep whichever we actually get rather than betting on one — a leaked timeupdate listener
      // would keep pausing playback at a stale boundary forever.
      this._spanTick = onTick;
      const off = this.ws.on('timeupdate', onTick);
      this._spanOff = typeof off === 'function' ? off : null;
    }
    try { this.ws.play(); } catch { /* autoplay blocked — the user gesture path handles it */ }
  }

  /** Drop any active span watcher, so the transport returns to normal continuous playback. */
  clearSpan() {
    if (this._spanOff) { try { this._spanOff(); } catch { /* noop */ } }
    else if (this._spanTick && this.ws) {
      try { this.ws.un('timeupdate', this._spanTick); } catch { /* noop */ }
    }
    this._spanTick = null;
    this._spanOff = null;
    this._spanHome = null;   // v332: back to whole-file semantics — the end rewinds to 0
  }

  destroyWs() {
    this.clearSpan();
    /* ⚠ THE MARKS DIE WITH THE RECORDING THEY DESCRIBE. Boundary times mean nothing outside the file
     * they were measured in, and this Player is a SINGLETON reused for every document — so keeping
     * `_bounds` across a load would stamp one text's cuts onto the next text's waveform (at
     * meaningless positions, for the whole of its decode) the moment two uncut recordings are worked
     * through in a row, which is exactly the Cut tab's own workflow. The tab re-pushes its own marks
     * on every render, so forgetting them here costs nothing and cannot be wrong. */
    this._bounds = [];
    this._boundLayer = null;   // it lived inside the wrapper being destroyed
    this._peaksOnly = false;   // a property of the load just discarded, not of the next one
    if (this.ws) { try { this.ws.destroy(); } catch { /* noop */ } this.ws = null; }
    if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
    this.el.play.textContent = '▶';
    this.el.time.textContent = '';
  }

  hide() {
    this.destroyWs();
    this.hideProgress();
    this.root.hidden = true;
  }
}
