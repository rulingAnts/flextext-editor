/* flex-panel.js — the FLEx features' UI, loaded ONLY inside the desktop shell (plans/flex-desktop-segmenter.md
 * §1, §3, §4.4, §8.4, §11). app.js imports this module dynamically after native-flex.js's whenFlexReady()
 * answered true, so a browser never loads it and no SHELL list has to carry it.
 *
 * THE SHELL IS THE AUDIO SEGMENTER (Seth, 2026-10-15: "the Audio Segmenter app for audio segmenting/
 * matching is what I want loading in this … app"). A FLEx text opens in the Segmenter's own
 * Matcher, exactly as the Segmenter's list opens a text; nothing here replaces any of its screens. What
 * this module adds:
 *   - on the home view, a FLEx section: choose a project, open it read-only or for writing, its texts.
 *     Each text row opens the text and, when the project is open for writing, carries Save to FLEx…
 *     (the work Done committed here → diff → preview → confirm → job) and Fix FLEx's recording link…;
 *     Export bundle… works read-only. The project row carries Undo / Redo Save to FLEx (the SEPARATE
 *     history, D1) and Import .flextext into FLEx.
 *   - in the Matcher, for a FLEx text, a slim strip: what it is (read-only or not), the text's writing
 *     systems — switched right there, from FLEx's own lists — and Copy line as FLEx Print view for the
 *     selected line.
 *
 * THE RECORDING (§8.4, Seth 2026-10-14: "Most of the recordings found in FLEx text media fields will
 * point to an incorrect path"). Opening a text gets it a recording of ITS OWN in the media store, under
 * the record's id: FLEx's link when it resolves here; else a file the user chose for that link before
 * (no question); else the find-the-recording card — files of that name the shell found, or the native
 * dialog. Nothing is written to FLEx then: `rec.flex.mediaFix` remembers the fix, and the next Save to
 * FLEx (or "Fix FLEx's recording link…") carries it, through the preview, when the project is open for
 * writing. A read-only project is enough to match.
 *
 * Two histories, never interleaved (§4.4): the Matcher's own undo is untouched by anything here, and
 * nothing here ever writes to FLEx except through the shell's Save to FLEx, which the user confirms. */

import { flex, flexCall, flexShellInfo, isFlexShell } from './native-flex.js';
import { diffFlexDoc, postStateOf, flexBlockers, flexDocId, isFlexDocId, isFlexDocOf, reopenDecision, hasLocalWork, keepTimeEstimates, recordingLink, pendingMediaFix } from './flex-ops.js';
import { printViewTsv } from './printview-tsv.js';
import { esc } from './flextext.js';

let H = null;      // hooks from app.js: { db, t, toast, confirmDialog, docStats, getCurrent, openRecord, reopenRecord, matcherEdited,
                  //   forgetRecord, selectedSegGuid, hideFromList, claimLangView, langView, setLangView, fetchMedia }
// project.ws = FLEx's writing systems, { vern: [{ id, name, abbr, isDefault }], anal: [...] } (open_project)
let project = null;   // { name, writable, ws, printViewConfig, texts: [...] } while a project is open in the shell

const $ = (sel, root = document) => root.querySelector(sel);
const clone = (x) => JSON.parse(JSON.stringify(x));
const T = (k, v) => (H && H.t ? H.t(k, v) : k);

