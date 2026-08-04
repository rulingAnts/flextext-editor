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

import { t, applyI18n } from './i18n.js';
import * as db from './db.js';
import { parseFlextext, segmentsFromOffsets, esc } from './flextext.js';
import { buildFxpa } from './seg-exports.js';
import {
  validateFxpa, serializeFxpa, groupUnits, ungroup, editGroup, toggleCollapse,
  topUnits, levelOf, spanOf, leavesOf, summaryOf, isGroupId, nodeById,
} from './paragraph-model.js';

const WORKING_KEY = 'fxpa:working';

let state = null;                 // validated .fxpa data (the model object)
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
        <input type="file" id="pa-file" multiple hidden
               accept=".fxpa,.flextext,audio/*,application/json,text/xml">
      </div>
      ${errors && errors.length ? `<div class="banner warn-banner"><span>${esc(errors.join(' '))}</span></div>` : ''}
      <p class="note">${esc(t('para.textOnlyNote'))}</p>
    </div>`;
  const drop = $('#pa-drop');
  const input = $('#pa-file');
  $('#pa-pick').addEventListener('click', () => input.click());
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
    const B = Math.min(2000000, Math.max(4000, Math.round(buf.duration * 2000)));
    const per = Math.max(1, Math.floor(ch.length / B));
    peaks = new Float32Array(B);
    for (let b = 0; b < B; b++) {
      let m = 0;
      const off = b * per, end = Math.min(ch.length, off + per);
      for (let i = off; i < end; i += 4) { const v = Math.abs(ch[i]); if (v > m) m = v; }
      peaks[b] = m;
    }
    mpb = (per / buf.sampleRate) * 1000;
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
        <button class="secondary-btn" id="pa-clear" disabled title="${esc(t('para.clearSelTip'))}">${esc(t('para.clearSel'))}</button>
        <button class="primary-btn" id="pa-save">${esc(t('para.save'))}</button>
        <button class="link-btn" id="pa-close" title="${esc(t('para.closeTip'))}">✕</button>
      </span>
    </div>
    ${showAudio ? `
    <div class="pa-player">
      <div class="pa-ovwrap"><canvas id="pa-ov"></canvas><div class="pa-cur" id="pa-ovcur"></div></div>
      <div class="pa-transport"><button class="icon-btn2" id="pa-play">▶</button><span id="pa-time" class="player-time"></span></div>
    </div>` : ''}
    <p class="pa-tip">${esc(t('para.selectTip'))}</p>
    <div class="pa-tree" id="pa-tree"></div>
    <div id="pa-dialog" hidden></div>`;

  $('#pa-layer').value = v.layer;
  $('#pa-free').checked = v.free !== false;
  // free-only requires free on; disable the free checkbox there (it is the whole display).
  $('#pa-free').disabled = v.layer === 'free-only';
  if (state.audio) {
    $('#pa-audio').checked = v.audio !== false;
    if ($('#pa-waves')) $('#pa-waves').value = v.waves || 'compact';
  }
  $('#pa-layer').addEventListener('change', (e) => setView({ layer: e.target.value, ...(e.target.value === 'free-only' ? { free: true } : {}) }));
  $('#pa-free').addEventListener('change', (e) => setView({ free: e.target.checked }));
  if (state.audio) {
    $('#pa-audio').addEventListener('change', (e) => setView({ audio: e.target.checked }));
    $('#pa-waves')?.addEventListener('change', (e) => setView({ waves: e.target.value }));
  }
  $('#pa-save').addEventListener('click', saveFxpa);
  $('#pa-close').addEventListener('click', () => {
    if (!confirm(t('para.closeConfirm'))) return;
    db.deleteMedia(WORKING_KEY).catch(() => {});
    state = null; stopAudio(); renderOpen();
  });
  $('#pa-group').addEventListener('click', openGroupDialog);
  $('#pa-ungroup').addEventListener('click', doUngroup);
  $('#pa-edit').addEventListener('click', openEditDialog);
  $('#pa-clear').addEventListener('click', clearSelection);
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
  for (const id of topUnits(state)) tree.appendChild(renderUnit(id));
  refreshActionButtons();
  drawAllWaves();
  startTicker();
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
function renderUnit(id, nodeLabel = '') {
  if (!isGroupId(id)) return renderLineRow(id, nodeLabel);
  const g = nodeById(state, id);
  const el = document.createElement('div');
  el.className = 'pa-group' + (selection.has(id) ? ' sel' : '');
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
  el.appendChild(badge);
  if (collapsed) {
    for (const line of summaryOf(state, id)) {
      const s = document.createElement('div');
      s.className = 'pa-summary';
      s.textContent = line || '—';
      el.appendChild(s);
    }
  } else {
    for (const c of g.children) el.appendChild(renderUnit(c, (g.labels || {})[c] || ''));
    // HEAD marker on the head child's container/row.
    if (g.joinType === 'asym') {
      const headEl = [...el.children].find((ch) => ch.dataset && ch.dataset.unit === g.head);
      if (headEl) headEl.classList.add('pa-head');
    }
  }
  return el;
}

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
  if (showAudio && timed) {
    parts.push(`<button class="pa-rowplay" data-s="${l.start}" data-e="${l.end}">▶</button>`);
  }
  const body = [`<div class="pa-cell">`];
  if (wavesMode !== 'off' && timed) {
    body.push(`<canvas class="pa-wave ${wavesMode === 'compact' ? 'pa-wave-sm' : ''}" data-s="${l.start}" data-e="${l.end}"></canvas>`);
  }
  if (v.layer === 'baseline') {
    body.push(`<div class="pa-baseline">${esc(l.baseline || '')}</div>`);
  } else if (v.layer === 'interlinear') {
    const words = (l.words || []).map((w) => w.punct
      ? `<span class="w punct"><span class="wt">${esc(w.txt)}</span></span>`
      : `<span class="w"><span class="wt">${esc(w.txt)}</span><span class="wg">${esc(w.gls || ' ')}</span></span>`).join('');
    body.push(`<div class="pa-words">${words}</div>`);
  }
  if ((v.free !== false || v.layer === 'free-only') && l.free) {
    body.push(`<div class="pa-free">${esc(l.free)}</div>`);
  }
  body.push('</div>');
  row.innerHTML = parts.join('') + body.join('');
  const play = row.querySelector('.pa-rowplay');
  if (play) play.addEventListener('click', (e) => { e.stopPropagation(); playSpan(l.start, l.end); });
  const wave = row.querySelector('canvas');
  if (wave) wireScrub(wave, l.start, l.end);
  row.addEventListener('click', (e) => toggleSelect(id, e));
  return row;
}

