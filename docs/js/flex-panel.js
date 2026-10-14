/* flex-panel.js — the FLEx features' UI, loaded ONLY inside the desktop shell (plans/flex-desktop-segmenter.md
 * §1, §3, §4.4, §11). app.js imports this module dynamically after native-flex.js's whenFlexReady()
 * answered true, so a browser never loads it and no SHELL list has to carry it.
 *
 * What it adds to the Audio Segmenter: a FLEx section on the home view (choose a project, open it read-
 * only or for writing, open one of its texts as a local record whose `flex` field keeps the FROZEN base
 * doc and baseRev), and on an open FLEx-bound text the FLEx row: Save to FLEx… (diff → preview → confirm
 * → job with progress), Undo / Redo Save to FLEx (the SEPARATE history, D1), Copy this line as FLEx Print
 * view, Export bundle, Relink a missing recording, Import .flextext into FLEx.
 *
 * Two histories, never interleaved (§4.4): the editor's Ctrl+Z ring is untouched by anything here, and
 * nothing here ever writes to FLEx except through the shell's Save to FLEx, which the user confirms. */

import { flex, flexShellInfo, isFlexShell } from './native-flex.js';
import { diffFlexDoc, postStateOf, flexBlockers } from './flex-ops.js';
import { printViewTsv } from './printview-tsv.js';
import { esc } from './flextext.js';

let H = null;      // hooks from app.js: { db, getCurrent, setCurrent, openRecord, t, toast, confirmDialog, refreshList, docStats }
let project = null;   // { name, writable, ws, printViewConfig, texts: [...] }

const $ = (sel, root = document) => root.querySelector(sel);
const clone = (x) => JSON.parse(JSON.stringify(x));
const T = (k, v) => (H && H.t ? H.t(k, v) : k);

export function initFlexPanel(hooks) {
  H = hooks;
  if (!isFlexShell()) return false;
  document.documentElement.classList.add('flex-shell');
  renderHome();
  document.addEventListener('flextext:home-rendered', renderHome);
  document.addEventListener('flextext:editor-entered', renderEditorRow);
  return true;
}

/* ---- the home section ------------------------------------------------------------------------ */
function renderHome() {
  const view = $('#view-segmenter');
  if (!view || $('#flex-home', view)) return;
  const info = flexShellInfo() || {};
  const box = document.createElement('section');
  box.id = 'flex-home';
  box.className = 'flex-home';
  box.innerHTML = `
    <h3>${esc(T('flex.title'))} <small class="flex-ver">${esc(info.fwVersion || '')} · ${esc(T('flex.shell'))} ${esc(info.shellVersion || '')}${info.copyOnly ? ' · ' + esc(T('flex.copyOnly')) : ''}</small></h3>
    <div class="flex-row">
      <select id="flex-project"><option value="">${esc(T('flex.chooseProject'))}</option></select>
      <button id="flex-open-read" class="secondary-btn" disabled>${esc(T('flex.openRead'))}</button>
      <button id="flex-open-write" class="primary-btn" disabled>${esc(T('flex.openWrite'))}</button>
      <button id="flex-close" class="link-btn" hidden>${esc(T('flex.closeProject'))}</button>
    </div>
    <p id="flex-reasons" class="flex-reasons" hidden></p>
    <ul id="flex-texts" class="doc-list" hidden></ul>
    <div class="flex-row" id="flex-project-actions" hidden>
      <button id="flex-import" class="secondary-btn">${esc(T('flex.import'))}</button>
    </div>`;
  view.insertBefore(box, view.firstChild);
  loadProjects();
  $('#flex-project', box).addEventListener('change', onProjectPick);
  $('#flex-open-read', box).addEventListener('click', () => openProject('read'));
  $('#flex-open-write', box).addEventListener('click', () => openProject('write'));
  $('#flex-close', box).addEventListener('click', closeProject);
  $('#flex-import', box).addEventListener('click', importFlextext);
}