export function initFlexPanel(hooks) {
  H = hooks;
  if (!isFlexShell()) return false;
  document.documentElement.classList.add('flex-shell');
  renderHome();
  document.addEventListener('flextext:home-rendered', renderHome);
  document.addEventListener('flextext:list-rendered', () => { if (project) renderTexts(); });   // after Done, a delete…
  document.addEventListener('flextext:matcher-entered', renderMatcherStrip);
  document.addEventListener('flextext:matcher-closed', () => { if (project) renderTexts(); });   // Back: a draft, a recording now here
  // FLEx texts are listed here, under their project; the Segmenter's own list keeps the app's own texts
  if (H.hideFromList) H.hideFromList((d) => isFlexDocId(d.id));
  // …and the Matcher shows a FLEx text in the writing systems chosen for IT (the strip's), never the
  // language this device last picked for some other text
  if (H.claimLangView) H.claimLangView((rec) => !!(rec && rec.flex));
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
      <button id="flex-reset-all" class="link-btn" hidden>${esc(T('flex.resetAll'))}</button>
    </div>
    <p id="flex-reasons" class="flex-reasons" hidden></p>
    <div class="flex-row" id="flex-project-actions" hidden>
      <button id="flex-undo" class="secondary-btn" title="${esc(T('flex.undoTip'))}" disabled>${esc(T('flex.undo'))}</button>
      <button id="flex-redo" class="secondary-btn" disabled>${esc(T('flex.redo'))}</button>
      <button id="flex-import" class="link-btn">${esc(T('flex.import'))}</button>
    </div>
    <ul id="flex-texts" class="doc-list" hidden></ul>`;
  view.insertBefore(box, view.firstChild);
  $('#flex-project', box).addEventListener('change', onProjectPick);
  $('#flex-open-read', box).addEventListener('click', () => openProject('read'));
  $('#flex-open-write', box).addEventListener('click', () => openProject('write'));
  $('#flex-close', box).addEventListener('click', closeProject);
  $('#flex-reset-all', box).addEventListener('click', resetAll);
  $('#flex-undo', box).addEventListener('click', () => undoRedo('undo'));
  $('#flex-redo', box).addEventListener('click', () => undoRedo('redo'));
  $('#flex-import', box).addEventListener('click', importFlextext);
  loadProjects().then(() => { if (project) showOpenProject(); });   // the view was rebuilt while one was open
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
  flexHist.done = []; flexHist.undone = [];
  await showOpenProject();
}
async function showOpenProject() {
  const sel = $('#flex-project');
  if (sel) { sel.value = project.name; sel.disabled = true; }
  $('#flex-close').hidden = false;
  $('#flex-reset-all').hidden = false;   // read-only too: it changes nothing in FLEx
  $('#flex-open-read').disabled = $('#flex-open-write').disabled = true;
  $('#flex-reasons').hidden = true;
  $('#flex-project-actions').hidden = !project.writable;
  updateHistoryButtons();
  await renderTexts();
}
async function closeProject() {
  try { await flex.closeProject(); } catch (e) { fail(e); }
  project = null;
  flexHist.done = []; flexHist.undone = [];
  $('#flex-close').hidden = true;
  $('#flex-reset-all').hidden = true;
  $('#flex-project').disabled = false;
  $('#flex-texts').hidden = true;
  $('#flex-project-actions').hidden = true;
  onProjectPick();
}

/* The text rows: what FLEx's link does here, whether the app has its own recording, whether the work
 * done here is in FLEx yet — and the actions that fit. One read of the library for the whole list; a
 * full record read only for the texts that have one. */
let renderSeq = 0;
async function renderTexts() {
  const ul = $('#flex-texts');
  if (!ul || !project) return;
  const seq = ++renderSeq;
  const proj = project;
  const [have, docs] = await Promise.all([
    H.db.mediaKeys ? H.db.mediaKeys().catch(() => new Set()) : Promise.resolve(new Set()),
    H.db.listDocs().catch(() => []),
  ]);
  const local = new Set(docs.map((d) => d.id));
  const recs = {};
  for (const tx of proj.texts) {
    const id = flexDocId(proj.name, tx.guid);
    if (local.has(id)) recs[tx.guid] = await H.db.getDoc(id).catch(() => null);
  }
  if (seq !== renderSeq || project !== proj) return;   // a newer render, or the project closed meanwhile
  ul.hidden = false;
  ul.innerHTML = '';
  for (const tx of proj.texts) {
    const rec = recs[tx.guid];
    const id = flexDocId(proj.name, tx.guid);
    const todo = rec && rec.flex ? notInFlex(rec) : { save: false, relink: false };
    const media = have.has(id) ? T('flex.media.inApp')
      : !tx.media.length ? T('flex.media.noLinkTag')
      : tx.media.some((m) => m.exists) ? '' : T('flex.mediaMissing');
    const bits = [T('flex.textMeta', { p: tx.paras, s: tx.segs, t: tx.timedSegs }), wsOf(rec) ? wsPair(wsOf(rec)) : '', media,
      rec && rec.matchDraft ? T('sg.inProgress') : '', todo.save || todo.relink ? T('flex.textUnsaved') : ''].filter(Boolean);
    const li = document.createElement('li');
    li.className = 'rec-item';
    li.dataset.textGuid = tx.guid;
    // the Segmenter list's own row structure (sgRenderList), so the app's styles apply
    li.innerHTML = `<div class="rec-item-main"><span class="doc-name"></span>
        <span class="doc-meta">${esc(bits.join(' · '))}</span></div>
      <div class="rec-item-actions">
        ${proj.writable && todo.save ? `<button class="primary-btn flex-save-text">${esc(T('flex.save'))}</button>` : ''}
        ${proj.writable && todo.relink ? `<button class="link-btn flex-fix-link">${esc(T('flex.relink'))}</button>` : ''}
        <button class="link-btn flex-ws-text">${esc(T('flex.ws.button'))}</button>
        ${rec ? `<button class="link-btn flex-reset-text" title="${esc(T('flex.resetTip'))}">${esc(T('flex.reset'))}</button>` : ''}
        ${rec ? `<button class="link-btn flex-export-text">${esc(T('flex.export'))}</button>` : ''}
        <button class="secondary-btn flex-open-text">${esc(T('flex.openText'))}</button>
      </div>`;
    li.querySelector('.doc-name').textContent = tx.title;   // titles reach the UI only, never a log
    li.querySelector('.flex-open-text').addEventListener('click', () => openText(tx));
    const sv = li.querySelector('.flex-save-text');
    if (sv) sv.addEventListener('click', () => saveTextToFlex(tx));
    const fx = li.querySelector('.flex-fix-link');
    if (fx) fx.addEventListener('click', () => fixLink(tx));
    const ex = li.querySelector('.flex-export-text');
    if (ex) ex.addEventListener('click', () => exportBundle(tx));
    li.querySelector('.flex-ws-text').addEventListener('click', () => chooseWs(tx));
    const rs = li.querySelector('.flex-reset-text');
    if (rs) rs.addEventListener('click', () => resetText(tx));
    ul.appendChild(li);
  }
}
/* What FLEx does not have yet of the work COMMITTED here (the Matcher's Done): text or time changes →
 * Save to FLEx…; a recording link that points nowhere → Fix FLEx's recording link…. Judged by the diff
 * Save to FLEx would make, never by timestamps: a Done that changed nothing has nothing to save, and two
 * saves undone and one redone still do. A draft still in the Matcher is not committed, so it is not here
 * (the row says it is in progress); an attach rides only with times (D9), so alone it is not either. */
function notInFlex(rec) {
  let save;
  try {
    const d = diffFlexDoc(rec.flex.base, rec.doc, { ws: rec.doc.analLang });
    save = d.ops.length > 0 || d.unsupported.length > 0;
  } catch { save = true; }   // cannot tell: say the work may not be in FLEx
  return { save, relink: !!pendingMediaFix(rec.flex).relink };
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
  const id = flexDocId(project.name, tx.guid);
  const existing = await H.db.getDoc(id).catch(() => null);
  const local = hasLocalWork(existing);
  // Read in the writing systems chosen for the text. A record with work here is read in the ones that
  // work is in; one with none, made by an older build before there was a choice, is read in the text's
  // own (the shell's default) — the one it is glossed and translated in, which that build never read.
  const ws = existing && existing.flex ? (existing.flex.ws || (local ? wsOf(existing) : null)) : null;
  let opened;
  try { opened = await flex.openText(tx.guid, ws); } catch (e) { fail(e); return; }
  const how = reopenDecision(existing, opened.baseRev, local);
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
  if (existing && existing.doc) keepTimeEstimates(existing.doc, doc);   // FLEx holds times, not which were estimated
  rec.title = doc.title;
  rec.doc = doc;
  rec.modified = now;
  // the record IS FLEx's text again: nothing of its own is pending (`dirty`), whatever it said before
  rec.flex = { ...((existing && existing.flex) || {}), textGuid: tx.guid, baseRev: opened.baseRev, base: clone(doc), project: project.name, loadedAt: now,
    ws: opened.ws || (doc.flex && doc.flex.ws) || null, dirty: false };
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

/* ---- Writing systems, per text (plan §7.4) ---------------------------------------------------------
 * FLEx's own lists (open_project's `ws`), never the device's language settings: in the shell a FLEx
 * text is shown in a vernacular writing system of the project (the words) and ONE analysis writing
 * system (glosses and the free translation the Matcher edits; the others ride along read-only, in its
 * language picker). The choice lives on the text's record (`rec.flex.ws`); a text opens in its own —
 * the vernacular its paragraphs are in, the analysis one it uses most — until someone chooses.
 * Changing it re-reads the text from FLEx in the new writing systems, so it waits until the work done
 * here is in FLEx: work shown in one analysis writing system is never quietly re-shown in another. */
// A record an older build made has no choice stored: its doc is in the ones that build read (FLEx's
// default vernacular and first analysis writing system) and says so itself.
const wsOf = (rec) => {
  if (!rec || !rec.flex) return null;
  if (rec.flex.ws) return rec.flex.ws;
  const d = rec.doc || {};
  return d.vernLang && d.analLang ? { vern: d.vernLang, anal: d.analLang } : null;
};
// The doc carries every analysis writing system, the others read-only (to_engine_doc since the choice
// existed); an older build's carries one.
const layered = (rec) => !!(rec && rec.doc && rec.doc.flex && rec.doc.flex.ws);
const wsList = (kind) => (project && project.ws && project.ws[kind]) || [];
function wsName(id, kind) {
  const w = wsList(kind).find((x) => x.id === id);
  return (w && w.name) || id || '';
}
const wsPair = (ws) => T('flex.ws.pair', { v: wsName(ws.vern, 'vern'), a: wsName(ws.anal, 'anal') });
async function chooseWs(tx) {
  if (busy || !project) return;
  let info;
  try { info = await flex.textWs(tx.guid); } catch (e) { fail(e); return; }
  const id = flexDocId(project.name, tx.guid);
  const rec = await H.db.getDoc(id).catch(() => null);
  const cur = wsOf(rec) || info.default;
  const pick = await wsDialog(tx, info, cur);
  if (!pick) return;
  const same = pick.vern === cur.vern && pick.anal === cur.anal;
  const older = !!(rec && rec.flex && !rec.flex.ws);   // an older build's record: nothing chosen yet
  if (same && !older) return;
  if (hasLocalWork(rec)) {
    // an older record with work in it, kept as it is: what it is in becomes the choice (it re-opens in it
    // once the work is in FLEx, rather than in the text's own)
    if (same) { rec.flex.ws = { vern: pick.vern, anal: pick.anal }; await H.db.putDoc(rec); await renderTexts(); return; }
    H.toast(T('flex.ws.busy'), 10000);
    return;
  }
  busy = true;
  try {
    const opened = await flex.openText(tx.guid, pick);
    const next = fromFlex(rec, id, tx, opened);
    next.flex.writable = project.writable;
    next.flex.linkOk = ((opened.doc.flex && opened.doc.flex.media) || []).some((m) => m.url);
    await H.db.putDoc(next);              // a raw write: a new view of FLEx's text is not an edit
    await renderTexts();
    wsChangedToast(opened);
  } catch (e) { fail(e); } finally { busy = false; }
}
/* → { vern, anal } or null. Each option says how much of this text is in it, and which is its own. */
function wsDialog(tx, info, cur) {
  return new Promise((resolve) => {
    const u = info.usage || { vern: {}, anal: {} }, own = info.default || {};
    // FLEx shows its guesses on words nobody approved; only approved glosses are FLEx's glosses (§7.4)
    const unapproved = (u.words && u.words.unapproved) || 0;
    const verns = wsList('vern').slice();
    for (const w of Object.keys(u.vern || {})) if (!verns.some((x) => x.id === w)) verns.push({ id: w, name: w });   // a paragraph in one FLEx no longer lists
    const label = (w, kind) => {
      const bits = [];
      const count = (n, one, many) => T(n === 1 ? one : many, { n });
      if (kind === 'vern' && (u.vern || {})[w.id]) bits.push(count(u.vern[w.id], 'flex.ws.para1', 'flex.ws.paras'));
      const c = kind === 'anal' && (u.anal || {})[w.id];
      if (c && c.ft) bits.push(count(c.ft, 'flex.ws.ft1', 'flex.ws.ftN'));
      if (c && c.gloss) bits.push(count(c.gloss, 'flex.ws.gl1', 'flex.ws.glN'));
      if (own[kind] === w.id) bits.push(T('flex.ws.own'));
      return (w.name && w.name !== w.id ? w.name + ' (' + w.id + ')' : w.id) + (bits.length ? ' — ' + bits.join(', ') : '');
    };
    const opts = (list, kind) => list.map((w) => `<option value="${esc(w.id)}"${w.id === cur[kind] ? ' selected' : ''}>${esc(label(w, kind))}</option>`).join('');
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.dataset.flexWs = '1';
    wrap.innerHTML = `<div class="modal-card flex-ws-card" role="dialog" aria-modal="true">
      <h3>${esc(T('flex.ws.title'))}</h3>
      <p class="flex-ws-text-title"></p>
      <label class="flex-ws-row">${esc(T('flex.ws.vern'))}<select data-ws="vern">${opts(verns, 'vern')}</select></label>
      <label class="flex-ws-row">${esc(T('flex.ws.anal'))}<select data-ws="anal">${opts(wsList('anal'), 'anal')}</select></label>
      <p class="flex-media-note">${esc(T('flex.ws.note'))}</p>
      ${unapproved ? `<p class="flex-media-note flex-ws-unapproved">${esc(T(unapproved === 1 ? 'flex.ws.unapproved1' : 'flex.ws.unapprovedN', { n: unapproved }))}</p>` : ''}
      <button class="primary-btn" data-ok>${esc(T('flex.ws.apply'))}</button>
      <button class="link-btn" data-cancel>${esc(T('share.cancel'))}</button>
    </div>`;
    wrap.querySelector('.flex-ws-text-title').textContent = tx.title;   // titles reach the UI only
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    const done = (v) => { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(v); };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-ok]').addEventListener('click', () => done({
      vern: wrap.querySelector('[data-ws="vern"]').value, anal: wrap.querySelector('[data-ws="anal"]').value }));
    wrap.querySelector('[data-cancel]').addEventListener('click', () => done(null));
  });
}

/* ---- Reset: this app's copy of a FLEx text, or of every text of the project ---------------------------
 * Seth, 2026-10-15: "I need a way to clear my cached or stale version of a text from FLEx (or reset all)".
 * The text is read fresh from FLEx in its own writing systems, as if it had never been opened here; FLEx
 * itself is not changed, so this works in a read-only session. What goes is said first — work here that
 * FLEx does not have, a matching draft — and Cancel is the default (first, and Escape). The recording
 * stays, with any link fix still waiting for a save, unless the user asks to forget it too: then this
 * app's copy goes (with the WAV made from it and its waveform) and so does the file the shell remembered
 * for FLEx's link, so the next Open finds the recording again, or asks. */
function workLost(rec) {
  if (!rec || !rec.flex) return [];
  const out = [];
  if (rec.matchDraft) out.push(T('flex.reset.whatDraft'));
  if (rec.flex.dirty || notInFlex(rec).save) out.push(T('flex.reset.whatChanges'));
  return out;
}
/* → { media } or null. `title` for one text; `count` and `working` (how many carry work) for all. */
function resetDialog({ title = null, count = 1, lost = [], working = 0 }) {
  return new Promise((resolve) => {
    const one = title != null;
    const warn = one ? (lost.length ? T('flex.reset.loseWork', { what: lost.join(', ') }) : '')
      : (working ? T(working === 1 ? 'flex.reset.loseAll1' : 'flex.reset.loseAllN', { n: working }) : '');
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.dataset.flexReset = '1';
    wrap.innerHTML = `<div class="modal-card flex-ws-card" role="dialog" aria-modal="true">
      <h3>${esc(one ? T('flex.reset.title') : T(count === 1 ? 'flex.reset.titleAll1' : 'flex.reset.titleAllN', { n: count }))}</h3>
      ${one ? '<p class="flex-ws-text-title"></p>' : ''}
      <p>${esc(T(one ? 'flex.reset.body' : 'flex.reset.bodyAll'))}</p>
      ${warn ? `<p class="flex-reset-lose">${esc(warn)}</p>` : ''}
      <label class="flex-reset-media"><input type="checkbox" data-media> <span>${esc(T('flex.reset.media'))}</span></label>
      <div class="flex-row">
        <button class="secondary-btn" data-cancel>${esc(T('share.cancel'))}</button>
        <button class="primary-btn" data-ok>${esc(T('flex.reset.ok'))}</button>
      </div>
    </div>`;
    if (one) wrap.querySelector('.flex-ws-text-title').textContent = title;   // titles reach the UI only
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    const done = (v) => { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(v); };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-ok]').addEventListener('click', () => done({ media: wrap.querySelector('[data-media]').checked }));
    wrap.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    wrap.querySelector('[data-cancel]').focus();
  });
}
/* One text: forgetting the recording, the shell forgets its choice first (a failure there leaves
 * everything as it was); else FLEx's text is read now and replaces the record, keeping only the
 * recording's facts — the copy in the media store under this id is untouched. */
async function resetOne(textGuid, rec, forgetRecording) {
  if (forgetRecording) {
    await flex.forgetMedia(textGuid);
    await H.forgetRecord(rec.id);
    return;
  }
  const opened = await flex.openText(textGuid);   // the text's own writing systems
  const keep = { id: rec.id, created: rec.created, flex: { recording: (rec.flex && rec.flex.recording) || null, mediaFix: (rec.flex && rec.flex.mediaFix) || null } };
  const next = fromFlex(keep, rec.id, { guid: textGuid }, opened);
  next.flex.writable = project.writable;
  next.flex.linkOk = ((opened.doc.flex && opened.doc.flex.media) || []).some((m) => m.url);
  await H.db.putDoc(next);                // a raw write: FLEx's text as it is is not an edit
}
async function resetText(tx) {
  if (busy || opening || !project) return;
  const rec = await H.db.getDoc(flexDocId(project.name, tx.guid)).catch(() => null);
  if (!rec || !rec.flex) return;
  const pick = await resetDialog({ title: tx.title, lost: workLost(rec) });
  if (!pick || !project) return;
  busy = true;
  try {
    await resetOne(tx.guid, rec, pick.media);
    H.toast(T(pick.media ? 'flex.reset.doneMedia' : 'flex.reset.done'), 7000);
  } catch (e) { fail(e); } finally { busy = false; }
  await renderTexts();
}
/* Every local record of THIS project's texts (isFlexDocOf — a copy of the project keeps its own). A
 * record of a text no longer in the project has nothing to be read back from: it goes whole. */
async function resetAll() {
  if (busy || opening || !project) return;
  const proj = project;
  const docs = await H.db.listDocs().catch(() => []);
  const recs = [];
  for (const d of docs) {
    if (!isFlexDocOf(d.id, proj.name)) continue;
    const r = await H.db.getDoc(d.id).catch(() => null);
    if (r && r.flex) recs.push(r);
  }
  if (!recs.length) { H.toast(T('flex.reset.nothing'), 6000); return; }
  const pick = await resetDialog({ count: recs.length, working: recs.filter((r) => hasLocalWork(r)).length });
  if (!pick || project !== proj) return;
  busy = true;
  const prog = progressModal(T('flex.reset.running'));
  const live = new Set(proj.texts.map((tx) => tx.guid));
  let n = 0;
  try {
    for (const r of recs) {
      prog.set(T('flex.reset.progress', { i: n + 1, n: recs.length }));
      const g = r.flex.textGuid;
      if (!g || !live.has(g)) await H.forgetRecord(r.id);
      else await resetOne(g, r, pick.media);
      n++;
    }
  } catch (e) { fail(e); } finally { prog.close(); busy = false; }
  await renderTexts();
  if (n) H.toast(T(n === 1 ? 'flex.reset.doneAll1' : 'flex.reset.doneAllN', { n }), 7000);
}

/* ---- the Matcher strip -------------------------------------------------------------------------- */
/* The text's writing systems, switched where the work is (Seth, 2026-10-15: "I'd like to be able to switch
 * on the fly within the text I'm working on"): FLEx's own lists, on EVERY FLEx text. (The Matcher's own
 * language picker appeared only on a text that happened to carry two analysis languages, and only knew the
 * ones in it — "showing on some texts and not others" — so for a FLEx text this strip replaces it.)
 * Choosing one re-reads the text from FLEx in it and opens it again in place: glosses and the free
 * translation are then edited in the one shown. Work here that FLEx does not have yet would be lost by a
 * re-read, so then nothing is read: another analysis writing system is SHOWN, read-only, as FLEx has it,
 * and the words wait for a save. "All languages" stacks the others under the one edited — a view only. */
function renderMatcherStrip() {
  const view = $('#view-matcher');
  const bar = view && $('.mg-bar', view);
  const old = $('#flex-mg-strip');
  if (old) old.remove();
  const cur = H.getCurrent();
  if (!bar || !cur || !cur.flex) return;
  const ws = wsOf(cur) || {};
  const shown = (H.langView && H.langView()) || 'primary';
  const listed = (kind, id) => {
    const list = wsList(kind).slice();
    if (id && !list.some((w) => w.id === id)) list.push({ id, name: id });   // one FLEx no longer lists
    return list;
  };
  const anals = listed('anal', ws.anal);
  const pick = (kind, list, sel, extra = '') => `<select id="flex-ws-${kind}" class="flex-ws-select">${list.map((w) =>
    `<option value="${esc(w.id)}"${w.id === sel ? ' selected' : ''}>${esc(w.name || w.id)}</option>`).join('')}${extra}</select>`;
  const all = anals.length > 1 ? `<option value="all"${shown === 'all' ? ' selected' : ''}>${esc(T('mg.langAll'))}</option>` : '';
  const other = shown !== 'primary' && shown !== 'all';   // another analysis writing system, shown read-only
  const row = document.createElement('div');
  row.id = 'flex-mg-strip';
  row.className = 'flex-mg-strip';
  row.innerHTML = `
    <span class="flex-badge">${esc(T('flex.badge'))}${cur.flex.writable ? '' : ' · ' + esc(T('flex.readOnlyTag'))}</span>
    <label class="flex-ws-field">${esc(T('flex.ws.words'))} ${pick('vern', listed('vern', ws.vern), ws.vern)}</label>
    <label class="flex-ws-field">${esc(T('flex.ws.glosses'))} ${pick('anal', anals, other ? shown : ws.anal, all)}</label>
    ${other ? `<span class="flex-ws-ro" title="${esc(T('flex.ws.viewOnly', { a: wsName(shown, 'anal'), e: wsName(ws.anal, 'anal') }))}">${esc(T('flex.readOnlyTag'))}</span>` : ''}
    <button id="flex-copy" class="link-btn">${esc(T('flex.copyLine'))}</button>`;
  bar.insertAdjacentElement('afterend', row);
  $('#flex-copy', row).addEventListener('click', copyLine);
  $('#flex-ws-vern', row).addEventListener('change', (e) => switchWs('vern', e.target.value));
  $('#flex-ws-anal', row).addEventListener('change', (e) => switchWs('anal', e.target.value));
}
async function switchWs(kind, value) {
  const cur = H.getCurrent();
  if (!cur || !cur.flex || !project || busy) { renderMatcherStrip(); return; }
  const rec = await H.db.getDoc(cur.id).catch(() => null);
  const ws = wsOf(rec);
  if (!rec || !ws) { renderMatcherStrip(); return; }
  if (kind === 'anal' && (value === 'all' || value === ws.anal)) { H.setLangView(value === 'all' ? 'all' : 'primary'); renderMatcherStrip(); return; }
  if (kind === 'vern' && value === ws.vern) return;
  if (H.matcherEdited() || hasLocalWork(rec)) {
    if (kind === 'anal' && layered(rec)) {
      H.setLangView(value);
      renderMatcherStrip();
      H.toast(T('flex.ws.viewOnly', { a: wsName(value, 'anal'), e: wsName(ws.anal, 'anal') }), 10000);
    } else {
      renderMatcherStrip();   // back to what is shown
      H.toast(T('flex.ws.busyHere'), 10000);
    }
    return;
  }
  busy = true;
  try {
    const opened = await flex.openText(rec.flex.textGuid, { ...ws, [kind]: value });
    // an edit made, or a text opened, while FLEx was being read wins: nothing is replaced under it
    const again = await H.db.getDoc(rec.id).catch(() => null);
    const still = H.getCurrent();
    if (!again || !still || still.id !== rec.id || H.matcherEdited() || hasLocalWork(again)) { renderMatcherStrip(); return; }
    const next = fromFlex(again, rec.id, { guid: rec.flex.textGuid }, opened);
    next.flex.writable = project.writable;
    next.flex.linkOk = ((opened.doc.flex && opened.doc.flex.media) || []).some((m) => m.url);
    await H.db.putDoc(next);              // a raw write: a new view of FLEx's text is not an edit
    await H.reopenRecord(rec.id);
    wsChangedToast(opened);
  } catch (e) { fail(e); renderMatcherStrip(); } finally { busy = false; }
}
// Words shown in a vernacular writing system the text is not written in are FLEx's alternatives for
// them: they show, and the shell refuses to save a change to them (E_WS_WORDS) — so say so up front.
function wsChangedToast(opened) {
  const own = opened.wsDefault && opened.wsDefault.vern;
  const note = own && opened.ws.vern !== own ? '\n' + T('flex.ws.vernNote', { v: wsName(opened.ws.vern, 'vern'), own: wsName(own, 'vern') }) : '';
  H.toast(T('flex.ws.changed', { p: wsPair(opened.ws) }) + note, note ? 9000 : 5000);
}

/* ---- Save to FLEx, from a text row (§11) ------------------------------------------------------------
 * The Matcher's Done commits the work to the local record and returns here; Save to FLEx then diffs
 * that record against the FLEx base it was loaded from. The shell must know the text (open_text), and
 * FLEx must still be at that base — else the protocol refuses with E_STALE_BASE anyway. */
let busy = false;
async function saveTextToFlex(tx) {
  if (busy || !project || !project.writable) return;
  busy = true;
  try { await saveTextNow(tx); } finally { busy = false; }
}
async function saveTextNow(tx) {
  const id = flexDocId(project.name, tx.guid);
  const rec = await H.db.getDoc(id).catch(() => null);
  if (!rec || !rec.flex) return;
  let opened;
  try { opened = await flex.openText(tx.guid, wsOf(rec)); } catch (e) { fail(e); return; }
  if (opened.baseRev !== rec.flex.baseRev) { fail({ code: 'E_STALE_BASE' }); return; }
  const base = rec.flex.base;
  // a recording this app found for a link that points nowhere rides along, shown in the preview (§8.4)
  const diff = diffFlexDoc(base, rec.doc, { ws: rec.doc.analLang, ...pendingMediaFix(rec.flex) });
  const blockers = flexBlockers(rec.doc, diff.touched).filter((b) => b.blocking);
  if (!diff.ops.length && !diff.unsupported.length) { H.toast(T('flex.nothingToSave')); return; }
  if (diff.unsupported.length) {
    const why = [...new Set(diff.unsupported.map((u) => T('flex.unsupported.' + u.why)))].join('\n');
    H.toast(T('flex.cannotDiff') + '\n' + why, 9000);
    return;
  }
  let preview;
  try {
    preview = await flex.previewSave(tx.guid, rec.flex.baseRev, diff.ops, postStateOf(rec.doc, diff.touched, base));
  } catch (e) { fail(e); return; }
  if (!await showPreview(preview, blockers, flexBlockers(rec.doc, diff.touched).filter((b) => !b.blocking))) return;
  const prog = progressModal(T('flex.saving'));
  try {
    const r = await flexJobWithProgress('save_to_flex', preview.previewToken, prog.set);
    prog.close();
    // the base is now what we wrote; new phrases take LCM's guids so later diffs key right
    applyAliases(rec.doc, r.alias || {});
    if (diff.ops.some((o) => o.op === 'media.relink' || o.op === 'media.attach')) { rec.flex.mediaFix = null; rec.flex.linkOk = true; }
    await refreshMediaList(rec, tx.guid);
    markInFlex(rec, r.newBaseRev);
    await H.db.putDoc(rec);
    flexHist.done.push({ textGuid: tx.guid, id }); flexHist.undone = [];
    updateHistoryButtons();
    project.texts = await flex.listTexts().catch(() => project.texts);
    await renderTexts();
    H.toast(T('flex.saved', { n: r.saved, b: (r.backup && r.backup.path || '').split(/[\\/]/).pop() }), 7000);
  } catch (e) {
    prog.close();
    fail(e, true);
  }
}
/* FLEx's media list for the text as it is now (a relink changes the path inside a media object, an
 * attach adds one) — the doc and its base keep what they hold otherwise. */
async function refreshMediaList(rec, textGuid) {
  try {
    const re = await flex.openText(textGuid, wsOf(rec));
    const f = (re.doc && re.doc.flex) || {};
    for (const d of [rec.doc, rec.flex.base]) {
      if (d) d.flex = { ...(d.flex || {}), media: clone(f.media || []), mediaContainer: f.mediaContainer || null };
    }
    rec.flex.linkOk = (f.media || []).some((m) => m.url);
  } catch { /* the save itself succeeded; the list refreshes on the next open */ }
}
/* After a write to FLEx the local record IS FLEx's text again: base = the doc, and no work pending. */
function markInFlex(rec, baseRev) {
  const now = Date.now();
  rec.flex.base = clone(rec.doc);
  rec.flex.baseRev = baseRev;
  rec.flex.dirty = false;
  rec.modified = now;
  rec.flex.loadedAt = now;
}

/* ---- Fix FLEx's recording link, from a text row: the file this app already uses ---------------- */
async function fixLink(tx) {
  if (busy || !project || !project.writable) return;
  busy = true;
  try { await fixLinkNow(tx); } finally { busy = false; }
}
async function fixLinkNow(tx) {
  const id = flexDocId(project.name, tx.guid);
  const rec = await H.db.getDoc(id).catch(() => null);
  const fix = rec && rec.flex && pendingMediaFix(rec.flex).relink;
  if (!fix) return;
  try {
    // A relink changes the path inside FLEx's media object, which no phrase fingerprint covers: the
    // base revision stays what it was, and work done here stays exactly as unsaved as it was.
    await flex.openText(tx.guid, wsOf(rec));   // the shell's session must know the text for the preview
    const preview = await flex.relinkPreview(tx.guid, fix.uriGuid, fix.path);
    if (!await showPreview(preview, [], [])) return;
    const prog = progressModal(T('flex.saving'));
    try {
      const r = await flexJobWithProgress('save_to_flex', preview.previewToken, prog.set);
      prog.close();
      rec.flex.mediaFix = null;
      rec.flex.linkOk = true;
      await refreshMediaList(rec, tx.guid);
      await H.db.putDoc(rec);
      flexHist.done.push({ textGuid: tx.guid, id }); flexHist.undone = [];
      updateHistoryButtons();
      project.texts = await flex.listTexts().catch(() => project.texts);
      await renderTexts();
      H.toast(T('flex.relinked'));
    } catch (e) { prog.close(); fail(e, true); }
  } catch (e) { fail(e); }
}

/* ---- Undo / Redo Save to FLEx (§4.4): FLEx goes back; the work done here stays, unsaved -------------- */
const flexHist = { done: [], undone: [] };   // [{ textGuid, id }] — FLEx's own history for this project session
function updateHistoryButtons() {
  const u = $('#flex-undo'), r = $('#flex-redo');
  if (u) u.disabled = !flexHist.done.length;
  if (r) r.disabled = !flexHist.undone.length;
}
async function undoRedo(which) {
  if (busy || !project) return;
  const from = which === 'undo' ? flexHist.done : flexHist.undone;
  const item = from[from.length - 1];
  if (!item) return;
  busy = true;
  const prog = progressModal(T(which === 'undo' ? 'flex.undoing' : 'flex.redoing'));
  try {
    const r = await flexJobWithProgress(which === 'undo' ? 'undo_flex' : 'redo_flex', undefined, prog.set);
    prog.close();
    from.pop();
    (which === 'undo' ? flexHist.undone : flexHist.done).push(item);
    const rec = await H.db.getDoc(item.id).catch(() => null);
    if (rec && rec.flex) {
      const re = await flex.openText(item.textGuid, wsOf(rec));
      rec.flex.base = clone(re.doc);
      rec.flex.baseRev = re.baseRev;
      const f = re.doc.flex || {};
      rec.doc.flex = { ...(rec.doc.flex || {}), media: clone(f.media || []), mediaContainer: f.mediaContainer || null };
      rec.flex.linkOk = (f.media || []).some((m) => m.url);
      // an undone relink or attach: FLEx's link points nowhere again, so the fix is pending again
      const rc = rec.flex.recording;
      if (rec.flex.linkOk) rec.flex.mediaFix = null;
      else if (rc && rc.path && rc.source !== 'flex') rec.flex.mediaFix = { uriGuid: rc.uriGuid || null, path: rc.path };
      // Is the work done here in FLEx now? The diff, not which button was pressed: two saves undone and
      // one redone leaves work FLEx does not have. (`dirty` keeps a re-open from replacing it.)
      rec.flex.dirty = notInFlex(rec).save;
      await H.db.putDoc(rec);
    }
    updateHistoryButtons();
    project.texts = await flex.listTexts().catch(() => project.texts);
    await renderTexts();
    H.toast(T(which === 'undo' ? 'flex.undone' : 'flex.redone', { l: r.label }), 6000);
  } catch (e) { prog.close(); fail(e, true); }
  finally { busy = false; }
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
    case 'word.join': return T('flex.sum.wordJoin', { a: s.words[0], b: s.words[1], w: s.into });
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
  const r = arg === undefined ? await flexCall(method) : await flexCall(method, arg);
  if (!r || !r.jobId) return r;
  for (;;) {
    const st = await flexCall('job_status', r.jobId);
    if (onProgress) onProgress(st.progress);
    if (st.state === 'done') return st.result;
    if (st.state === 'error') { const e = new Error(st.error.message || st.error.code); e.code = st.error.code; e.detail = st.error.detail; throw e; }
    await new Promise((res) => setTimeout(res, 150));
  }
}

/* ---- Copy this line as FLEx Print view (§10): the Matcher's selected line --------------------------- */
async function copyLine() {
  const segGuid = H.selectedSegGuid ? H.selectedSegGuid() : null;
  if (!segGuid) { H.toast(T('flex.copyNoLine')); return; }
  try {
    const data = await flex.printviewData(segGuid);
    const tsv = printViewTsv(data, { lines: project && project.printViewConfig ? project.printViewConfig.lines : undefined });
    await flex.copyText(tsv);
    H.toast(T('flex.copied'));
  } catch (e) { fail(e); }
}

/* ---- Export / import ----------------------------------------------------------------------------- */
async function exportBundle(tx) {
  const prog = progressModal(T('flex.exporting'));
  try {
    const r = await flexJobWithProgress('export_editor_bundle', tx.guid, prog.set);
    prog.close();
    H.toast(T('flex.exported', { p: r.zipPath }), 9000);
  } catch (e) { prog.close(); fail(e); }
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
  let msg = T('flex.err.' + code, (e && e.detail) || undefined);
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
