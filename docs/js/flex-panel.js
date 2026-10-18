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
import { diffFlexDoc, postStateOf, flexBlockers, flexDocId, isFlexDocId, isFlexDocOf, reopenDecision, hasLocalWork, keepTimeEstimates, mergeFlexDocs, arrangeTexts, recordingLink, pendingMediaFix, flexFailText, flexClosedBy, stripFlexPadding, graftFlexGuesses, adoptFlexGuesses } from './flex-ops.js';
import { printViewTsv } from './printview-tsv.js';
import { esc } from './flextext.js';

let H = null;      // hooks from app.js: { db, t, toast, confirmDialog, docStats, busyScrim, getCurrent, openRecord, reopenRecord,
                  //   matcherEdited, forgetRecord, selectedSegGuid, hideFromList, exportRecord, claimLangView, langView, setLangView, fetchMedia }
// project.ws = FLEx's writing systems, { vern: [{ id, name, abbr, isDefault }], anal: [...] } (open_project)
let project = null;   // { name, writable, ws, printViewConfig, texts: [...] } while a project is open in the shell

const $ = (sel, root = document) => root.querySelector(sel);
const clone = (x) => JSON.parse(JSON.stringify(x));
const T = (k, v) => (H && H.t ? H.t(k, v) : k);

/* "Working…" while FLEx is read or written (Seth, 2026-10-16: "We do need a loading spinner instead of
 * just an app that looks like it's frozen after 'open' is clicked"). LCM reads a whole project, or a
 * text, in seconds on a real machine, and the page waited with no sign of life. This is the app's own
 * loading scrim (app.js busyScrim: a spinner and what is happening, the page held so a second click
 * cannot start a second open), up within a frame of the click. It comes DOWN before anything asks the
 * user a question — a dialog never opens over "Opening…" — and goes up again for the next wait.
 * → a stopper, safe to call more than once. */
