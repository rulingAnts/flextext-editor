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

// Download audio for a doc record and store it. Returns the media record.
export async function downloadAudioForDoc(rec, url, onProgress) {
  const { blob, name, mimeType } = await fetchAudio(url, onProgress);
  const media = { blob, name, mimeType, sourceUrl: url, peaks: null, duration: null };
  await db.putMedia(rec.id, media);
  return media;
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
