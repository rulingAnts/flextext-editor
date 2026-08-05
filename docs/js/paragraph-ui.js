/* paragraph-ui.js — the Paragraph Analysis satellite's UI (window.__MODE === 'paragraph').
 *
 * Rendering + wiring ONLY: every tree mutation routes through paragraph-model.js (the invariants
 * live there, node-tested). Same doctrine as segment-strips.js. The bracket tree renders as
 * NESTED containers — each group is a div whose left border IS its bracket, so levels, spans and
 * collapse come from the DOM structure with no absolute-position bookkeeping.
 *
 * Audio: ONE <audio> element + ONE peaks array computed at load from the embedded base64 (the
 * preview-v2 machinery: exact msPerBucket mapping, range-max/interpolation regimes, m^0.6 curve).
 * Grouping never touches audio or text — a collapsed group merely PLAYS its aggregate span.
 */

import { t, applyI18n, ENGINE_VERSION } from './i18n.js';
import * as db from './db.js';
import { parseFlextext, segmentsFromOffsets, esc } from './flextext.js';
import { buildFxpa, peakPlan } from './seg-exports.js';
import { readEaf, describeTiers, detectMapping, detectStacks, looksMultiSpeaker, eafToLines } from './eaf-read.js';
import { parseSfm, markerInventory, detectMapping as detectSfmMapping, sfmToTexts } from './sfm.js';
import { buildParagraphPreviewHtml, buildSsaSvg, buildSsaDiagramHtml } from './paragraph-export.js';
import { parseDelimited, looksLikeHeader, columnsOf, detectMapping as detectCsvMapping, csvToLines, templateCsv } from './csv.js';
import {
  validateFxpa, serializeFxpa, groupUnits, ungroup, editGroup, toggleCollapse, setCollapsedAll,
  topUnits, levelOf, spanOf, leavesOf, summaryOf, isGroupId, nodeById,
  isBlankLine, visibleTopUnits, withBlanksBetween,
  addProp, setPropText, setPropImplicit, deleteProp,
  newAuthoredDoc, addLine, setLineText, deleteLine, setLineFree,
  setWordText, setWordGloss, deleteWord,
} from './paragraph-model.js';

const WORKING_KEY = 'fxpa:working';
const EAF_MAP_KEY = 'fxpa:eaf-mapping';   // the last tier mapping, so a repeated file shape is one click
const SFM_MAP_KEY = 'fxpa:sfm-mapping';

let state = null;                 // validated .fxpa data (the model object)
let pendingEaf = null;            // an .eaf awaiting its tier mapping (see renderEafMapping)
let pendingSfm = null;            // a Toolbox/SFM file awaiting its marker mapping
let pendingCsv = null;            // a CSV/TSV file awaiting its column mapping
let focusLineId = null;           // after a re-render, put the cursor back where the user was
let focusPropId = null;           // ...and into the proposition just added ('new' = the last one)
let selection = new Set();        // selected unit ids (lines or groups)
let root = null;                  // #pa-main
let audio = null, peaks = null, mpb = 0, durMs = 0, stopAt = 0, activeSpan = null, rafId = 0;

const $ = (sel) => root.querySelector(sel);

/* ---------------- boot ---------------- */

export function initParagraphApp() {
  root = document.getElementById('pa-main');
  if (!root) return;
  applyI18n();
  // A reload must not lose the session: restore the working copy if one exists.
  db.getMedia(WORKING_KEY).then((rec) => {
    if (rec && rec.text) {
      try {
        const v = validateFxpa(JSON.parse(rec.text));
        if (v.ok) { load(v.data, { persist: false }); return; }
      } catch { /* fall through to the open screen */ }
    }
    renderOpen();
  }).catch(() => renderOpen());
}

/* ---------------- open screen (opens OR generates) ---------------- */

function renderOpen(errors) {
  stopAudio();
  root.innerHTML = `
    <div class="pa-open">
      <h1>${esc(t('para.appName'))}</h1>
      <p class="tab-hint">${esc(t('para.openHint'))}</p>
      <div class="pa-drop" id="pa-drop">
        <p><b>${esc(t('para.dropHere'))}</b></p>
        <p class="tab-hint">${esc(t('para.dropKinds'))}</p>
        <button class="primary-btn" id="pa-pick">${esc(t('para.chooseFiles'))}</button>
        <!-- NO accept filter, deliberately (Seth, 2026-08-05: "it could be any number of file
             extensions. .db and .txt are among them"). Toolbox files come as .txt, .db, .sfm,
             .tbt and whatever a project chose, so a filter would HIDE the user's own data in the
             picker. The format is detected from the file's CONTENT instead. -->
        <input type="file" id="pa-file" multiple hidden>
      </div>
      ${errors && errors.length ? `<div class="banner warn-banner"><span>${esc(errors.join(' '))}</span></div>` : ''}
      <p class="note">${esc(t('para.textOnlyNote'))}</p>
      <div class="pa-scratch">
        <p class="tab-hint">${esc(t('para.scratchIntro'))}</p>
        <button class="secondary-btn" id="pa-new">${esc(t('para.scratchBtn'))}</button>
      </div>
    </div>`;
  const drop = $('#pa-drop');
  const input = $('#pa-file');
  $('#pa-pick').addEventListener('click', () => input.click());
  $('#pa-new').addEventListener('click', () => {
    const v = validateFxpa(newAuthoredDoc(t('para.scratchTitle')));
    if (v.ok) { focusLineId = v.data.lines[0].id; load(v.data); }
  });
  input.addEventListener('change', () => handleFiles([...input.files]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    handleFiles([...e.dataTransfer.files]);
  });
}