let projects = [];
async function loadProjects() {
  try { projects = await flex.listProjects(); } catch (e) { fail(e); return; }
  const sel = $('#flex-project');
  if (!sel) return;
  for (const p of projects) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.name + (p.writable ? '' : ' · ' + T('flex.readOnlyTag'));
    sel.appendChild(o);
  }
}
function onProjectPick() {
  const p = projects.find((x) => x.name === $('#flex-project').value);
  $('#flex-open-read').disabled = !p || !p.readable;
  $('#flex-open-write').disabled = !p || !p.writable;
  const r = $('#flex-reasons');
  r.hidden = !p || !p.reasons.length;
  if (p && p.reasons.length) r.textContent = p.reasons.map((c) => T('flex.err.' + c)).join(' ');
}
async function openProject(mode) {
  const name = $('#flex-project').value;
  if (!name) return;
  try {
    const r = await flex.openProject(name, mode);
    project = { name, writable: r.writable, ws: r.ws, printViewConfig: r.printViewConfig, texts: await flex.listTexts() };
  } catch (e) { fail(e); return; }
  $('#flex-close').hidden = false;
  $('#flex-open-read').disabled = $('#flex-open-write').disabled = $('#flex-project').disabled = true;
  $('#flex-project-actions').hidden = !project.writable;
  renderTexts();
}
async function closeProject() {
  try { await flex.closeProject(); } catch (e) { fail(e); }
  project = null;
  $('#flex-close').hidden = true;
  $('#flex-project').disabled = false;
  $('#flex-texts').hidden = true;
  $('#flex-project-actions').hidden = true;
  onProjectPick();
}
function renderTexts() {
  const ul = $('#flex-texts');
  ul.hidden = false;
  ul.innerHTML = '';
  for (const tx of project.texts) {
    const li = document.createElement('li');
    li.className = 'rec-item';
    const missing = tx.media.filter((m) => !m.exists).length;
    li.innerHTML = `<span class="rec-title"></span><span class="rec-meta">${esc(T('flex.textMeta', { p: tx.paras, s: tx.segs, t: tx.timedSegs }))}${missing ? ' · ' + esc(T('flex.mediaMissing')) : ''}</span>
      <button class="primary-btn flex-open-text">${esc(T('flex.openText'))}</button>`;
    li.querySelector('.rec-title').textContent = tx.title;   // titles reach the UI only, never a log
    li.querySelector('.flex-open-text').addEventListener('click', () => openText(tx));
    ul.appendChild(li);
  }
}

/* A FLEx text becomes a local record. `rec.flex` = { textGuid, baseRev, base (frozen doc), project }.
 * Re-opening the same text replaces the record's doc from FLEx (FLEx is the truth until Save). */
async function openText(tx) {
  let opened;
  try { opened = await flex.openText(tx.guid); } catch (e) { fail(e); return; }
  const id = 'flex:' + project.name + ':' + tx.guid;
  const doc = opened.doc;
  const rec = (await H.db.getDoc(id)) || { id, created: Date.now() };
  rec.title = doc.title;
  rec.doc = doc;
  rec.flex = { textGuid: tx.guid, baseRev: opened.baseRev, base: clone(doc), project: project.name, writable: project.writable };
  rec.modified = Date.now();
  Object.assign(rec, H.docStats(doc));
  await H.db.putDoc(rec);
  // audio: the shell serves the linked file from /media/<token>; the engine stores it as the doc's media
  const track = (doc.flex.media || []).find((m) => m.url);
  if (track && H.fetchMedia) {
    try { await H.fetchMedia(id, track.url, track.uri.split(/[\\/]/).pop()); } catch (e) { H.toast(T('flex.mediaLoadFailed')); }
  }
  await H.openRecord(id);
}

