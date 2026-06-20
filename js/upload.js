/* upload.js — send the finished file to the researcher's Google Drive
 * THROUGH the relay (docs/drive-relay.gs).
 *
 * Why not PUT straight to Google? Google only returns the
 * Access-Control-Allow-Origin header on resumable-upload chunk PUTs when the
 * request carries OAuth-client context that an anonymous browser doesn't have.
 * A browser PUT to a relay-opened session therefore completes (HTTP 200) but
 * the browser is blocked from reading the response, so the upload "fails".
 *
 * Instead the browser hands the bytes to the relay as a CORS "simple" POST and
 * the relay writes them to Drive with its own credentials using the NATIVE
 * Drive service (no UrlFetch quota — only the relay account's storage). The
 * browser confirms the outcome with an ordinary GET (which the relay CAN
 * decorate with CORS headers, via the googleusercontent redirect).
 *
 * Two CORS subtleties force the exact shape of the POST:
 *   - text/plain body + no custom headers → a "simple" request (no preflight),
 *     so it reaches the relay even though the response has no CORS header.
 *   - We must NOT attach an upload-progress listener: per the Fetch spec, any
 *     upload listener forces a preflight (OPTIONS), which Apps Script can't
 *     answer. So we send with no-cors fetch and show an indeterminate
 *     "uploading" state rather than a byte-accurate bar.
 *
 * Tradeoff vs. the old resumable design: no byte-level progress and a dropped
 * upload restarts rather than resuming — but it works cross-origin. Drive
 * always creates a NEW file (the name carries a timestamp); nothing is
 * overwritten.
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
  // onState({ status:'uploading'|'paused'|'error'|'done'|'cancelled', sent, total, indeterminate, error, name })
  constructor(docId, record, onState) {
    this.docId = docId;
    this.rec = record;
    this.onState = onState;
    this.status = 'uploading';
    this.abortCtl = null;
    this.indeterminate = false;
    this._gen = 0;
    this.errorMessage = null;
    if (!this.rec.token) this.rec.token = newToken();
  }

  emit() {
    this.onState({
      status: this.status,
      sent: this.rec.sent,
      total: this.rec.total,
      indeterminate: this.indeterminate,
      error: this.errorMessage,
      name: this.rec.name,
      // On 'done', the Drive file id + the send-time doc-modified stamp, so the
      // doc can record proof-of-backup (delete-safety). Undefined until done.
      fileId: this.uploadedFileId,
      docModified: this.rec.docModified,
    });
  }

  pause() {
    if (this.status !== 'uploading') return;
    this.status = 'paused';
    this.abortCtl?.abort();
    this.rec.paused = true; // persist so a deliberate pause survives a restart
    db.putMedia(upKey(this.docId), this.rec).catch(() => {});
    this.emit();
  }

  resume() {
    if (this.status === 'uploading') return;
    this.rec.paused = false;
    db.putMedia(upKey(this.docId), this.rec).catch(() => {});
    this.start(); // proxy upload can't resume mid-stream — restart from 0
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
    this.donePromise = this._run(run)
      .catch((e) => {
        if (this._gen !== run) return;
        if (this.status === 'paused' || this.status === 'cancelled') return;
        this.status = 'error';
        this.indeterminate = false;
        this.errorMessage = e.message;
        this.emit();
      })
      .finally(() => { if (this.status === 'done') active.delete(this.docId); });
    return this.donePromise;
  }

  async _run(run) {
    const rec = this.rec;
    rec.sent = 0;
    this.indeterminate = true; // no byte-level progress available (see header)
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
    this.indeterminate = false;
    rec.sent = rec.total;
    this.uploadedFileId = fileId;   // proof-of-backup, carried out via emit()
    this.status = 'done';
    await db.deleteMedia(upKey(this.docId)).catch(() => {});
    this.emit();
  }

  // Cross-origin "simple" POST sent with no-cors (see header for why we can't
  // use an upload-progress listener). The response is opaque — the relay still
  // receives and processes the body; the GET poll reports the real outcome.
  async _post(relayUrl, body, run) {
    this.abortCtl = new AbortController();
    try {
      await fetch(relayUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body,
        signal: this.abortCtl.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError' || this._gen !== run) throw new Error('aborted');
      throw new Error('The upload could not be sent — check the connection and try again.');
    }
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
