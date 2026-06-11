/* app.js — UI controller for the FlexText interlinear editor PWA. */

import {
  parseFlextext, serializeFlextext, makeDoc, makeWord, makeSegment,
  getBaselineParagraphs, reconcileBaseline, segmentText, tokenize,
  canMerge, mergeWords, breakPhrase, newGuid,
  surveyWritingSystems, remapWritingSystems,
} from './flextext.js';
import * as db from './db.js';
import { t, getLang, setLang, applyI18n, LANGS } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------------- Settings (writing systems) ---------------- */

const SETTINGS_KEY = 'flextext-ws-settings';

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch { return {}; }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// Apply settings arriving via shared setup URL (?vern=fau&vernName=Fayu...&lang=id)
function applyUrlSettings() {
  const p = new URLSearchParams(location.search);
  if (p.has('lang')) setLang(p.get('lang'));
  if (!p.has('vern') && !p.has('anal')) {
    if (p.has('lang')) history.replaceState(null, '', location.pathname);
    return false;
  }
  const s = loadSettings();
  const map = { vern: 'vernLang', vernName: 'vernName', vernFont: 'vernFont',
                anal: 'analLang', analName: 'analName', analFont: 'analFont' };
  for (const [qp, key] of Object.entries(map)) {
    if (p.has(qp)) s[key] = p.get(qp);
  }
  saveSettings(s);
  history.replaceState(null, '', location.pathname);
  return true;
}

/* ---------------- App state ---------------- */

let settings = loadSettings();
let current = null;          // { id, title, created, modified, doc }
let activeTab = 'baseline';
let saveTimer = null;
let helpReturnView = 'texts';

/* ---------------- Toast ---------------- */

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ---------------- View switching ---------------- */

const VIEWS = ['texts', 'baseline', 'gloss', 'research', 'help'];

function currentView() {
  return VIEWS.find(v => !$('#view-' + v).hidden) || 'texts';
}

function show(view) {
  for (const v of VIEWS) $('#view-' + v).hidden = v !== view;
  const inEditor = view === 'baseline' || view === 'gloss' ||
    (view === 'help' && (helpReturnView === 'baseline' || helpReturnView === 'gloss'));
  $('#topbar-home').hidden = inEditor;
  $('#topbar-editor').hidden = !inEditor;
  if (!inEditor) {
    $$('#topbar-home .top-tab').forEach(b =>
      b.setAttribute('aria-selected', String(b.dataset.view === view)));
  } else {
    $$('#topbar-editor .top-tab').forEach(b =>
      b.setAttribute('aria-selected', String(b.dataset.tab === view)));
  }
}

function openHelp() {
  helpReturnView = currentView();
  if (helpReturnView === 'help') helpReturnView = 'texts';
  show('help');
}

function closeHelp() {
  if (helpReturnView === 'gloss' || helpReturnView === 'baseline') {
    if (current) { switchTab(helpReturnView); return; }
    helpReturnView = 'texts';
  }
  if (helpReturnView === 'research') { fillWsForm(); show('research'); }
  else { renderDocList(); show('texts'); }
}

/* ---------------- Document library ---------------- */

async function renderDocList() {
  const docs = await db.listDocs();
  const ul = $('#doc-list');
  ul.innerHTML = '';
  $('#doc-list-empty').hidden = docs.length > 0;
  for (const d of docs) {
    const li = document.createElement('li');
    const date = d.modified ? new Date(d.modified).toLocaleString() : '';
    li.innerHTML = `
      <button class="doc-open">
        <span class="doc-name"></span>
        <span class="doc-meta"></span>
      </button>
      <button class="doc-delete icon-btn"></button>`;
    li.querySelector('.doc-name').textContent = d.title || t('untitled');
    li.querySelector('.doc-meta').textContent =
      t('texts.meta', { n: d.segCount ?? 0, g: d.glossed ?? 0, date });
    const del = li.querySelector('.doc-delete');
    del.title = t('texts.deleteTitle');
    del.innerHTML = '&#128465;';
    li.querySelector('.doc-open').addEventListener('click', () => openDoc(d.id));
    del.addEventListener('click', async () => {
      if (confirm(t('texts.confirmDelete', { title: d.title || t('untitled') }))) {
        await db.deleteDoc(d.id);
        renderDocList();
      }
    });
    ul.appendChild(li);
  }
  renderWsBanner();
}

