/* Segment strips — the segmentation-mode baseline editor (Seth's 2026-08-03 redesign).
 *
 * Each segment renders as a STRIP: [play button | waveform slice | single-line text box], stacked
 * vertically. Enter breaks the waveform at the PLAYHEAD and the text at the CURSOR, starting a new
 * strip beneath; Backspace at the start of a strip (or Delete at the end) merges it with its
 * neighbour — text joins, spans join. A continuous player lives at the bottom of the tab (the
 * app's existing Player); strips are VIEWS onto it, never players of their own.
 *
 * ⚠ ONE DECODE, ONE PEAKS ARRAY, NO PER-STRIP AUDIO. Each strip draws its [start,end) sub-range of
 * a single shared peaks array onto its own small canvas. N wavesurfers would re-open the memory
 * problem the RAM-cap work exists to prevent; peaks are computed once per doc and the decoded
 * AudioBuffer is released immediately after.
 *
 * ⚠ THE MODEL OWNS THE INVARIANTS. Every edit routes through segments.js
 * (boundaryAtPlayhead / mergeSegments / normalizeSegments): segments can never cross, a time is
 * never invented (out-of-range playhead → timePending, text still splits — text is sacred), and
 * strip order IS paragraph order. This file is rendering + wiring only.
 *
 * ⚠ NO AUDIO IS EVER EDITED. Strips are metadata pointing INTO an untouched recording; peaks are a
 * DISPLAY of samples, never a modification of them.
 */

import { normalizeSegments, boundaryAtPlayhead, mergeSegments, syncToLines, isAligned } from './segments.js';

let deps = null;      // { container, textarea, getPlayer, getDoc, getParagraphs, setParagraphs, persist, t }
let peaksCache = { docId: null, peaks: null, durationMs: 0 };
let rafId = 0;

export function initStrips(d) { deps = d; }

/* ---------------- peaks (one decode per doc, buffer released immediately) ---------------- */

const BUCKETS = 4000;   // ~4k buckets across the whole file → plenty for strip-width canvases

export async function ensurePeaks(docId, blob) {
  if (peaksCache.docId === docId && peaksCache.peaks) return peaksCache;
  peaksCache = { docId, peaks: null, durationMs: 0 };
  if (!blob) return peaksCache;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const ch = buf.getChannelData(0);
    const peaks = new Float32Array(BUCKETS);
    const per = Math.max(1, Math.floor(ch.length / BUCKETS));
    for (let b = 0; b < BUCKETS; b++) {
      let m = 0;
      const off = b * per, end = Math.min(ch.length, off + per);
      for (let i = off; i < end; i += 4) { const v = Math.abs(ch[i]); if (v > m) m = v; }  // stride 4: display, not measurement
      peaks[b] = m;
    }
    peaksCache = { docId, peaks, durationMs: Math.round(buf.duration * 1000) };
    try { ctx.close(); } catch { /* noop */ }
  } catch { /* undecodable (or no Web Audio) → strips render without waveforms */ }
  return peaksCache;
}

/* ---------------- segment state on the doc ---------------- */

export function docSegments(doc) {
  if (!doc.segments || !Array.isArray(doc.segments)) doc.segments = [];
  return doc.segments;
}

// Keep segments 1:1 with paragraphs, using the model's own repair (extra → merged, missing →
// timePending), so a doc edited on a non-segmentation device re-opens sane here.
function reconcile(doc) {
  const paras = deps.getParagraphs(doc);
  const segs = docSegments(doc);
  // SEED: a doc entering segmentation for the first time gets ONE segment spanning the whole
  // recording — that is the truthful starting state (nothing has been divided yet), and it is what
  // makes the first Enter actually have a time span to break. Without it every strip starts
  // timePending and no boundary can ever be real.
  if (!segs.length && peaksCache.durationMs > 0) {
    doc.segments = [{ start: 0, end: peaksCache.durationMs }];
  }
  doc.segments = syncToLines(docSegments(doc), paras.length, { duration: peaksCache.durationMs || null });
  return doc.segments;
}

