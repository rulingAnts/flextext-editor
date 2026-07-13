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

// Injected by app.js (returns {url, headers} for an ENROLLED device, else null):
// lets uploads stream through the worker into the researcher's own Drive without
// this module importing sync.js. Evaluated fresh on every run/retry, so a device
// enrolled (or revoked) mid-queue does the right thing on its next attempt.
let workerTargetProvider = null;
export function setWorkerUploadTarget(fn) { workerTargetProvider = fn; }

// Chunked-streaming tuning. Drive requires every non-final chunk to be a multiple
// of 256 KiB. The size ADAPTS to the link: grows toward 32 MiB while chunks land
// fast, halves toward 512 KiB on slowness or failure — village connections send
// small reliable pieces, good connections finish big files quickly.
const STREAM_SINGLE_MAX = 16 * 1024 * 1024;  // ≤ this → one plain POST; above → chunked resumable
const CHUNK_UNIT = 262144;
const CHUNK_MIN = 2 * CHUNK_UNIT;            // 512 KiB
const CHUNK_MAX = 128 * CHUNK_UNIT;          // 32 MiB
const CHUNK_START = 16 * CHUNK_UNIT;         // 4 MiB opening guess
const shrinkChunk = (n) => Math.max(CHUNK_MIN, Math.floor(n / 2 / CHUNK_UNIT) * CHUNK_UNIT);

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

    // ENROLLED devices: stream through the worker into the researcher's OWN Drive
    // ("FlexText Uploads / <device nickname>") FIRST — no base64, no 15 MB cap, no
    // WAV refusal, and a directly readable response (no status-poll dance). ANY
    // failure falls through to the relay path below, exactly as before — and the
    // queue's retry loop re-enters here, so a transient worker/token problem heals
    // back onto the streaming path on a later attempt.
    const target = workerTargetProvider && workerTargetProvider();
    if (target && rec.total > STREAM_SINGLE_MAX) {
      // Big files: chunked resumable — no practical size limit, exact resume from
      // wherever a drop/reload/pause left off (the Drive session is persisted with
      // this queued upload), real byte progress. Never falls through to the relay
      // when the relay couldn't take the file anyway.
      const finished = await this._streamChunked(target, run);
      if (this._gen !== run || this.status !== 'uploading') return;
      if (finished) return;
      if (rec.total > 14 * 1048576 || /wav|aiff|flac/i.test(rec.mime || '')) {
        // The relay refuses big/uncompressed files, so surface a truthful, calm
        // message: nothing is lost, the session is saved, the sweep resumes it.
        throw new Error('The upload is paused — it will continue from where it stopped when the connection is back.');
      }
      // Small compressed file whose chunked attempt failed → the relay can take it.
    } else if (target) {
      try {
        this.abortCtl = new AbortController();
        const resp = await fetch(target.url, {
          method: 'POST',
          headers: {
            ...target.headers,
            'content-type': 'application/octet-stream',
            'x-fx-name': encodeURIComponent(rec.name || ''),
            'x-fx-mime': rec.mime || '',
          },
          body: rec.blob,
          signal: this.abortCtl.signal,
        });
        if (this._gen !== run || this.status !== 'uploading') return;
        const out = await resp.json().catch(() => ({}));
        if (resp.ok && out.ok && out.fileId) {
          this.indeterminate = false;
          rec.sent = rec.total;
          this.uploadedFileId = out.fileId;   // proof-of-backup — delete-safety unchanged
          this.status = 'done';
          await db.deleteMedia(upKey(this.docId)).catch(() => {});
          this.emit();
          return;
        }
        // no_drive / too_large / 5xx → relay fallback below
      } catch (e) {
        if (e.name === 'AbortError' || this._gen !== run) throw new Error('aborted');
        // network blip → try the relay leg; the retry sweep will revisit streaming
      }
      if (this._gen !== run || this.status !== 'uploading') return;
    }

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

  // ---- chunked resumable streaming (big files through the worker into the
  // researcher's own Drive) ----

  // One PUT to the worker's chunk relay. body null + "bytes */total" = a status
  // probe (Drive answers with exactly how many bytes it holds). Returns
  // { done, fileId } | { received } | { gone } (session died — restart fresh) |
  // { fail } (transient). Abort (pause/cancel) throws like the relay path does.
  async _chunkPut(target, rec, range, body) {
    this.abortCtl = new AbortController();
    let resp = null;
    try {
      resp = await fetch(target.url + '/chunk', {
        method: 'PUT',
        headers: {
          ...target.headers,
          'x-fx-upload': rec.streamId,
          'content-range': range,
          ...(body ? { 'content-type': 'application/octet-stream' } : {}),
        },
        body,
        signal: this.abortCtl.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('aborted');
      return { fail: true };
    }
    const out = await resp.json().catch(() => ({}));
    if (resp.ok && out.done && out.fileId) return { done: true, fileId: out.fileId };
    if (resp.ok && out.done === false) return { received: out.received || 0 };
    if (out.error === 'session_gone' || out.error === 'bad_upload') return { gone: true };
    return { fail: true };
  }

  async _streamFinish(rec, fileId) {
    delete rec.streamId;
    delete rec.chunkBytes;
    this.indeterminate = false;
    rec.sent = rec.total;
    this.uploadedFileId = fileId;   // proof-of-backup — delete-safety unchanged
    this.status = 'done';
    await db.deleteMedia(upKey(this.docId)).catch(() => {});
    this.emit();
  }

  // The chunked run: open (or reuse) a Drive session, ask Drive where it stands,
  // then push adaptive chunks. Aggressively failure-proof by construction:
  //  - the session token + chunk size persist in this queued upload's IndexedDB
  //    record, so a reload/crash/offline WEEK later resumes mid-file;
  //  - every retry starts with a probe, so we always continue from Drive's own
  //    count, never a guess;
  //  - transient failures back off (2s→60s) and shrink the chunk; after a few
  //    strikes we return to the queue, whose startup/online/timer sweep re-enters
  //    here — pause/cancel behave exactly like the relay path (abort → status).
  // Returns true when the file is fully delivered (status already 'done').
  async _streamChunked(target, run) {
    const rec = this.rec;
    if (!rec.streamId) {
      let out = null;
      try {
        const r = await fetch(target.url + '/start', {
          method: 'POST',
          headers: { ...target.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ name: rec.name, mime: rec.mime, size: rec.total }),
        });
        out = await r.json().catch(() => null);
        if (!r.ok || !out || !out.uploadId) return false;   // no_drive/network → caller decides
      } catch { return false; }
      rec.streamId = out.uploadId;
      rec.chunkBytes = rec.chunkBytes || CHUNK_START;
      await db.putMedia(upKey(this.docId), rec).catch(() => {});
    }
    rec.chunkBytes = Math.min(CHUNK_MAX, Math.max(CHUNK_MIN, rec.chunkBytes || CHUNK_START));
    let waitMs = 2000;
    let strikes = 0;
    while (strikes < 5) {
      if (this._gen !== run || this.status !== 'uploading') return true;   // paused/cancelled — session persists
      const probe = await this._chunkPut(target, rec, `bytes */${rec.total}`, null);
      if (probe.done) { await this._streamFinish(rec, probe.fileId); return true; }
      if (probe.gone) { delete rec.streamId; await db.putMedia(upKey(this.docId), rec).catch(() => {}); return false; }
      if (probe.fail) {
        strikes++;
        await new Promise((r) => setTimeout(r, waitMs));
        waitMs = Math.min(waitMs * 2, 60000);
        continue;
      }
      let offset = probe.received || 0;
      let pushFailed = false;
      while (offset < rec.total) {
        if (this._gen !== run || this.status !== 'uploading') return true;
        const size = Math.min(rec.chunkBytes, rec.total - offset);
        const t0 = Date.now();
        const res = await this._chunkPut(target, rec,
          `bytes ${offset}-${offset + size - 1}/${rec.total}`, rec.blob.slice(offset, offset + size));
        if (res.done) { await this._streamFinish(rec, res.fileId); return true; }
        if (res.gone) { delete rec.streamId; await db.putMedia(upKey(this.docId), rec).catch(() => {}); return false; }
        if (res.fail) {
          rec.chunkBytes = shrinkChunk(rec.chunkBytes);
          strikes++;
          pushFailed = true;
          await db.putMedia(upKey(this.docId), rec).catch(() => {});
          await new Promise((r) => setTimeout(r, waitMs));
          waitMs = Math.min(waitMs * 2, 60000);
          break;   // re-probe: Drive tells us the true offset, we continue from there
        }
        // Chunk landed: adapt to the measured pace and show REAL byte progress.
        strikes = 0;
        waitMs = 2000;
        const secs = (Date.now() - t0) / 1000;
        if (secs < 15 && rec.chunkBytes < CHUNK_MAX) rec.chunkBytes = Math.min(CHUNK_MAX, rec.chunkBytes * 2);
        else if (secs > 60) rec.chunkBytes = shrinkChunk(rec.chunkBytes);
        offset = res.received != null ? res.received : offset + size;
        rec.sent = offset;
        this.indeterminate = false;
        this.emit();
        await db.putMedia(upKey(this.docId), rec).catch(() => {});
      }
      if (!pushFailed && offset >= rec.total) {
        // All bytes sent but no done yet (edge) — the next probe resolves it.
        strikes++;
      }
    }
    return false;   // hand back to the queue's sweep; the persisted session resumes
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

// Idiot-proof write-probe for a Drive upload folder: drop a tiny marker file via the EXACT relay
// path real uploads use, so a green result PROVES field uploads to this folder will land. Needs NO
// client-side Drive token (the relay holds the only credential). Resolves {ok:true,fileId,name} on
// success, {ok:false,timeout:true} if the relay never confirms, or REJECTS with the relay's own
// plain-language error (e.g. "Share it as 'Anyone with the link can EDIT'") on a real Drive failure.
export async function probeDriveFolder(relayUrl, folderId) {
  const token = newToken();
  const name = 'flextext-write-test-' + Date.now() + '.txt';
  const text = 'FlexText folder write test — safe to delete.';
  const data = await blobToBase64(new Blob([text], { type: 'text/plain' }));
  const body = JSON.stringify({
    action: 'upload', token, folder: folderId || '',
    name, mimeType: 'text/plain', size: text.length, data,
  });
  try {
    await fetch(relayUrl, { method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body });
  } catch {
    throw new Error('Could not reach the upload relay — check the connection and try again.');
  }
  const sep = relayUrl.includes('?') ? '&' : '?';
  for (let i = 0; i < 12; i++) {   // a ~40-byte file lands fast, so fewer tries than a real upload
    try {
      const resp = await fetch(relayUrl + sep +
        new URLSearchParams({ action: 'upload-status', token }).toString());
      if (resp.ok) {
        const b = await resp.json();
        if (b.error) { const e = new Error(b.error); e.fatal = true; throw e; } // relay's plain-language Drive error
        if (b.done && b.fileId) return { ok: true, fileId: b.fileId, name };
      }
    } catch (e) {
      if (e.fatal) throw e;            // surface a real Drive/permission error; a transient blip just retries
    }
    await new Promise((r) => setTimeout(r, POLL_DELAY));
  }
  return { ok: false, timeout: true };
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