/* ---- the editor row -------------------------------------------------------------------------- */
function renderEditorRow() {
  const cur = H.getCurrent();
  const host = $('#topbar-editor');
  const old = $('#flex-row');
  if (old) old.remove();
  if (!cur || !cur.flex || !host) return;
  const row = document.createElement('div');
  row.id = 'flex-row';
  row.className = 'flex-editor-row';
  row.innerHTML = `
    <span class="flex-badge">${esc(T('flex.badge'))}${cur.flex.writable ? '' : ' · ' + esc(T('flex.readOnlyTag'))}</span>
    <button id="flex-save" class="primary-btn" ${cur.flex.writable ? '' : 'disabled'}>${esc(T('flex.save'))}</button>
    <button id="flex-undo" class="secondary-btn" title="${esc(T('flex.undoTip'))}" disabled>${esc(T('flex.undo'))}</button>
    <button id="flex-redo" class="secondary-btn" disabled>${esc(T('flex.redo'))}</button>
    <button id="flex-copy" class="link-btn">${esc(T('flex.copyLine'))}</button>
    <button id="flex-export" class="link-btn">${esc(T('flex.export'))}</button>
    <button id="flex-relink" class="link-btn" hidden>${esc(T('flex.relink'))}</button>`;
  host.appendChild(row);
  $('#flex-save', row).addEventListener('click', saveToFlex);
  $('#flex-undo', row).addEventListener('click', () => undoRedo('undo'));
  $('#flex-redo', row).addEventListener('click', () => undoRedo('redo'));
  $('#flex-copy', row).addEventListener('click', copyLine);
  $('#flex-export', row).addEventListener('click', exportBundle);
  $('#flex-relink', row).addEventListener('click', relink);
  const missing = (cur.doc.flex && cur.doc.flex.media || []).find((m) => !m.url);
  if (missing && cur.flex.writable) $('#flex-relink', row).hidden = false;
  updateHistoryButtons();
}
const flexHistory = { undo: 0, redo: 0 };
function updateHistoryButtons() {
  const u = $('#flex-undo'), r = $('#flex-redo');
  if (u) u.disabled = !flexHistory.undo;
  if (r) r.disabled = !flexHistory.redo;
}