async function handleFiles(files) {
  try {
    const fxpaFile = files.find((f) => /\.fxpa$/i.test(f.name));
    if (fxpaFile) {
      const v = validateFxpa(JSON.parse(await fxpaFile.text()));
      if (!v.ok) return renderOpen(v.errors);
      return load(v.data);
    }
    const audioOf = (fs) => fs.find((f) => /^audio\//.test(f.type) || /\.(wav|mp3|m4a|aac|ogg|opus|webm|flac)$/i.test(f.name));
    // ELAN. ANY .eaf from ANY source (Seth, 2026-08-04) — ours, SayMore's, or a stranger's with
    // tier names we have never seen. detectMapping() only PROPOSES; the wizard lets the user say
    // what each tier really is, because no heuristic can be right about every field file.
    const eafFile = files.find((f) => /\.eaf$/i.test(f.name));
    if (eafFile) {
      const eaf = readEaf(await eafFile.text());
      if (!eaf.tiers.length) return renderOpen([t('para.errNoTiers')]);
      // A conversation (several speaker tiers) is COLLAPSED into one time-ordered line list with
      // speaker attributes — flextext's model, and the one this app works in (Seth, 2026-08-04).
      const multi = looksMultiSpeaker(eaf);
      pendingEaf = {
        eaf,
        tiers: describeTiers(eaf),
        mapping: rememberedMapping(detectMapping(eaf), eaf),
        stacks: multi ? detectStacks(eaf).map((st) => ({ ...st, use: true })) : null,
        audioFile: audioOf(files) || null,
        name: eafFile.name.replace(/\.eaf$/i, ''),
      };
      return renderEafMapping();
    }
    // CSV / TSV. Checked before the SFM sniff: an SFM file starts with a backslash marker and a
    // delimited file does not, so the two cannot be confused.
    const maybeCsv = files.find((f) => !/\.(fxpa|eaf|flextext)$/i.test(f.name) && !/^audio\//.test(f.type));
    if (maybeCsv) {
      const txt = await maybeCsv.text().catch(() => '');
      if (txt.trim() && !/^\\\S+/m.test(txt)) {
        const { rows, delimiter } = parseDelimited(txt);
        if (rows.length && Math.max(...rows.map((r) => r.length)) > 1) {
          const hasHeader = looksLikeHeader(rows);
          const cols = columnsOf(rows, hasHeader);
          pendingCsv = { rows, delimiter, hasHeader, cols, mapping: detectCsvMapping(cols),
                         timeUnits: 'auto', audioFile: audioOf(files) || null,
                         name: maybeCsv.name.replace(/\.[^.]+$/, '') };
          return renderCsvMapping();
        }
      }
    }
    // Toolbox / SFM. Detected by CONTENT (a backslash-marker line), not extension: these files
    // come as .txt, .sfm, .db, .tbt and anything else a project chose. Checked AFTER the XML/JSON
    // formats so it can never shadow them.
    const maybeSfm = files.find((f) => !/\.(fxpa|eaf|flextext)$/i.test(f.name) && !/^audio\//.test(f.type));
    if (maybeSfm) {
      const txt = await maybeSfm.text().catch(() => '');
      if (/^\\\S+/m.test(txt)) {
        const fields = parseSfm(txt);
        const mapping = rememberedSfmMapping(detectSfmMapping(fields), fields);
        const { texts } = sfmToTexts(fields, mapping);
        if (!texts.length) return renderOpen([t('para.errSfmNoTexts')]);
        pendingSfm = {
          fields, mapping, texts, textIndex: 0,
          inv: markerInventory(fields),
          audioFile: audioOf(files) || null,
          name: maybeSfm.name.replace(/\.[^.]+$/, ''),
        };
        return renderSfmMapping();
      }
    }
    const ft = files.find((f) => /\.flextext$/i.test(f.name));
    if (!ft) return renderOpen([t('para.errNoUsableFile')]);
    // GENERATE from flextext (± its audio file): the same conversion the editor's export does —
    // spans from the flextext's native offsets; no offsets or no audio → a text-only document.
    const parsed = parseFlextext(await ft.text(), {});
    if (parsed.error || !parsed.texts.length) return renderOpen([parsed.error || t('para.errNoUsableFile')]);
    const doc = parsed.texts[0];
    doc.segments = segmentsFromOffsets(doc) || [];
    const audioFile = files.find((f) => /^audio\//.test(f.type) || /\.(wav|mp3|m4a|aac|ogg|opus|webm|flac)$/i.test(f.name));
    const hasSpans = doc.segments.some((s) => typeof s.start === 'number');
    const audioOpt = (audioFile && hasSpans)
      ? { b64: await blobToB64(audioFile), mime: audioFile.type || 'audio/wav', name: audioFile.name }
      : null;
    const fx = buildFxpa(doc, {
      title: doc.title || ft.name.replace(/\.flextext$/i, ''),
      vernLang: doc.vernLang || 'und', analLang: doc.analLang || 'en',
      audio: audioOpt,
    });
    const v = validateFxpa(fx);
    if (!v.ok) return renderOpen(v.errors);
    load(v.data);
  } catch (e) {
    renderOpen([t('para.errOpenFailed', { msg: e.message })]);
  }
}

/* ---------------- ELAN import: the tier-mapping wizard ----------------
 * EVERY .eaf comes through here, including ones we wrote: detectMapping()'s proposal is
 * prefilled, so a recognised file is a single click, and a file from anywhere else is four
 * dropdowns instead of a dead end. No heuristic can be right about every field recording, so the
 * user always gets the last word — and sees the result BEFORE importing. */

const ROLES = ['baseline', 'words', 'glosses', 'free'];

const tierLabel = (d) =>
  `${d.id} — ${d.count}${d.timed ? ' ⏱' : ''}${d.sample ? ' · “' + d.sample + '”' : ''}`;

// Re-use the previous mapping when this file has the same tiers (field work repeats one shape).
function rememberedMapping(proposed, eaf) {
  try {
    const saved = JSON.parse(localStorage.getItem(EAF_MAP_KEY) || 'null');
    if (!saved) return proposed;
    const has = (id) => !id || eaf.tiers.some((t) => t.id === id);
    if (ROLES.every((r) => has(saved[r])) && saved.baseline && has(saved.baseline)) {
      return { ...proposed, ...saved };
    }
  } catch { /* a corrupt remembered mapping is not worth a failed import */ }
  return proposed;
}

function currentMapping() {
  const P = pendingEaf;
  const m = { title: P.mapping.title || '' };
  if (P.stacks) {
    // Multi-speaker: the stacks ARE the mapping. Each speaker keeps its own role tiers; the user
    // only chooses who to include.
    m.stacks = P.stacks.filter((st) => st.use);
    return m;
  }
  for (const r of ROLES) m[r] = ($('#pa-map-' + r) || {}).value || null;
  return m;
}

/* A STRUCTURAL diagnostic for a bug report — deliberately NO annotation text, no sample content,
 * no file path beyond the name. Language data is exactly what must not leak into a public issue
 * tracker (the suite's threat model includes hostile-government scrutiny, and consent covers this
 * material). Tier shapes and what we detected are what actually diagnose an import. */
function eafDiagnostic() {
  const P = pendingEaf;
  const L = [];
  L.push('App: Paragraph Analysis Tool ' + (ENGINE_VERSION || ''));
  L.push('Browser: ' + navigator.userAgent);
  L.push('File: ' + P.name + '.eaf');
  L.push('Media named in the EAF: ' + ((P.eaf.media[0] || {}).name || 'none')
         + ' | audio supplied: ' + (P.audioFile ? 'yes' : 'no'));
  L.push('Multi-speaker: ' + (P.stacks ? 'yes (' + P.stacks.map((st) => st.speaker).join(', ') + ')' : 'no'));
  const m = currentMapping();
  L.push('Chosen mapping: ' + (P.stacks
    ? P.stacks.filter((st) => st.use).map((st) => st.speaker + '→' + st.baseline).join(', ')
    : ROLES.map((r) => r + '=' + (m[r] || 'none')).join(', ')));
  L.push('');
  L.push('Tiers (id | linguistic type | parent | annotations | time-aligned):');
  for (const d of P.tiers.slice(0, 40)) {
    L.push('  ' + [d.id, d.typeRef || '-', d.parentRef || '-', d.count, d.timed].join(' | ')
           + (d.constraints ? '  [' + d.constraints + ']' : ''));
  }
  if (P.tiers.length > 40) L.push('  …and ' + (P.tiers.length - 40) + ' more tiers');
  L.push('');
  L.push('(No text from the file is included above — only its structure.)');
  return L.join('\n');
}

function reportEafProblem() {
  const body = t('para.reportBody') + '\n\n\n---\n```\n' + eafDiagnostic() + '\n```\n';
  const url = 'https://github.com/rulingAnts/flextext-editor/issues/new?title='
    + encodeURIComponent('ELAN import: ' + pendingEaf.name)
    + '&body=' + encodeURIComponent(body);
  window.open(url, '_blank', 'noopener');
}

async function copyEafDiagnostic() {
  const btn = $('#pa-map-copy');
  try {
    await navigator.clipboard.writeText(eafDiagnostic());
    if (btn) btn.textContent = t('para.reportCopied');
  } catch {
    // No clipboard permission (or an insecure context): show it so it can be copied by hand —
    // never leave the user with a button that silently did nothing.
    const box = $('#pa-map-diag');
    if (box) { box.hidden = false; box.textContent = eafDiagnostic(); box.select?.(); }
  }
}

function renderEafMapping(errors) {
  stopAudio();
  const P = pendingEaf;
  const sel = (role, allowNone) => {
    const cur = P.mapping[role] || '';
    const opts = P.tiers.map((d) =>
      `<option value="${esc(d.id)}"${d.id === cur ? ' selected' : ''}>${esc(tierLabel(d))}</option>`).join('');
    return `<select id="pa-map-${role}">${allowNone ? `<option value=""${cur ? '' : ' selected'}>${esc(t('para.mapNone'))}</option>` : ''}${opts}</select>`;
  };
  const mediaName = (P.eaf.media[0] || {}).name || '';
  const mismatch = mediaName && P.audioFile && P.audioFile.name !== mediaName;
  root.innerHTML = `
    <div class="pa-open pa-wizard">
      <h1>${esc(t('para.eafTitle'))}</h1>
      <p class="tab-hint">${esc(t('para.eafIntro', { file: P.name }))}</p>
      ${errors && errors.length ? `<div class="banner warn-banner"><span>${esc(errors.join(' '))}</span></div>` : ''}
      ${mediaName && !P.audioFile ? `<div class="banner"><span>${esc(t('para.eafWantsAudio', { name: mediaName }))}</span></div>` : ''}
      ${mismatch ? `<div class="banner warn-banner"><span>${esc(t('para.eafAudioMismatch', { eaf: mediaName, got: P.audioFile.name }))}</span></div>` : ''}
      ${P.stacks ? `
      <div class="banner"><span>${esc(t('para.eafMultiSpeaker', { n: P.stacks.length }))}</span></div>
      <div class="pa-maprows">
        ${P.stacks.map((st, i) => `<label class="check-label"><input type="checkbox" class="pa-spk" data-i="${i}"${st.use ? ' checked' : ''}>
          <b>${esc(st.speaker)}</b> — ${esc(st.baseline)}</label>`).join('')}
      </div>
      <p class="note">${esc(t('para.eafMultiHint'))}</p>` : `
      <div class="pa-maprows">
        <label class="pa-maprow"><span>${esc(t('para.mapBaseline'))}</span>${sel('baseline', false)}</label>
        <label class="pa-maprow"><span>${esc(t('para.mapWords'))}</span>${sel('words', true)}</label>
        <label class="pa-maprow"><span>${esc(t('para.mapGlosses'))}</span>${sel('glosses', true)}</label>
        <label class="pa-maprow"><span>${esc(t('para.mapFree'))}</span>${sel('free', true)}</label>
      </div>
      <p class="note">${esc(t('para.mapHint'))}</p>`}
      <h3 class="pa-mapph">${esc(t('para.mapPreview'))}</h3>
      <div class="pa-mappreview" id="pa-map-preview"></div>
      <p class="note pa-reportline">${esc(t('para.reportIntro'))}
        <button class="link-btn" id="pa-map-report">${esc(t('para.reportBtn'))}</button>
        <button class="link-btn" id="pa-map-copy">${esc(t('para.reportCopy'))}</button>
      </p>
      <p class="note pa-reportnote">${esc(t('para.reportNote'))}</p>
      <textarea id="pa-map-diag" class="pa-diag" readonly hidden></textarea>
      <div class="pa-modal-actions">
        <button class="secondary-btn" id="pa-map-cancel">${esc(t('para.cancel'))}</button>
        <button class="primary-btn" id="pa-map-go">${esc(t('para.mapOpen'))}</button>
      </div>
    </div>`;
  if (P.stacks) {
    root.querySelectorAll('.pa-spk').forEach((cb) => cb.addEventListener('change', () => {
      P.stacks[+cb.dataset.i].use = cb.checked;
      drawMapPreview();
    }));
  } else {
    for (const r of ROLES) $('#pa-map-' + r).addEventListener('change', () => { P.mapping = currentMapping(); drawMapPreview(); });
  }
  $('#pa-map-report').addEventListener('click', reportEafProblem);
  $('#pa-map-copy').addEventListener('click', copyEafDiagnostic);
  $('#pa-map-cancel').addEventListener('click', () => { pendingEaf = null; renderOpen(); });
  $('#pa-map-go').addEventListener('click', eafConfirm);
  drawMapPreview();
}

// The whole point of the preview: a wrong tier choice is obvious HERE, not after importing.
function drawMapPreview() {
  const box = $('#pa-map-preview');
  if (!box) return;
  const conv = eafToLines(pendingEaf.eaf, currentMapping());
  if (!conv.lines.length) { box.innerHTML = `<p class="note">${esc(t('para.mapEmpty'))}</p>`; return; }
  box.innerHTML = conv.lines.slice(0, 4).map((l) => `
    <div class="pa-mapline">
      ${l.speaker ? `<div class="pa-speaker">${esc(l.speaker)}</div>` : ''}
      <div class="pa-baseline">${esc(l.baseline || '—')}</div>
      ${(l.words || []).some((w) => w.gls) ? `<div class="pa-words">${(l.words || []).map((w) =>
        `<span class="w"><span class="wt">${esc(w.txt)}</span><span class="wg">${esc(w.gls || ' ')}</span></span>`).join('')}</div>` : ''}
      ${l.free ? `<div class="pa-free">${esc(l.free)}</div>` : ''}
      ${typeof l.start === 'number' ? `<div class="pa-maptime">${clock(l.start)} – ${clock(l.end)}</div>` : ''}
    </div>`).join('')
    + (conv.lines.length > 4 ? `<p class="note">${esc(t('para.mapMore', { n: conv.lines.length - 4 }))}</p>` : '');
}

async function eafConfirm() {
  const P = pendingEaf;
  const mapping = currentMapping();
  const conv = eafToLines(P.eaf, mapping);
  if (!conv.lines.length) return renderEafMapping([t('para.mapEmpty')]);
  const hasSpans = conv.lines.some((l) => typeof l.start === 'number');
  const audio = (P.audioFile && hasSpans)
    ? { b64: await blobToB64(P.audioFile), mime: P.audioFile.type || 'audio/wav', name: P.audioFile.name }
    : null;
  // Back into the shape buildFxpa() already knows — one paragraph per line, spans in parallel.
  const doc = {
    title: conv.title || P.name,
    paragraphs: conv.lines.map((l) => ({ segments: [{ baseline: l.baseline, free: l.free || '', words: l.words || [], speaker: l.speaker || '', attrs: {} }] })),
    segments: conv.lines.map((l) => (typeof l.start === 'number' ? { start: l.start, end: l.end } : { timePending: true })),
  };
  const fx = buildFxpa(doc, { title: doc.title, vernLang: 'und', analLang: 'en', audio, speakers: conv.speakers });
  const v = validateFxpa(fx);
  if (!v.ok) return renderEafMapping(v.errors);
  try { localStorage.setItem(EAF_MAP_KEY, JSON.stringify(mapping)); } catch { /* non-fatal */ }
  pendingEaf = null;
  load(v.data);
}


/* ---------------- Toolbox / SFM import: the marker-mapping wizard ----------------
 * Same contract as the ELAN wizard: the app PROPOSES (FLEx's conventional marker table plus
 * ELAN's \ELANBegin/\ELANEnd/\ELANParticipant), the user DECIDES, and a live preview shows the
 * result before anything is imported. Two things EAF never needs: these files can hold a whole
 * CORPUS, so there is a text picker; and the roles include times and speaker, because a Toolbox
 * file exported from ELAN really does carry them. */

const SFM_ROLES = ['baseline', 'gloss', 'free', 'speaker', 'start', 'end', 'title', 'ref'];

function rememberedSfmMapping(proposed, fields) {
  try {
    const saved = JSON.parse(localStorage.getItem(SFM_MAP_KEY) || 'null');
    if (!saved || !saved.baseline) return proposed;
    const present = new Set(fields.map((f) => f.marker));
    if (SFM_ROLES.every((r) => !saved[r] || present.has(saved[r])) && present.has(saved.baseline)) {
      return { ...proposed, ...saved };
    }
  } catch { /* a corrupt remembered mapping must not block an import */ }
  return proposed;
}

function currentSfmMapping() {
  const m = {};
  for (const r of SFM_ROLES) m[r] = ($('#pa-sfm-' + r) || {}).value || null;
  // The morpheme line is carried along implicitly (it only aligns glosses, it is never displayed).
  // But an EXPLICIT choice must always win: mapping \mb as the gloss and leaving \mb as the
  // morpheme line made the glosses silently disappear, because the implicit role claimed the
  // marker. Drop the implicit one whenever the user has assigned that marker a real role.
  const mor = pendingSfm.mapping.morphemes;
  if (mor && !SFM_ROLES.some((r) => m[r] === mor)) m.morphemes = mor;
  if (pendingSfm.mapping.newtext) m.newtext = pendingSfm.mapping.newtext;
  return m;
}

function renderSfmMapping(errors) {
  stopAudio();
  const P = pendingSfm;
  const label = (e) => `\\${e.marker} — ${e.count}${e.sample ? ' · “' + e.sample + '”' : ''}`;
  const sel = (role, allowNone) => {
    const cur = P.mapping[role] || '';
    const opts = P.inv.map((e) =>
      `<option value="${esc(e.marker)}"${e.marker === cur ? ' selected' : ''}>${esc(label(e))}</option>`).join('');
    return `<select id="pa-sfm-${role}">${allowNone ? `<option value=""${cur ? '' : ' selected'}>${esc(t('para.mapNone'))}</option>` : ''}${opts}</select>`;
  };
  const many = P.texts.length > 1;
  root.innerHTML = `
    <div class="pa-open pa-wizard">
      <h1>${esc(t('para.sfmTitle'))}</h1>
      <p class="tab-hint">${esc(t('para.sfmIntro', { file: P.name }))}</p>
      ${errors && errors.length ? `<div class="banner warn-banner"><span>${esc(errors.join(' '))}</span></div>` : ''}
      <div class="banner warn-banner"><span>${esc(t('para.sfmNew'))}
        <button class="link-btn" id="pa-sfm-report2">${esc(t('para.reportBtn'))}</button></span></div>
      ${many ? `<div class="banner"><span>${esc(t('para.sfmManyTexts', { n: P.texts.length }))}</span></div>
      <label class="pa-maprow"><span>${esc(t('para.sfmWhichText'))}</span>
        <select id="pa-sfm-text">${P.texts.map((tx, i) =>
          `<option value="${i}"${i === P.textIndex ? ' selected' : ''}>${esc((tx.title || t('para.sfmUntitled')) + ' — ' + t('para.sfmLineCount', { n: tx.lines.length }))}</option>`).join('')}</select></label>` : ''}
      <div class="pa-maprows">
        <label class="pa-maprow"><span>${esc(t('para.mapBaseline'))}</span>${sel('baseline', false)}</label>
        <label class="pa-maprow"><span>${esc(t('para.mapGlosses'))}</span>${sel('gloss', true)}</label>
        <label class="pa-maprow"><span>${esc(t('para.mapFree'))}</span>${sel('free', true)}</label>
        <label class="pa-maprow"><span>${esc(t('para.sfmSpeaker'))}</span>${sel('speaker', true)}</label>
        <label class="pa-maprow"><span>${esc(t('para.sfmStart'))}</span>${sel('start', true)}</label>
        <label class="pa-maprow"><span>${esc(t('para.sfmEnd'))}</span>${sel('end', true)}</label>
        <label class="pa-maprow"><span>${esc(t('para.sfmTitleField'))}</span>${sel('title', true)}</label>
        <label class="pa-maprow"><span>${esc(t('para.sfmRecord'))}</span>${sel('ref', true)}</label>
      </div>
      <p class="note">${esc(t('para.sfmHint'))}</p>
      <h3 class="pa-mapph">${esc(t('para.mapPreview'))}</h3>
      <div class="pa-mappreview" id="pa-map-preview"></div>
      <p class="note pa-reportline">${esc(t('para.reportIntro'))}
        <button class="link-btn" id="pa-sfm-report">${esc(t('para.reportBtn'))}</button>
      </p>
      <p class="note pa-reportnote">${esc(t('para.reportNote'))}</p>
      <div class="pa-modal-actions">
        <button class="secondary-btn" id="pa-sfm-cancel">${esc(t('para.cancel'))}</button>
        <button class="primary-btn" id="pa-sfm-go">${esc(t('para.mapOpen'))}</button>
      </div>
    </div>`;
  const reparse = () => {
    P.mapping = currentSfmMapping();
    P.texts = sfmToTexts(P.fields, P.mapping).texts;
    if (P.textIndex >= P.texts.length) P.textIndex = 0;
    drawSfmPreview();
  };
  for (const r of SFM_ROLES) $('#pa-sfm-' + r).addEventListener('change', reparse);
  if (many) $('#pa-sfm-text').addEventListener('change', (e) => { P.textIndex = +e.target.value; drawSfmPreview(); });
  $('#pa-sfm-cancel').addEventListener('click', () => { pendingSfm = null; renderOpen(); });
  $('#pa-sfm-go').addEventListener('click', sfmConfirm);
  $('#pa-sfm-report').addEventListener('click', reportSfmProblem);
  $('#pa-sfm-report2').addEventListener('click', reportSfmProblem);
  drawSfmPreview();
}

function drawSfmPreview() {
  const box = $('#pa-map-preview');
  if (!box) return;
  const tx = pendingSfm.texts[pendingSfm.textIndex];
  if (!tx || !tx.lines.length) { box.innerHTML = `<p class="note">${esc(t('para.mapEmpty'))}</p>`; return; }
  box.innerHTML = tx.lines.slice(0, 4).map((l) => `
    <div class="pa-mapline">
      ${l.speaker ? `<div class="pa-speaker">${esc(l.speaker)}</div>` : ''}
      <div class="pa-baseline">${esc(l.baseline || '—')}</div>
      ${(l.words || []).some((w) => w.gls) ? `<div class="pa-words">${(l.words || []).map((w) =>
        `<span class="w"><span class="wt">${esc(w.txt)}</span><span class="wg">${esc(w.gls || ' ')}</span></span>`).join('')}</div>` : ''}
      ${l.free ? `<div class="pa-free">${esc(l.free)}</div>` : ''}
      ${typeof l.start === 'number' ? `<div class="pa-maptime">${clock(l.start)} – ${clock(l.end)}</div>` : ''}
    </div>`).join('')
    + (tx.lines.length > 4 ? `<p class="note">${esc(t('para.mapMore', { n: tx.lines.length - 4 }))}</p>` : '');
}

function reportSfmProblem() {
  const P = pendingSfm;
  const L = [];
  L.push('App: Paragraph Analysis Tool ' + (ENGINE_VERSION || ''));
  L.push('Browser: ' + navigator.userAgent);
  L.push('File: ' + P.name + ' (Toolbox/SFM)');
  L.push('Texts found: ' + P.texts.length + ' | importing #' + (P.textIndex + 1));
  L.push('Chosen mapping: ' + SFM_ROLES.map((r) => r + '=' + (P.mapping[r] || 'none')).join(', '));
  L.push('');
  L.push('Markers present (marker | occurrences):');
  for (const e of P.inv.slice(0, 60)) L.push('  \\' + e.marker + ' | ' + e.count);
  L.push('');
  L.push('(No text from the file is included above — only its structure.)');
  const body = t('para.reportBody') + '\n\n\n---\n```\n' + L.join('\n') + '\n```\n';
  window.open('https://github.com/rulingAnts/flextext-editor/issues/new?title='
    + encodeURIComponent('Toolbox/SFM import: ' + P.name) + '&body=' + encodeURIComponent(body), '_blank', 'noopener');
}

async function sfmConfirm() {
  const P = pendingSfm;
  const tx = P.texts[P.textIndex];
  if (!tx || !tx.lines.length) return renderSfmMapping([t('para.mapEmpty')]);
  const hasSpans = tx.lines.some((l) => typeof l.start === 'number');
  const audio = (P.audioFile && hasSpans)
    ? { b64: await blobToB64(P.audioFile), mime: P.audioFile.type || 'audio/wav', name: P.audioFile.name }
    : null;
  const doc = {
    title: tx.title || P.name,
    paragraphs: tx.lines.map((l) => ({ segments: [{ baseline: l.baseline, free: l.free || '', words: l.words || [], speaker: l.speaker || '', attrs: {} }] })),
    segments: tx.lines.map((l) => (typeof l.start === 'number' ? { start: l.start, end: l.end } : { timePending: true })),
  };
  const speakers = [...new Set(tx.lines.map((l) => l.speaker).filter(Boolean))];
  const fx = buildFxpa(doc, { title: doc.title, vernLang: 'und', analLang: 'en', audio, speakers });
  const v = validateFxpa(fx);
  if (!v.ok) return renderSfmMapping(v.errors);
  try { localStorage.setItem(SFM_MAP_KEY, JSON.stringify(P.mapping)); } catch { /* non-fatal */ }
  pendingSfm = null;
  load(v.data);
}

function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/* ---------------- state / persistence ---------------- */

function load(data, { persist = true } = {}) {
  state = data;
  selection = new Set();
  if (persist) persistWorking();
  setupAudio();
  renderWork();
}

function commit(next) {
  state = next;
  persistWorking();
  renderWork();
}

function persistWorking() {
  db.putMedia(WORKING_KEY, { text: serializeFxpa(state) }).catch(() => {});
}

/* ---------------- audio (preview-v2 machinery, app-module form) ---------------- */

function stopAudio() {
  cancelAnimationFrame(rafId);
  if (audio) { try { audio.pause(); } catch { /* noop */ } }
  audio = null; peaks = null; mpb = 0; durMs = 0; stopAt = 0; activeSpan = null;
}

function setupAudio() {
  stopAudio();
  if (!state.audio) return;
  const bin = atob(state.audio.b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  audio = new Audio(URL.createObjectURL(new Blob([u8], { type: state.audio.mime || 'audio/wav' })));
  // Boundary stop must not depend on rAF (throttled in background tabs).
  audio.addEventListener('timeupdate', () => {
    if (stopAt && audio.currentTime * 1000 >= stopAt - 20) audio.pause();
  });
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const ctx = new AC();
  ctx.decodeAudioData(u8.buffer.slice(0)).then((buf) => {
    const ch = buf.getChannelData(0);
    // peakPlan, not an inline floor: flooring leaves the tail of the file with no buckets at all,
    // which is what made the overview and the last lines drift (see peakPlan's note).
    const { buckets: B, per, msPerBucket } = peakPlan(ch.length, buf.sampleRate, buf.duration);
    peaks = new Float32Array(B);
    for (let b = 0; b < B; b++) {
      let m = 0;
      const off = b * per, end = Math.min(ch.length, off + per);
      for (let i = off; i < end; i += 4) { const v = Math.abs(ch[i]); if (v > m) m = v; }
      peaks[b] = m;
    }
    mpb = msPerBucket;
    durMs = Math.round(buf.duration * 1000);
    try { ctx.close(); } catch { /* noop */ }
    drawAllWaves();
  }).catch((e) => { try { console.warn('[paragraph] peaks unavailable', e); } catch { /* noop */ } });
}

function drawWave(canvas, sMs, eMs) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round((canvas.clientWidth || 300) * dpr));
  const H = Math.max(1, Math.round((canvas.clientHeight || 20) * dpr));
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, W, H);
  if (!peaks || !mpb || !(eMs > sMs)) {
    g.fillStyle = 'rgba(120,130,150,.45)'; g.fillRect(0, H / 2 - 1, W, 2); return;
  }
  const B = peaks.length;
  const b0 = Math.min(B - 1, Math.max(0, Math.floor(sMs / mpb)));
  const b1 = Math.min(B, Math.max(b0 + 1, Math.ceil(eMs / mpb)));
  const n = b1 - b0;
  g.fillStyle = '#1f4f8f';
  for (let x = 0; x < W; x++) {
    const fpos = (x / W) * n + b0;
    const i0 = Math.floor(fpos);
    const i1 = Math.max(i0 + 1, b0 + Math.ceil(((x + 1) / W) * n));
    let m = 0;
    if (i1 - i0 <= 1) {
      const fr = fpos - i0;
      m = (peaks[i0] || 0) * (1 - fr) + (peaks[Math.min(i0 + 1, b0 + n - 1)] || 0) * fr;
    } else {
      for (let i = i0; i < i1; i++) { const v = peaks[i] || 0; if (v > m) m = v; }
    }
    const h = Math.max(2, Math.pow(m, 0.6) * (H - 4));
    g.fillRect(x, (H - h) / 2, 1, h);
  }
}

function drawAllWaves() {
  if (!root) return;
  root.querySelectorAll('canvas[data-s]').forEach((c) => drawWave(c, +c.dataset.s, +c.dataset.e));
  const ov = $('#pa-ov');
  if (ov) drawWave(ov, 0, durMs || 1);
}

function wireScrub(el, s, e) {
  let down = false;
  const seek = (ev) => {
    if (!audio) return;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    audio.currentTime = (s + f * (e - s)) / 1000;
  };
  el.addEventListener('pointerdown', (ev) => { ev.preventDefault(); down = true; seek(ev); });
  el.addEventListener('pointermove', (ev) => { if (down) seek(ev); });
  window.addEventListener('pointerup', () => { down = false; });
}

function playSpan(s, e) {
  if (!audio) return;
  const tNow = audio.currentTime * 1000;
  if (!audio.paused && activeSpan && s === activeSpan.s && e === activeSpan.e) { audio.pause(); return; }
  activeSpan = { s, e };
  audio.currentTime = ((tNow > s && tNow < e - 150) ? tNow : s) / 1000;   // resume-in-span
  stopAt = e;
  audio.play().catch(() => {});
}

function startTicker() {
  cancelAnimationFrame(rafId);
  const tick = () => {
    if (audio) {
      const tNow = audio.currentTime * 1000;
      const T = durMs || (isFinite(audio.duration) ? audio.duration * 1000 : 0);
      const cur = $('#pa-ovcur'), ov = $('#pa-ov');
      if (cur && ov && T > 0) cur.style.left = (Math.min(1, tNow / T) * ov.clientWidth) + 'px';
      const time = $('#pa-time');
      if (time) time.textContent = clock(tNow) + ' / ' + clock(T);
      const mp = $('#pa-play');
      if (mp) mp.textContent = (!audio.paused && !stopAt) ? '⏸' : '▶';
      root.querySelectorAll('.pa-row[data-s]').forEach((row) => {
        const s = +row.dataset.s, e = +row.dataset.e;
        row.classList.toggle('on', tNow >= s && tNow < e);
      });
      root.querySelectorAll('button.pa-rowplay').forEach((b) => {
        const s = +b.dataset.s, e = +b.dataset.e;
        b.textContent = (!audio.paused && activeSpan && activeSpan.s === s && activeSpan.e === e && tNow >= s && tNow < e) ? '⏸' : '▶';
      });
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

const clock = (ms) => {
  const x = Math.max(0, Math.round(ms));
  return Math.floor(x / 60000) + ':' + String(Math.floor((x % 60000) / 1000)).padStart(2, '0') + '.' + Math.floor((x % 1000) / 100);
};

/* ---------------- workspace rendering ---------------- */

function renderWork() {
  const v = state.view;
  const showAudio = !!(state.audio && v.audio);
  root.innerHTML = `
    <div class="pa-bar">
      <span class="pa-title" title="${esc(state.title)}">${esc(state.title)}</span>
      <span class="pa-tools">
        <select id="pa-layer" title="${esc(t('para.layerTip'))}">
          <option value="interlinear">${esc(t('para.layerInterlinear'))}</option>
          <option value="baseline">${esc(t('para.layerBaseline'))}</option>
          <option value="free-only">${esc(t('para.layerFreeOnly'))}</option>
        </select>
        <label class="check-label pa-inline"><input type="checkbox" id="pa-free"> ${esc(t('para.showFree'))}</label>
        <label class="check-label pa-inline" title="${esc(t('para.hideBlankTip'))}"><input type="checkbox" id="pa-blank"> ${esc(t('para.hideBlank'))}</label>
        <label class="check-label pa-inline" id="pa-brk-wrap" hidden><input type="checkbox" id="pa-brk"> ${esc(t('para.brackets'))}</label>
        ${state.audio ? `<label class="check-label pa-inline"><input type="checkbox" id="pa-audio"> ${esc(t('para.showAudio'))}</label>
        <select id="pa-waves" title="${esc(t('para.wavesTip'))}">
          <option value="compact">${esc(t('para.wavesCompact'))}</option>
          <option value="normal">${esc(t('para.wavesNormal'))}</option>
          <option value="off">${esc(t('para.wavesOff'))}</option>
        </select>` : ''}
      </span>
      <span class="pa-actions">
        <span class="pa-selinfo" id="pa-selinfo"></span>
        <button class="secondary-btn pa-multi" id="pa-multi" aria-pressed="${multiMode}"
                title="${esc(t('para.multiTip'))}">${esc(t('para.multi'))}</button>
        <button class="secondary-btn" id="pa-group">${esc(t('para.group'))}</button>
        <button class="secondary-btn" id="pa-edit">${esc(t('para.editGroup'))}</button>
        <button class="secondary-btn" id="pa-ungroup">${esc(t('para.ungroup'))}</button>
        <button class="secondary-btn" id="pa-collapse-all">${esc(t('para.collapseAll'))}</button>
        <button class="secondary-btn" id="pa-expand-all">${esc(t('para.expandAll'))}</button>
        <button class="secondary-btn" id="pa-clear" disabled title="${esc(t('para.clearSelTip'))}">${esc(t('para.clearSel'))}</button>
        ${state.authored ? `<button class="secondary-btn" id="pa-addline">${esc(t('para.scratchAddLine'))}</button>` : ''}
        <button class="secondary-btn" id="pa-export">${esc(t('para.exportBtn'))}</button>
        <button class="primary-btn" id="pa-save">${esc(t('para.save'))}</button>
        <!-- Far right, and LABELLED: a bare ✕ read as "close the toolbar/banner", not "put this
             document away" — and it is the one control that discards the working copy. -->
        <button class="secondary-btn pa-closebtn" id="pa-close" title="${esc(t('para.closeTip'))}">
          ${esc(t('para.close'))} <span aria-hidden="true">✕</span></button>
      </span>
    </div>
    ${showAudio ? `
    <div class="pa-player">
      <div class="pa-ovwrap"><canvas id="pa-ov"></canvas><div class="pa-cur" id="pa-ovcur"></div></div>
      <div class="pa-transport"><button class="icon-btn2" id="pa-play">▶</button><span id="pa-time" class="player-time"></span></div>
    </div>` : ''}
    <p class="pa-tip">${esc(state.authored ? t('para.scratchHint') : t('para.selectTip'))}
      ${state.authored ? '' : `<span class="pa-tip-note">${esc(t('para.splitNote'))}</span>`}</p>
    <div class="pa-tree" id="pa-tree"></div>
    <div id="pa-dialog" hidden></div>`;

  $('#pa-layer').value = v.layer;
  $('#pa-free').checked = v.free !== false;
  $('#pa-blank').checked = v.hideBlank !== false;      // ON by default: blank lines are not analysis
  // Brackets only mean something once a document HAS implied propositions — Seth: default on.
  $('#pa-brk').checked = v.brackets !== false;
  $('#pa-brk-wrap').hidden = !state.lines.some((l) => (l.props || []).some((p) => p.implicit));
  // free-only requires free on; disable the free checkbox there (it is the whole display).
  $('#pa-free').disabled = v.layer === 'free-only';
  if (state.audio) {
    $('#pa-audio').checked = v.audio !== false;
    if ($('#pa-waves')) $('#pa-waves').value = v.waves || 'compact';
  }
  $('#pa-layer').addEventListener('change', (e) => setView({ layer: e.target.value, ...(e.target.value === 'free-only' ? { free: true } : {}) }));
  $('#pa-free').addEventListener('change', (e) => setView({ free: e.target.checked }));
  $('#pa-brk').addEventListener('change', (e) => {
    commit({ ...state, view: { ...state.view, brackets: e.target.checked } });
  });
  $('#pa-blank').addEventListener('change', (e) => {
    // Hiding a line must never hide a SELECTION the user cannot then clear.
    if (e.target.checked) { selection = new Set([...selection].filter((id) => isGroupId(id) || !isBlankLine(nodeById(state, id)))); anchor = null; }
    setView({ hideBlank: e.target.checked });
  });
  if (state.audio) {
    $('#pa-audio').addEventListener('change', (e) => setView({ audio: e.target.checked }));
    $('#pa-waves')?.addEventListener('change', (e) => setView({ waves: e.target.value }));
  }
  $('#pa-save').addEventListener('click', saveFxpa);
  $('#pa-export').addEventListener('click', openExportDialog);
  if (state.authored) {
    $('#pa-addline').addEventListener('click', () => {
      const last = state.lines[state.lines.length - 1];
      const next = addLine(state, last ? last.id : null);
      focusLineId = next._added;
      commit(next);
    });
  }
  $('#pa-close').addEventListener('click', () => {
    if (!confirm(t('para.closeConfirm'))) return;
    db.deleteMedia(WORKING_KEY).catch(() => {});
    state = null; stopAudio(); renderOpen();
  });
  $('#pa-group').addEventListener('click', openGroupDialog);
  $('#pa-ungroup').addEventListener('click', doUngroup);
  $('#pa-edit').addEventListener('click', openEditDialog);
  $('#pa-clear').addEventListener('click', clearSelection);
  $('#pa-collapse-all').addEventListener('click', () => collapseAllAction(true));
  $('#pa-expand-all').addEventListener('click', () => collapseAllAction(false));
  // The touch-friendly stand-in for holding Shift/Ctrl/Cmd (see toggleSelect).
  $('#pa-multi').addEventListener('click', () => {
    multiMode = !multiMode;
    const b = $('#pa-multi');
    b.classList.toggle('on', multiMode);
    b.setAttribute('aria-pressed', String(multiMode));
  });
  $('#pa-multi').classList.toggle('on', multiMode);
  wireKeys();
  if (showAudio) {
    $('#pa-play').addEventListener('click', () => {
      if (!audio) return;
      if (!audio.paused && !stopAt) { audio.pause(); return; }
      stopAt = 0; activeSpan = null;
      audio.play().catch(() => {});
    });
    // Overview scrub resolves its span at seek time (durMs only exists after decode),
    // so it gets its own wiring instead of wireScrub's fixed numbers.
    wireOverviewScrub($('#pa-ov'));
  }
  const tree = $('#pa-tree');
  for (const id of visibleTopUnits(state, v.hideBlank !== false)) tree.appendChild(renderUnit(id));
  refreshActionButtons();
  drawAllWaves();
  startTicker();
  if (focusLineId) {
    // A structural change re-renders, which is exactly when the cursor has to be put back
    // deliberately — into the new proposition when one was just added, else the line editor.
    if (focusPropId) {
      const el = root.querySelector(`.pa-props .pa-prop:last-child .pa-propedit[data-line="${focusLineId}"]`);
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    } else {
      // Authored lines are text until asked; a line the user just CREATED opens straight into its
      // editor, so building a chart from scratch stays type-Enter-type-Enter.
      const row = root.querySelector(`.pa-row[data-unit="${focusLineId}"]`);
      if (row) openLineEditor(row, focusLineId);
    }
    focusLineId = null; focusPropId = null;
  }
}

function wireOverviewScrub(el) {
  let down = false;
  const seek = (ev) => {
    if (!audio) return;
    const T = durMs || (isFinite(audio.duration) ? audio.duration * 1000 : 0);
    if (!T) return;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    audio.currentTime = (f * T) / 1000;
  };
  el.addEventListener('pointerdown', (ev) => { ev.preventDefault(); down = true; seek(ev); });
  el.addEventListener('pointermove', (ev) => { if (down) seek(ev); });
  window.addEventListener('pointerup', () => { down = false; });
}

function setView(patch) {
  commit({ ...state, view: { ...state.view, ...patch } });
}

// One unit → DOM. Groups NEST: the container's left border is the bracket; collapse swaps the
// children for free-translation summary rows (the model computes them).
// `nodeLabel` is this unit's ROLE in its parent group's relation (from the PARENT's labels map —
// a role is held relative to one relation, so the parent owns it). Optional everywhere.
function renderUnit(id, nodeLabel = '', depth = 0) {
  if (!isGroupId(id)) return renderLineRow(id, nodeLabel);
  const g = nodeById(state, id);
  const el = document.createElement('div');
  el.className = 'pa-group' + (selection.has(id) ? ' sel' : '');
  // Depth drives the bracket's COLOUR and weight — see the CSS note. Cycling at 6 is far more
  // than any real analysis nests, so in practice each level on screen is a distinct colour.
  el.dataset.depth = depth % 6;
  el.dataset.unit = id;
  const collapsed = (state.view.collapsed || []).includes(id);
  const badge = document.createElement('div');
  badge.className = 'pa-badge';
  badge.title = t('para.headingTip');   // this bar IS the group's handle — Edit/Ungroup act on it
  const span = spanOf(state, id);
  badge.innerHTML = `
    ${nodeLabel ? `<span class="pa-nodelabel" title="${esc(nodeLabel)}">${esc(nodeLabel)}</span>` : ''}
    <button class="pa-caret" title="${esc(t(collapsed ? 'para.expand' : 'para.collapse'))}">${collapsed ? '▸' : '▾'}</button>
    <span class="pa-jt" title="${esc(t(g.joinType === 'asym' ? 'para.asym' : 'para.sym'))}">${g.joinType === 'asym' ? '⊳' : '⊕'}</span>
    ${g.relation ? `<span class="pa-rel">${esc(g.relation)}</span>` : `<span class="pa-rel pa-rel-empty">${esc(t('para.noRelation'))}</span>`}
    ${span && state.audio && state.view.audio ? `<button class="pa-rowplay" data-s="${span.start}" data-e="${span.end}">▶</button>` : ''}`;
  badge.querySelector('.pa-caret').addEventListener('click', (e) => { e.stopPropagation(); commit(toggleCollapse(state, id)); });
  const gplay = badge.querySelector('.pa-rowplay');
  if (gplay) gplay.addEventListener('click', (e) => { e.stopPropagation(); playSpan(+gplay.dataset.s, +gplay.dataset.e); });
  badge.addEventListener('click', (e) => toggleSelect(id, e));
  // Pointing at a heading traces THAT bracket down its whole length. With several levels stacked
  // in the margin, working out which bar belongs to which heading is the hard part.
  badge.addEventListener('mouseenter', () => el.classList.add('trace'));
  badge.addEventListener('mouseleave', () => el.classList.remove('trace'));
  el.appendChild(badge);
  if (collapsed) {
    for (const line of summaryOf(state, id)) {
      const s = document.createElement('div');
      s.className = 'pa-summary';
      s.textContent = line || '—';
      el.appendChild(s);
    }
  } else {
    const hideBlank = state.view.hideBlank !== false;
    for (const c of g.children) {
      if (hideBlank && !isGroupId(c) && isBlankLine(nodeById(state, c))) continue;   // silence inside a group
      el.appendChild(renderUnit(c, (g.labels || {})[c] || '', depth + 1));
    }
    // HEAD marker on the head child's container/row.
    if (g.joinType === 'asym') {
      const headEl = [...el.children].find((ch) => ch.dataset && ch.dataset.unit === g.head);
      if (headEl) headEl.classList.add('pa-head');
    }
  }
  return el;
}

/* ONE in-place editor, used by the free translation, the authored lines and the words (Seth,
 * 2026-08-05). Fields: one or two boxes, a green tick to commit, ✕ or Escape to abandon, and an
 * optional bin. It replaces the holder's contents rather than re-rendering, so the row keeps its
 * selection, waveform and scroll position while it is open, and nothing reaches the document until
 * the tick. `onEnter` lets a caller keep a fast typing flow (save, then open the next box).
 * Returns the first input so the caller can focus it. */
function inlineEdit(holder, { fields, onSave, onDelete, onEnter, deleteTitle } = {}) {
  const boxes = fields.map((f, i) => `<input class="pa-inline-in${i ? ' pa-inline-2nd' : ''}" data-k="${esc(f.key)}"
      value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}"${f.size ? ` size="${f.size}"` : ''}>`).join('');
  holder.innerHTML = `<span class="pa-inline">${boxes}
    <button class="pa-inline-ok" title="${esc(t('para.freeSave'))}">✓</button>
    <button class="pa-inline-cancel" title="${esc(t('para.freeCancel'))}">✕</button>
    ${onDelete ? `<button class="pa-inline-del" title="${esc(deleteTitle || t('para.wordDelete'))}">🗑</button>` : ''}
  </span>`;
  const inputs = [...holder.querySelectorAll('.pa-inline-in')];
  const values = () => Object.fromEntries(inputs.map((i) => [i.dataset.k, i.value]));
  const cancel = () => renderWork();
  const save = () => onSave(values());
  holder.querySelector('.pa-inline-ok').addEventListener('click', (e) => { e.stopPropagation(); save(); });
  holder.querySelector('.pa-inline-cancel').addEventListener('click', (e) => { e.stopPropagation(); cancel(); });
  const del = holder.querySelector('.pa-inline-del');
  if (del) del.addEventListener('click', (e) => { e.stopPropagation(); onDelete(); });
  for (const inp of inputs) {
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); (onEnter || save)(values()); }
      // Esc is the app-wide "clear selection" key — swallow it so it cancels the edit instead.
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      if (e.key === 'Tab' && !e.shiftKey && inp === inputs[inputs.length - 1]) { /* let it leave */ }
    });
  }
  inputs[0].focus();
  inputs[0].setSelectionRange(inputs[0].value.length, inputs[0].value.length);
  return inputs[0];
}

/* A word and its gloss are edited TOGETHER — they are one unit, and correcting a word while its
 * gloss still says the old thing is how an interlinear text quietly goes wrong. The bin removes
 * the word entirely; the line survives even if it loses every word (it still owns a time span). */
function openWordEditor(el, lineId, index) {
  const w = (nodeById(state, lineId).words || [])[index];
  if (!w) return;
  inlineEdit(el, {
    fields: [
      { key: 'txt', value: w.txt || '', placeholder: t('para.wordPh'), size: Math.max(6, (w.txt || '').length + 1) },
      { key: 'gls', value: w.gls || '', placeholder: t('para.glossPh'), size: Math.max(6, (w.gls || '').length + 1) },
    ],
    deleteTitle: t('para.wordDelete'),
    onSave: ({ txt, gls }) => {
      try {
        let next = String(txt).trim() === String(w.txt || '').trim() ? state : setWordText(state, lineId, index, txt);
        next = setWordGloss(next, lineId, index, gls);
        commit(next);
      } catch (e) { alert(e.message); }
    },
    onDelete: () => commit(deleteWord(state, lineId, index)),
  });
}

/* The authored line editor. Enter commits and opens the NEXT line, so building a chart from
 * scratch is still type-Enter-type-Enter; Backspace on an empty line removes it. */
function openLineEditor(row, lineId) {
  const holder = row.querySelector('.pa-authored');
  if (!holder || holder.querySelector('.pa-inline-in')) return;
  const original = nodeById(state, lineId).baseline || '';
  const commitText = (v) => (v === original ? state : setLineText(state, lineId, v));
  const input = inlineEdit(holder, {
    fields: [{ key: 'txt', value: original, placeholder: t('para.scratchPlaceholder') }],
    onSave: ({ txt }) => commit(commitText(txt)),
    onEnter: ({ txt }) => {
      const withText = commitText(txt);
      const next = addLine(withText, lineId);
      focusLineId = next._added;
      commit(next);
    },
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value && state.lines.length > 1) {
      e.preventDefault();
      commit(deleteLine(state, lineId));
    }
  });
}

