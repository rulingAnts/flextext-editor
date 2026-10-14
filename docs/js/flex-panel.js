/* flex-panel.js — the FLEx features' UI, loaded ONLY inside the desktop shell (plans/flex-desktop-segmenter.md
 * §1, §3, §4.4, §11). app.js imports this module dynamically after native-flex.js's whenFlexReady()
 * answered true, so a browser never loads it and no SHELL list has to carry it.
 *
 * What it adds to the Audio Segmenter: a FLEx section on the home view (choose a project, open it read-
 * only or for writing, open one of its texts as a local record whose `flex` field keeps the FROZEN base
 * doc and baseRev), and on an open FLEx-bound text the FLEx row: Save to FLEx… (diff → preview → confirm
 * → job with progress), Undo / Redo Save to FLEx (the SEPARATE history, D1), Copy this line as FLEx Print
 * view, Export bundle, Fix FLEx's recording link, Import .flextext into FLEx.
 *
 * THE RECORDING (§8.4, Seth 2026-10-14: "Most of the recordings found in FLEx text media fields will
 * point to an incorrect path"). Opening a text gets it a recording of ITS OWN in the media store, under
 * the record's id: FLEx's link when it resolves here; else a file the user chose for that link before
 * (no question); else the find-the-recording card — files of that name the shell found, or the native
 * dialog. Nothing is written to FLEx then: `rec.flex.mediaFix` remembers the fix, and the next Save to
 * FLEx (or "Fix FLEx's recording link…") carries it, through the preview, when the project is open for
 * writing. A read-only project is enough to cut.
 *
 * Two histories, never interleaved (§4.4): the editor's Ctrl+Z ring is untouched by anything here, and
 * nothing here ever writes to FLEx except through the shell's Save to FLEx, which the user confirms. */

import { flex, flexShellInfo, isFlexShell } from './native-flex.js';
import { diffFlexDoc, postStateOf, flexBlockers, flexDocId, reopenDecision, recordingLink, pendingMediaFix } from './flex-ops.js';
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
  await renderTexts();
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
async function renderTexts() {
  const ul = $('#flex-texts');
  if (!ul || !project) return;
  // which texts already have a recording in this app: one read for the whole list
  const have = H.db.mediaKeys ? await H.db.mediaKeys().catch(() => new Set()) : new Set();
  ul.hidden = false;
  ul.innerHTML = '';
  for (const tx of project.texts) {
    const li = document.createElement('li');
    li.className = 'rec-item';
    li.dataset.textGuid = tx.guid;
    const status = have.has(flexDocId(project.name, tx.guid)) ? T('flex.media.inApp')
      : !tx.media.length ? T('flex.media.noLinkTag')
      : tx.media.some((m) => m.exists) ? '' : T('flex.mediaMissing');
    // the Segmenter list's own row structure (sgRenderList), so the app's styles apply
    li.innerHTML = `<div class="rec-item-main"><span class="doc-name"></span>
        <span class="doc-meta">${esc(T('flex.textMeta', { p: tx.paras, s: tx.segs, t: tx.timedSegs }))}${status ? ' · ' + esc(status) : ''}</span></div>
      <div class="rec-item-actions"><button class="secondary-btn flex-open-text">${esc(T('flex.openText'))}</button></div>`;
    li.querySelector('.doc-name').textContent = tx.title;   // titles reach the UI only, never a log
    li.querySelector('.flex-open-text').addEventListener('click', () => openText(tx));
    ul.appendChild(li);
  }
}

/* A FLEx text becomes a local record, id flexDocId(project, text) — never with a colon, or the media
 * store would not count its recording. `rec.flex` = { textGuid, baseRev, base (frozen doc), project,
 * writable, loadedAt, linkOk, recording, mediaFix }. Re-opening NEVER discards local work silently
 * (reopenDecision): FLEx unchanged → the local record opens as it is; FLEx changed and nothing done
 * here → FLEx's version loads; both changed → the user decides, and the safe answer keeps the work. */