/* ---- Save to FLEx (§11) ------------------------------------------------------------------------ */
async function saveToFlex() {
  const cur = H.getCurrent();
  if (!cur || !cur.flex) return;
  if (H.flush) await H.flush();   // commit any focused field / pending persist first
  const base = cur.flex.base;
  const media = cur.flex.mediaPath || null;
  const diff = diffFlexDoc(base, cur.doc, { ws: cur.doc.analLang, media });
  const blockers = flexBlockers(cur.doc, diff.touched).filter((b) => b.blocking);
  if (!diff.ops.length && !diff.unsupported.length) { H.toast(T('flex.nothingToSave')); return; }
  if (diff.unsupported.length) {
    const why = [...new Set(diff.unsupported.map((u) => T('flex.unsupported.' + u.why)))].join('\n');
    H.toast(T('flex.cannotDiff') + '\n' + why, 9000);
    return;
  }
  let preview;
  try {
    preview = await flex.previewSave(cur.flex.textGuid, cur.flex.baseRev, diff.ops, postStateOf(cur.doc, diff.touched, base));
  } catch (e) { fail(e); return; }
  const ok = await showPreview(preview, blockers, flexBlockers(cur.doc, diff.touched).filter((b) => !b.blocking));
  if (!ok) return;
  const prog = progressModal(T('flex.saving'));
  try {
    const r = await flexJobWithProgress('save_to_flex', preview.previewToken, prog.set);
    prog.close();
    // the base is now what we wrote; new phrases take LCM's guids so later diffs key right
    applyAliases(cur.doc, r.alias || {});
    cur.flex.base = clone(cur.doc);
    cur.flex.baseRev = r.newBaseRev;
    flexHistory.undo++; flexHistory.redo = 0;
    updateHistoryButtons();
    if (H.persist) await H.persist();
    H.toast(T('flex.saved', { n: r.saved, b: (r.backup && r.backup.path || '').split(/[\\/]/).pop() }), 7000);
  } catch (e) {
    prog.close();
    fail(e, true);
  }
}
function applyAliases(doc, alias) {
  for (const ln of doc.paragraphs) {
    for (const seg of ln.segments) {
      const g = seg.attrs && seg.attrs.guid;
      if (g && alias[g]) { seg.attrs.guid = alias[g]; seg.flex = { ...(seg.flex || {}), segGuid: alias[g], paraGuid: alias[ln.paraOf] || ln.paraOf }; }
    }
    if (ln.paraOf && alias[ln.paraOf]) ln.paraOf = alias[ln.paraOf];
  }
}
function showPreview(preview, blockers, warnings) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    const items = preview.summary.map((s) => `<li class="flex-sum-${esc(s.kind.replace('.', '-'))}">${esc(describe(s))}</li>`).join('');
    const warn = [...(preview.warnings || []).map((w) => T('flex.warn.' + w.code, w)), ...warnings.map((w) => T('flex.warn.' + w.code, { c: w.char || '' }))];
    wrap.innerHTML = `<div class="modal-card flex-preview" role="dialog" aria-modal="true">
      <h3>${esc(T('flex.previewTitle', { n: preview.summary.length }))}</h3>
      <ul class="flex-summary">${items || '<li>' + esc(T('flex.nothingToSave')) + '</li>'}</ul>
      ${blockers.length ? '<p class="flex-blockers">' + blockers.map((b) => esc(T('flex.warn.' + b.code, { c: b.char || '' }))).join('<br>') + '</p>' : ''}
      ${warn.length ? '<p class="flex-warnings">' + warn.map(esc).join('<br>') + '</p>' : ''}
      <p class="flex-backup">${esc(T('flex.backupNote', { d: preview.backupDir || '' }))}</p>
      <button class="primary-btn" data-ok ${blockers.length ? 'disabled' : ''}>${esc(T('flex.confirm'))}</button>
      <button class="link-btn" data-cancel>${esc(T('share.cancel'))}</button>
    </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('[data-ok]').addEventListener('click', () => { wrap.remove(); resolve(true); });
    wrap.querySelector('[data-cancel]').addEventListener('click', () => { wrap.remove(); resolve(false); });
  });
}
function describe(s) {
  switch (s.kind) {
    case 'ft.set': return T('flex.sum.ft', { b: s.before || '—', a: s.after || '—' });
    case 'lt.set': return T('flex.sum.lt', { b: s.before || '—', a: s.after || '—' });
    case 'times.set': return T('flex.sum.times', { b: s.begin, e: s.end });
    case 'gloss.set': return T('flex.sum.gloss.' + s.outcome, { n: s.otherUses || 0 }) + (s.approves ? ' ' + T('flex.sum.approves') : '');
    case 'word.split': return T('flex.sum.wordSplit', { w: s.word, a: s.into[0], b: s.into[1] });
    case 'word.insert': return T('flex.sum.wordInsert', { w: s.word });
    case 'baseline.replace': return T('flex.sum.baseline', { b: s.before, a: s.after });
    case 'media.attach': return T('flex.sum.attach', { f: s.file });
    case 'media.relink': return T('flex.sum.relink', { f: s.to });
    default: return T('flex.sum.' + s.kind.replace('.', '_'));
  }
}
function progressModal(title) {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><p class="flex-progress">…</p></div>`;
  document.body.appendChild(wrap);
  return { set: (m) => { const p = wrap.querySelector('.flex-progress'); if (p) p.textContent = m || '…'; }, close: () => wrap.remove() };
}
async function flexJobWithProgress(method, arg, onProgress) {
  const start = await flex[{ save_to_flex: 'saveToFlex', undo_flex: 'undoFlex', redo_flex: 'redoFlex', import_flextext: 'importFlextext', export_editor_bundle: 'exportEditorBundle' }[method]].__raw
    ? null : null;
  // flex.* helpers poll to completion themselves; progress is read by polling job_status alongside
  const { flexCall } = await import('./native-flex.js');
  const r = await flexCall(method, arg);
  if (!r || !r.jobId) return r;
  for (;;) {
    const st = await flexCall('job_status', r.jobId);
    if (onProgress) onProgress(st.progress);
    if (st.state === 'done') return st.result;
    if (st.state === 'error') { const e = new Error(st.error.message || st.error.code); e.code = st.error.code; e.detail = st.error.detail; throw e; }
    await new Promise((res) => setTimeout(res, 150));
  }
}

/* ---- Undo / Redo Save to FLEx (§4.4): FLEx goes back; the editor's edits stay as unsaved --------- */
async function undoRedo(which) {
  const cur = H.getCurrent();
  if (!cur || !cur.flex) return;
  const prog = progressModal(T(which === 'undo' ? 'flex.undoing' : 'flex.redoing'));
  try {
    const r = await flexJobWithProgress(which === 'undo' ? 'undo_flex' : 'redo_flex', undefined, prog.set);
    prog.close();
    const reopened = await flex.openText(cur.flex.textGuid);
    cur.flex.base = clone(reopened.doc);
    cur.flex.baseRev = reopened.baseRev;
    if (which === 'undo') { flexHistory.undo--; flexHistory.redo++; } else { flexHistory.undo++; flexHistory.redo--; }
    updateHistoryButtons();
    if (H.persist) await H.persist();
    H.toast(T(which === 'undo' ? 'flex.undone' : 'flex.redone', { l: r.label }), 6000);
  } catch (e) { prog.close(); fail(e, true); }
}