/* Swap the free-translation line for an editor, in place. Deliberately NOT a re-render: the row
 * keeps its selection, its waveform and its scroll position while the box is open, and only the
 * tick writes anything to the document. Escape or ✕ abandons the edit; Enter is the tick. */
function openFreeEditor(row, lineId) {
  const holder = row.querySelector('.pa-free');
  if (!holder || holder.querySelector('.pa-freeinput')) return;
  const l = nodeById(state, lineId);
  const original = l.free || '';
  holder.innerHTML = `<input class="pa-freeinput" value="${esc(original)}" placeholder="${esc(t('para.freePlaceholder'))}">
    <button class="pa-freeok" title="${esc(t('para.freeSave'))}">✓</button>
    <button class="pa-freecancel" title="${esc(t('para.freeCancel'))}">✕</button>`;
  const input = holder.querySelector('.pa-freeinput');
  const close = () => { renderWork(); };
  const save = () => {
    if (input.value === original) return close();     // nothing changed — do not dirty the doc
    commit(setLineFree(state, lineId, input.value));
  };
  holder.querySelector('.pa-freeok').addEventListener('click', (e) => { e.stopPropagation(); save(); });
  holder.querySelector('.pa-freecancel').addEventListener('click', (e) => { e.stopPropagation(); close(); });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    // Esc is the app-wide "clear selection" key — swallow it here so it cancels the edit instead.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// An <input>'s `size` is in characters — the cheapest content-sized text box there is.
const propSize = (text) => Math.max(24, Math.min(90, String(text || '').length + 2));

function renderLineRow(id, nodeLabel = '') {
  const l = nodeById(state, id);
  const v = state.view;
  const row = document.createElement('div');
  row.className = 'pa-row' + (selection.has(id) ? ' sel' : '');
  row.dataset.unit = id;
  const timed = typeof l.start === 'number' && typeof l.end === 'number';
  if (timed) { row.dataset.s = l.start; row.dataset.e = l.end; }
  const showAudio = !!(state.audio && v.audio);
  const wavesMode = showAudio ? (v.waves || 'compact') : 'off';
  const parts = [];
  if (nodeLabel) parts.push(`<span class="pa-nodelabel" title="${esc(nodeLabel)}">${esc(nodeLabel)}</span>`);
  // Who said this line (conversations only — absent in a single-speaker text).
  if (l.speaker) parts.push(`<span class="pa-speaker" title="${esc(l.speaker)}">${esc(l.speaker)}</span>`);
  if (showAudio && timed) {
    parts.push(`<button class="pa-rowplay" data-s="${l.start}" data-e="${l.end}">▶</button>`);
  }
  const body = [`<div class="pa-cell">`];
  if (wavesMode !== 'off' && timed) {
    body.push(`<canvas class="pa-wave ${wavesMode === 'compact' ? 'pa-wave-sm' : ''}" data-s="${l.start}" data-e="${l.end}"></canvas>`);
  }
  if (state.authored) {
    /* ⚠ TEXT FIRST, EDITOR ON REQUEST (Seth, 2026-08-05: "with the blank/new chart editor, it's not
     * easy to select lines instead of editing them"). A permanently-open text box swallows every
     * click, so the row could never be SELECTED — and selecting is how you group, which is the
     * whole point of the tool. Now the line shows as text and a pencil opens the box, exactly like
     * the free translation. The fast typing flow is kept by opening the editor automatically on a
     * line the user just created, and by Enter committing and opening the next one. */
    body.push(`<div class="pa-authored" data-line="${esc(id)}">
      <span class="pa-linetext${l.baseline ? '' : ' pa-empty'}">${esc(l.baseline || t('para.scratchPlaceholder'))}</span>
      <button class="pa-lineedit" data-line="${esc(id)}" title="${esc(t('para.lineEdit'))}">✎</button>
    </div>`);
  } else if (v.layer === 'baseline' || !(l.words || []).length) {
    // Fall back to the baseline when a line has no words, or an interlinear view shows nothing.
    body.push(`<div class="pa-baseline">${esc(l.baseline || '')}</div>`);
  } else if (v.layer === 'interlinear') {
    // Each word is individually editable (Seth, 2026-08-05) — click opens a box for the word AND
    // its gloss together, because the two are one unit; the bin removes the word entirely.
    const words = (l.words || []).map((w, i) => w.punct
      ? `<span class="w punct" data-i="${i}"><span class="wt">${esc(w.txt)}</span></span>`
      : `<span class="w w-edit" data-i="${i}" title="${esc(t('para.wordEditTip'))}"><span class="wt">${esc(w.txt)}</span><span class="wg">${esc(w.gls || ' ')}</span></span>`).join('');
    body.push(`<div class="pa-words" data-line="${esc(id)}">${words}</div>`);
  }
  /* The free translation is EDITABLE — the one imported field that is (Seth, 2026-08-05). A pencil
   * opens a box, a green tick commits it. It is an explicit two-step rather than a live-typing
   * field like the authored lines, because this text came from somewhere: changing it should be a
   * decision, not something that happens while the cursor is passing through.
   * The row is offered even when there is NO free translation yet, since SSA states its
   * propositions in the analysis language and an imported line may simply lack one. */
  const showFree = v.free !== false || v.layer === 'free-only';
  if (showFree && !state.authored) {
    body.push(`<div class="pa-free${l.free ? '' : ' pa-free-empty'}" data-line="${esc(id)}">
      <span class="pa-freetext">${esc(l.free || t('para.freeNone'))}</span>
      <button class="pa-freeedit" data-line="${esc(id)}" title="${esc(t('para.freeEdit'))}">✎</button>
    </div>`);
  } else if (showFree && l.free) {
    body.push(`<div class="pa-free">${esc(l.free)}</div>`);
  }
  /* AUTHORED PROPOSITIONS — the semantic daughters of this line (Seth, 2026-08-05). Text boxes,
   * because they are written by the analyst, not read off the recording. They are additions beside
   * the line, never edits to it: the baseline, words, glosses and free translation above are
   * untouched, which is why these are offered on IMPORTED texts too.
   * Bracketed when implicit — the SSA convention — and the brackets are a setting. */
  const props = Array.isArray(l.props) ? l.props : [];
  if (props.length) {
    body.push('<div class="pa-props">');
    for (const p of props) {
      const br = v.brackets !== false && p.implicit;
      body.push(`<div class="pa-prop${p.implicit ? ' implicit' : ''}">
        ${br ? '<span class="pa-brk">(</span>' : ''}
        <input class="pa-propedit" data-line="${esc(id)}" data-prop="${esc(p.id)}"
               size="${propSize(p.text)}" value="${esc(p.text || '')}" placeholder="${esc(t('para.propPlaceholder'))}">
        ${br ? '<span class="pa-brk">)</span>' : ''}
        <button class="pa-propimp" data-line="${esc(id)}" data-prop="${esc(p.id)}"
                title="${esc(t(p.implicit ? 'para.propStated' : 'para.propImplied'))}">${p.implicit ? '( )' : '“ ”'}</button>
        <button class="pa-propdel" data-line="${esc(id)}" data-prop="${esc(p.id)}"
                title="${esc(t('para.propDelete'))}">✕</button>
      </div>`);
    }
    body.push('</div>');
  }
  /* NOT on a from-scratch chart (Seth, 2026-08-05): "our new blank chart is ONLY propositions", so
   * every line there already IS one and a control to add a proposition beneath it is nonsense.
   * Propositions exist to break IMPORTED language data into what it semantically expresses. */
  if (!state.authored) {
    body.push(`<button class="pa-propadd" data-line="${esc(id)}" title="${esc(t('para.propAddTip'))}">${esc(t('para.propAdd'))}</button>`);
  }
  body.push('</div>');
  row.innerHTML = parts.join('') + body.join('');
  const play = row.querySelector('.pa-rowplay');
  if (play) play.addEventListener('click', (e) => { e.stopPropagation(); playSpan(l.start, l.end); });
  const wave = row.querySelector('canvas');
  if (wave) wireScrub(wave, l.start, l.end);
  const freeBtn = row.querySelector('.pa-freeedit');
  if (freeBtn) freeBtn.addEventListener('click', (e) => { e.stopPropagation(); openFreeEditor(row, id); });
  const lineBtn = row.querySelector('.pa-lineedit');
  if (lineBtn) lineBtn.addEventListener('click', (e) => { e.stopPropagation(); openLineEditor(row, id); });
  row.querySelectorAll('.w-edit').forEach((w) => {
    w.addEventListener('click', (e) => { e.stopPropagation(); openWordEditor(w, id, +w.dataset.i); });
  });
  // Proposition controls must not select/deselect the row underneath them.
  row.querySelectorAll('.pa-propadd, .pa-propdel, .pa-propimp').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const { line, prop } = b.dataset;
      if (b.classList.contains('pa-propadd')) { focusPropId = 'new'; focusLineId = line; commit(addProp(state, line)); }
      else if (b.classList.contains('pa-propdel')) commit(deleteProp(state, line, prop));
      else {
        const cur = (nodeById(state, line).props || []).find((p) => p.id === prop);
        commit(setPropImplicit(state, line, prop, !(cur && cur.implicit)));
      }
    });
  });
  row.querySelectorAll('.pa-propedit').forEach((inp) => {
    inp.addEventListener('click', (e) => e.stopPropagation());
    // Typing updates state IN PLACE and never re-renders — the same rule as the authored line
    // editor, or the cursor jumps out of the word being typed.
    inp.addEventListener('input', () => {
      // Grow with the text, so a closing bracket hugs the words instead of stranding itself at
      // the right-hand edge of the row.
      inp.size = propSize(inp.value);
      state = setPropText(state, inp.dataset.line, inp.dataset.prop, inp.value);
      persistWorking();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); focusPropId = 'new'; focusLineId = inp.dataset.line; commit(addProp(state, inp.dataset.line)); }
      if (e.key === 'Backspace' && !inp.value) { e.preventDefault(); commit(deleteProp(state, inp.dataset.line, inp.dataset.prop)); }
    });
  });
  row.addEventListener('click', (e) => toggleSelect(id, e));
  return row;
}