let opening = false;
async function openText(tx) {
  if (opening) return;
  opening = true;
  try { await openTextNow(tx); } finally { opening = false; }
}
async function openTextNow(tx) {
  let opened;
  try { opened = await flex.openText(tx.guid); } catch (e) { fail(e); return; }
  const id = flexDocId(project.name, tx.guid);
  const existing = await H.db.getDoc(id).catch(() => null);
  const how = reopenDecision(existing, opened.baseRev);
  let rec;
  if (how === 'ask') {
    // the destructive answer is the one Escape and a click outside never give
    const load = await H.confirmDialog(T('flex.reopen.conflict'), { ok: T('flex.reopen.loadFlex'), cancel: T('flex.reopen.keep'), cancelFirst: true });
    rec = load ? fromFlex(existing, id, tx, opened) : existing;
  } else {
    rec = how === 'keep' ? existing : fromFlex(existing, id, tx, opened);
  }
  const links = (opened.doc.flex && opened.doc.flex.media) || [];
  rec.flex.writable = project.writable;
  rec.flex.linkOk = links.some((m) => m.url);
  // the recording: this app's own copy if it has one; else FLEx's link, a remembered choice, or the user
  const have = await H.db.getMedia(id).catch(() => null);
  if (!have) {
    const got = await obtainRecording(id, tx, links);
    if (!got) return;                      // "Not now": nothing stored, nothing opened
    rec.flex.recording = got.recording;
    rec.flex.mediaFix = got.fix;
  }
  await H.db.putDoc(rec);                  // a raw write: opening is not an edit
  await H.openRecord(id);
}
function fromFlex(existing, id, tx, opened) {
  const doc = opened.doc;
  const now = Date.now();
  const rec = existing ? { ...existing } : { id, created: now };
  delete rec.matchDraft;                   // a draft against the text being replaced does not carry over
  rec.title = doc.title;
  rec.doc = doc;
  rec.modified = now;
  rec.flex = { ...((existing && existing.flex) || {}), textGuid: tx.guid, baseRev: opened.baseRev, base: clone(doc), project: project.name, loadedAt: now };
  Object.assign(rec, H.docStats(doc));
  return rec;
}