function working(label) {
  let off = H && H.busyScrim ? H.busyScrim(label) : null;
  return () => { if (off) { off(); off = null; } };
}

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
  // language this device last picked for some other text — every one of them editable
  if (H.claimLangView) H.claimLangView((rec) => (rec && rec.flex ? langViewOf(rec) : false));
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
    <div class="flex-row">
      <button id="flex-make-copy" class="secondary-btn" hidden>${esc(T('flex.copy.make'))}</button>
      <button id="flex-recover" class="secondary-btn" hidden title="${esc(T('flex.recover.title'))}">${esc(T('flex.recover'))}</button>
    </div>
    <div class="flex-row" id="flex-project-actions" hidden>
      <button id="flex-undo" class="secondary-btn" title="${esc(T('flex.undoTip'))}" disabled>${esc(T('flex.undo'))}</button>
      <button id="flex-redo" class="secondary-btn" disabled>${esc(T('flex.redo'))}</button>
      <button id="flex-import" class="link-btn">${esc(T('flex.import'))}</button>
    </div>
    <div id="flex-list-tools" class="flex-list-tools" hidden>
      <label class="flex-tool">${esc(T('flex.list.sort'))} <select id="flex-sort">
        ${[['title', 'flex.list.byTitle'], ['pending', 'flex.list.byPending'], ['opened', 'flex.list.byOpened'], ['changed', 'flex.list.byChanged'],
           ['created', 'flex.list.byCreated'], ['timed', 'flex.list.byTimed']]
          .map(([v, k]) => `<option value="${v}">${esc(T(k))}</option>`).join('')}
      </select></label>
      <button id="flex-sort-rev" class="link-btn flex-sort-rev" aria-pressed="false" title="${esc(T('flex.list.reverse'))}" aria-label="${esc(T('flex.list.reverse'))}">⇅</button>
      <label class="flex-tool">${esc(T('flex.list.genre'))} <select id="flex-genre"></select></label>
      <input id="flex-q" class="flex-q" type="search" placeholder="${esc(T('flex.list.search'))}" aria-label="${esc(T('flex.list.search'))}">
      <span id="flex-count" class="flex-count" role="status"></span>
      <div class="flex-only"><span>${esc(T('flex.list.only'))}</span>
        ${['pending', 'checked', 'opened', 'recording', 'untimed'].map((k) => `<label><input type="checkbox" data-only="${k}"> ${esc(T('flex.list.only.' + k))}</label>`).join('')}
      </div>
    </div>
    <ul id="flex-texts" class="doc-list" hidden></ul>`;
  view.insertBefore(box, view.firstChild);
  $('#flex-project', box).addEventListener('change', () => { onProjectPick(); refreshProjects(); });
  $('#flex-open-read', box).addEventListener('click', () => openProject('read'));
  $('#flex-open-write', box).addEventListener('click', () => openProject('write'));
  $('#flex-close', box).addEventListener('click', closeProject);
  $('#flex-reset-all', box).addEventListener('click', resetAll);
  $('#flex-make-copy', box).addEventListener('click', makeCopy);
  $('#flex-recover', box).addEventListener('click', recoverProject);
  wireListTools(box);
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
  const keep = sel.value;
  for (const o of [...sel.options]) if (o.value) o.remove();   // a reload starts clean, keeping the choice
  for (const p of projects) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.name + (p.writable ? '' : ' · ' + T('flex.readOnlyTag'));
    sel.appendChild(o);
  }
  if (keep && projects.some((p) => p.name === keep)) sel.value = keep;
}
/* ⚠ A PROJECT'S STATE CHANGES OUTSIDE THIS WINDOW, so it is read again whenever it matters — on choosing
 * a project, on coming back to this window, after closing a project, on "Check again" — never trusted
 * from when the shell started. It was: the list was read once at start-up, so FLEx closed, sharing turned
 * off or a marker added afterwards changed nothing here, and "Open for writing" stayed off until a
 * restart (Seth, 2026-10-16: "I still can't open for writing..."). list_projects reads only the
 * filesystem, so this is cheap. */
let refreshing = null;
function refreshProjects() {
  if (project || !$('#flex-project')) return Promise.resolve();
  if (!refreshing) refreshing = loadProjects().then(onProjectPick).finally(() => { refreshing = null; });
  return refreshing;
}
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => { if (isFlexShell()) refreshProjects(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && isFlexShell()) refreshProjects(); });
}
function onProjectPick() {
  const p = projects.find((x) => x.name === $('#flex-project').value);
  $('#flex-open-read').disabled = !p || !p.readable;
  // the team's project opens for writing through the before-write checklist (teamwrite.py), which also covers
  // sharing being on; a marked copy opens as it always did
  $('#flex-open-write').disabled = !p || !(p.writable || p.writableWithChecklist);
  // every reason writing (or reading) is off, one per line, each saying what to do — and a way to look again
  const why = p ? p.reasons.filter((c) => !(c === 'E_SHARING_ON' && p.writableWithChecklist)).map((c) => T('flex.err.' + c)) : [];
  showReasons(why);
  $('#flex-open-write').title = why.join('\n');
  // a disposable copy is a choice for a team project, no longer the only way to write
  $('#flex-make-copy').hidden = !p || !!project || !p.team;
  // RECOVER: while a snapshot of this project exists (a write session opened it), with nothing open here
  $('#flex-recover').hidden = !p || !!project || !p.snapshot;
}
function showReasons(lines) {
  const r = $('#flex-reasons');
  if (!r) return;
  r.hidden = !lines.length;
  r.innerHTML = lines.map((w) => `<span class="flex-reason">${esc(w)}</span>`).join('')
    + (lines.length && !project ? ` <button class="link-btn flex-recheck">${esc(T('flex.recheck'))}</button>` : '');
  const b = r.querySelector('.flex-recheck');
  if (b) b.addEventListener('click', () => refreshProjects());
}
async function openProject(mode) {
  const name = $('#flex-project').value;
  if (!name) return;
  const p = projects.find((x) => x.name === name);
  let confirm = null;
  if (mode === 'write' && p && (p.team || p.reasons.includes('E_SHARING_ON'))) {
    let plan;
    const reading = working(T('flex.reading'));
    try { plan = await flex.writePlan(name); } catch (e) { reading(); fail(e); return; } finally { reading(); }
    confirm = await teamChecklist(plan);
    if (!confirm) return;
  }
  const done = working(T('flex.openingProject', { p: name }));   // the list of texts is part of the wait
  try {
    try {
      const r = await flex.openProject(name, mode, confirm);
      project = { name, writable: r.writable, ws: r.ws, printViewConfig: r.printViewConfig, texts: await flex.listTexts(),
        team: !!r.team, snapshot: r.snapshot || null };
      if (r.writable && r.snapshot) H.toast(T('flex.team.snapshotNote', { t: new Date(r.snapshot.takenAt).toLocaleTimeString() }), 12000);
    } catch (e) {
      done();
      fail(e);
      await refreshProjects();                // what stopped it may be news to this window too
      // …and the refusal stays in view, first, above whatever else the project's state says
      const p = projects.find((x) => x.name === name);
      showReasons([...new Set([failMessage(e), ...(p ? p.reasons.map((c) => T('flex.err.' + c)) : [])])]);
      return;
    }
    flexHist.done = []; flexHist.undone = [];
    await showOpenProject();
  } finally { done(); }
}
async function showOpenProject() {
  const sel = $('#flex-project');
  if (sel) { sel.value = project.name; sel.disabled = true; }
  $('#flex-close').hidden = false;
  $('#flex-reset-all').hidden = false;   // read-only too: it changes nothing in FLEx
  $('#flex-list-tools').hidden = false;
  $('#flex-make-copy').hidden = true;    // a copy is made with nothing open here
  $('#flex-recover').hidden = true;      // and so is a recovery
  $('#flex-open-read').disabled = $('#flex-open-write').disabled = true;
  $('#flex-reasons').hidden = true;
  $('#flex-project-actions').hidden = !project.writable;
  updateHistoryButtons();
  await renderTexts();
}
async function closeProject() {
  const done = working(T('flex.closingProject'));
  try { await flex.closeProject(); } catch (e) { done(); fail(e); } finally { done(); }
  project = null;
  flexHist.done = []; flexHist.undone = [];
  $('#flex-close').hidden = true;
  $('#flex-reset-all').hidden = true;
  $('#flex-list-tools').hidden = true;
  $('#flex-project').disabled = false;
  $('#flex-texts').hidden = true;
  $('#flex-project-actions').hidden = true;
  onProjectPick();
  await refreshProjects();   // its lock is gone now, and the others may have changed meanwhile
}

/* ---- writing to the TEAM's project (desktop/flexshell/teamwrite.py; Seth, 2026-10-18) ------------------------
 * "it should write a throwaway copy as a backup with a 'reverse/recover' button if the database turns out to be
 * broken. Have it remind the user to send and receive and confirm that they have BEFORE it starts the attempted
 * write operation … Close FLEx and any other apps using the database." Every protection a save already has stays:
 * the checklist and the snapshot go AROUND them. What the filesystem can answer is shown, not asked: when the
 * project's Send/Receive store last moved; and RECOVER is refused by the shell, not the user, once a Send/Receive
 * has happened since the snapshot (the written data is the team's then). */
function agoText(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 90) return T('flex.ago.minutes', { n: m });
  if (m < 36 * 60) return T('flex.ago.hours', { n: Math.round(m / 60) });
  return T('flex.ago.days', { n: Math.round(m / 1440) });
}
const AN_HOUR = 60 * 60 * 1000;
/* → { sentReceived: true, appsClosed: true } or null (Cancel). Both boxes must be ticked; a Send/Receive long ago
 * is said in red beside the box, and the dialog is where the user comes back to after doing one. */
function teamChecklist(plan) {
  return new Promise((resolve) => {
    const sr = plan.sendReceive || {};
    const srLine = !sr.present ? T('flex.team.lastSRNone')
      : T('flex.team.lastSR', { when: sr.lastActivity ? new Date(sr.lastActivity).toLocaleString() + ' (' + agoText(sr.lastActivity) + ')' : '?' });
    const old = sr.present && (!sr.lastActivity || Date.now() - sr.lastActivity > AN_HOUR);
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.dataset.flexTeam = '1';
    wrap.innerHTML = `<div class="modal-card flex-ws-card" role="dialog" aria-modal="true">
      <h3>${esc(T('flex.team.title', { p: plan.name }))}</h3>
      <p>${esc(T('flex.team.intro'))}</p>
      <ol class="flex-team-steps">
        <li>${esc(T('flex.team.step1'))} <span class="flex-media-note">${esc(srLine)}${sr.tip ? ' ' + esc(T('flex.team.lastCommit', { d: sr.tip.date || '', id: String(sr.tip.id || '').slice(0, 12) })) : ''}</span>${old ? ' <span class="flex-reset-lose">' + esc(T('flex.team.lastSROld')) + '</span>' : ''}</li>
        <li>${esc(T('flex.team.step2'))}${plan.sharing ? ' <span class="flex-media-note">' + esc(T('flex.team.sharingNote')) + '</span>' : ''}</li>
        <li>${esc(T('flex.team.step3', { s: sizeText(plan.fwdataBytes || 0) }))}</li>
      </ol>
      <label class="flex-reset-media"><input type="checkbox" data-sr> <span>${esc(T('flex.team.confirmSR'))}</span></label>
      <label class="flex-reset-media"><input type="checkbox" data-closed> <span>${esc(T('flex.team.confirmClosed'))}</span></label>
      <div class="flex-row">
        <button class="secondary-btn" data-cancel>${esc(T('share.cancel'))}</button>
        <button class="primary-btn" data-ok disabled>${esc(T('flex.team.ok'))}</button>
      </div>
    </div>`;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    const done = (v) => { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(v); };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    const boxes = [wrap.querySelector('[data-sr]'), wrap.querySelector('[data-closed]')];
    const okBtn = wrap.querySelector('[data-ok]');
    boxes.forEach((b) => b.addEventListener('change', () => { okBtn.disabled = !boxes.every((x) => x.checked); }));
    okBtn.addEventListener('click', () => { if (boxes.every((x) => x.checked)) done({ sentReceived: true, appsClosed: true }); });
    wrap.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    wrap.querySelector('[data-cancel]').focus();
  });
}
/* The work a save is about to put into FLEx, kept on the record with the snapshot's id (`beforeSave`), so RECOVER
 * — which takes FLEx back to the snapshot — can give the record its work back, marked as not in FLEx. Once per
 * snapshot: the first save of a write session is the one whose "before" is the snapshot's state. */
const BEFORE_SAVES_MAX = 12;
function keepBeforeSave(rec) {
  if (!(project && project.team) || !rec || !rec.flex) return null;
  const entry = { snapshotId: null, at: Date.now(), doc: clone(rec.doc), base: clone(rec.flex.base), baseRev: rec.flex.baseRev,
    dirty: !!rec.flex.dirty, mediaFix: rec.flex.mediaFix ? clone(rec.flex.mediaFix) : null, linkOk: !!rec.flex.linkOk };
  rec.flex.beforeSaves = [...(rec.flex.beforeSaves || []).slice(-(BEFORE_SAVES_MAX - 1)), entry];
  delete rec.flex.beforeSave;   // the one-per-session form of 9eb919d
  return entry;
}
// the write job answered: the snapshot the shell took before it is the one this entry is the way back from
function stampBeforeSave(entry, r) {
  if (entry && r && r.snapshot) { entry.snapshotId = r.snapshot.id; entry.snapshotAt = r.snapshot.takenAt; }
}
/* RECOVER took FLEx back to the snapshot taken at `takenAt`: every write from here after it is undone there, so each
 * record gets back the state before its FIRST write after that moment; later entries go (their "before" is a FLEx
 * that no longer exists). Entries are matched by the snapshot the shell named, else by time. */
async function restoreRecordsAfter(name, snap, known) {
  const at = (e) => (e.snapshotId && known.has(e.snapshotId) ? known.get(e.snapshotId) : (e.snapshotAt || e.at));
  const docs = await H.db.listDocs().catch(() => []);
  let n = 0;
  for (const d of docs) {
    if (!isFlexDocOf(d.id, name)) continue;
    const rec = await H.db.getDoc(d.id).catch(() => null);
    const list = (rec && rec.flex && (rec.flex.beforeSaves || (rec.flex.beforeSave ? [rec.flex.beforeSave] : []))) || [];
    const after = list.filter((e) => at(e) >= snap.takenAt - 1000).sort((x, y) => at(x) - at(y));
    if (!after.length) continue;
    const b = after[0];
    rec.doc = b.doc; rec.title = b.doc.title || rec.title;
    rec.flex.base = b.base; rec.flex.baseRev = b.baseRev; rec.flex.dirty = true;
    rec.flex.mediaFix = b.mediaFix; rec.flex.linkOk = b.linkOk;
    rec.flex.beforeSaves = list.filter((e) => at(e) < snap.takenAt - 1000);
    delete rec.flex.beforeSave;
    rec.modified = Date.now();
    Object.assign(rec, H.docStats(rec.doc));
    await H.db.putDoc(rec);
    n++;
  }
  return n;
}
/* → the chosen snapshot's plan, or null (Cancel). Every snapshot of the project is offered, newest first — one per
 * write since 2026-10-18 — and the body follows the choice (a fresh plan from the shell for each). */
function recoverDialog(plan0, name) {
  return new Promise((resolve) => {
    let plan = plan0;
    const warnOf = (p) => [p.warnings.includes('fwdataChangedSinceWrite') ? T('flex.recover.warnFlexEdits') : '',
      p.warnings.includes('nothingWrittenHere') ? T('flex.recover.warnNothing') : ''].filter(Boolean);
    const body = (p) => `<p data-body>${esc(T('flex.recover.body', { p: p.project, t: new Date(p.snapshot.takenAt).toLocaleString(), n: p.snapshot.saves }))}</p>
      ${warnOf(p).map((w) => '<p class="flex-reset-lose">' + esc(w) + '</p>').join('')}
      ${p.refusal ? '<p class="flex-reset-lose">' + esc(T('flex.err.' + p.refusal)) + '</p>' : ''}`;
    const options = (plan0.snapshots || [plan0.snapshot]).map((s) =>
      `<option value="${esc(s.id)}"${s.id === plan0.snapshot.id ? ' selected' : ''}>${esc(T('flex.recover.option', { t: new Date(s.takenAt).toLocaleString(), n: s.saves }))}</option>`).join('');
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.dataset.flexRecover = '1';
    wrap.innerHTML = `<div class="modal-card flex-ws-card" role="dialog" aria-modal="true">
      <h3>${esc(T('flex.recover.title'))}</h3>
      <label class="flex-ws-row">${esc(T('flex.recover.pick'))} <select data-snap>${options}</select></label>
      <div data-plan>${body(plan)}</div>
      <p class="flex-media-note">${esc(T('flex.recover.workKept'))}</p>
      <label class="flex-reset-media"><input type="checkbox" data-c1> <span>${esc(T('flex.recover.confirm1'))}</span></label>
      <label class="flex-reset-media"><input type="checkbox" data-c2> <span>${esc(T('flex.recover.confirm2'))}</span></label>
      <div class="flex-row">
        <button class="secondary-btn" data-cancel>${esc(T('share.cancel'))}</button>
        <button class="primary-btn" data-ok disabled>${esc(T('flex.recover.ok'))}</button>
      </div>
    </div>`;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    const done = (v) => { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(v); };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    const boxes = [wrap.querySelector('[data-c1]'), wrap.querySelector('[data-c2]')];
    const okBtn = wrap.querySelector('[data-ok]');
    const ready = () => { okBtn.disabled = !(boxes.every((x) => x.checked) && plan && !plan.refusal && !plan.alreadyThere); };
    boxes.forEach((b) => b.addEventListener('change', ready));
    wrap.querySelector('[data-snap]').addEventListener('change', async (e) => {
      okBtn.disabled = true;
      try { plan = await flex.recoverPlan(name, e.target.value); } catch (err) { fail(err); return; }
      wrap.querySelector('[data-plan]').innerHTML = body(plan);
      ready();
    });
    okBtn.addEventListener('click', () => { if (boxes.every((x) => x.checked) && plan && !plan.refusal) done(plan); });
    wrap.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    wrap.querySelector('[data-cancel]').focus();
  });
}
async function recoverProject() {
  if (busy || project) return;
  const name = $('#flex-project').value;
  if (!name) return;
  let plan;
  const reading = working(T('flex.reading'));
  try { plan = await flex.recoverPlan(name); } catch (e) { reading(); fail(e); return; } finally { reading(); }
  if (plan.alreadyThere && (plan.snapshots || []).length <= 1) { H.toast(T('flex.recover.already'), 8000); return; }
  if (plan.refusal && plan.refusal !== 'E_NO_SNAPSHOT') { H.toast(T('flex.err.' + plan.refusal), 15000); return; }
  if (plan.refusal === 'E_NO_SNAPSHOT' && !plan.snapshot) { H.toast(T('flex.err.E_NO_SNAPSHOT'), 8000); return; }
  const chosen = await recoverDialog(plan, name);
  if (!chosen) return;
  plan = chosen;
  busy = true;
  const done = working(T('flex.reading'));
  try {
    const r = await flex.recoverSnapshot(name, plan.snapshot.id);
    // the records whose work a write after that snapshot put into FLEx: it comes back here, marked not in FLEx
    const known = new Map((plan.snapshots || []).map((s) => [s.id, s.takenAt]));
    await restoreRecordsAfter(name, plan.snapshot, known);
    done();
    if (r.restored) H.toast(T('flex.recover.done', { t: new Date(plan.snapshot.takenAt).toLocaleString(), f: baseName(r.setAside || '') }), 15000);
    else H.toast(T('flex.recover.already'), 8000);
  } catch (e) { done(); fail(e); } finally { done(); busy = false; }
  await refreshProjects();
}

/* ---- Make a copy to write to (plan §12.3) -------------------------------------------------------------
 * Seth, 2026-10-16: "So far audio segmenter can't write at all yet. Now's the time to start changing that."
 * This build writes only to a marked disposable copy, which had to be made by hand — and a copy made by
 * hand carries the project's Send/Receive repository, so a Send/Receive from it could send test writes to
 * the team's shared project. The shell copies the folder beside the original without it, renames it,
 * marks it, and only reads the original; the copy then opens for writing like any project. */
async function makeCopy() {
  if (busy || project) return;
  const name = $('#flex-project').value;
  const p = projects.find((x) => x.name === name);
  if (!p) return;
  let plan;
  const reading = working(T('flex.reading'));
  try { plan = await flex.copyPlan(name); } catch (e) { reading(); fail(e); return; } finally { reading(); }
  const msg = T('flex.copy.confirm', { p: name, c: plan.name, s: sizeText(plan.bytes), f: sizeText(plan.free) })
    + (p.sharing ? '\n\n' + T('flex.copy.sharing') : '');
  if (!await H.confirmDialog(msg, { ok: T('flex.copy.ok'), cancel: T('share.cancel') })) return;   // nothing is lost by it: not a destructive question
  busy = true;
  const prog = progressModal(T('flex.copy.making', { c: plan.name }));
  try {
    const r = await flexJobWithProgress('make_copy', name, (x) => prog.set(x && x.n ? T('flex.copy.progress', { i: x.i, n: x.n }) : ''));
    prog.close();
    await loadProjects();
    $('#flex-project').value = r.name;
    onProjectPick();
    H.toast(T('flex.copy.done', { c: r.name }), 10000);
  } catch (e) { prog.close(); fail(e); } finally { busy = false; }
}

/* ---- the text list: sorted and filtered (plan §11.1) --------------------------------------------------
 * Seth, 2026-10-16: "sorting options for texts, including open/pending edits, most recently opened/edited
 * (in this app, in FLEx), alphabetical, date created, etc. Also ability to filter (including by genre or
 * checkbox)." flex-ops.js arrangeTexts does the sorting and filtering; here are the controls, a checkbox
 * on every row (your own working set, filtered by "checked"), and what this device remembers: the sort,
 * its direction and the "show only" boxes for every project; the genre and the checked texts per project
 * (a genre is a guid of ONE project's list). The search is for now only. FLEx's dates and genres come
 * from list_texts; "opened here" is stamped on every open (`rec.flex.openedAt`). */
const VIEW_KEY = 'flextext-flex-view';
const view = (() => {
  const v = { sort: 'title', reverse: false, only: {}, genres: {}, q: '' };
  try { Object.assign(v, JSON.parse(localStorage.getItem(VIEW_KEY) || '{}'), { q: '' }); } catch { /* a private window: defaults */ }
  return v;
})();
const projectKey = () => (project ? flexDocId(project.name, '').slice('flex-'.length) : '');
function saveView() {
  const { q, ...keep } = view;
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(keep)); } catch { /* the view still applies now */ }
}
const checkedKey = () => 'flextext-flex-checked' + projectKey();
function checkedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(checkedKey()) || '[]')); } catch { return new Set(); }
}
function saveChecked(set) {
  try { localStorage.setItem(checkedKey(), JSON.stringify([...set])); } catch { /* kept for this session only */ }
}
function wireListTools(box) {
  const sortSel = $('#flex-sort', box), rev = $('#flex-sort-rev', box), genreSel = $('#flex-genre', box), q = $('#flex-q', box);
  sortSel.value = view.sort;
  rev.setAttribute('aria-pressed', String(!!view.reverse));
  box.querySelectorAll('[data-only]').forEach((cb) => { cb.checked = !!view.only[cb.dataset.only]; });
  sortSel.addEventListener('change', () => { view.sort = sortSel.value; saveView(); drawTexts(); });
  rev.addEventListener('click', () => { view.reverse = !view.reverse; rev.setAttribute('aria-pressed', String(view.reverse)); saveView(); drawTexts(); });
  genreSel.addEventListener('change', () => { view.genres[projectKey()] = genreSel.value; saveView(); drawTexts(); });
  q.addEventListener('input', () => { view.q = q.value; drawTexts(); });
  box.querySelectorAll('[data-only]').forEach((cb) => cb.addEventListener('change', () => {
    view.only = { ...view.only, [cb.dataset.only]: cb.checked };
    saveView();
    drawTexts();
  }));
}
// FLEx's genres, as this project's texts carry them: All, each (with how many), and None if any has none
function fillGenres() {
  const sel = $('#flex-genre');
  if (!sel || !project) return;
  const count = new Map();
  let none = 0;
  for (const tx of project.texts) {
    if (!(tx.genres || []).length) none++;
    for (const g of tx.genres || []) count.set(g.guid, { name: g.name || '?', n: ((count.get(g.guid) || {}).n || 0) + 1 });
  }
  const list = [...count].sort((a, b) => a[1].name.localeCompare(b[1].name));
  sel.innerHTML = `<option value="">${esc(T('flex.list.allGenres'))}</option>`
    + list.map(([guid, g]) => `<option value="${esc(guid)}">${esc(g.name)} (${g.n})</option>`).join('')
    + (none && list.length ? `<option value="none">${esc(T('flex.list.noGenre', { n: none }))}</option>` : '');
  const want = view.genres[projectKey()] || '';
  sel.value = [...sel.options].some((o) => o.value === want) ? want : '';
  sel.closest('.flex-tool').hidden = !list.length;   // a project without genres has nothing to choose
}

/* The text rows: what FLEx's link does here, whether the app has its own recording, whether the work
 * done here is in FLEx yet — and the actions that fit. One read of the library for the whole list; a
 * full record read only for the texts that have one. A change of sort or filter redraws from what was
 * read (drawTexts); renderTexts reads again. */
let renderSeq = 0;
let rows = [];
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
  const checked = checkedSet();
  rows = proj.texts.map((tx, i) => {
    const rec = recs[tx.guid] || null;
    const id = flexDocId(proj.name, tx.guid);
    const todo = rec && rec.flex ? notInFlex(rec) : { save: false, relink: false };
    return { tx, rec, id, todo, guid: tx.guid, title: tx.title, flexIndex: i, created: tx.created || null, modified: tx.modified || null,
      genres: tx.genres || [], segs: tx.segs, timedSegs: tx.timedSegs, pending: !!(todo.save || todo.relink || (rec && rec.matchDraft)),
      openedAt: rec && rec.flex ? (rec.flex.openedAt || rec.flex.loadedAt || null) : null, recording: have.has(id), checked: checked.has(tx.guid) };
  });
  fillGenres();
  drawTexts();
}
function drawTexts() {
  const ul = $('#flex-texts');
  if (!ul || !project) return;
  const shown = arrangeTexts(rows, { ...view, genre: view.genres[projectKey()] || '' });
  ul.hidden = false;
  ul.innerHTML = '';
  const cnt = $('#flex-count');
  if (cnt) cnt.textContent = shown.length === rows.length ? T('flex.list.countAll', { n: rows.length }) : T('flex.list.count', { n: shown.length, all: rows.length });
  if (!shown.length && rows.length) {
    const li = document.createElement('li');
    li.className = 'flex-empty';
    li.innerHTML = `<span>${esc(T('flex.list.none'))}</span> <button class="link-btn">${esc(T('flex.list.showAll'))}</button>`;
    li.querySelector('button').addEventListener('click', () => {
      view.only = {}; view.q = ''; view.genres[projectKey()] = '';
      saveView();
      document.querySelectorAll('#flex-list-tools [data-only]').forEach((cb) => { cb.checked = false; });
      const q = $('#flex-q'); if (q) q.value = '';
      fillGenres();
      drawTexts();
    });
    ul.appendChild(li);
    return;
  }
  for (const r of shown) ul.appendChild(textRow(r));
}
function textRow(r) {
  const { tx, rec, id, todo } = r;
  const proj = project;
  const media = r.recording ? T('flex.media.inApp')
    : !tx.media.length ? T('flex.media.noLinkTag')
    : tx.media.some((m) => m.exists) ? '' : T('flex.mediaMissing');
  const bits = [T('flex.textMeta', { p: tx.paras, s: tx.segs, t: tx.timedSegs }), r.genres.map((g) => g.name).join(', '), wsOf(rec) ? wsPair(wsOf(rec)) : '', media,
    rec && rec.matchDraft ? T('sg.inProgress') : '', todo.save || todo.relink ? T('flex.textUnsaved') : ''].filter(Boolean);
  const li = document.createElement('li');
  li.className = 'rec-item';
  li.dataset.textGuid = tx.guid;
  // the Segmenter list's own row structure (sgRenderList), so the app's styles apply
  li.innerHTML = `<label class="flex-check-wrap" title="${esc(T('flex.list.checkTip'))}"><input type="checkbox" class="flex-check" aria-label="${esc(T('flex.list.checkTip'))}"${r.checked ? ' checked' : ''}></label>
    <div class="rec-item-main"><span class="doc-name"></span>
        <span class="doc-meta">${esc(bits.join(' · '))}</span></div>
      <div class="rec-item-actions">
        ${proj.writable && todo.save ? `<button class="primary-btn flex-save-text">${esc(T('flex.save'))}</button>` : ''}
        ${proj.writable && todo.relink ? `<button class="link-btn flex-fix-link">${esc(T('flex.relink'))}</button>` : ''}
        <button class="link-btn flex-ws-text">${esc(T('flex.ws.button'))}</button>
        ${rec ? `<button class="link-btn flex-reset-text" title="${esc(T('flex.resetTip'))}">${esc(T('flex.reset'))}</button>` : ''}
        ${rec ? `<button class="link-btn flex-download-text" title="${esc(T('flex.downloadTip'))}">${esc(T('flex.download'))}</button>` : ''}
        ${rec ? `<button class="link-btn flex-export-text" title="${esc(T('flex.exportTip'))}">${esc(T('flex.export'))}</button>` : ''}
        <button class="secondary-btn flex-open-text">${esc(T('flex.openText'))}</button>
      </div>`;
  li.querySelector('.doc-name').textContent = tx.title;   // titles reach the UI only, never a log
  li.querySelector('.flex-check').addEventListener('change', (e) => {
    const set = checkedSet();
    if (e.target.checked) set.add(tx.guid); else set.delete(tx.guid);
    saveChecked(set);
    r.checked = e.target.checked;
    if (view.only.checked) drawTexts();
  });
  li.querySelector('.flex-open-text').addEventListener('click', () => openText(tx));
  const sv = li.querySelector('.flex-save-text');
  if (sv) sv.addEventListener('click', () => saveTextToFlex(tx));
  const fx = li.querySelector('.flex-fix-link');
  if (fx) fx.addEventListener('click', () => fixLink(tx));
  /* Download… is THIS APP'S copy, the work done here in it — the Segmenter's own download, the file FLEx's own
   * exporter would write for it (flextext.js flexExportDoc). Seth, 2026-10-17, of a text worked on in a read-only
   * session: "Can you give me a way to export my app's flextext copy … I'd rather not have to REDO all the hours".
   * Export FLEx's copy… is what FLEx has, from FLEx's exporter; the two used to be one button that said neither. */
  const dl = li.querySelector('.flex-download-text');
  if (dl && H.exportRecord) dl.addEventListener('click', () => H.exportRecord(id));
  const ex = li.querySelector('.flex-export-text');
  if (ex) ex.addEventListener('click', () => exportBundle(tx));
  li.querySelector('.flex-ws-text').addEventListener('click', () => chooseWs(tx));
  const rs = li.querySelector('.flex-reset-text');
  if (rs) rs.addEventListener('click', () => resetText(tx));
  return li;
}
/* What FLEx does not have yet of the work COMMITTED here (the Matcher's Done): text or time changes →
 * Save to FLEx…; a recording link that points nowhere → Fix FLEx's recording link…. Judged by the diff
 * Save to FLEx would make, never by timestamps: a Done that changed nothing has nothing to save, and two
 * saves undone and one redone still do. A draft still in the Matcher is not committed, so it is not here
 * (the row says it is in progress); an attach rides only with times (D9), so alone it is not either. */
function notInFlex(rec) {
  let save;
  try {
    // what a save would write: blank lines (the Matcher's +, Done's old padding) never go to FLEx
    const d = diffFlexDoc(rec.flex.base, stripFlexPadding(rec.flex.base, rec.doc, { everywhere: true }), { ws: rec.doc.analLang });
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
  let done = working(T('flex.openingText', { t: tx.title }));
  const again = () => { done = working(T('flex.openingText', { t: tx.title })); };
  try { await openTextSteps(tx, () => done(), again); } finally { done(); }
}
// The steps of an open; `pause` takes the spinner down before a question, `resume` puts it back.
async function openTextSteps(tx, pause, resume) {
  const id = flexDocId(project.name, tx.guid);
  const existing = await H.db.getDoc(id).catch(() => null);
  const local = hasLocalWork(existing);
  // Read in the writing systems chosen for the text. A record with work here is read in the ones that
  // work is in; one with none, made by an older build before there was a choice, is read in the text's
  // own (the shell's default) — the one it is glossed and translated in, which that build never read.
  const ws = existing && existing.flex ? (existing.flex.ws || (local ? wsOf(existing) : null)) : null;
  let opened;
  try { opened = await flex.openText(tx.guid, ws); } catch (e) { pause(); fail(e); return; }
  const how = reopenDecision(existing, opened.baseRev, local);
  let rec, after = '';
  if (how === 'ask' && !existing.matchDraft) {
    /* FLEx changed the text and there is work here (§4.5): FLEx's changes come in under the work — the
     * checkout moves to FLEx's text as it is now, the work rides on it — unless the two changed the same
     * thing, which Save to FLEx… then shows. Nothing is lost either way, nothing is asked here. */
    const m = mergeFlexDocs(existing.flex.base, stripFlexPadding(existing.flex.base, existing.doc), opened.doc);
    if (!m.conflicts.length) {
      keepTimeEstimates(existing.doc, m.doc);
      rec = { ...existing, doc: m.doc, title: m.doc.title,
        flex: { ...existing.flex, base: clone(opened.doc), baseRev: opened.baseRev, loadedAt: Date.now() } };
      Object.assign(rec, H.docStats(m.doc));
      after = T(m.theirs === 1 ? 'flex.merge.openKept1' : 'flex.merge.openKeptN', { n: m.theirs });
    } else {
      rec = existing;
      after = T(m.conflicts.length === 1 ? 'flex.merge.openConflicts1' : 'flex.merge.openConflictsN', { n: m.conflicts.length });
    }
  } else if (how === 'ask') {
    // ⚠ NOT UNDER A MATCHER DRAFT: the draft holds the Matcher's own copy of the lines, and its Done would
    // write them back over FLEx's merged changes. So the old question: the destructive answer is the one
    // Escape and a click outside never give.
    pause();
    const load = await H.confirmDialog(T('flex.reopen.conflict'), { ok: T('flex.reopen.loadFlex'), cancel: T('flex.reopen.keep'), cancelFirst: true });
    resume();
    rec = load ? fromFlex(existing, id, tx, opened) : existing;
  } else {
    rec = how === 'keep' ? existing : fromFlex(existing, id, tx, opened);
    if (how === 'keep') {
      // FLEx unchanged: its guesses for the words not glossed here, on a record an older build kept (shown in the Matcher)
      rec.flex.base = graftFlexGuesses(rec.flex.base, opened.doc);
      rec.doc = graftFlexGuesses(rec.doc, opened.doc);
    }
  }
  const links = (opened.doc.flex && opened.doc.flex.media) || [];
  rec.flex.writable = project.writable;
  rec.flex.linkOk = links.some((m) => m.url);
  // the recording: this app's own copy if it has one; else FLEx's link, a remembered choice, or the user
  const have = await H.db.getMedia(id).catch(() => null);
  if (!have) {
    pause();                               // the card, or the copy's own progress, says what happens now
    const got = await obtainRecording(id, tx, links);
    if (!got) return;                      // "Not now": nothing stored, nothing opened
    resume();
    rec.flex.recording = got.recording;
    rec.flex.mediaFix = got.fix;
  }
  rec.flex.openedAt = Date.now();          // "opened here", for the list's sort and filter
  await H.db.putDoc(rec);                  // a raw write: opening is not an edit
  await H.openRecord(id);
  if (after) { pause(); H.toast(after, 9000); }
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
const sizeText = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
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
 * text is shown in a vernacular writing system of the project (the words) and its analysis writing
 * systems — EVERY one of them carried in the record and editable (Seth, 2026-10-16: "I want our app to
 * cache and be able to edit (if the user wants) ALL writing systems (like they can switch from English to
 * indonesian mid-way and their English changes will be saved)"). The choice lives on the text's record
 * (`rec.flex.ws`, and `rec.flex.allLangs` for all of them at once); a text opens in its own — the
 * vernacular its paragraphs are in, the analysis one it uses most — until someone chooses.
 * The analysis one is a VIEW: switching it reads nothing and loses nothing, with work pending or not.
 * The vernacular one is how the words are spelled, so it re-reads the text from FLEx, and waits until the
 * work done here is in FLEx. */
// A record an older build made has no choice stored: its doc is in the ones that build read (FLEx's
// default vernacular and first analysis writing system) and says so itself.
const wsOf = (rec) => {
  if (!rec || !rec.flex) return null;
  if (rec.flex.ws) return rec.flex.ws;
  const d = rec.doc || {};
  return d.vernLang && d.analLang ? { vern: d.vernLang, anal: d.analLang } : null;
};
// The doc carries every analysis writing system (to_engine_doc since the choice existed); an older
// build's carries one, and showing another in it would show it empty where FLEx has text.
const layered = (rec) => !!(rec && rec.doc && rec.doc.flex && rec.doc.flex.ws);
// What the Matcher shows a record in: 'all', 'primary' (the doc's own analysis language) or a code.
function langViewOf(rec) {
  const ws = wsOf(rec) || {};
  if (rec.flex.allLangs && layered(rec)) return 'all';
  return ws.anal && rec.doc && rec.doc.analLang && ws.anal !== rec.doc.analLang && layered(rec) ? ws.anal : 'primary';
}
// Remember a view choice on the record, in storage and in the copy the editor holds (which persist()
// writes back) — a raw write: choosing what to look at is not an edit.
async function rememberView(id, patch) {
  const rec = await H.db.getDoc(id).catch(() => null);
  if (rec && rec.flex) { Object.assign(rec.flex, patch); await H.db.putDoc(rec).catch(() => {}); }
  const cur = H.getCurrent();
  if (cur && cur.id === id && cur.flex) Object.assign(cur.flex, patch);
}
const wsList = (kind) => (project && project.ws && project.ws[kind]) || [];
function wsName(id, kind) {
  const w = wsList(kind).find((x) => x.id === id);
  return (w && w.name) || id || '';
}
const wsPair = (ws) => T('flex.ws.pair', { v: wsName(ws.vern, 'vern'), a: wsName(ws.anal, 'anal') });
async function chooseWs(tx) {
  if (busy || !project) return;
  let info;
  const reading = working(T('flex.reading'));
  try { info = await flex.textWs(tx.guid); } catch (e) { reading(); fail(e); return; } finally { reading(); }
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
    // another analysis writing system only: the record carries every one — a view, nothing read or lost
    if (pick.vern === cur.vern && layered(rec)) {
      await rememberView(id, { ws: { vern: pick.vern, anal: pick.anal }, allLangs: false });
      await renderTexts();
      H.toast(T('flex.ws.changed', { p: wsPair(pick) }), 5000);
      return;
    }
    H.toast(T(pick.vern !== cur.vern ? 'flex.ws.busy' : 'flex.ws.busyOld'), 10000);
    return;
  }
  busy = true;
  const done = working(T('flex.reading'));
  try {
    const opened = await flex.openText(tx.guid, pick);
    const next = fromFlex(rec, id, tx, opened);
    next.flex.writable = project.writable;
    next.flex.linkOk = ((opened.doc.flex && opened.doc.flex.media) || []).some((m) => m.url);
    await H.db.putDoc(next);              // a raw write: a new view of FLEx's text is not an edit
    await renderTexts();
    done();
    wsChangedToast(opened);
  } catch (e) { done(); fail(e); } finally { done(); busy = false; }
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
  const done = working(T('flex.reading'));
  try {
    await resetOne(tx.guid, rec, pick.media);
    done();
    H.toast(T(pick.media ? 'flex.reset.doneMedia' : 'flex.reset.done'), 7000);
  } catch (e) { done(); fail(e); } finally { done(); busy = false; }
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
 * "Glosses in" shows the glosses and free translations of the one chosen, editable, at once and with work
 * pending (2026-10-16): every analysis writing system is in the record, so nothing is read and nothing
 * done in another is lost — the English typed before switching to Indonesian is still there, and Save to
 * FLEx writes both. "All languages" stacks every one of FLEx's, each editable. "Words in" re-reads the
 * text from FLEx in that vernacular writing system — only with nothing pending here. */
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
  const other = shown !== 'primary' && shown !== 'all';   // another analysis writing system than the doc's own
  const own = (cur.doc && cur.doc.analLang) || ws.anal;
  const row = document.createElement('div');
  row.id = 'flex-mg-strip';
  row.className = 'flex-mg-strip';
  row.innerHTML = `
    <span class="flex-badge">${esc(T('flex.badge'))}${cur.flex.writable ? '' : ' · ' + esc(T('flex.readOnlyTag'))}</span>
    <label class="flex-ws-field">${esc(T('flex.ws.words'))} ${pick('vern', listed('vern', ws.vern), ws.vern)}</label>
    <label class="flex-ws-field">${esc(T('flex.ws.glosses'))} ${pick('anal', anals, other ? shown : own, all)}</label>
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
  if (kind === 'anal' && layered(rec)) {
    // a view: the record carries every analysis writing system, each editable — nothing is read, and the
    // work done in one stays in it while another is shown (and is saved with it)
    const all = value === 'all';
    const own = (rec.doc && rec.doc.analLang) || ws.anal;
    H.setLangView(all ? 'all' : value === own ? 'primary' : value);
    await rememberView(rec.id, all ? { allLangs: true } : { allLangs: false, ws: { ...ws, anal: value } });
    renderMatcherStrip();
    return;
  }
  if (kind === 'vern' && value === ws.vern) return;
  if (H.matcherEdited() || hasLocalWork(rec)) {
    renderMatcherStrip();   // back to what is shown
    H.toast(T(kind === 'vern' ? 'flex.ws.busyHere' : 'flex.ws.busyOld'), 10000);
    return;
  }
  busy = true;
  const done = working(T('flex.reading'));
  try {
    // (an older build's record, read again: it then carries every analysis writing system)
    const opened = await flex.openText(rec.flex.textGuid, kind === 'anal' && value === 'all' ? ws : { ...ws, [kind]: value });
    // an edit made, or a text opened, while FLEx was being read wins: nothing is replaced under it
    const again = await H.db.getDoc(rec.id).catch(() => null);
    const still = H.getCurrent();
    if (!again || !still || still.id !== rec.id || H.matcherEdited() || hasLocalWork(again)) { renderMatcherStrip(); return; }
    const next = fromFlex(again, rec.id, { guid: rec.flex.textGuid }, opened);
    if (kind === 'anal') next.flex.allLangs = value === 'all';
    next.flex.writable = project.writable;
    next.flex.linkOk = ((opened.doc.flex && opened.doc.flex.media) || []).some((m) => m.url);
    await H.db.putDoc(next);              // a raw write: a new view of FLEx's text is not an edit
    await H.reopenRecord(rec.id);
    done();
    wsChangedToast(opened);
  } catch (e) { done(); fail(e); renderMatcherStrip(); } finally { done(); busy = false; }
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
  let done = working(T('flex.preparingSave'));   // down before the preview (or any message) shows
  const spin = { stop: () => done(), again: () => { done = working(T('flex.preparingSave')); } };
  try { await saveSteps(tx, id, rec, spin); } finally { done(); }
}
async function saveSteps(tx, id, rec, spin) {
  const done = () => spin.stop();
  let opened;
  try { opened = await flex.openText(tx.guid, wsOf(rec)); } catch (e) { done(); fail(e); return; }
  /* CHECK-IN (§4.5). With FLEx as it was at the check-out, the work is diffed against that. When FLEx has
   * changed the text since, the work goes onto FLEx's text as it is NOW (mergeFlexDocs) and the diff is
   * against THAT — so only the changes made here are written, and FLEx's own stay as they are. Where both
   * changed the same thing the user says which to keep, first. */
  // a blank line — the Matcher's +, or an earlier Done's padding — pairs audio here and is never FLEx's (stripFlexPadding)
  const mine = stripFlexPadding(rec.flex.base, rec.doc, { everywhere: true });
  let base = rec.flex.base, work = mine, baseRev = rec.flex.baseRev, merged = null;
  if (opened.baseRev !== rec.flex.baseRev) {
    merged = mergeFlexDocs(rec.flex.base, mine, opened.doc);
    if (merged.conflicts.length) {
      done();
      const how = await mergeDialog(merged.conflicts);
      if (!how) return;
      if (how === 'mine') merged = mergeFlexDocs(rec.flex.base, mine, opened.doc, { prefer: 'mine' });
      spin.again();
    }
    base = opened.doc; work = merged.doc; baseRev = opened.baseRev;
  } else {
    base = graftFlexGuesses(base, opened.doc);   // FLEx unchanged: its guesses as read now (a record from an older build has none)
  }
  // a word glossed here that FLEx was guessing for keeps the guess's other languages (adoptFlexGuesses)
  work = adoptFlexGuesses(base, work);
  // a recording this app found for a link that points nowhere rides along, shown in the preview (§8.4)
  const diff = diffFlexDoc(base, work, { ws: work.analLang, ...pendingMediaFix(rec.flex) });
  const blockers = flexBlockers(work, diff.touched).filter((b) => b.blocking);
  if (!diff.ops.length && !diff.unsupported.length) {
    done();
    if (!merged) { H.toast(T('flex.nothingToSave')); return; }
    // nothing of ours is left to write (kept FLEx's for all of it): this app's copy is FLEx's text again
    adoptFlex(rec, opened, work);
    await H.db.putDoc(rec);
    await renderTexts();
    H.toast(T('flex.merge.nothingLeft'), 7000);
    return;
  }
  if (diff.unsupported.length) {
    done();
    const why = [...new Set(diff.unsupported.map((u) => T('flex.unsupported.' + u.why)))].join('\n');
    H.toast(T('flex.cannotDiff') + '\n' + why, 9000);
    return;
  }
  let preview;
  try {
    preview = await flex.previewSave(tx.guid, baseRev, diff.ops, postStateOf(work, diff.touched, base));
  } catch (e) { done(); fail(e); return; }
  done();
  const kept = merged && merged.theirs ? T(merged.theirs === 1 ? 'flex.merge.kept1' : 'flex.merge.keptN', { n: merged.theirs }) : '';
  if (!await showPreview(preview, blockers, flexBlockers(work, diff.touched).filter((b) => !b.blocking), kept)) return;
  const before = keepBeforeSave(rec);   // RECOVER's way back for this text's work: before anything of it reaches FLEx
  const prog = progressModal(T('flex.saving'));
  try {
    const r = await flexJobWithProgress('save_to_flex', preview.previewToken, prog.set);
    prog.close();
    stampBeforeSave(before, r);
    if (diff.ops.some((o) => o.op === 'media.relink' || o.op === 'media.attach')) { rec.flex.mediaFix = null; rec.flex.linkOk = true; }
    /* FLEx now holds the work (and, after a merge, its own changes with it): this app's copy becomes FLEx's
     * text as read just now — FLEx's own shape (no § a join took out, LCM's guids for what the save made,
     * every word's occurrence as FLEx holds it), so the next check-in compares with exactly what FLEx has.
     * Should that read fail, the copy is marked as FLEx's from what was written (new phrases take LCM's
     * guids), and a merged one is read again on the next open. */
    applyAliases(work, r.alias || {});
    try { adoptFlex(rec, await flex.openText(tx.guid, wsOf(rec)), work); }
    catch {
      if (merged) { applyAliases(rec.doc, r.alias || {}); markInFlex(rec, r.newBaseRev); rec.flex.dirty = true; }
      else { await refreshMediaList(rec, tx.guid); markInFlex(rec, r.newBaseRev); }
    }
    await H.db.putDoc(rec);
    flexHist.done.push({ textGuid: tx.guid, id }); flexHist.undone = [];
    updateHistoryButtons();
    project.texts = await flex.listTexts().catch(() => project.texts);
    await renderTexts();
    H.toast(T('flex.saved', { n: r.saved, b: (r.backup && r.backup.path || '').split(/[\\/]/).pop() }) + (project.team ? ' ' + T('flex.team.afterSave') : ''), project.team ? 14000 : 7000);
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
/* After a merged check-in, FLEx holds the text this app should show — its changes and ours: the record
 * takes it as just read, keeping what FLEx does not hold (the draft, the recording, which time edges were
 * estimates — from `estimatesFrom`, the text as written). */
function adoptFlex(rec, opened, estimatesFrom) {
  const doc = opened.doc;
  keepTimeEstimates(estimatesFrom || rec.doc, doc);
  const now = Date.now();
  rec.doc = doc;
  rec.title = doc.title;
  rec.modified = now;
  rec.flex.base = clone(doc);
  rec.flex.baseRev = opened.baseRev;
  rec.flex.loadedAt = now;
  rec.flex.dirty = false;
  rec.flex.linkOk = ((doc.flex && doc.flex.media) || []).some((m) => m.url);
  Object.assign(rec, H.docStats(doc));
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
  const done = working(T('flex.preparingSave'));
  try {
    // A relink changes the path inside FLEx's media object, which no phrase fingerprint covers: the
    // base revision stays what it was, and work done here stays exactly as unsaved as it was.
    await flex.openText(tx.guid, wsOf(rec));   // the shell's session must know the text for the preview
    const preview = await flex.relinkPreview(tx.guid, fix.uriGuid, fix.path);
    done();
    if (!await showPreview(preview, [], [])) return;
    const before = keepBeforeSave(rec);
    const prog = progressModal(T('flex.saving'));
    try {
      const r = await flexJobWithProgress('save_to_flex', preview.previewToken, prog.set);
      prog.close();
      stampBeforeSave(before, r);
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
  } catch (e) { done(); fail(e); } finally { done(); }
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
/* Where the work here and FLEx changed the same thing (§4.5) → 'flex' (keep FLEx's for these and save
 * the rest), 'mine' (use mine for these — offered only when every one of them can take it), or null
 * (Cancel: nothing written, nothing changed here). Cancel is the default. */
function mergeDialog(conflicts) {
  return new Promise((resolve) => {
    const canMine = conflicts.every((c) => c.forceable);
    const lines = (c) => (c.lines && c.lines.length > 1 ? c.lines[0] + '–' + c.lines[c.lines.length - 1] : String(c.line || (c.lines && c.lines[0]) || '?'));
    // a gloss or a free translation is a cell per analysis writing system: the conflict names which
    const say = (c) => T('flex.merge.c.' + c.kind + (c.ws && (c.kind === 'free' || c.kind === 'gloss') ? 'In' : '') + (c.lines && c.lines.length > 1 ? 'N' : ''),
      { l: lines(c), w: c.word || '', ws: c.ws ? wsName(c.ws, 'anal') : '' });
    const shown = conflicts.slice(0, 15).map((c) => '<li>' + esc(say(c)) + '</li>').join('')
      + (conflicts.length > 15 ? '<li>' + esc(T('flex.merge.more', { n: conflicts.length - 15 })) + '</li>' : '');
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.dataset.flexMerge = '1';
    wrap.innerHTML = `<div class="modal-card flex-ws-card" role="dialog" aria-modal="true">
      <h3>${esc(T('flex.merge.title'))}</h3>
      <p>${esc(T('flex.merge.intro'))}</p>
      <ul class="flex-merge-list">${shown}</ul>
      <p class="flex-media-note">${esc(T(canMine ? 'flex.merge.choose' : 'flex.merge.chooseFlexOnly'))}</p>
      <div class="flex-row">
        <button class="secondary-btn" data-cancel>${esc(T('share.cancel'))}</button>
        <button class="primary-btn" data-flex>${esc(T('flex.merge.keepFlex'))}</button>
        ${canMine ? `<button class="secondary-btn" data-mine>${esc(T('flex.merge.keepMine'))}</button>` : ''}
      </div>
    </div>`;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    const done = (v) => { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(v); };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-flex]').addEventListener('click', () => done('flex'));
    const m = wrap.querySelector('[data-mine]');
    if (m) m.addEventListener('click', () => done('mine'));
    wrap.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    wrap.querySelector('[data-cancel]').focus();
  });
}
function showPreview(preview, blockers, warnings, kept = '') {
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
      ${kept ? '<p class="flex-merge-kept">' + esc(kept) + '</p>' : ''}
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
    case 'ft.set': return s.ws ? T('flex.sum.ftIn', { w: wsName(s.ws, 'anal'), b: s.before || '—', a: s.after || '—' }) : T('flex.sum.ft', { b: s.before || '—', a: s.after || '—' });
    case 'lt.set': return T('flex.sum.lt', { b: s.before || '—', a: s.after || '—' });
    case 'times.set': return T('flex.sum.times', { b: s.begin, e: s.end });
    case 'gloss.set': return T(s.fromGuess ? (s.outcome === 'reuse' ? 'flex.sum.gloss.guessReuse' : 'flex.sum.gloss.guessNew') : 'flex.sum.gloss.' + s.outcome, { n: s.otherUses || 0 })
      + (s.ws && s.ws.length ? ' — ' + T('flex.sum.inWs', { w: s.ws.map((w) => wsName(w, 'anal')).join(', ') }) : '')
      + (s.newWord ? ' ' + T('flex.sum.newWord') : '') + (s.approves ? ' ' + T('flex.sum.approves') : '');
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
  // the app's own indeterminate bar (the Matcher's audio note): "working", without an invented percentage
  wrap.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true"><h3>${esc(title)}</h3>
    <p class="flex-progress" role="status" aria-live="polite">…</p>
    <span class="seg-loading-bar is-indeterminate" aria-hidden="true"><i></i></span></div>`;
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
    const reading = working(T('flex.reading'));
    let pv;
    try { pv = await flex.importPreview(pick.path); } finally { reading(); }
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

/* ---- errors: stable codes → translated messages; a closed session says exactly what happened ---- */
function fail(e, afterWrite = false) {
  const msg = failMessage(e, afterWrite);
  H.toast(msg, flexClosedBy(e) ? 30000 : 12000);
  // the whole error, on one line, for the shell's console (native-flex mirrors console.warn there)
  let detail = '';
  try { detail = e && e.detail !== undefined ? ' | detail ' + JSON.stringify(e.detail) : ''; } catch { /* unserialisable */ }
  console.warn('[flex] ' + ((e && e.code) || 'E_INTERNAL') + ': ' + ((e && e.message) || e) + detail + ' | shown: ' + msg);
}
function failMessage(e, afterWrite = false) { return flexFailText(e, afterWrite, T); }