/* Typing in an authored document. Text edits do NOT re-render: rebuilding the tree on every
 * keystroke would take the cursor away mid-word. The model is updated in place and persisted, and
 * only STRUCTURAL changes (adding or deleting a line) re-render — which is also when the cursor
 * has to be put back deliberately, via focusLineId. */

/* ---------------- selection + actions ---------------- */

/* SELECTION — a CONTIGUOUS RANGE, always (Seth, 2026-08-05).
 *
 * A plain click selects one unit and makes it the ANCHOR. Shift / Ctrl / Cmd-click recomputes the
 * selection as the whole run from the anchor to the clicked unit, in either direction — it moves
 * an endpoint rather than adding one unit at a time.
 *
 * ⚠ WHY THIS SHAPE, and not "add one at a time": grouping REQUIRES contiguity, so a range makes a
 * non-contiguous selection IMPOSSIBLE TO EXPRESS in the UI (Seth's point). The model's "units must
 * be adjacent" refusal stops being something a user can trip over — it is now a guard against
 * programming errors, not a message people see. The history here is instructive: selection began
 * purely additive, which silently accumulated units and left Edit/Ungroup permanently unusable
 * (the "ungroup does nothing" report); replace-by-default fixed that; ranges finish the job.
 *
 * The range runs over SIBLINGS — the top-level units, or the children of a shared parent — so it
 * can never straddle a group boundary. Anchor and target in different parents means the click
 * simply becomes a new anchor.
 *
 * `multiMode` is the toolbar stand-in for holding a modifier, because a touch device has none.
 */
