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

/* ---------------- Google Drive link parsing ---------------- */

// Accepts any common Drive share-link shape and returns the file id, or null.
export function driveFileId(text) {
  const s = String(text).trim();
  let m = s.match(/drive\.google\.com\/file\/d\/([\w-]{10,})/);
  if (m) return m[1];
  m = s.match(/drive\.google\.com\/(?:open|uc|download)\?[^#]*\bid=([\w-]{10,})/);
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
export async function fetchAudio(url, onProgress) {
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
  const name = decodeURIComponent((url.split('/').pop() || 'audio').split('?')[0]) || 'audio';
  const mimeType = ctype.split(';')[0] || 'audio/mpeg';
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

const RELAY_CHUNK = 512 * 1024;     // bytes per relay request
const SAVE_EVERY = 256 * 1024;      // persist partial progress this often
const RETRIES = 3;                  // per-chunk attempts before giving up

const partialKey = (docId) => 'partial:' + docId;
const activeDownloads = new Map();  // docId -> AudioDownload

export function getDownload(docId) { return activeDownloads.get(docId) || null; }

export class AudioDownload {
  // onState({ status: 'downloading'|'paused'|'error'|'done', received, total })
  constructor(docId, url, onState) {
    this.docId = docId;
    this.url = url;
    this.onState = onState;
    this.status = 'downloading';
    this.received = 0;
    this.total = 0;
    this.abortCtl = null;
    this.donePromise = null;
    this._gen = 0; // run generation: invalidates loops superseded by reset/resume
  }

  emit() {
    this.onState({
      status: this.status,
      received: this.received,
      total: this.total,
      storage: !!this.storageIssue,
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
          this.emit();
          throw e;
        }
        if (attempt + 1 >= RETRIES) {
          this.status = 'error';                             // keep partial
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

  async _complete(blob, name, mimeType) {
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
      const resp = await fetch(
        `${this.url}${sep}start=${part.received}&len=${RELAY_CHUNK}`,
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
    if (!resp.ok && resp.status !== 206) throw new Error('HTTP ' + resp.status);

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
    part.name = part.name ||
      (decodeURIComponent((this.url.split('/').pop() || 'audio').split('?')[0]) || 'audio');

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
  const dl = new AudioDownload(rec.id, url, onState);
  return dl.start();
}

// Discard saved partial progress for a doc (used by "start over").
export function clearPartial(docId) {
  return db.deleteMedia(partialKey(docId)).catch(() => {});
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
  constructor(root, { onPeaks, onRemove, labels }) {
    this.root = root;
    this.onPeaks = onPeaks;
    this.labels = labels;
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

    this.el.play.addEventListener('click', () => this.ws?.playPause());
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
      dragToSeek: true,
    };
    if (media.peaks && media.duration) {
      opts.peaks = media.peaks;
      opts.duration = media.duration;
    }
    this.ws = WaveSurfer.create(opts);

    this.ws.on('ready', (duration) => {
      this.el.status.hidden = true;
      this.updateTime();
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
      this.el.status.textContent = this.labels.error + ' ' + (err?.message || err || '');
      this.el.status.hidden = false;
    });
    this.ws.on('play', () => { this.el.play.textContent = '⏸'; });
    this.ws.on('pause', () => { this.el.play.textContent = '▶'; });
    this.ws.on('finish', () => { this.el.play.textContent = '▶'; });
    this.ws.on('timeupdate', () => this.updateTime());
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

  destroyWs() {
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
