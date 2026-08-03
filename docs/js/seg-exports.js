/* Segmentation export formats — EAF (ELAN-for-FLEx + SayMore profiles), the standalone
 * audio-segment preview page, and the BWF `bext` provenance chunk for derived WAVs.
 *
 * FORMAT MODULE RULES (CLAUDE.md / plan): imports nothing but other format modules — no DOM, no
 * settings, no IndexedDB, no i18n. Input is a plain doc object (+ explicit options); output is a
 * string or ArrayBuffer. Must run under plain `node` (test/seg-exports.test.mjs does exactly that).
 * Satellites load this file cross-path, so it is a SHELL entry in the editor AND both satellite
 * service workers.
 *
 * ⚠ NO SEGNUM IN EAF FILES (Seth, 2026-08-03): line numbers are display sugar, not data. The EAF
 * carries only real content — baseline text, words, word glosses, free translations, times.
 */

import { esc } from './flextext.js';

/* ---------------- shared helpers ---------------- */

const isAligned = (s) => !!s && typeof s.start === 'number' && typeof s.end === 'number' && !s.timePending;

// One phrase per paragraph is the segmentation-mode invariant (flat mode); walk paragraphs and
// pair phrase i with time segment i. Docs that violate the invariant simply get no time pairing
// for the extra phrases — never a crossed pairing.
function phraseRows(doc) {
  const segs = Array.isArray(doc.segments) ? doc.segments : [];
  const rows = [];
  let i = 0;
  for (const para of doc.paragraphs || []) {
    for (const phrase of para.segments || []) {
      rows.push({ phrase, span: para.segments.length === 1 ? (segs[i] || null) : null });
    }
    i++;
  }
  return rows;
}

export function fmtClock(ms) {
  const t = Math.max(0, Math.round(ms));
  const m = Math.floor(t / 60000), s = Math.floor((t % 60000) / 1000), f = t % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
}

/* ---------------- EAF (ELAN Annotation Format 3.0) ---------------- */

/* Two profiles from ONE writer — the tier-NAMING is the only difference (verified: SayMore
 * requires literal `Transcription` / `Free Translation` tier names; ELAN's FLEx importer decodes
 * `A_<element>-<item-type>-<language>`). Everything else — shared TIME_SLOTs, dependent-tier
 * stereotypes, pending segments as slots WITHOUT TIME_VALUE (ELAN's own unaligned mechanism) —
 * is identical and schema-verified in the plan. Word + word-gloss tiers ride along in BOTH
 * profiles (SayMore is expected to ignore them — verify with a real install before promising). */