let multiMode = false;
let anchor = null;                 // the fixed end of the range; a plain click moves it

// The ordered sibling list a unit belongs to, as the user SEES it (hidden blanks excluded).
function siblingsOf(id) {
  const hideBlank = state.view.hideBlank !== false;
  const parent = state.tree.find((g) => g.children.includes(id)) || null;
  const list = parent ? parent.children : visibleTopUnits(state, false);
  return list.filter((x) => !hideBlank || isGroupId(x) || !isBlankLine(nodeById(state, x)));
}

// The contiguous run between two units, or null when they are not siblings.
function rangeBetween(a, b) {
  const sibs = siblingsOf(a);
  const i = sibs.indexOf(a), j = sibs.indexOf(b);
  if (i < 0 || j < 0) return null;
  return sibs.slice(Math.min(i, j), Math.max(i, j) + 1);
}

function paintSelection() {
  root.querySelectorAll('.pa-row, .pa-group').forEach((el) => {
    if (el.dataset.unit) el.classList.toggle('sel', selection.has(el.dataset.unit));
  });
  refreshActionButtons();
}

function toggleSelect(id, ev) {
  const extend = multiMode || !!(ev && (ev.shiftKey || ev.ctrlKey || ev.metaKey));
  if (extend && anchor && anchor !== id) {
    const range = rangeBetween(anchor, id);
    // Not siblings (different groups): start a fresh range here rather than selecting nonsense.
    if (range) selection = new Set(range);
    else { selection = new Set([id]); anchor = id; }
  } else if (!extend && selection.size === 1 && selection.has(id)) {
    selection = new Set(); anchor = null;      // clicking the only selected unit again clears it
  } else {
    selection = new Set([id]); anchor = id;    // plain click: this one, and it anchors the range
  }
  paintSelection();
}