/* ---------------- rendering ---------------- */

export function renderStrips() {
  const doc = deps.getDoc();
  if (!doc) return;
  const segs = reconcile(doc);
  const paras = deps.getParagraphs(doc);
  const host = deps.container;
  host.innerHTML = '';
  const dur = peaksCache.durationMs || (segs.length && isAligned(segs[segs.length - 1]) ? segs[segs.length - 1].end : 0);

  paras.forEach((text, i) => {
    const seg = segs[i] || { timePending: true };
    const row = document.createElement('div');
    row.className = 'seg-strip' + (isAligned(seg) ? '' : ' seg-pending') + (text.trim() ? '' : ' seg-empty');
    row.dataset.i = i;

    const play = document.createElement('button');
    play.className = 'seg-play';
    play.title = deps.t(isAligned(seg) ? 'seg.playTip' : 'seg.pendingTip');
    play.textContent = isAligned(seg) ? '▶' : '⋯';
    play.addEventListener('click', () => {
      if (!isAligned(seg)) return;
      const p = deps.getPlayer();
      if (!p) return;
      // Toggle: if THIS segment is the one rolling, pause IN PLACE — the parked playhead is what
      // the user then breaks at with Enter. Anything else (stopped, or another segment playing)
      // starts this segment's span.
      const t = p.playheadMs?.();
      if (p.playing?.() && typeof t === 'number' && t >= seg.start && t < seg.end) p.pause();
      else p.playSpan(seg.start, seg.end);
    });

    const wave = document.createElement('canvas');
    wave.className = 'seg-wave';
    wave.height = 44;
    // Click to POSITION the playhead inside this segment; drag to scrub (Seth). Position only —
    // play/pause stays whatever it was, so the flow is: click (or drag) to park, then Enter to
    // break there, or ▶ to listen from there.
    if (isAligned(seg)) {
      const seekAt = (ev) => {
        const r = wave.getBoundingClientRect();
        const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
        deps.getPlayer()?.seekMs?.(seg.start + f * (seg.end - seg.start));
      };
      wave.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        wave.setPointerCapture(ev.pointerId);
        seekAt(ev);
        const move = (e2) => seekAt(e2);
        const up = () => { wave.removeEventListener('pointermove', move); wave.removeEventListener('pointerup', up); };
        wave.addEventListener('pointermove', move);
        wave.addEventListener('pointerup', up);
      });
    }

    const input = document.createElement('input');
    input.className = 'seg-text';
    input.value = text;
    input.spellcheck = false;
    input.addEventListener('input', () => commitTexts());
    input.addEventListener('keydown', (e) => onKey(e, i, input));

    row.append(play, wave, input);
    host.appendChild(row);
    drawStrip(wave, seg, dur);
  });
  positionCursor();
}

function drawStrip(canvas, seg, durationMs) {
  const w = canvas.clientWidth || 300;
  canvas.width = w * (window.devicePixelRatio || 1);
  const g = canvas.getContext('2d');
  const H = canvas.height, W = canvas.width;
  g.clearRect(0, 0, W, H);
  const peaks = peaksCache.peaks;
  if (!peaks || !isAligned(seg) || !durationMs) {
    // No waveform available (pending segment, undecoded, or no audio): a flat midline says so
    // honestly instead of drawing invented shape.
    g.fillStyle = 'rgba(120,130,150,.45)';
    g.fillRect(0, H / 2 - 1, W, 2);
    return;
  }
  const b0 = Math.floor((seg.start / durationMs) * BUCKETS);
  const b1 = Math.max(b0 + 1, Math.ceil((seg.end / durationMs) * BUCKETS));
  g.fillStyle = '#1f4f8f';
  const n = b1 - b0;
  for (let x = 0; x < W; x++) {
    const p = peaks[b0 + Math.floor((x / W) * n)] || 0;
    const h = Math.max(2, p * (H - 4));
    g.fillRect(x, (H - h) / 2, 1, h);
  }
}