/* ---- the recording (§8.4) ------------------------------------------------------------------------- */
const baseName = (s) => String(s || '').split(/[\\/]/).filter(Boolean).pop() || '';
const stemOf = (n) => baseName(n).replace(/\.[^.]*$/, '').toLowerCase();
const sizeText = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
function adopted(u, link, source) {
  return { recording: { source, name: u.name, path: u.path, uriGuid: link ? link.uriGuid : null },
           fix: { uriGuid: link ? link.uriGuid : null, path: u.path } };
}
/* Copy a served file into the media store under the record's id. → true when it landed. */
async function cacheRecording(id, url, name) {
  const prog = progressModal(T('flex.media.copying'));
  try { await H.fetchMedia(id, url, name); return true; }
  catch (e) { H.toast(T('flex.mediaLoadFailed'), 9000); console.warn('[flex] recording copy failed', e && e.message); return false; }
  finally { prog.close(); }
}
/* → { recording, fix } once the record has a recording of its own, or null ("Not now"). */
async function obtainRecording(id, tx, links) {
  const link = recordingLink(links);
  if (link && link.url) {                  // FLEx's own link resolves on this machine
    const name = baseName(link.uri);
    return (await cacheRecording(id, link.url, name)) ? { recording: { source: 'flex', name, uriGuid: link.uriGuid }, fix: null } : null;
  }
  let found;
  try { found = await flex.findMedia(tx.guid); } catch (e) { fail(e); return null; }
  const all = found.links || [];
  const fl = (link && all.find((l) => l.uriGuid === link.uriGuid)) || all[0] || null;
  if (fl && fl.url) {                      // it resolved after all (the file came back since list_texts)
    return (await cacheRecording(id, fl.url, fl.name)) ? { recording: { source: 'flex', name: fl.name, uriGuid: fl.uriGuid }, fix: null } : null;
  }
  const before = fl && (fl.candidates || []).find((c) => c.remembered);
  if (before) {                            // the user chose this file for this link before: no question
    try {
      const u = await flex.useMedia(tx.guid, fl.uriGuid, before.path);
      if (await cacheRecording(id, u.url, u.name)) { H.toast(T('flex.media.usingRemembered', { n: u.name }), 6000); return adopted(u, fl, 'remembered'); }
    } catch (e) { fail(e); }
  }
  return mediaCard(id, tx, fl, all.length);
}
/* The find-the-recording card: candidates the shell found, Choose the recording…, Not now. */
function mediaCard(id, tx, fl, linkCount) {
  return new Promise((resolve) => {
    const cands = (fl && fl.candidates) || [];
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.dataset.flexMedia = '1';
    wrap.innerHTML = `<div class="modal-card flex-media-card" role="dialog" aria-modal="true">
      <h3>${esc(T('flex.media.title'))}</h3>
      <p class="flex-media-why"></p>
      ${linkCount > 1 ? '<p class="flex-media-more">' + esc(T('flex.media.more', { k: linkCount })) + '</p>' : ''}
      ${cands.length ? '<p>' + esc(T('flex.media.found')) + '</p><ul class="flex-media-cands">' + cands.map((c, i) =>
        '<li><span class="flex-media-name"></span><small class="flex-media-where"></small><button class="primary-btn" data-use="' + i + '">' + esc(T('flex.media.use')) + '</button></li>').join('') + '</ul>' : ''}
      <p class="flex-media-note">${esc(T('flex.media.note'))}</p>
      <button class="${cands.length ? 'secondary-btn' : 'primary-btn'}" data-choose>${esc(T('flex.media.choose'))}</button>
      <button class="link-btn" data-cancel>${esc(T('flex.media.notNow'))}</button>
    </div>`;
    // file names and folders are this machine's paths: set as text, shown in the UI only
    wrap.querySelector('.flex-media-why').textContent = fl ? T('flex.media.missing', { n: fl.name || fl.link || '' }) : T('flex.media.noLink');
    wrap.querySelectorAll('.flex-media-cands li').forEach((li, i) => {
      const c = cands[i];
      li.querySelector('.flex-media-name').textContent = c.name + (c.remembered ? ' · ' + T('flex.media.remembered') : '');
      li.querySelector('.flex-media-where').textContent = c.folder + ' · ' + sizeText(c.size);
    });
    document.body.appendChild(wrap);
    let busy = false;
    const onKey = (e) => { if (e.key === 'Escape' && !busy && !document.querySelector('[data-confirm-dialog]')) { e.preventDefault(); done(null); } };
    const done = (v) => { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(v); };
    document.addEventListener('keydown', onKey, true);
    const settle = async (pick, source) => {
      if (busy) return;
      busy = true;
      try {
        const path = await pick();
        if (path) {
          const u = await flex.useMedia(tx.guid, fl ? fl.uriGuid : null, path);
          if (await cacheRecording(id, u.url, u.name)) { H.toast(T('flex.media.cached', { n: u.name }), 6000); done(adopted(u, fl, source)); return; }
        }
      } catch (e) { fail(e); }
      busy = false;                        // a cancelled dialog or a failure: the card stays
    };
    wrap.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', () => {
      const c = cands[Number(b.dataset.use)];
      settle(async () => c.path, c.remembered ? 'remembered' : 'found');
    }));
    wrap.querySelector('[data-choose]').addEventListener('click', () => settle(async () => {
      for (;;) {
        const p = await flex.chooseMedia(tx.guid, fl ? fl.uriGuid : null);
        if (!p || !p.path) return null;
        if (!fl || !fl.name || stemOf(p.name) === stemOf(fl.name)) return p.path;   // same recording, maybe converted
        const yes = await H.confirmDialog(T('flex.media.differs', { a: p.name, b: fl.name }), { ok: T('flex.media.useAnyway'), cancel: T('flex.media.chooseAgain') });
        if (yes) return p.path;
      }
    }, 'chosen'));
    wrap.querySelector('[data-cancel]').addEventListener('click', () => { if (!busy) done(null); });
  });
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
    <button id="flex-save" class="primary-btn" ${cur.flex.writable ? '' : 'hidden'}>${esc(T('flex.save'))}</button>
    <button id="flex-undo" class="secondary-btn" title="${esc(T('flex.undoTip'))}" disabled ${cur.flex.writable ? '' : 'hidden'}>${esc(T('flex.undo'))}</button>
    <button id="flex-redo" class="secondary-btn" disabled ${cur.flex.writable ? '' : 'hidden'}>${esc(T('flex.redo'))}</button>
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
  const links = (cur.doc.flex && cur.doc.flex.media) || [];
  if (links.length && cur.flex.writable && !cur.flex.linkOk) $('#flex-relink', row).hidden = false;
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
  // a recording this app found for a link that points nowhere rides along, shown in the preview (§8.4)
  const diff = diffFlexDoc(base, cur.doc, { ws: cur.doc.analLang, ...pendingMediaFix(cur.flex) });
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
    if (diff.ops.some((o) => o.op === 'media.relink' || o.op === 'media.attach')) { cur.flex.mediaFix = null; cur.flex.linkOk = true; }
    flexHistory.undo++; flexHistory.redo = 0;
    updateHistoryButtons();
    await persistInSync(cur);
    H.toast(T('flex.saved', { n: r.saved, b: (r.backup && r.backup.path || '').split(/[\\/]/).pop() }), 7000);
  } catch (e) {
    prog.close();
    fail(e, true);
  }
}
/* After a write to FLEx the local record IS FLEx's text again: persist (which stamps an edit), then
 * mark it loaded at that stamp so a later re-open does not mistake the save for local work. */
