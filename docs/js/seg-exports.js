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
// pair phrase i with time segment i. Span precedence per phrase (audit find — a multi-phrase
// paragraph, e.g. merged in ELAN, exported every phrase as PENDING even though each carried its
// own offsets): 1) the LIVE app span when aligned (newest truth for single-phrase paragraphs),
// 2) the phrase's own begin/end-time-offset attributes (imported alignment), 3) pending.
function phraseRows(doc) {
  const segs = Array.isArray(doc.segments) ? doc.segments : [];
  const rows = [];
  let i = 0;
  for (const para of doc.paragraphs || []) {
    for (const phrase of para.segments || []) {
      const b = parseInt(phrase.attrs && phrase.attrs['begin-time-offset'], 10);
      const e = parseInt(phrase.attrs && phrase.attrs['end-time-offset'], 10);
      const own = (Number.isFinite(b) && Number.isFinite(e) && e > b) ? { start: b, end: e } : null;
      const live = para.segments.length === 1 ? (segs[i] || null) : null;
      rows.push({ phrase, span: (live && isAligned(live)) ? live : (own || live) });
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

/* ---------------- .fxpa (FlexText Paragraph Analysis) ---------------- */

/* The interchange for the Paragraph Analysis satellite (Seth, 2026-08-05): JSON inside, a
 * proprietary `.fxpa` extension outside (`.fxp` is FL Studio's; `.fxpa` has no known claimant).
 * OPTIONAL and NOT primary — flextext remains the suite's canonical format; this exists so the
 * paragraph app can carry a grouping TREE + embedded audio in one portable file.
 *
 * Shape: { format, version, title, vernLang, analLang, audio?, lines[], tree[] } —
 * - lines carry STABLE ids (L1..Ln, minted here): tree nodes reference ids, never indexes, so
 *   the grouping survives later bottom-level edits.
 * - TEXT-ONLY is first-class: `audio` may be absent, and a line without alignment simply has no
 *   start/end — the app then works without players/waves (a flextext with no segmentation, or
 *   no audio at all, is a legitimate source).
 * - `speaker` on a line + the optional top-level `speakers[]` — flextext's phrase-level model,
 *   which is what EAF's tier-per-speaker collapses INTO on import. Absent when there is one
 *   speaker, so older files and single-speaker texts are unaffected.
 * - `tree` is written by the paragraph app (empty at export): nodes
 *   { id, level, children[ids], joinType: 'sym'|'asym', head? (asym only), relation,
 *     labels? { childId: 'role' } }. BOTH labels are optional and independent: `relation` names
 *   the whole group, `labels` names each member's role in it (the SSA convention).
 * Returns a plain object; the caller JSON.stringifies it into the `.fxpa` file. */
export function buildFxpa(doc, opts = {}) {
  const { title = 'Text', vernLang = 'und', analLang = 'en', audio = null } = opts;
  const rows = phraseRows(doc);
  const lines = rows.map((r, i) => {
    const t = r.phrase;
    const line = { id: 'L' + (i + 1), baseline: t.baseline || '' };
    if (isAligned(r.span)) {
      line.start = Math.round(r.span.start);
      line.end = Math.round(r.span.end);
      if (r.span.timeEstimated) line.timeEstimated = true;
    }
    line.words = (t.words || []).map((w) => {
      const o = { txt: w.txt || '' };
      if (w.punct) o.punct = true;
      else if (w.gls) o.gls = w.gls;
      return o;
    });
    if (t.free) line.free = t.free;
    // SPEAKER (Seth, 2026-08-04): flextext carries it per PHRASE and so do we — EAF's
    // tier-per-speaker is collapsed to this on import. Optional: absent in a single-speaker text.
    if (t.speaker) line.speaker = t.speaker;
    return line;
  });
  const out = { format: 'flextext-paragraph-analysis', version: 1, title, vernLang, analLang };
  if (audio && audio.b64) {
    out.audio = { b64: audio.b64, mime: audio.mime || 'audio/wav', name: audio.name || 'audio' };
    if (audio.derived) { out.audio.derived = true; out.audio.srcName = audio.srcName || ''; }
  }
  const speakers = opts.speakers && opts.speakers.length
    ? [...opts.speakers]
    : [...new Set(lines.map((l) => l.speaker).filter(Boolean))];
  if (speakers.length) out.speakers = speakers;
  out.lines = lines;
  out.tree = [];
  return out;
}

/* ---------------- EAF (ELAN Annotation Format 3.0) ---------------- */

/* Two profiles from ONE writer (verified against the ELAN manual + SayMore docs, 2026-08-03):
 *
 * - 'flex': the full ELAN-for-FLEx hierarchy `interlinear-text > paragraph > phrase > word`,
 *   tier names in ELAN's decodable `<Speaker>_<element>-<item-type>-<language>` schema. The
 *   PARAGRAPH tier mirrors the phrase tier annotation-for-annotation, SHARING its time slots
 *   (Seth's design): ELAN can MERGE annotations but not split ones with dependents, so starting
 *   maximally split lets the user build real paragraph structure by joining — the same
 *   over-segment-then-merge logic as pause-based breaking. ELAN's FLEx exporter treats both
 *   structural tiers as optional, so their absence elsewhere is safe.
 * - 'saymore': ONLY the two tiers SayMore documents — literal `Transcription` /
 *   `Free Translation`. SIL's docs say extra tiers are ignored and advise against adding any
 *   (SayMore rewrites annotation files), so word/gloss detail is deliberately NOT included —
 *   it lives in the .eaf and the .flextext (Seth, 2026-08-03).
 *
 * Shared machinery: contiguous boundaries share TIME_SLOTs; pending segments get slots WITHOUT
 * TIME_VALUE (ELAN's own unaligned mechanism); empty (silence) segments are empty aligned
 * annotations. All schema-verified in the plan. */
export function serializeEaf(doc, opts = {}) {
  const { profile = 'flex', vern = 'und', anal = 'en', mediaName = '', mediaMime = 'audio/x-wav' } = opts;
  const flex = profile !== 'saymore';
  const names = flex
    ? { itext: `A_interlinear-text-title-${anal}`, para: 'A_paragraph',
        phrase: `A_phrase-txt-${vern}`, free: `A_phrase-gls-${anal}`,
        word: `A_word-txt-${vern}`, gloss: `A_word-gls-${anal}` }
    : { phrase: 'Transcription', free: 'Free Translation' };

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

  // Structural tiers (flex profile, and only when something is aligned — Included_In children
  // need a real parent span to sit inside). The interlinear-text annotation spans first..last
  // aligned boundary (REUSING those rows' slots, so containment is exact) and carries the title;
  // each paragraph annotation MIRRORS its phrase — same slots, empty value — so the ELAN user
  // can merge paragraphs into real groupings but never needs to split one.
  const alignedAnns = anns.filter((a, k) => isAligned(rows[k].span));
  const structural = flex && alignedAnns.length > 0;
  if (structural) {
    const itextId = 'a' + (++aid);
    L.push(`  <TIER LINGUISTIC_TYPE_REF="interlinear-text" TIER_ID="${esc(names.itext)}">`);
    L.push(`    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="${itextId}" TIME_SLOT_REF1="${alignedAnns[0].ts1}" TIME_SLOT_REF2="${alignedAnns[alignedAnns.length - 1].ts2}"><ANNOTATION_VALUE>${esc(doc.title || '')}</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>`);
    L.push('  </TIER>');
    L.push(`  <TIER LINGUISTIC_TYPE_REF="paragraph" PARENT_REF="${esc(names.itext)}" TIER_ID="${esc(names.para)}">`);
    for (const a of anns) {
      L.push(`    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="a${++aid}" TIME_SLOT_REF1="${a.ts1}" TIME_SLOT_REF2="${a.ts2}"><ANNOTATION_VALUE></ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>`);
    }
    L.push('  </TIER>');
  }

  // Baseline: time-aligned; a child of the paragraph tier when the structure exists. Empty
  // segments export with an empty ANNOTATION_VALUE (schema-legal) — timed silence is real data.
  L.push(`  <TIER LINGUISTIC_TYPE_REF="phrase"${structural ? ` PARENT_REF="${esc(names.para)}"` : ''} TIER_ID="${esc(names.phrase)}">`);
  for (const a of anns) {
    L.push(`    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="${a.id}" TIME_SLOT_REF1="${a.ts1}" TIME_SLOT_REF2="${a.ts2}"><ANNOTATION_VALUE>${esc(a.text)}</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>`);
  }
  L.push('  </TIER>');

  if (flex) {
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
  }

  // Free translation: Symbolic_Association on the phrase. Empty → no annotation at all.
  L.push(`  <TIER LINGUISTIC_TYPE_REF="phraseGloss" PARENT_REF="${esc(names.phrase)}" TIER_ID="${esc(names.free)}">`);
  for (const a of anns) {
    if (!a.free) continue;
    L.push(`    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="a${++aid}" ANNOTATION_REF="${a.id}"><ANNOTATION_VALUE>${esc(a.free)}</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>`);
  }
  L.push('  </TIER>');

  // The stereotype names are ELAN conventions recognised BY NAME, not schema-enforced — the
  // standard CONSTRAINT declarations below are required for ELAN to interpret the tiers.
  // Included_In (not Time_Subdivision) for the structural children: it tolerates gaps and
  // unaligned (pending) members, which Time_Subdivision's no-gaps rule would not.
  if (structural) {
    L.push('  <LINGUISTIC_TYPE GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="interlinear-text" TIME_ALIGNABLE="true"/>');
    L.push('  <LINGUISTIC_TYPE CONSTRAINTS="Included_In" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="paragraph" TIME_ALIGNABLE="true"/>');
    L.push('  <LINGUISTIC_TYPE CONSTRAINTS="Included_In" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="phrase" TIME_ALIGNABLE="true"/>');
  } else {
    L.push('  <LINGUISTIC_TYPE GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="phrase" TIME_ALIGNABLE="true"/>');
  }
  if (flex) {
    L.push('  <LINGUISTIC_TYPE CONSTRAINTS="Symbolic_Subdivision" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="word" TIME_ALIGNABLE="false"/>');
    L.push('  <LINGUISTIC_TYPE CONSTRAINTS="Symbolic_Association" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="wordGloss" TIME_ALIGNABLE="false"/>');
  }
  L.push('  <LINGUISTIC_TYPE CONSTRAINTS="Symbolic_Association" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="phraseGloss" TIME_ALIGNABLE="false"/>');
  L.push('  <CONSTRAINT DESCRIPTION="Time subdivision of parent annotation\'s time interval, no time gaps allowed within this interval" STEREOTYPE="Time_Subdivision"/>');
  L.push('  <CONSTRAINT DESCRIPTION="Symbolic subdivision of a parent annotation. Annotations refering to the same parent are ordered" STEREOTYPE="Symbolic_Subdivision"/>');
  L.push('  <CONSTRAINT DESCRIPTION="1-1 association with a parent annotation" STEREOTYPE="Symbolic_Association"/>');
  L.push('  <CONSTRAINT DESCRIPTION="Time alignable annotations within the parent annotation\'s time interval, gaps are allowed" STEREOTYPE="Included_In"/>');
  L.push('</ANNOTATION_DOCUMENT>');
  return L.join('\n') + '\n';
}

/* ---------------- standalone segment preview page ---------------- */

/* A single self-contained HTML file: a READ-ONLY twin of the segmentation editor (Seth,
 * 2026-08-03) — scrubbable full-track player up top, per-line mini waveforms below, all computed
 * at load from the audio embedded as base64. Purpose: a researcher keeps this open in a browser
 * and alt-tabs to it while doing interlinear/charting work in FLEx — no app, no server, no
 * network. The waveform math mirrors segment-strips.js exactly (2000 buckets/s, exact msPerBucket
 * mapping, range-max vs interpolation regimes, m^0.6 display curve) so the page and the editor
 * show the SAME picture. English-only on purpose: it is a researcher-side artifact. */
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
      : `<span class="w"><span class="wt">${esc(w.txt)}</span><span class="wg">${esc(w.gls || ' ')}</span></span>`).join('');
    const free = t.free ? `<div class="free">${esc(t.free)}</div>` : '';
    const blank = !(t.baseline || '').trim() && !(t.words || []).length;
    const wave = timed ? '<div class="wwrap"><canvas class="rw"></canvas><div class="cur" hidden></div></div>' : '';
    return `<div class="seg${blank ? ' blank' : ''}"${timed ? ` data-s="${Math.round(r.span.start)}" data-e="${Math.round(r.span.end)}"` : ''}>
  <button class="play"${timed ? '' : ' disabled'}>${timed ? '&#9654;' : '&#8943;'}</button>
  <div class="cell"><div class="meta">${esc(time)}</div>${wave}${blank ? '<div class="blanklbl">(blank line)</div>' : `<div class="words">${words}</div>${free}`}</div>
</div>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — segments</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.5 -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif; padding: 16px clamp(10px, 4vw, 40px) 60px; }
  h1 { font-size: 19px; margin: 4px 0 2px; }
  .src { opacity: .6; font-size: 12px; margin-bottom: 10px; }
  .player { position: sticky; top: 0; background: Canvas; padding: 6px 0 4px; z-index: 5;
            border-bottom: 1px solid rgba(127,127,127,.35); margin-bottom: 8px; }
  .wwrap { position: relative; }
  #ov { width: 100%; height: 72px; display: block; cursor: crosshair; touch-action: none; }
  .rw { width: 100%; height: 26px; display: block; cursor: crosshair; touch-action: none; }
  .cur { position: absolute; top: 0; bottom: 0; width: 2px; background: #d33; pointer-events: none; }
  .bar { display: flex; gap: 10px; align-items: center; margin-top: 6px; }
  #mplay { width: 44px; height: 36px; font-size: 15px; border-radius: 8px; border: 1px solid rgba(127,127,127,.4); background: transparent; cursor: pointer; }
  #mtime { font-size: 13px; opacity: .7; font-variant-numeric: tabular-nums; }
  .seg { display: flex; gap: 10px; align-items: flex-start; padding: 8px 6px; border-bottom: 1px solid rgba(127,127,127,.25); }
  .seg.on { background: rgba(80,130,220,.12); }
  .seg.blank { opacity: .55; }
  .seg .cell { flex: 1; min-width: 0; }
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
<div class="player">
  <div class="wwrap"><canvas id="ov"></canvas><div class="cur" id="ovcur"></div></div>
  <div class="bar"><button id="mplay">&#9654;</button><span id="mtime"></span></div>
</div>
${body}
<p class="note">Generated by FlexText Editor. Audio is embedded in this file — it works offline and needs no other files. Click or drag on any waveform to position the playhead; the round buttons play a line (or the whole recording) from there.</p>
<script>
(function () {
  var b64 = ${JSON.stringify(audioB64)};
  var bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  var audio = new Audio(URL.createObjectURL(new Blob([u8], { type: ${JSON.stringify(audioMime)} })));
  var stopAt = 0, active = null;
  var peaks = null, mpb = 0, durMs = 0;
  var rows = [].slice.call(document.querySelectorAll('.seg[data-s]'));
  var ov = document.getElementById('ov'), ovcur = document.getElementById('ovcur');
  var mplay = document.getElementById('mplay'), mtime = document.getElementById('mtime');

  // Boundary stop must NOT depend on the rAF loop: browsers throttle rAF in background tabs
  // while audio keeps playing, and a line would blow through its boundary. timeupdate fires
  // regardless of tab visibility.
  audio.addEventListener('timeupdate', function () {
    if (stopAt && audio.currentTime * 1000 >= stopAt - 20) audio.pause();
  });

  function fmt(ms) {
    var t = Math.max(0, Math.round(ms)), m = Math.floor(t / 60000), s = Math.floor((t % 60000) / 1000);
    return m + ':' + String(s).padStart(2, '0') + '.' + String(Math.floor((t % 1000) / 100));
  }
  function totalMs() { return durMs || (isFinite(audio.duration) ? audio.duration * 1000 : 0); }

  // One decode at load, peaks kept, buffer discarded — same math as the editor's strips
  // (exact msPerBucket mapping; proportional-to-duration drifts toward the file end).
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      var actx = new AC();
      actx.decodeAudioData(u8.buffer.slice(0)).then(function (buf) {
        var ch = buf.getChannelData(0);
        var B = Math.min(2000000, Math.max(4000, Math.round(buf.duration * 2000)));
        var per = Math.max(1, Math.floor(ch.length / B));
        peaks = new Float32Array(B);
        for (var b = 0; b < B; b++) {
          var m = 0, off = b * per, end = Math.min(ch.length, off + per);
          for (var i = off; i < end; i += 4) { var v = Math.abs(ch[i]); if (v > m) m = v; }
          peaks[b] = m;
        }
        mpb = per / buf.sampleRate * 1000;
        durMs = Math.round(buf.duration * 1000);
        try { actx.close(); } catch (e) {}
        drawAll();
      }).catch(function () { /* undecodable → page still plays, no waves */ });
    }
  } catch (e) {}

  function draw(canvas, sMs, eMs) {
    var dpr = window.devicePixelRatio || 1;
    var W = Math.max(1, Math.round((canvas.clientWidth || 300) * dpr));
    var H = Math.max(1, Math.round((canvas.clientHeight || 26) * dpr));
    canvas.width = W; canvas.height = H;
    var g = canvas.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (!peaks || !mpb || eMs <= sMs) { g.fillStyle = 'rgba(120,130,150,.45)'; g.fillRect(0, H / 2 - 1, W, 2); return; }
    var B = peaks.length;
    var b0 = Math.min(B - 1, Math.max(0, Math.floor(sMs / mpb)));
    var b1 = Math.min(B, Math.max(b0 + 1, Math.ceil(eMs / mpb)));
    var n = b1 - b0;
    g.fillStyle = '#1f4f8f';
    for (var x = 0; x < W; x++) {
      var fpos = (x / W) * n + b0;
      var i0 = Math.floor(fpos);
      var i1 = Math.max(i0 + 1, b0 + Math.ceil(((x + 1) / W) * n));
      var m = 0;
      if (i1 - i0 <= 1) {
        var fr = fpos - i0;
        m = (peaks[i0] || 0) * (1 - fr) + (peaks[Math.min(i0 + 1, b0 + n - 1)] || 0) * fr;
      } else {
        for (var i = i0; i < i1; i++) { var v = peaks[i] || 0; if (v > m) m = v; }
      }
      var h = Math.max(2, Math.pow(m, 0.6) * (H - 4));
      g.fillRect(x, (H - h) / 2, 1, h);
    }
  }
  function drawAll() {
    draw(ov, 0, totalMs());
    rows.forEach(function (row) {
      var c = row.querySelector('.rw');
      if (c) draw(c, +row.dataset.s, +row.dataset.e);
    });
  }
  var rsz; window.addEventListener('resize', function () { clearTimeout(rsz); rsz = setTimeout(drawAll, 150); });

  // Scrub = position only (the editor's interaction language): click or drag parks the playhead;
  // the play buttons start sound. Overview scrubs the whole file; a row wave scrubs its span.
  function wireScrub(el, s, e) {
    var down = false;
    function seek(ev) {
      var start = (typeof s === 'function' ? s() : s);
      var span = (typeof e === 'function' ? e() : e) - start;
      var r = el.getBoundingClientRect();
      var f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      if (span > 0) audio.currentTime = (start + f * span) / 1000;
    }
    el.addEventListener('pointerdown', function (ev) { ev.preventDefault(); down = true; seek(ev); });
    el.addEventListener('pointermove', function (ev) { if (down) seek(ev); });
    window.addEventListener('pointerup', function () { down = false; });
  }
  wireScrub(ov, 0, totalMs);
  rows.forEach(function (row) {
    var c = row.querySelector('.rw');
    if (c) wireScrub(c, +row.dataset.s, +row.dataset.e);
  });

  mplay.addEventListener('click', function () {
    if (!audio.paused && !stopAt) { audio.pause(); return; }
    stopAt = 0; active = null;                     // full-file mode: play on through boundaries
    audio.play();
  });
  rows.forEach(function (row) {
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

  (function tick() {
    var t = audio.currentTime * 1000, T = totalMs();
    if (stopAt && t >= stopAt - 20) audio.pause();
    if (T > 0) { ovcur.style.left = (Math.min(1, t / T) * ov.clientWidth) + 'px'; }
    mtime.textContent = fmt(t) + ' / ' + fmt(T);
    mplay.innerHTML = (!audio.paused && !stopAt) ? '&#9208;' : '&#9654;';
    rows.forEach(function (row) {
      var s = +row.dataset.s, e = +row.dataset.e;
      var inSeg = t >= s && t < e;
      row.classList.toggle('on', inSeg);
      var cur = row.querySelector('.cur'), c = row.querySelector('.rw');
      if (cur && c) {
        if (inSeg) { cur.hidden = false; cur.style.left = (((t - s) / (e - s)) * c.clientWidth) + 'px'; }
        else cur.hidden = true;
      }
      var btn = row.querySelector('.play');
      if (btn) btn.innerHTML = (!audio.paused && inSeg && row === active) ? '&#9208;' : '&#9654;';
    });
    requestAnimationFrame(tick);
  })();
})();
</script>
</body></html>`;
  // (The base64 is interpolated directly above — an earlier .replace('__MARKER__') approach hit
  // the FIRST occurrence, so a title containing the literal marker text hijacked the audio slot.)
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