export function serializeEaf(doc, opts = {}) {
  const { profile = 'flex', vern = 'und', anal = 'en', mediaName = '', mediaMime = 'audio/x-wav' } = opts;
  const names = profile === 'saymore'
    ? { phrase: 'Transcription', free: 'Free Translation', word: `A_word-txt-${vern}`, gloss: `A_word-gls-${anal}` }
    : { phrase: `A_phrase-txt-${vern}`, free: `A_phrase-gls-${anal}`, word: `A_word-txt-${vern}`, gloss: `A_word-gls-${anal}` };

  const rows = phraseRows(doc);
  // TIME_ORDER: one slot per boundary; contiguous aligned neighbours SHARE the joint slot.
  // Pending spans get their own value-less slots (schema-legal; ELAN interpolates their position).
  const slots = [];
  const slot = (value) => { const id = 'ts' + (slots.length + 1); slots.push({ id, value }); return id; };
  let prev = null;                       // { span, endSlot }
  const anns = [];                       // { id, ts1, ts2, text, words:[{id, text, gloss}], free }
  let aid = 0;
  for (const r of rows) {
    const a = { id: 'a' + (++aid), text: r.phrase.baseline || '', free: r.phrase.free || '', words: [] };
    if (isAligned(r.span)) {
      a.ts1 = (prev && isAligned(prev.span) && prev.span.end === r.span.start) ? prev.endSlot : slot(r.span.start);
      a.ts2 = slot(r.span.end);
    } else {
      a.ts1 = slot(undefined);
      a.ts2 = slot(undefined);
    }
    for (const w of r.phrase.words || []) {
      a.words.push({ id: 'a' + (++aid), text: w.txt || '', gloss: (!w.punct && w.gls) ? w.gls : '' });
    }
    prev = { span: r.span, endSlot: a.ts2 };
    anns.push(a);
  }

  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push(`<ANNOTATION_DOCUMENT AUTHOR="FlexText Editor" DATE="${esc(opts.date || new Date().toISOString())}" FORMAT="3.0" VERSION="3.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.mpi.nl/tools/elan/EAFv3.0.xsd">`);
  L.push('  <HEADER MEDIA_FILE="" TIME_UNITS="milliseconds">');
  if (mediaName) {
    // RELATIVE_MEDIA_URL beside a matching basename is what makes ELAN/SayMore find the media
    // with NO relinking dialog — the highest-value line in this writer (plan: media-relinking).
    L.push(`    <MEDIA_DESCRIPTOR MEDIA_URL="file:///./${esc(mediaName)}" MIME_TYPE="${esc(mediaMime)}" RELATIVE_MEDIA_URL="./${esc(mediaName)}"/>`);
  }
  L.push('  </HEADER>');
  L.push('  <TIME_ORDER>');
  for (const s of slots) {
    L.push(s.value === undefined
      ? `    <TIME_SLOT TIME_SLOT_ID="${s.id}"/>`
      : `    <TIME_SLOT TIME_SLOT_ID="${s.id}" TIME_VALUE="${Math.round(s.value)}"/>`);
  }
  L.push('  </TIME_ORDER>');

  // Baseline: the only time-aligned tier. Empty segments export with an empty ANNOTATION_VALUE
  // (schema-legal) — a timed span of silence is real data.
  L.push(`  <TIER LINGUISTIC_TYPE_REF="phrase" TIER_ID="${esc(names.phrase)}">`);
  for (const a of anns) {
    L.push(`    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="${a.id}" TIME_SLOT_REF1="${a.ts1}" TIME_SLOT_REF2="${a.ts2}"><ANNOTATION_VALUE>${esc(a.text)}</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>`);
  }
  L.push('  </TIER>');

  // Words: Symbolic_Subdivision of the phrase (ordered children, no times of their own).
  L.push(`  <TIER LINGUISTIC_TYPE_REF="word" PARENT_REF="${esc(names.phrase)}" TIER_ID="${esc(names.word)}">`);
  for (const a of anns) {
    let prevW = null;
    for (const w of a.words) {
      const chain = prevW ? ` PREVIOUS_ANNOTATION="${prevW}"` : '';
      L.push(`    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="${w.id}" ANNOTATION_REF="${a.id}"${chain}><ANNOTATION_VALUE>${esc(w.text)}</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>`);
      prevW = w.id;
    }
  }
  L.push('  </TIER>');

  // Word glosses: Symbolic_Association on the WORD (1:1) — chaining to words, not the phrase,
  // is what binds each gloss to its specific word.
  L.push(`  <TIER LINGUISTIC_TYPE_REF="wordGloss" PARENT_REF="${esc(names.word)}" TIER_ID="${esc(names.gloss)}">`);
  for (const a of anns) {
    for (const w of a.words) {
      if (!w.gloss) continue;
      L.push(`    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="a${++aid}" ANNOTATION_REF="${w.id}"><ANNOTATION_VALUE>${esc(w.gloss)}</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>`);
    }
  }
  L.push('  </TIER>');

  // Free translation: Symbolic_Association on the phrase. Empty → no annotation at all.
  L.push(`  <TIER LINGUISTIC_TYPE_REF="phraseGloss" PARENT_REF="${esc(names.phrase)}" TIER_ID="${esc(names.free)}">`);
  for (const a of anns) {
    if (!a.free) continue;
    L.push(`    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="a${++aid}" ANNOTATION_REF="${a.id}"><ANNOTATION_VALUE>${esc(a.free)}</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>`);
  }
  L.push('  </TIER>');

  // The stereotype names are ELAN conventions recognised BY NAME, not schema-enforced — the
  // standard CONSTRAINT declarations below are required for ELAN to interpret the tiers.
  L.push('  <LINGUISTIC_TYPE GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="phrase" TIME_ALIGNABLE="true"/>');
  L.push('  <LINGUISTIC_TYPE CONSTRAINTS="Symbolic_Subdivision" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="word" TIME_ALIGNABLE="false"/>');
  L.push('  <LINGUISTIC_TYPE CONSTRAINTS="Symbolic_Association" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="wordGloss" TIME_ALIGNABLE="false"/>');
  L.push('  <LINGUISTIC_TYPE CONSTRAINTS="Symbolic_Association" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="phraseGloss" TIME_ALIGNABLE="false"/>');
  L.push('  <CONSTRAINT DESCRIPTION="Time subdivision of parent annotation\'s time interval, no time gaps allowed within this interval" STEREOTYPE="Time_Subdivision"/>');
  L.push('  <CONSTRAINT DESCRIPTION="Symbolic subdivision of a parent annotation. Annotations refering to the same parent are ordered" STEREOTYPE="Symbolic_Subdivision"/>');
  L.push('  <CONSTRAINT DESCRIPTION="1-1 association with a parent annotation" STEREOTYPE="Symbolic_Association"/>');
  L.push('  <CONSTRAINT DESCRIPTION="Time alignable annotations within the parent annotation\'s time interval, gaps are allowed" STEREOTYPE="Included_In"/>');
  L.push('</ANNOTATION_DOCUMENT>');
  return L.join('\n') + '\n';
}