async function persistInSync(cur) {
  if (H.persist) await H.persist();
  cur.flex.loadedAt = Number(cur.modified) || Date.now();
  await H.db.putDoc(cur);
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
    cur.flex.linkOk = ((reopened.doc.flex && reopened.doc.flex.media) || []).some((m) => m.url);
    if (which === 'undo') { flexHistory.undo--; flexHistory.redo++; } else { flexHistory.undo++; flexHistory.redo--; }
    updateHistoryButtons();
    await persistInSync(cur);
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
  if (!cur || !cur.flex) return;
  const link = recordingLink(cur.doc.flex && cur.doc.flex.media);
  if (!link) return;
  try {
    // the file this app already uses for this link; the dialog only when it has none
    const fix = pendingMediaFix(cur.flex).relink;
    let path = fix && fix.uriGuid === link.uriGuid ? fix.path : null;
    if (!path) {
      const p = await flex.chooseMedia(cur.flex.textGuid, link.uriGuid);
      if (!p || !p.path) return;
      path = p.path;
    }
    const preview = await flex.relinkPreview(cur.flex.textGuid, link.uriGuid, path);
    if (!await showPreview(preview, [], [])) return;
    const prog = progressModal(T('flex.saving'));
    try {
      const r = await flexJobWithProgress('save_to_flex', preview.previewToken, prog.set);
      prog.close();
      cur.flex.baseRev = r.newBaseRev;
      cur.flex.mediaFix = null;
      cur.flex.linkOk = true;
      flexHistory.undo++; updateHistoryButtons();
      await H.db.putDoc(cur);
      const btn = $('#flex-relink');
      if (btn) btn.hidden = true;
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
      await renderTexts();
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