function renderWsBanner() {
  const el = $('#ws-banner');
  el.hidden = false;
  if (settings.vernLang) {
    el.textContent = t('banner.set', {
      vern: `${settings.vernName || settings.vernLang} [${settings.vernLang}]`,
      anal: `${settings.analName || settings.analLang || 'en'} [${settings.analLang || 'en'}]`,
    });
  } else {
    el.innerHTML = t('banner.unset');
  }
}

async function newDoc() {
  const doc = makeDoc(settings);
  current = {
    id: newGuid(),
    title: '',
    created: Date.now(),
    modified: Date.now(),
    doc,
  };
  await persist();
  enterEditor('baseline');
}

async function openDoc(id) {
  const rec = await db.getDoc(id);
  if (!rec) { toast(t('toast.cantOpen')); return; }
  current = rec;
  enterEditor('baseline');
}

function docStats(doc) {
  let segCount = 0, glossed = 0;
  for (const p of doc.paragraphs) for (const s of p.segments) {
    if (s.words.length || s.baseline.trim()) segCount++;
    for (const w of s.words) if (!w.punct && w.gls) glossed++;
  }
  return { segCount, glossed };
}

async function persist() {
  if (!current) return;
  current.modified = Date.now();
  current.title = $('#doc-title').value.trim() || current.title || '';
  if (!$('#view-texts').hidden) return;
  Object.assign(current, docStats(current.doc));
  current.doc.title = current.title;
  await db.putDoc(current);
}

function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(
    () => persist().catch(e => toast(t('toast.autosaveFailed', { msg: e.message }))),
    400);
}

/* ---------------- Import ---------------- */

async function importFile(file) {
  const text = await file.text();
  const { texts, error } = parseFlextext(text);
  if (error) { toast(t('toast.importFailed', { msg: error }), 6000); return; }
  let lastId = null;
  for (const doc of texts) {
    const rec = {
      id: newGuid(),
      title: doc.title || file.name.replace(/\.(flextext|xml)$/i, ''),
      created: Date.now(),
      modified: Date.now(),
      doc,
    };
    Object.assign(rec, docStats(doc));
    await db.putDoc(rec);
    lastId = rec.id;
  }
  if (texts.length > 1) {
    toast(t('toast.importedMany', { n: texts.length, name: file.name }), 6000);
    renderDocList();
  } else {
    await openDoc(lastId);
    toast(t('toast.opened', { name: file.name }));
  }
}

/* ---------------- Editor ---------------- */

function enterEditor(tab) {
  $('#doc-title').value = current.title || '';
  switchTab(tab);
}

function switchTab(tab) {
  // Leaving baseline: apply baseline edits to the model first.
  if (activeTab === 'baseline' && !$('#view-baseline').hidden) {
    applyBaseline();
  }
  activeTab = tab;
  if (tab === 'baseline') {
    $('#baseline-text').value = getBaselineParagraphs(current.doc).join('\n');
    show('baseline');
    if (settings.vernFont) $('#baseline-text').style.fontFamily = quoteFont(settings.vernFont);
  } else {
    renderGloss();
    show('gloss');
  }
}

function applyBaseline() {
  if (!current) return;
  const text = $('#baseline-text').value;
  const paras = text.split('\n').map(s => s.trim()).filter((s, i, arr) => s || arr.length === 1);
  const before = JSON.stringify(getBaselineParagraphs(current.doc));
  if (JSON.stringify(paras) === before) return;
  reconcileBaseline(current.doc, paras.length ? paras : ['']);
  schedulePersist();
}

function quoteFont(f) {
  return /[ ,]/.test(f) ? `"${f}", sans-serif` : `${f}, sans-serif`;
}

/* ---------------- Gloss tab rendering ---------------- */

function renderGloss() {
  const body = $('#gloss-body');
  body.innerHTML = '';
  const doc = current.doc;
  const vernFont = fontFor(doc, true);
  const analFont = fontFor(doc, false);
  let segnum = 0;
  let any = false;
  for (const para of doc.paragraphs) {
    for (const seg of para.segments) {
      if (!seg.words.length && !seg.baseline.trim()) continue;
      any = true;
      segnum++;
      body.appendChild(renderSegment(seg, segnum, vernFont, analFont));
    }
  }
  $('#gloss-empty').hidden = any;
}

