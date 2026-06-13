/* upload.js — send the finished file to the researcher's Google Drive
 * THROUGH the relay (docs/drive-relay.gs).
 *
 * Why not PUT straight to Google? Google only returns the
 * Access-Control-Allow-Origin header on resumable-upload chunk PUTs when the
 * request carries OAuth-client context that an anonymous browser doesn't have.
 * A browser PUT to a relay-opened session therefore completes (HTTP 200) but
 * the browser is blocked from reading the response, so the upload "fails".
 *
 * Instead the browser hands the bytes to the relay as a CORS "simple" POST
 * (text/plain body, no custom headers → no preflight, so the request reaches
 * the relay even though its response carries no CORS header), the relay writes
 * them to Drive with its own credentials using the NATIVE Drive service (no
 * UrlFetch quota — only the relay account's storage), and the browser confirms
 * the outcome with an ordinary GET (which the relay CAN decorate with CORS
 * headers, via the googleusercontent redirect).
 *
 * Tradeoff vs. the old resumable design: a dropped upload restarts rather than
 * resuming byte-for-byte, but we keep a real progress bar (XHR upload events)
 * and it works cross-origin. Drive always creates a NEW file (the name carries
 * a timestamp for humans); nothing is ever overwritten.
 */

import * as db from './db.js';

const upKey = (docId) => 'upload:' + docId;
const active = new Map();
const POLL_TRIES = 40;     // confirmation GETs
const POLL_DELAY = 1500;   // ms between them

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

function newToken() {
  return 'up-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

// Read a Blob as base64 (no data: prefix). Drive needs base64 because Apps
// Script can only safely receive text in a POST body.
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(new Error('Could not read the file to upload.'));
    r.readAsDataURL(blob);
  });
}

export class DriveUpload {
  // record: { relayUrl, folder, blob, name, mime, total, token, sent }
  // onState({ status:'uploading'|'paused'|'error'|'done'|'cancelled', sent, total, error, name })
  constructor(docId, record, onState) {
    this.docId = docId;
    this.rec = record;
    this.onState = onState;
    this.status = 'uploading';
    this.xhr = null;
    this._gen = 0;
    this.errorMessage = null;
    if (!this.rec.token) this.rec.token = newToken();
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
    this.xhr?.abort();
    this.emit();
  }

  resume() {
    if (this.status === 'uploading') return;
    this.start(); // proxy upload can't resume mid-stream — restart from 0
  }

  async cancel() {
    this.status = 'cancelled';
    this.xhr?.abort();
    active.delete(this.docId);
    await db.deleteMedia(upKey(this.docId)).catch(() => {});
    this.onState({ status: 'cancelled', sent: this.rec.sent, total: this.rec.total, name: this.rec.name });
  }

  start() {
    this.status = 'uploading';
    this.errorMessage = null;
    const run = ++this._gen;
    active.set(this.docId, this);
    this.donePromise = this._run(run)
      .catch((e) => {
        if (this._gen !== run) return;
        if (this.status === 'paused' || this.status === 'cancelled') return;
        this.status = 'error';
        this.errorMessage = e.message;
        this.emit();
      })
      .finally(() => { if (this.status === 'done') active.delete(this.docId); });
    return this.donePromise;
  }

  async _run(run) {
    const rec = this.rec;
    rec.sent = 0;
    this.emit();
    await db.putMedia(upKey(this.docId), rec).catch(() => {});

    const dataB64 = await blobToBase64(rec.blob);
    if (this._gen !== run || this.status !== 'uploading') return;

    const body = JSON.stringify({
      action: 'upload',
      token: rec.token,
      folder: rec.folder || '',
      name: rec.name,
      mimeType: rec.mime,
      size: rec.total,
      data: dataB64,
    });

    await this._post(rec.relayUrl, body, run);
    if (this._gen !== run || this.status !== 'uploading') return;

    const fileId = await this._poll(run);
    if (this._gen !== run || this.status !== 'uploading') return;
    if (!fileId) {
      throw new Error('The upload did not arrive. Check the connection and that the Drive folder is shared "Anyone with the link can edit", then try again.');
    }
    rec.sent = rec.total;
    this.status = 'done';
    await db.deleteMedia(upKey(this.docId)).catch(() => {});
    this.emit();
  }

  // Cross-origin "simple" POST. Its response has no CORS header so the browser
  // surfaces it as an error with status 0 — but the relay still received and
  // processed it. So: if the body finished uploading, treat the request as
  // delivered and let the GET poll decide success; only a genuinely interrupted
  // upload is a failure.
  _post(relayUrl, body, run) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.xhr = xhr;
      let uploadDone = false;
      xhr.open('POST', relayUrl);
      // text/plain keeps this a CORS-safelisted "simple" request (no preflight).
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      xhr.upload.onprogress = (e) => {
        if (this._gen !== run || this.status !== 'uploading') return;
        const frac = e.lengthComputable && e.total ? e.loaded / e.total : 0;
        this.rec.sent = Math.min(this.rec.total, Math.round(frac * this.rec.total));
        this.emit();
      };
      xhr.upload.onload = () => { uploadDone = true; };
      xhr.onload = () => resolve();
      xhr.onerror = () => { uploadDone ? resolve() : reject(new Error('The upload could not be sent — check the connection and try again.')); };
      xhr.onabort = () => reject(new Error('aborted'));
      xhr.send(body);
    });
  }

  async _poll(run) {
    const sep = this.rec.relayUrl.includes('?') ? '&' : '?';
    for (let i = 0; i < POLL_TRIES; i++) {
      if (this._gen !== run || this.status !== 'uploading') return null;
      try {
        const url = this.rec.relayUrl + sep +
          new URLSearchParams({ action: 'upload-status', token: this.rec.token }).toString();
        const resp = await fetch(url);
        if (resp.ok) {
          const b = await resp.json();
          if (b.error) { const e = new Error(b.error); e.fatal = true; throw e; }
          if (b.done && b.fileId) return b.fileId;
        }
      } catch (e) {
        if (e.fatal) throw e; // a real Drive error reported by the relay
      }
      await new Promise((r) => setTimeout(r, POLL_DELAY));
    }
    return null;
  }
}

// Pending uploads persisted from a previous session (restarted from 0 — the
// proxy upload has no byte-level resume).
export async function listPendingUploads() {
  const keys = await db.listMediaKeys().catch(() => []);
  const out = [];
  for (const k of keys) {
    if (String(k).startsWith('upload:')) {
      const rec = await db.getMedia(k).catch(() => null);
      if (rec?.relayUrl && rec.blob) out.push({ docId: String(k).slice(7), rec });
    }
  }
  return out;
}