/* ---------------- standalone segment preview page ---------------- */

/* A single self-contained HTML file: the interlinear rows + per-segment playback, with the audio
 * embedded as base64 and turned into a blob URL at load. Purpose (Seth): a researcher keeps this
 * open in a browser and alt-tabs to it while doing interlinear/charting work in FLEx — no app, no
 * server, no network. English-only on purpose: it is a researcher-side artifact. */
export function buildSegPreviewHtml(doc, opts = {}) {
  const { title = 'Text', audioB64 = '', audioMime = 'audio/wav', mediaName = '' } = opts;
  const rows = phraseRows(doc);
  const body = rows.map((r) => {
    const t = r.phrase;
    const timed = isAligned(r.span);
    const est = timed && r.span.timeEstimated ? '~' : '';
    const time = timed ? `${est}${fmtClock(r.span.start)}–${fmtClock(r.span.end)}` : '';
    const words = (t.words || []).map((w) => w.punct
      ? `<span class="w punct"><span class="wt">${esc(w.txt)}</span></span>`
      : `<span class="w"><span class="wt">${esc(w.txt)}</span><span class="wg">${esc(w.gls || ' ')}</span></span>`).join('');
    const free = t.free ? `<div class="free">${esc(t.free)}</div>` : '';
    const blank = !(t.baseline || '').trim() && !(t.words || []).length;
    return `<div class="seg${blank ? ' blank' : ''}"${timed ? ` data-s="${Math.round(r.span.start)}" data-e="${Math.round(r.span.end)}"` : ''}>
  <button class="play"${timed ? '' : ' disabled'}>${timed ? '&#9654;' : '&#8943;'}</button>
  <div class="cell"><div class="meta">${esc(time)}</div>${blank ? '<div class="blanklbl">(blank line)</div>' : `<div class="words">${words}</div>${free}`}</div>
</div>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — segments</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.5 -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif; padding: 16px clamp(10px, 4vw, 40px) 60px; }
  h1 { font-size: 19px; margin: 4px 0 2px; }
  .src { opacity: .6; font-size: 12px; margin-bottom: 14px; }
  .seg { display: flex; gap: 10px; align-items: flex-start; padding: 8px 6px; border-bottom: 1px solid rgba(127,127,127,.25); }
  .seg.on { background: rgba(80,130,220,.12); }
  .seg.blank { opacity: .55; }
  .play { flex: none; width: 40px; height: 40px; font-size: 15px; border-radius: 8px; border: 1px solid rgba(127,127,127,.4); background: transparent; cursor: pointer; }
  .play:disabled { opacity: .4; cursor: default; }
  .meta { font-size: 11px; opacity: .6; font-variant-numeric: tabular-nums; }
  .words { display: flex; flex-wrap: wrap; gap: 2px 14px; margin: 2px 0; }
  .w { display: inline-flex; flex-direction: column; }
  .wt { color: #2555b0; font-size: 17px; }
  .wg { color: #2a6e2a; font-size: 13px; }
  .blanklbl, .free { font-style: italic; }
  .free { margin-top: 2px; }
  .note { font-size: 12px; opacity: .6; margin-top: 18px; }
</style></head><body>
<h1>${esc(title)}</h1>
<div class="src">${esc(mediaName)}</div>
${body}
<p class="note">Generated by FlexText Editor. Audio is embedded in this file — it works offline and needs no other files.</p>
<script>
(function () {
  var b64 = "__AUDIO_B64__";
  var bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  var audio = new Audio(URL.createObjectURL(new Blob([u8], { type: ${JSON.stringify(audioMime)} })));
  var stopAt = 0, active = null;
  audio.addEventListener('timeupdate', function () {
    if (stopAt && audio.currentTime * 1000 >= stopAt - 20) { audio.pause(); }
  });
  audio.addEventListener('pause', function () { paint(); });
  audio.addEventListener('play', function () { paint(); });
  function paint() {
    document.querySelectorAll('.seg').forEach(function (row) {
      var on = row === active && !audio.paused;
      row.classList.toggle('on', row === active);
      var b = row.querySelector('.play');
      if (b && !b.disabled) b.innerHTML = on ? '&#9208;' : '&#9654;';
    });
  }
  document.querySelectorAll('.seg[data-s]').forEach(function (row) {
    row.querySelector('.play').addEventListener('click', function () {
      var s = +row.dataset.s, e = +row.dataset.e;
      var t = audio.currentTime * 1000;
      if (!audio.paused && row === active) { audio.pause(); return; }
      active = row;
      audio.currentTime = ((t > s && t < e - 150) ? t : s) / 1000;   // resume-in-span, like the app
      stopAt = e;
      audio.play();
    });
  });
})();
</script>
</body></html>`.replace('__AUDIO_B64__', audioB64);
}

/* ---------------- BWF bext chunk (derived-WAV honesty in the BYTES) ---------------- */

/* Insert a Broadcast Wave `bext` chunk (EBU Tech 3285) into a plain RIFF/WAVE buffer. Filenames
 * get renamed; the bext CodingHistory is the label that SURVIVES — it states the true lossy
 * origin and that this file is NOT an archival master ([[audio-archival-standards]]). The chunk
 * is inserted before `data`; RIFF size is updated. Input buffer is not modified. */
export function wavWithBext(buf, opts = {}) {
  const src = new Uint8Array(buf);
  const dv = new DataView(buf);
  if (src.length < 12 || dv.getUint32(0) !== 0x52494646 /* RIFF */) return buf;
  const enc = (s, len) => {
    const out = new Uint8Array(len);
    for (let i = 0; i < Math.min(s.length, len); i++) out[i] = s.charCodeAt(i) & 0x7f;
    return out;
  };
  const history = (opts.codingHistory || '').replace(/\n/g, '\r\n') + '\r\n';
  const histBytes = enc(history, history.length + (history.length % 2)); // pad to even
  const now = opts.date ? new Date(opts.date) : new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const chunkLen = 602 + histBytes.length;
  const bext = new Uint8Array(8 + chunkLen);
  const bdv = new DataView(bext.buffer);
  bext.set(enc('bext', 4), 0);
  bdv.setUint32(4, chunkLen, true);
  bext.set(enc(opts.description || '', 256), 8);                                  // Description
  bext.set(enc(opts.originator || 'FlexText Editor', 32), 8 + 256);               // Originator
  bext.set(enc(opts.originatorRef || '', 32), 8 + 288);                           // OriginatorReference
  bext.set(enc(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, 10), 8 + 320);
  bext.set(enc(`${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, 8), 8 + 330);
  bdv.setUint16(8 + 346, 2, true);                                                // Version 2
  // TimeReference(8) zero, UMID(64) zero, loudness fields (10) zero, Reserved(180) zero.
  bext.set(histBytes, 8 + 602);
  // Splice after the fmt chunk (before whatever follows it — usually `data`).
  let off = 12;
  while (off + 8 <= src.length) {
    const id = String.fromCharCode(src[off], src[off + 1], src[off + 2], src[off + 3]);
    const size = dv.getUint32(off + 4, true);
    off += 8 + size + (size % 2);
    if (id === 'fmt ') break;
  }
  const out = new Uint8Array(src.length + bext.length);
  out.set(src.subarray(0, off), 0);
  out.set(bext, off);
  out.set(src.subarray(off), off + bext.length);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);                    // RIFF size
  return out.buffer;
}