function fontFor(doc, vernacular) {
  const fromDoc = (doc.languages || []).find(l => !!l.vernacular === vernacular && l.font);
  const f = fromDoc?.font || (vernacular ? settings.vernFont : settings.analFont);
  return f ? quoteFont(f) : '';
}

function renderSegment(seg, segnum, vernFont, analFont) {
  const div = document.createElement('div');
  div.className = 'segment';

  const row = document.createElement('div');
  row.className = 'word-row';
  const num = document.createElement('span');
  num.className = 'segnum';
  num.textContent = segnum;
  row.appendChild(num);

  // Line-label gutter (Word/Gloss — Asli/Harfiah), aligned with the two
  // lines of the first word cell. Labels appear once per sentence.
  const labels = document.createElement('div');
  labels.className = 'line-labels';
  const lw = document.createElement('span');
  lw.className = 'line-label line-label-word';
  lw.textContent = t('gloss.wordLabel');
  const lg = document.createElement('span');
  lg.className = 'line-label line-label-gloss';
  lg.textContent = t('gloss.glossLabel');
  labels.append(lw, lg);
  row.appendChild(labels);

  seg.words.forEach((w, i) => {
    if (w.punct) {
      const cell = document.createElement('div');
      cell.className = 'word-cell punct-cell';
      const t2 = document.createElement('div');
      t2.className = 'word-txt punct';
      if (vernFont) t2.style.fontFamily = vernFont;
      t2.textContent = w.txt;
      cell.appendChild(t2);
      row.appendChild(cell);
    } else {
      row.appendChild(renderWordCell(seg, w, i, vernFont, analFont));
    }
    // Chain-link toggle between this word and the next.
    if (canMerge(seg, i)) {
      const link = document.createElement('button');
      link.className = 'chain-btn';
      link.title = t('gloss.chainTitle');
      link.textContent = '🔗';
      link.addEventListener('click', () => {
        mergeWords(seg, i);
        schedulePersist();
        renderGloss();
      });
      row.appendChild(link);
    }
  });
  div.appendChild(row);

  // Free translation line.
  const freeRow = document.createElement('div');
  freeRow.className = 'free-row';
  const label = document.createElement('span');
  label.className = 'free-label';
  label.textContent = t('gloss.freeLabel');
  const input = document.createElement('input');
  input.className = 'free-input';
  input.placeholder = t('gloss.freePlaceholder');
  input.value = seg.free || '';
  if (analFont) input.style.fontFamily = analFont;
  input.addEventListener('input', () => { seg.free = input.value; schedulePersist(); });
  freeRow.append(label, input);
  div.appendChild(freeRow);
  return div;
}

function renderWordCell(seg, w, i, vernFont, analFont) {
  const cell = document.createElement('div');
  cell.className = 'word-cell' + (w.phrase ? ' phrase-cell' : '');

  const t2 = document.createElement('div');
  t2.className = 'word-txt';
  if (vernFont) t2.style.fontFamily = vernFont;
  t2.textContent = w.txt;
  cell.appendChild(t2);

  const g = document.createElement('input');
  g.className = 'gloss-input';
  g.value = w.gls || '';
  g.placeholder = '—';
  g.autocapitalize = 'off';
  g.autocomplete = 'off';
  g.spellcheck = false;
  if (analFont) g.style.fontFamily = analFont;
  sizeInput(g);
  g.addEventListener('input', () => { w.gls = g.value; sizeInput(g); schedulePersist(); });
  g.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      focusNextGloss(g, e.shiftKey ? -1 : 1);
    }
  });
  cell.appendChild(g);

  if (w.phrase) {
    const un = document.createElement('button');
    un.className = 'unchain-btn';
    un.title = t('gloss.breakTitle');
    un.textContent = t('gloss.breakLabel');
    un.addEventListener('click', () => {
      breakPhrase(seg, i);
      schedulePersist();
      renderGloss();
    });
    cell.appendChild(un);
  }
  return cell;
}

function sizeInput(input) {
  const len = Math.max(input.value.length, input.placeholder.length, 3);
  input.style.width = (len + 2) + 'ch';
}

function focusNextGloss(fromInput, dir) {
  const all = $$('#gloss-body .gloss-input, #gloss-body .free-input');
  const idx = all.indexOf(fromInput);
  const next = all[idx + dir];
  if (next) { next.focus(); next.select?.(); }
}