/* ---- Copy this line as FLEx Print view (§10) ------------------------------------------------------ */
async function copyLine() {
  const cur = H.getCurrent();
  const li = H.activeLine ? H.activeLine() : 0;
  const line = cur && cur.doc.paragraphs[li];
  const seg = line && line.segments[0];
  if (!seg || !seg.flex || !seg.flex.segGuid) { H.toast(T('flex.copyNoLine')); return; }
  try {
    const data = await flex.printviewData(seg.flex.segGuid);
    const tsv = printViewTsv(data, { lines: project && project.printViewConfig ? project.printViewConfig.lines : undefined });
    await flex.copyText(tsv);
    H.toast(T('flex.copied'));
  } catch (e) { fail(e); }
}

/* ---- Export / relink / import --------------------------------------------------------------------- */
async function exportBundle() {
  const cur = H.getCurrent();
  if (!cur || !cur.flex) return;
  const prog = progressModal(T('flex.exporting'));
  try {
    const r = await flexJobWithProgress('export_editor_bundle', cur.flex.textGuid, prog.set);
    prog.close();
    H.toast(T('flex.exported', { p: r.zipPath }), 9000);
  } catch (e) { prog.close(); fail(e); }
}
async function relink() {
  const cur = H.getCurrent();
  const missing = (cur && cur.doc.flex && cur.doc.flex.media || []).find((m) => !m.url);
  if (!missing) return;
  try {
    const pick = await flex.pickFile('media');
    if (!pick || !pick.path) return;
    const preview = await flex.relinkPreview(cur.flex.textGuid, missing.uriGuid, pick.path);
    if (!await showPreview(preview, [], [])) return;
    const prog = progressModal(T('flex.saving'));
    try {
      const r = await flexJobWithProgress('save_to_flex', preview.previewToken, prog.set);
      prog.close();
      cur.flex.baseRev = r.newBaseRev;
      flexHistory.undo++; updateHistoryButtons();
      H.toast(T('flex.relinked'));
    } catch (e) { prog.close(); fail(e, true); }
  } catch (e) { fail(e); }
}
async function importFlextext() {
  if (!project || !project.writable) return;
  try {
    const pick = await flex.pickFile('flextext');
    if (!pick || !pick.path) return;
    const pv = await flex.importPreview(pick.path);
    const ok = await H.confirmDialog(T('flex.importConfirm', { t: pv.texts, p: pv.paras, n: pv.phrases }) + '\n\n' + pv.warnings.map((w) => T('flex.warn.' + w.code, w)).join('\n'));
    if (!ok) return;
    const prog = progressModal(T('flex.importing'));
    try {
      const r = await flexJobWithProgress('import_flextext', pv.previewToken, prog.set);
      prog.close();
      project.texts = await flex.listTexts();
      renderTexts();
      H.toast(T('flex.imported', { n: r.newTextGuids.length }), 7000);
    } catch (e) { prog.close(); fail(e, true); }
  } catch (e) { fail(e); }
}

/* ---- errors: stable codes → translated messages; a poisoned session says exactly what happened ---- */
function fail(e, afterWrite = false) {
  const code = (e && e.code) || 'E_INTERNAL';
  let msg = T('flex.err.' + code);
  if (msg === 'flex.err.' + code) msg = T('flex.err.E_INTERNAL');
  if (code === 'E_POISONED' && e.detail) {
    msg = T('flex.poisoned', { f: e.detail.failedFile || '', b: e.detail.backup || '' });
  } else if (afterWrite && code !== 'E_POISONED') {
    msg = T('flex.nothingWritten') + ' ' + msg;
  }
  if (e && e.message && code === 'E_INTERNAL') msg += ' (' + e.message + ')';
  H.toast(msg, 12000);
  console.warn('[flex]', code, e);
}