function clearSelection() {
  if (!selection.size) return;
  selection = new Set();
  anchor = null;
  root.querySelectorAll('.pa-row.sel, .pa-group.sel').forEach((el) => el.classList.remove('sel'));
  refreshActionButtons();
}

// The one group the selection points at, or null. Edit/Ungroup act on a GROUP HEADING (Seth,
// 2026-08-04) — the collapsible bar at the top of a group — so exactly one group and nothing else.
function selectedGroup() {
  const ids = [...selection];
  return (ids.length === 1 && isGroupId(ids[0])) ? nodeById(state, ids[0]) : null;
}

// What a group is called in a message/tooltip: its own label, else its summary line, else its id.
function groupTitle(g) {
  return g.relation || (summaryOf(state, g.id)[0] || '').slice(0, 40) || g.id;
}

/* ⚠ THE BUTTONS STAY ENABLED (Seth, 2026-08-04). They used to disable themselves whenever the
 * selection wasn't right, which reads as "the button is broken": a disabled button swallows the
 * click, logs nothing, and shows nothing — and because selection is ADDITIVE, a few exploratory
 * clicks silently put the app in that state. Now every button is clickable and SAYS what to
 * select instead, and the toolbar reports what is selected so it is clear what will be acted on. */
function refreshActionButtons() {
  const ids = [...selection];
  const g = selectedGroup();
  $('#pa-clear').disabled = !ids.length;
  $('#pa-edit').title = g ? t('para.editNamed', { name: groupTitle(g) }) : t('para.needGroupHeadingTip');
  $('#pa-ungroup').title = g ? t('para.ungroupNamed', { name: groupTitle(g) }) : t('para.needGroupHeadingTip');
  $('#pa-group').title = ids.length >= 2 ? t('para.groupTip') : t('para.needTwoTip');
  // The scope of collapse/expand follows the selection, so the tooltip must say WHICH it will be.
  const scoped = g ? groupTitle(g) : null;
  $('#pa-collapse-all').title = scoped ? t('para.collapseSelTip', { name: scoped }) : t('para.collapseAllTip');
  $('#pa-expand-all').title = scoped ? t('para.expandSelTip', { name: scoped }) : t('para.expandAllTip');
  const info = $('#pa-selinfo');
  if (info) {
    info.textContent = g ? t('para.selGroup', { name: groupTitle(g) })
      : ids.length === 1 ? t('para.selOne')
      : ids.length ? t('para.selCount', { n: ids.length })
      : '';
  }
}

// Esc — the companion to the Clear button: closes the join dialog if one is open, otherwise
// clears the selection. Registered ONCE: renderWork() replaces the whole subtree on every
// commit, so a listener added there would stack up one copy per edit.
let keysWired = false;
function wireKeys() {
  if (keysWired) return;
  keysWired = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !state) return;
    const dlg = document.getElementById('pa-dialog');
    if (dlg && !dlg.hidden) { dlg.hidden = true; dlg.innerHTML = ''; return; }
    clearSelection();
  });
}

function unitLabel(id) {
  if (!isGroupId(id)) {
    const l = nodeById(state, id);
    return (l.free || l.baseline || id).slice(0, 40);
  }
  const g = nodeById(state, id);
  return `${id}${g.relation ? ' — ' + g.relation : ''}`;
}

/* Collapse/expand everything, or — when something is selected — that subtree only (Seth,
 * 2026-08-05). Selecting a group and collapsing it takes its descendants down too, so opening it
 * again shows one level rather than dumping the whole depth back on screen.
 * Like every other button here it is never disabled: with no groups it SAYS so. */
function collapseAllAction(collapsed) {
  if (!state.tree.length) return alert(t('para.noGroupsYet'));
  const roots = [...selection].filter((id) => isGroupId(id));
  commit(setCollapsedAll(state, collapsed, roots.length ? roots : null));
}