/* ---------------- edits: Enter splits, Backspace/Delete merges ---------------- */

function onKey(e, i, input) {
  const doc = deps.getDoc();
  if (e.key === 'Enter') {
    e.preventDefault();
    const c = input.selectionStart ?? input.value.length;
    const paras = deps.getParagraphs(doc).slice();
    paras.splice(i, 1, input.value.slice(0, c), input.value.slice(c));
    // Waveform breaks at the PLAYHEAD; out-of-range → timePending, text splits regardless.
    doc.segments = boundaryAtPlayhead(docSegments(doc), i, deps.getPlayer()?.playheadMs?.() ?? null,
                                      { duration: peaksCache.durationMs || null });
    deps.setParagraphs(doc, paras);
    deps.persist();
    renderStrips();
    focusStrip(i + 1, 0);
  } else if (e.key === 'Backspace' && (input.selectionStart ?? 0) === 0 && (input.selectionEnd ?? 0) === 0 && i > 0) {
    e.preventDefault();
    mergeAt(i - 1, i);
  } else if (e.key === 'Delete' && input.selectionStart === input.value.length && input.selectionEnd === input.value.length
             && i < deps.getParagraphs(doc).length - 1) {
    e.preventDefault();
    mergeAt(i, i + 1, /* caretAtJoin */ true);
  }
}

function mergeAt(a, b, caretAtJoin) {
  const doc = deps.getDoc();
  const paras = deps.getParagraphs(doc).slice();
  const joinPos = paras[a].length;
  paras.splice(a, 2, paras[a] + paras[b]);
  doc.segments = mergeSegments(docSegments(doc), a, { duration: peaksCache.durationMs || null });
  deps.setParagraphs(doc, paras);
  deps.persist();
  renderStrips();
  focusStrip(a, caretAtJoin ? joinPos : joinPos);
}

function commitTexts() {
  const doc = deps.getDoc();
  const inputs = deps.container.querySelectorAll('.seg-text');
  deps.setParagraphs(doc, [...inputs].map((el) => el.value));
  deps.persist();
}

function focusStrip(i, caret) {
  const el = deps.container.querySelectorAll('.seg-text')[i];
  if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch { /* noop */ } }
}

/* ---------------- playhead cursor across strips ---------------- */

function positionCursor() {
  cancelAnimationFrame(rafId);
  const tick = () => {
    const p = deps.getPlayer();
    const t = p?.playheadMs?.();
    const dur = peaksCache.durationMs;
    deps.container.querySelectorAll('.seg-strip').forEach((row, i) => {
      const seg = docSegments(deps.getDoc())[i];
      let cur = row.querySelector('.seg-cursor');
      const inSeg = seg && isAligned(seg) && typeof t === 'number' && t >= seg.start && t < seg.end;
      const btn = row.querySelector('.seg-play');
      if (btn && seg && isAligned(seg)) {
        const rolling = p?.playing?.() && inSeg;
        const want = rolling ? '⏸' : '▶';
        if (btn.textContent !== want) {
          btn.textContent = want;
          btn.title = deps.t(rolling ? 'seg.pauseTip' : 'seg.playTip');
        }
      }
      if (inSeg) {
        if (!cur) { cur = document.createElement('div'); cur.className = 'seg-cursor'; row.appendChild(cur); }
        const wave = row.querySelector('.seg-wave');
        const frac = (t - seg.start) / (seg.end - seg.start);
        cur.style.left = (wave.offsetLeft + frac * wave.offsetWidth) + 'px';
        cur.style.top = wave.offsetTop + 'px';
        cur.style.height = wave.offsetHeight + 'px';
      } else if (cur) cur.remove();
    });
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

export function stopStrips() { cancelAnimationFrame(rafId); }