/* ---------------- selection + actions ---------------- */

/* SELECTION (Seth, 2026-08-04): a plain click REPLACES the selection; Shift-click or
 * Ctrl/Cmd-click ADDS to it. Selection used to be purely additive, which quietly accumulated
 * units as the user explored and left Edit/Ungroup permanently unusable — the "ungroup does
 * nothing" report. Replace-by-default means the selection is always what you last clicked.
 *
 * `multiMode` is the SAME thing as holding a modifier, exposed as a toolbar toggle, because a
 * touch device has no modifier keys — without it, tablets could select one unit and could
 * therefore never group anything. */
let multiMode = false;

function toggleSelect(id, ev) {
  const additive = multiMode || !!(ev && (ev.shiftKey || ev.ctrlKey || ev.metaKey));
  if (additive) {
    if (selection.has(id)) selection.delete(id); else selection.add(id);
  } else if (selection.size === 1 && selection.has(id)) {
    selection = new Set();                     // clicking the only selected unit again clears it
  } else {
    selection = new Set([id]);                 // plain click: this one, and only this one
  }
  root.querySelectorAll('.pa-row, .pa-group').forEach((el) => {
    if (el.dataset.unit) el.classList.toggle('sel', selection.has(el.dataset.unit));
  });
  refreshActionButtons();
}

// Deselect everything. A pure VIEW action — it never touches doc/tree, so it deliberately does
// NOT commit or re-render (a render would rebuild the tree DOM and lose scroll position); it
// just drops the highlight classes. Selection is easy to build up wrongly (a refused group
// leaves it intact on purpose), so this is the way out that isn't hunting for each selected row.
function clearSelection() {
  if (!selection.size) return;
  selection = new Set();
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

function openGroupDialog() {
  if (selection.size < 2) return alert(t('para.needTwo'));
  groupDialog({ ids: [...selection] });
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
  const members = ids.map((id) => `
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

/* ---------------- save ---------------- */

function saveFxpa() {
  const name = String(state.title || 'text').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) + '.fxpa';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([serializeFxpa(state)], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
