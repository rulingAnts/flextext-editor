/* upload.js — resumable uploads to Google Drive.
 *
 * The relay (docs/drive-relay.gs, "initiate-upload") opens a Drive resumable
 * upload session using its own credentials (drive.file scope: it can only
 * create new files, never read or overwrite anything). The session URI it
 * returns is a capability URL — the browser then PUTs the bytes directly to
 * Google with no further auth, chunk by chunk, with the same error
 * tolerance as downloads: pause/resume/cancel, per-chunk retries, adaptive
 * chunk sizing, and persistence so an upload survives closing the app.
 * Drive always creates a NEW file (names carry a timestamp for humans);
 * nothing is ever overwritten.
 */

import * as db from './db.js';

// Drive requires chunk sizes in multiples of 256 KB (except the last).
const UP_QUANTUM = 256 * 1024;
const UP_CHUNK_START = 512 * 1024;
const UP_CHUNK_MIN = 256 * 1024;
const UP_CHUNK_MAX = 4 * 1024 * 1024;
const RETRIES = 3;

const upKey = (docId) => 'upload:' + docId;
const active = new Map();

export function getUpload(docId) { return active.get(docId) || null; }

export function driveFolderId(text) {
  const s = String(text || '').trim();
  let m = s.match(/drive\.google\.com\/[^\s]*folders\/([\w-]{10,})/);
  if (m) return m[1];
  m = s.match(/[?&]id=([\w-]{10,})/);
  if (m) return m[1];
  if (/^[\w-]{20,}$/.test(s)) return s;
  return null;
}

// Ask the relay to open a resumable session. Uses GET (not POST): Apps Script
// only attaches CORS headers to its GET responses (via the googleusercontent
// redirect) — a cross-origin POST comes back as an HTML page with no
// Access-Control-Allow-Origin and is blocked by the browser.
export async function initiateUpload(relayUrl, folderId, name, mimeType, size) {
  const sep = relayUrl.includes('?') ? '&' : '?';
  const url = relayUrl + sep + new URLSearchParams({
    action: 'initiate-upload',
    folder: folderId || '',
    name: name || 'upload.bin',
    mimeType: mimeType || 'application/octet-stream',
    size: String(size || 0),
  }).toString();
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const body = await resp.json();
  if (body.error) throw new Error(body.error);
  if (!body.sessionUri) {
    throw new Error('No upload session returned — update the relay (docs/drive-relay.gs) and re-deploy it.');
  }
  return body.sessionUri;
}

export class DriveUpload {
  // record: { sessionUri, blob, name, sent, total }
  // onState({ status:'uploading'|'paused'|'error'|'done', sent, total, error })
  constructor(docId, record, onState) {
    this.docId = docId;
    this.rec = record;
    this.onState = onState;
    this.status = 'uploading';
    this.abortCtl = null;
    this.chunkSize = UP_CHUNK_START;
    this._gen = 0;
    this.errorMessage = null;
  }

  emit() {
    this.onState({
      status: this.status,
      sent: this.rec.sent,
      total: this.rec.total,
      error: this.errorMessage,
      name: this.rec.name,
    });
  }

  pause() {
    if (this.status !== 'uploading') return;
    this.status = 'paused';
    this.abortCtl?.abort();
    this.emit();
  }

  resume() {
    if (this.status === 'uploading') return;
    this.start();
  }

  async cancel() {
    this.status = 'cancelled';
    this.abortCtl?.abort();
    active.delete(this.docId);
    await db.deleteMedia(upKey(this.docId)).catch(() => {});
    this.onState({ status: 'cancelled', sent: this.rec.sent, total: this.rec.total, name: this.rec.name });
  }

  start() {
    this.status = 'uploading';
    this.errorMessage = null;
    const run = ++this._gen;
    active.set(this.docId, this);
    this.donePromise = this._runWithRetries(run).finally(() => {
      if (this._gen === run && (this.status === 'done' || this.status === 'error')) {
        if (this.status === 'done') active.delete(this.docId);
      }
    });
    return this.donePromise;
  }

  async _runWithRetries(run) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._run(run);
      } catch (e) {
        if (this._gen !== run) return null;
        if (this.status === 'paused' || this.status === 'cancelled') return null;
        if (e.fatal) {
          this.status = 'error';
          this.errorMessage = e.message;
          this.emit();
          return null;
        }
        this.chunkSize = Math.max(UP_CHUNK_MIN,
          Math.floor(this.chunkSize / 2 / UP_QUANTUM) * UP_QUANTUM || UP_CHUNK_MIN);
        if (attempt + 1 >= RETRIES) {
          this.status = 'error';
          this.errorMessage = e.message;
          this.emit();
          return null;
        }
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        if (this._gen !== run || this.status !== 'uploading') return null;
      }
    }
  }

  async _run(run) {
    const rec = this.rec;
    this.emit();
    while (rec.sent < rec.total) {
      if (this._gen !== run || this.status !== 'uploading') return null;
      const end = Math.min(rec.sent + this.chunkSize, rec.total);
      this.abortCtl = new AbortController();
      const resp = await fetch(rec.sessionUri, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${rec.sent}-${end - 1}/${rec.total}` },
        body: rec.blob.slice(rec.sent, end),
        signal: this.abortCtl.signal,
      });
      if (this._gen !== run) return null;
      if (resp.status === 308) {
        // chunk accepted, more expected
        rec.sent = end;
        await db.putMedia(upKey(this.docId), rec).catch(() => {});
        this.chunkSize = Math.min(UP_CHUNK_MAX, this.chunkSize * 2);
        this.emit();
      } else if (resp.ok) {
        rec.sent = rec.total;
        this.status = 'done';
        await db.deleteMedia(upKey(this.docId)).catch(() => {});
        this.emit();
        return true;
      } else if (resp.status === 404 || resp.status === 410) {
        const e = new Error('Upload session expired — start the upload again.');
        e.fatal = true;
        throw e;
      } else {
        throw new Error('HTTP ' + resp.status);
      }
    }
    this.status = 'done';
    await db.deleteMedia(upKey(this.docId)).catch(() => {});
    this.emit();
    return true;
  }
}

// Pending uploads persisted from a previous session (for auto-resume).
export async function listPendingUploads() {
  const keys = await db.listMediaKeys().catch(() => []);
  const out = [];
  for (const k of keys) {
    if (String(k).startsWith('upload:')) {
      const rec = await db.getMedia(k).catch(() => null);
      if (rec?.sessionUri && rec.blob) out.push({ docId: String(k).slice(7), rec });
    }
  }
  return out;
}