function openGroupDialog() {
  if (selection.size < 2) return alert(t('para.needTwo'));
  // With blanks hidden, two visible neighbours may have silence between them in the model. Absorb
  // it, or the model refuses the group as non-adjacent for a reason the user cannot see.
  const top = topUnits(state);
  const ids = withBlanksBetween(state, [...selection], state.view.hideBlank !== false)
    .sort((a, b) => top.indexOf(a) - top.indexOf(b));
  groupDialog({ ids });
}

function openEditDialog() {
  const g = selectedGroup();
  if (!g) return alert(t('para.needGroupHeading'));
  groupDialog({ ids: g.children, gid: g.id, joinType: g.joinType, head: g.head,
                relation: g.relation, labels: g.labels || {} });
}

// The join dialog — GROUPING is the default and only action here (Seth: destructive merges are a
// separate explicit feature, not built in v1).
//
// LABELS (Seth, 2026-08-04): a relation can be written on the GROUP, on its MEMBER NODES, or
// both, and each one is optional. So the members list carries a label box per member, the group
// label sits under it, and the HEAD choice moved from a separate dropdown INTO that same list —
// one place showing every per-member decision, in reading order.
function groupDialog({ ids, gid, joinType = 'sym', head, relation = '', labels = {} }) {
  const dlg = $('#pa-dialog');
  dlg.hidden = false;
  /* ⚠ ONLY LIST MEMBERS THE USER CAN SEE (Seth, 2026-08-05: "extra group item labels for lines
   * that don't exist"). A hidden blank line is still absorbed into the group — it has to be, or
   * the children would not be contiguous — but it is not a unit the user is analysing, so it must
   * not get a label box, and above all not a HEAD radio: a silence cannot be the prominent member
   * of an asymmetrical join, and its summary would be empty. Files from FLEx routinely carry these
   * (Jn1_1-3-glossed.flextext has four whitespace-only phrases among eleven).
   * The current head is always shown even if invisible, so a group made before this fix can still
   * be seen and reassigned rather than becoming uneditable. */
  const hideBlank = state.view.hideBlank !== false;
  const shown = ids.filter((id) => isGroupId(id) || id === head
    || !(hideBlank && isBlankLine(nodeById(state, id))));
  const members = shown.map((id) => `
    <div class="pa-member">
      <label class="pa-headpick" title="${esc(t('para.headTip'))}">
        <input type="radio" name="pa-head" value="${esc(id)}" ${id === head ? 'checked' : ''}></label>
      <span class="pa-memtext" title="${esc(unitLabel(id))}">${esc(unitLabel(id))}</span>
      <input class="pa-memlabel" data-for="${esc(id)}" value="${esc(labels[id] || '')}"
             placeholder="${esc(t('para.nodeLabelPh'))}">
    </div>`).join('');
  dlg.innerHTML = `
    <div class="pa-modal">
      <h3>${esc(t(gid ? 'para.editGroup' : 'para.group'))}</h3>
      <div class="pa-modal-body">
        <label class="check-label"><input type="radio" name="pa-jt" value="sym" ${joinType !== 'asym' ? 'checked' : ''}>
          ${esc(t('para.symLong'))}</label>
        <label class="check-label"><input type="radio" name="pa-jt" value="asym" ${joinType === 'asym' ? 'checked' : ''}>
          ${esc(t('para.asymLong'))}</label>
        <p class="note pa-labelhint">${esc(t('para.labelHint'))}</p>
        <div class="pa-members ${joinType === 'asym' ? '' : 'no-head'}" id="pa-members">
          <div class="pa-member pa-memhead">
            <span class="pa-headpick">${esc(t('para.head'))}</span>
            <span>${esc(t('para.members'))}</span>
            <span>${esc(t('para.nodeLabels'))}</span>
          </div>
          ${members}
        </div>
        <label class="pa-field"><span>${esc(t('para.relation'))}</span>
          <input id="pa-rel" value="${esc(relation)}" placeholder="${esc(t('para.relationPh'))}"></label>
      </div>
      <div class="pa-modal-actions">
        <button class="secondary-btn" id="pa-cancel">${esc(t('para.cancel'))}</button>
        <button class="primary-btn" id="pa-ok">${esc(t('para.ok'))}</button>
      </div>
    </div>`;
  // The head column only exists for an asymmetrical join; switching TO asym pre-picks the first
  // member so the common case needs no extra click (the model still refuses a headless asym).
  dlg.querySelectorAll('input[name="pa-jt"]').forEach((r) => r.addEventListener('change', () => {
    const asym = dlg.querySelector('input[name="pa-jt"]:checked').value === 'asym';
    dlg.querySelector('#pa-members').classList.toggle('no-head', !asym);
    if (asym && !dlg.querySelector('input[name="pa-head"]:checked')) {
      dlg.querySelector('input[name="pa-head"]').checked = true;
    }
  }));
  dlg.querySelector('#pa-cancel').addEventListener('click', () => { dlg.hidden = true; dlg.innerHTML = ''; });
  dlg.querySelector('#pa-ok').addEventListener('click', () => {
    const jt = dlg.querySelector('input[name="pa-jt"]:checked').value;
    // Always send `labels` (even empty): the model then clears labels the user emptied out.
    const labelsOut = {};
    dlg.querySelectorAll('.pa-memlabel').forEach((inp) => {
      const v = inp.value.trim();
      if (v) labelsOut[inp.dataset.for] = v;
    });
    const opts = { joinType: jt, relation: dlg.querySelector('#pa-rel').value.trim(), labels: labelsOut };
    if (jt === 'asym') opts.head = dlg.querySelector('input[name="pa-head"]:checked')?.value;
    try {
      const next = gid
        ? editGroup(state, gid, { joinType: opts.joinType, head: opts.head, relation: opts.relation, labels: opts.labels })
        : groupUnits(state, ids, opts);
      selection = new Set(gid ? [gid] : []);
      dlg.hidden = true; dlg.innerHTML = '';
      commit(next);
    } catch (e) {
      alert(e.message);   // the model's message is the user message
    }
  });
}

function doUngroup() {
  const g = selectedGroup();
  if (!g) return alert(t('para.needGroupHeading'));
  try {
    const next = ungroup(state, g.id);   // may refuse (dissolve top-down) — keep the selection then
    selection = new Set();
    commit(next);
  } catch (e) { alert(e.message); }
}


/* ---------------- CSV / TSV import: the column-mapping wizard ----------------
 * Seth's scoping (2026-08-05): "require certain conventions and document those, rather than making
 * our script smart enough to handle any possible CSV/TSV." So: a file following the documented
 * column names maps itself, anything else is ASKED about, and the wizard carries the documentation
 * — step by step for Excel and Google Sheets, because many users will not otherwise know how to
 * produce a tab-separated file at all. */

const CSV_ROLES = ['baseline', 'gloss', 'free', 'speaker', 'start', 'end'];

function currentCsvMapping() {
  const m = {};
  for (const r of CSV_ROLES) {
    const v = ($('#pa-csv-' + r) || {}).value;
    if (v !== '' && v !== undefined && v !== null) m[r] = Number(v);
  }
  return m;
}

function renderCsvMapping(errors) {
  stopAudio();
  const P = pendingCsv;
  const label = (c) => `${c.name} — ${c.filled}${c.sample ? ' · “' + c.sample + '”' : ''}`;
  const sel = (role, allowNone) => {
    const cur = P.mapping[role];
    const opts = P.cols.map((c) =>
      `<option value="${c.index}"${c.index === cur ? ' selected' : ''}>${esc(label(c))}</option>`).join('');
    return `<select id="pa-csv-${role}">${allowNone ? `<option value=""${cur === undefined ? ' selected' : ''}>${esc(t('para.mapNone'))}</option>` : ''}${opts}</select>`;
  };
  const delimName = P.delimiter === '\t' ? t('para.csvTab') : P.delimiter === ';' ? ';' : P.delimiter;
  root.innerHTML = `
    <div class="pa-open pa-wizard">
      <h1>${esc(t('para.csvTitle'))}</h1>
      <p class="tab-hint">${esc(t('para.csvIntro', { file: P.name, delim: delimName, rows: P.rows.length }))}</p>
      ${errors && errors.length ? `<div class="banner warn-banner"><span>${esc(errors.join(' '))}</span></div>` : ''}
      <div class="banner warn-banner"><span>${esc(t('para.csvNew'))}
        <button class="link-btn" id="pa-csv-report">${esc(t('para.reportBtn'))}</button></span></div>

      <details class="pa-help">
        <summary>${esc(t('para.csvHowTitle'))}</summary>
        <div class="pa-helpbody">
          <p>${esc(t('para.csvHowIntro'))}</p>
          <p class="pa-helpcols"><b>${esc(t('para.csvHowColumns'))}</b></p>
          <ol>
            <li>${esc(t('para.csvHowRow1'))}</li>
            <li>${esc(t('para.csvHowRow2'))}</li>
            <li>${esc(t('para.csvHowRow3'))}</li>
          </ol>
          <p><b>${esc(t('para.csvExcelTitle'))}</b></p>
          <ol>
            <li>${esc(t('para.csvExcel1'))}</li>
            <li>${esc(t('para.csvExcel2'))}</li>
            <li>${esc(t('para.csvExcel3'))}</li>
          </ol>
          <p><b>${esc(t('para.csvSheetsTitle'))}</b></p>
          <ol>
            <li>${esc(t('para.csvSheets1'))}</li>
            <li>${esc(t('para.csvSheets2'))}</li>
          </ol>
          <p class="note">${esc(t('para.csvEncoding'))}</p>
          <button class="secondary-btn" id="pa-csv-template">${esc(t('para.csvTemplate'))}</button>
        </div>
      </details>

      <label class="check-label"><input type="checkbox" id="pa-csv-header" ${P.hasHeader ? 'checked' : ''}>
        ${esc(t('para.csvHasHeader'))}</label>
      <div class="pa-maprows">
        <label class="pa-maprow"><span>${esc(t('para.mapBaseline'))}</span>${sel('baseline', true)}</label>
        <label class="pa-maprow"><span>${esc(t('para.mapGlosses'))}</span>${sel('gloss', true)}</label>
        <label class="pa-maprow"><span>${esc(t('para.mapFree'))}</span>${sel('free', true)}</label>
        <label class="pa-maprow"><span>${esc(t('para.sfmSpeaker'))}</span>${sel('speaker', true)}</label>
        <label class="pa-maprow"><span>${esc(t('para.sfmStart'))}</span>${sel('start', true)}</label>
        <label class="pa-maprow"><span>${esc(t('para.sfmEnd'))}</span>${sel('end', true)}</label>
        <label class="pa-maprow"><span>${esc(t('para.csvTimeUnits'))}</span>
          <select id="pa-csv-units">
            <option value="auto">${esc(t('para.csvUnitsAuto'))}</option>
            <option value="seconds">${esc(t('para.csvUnitsSeconds'))}</option>
            <option value="ms">${esc(t('para.csvUnitsMs'))}</option>
          </select></label>
      </div>
      <p class="note">${esc(t('para.csvGlossNote'))}</p>
      <h3 class="pa-mapph">${esc(t('para.mapPreview'))}</h3>
      <div class="pa-mappreview" id="pa-map-preview"></div>
      <div class="pa-modal-actions">
        <button class="secondary-btn" id="pa-csv-cancel">${esc(t('para.cancel'))}</button>
        <button class="primary-btn" id="pa-csv-go">${esc(t('para.mapOpen'))}</button>
      </div>
    </div>`;
  $('#pa-csv-units').value = P.timeUnits;
  const refresh = () => {
    P.hasHeader = $('#pa-csv-header').checked;
    P.timeUnits = $('#pa-csv-units').value;
    P.mapping = currentCsvMapping();
    drawCsvPreview();
  };
  for (const r of CSV_ROLES) $('#pa-csv-' + r).addEventListener('change', refresh);
  $('#pa-csv-units').addEventListener('change', refresh);
  $('#pa-csv-header').addEventListener('change', () => {
    P.hasHeader = $('#pa-csv-header').checked;
    P.cols = columnsOf(P.rows, P.hasHeader);
    P.mapping = currentCsvMapping();
    renderCsvMapping();          // column NAMES change with the header, so redraw the whole form
  });
  $('#pa-csv-template').addEventListener('click', () =>
    downloadFile(templateCsv(), 'paragraph-analysis-template.csv', 'text/csv'));
  $('#pa-csv-report').addEventListener('click', reportCsvProblem);
  $('#pa-csv-cancel').addEventListener('click', () => { pendingCsv = null; renderOpen(); });
  $('#pa-csv-go').addEventListener('click', csvConfirm);
  drawCsvPreview();
}