/* ---------------- Save and send ---------------- */

function exportBlob() {
  if (activeTab === 'baseline') applyBaseline();
  current.doc.title = $('#doc-title').value.trim() || current.title || 'Untitled';
  const xml = serializeFlextext(current.doc, settings);
  return new Blob([xml], { type: 'application/xml' });
}

function exportFilename() {
  const t2 = ($('#doc-title').value.trim() || current.title || 'text')
    .replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
  return t2 + '.flextext';
}

function openShareMenu() {
  persist();
  const name = exportFilename();
  $('#share-filename').textContent = name;
  const blob = exportBlob();
  const file = new File([blob], name, { type: 'application/xml' });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  $('#share-share').hidden = !canShare;
  $('#share-saveas').hidden = !window.showSaveFilePicker;
  $('#share-menu').hidden = false;

  $('#share-share').onclick = async () => {
    try {
      await navigator.share({ files: [file], title: name });
      closeShareMenu();
    } catch (e) {
      if (e.name !== 'AbortError') toast(t('toast.shareFailed', { msg: e.message }));
    }
  };
  $('#share-saveas').onclick = async () => {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'FLEx interlinear text', accept: { 'application/xml': ['.flextext'] } }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      closeShareMenu();
      toast(t('toast.saved'));
    } catch (e) {
      if (e.name !== 'AbortError') toast(t('toast.saveFailed', { msg: e.message }));
    }
  };
  $('#share-download').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    closeShareMenu();
  };
  $('#share-cancel').onclick = closeShareMenu;
}

function closeShareMenu() { $('#share-menu').hidden = true; }

/* ---------------- Research tab ---------------- */

function fillWsForm() {
  const f = $('#ws-form');
  for (const key of ['vernLang', 'vernName', 'vernFont', 'analLang', 'analName', 'analFont']) {
    if (f.elements[key]) f.elements[key].value = settings[key] || '';
  }
}

