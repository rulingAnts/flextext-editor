/* upload.js — stream the finished file into the researcher's own Google Drive
 * THROUGH the connectivity worker (install-authed; the worker holds the
 * researcher's OAuth token and files everything under
 * "FlexText Uploads / <device nickname>").
 *
 * The old Apps Script relay leg is RETIRED (2026-07-13): uploads exist only on
 * researcher-linked devices, small files as one POST, big files as CHUNKED
 * RESUMABLE sessions (adaptive chunk size, exact mid-file resume across drops/
 * reloads/offline gaps — Drive's own byte count is the source of truth).
 * Queued items persist in IndexedDB and retry forever, exactly as before.
 */

import * as db from './db.js';

const upKey = (docId) => 'upload:' + docId;
const active = new Map();

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

export class DriveUpload {
  // record: { blob, name, mime, total, sent, docModified }
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
      folderId: this.uploadedFolderId,   // per-text Drive folder (remembered for dedupe)
      docModified: this.rec.docModified,
      docDone: this.rec.docDone,   // was the doc marked FINISHED at queue time (gates auto-delete)
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
    this.start(); // chunked uploads CONTINUE from Drive's byte count; small ones restart (they're small)
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
    this.indeterminate = true;
    this.emit();
    await db.putMedia(upKey(this.docId), rec).catch(() => {});

    const target = workerTargetProvider && workerTargetProvider();
    if (!target) {
      // The relay upload leg is retired: uploads exist ONLY through the
      // researcher-linked streaming path. The item stays queued with a truthful
      // message (Cancel is always available on the bar); a later enrollment —
      // or a revoked binding coming back — picks it up on the next sweep.
      throw new Error('Uploads need this device to be linked to a researcher.');
    }

    if (rec.total > STREAM_SINGLE_MAX) {
      const finished = await this._streamChunked(target, run);
      if (this._gen !== run || this.status !== 'uploading') return;
      if (!finished) throw new Error('The upload is paused — it will continue from where it stopped when the connection is back.');
      return;
    }

    // Small file: one streaming POST, response read directly.
    this.abortCtl = new AbortController();
    let resp = null;
    try {
      /* ⚠ DONE-NESS RIDES A QUERY PARAM, NOT A HEADER — and this is not a style choice.
       * It was an `x-fx-done` header for about an hour, which broke EVERY upload: a custom request
       * header must be named in the worker's Access-Control-Allow-Headers, and until that worker is
       * deployed the browser's CORS preflight refuses the request outright. The fetch then rejects,
       * classifies as transient, and the queue retries forever — "1 file(s) waiting to upload" with
       * no error anyone can act on.
       * A query param needs no preflight allowance, so a NEW client works against an OLD worker
       * (which simply ignores it) and deploy order stops mattering. Sent explicitly as 1 or 0;
       * ABSENT still means "no change" for engines that predate this. */
      const doneQ = (target.url.includes('?') ? '&' : '?') + 'done=' + (rec.docDone ? '1' : '0');
      resp = await fetch(target.url + doneQ, {
        method: 'POST',
        headers: {
          ...target.headers,
          'content-type': 'application/octet-stream',
          'x-fx-name': encodeURIComponent(rec.name || ''),
          'x-fx-mime': rec.mime || '',
          // Per-text Drive folder identity. Headers, because the body is the raw bytes. A worker
          // that predates them ignores unknown x-fx-* headers, so deploy order cannot break this.
          // rec.docId is the WIRE identity: a Lane A record's queue key is 'media:<docId>' but its
          // bytes belong to <docId>'s folder. Old-format records carry no docId field and fall
          // back to the key — which for them IS the docId (backward-readable by construction).
          'x-fx-doc': rec.docId || this.docId || '',
          'x-fx-doctitle': encodeURIComponent(rec.docTitle || ''),
          'x-fx-folder': rec.docFolderId || '',   // remembered per-text folder id (dedupe)
          // v2 source package: which child folder, and the role tag every consumer matches on.
          // Absent (old records, Lane B) → the text folder untagged, exactly as before.
          ...(rec.sub ? { 'x-fx-sub': rec.sub } : {}),
          ...(rec.role ? { 'x-fx-role': rec.role } : {}),
        },
        body: rec.blob,
        signal: this.abortCtl.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError' || this._gen !== run) throw new Error('aborted');
      throw new Error('The upload could not be sent — check the connection and try again.');
    }
    if (this._gen !== run || this.status !== 'uploading') return;
    const out = await resp.json().catch(() => ({}));
    if (!(resp.ok && out.ok && out.fileId)) {
      throw new Error(out.error === 'no_drive' || out.error === 'reconnect_needed'
        ? 'The researcher\'s Google Drive connection needs attention — this upload will keep retrying.'
        : 'The upload did not arrive — it will retry when the connection is better.');
    }
    this.indeterminate = false;
    rec.sent = rec.total;
    this.uploadedFileId = out.fileId;   // proof-of-backup — delete-safety unchanged
    this.uploadedFolderId = out.folderId || rec.docFolderId || null;   // remembered → next upload reuses it
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
          'x-fx-range': range,   // NOT Content-Range: Cloudflare's edge validates that literally and 400s the probe
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
    this.uploadedFolderId = rec.folderId || rec.docFolderId || null;
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
          body: JSON.stringify({ name: rec.name, mime: rec.mime, size: rec.total,
                                 // Same wire-identity rule as the single-POST path: rec.docId
                                 // (lane records) falls back to the queue key (old records).
                                 docId: rec.docId || this.docId || '', docTitle: rec.docTitle || '',
                                 folderId: rec.docFolderId || '',
                                 done: rec.docDone ? '1' : '0',   // JSON body — see the query-param note on the single-POST path
                                 ...(rec.sub ? { sub: rec.sub } : {}),
                                 ...(rec.role ? { role: rec.role } : {}) }),
        });
        out = await r.json().catch(() => null);
        if (!r.ok || !out || !out.uploadId) return false;   // no_drive/network → caller decides
      } catch { return false; }
      rec.streamId = out.uploadId;
      rec.folderId = out.folderId || rec.docFolderId || '';   // persists with the session state
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

}

// Pending uploads persisted from a previous session (restarted from 0 — the
// proxy upload has no byte-level resume).
export async function listPendingUploads() {
  const keys = await db.listMediaKeys().catch(() => []);
  const out = [];
  for (const k of keys) {
    if (String(k).startsWith('upload:')) {
      const rec = await db.getMedia(k).catch(() => null);
      if (rec?.blob && rec.name) out.push({ docId: String(k).slice(7), rec });
    }
  }
  return out;
}