function drawCsvPreview() {
  const box = $('#pa-map-preview');
  if (!box) return;
  const P = pendingCsv;
  const { lines } = csvToLines(P.rows, currentCsvMapping(), { hasHeader: P.hasHeader, timeUnits: P.timeUnits });
  if (!lines.length) { box.innerHTML = `<p class="note">${esc(t('para.mapEmpty'))}</p>`; return; }
  box.innerHTML = lines.slice(0, 4).map((l) => `
    <div class="pa-mapline">
      ${l.speaker ? `<div class="pa-speaker">${esc(l.speaker)}</div>` : ''}
      <div class="pa-baseline">${esc(l.baseline || '—')}</div>
      ${(l.words || []).some((w) => w.gls) ? `<div class="pa-words">${(l.words || []).map((w) =>
        `<span class="w"><span class="wt">${esc(w.txt)}</span><span class="wg">${esc(w.gls || ' ')}</span></span>`).join('')}</div>` : ''}
      ${l.free ? `<div class="pa-free">${esc(l.free)}</div>` : ''}
      ${typeof l.start === 'number' ? `<div class="pa-maptime">${clock(l.start)} – ${clock(l.end)}</div>` : ''}
    </div>`).join('')
    + (lines.length > 4 ? `<p class="note">${esc(t('para.mapMore', { n: lines.length - 4 }))}</p>` : '');
}

function reportCsvProblem() {
  const P = pendingCsv;
  const L = [];
  L.push('App: Paragraph Analysis Tool ' + (ENGINE_VERSION || ''));
  L.push('Browser: ' + navigator.userAgent);
  L.push('File: ' + P.name + ' (delimited)');
  L.push('Delimiter: ' + (P.delimiter === '\t' ? 'TAB' : P.delimiter) + ' | header row: ' + P.hasHeader
         + ' | rows: ' + P.rows.length + ' | time units: ' + P.timeUnits);
  L.push('Columns (name | non-empty cells): ' + P.cols.map((c) => c.name + ' | ' + c.filled).join(' · '));
  L.push('Chosen mapping: ' + CSV_ROLES.map((r) => r + '=' + (P.mapping[r] ?? 'none')).join(', '));
  L.push('');
  L.push('(No text from the file is included above — only its structure.)');
  const body = t('para.reportBody') + '\n\n\n---\n```\n' + L.join('\n') + '\n```\n';
  window.open('https://github.com/rulingAnts/flextext-editor/issues/new?title='
    + encodeURIComponent('CSV/TSV import: ' + P.name) + '&body=' + encodeURIComponent(body), '_blank', 'noopener');
}

async function csvConfirm() {
  const P = pendingCsv;
  const { lines } = csvToLines(P.rows, currentCsvMapping(), { hasHeader: P.hasHeader, timeUnits: P.timeUnits });
  if (!lines.length) return renderCsvMapping([t('para.mapEmpty')]);
  const hasSpans = lines.some((l) => typeof l.start === 'number');
  const audio = (P.audioFile && hasSpans)
    ? { b64: await blobToB64(P.audioFile), mime: P.audioFile.type || 'audio/wav', name: P.audioFile.name }
    : null;
  const doc = {
    title: P.name,
    paragraphs: lines.map((l) => ({ segments: [{ baseline: l.baseline, free: l.free || '', words: l.words || [], speaker: l.speaker || '', attrs: {} }] })),
    segments: lines.map((l) => (typeof l.start === 'number' ? { start: l.start, end: l.end } : { timePending: true })),
  };
  const speakers = [...new Set(lines.map((l) => l.speaker).filter(Boolean))];
  const fx = buildFxpa(doc, { title: doc.title, vernLang: 'und', analLang: 'en', audio, speakers });
  const v = validateFxpa(fx);
  if (!v.ok) return renderCsvMapping(v.errors);
  pendingCsv = null;
  load(v.data);
}

/* ---------------- exports ----------------
 * One dialog for every export format. Two of Seth's rules live here:
 *  - COLLAPSED GROUPS EXPORT COLLAPSED (what you see is what you get) — but the dialog WARNS when
 *    any are collapsed, so a partly-hidden export is never a surprise;
 *  - a SELECTION can be exported, not only the whole text.
 * More formats (scrollable diagram, SSA SVG, PNG, paragraph-analyzed EAF) slot in beside these. */

function openExportDialog() {
  const dlg = $('#pa-dialog');
  const collapsedCount = (state.view.collapsed || []).length;
  const selCount = selection.size;
  dlg.hidden = false;
  dlg.innerHTML = `
    <div class="pa-modal">
      <h3>${esc(t('para.exportTitle'))}</h3>
      <div class="pa-modal-body">
        <label class="pa-field"><span>${esc(t('para.exportWhat'))}</span>
          <select id="pa-exp-what">
            <option value="preview">${esc(t('para.exportPreview'))}</option>
            <option value="diagram">${esc(t('para.exportDiagram'))}</option>
            <option value="svg">${esc(t('para.exportSvg'))}</option>
          </select></label>
        <p class="note" id="pa-exp-note">${esc(t('para.exportPreviewNote'))}</p>
        <label class="pa-field"><span>${esc(t('para.exportScope'))}</span>
          <select id="pa-exp-scope">
            <option value="all">${esc(t('para.exportAll'))}</option>
            <option value="sel"${selCount ? '' : ' disabled'}>${esc(t('para.exportSelection', { n: selCount }))}</option>
          </select></label>
        <label class="check-label"><input type="checkbox" id="pa-exp-audio" ${state.audio ? 'checked' : 'disabled'}>
          ${esc(t('para.exportWithAudio'))}</label>
        <div id="pa-exp-diagram" hidden>
          <label class="pa-field"><span>${esc(t('para.exportTextWidth'))}</span>
            <select id="pa-exp-tw">
              <option value="300">${esc(t('para.widthNarrow'))}</option>
              <option value="440" selected>${esc(t('para.widthMedium'))}</option>
              <option value="640">${esc(t('para.widthWide'))}</option>
              <option value="900">${esc(t('para.widthVeryWide'))}</option>
            </select></label>
          <label class="pa-field"><span>${esc(t('para.exportIndent'))}</span>
            <select id="pa-exp-lw">
              <option value="70">${esc(t('para.indentTight'))}</option>
              <option value="120" selected>${esc(t('para.indentNormal'))}</option>
              <option value="180">${esc(t('para.indentRoomy'))}</option>
            </select></label>
          <label class="pa-field"><span>${esc(t('para.exportLabels'))}</span>
            <select id="pa-exp-labels">
              <option value="both" selected>${esc(t('para.labelsBoth'))}</option>
              <option value="relations">${esc(t('para.labelsRelations'))}</option>
              <option value="roles">${esc(t('para.labelsRoles'))}</option>
            </select></label>
          <label class="check-label"><input type="checkbox" id="pa-exp-view" checked>
            ${esc(t('para.exportMatchView'))}</label>
          <p class="note">${esc(t('para.exportDiagramHint'))}</p>
        </div>
        ${collapsedCount ? `<div class="banner warn-banner"><span>${esc(t('para.exportCollapsedWarn', { n: collapsedCount }))}</span></div>` : ''}
      </div>
      <div class="pa-modal-actions">
        <button class="secondary-btn" id="pa-exp-cancel">${esc(t('para.cancel'))}</button>
        <button class="primary-btn" id="pa-exp-go">${esc(t('para.exportGo'))}</button>
      </div>
    </div>`;
  dlg.querySelector('#pa-exp-what').addEventListener('change', (e) => {
    const k = e.target.value;
    dlg.querySelector('#pa-exp-note').textContent =
      t(k === 'preview' ? 'para.exportPreviewNote' : k === 'diagram' ? 'para.exportDiagramNote' : 'para.exportSvgNote');
    // Audio only means anything for the interactive page; a diagram is a picture.
    dlg.querySelector('#pa-exp-audio').disabled = k !== 'preview' || !state.audio;
    dlg.querySelector('#pa-exp-diagram').hidden = k === 'preview';
  });
  dlg.querySelector('#pa-exp-cancel').addEventListener('click', () => { dlg.hidden = true; dlg.innerHTML = ''; });
  dlg.querySelector('#pa-exp-go').addEventListener('click', runExport);
}

function runExport() {
  const dlg = $('#pa-dialog');
  const kind = dlg.querySelector('#pa-exp-what').value;
  const scope = dlg.querySelector('#pa-exp-scope').value;
  const withAudio = dlg.querySelector('#pa-exp-audio').checked && !!state.audio && kind === 'preview';
  const common = {
    title: state.title,
    only: scope === 'sel' ? [...selection] : null,
    collapsed: state.view.collapsed || [],
    hideBlank: state.view.hideBlank !== false,
    lang: getLangForExport(),
    // Real text metrics from the browser, so the diagram wraps where it actually will.
    measure: measureText,
  };
  if (kind === 'diagram' || kind === 'svg') {
    // Diagram geometry is the user's call — a long line or a deep analysis needs different room,
    // and guessing it for them was what produced diagrams too wide to use (Seth, 2026-08-05).
    const matchView = dlg.querySelector('#pa-exp-view').checked;
    const diagram = { ...common,
      textWidth: +dlg.querySelector('#pa-exp-tw').value,
      levelWidth: +dlg.querySelector('#pa-exp-lw').value,
      labels: dlg.querySelector('#pa-exp-labels').value,
      // "matching whatever view settings the user had before they exported" — otherwise the
      // library default (free translation only, the SSA convention).
      layer: matchView ? state.view.layer : 'free',
      free: matchView ? state.view.free !== false : false,
    };
    const out = kind === 'svg' ? buildSsaSvg(state, diagram) : buildSsaDiagramHtml(state, diagram);
    downloadFile(out, safeName(state.title) + (kind === 'svg' ? '.ssa.svg' : '.ssa.html'),
                 kind === 'svg' ? 'image/svg+xml' : 'text/html');
    dlg.hidden = true; dlg.innerHTML = '';
    return;
  }
  const html = buildParagraphPreviewHtml(state, {
    title: state.title,
    audioB64: withAudio ? state.audio.b64 : '',
    audioMime: withAudio ? (state.audio.mime || 'audio/wav') : '',
    only: scope === 'sel' ? [...selection] : null,
    collapsed: state.view.collapsed || [],
    hideBlank: state.view.hideBlank !== false,
    layer: state.view.layer,
    free: state.view.free !== false,
    lang: getLangForExport(),
  });
  downloadFile(html, safeName(state.title) + '.preview.html', 'text/html');
  dlg.hidden = true; dlg.innerHTML = '';
}

const getLangForExport = () => (document.documentElement.lang || 'en');

// The diagram renderer is PURE and cannot measure text, so the app injects real metrics — the
// difference between a diagram that wraps where it looks like it will and one that does not.
let _measureCanvas = null;
function measureText(text, fontSize) {
  if (!_measureCanvas) _measureCanvas = document.createElement('canvas');
  const ctx = _measureCanvas.getContext('2d');
  ctx.font = fontSize + 'px Helvetica, Arial, sans-serif';
  return ctx.measureText(String(text)).width;
}
const safeName = (s) => String(s || 'text').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);

function downloadFile(text, name, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

/* ---------------- save ---------------- */

function saveFxpa() {
  const name = String(state.title || 'text').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) + '.fxpa';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([serializeFxpa(state)], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