function setupResearch() {
  const f = $('#ws-form');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    for (const key of ['vernLang', 'vernName', 'vernFont', 'analLang', 'analName', 'analFont']) {
      settings[key] = f.elements[key].value.trim();
    }
    saveSettings(settings);
    renderWsBanner();
    toast(t('toast.settingsSaved'));
  });

  $('#btn-copy-link').addEventListener('click', async () => {
    const f2 = $('#ws-form');
    const p = new URLSearchParams();
    const map = { vernLang: 'vern', vernName: 'vernName', vernFont: 'vernFont',
                  analLang: 'anal', analName: 'analName', analFont: 'analFont' };
    for (const [key, qp] of Object.entries(map)) {
      const v = f2.elements[key].value.trim();
      if (v) p.set(qp, v);
    }
    if (!p.has('vern')) { toast(t('toast.needVern')); return; }
    p.set('lang', getLang());
    const url = location.origin + location.pathname + '?' + p.toString();
    const out = $('#share-link-out');
    out.hidden = false;
    out.textContent = url;
    try {
      await navigator.clipboard.writeText(url);
      toast(t('toast.linkCopied'));
    } catch {
      toast(t('toast.linkCopyManual'));
    }
  });

  // Writing system checker
  let wsState = null; // { dom, rows, filename }
  $('#btn-wscheck').addEventListener('click', () => $('#wscheck-file').click());
  $('#wscheck-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const res = surveyWritingSystems(text);
    if (res.error) { toast(t('toast.importFailed', { msg: res.error }), 6000); return; }
    wsState = { dom: res.dom, rows: res.rows, filename: file.name };
    $('#wscheck-name').textContent = t('research.declared', {
      name: file.name,
      list: res.declared.length
        ? res.declared.map(l => `${l.lang}${l.vernacular ? ' ★' : ''}`).join(', ')
        : t('research.noneDeclared'),
    });
    const tbody = $('#wscheck-rows');
    tbody.innerHTML = '';
    for (const r of res.rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td></td><td><code></code></td><td></td>
        <td><input class="ws-newcode" spellcheck="false"></td>`;
      tr.children[0].textContent = t(r.label);
      tr.children[1].firstChild.textContent = r.lang;
      tr.children[2].textContent = r.count;
      const inp = tr.querySelector('input');
      inp.placeholder = t('ws.keepPh');
      inp.dataset.selector = r.selector;
      inp.dataset.fromLang = r.lang;
      tbody.appendChild(tr);
    }
    $('#wscheck-result').hidden = false;
  });

  $('#btn-wsapply').addEventListener('click', () => {
    if (!wsState) return;
    const mappings = $$('#wscheck-rows .ws-newcode')
      .filter(inp => inp.value.trim())
      .map(inp => ({ selector: inp.dataset.selector, fromLang: inp.dataset.fromLang, toLang: inp.value.trim() }));
    const xml = '<?xml version="1.0" encoding="utf-8"?>\n' +
      remapWritingSystems(wsState.dom, mappings).replace(/^<\?xml[^>]*\?>\s*/i, '');
    const blob = new Blob([xml], { type: 'application/xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = wsState.filename.replace(/(\.flextext|\.xml)?$/i, (m) => m || '.flextext');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    toast(mappings.length ? t('toast.corrected') : t('toast.noChanges'));
  });
}

/* ---------------- Service worker & updates ----------------
 * Cache-first shell: clients only change app version when a new service
 * worker (with a bumped VERSION in sw.js) is installed. We actively check
 * for that whenever the app loads or returns to the foreground, and show
 * an Update button when a new version is waiting.
 */

function setupServiceWorker() {
  const isDev = ['localhost', '127.0.0.1'].includes(location.hostname) &&
    !new URLSearchParams(location.search).has('sw');
  if (!('serviceWorker' in navigator) || isDev) return;

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  navigator.serviceWorker.register('sw.js').then((reg) => {
    const check = () => reg.update().catch(() => {});
    reg.active?.postMessage({ type: 'CLEANUP' });
    // A waiting worker means a new version is already downloaded.
    if (reg.waiting && navigator.serviceWorker.controller) promptUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) promptUpdate(nw);
      });
    });
    // Check on load, when the app returns to the foreground, when the
    // network comes back, and hourly while open.
    check();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    window.addEventListener('online', check);
    setInterval(check, 60 * 60 * 1000);
  }).catch(() => {});
}

function promptUpdate(waitingWorker) {
  const el = $('#toast');
  clearTimeout(toastTimer);
  el.textContent = t('update.available') + ' ';
  const b = document.createElement('button');
  b.className = 'toast-btn';
  b.textContent = t('update.now');
  b.addEventListener('click', () => {
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  });
  el.appendChild(b);
  el.hidden = false; // stays until acted on or page reload
}

/* ---------------- Wire-up ---------------- */

function setup() {
  const gotSetup = applyUrlSettings();
  settings = loadSettings();
  applyI18n();

  const langSel = $('#lang-select');
  langSel.value = getLang();
  langSel.addEventListener('change', () => {
    setLang(langSel.value);
    applyI18n();
    renderDocList();
    if (!$('#view-gloss').hidden) renderGloss();
  });

  $$('#topbar-home .top-tab').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.view === 'research') { fillWsForm(); show('research'); }
    else { renderDocList(); show('texts'); }
  }));
  $$('#topbar-editor .top-tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  $('#btn-back').addEventListener('click', async () => {
    if (activeTab === 'baseline') applyBaseline();
    await persist();
    current = null;
    renderDocList();
    show('texts');
  });

  $('#btn-help-home').addEventListener('click', openHelp);
  $('#btn-help-editor').addEventListener('click', openHelp);
  $('#btn-help-close').addEventListener('click', closeHelp);

  $('#doc-title').addEventListener('input', schedulePersist);
  $('#btn-new').addEventListener('click', () => newDoc());
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importFile(f).catch(err => toast(t('toast.importFailed', { msg: err.message }), 6000));
  });
  $('#baseline-text').addEventListener('blur', () => { applyBaseline(); });
  $('#btn-share').addEventListener('click', openShareMenu);
  $('#share-menu').addEventListener('click', (e) => { if (e.target === $('#share-menu')) closeShareMenu(); });

  setupResearch();
  renderDocList();
  show('texts');
  if (gotSetup) {
    toast(t('toast.setupReceived'), 5000);
  }

  setupServiceWorker();
}

setup();

// Expose internals for testing in the console.
window.__flextext = { parseFlextext, serializeFlextext, reconcileBaseline, segmentText, tokenize, getBaselineParagraphs, makeDoc };
window.__app = {
  get current() { return current; },
  get settings() { return settings; },
  exportXml() { return serializeFlextext(current.doc, settings); },
  applyBaseline,
};
