/* ui.js — the recovery page: pick a folder, list the texts found, save them, and (once saved)
 * hand the app a link that removes them.
 *
 * ⚠ THIS PAGE NEVER WRITES TO THE BROWSER'S FILES. It reads a copy of them, or reads them in place
 * through a file picker, which is read-only by construction. Removing a text is done by the APP,
 * through its own long-standing `?cleanup=` link (app.js runTaskCleanup): the app asks on the
 * device before it deletes anything, shows how many texts it will remove, and deletes through its
 * own database code. Editing Chrome's LevelDB from outside while Chrome holds it open would corrupt
 * every text on the device, which is the opposite of recovery.
 *
 * The cleanup link matches texts by TITLE (case-insensitive), so this page only offers it for a text
 * whose title no other text on that site shares, and only while the text is unchanged since it was
 * saved here. Anything else would let the link remove a text nobody has saved.
 */
import { scanFiles, previewLines } from './recover.js';
import { buildBundle } from './bundle.js';
import * as engine from './engine.js';

/* global __RECOVERY_ENGINE_VERSION */
const ENGINE_VERSION = typeof __RECOVERY_ENGINE_VERSION === 'string' ? __RECOVERY_ENGINE_VERSION : 'dev';
const CLAIMS_KEY = 'flextext-recovery-claimed';

const $ = (sel, root = document) => root.querySelector(sel);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'value') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

/* ---------- claims: which texts this page has saved, remembered per browser ---------- */

function loadClaims() {
  try { return JSON.parse(localStorage.getItem(CLAIMS_KEY)) || {}; } catch { return {}; }
}
function saveClaims(c) {
  try { localStorage.setItem(CLAIMS_KEY, JSON.stringify(c)); } catch { /* private window: this visit only */ }
}
let claims = loadClaims();
const claimKey = (text) => `${text.area.origin}\n${text.id}`;
function markClaimed(text, filename) {
  claims[claimKey(text)] = { modified: text.modified, title: text.title, file: filename, at: Date.now() };
  saveClaims(claims);
}
function claimOf(text) { return claims[claimKey(text)] || null; }

/* Why the cleanup link may not be used for this text, or '' when it may. */
export function deleteBlocker(text, claim, allTexts) {
  if (!claim) return 'not saved yet';
  if ((claim.modified || 0) !== (text.modified || 0)) return 'changed since it was saved — save it again first';
  const title = text.title;
  if (!title) return 'has no title, so the app cannot be told which text to remove';
  if (title !== title.trim()) return 'its title starts or ends with a space, which the app\'s link cannot match';
  if (title.includes(',')) return 'its title contains a comma, which the app\'s link cannot carry';
  const same = allTexts.filter((t) => t !== text && t.title.toLowerCase() === title.toLowerCase());
  if (same.length) return `${same.length === 1 ? 'another text has' : `${same.length} other texts have`} the same title — the link would remove ${same.length === 1 ? 'it' : 'them'} too`;
  return '';
}

/* Where the app lives on an origin. The editor on the GitHub Pages estate is under
 * /flextext-editor/; every other estate serves its app at the origin root. Editable on the page. */
export function guessAppUrl(origin) {
  if (/^https:\/\/rulingants\.github\.io$/i.test(origin)) return origin + '/flextext-editor/';
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return origin + '/flextext-editor/';
  return origin + '/';
}
export function cleanupLink(appUrl, titles) {
  const u = new URL(appUrl);
  u.search = '';
  u.hash = '';
  return u.href + '?cleanup=' + encodeURIComponent(titles.join(','));
}

/* ---------- formatting ---------- */

const fmtDate = (ms) => ms ? new Date(ms).toLocaleString() : '—';
function fmtSize(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function status(msg, kind = '') {
  const el = $('#status');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = !msg;
}

/* ---------- reading the chosen folder ---------- */

let scan = null;

async function entriesFromDrop(items) {
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ path: prefix + entry.name, size: file.size, blob: file });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, prefix + entry.name + '/');
      }
    }
  };
  for (const it of items) {
    const e = it.webkitGetAsEntry && it.webkitGetAsEntry();
    if (e) await walk(e, '');
  }
  return out;
}

async function runScan(entries) {
  status(`Looking through ${entries.length.toLocaleString()} files…`);
  $('#results').replaceChildren();
  try {
    scan = await scanFiles(entries, { onProgress: (m) => status(m) });
  } catch (e) {
    status(`Could not read that folder: ${e.message}`, 'bad');
    return;
  }
  render();
}

/* ---------- saving ---------- */

async function bundleFor(text) {
  const b = await buildBundle(text, { engine, settings: text.area.settings, appKey: text.area.app.key, engineVersion: ENGINE_VERSION });
  const blob = b.zipped ? await b.zip() : b.blob;
  return { ...b, blob };
}

async function saveOne(text, btn) {
  btn.disabled = true;
  try {
    const b = await bundleFor(text);
    download(b.blob, b.filename);
    markClaimed(text, b.filename);
    const notes = [];
    if (b.missing.length) notes.push(`not found on disk: ${b.missing.join(', ')}`);
    if (b.trimmed.length) notes.push('the recording was too large to embed in the listening page / analysis file (it is still in the zip as its own file)');
    status(`Saved ${b.filename}${notes.length ? ' — ' + notes.join('; ') : ''}`, b.missing.length ? 'warn' : 'good');
  } catch (e) {
    status(`Could not build "${text.title || 'untitled'}": ${e.message}`, 'bad');
  } finally {
    btn.disabled = false;
    render();
  }
}

async function saveSelected(area, texts, btn) {
  if (!texts.length) return;
  btn.disabled = true;
  const entries = [];
  const used = new Set();
  const missing = [];
  try {
    for (const [i, text] of texts.entries()) {
      status(`Building ${i + 1} of ${texts.length}: ${text.title || 'untitled'}`);
      const b = await bundleFor(text);
      let name = b.filename;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = b.filename.replace(/(\.[a-z]+)$/i, ` (${n})$1`);
      used.add(name.toLowerCase());
      entries.push({ name, data: b.blob, text });
      if (b.missing.length) missing.push(`${name}: ${b.missing.join(', ')}`);
    }
    status('Packing…');
    const zip = await engine.makeZip(entries.map(({ name, data }) => ({ name, data })));
    const host = area.origin.replace(/^[a-z]+:\/\//i, '').replace(/[^\w.-]+/g, '_');
    download(zip, `Flextext recovery ${host} ${fileStamp()}.zip`);
    for (const e of entries) markClaimed(e.text, e.name);
    status(`Saved ${entries.length} text${entries.length === 1 ? '' : 's'} in one zip${missing.length ? ' — not found on disk: ' + missing.join('; ') : ''}`, missing.length ? 'warn' : 'good');
  } catch (e) {
    status(`Could not build the zip: ${e.message}`, 'bad');
  } finally {
    btn.disabled = false;
    render();
  }
}

/* ---------- the page ---------- */

function render() {
  const root = $('#results');
  root.replaceChildren();
  if (!scan) return;
  const { areas, problems, idbFolders, localStorageFolders } = scan;
  const nTexts = areas.reduce((n, a) => n + a.texts.length, 0);
  if (!areas.length) {
    status(idbFolders.length
      ? 'Found browser storage, but no Flextext texts in it. Is this the right browser profile?'
      : 'No IndexedDB folder in what was chosen. Choose the browser profile folder (see step 1).', 'bad');
  } else {
    status(`Found ${nTexts} text${nTexts === 1 ? '' : 's'} in ${areas.length} app${areas.length === 1 ? '' : 's'}.${localStorageFolders.length ? '' : ' (No "Local Storage" folder was included, so device settings could not be read — see the note under each app.)'}`, 'good');
  }
  for (const area of areas) root.append(renderArea(area));
  if (problems.length) {
    root.append(h('details', { class: 'problems' }, h('summary', {}, `${problems.length} note${problems.length === 1 ? '' : 's'} from reading the files`),
      h('ul', {}, problems.map((p) => h('li', {}, p)))));
  }
}

function renderArea(area) {
  const selected = new Set(area.texts.filter((t) => t.record && t.record.doc));
  const sec = h('section', { class: 'area' });
  const saveSel = h('button', { class: 'primary', onclick: (e) => saveSelected(area, [...selected], e.currentTarget) }, 'Save selected as one zip');
  const syncSel = () => { saveSel.textContent = `Save ${selected.size} selected as one zip`; saveSel.disabled = !selected.size; };
  sec.append(
    h('h2', {}, area.app.label),
    h('p', { class: 'meta' }, area.origin, ' · device settings ', area.settingsNote,
      area.blobFolder ? '' : ' · ⚠ no recordings folder found next to the database'),
  );
  const list = h('ul', { class: 'texts' });
  for (const text of area.texts) {
    const usable = !!(text.record && text.record.doc);
    const claim = claimOf(text);
    const cb = h('input', { type: 'checkbox', checked: usable, disabled: !usable, 'aria-label': 'select',
      onchange: (e) => { if (e.target.checked) selected.add(text); else selected.delete(text); syncSel(); } });
    const s = text.stats;
    const audio = text.media
      ? (text.media.blob ? `🔊 ${text.media.name || 'recording'} (${fmtSize(text.media.size)})` : `⚠ recording listed but its file is missing`)
      : 'no recording';
    const flags = [];
    if (text.done) flags.push('done');
    if (text.pending) flags.push('waiting to upload');
    if (text.fromOlder) flags.push('⚠ newest version unreadable — showing the one before');
    if (text.decodeError && !text.fromOlder) flags.push(`⚠ ${text.decodeError}`);
    if (claim) flags.push(claim.modified === text.modified ? `✓ saved ${fmtDate(claim.at)}` : '✎ changed since saved');
    const btn = h('button', { disabled: !usable, onclick: (e) => saveOne(text, e.currentTarget) }, 'Save');
    const preview = h('details', { class: 'preview' }, h('summary', {}, 'Preview'));
    preview.addEventListener('toggle', () => {
      if (!preview.open || preview.dataset.done) return;
      preview.dataset.done = '1';
      const lines = previewLines(text.record && text.record.doc, 200);
      preview.append(h('ol', {}, lines.map((l) => h('li', {},
        h('div', { class: 'bl' }, l.baseline || '·'),
        l.words.some((w) => w.gls) ? h('div', { class: 'gl' }, l.words.map((w) => `${w.txt}=${w.gls || '?'}`).join('  ')) : null,
        l.free ? h('div', { class: 'ft' }, l.free) : null))));
    });
    list.append(h('li', { class: claim && claim.modified === text.modified ? 'claimed' : '' },
      h('div', { class: 'row' }, cb,
        h('div', { class: 'what' },
          h('div', { class: 'title' }, text.title || '(untitled)'),
          h('div', { class: 'meta' }, `edited ${fmtDate(text.modified)} · ${s.lines} lines · ${s.words} words, ${s.glossed} glossed · ${s.freeTranslations} free translations · ${audio}`),
          flags.length ? h('div', { class: 'flags' }, flags.join(' · ')) : null),
        btn),
      usable ? preview : null));
  }
  syncSel();
  sec.append(h('div', { class: 'bar' }, saveSel), list);
  if (area.others.length) {
    sec.append(h('details', { class: 'others' }, h('summary', {}, `${area.others.length} other stored file${area.others.length === 1 ? '' : 's'} not attached to any text`),
      h('ul', {}, area.others.map((o) => h('li', {}, `${o.name || o.key} (${fmtSize(o.size)}) `,
        o.blob ? h('button', { onclick: () => download(o.blob, o.name || o.key.replace(/[^\w.-]+/g, '_')) }, 'Save') : '— file missing')))));
  }
  sec.append(renderDelete(area));
  return sec;
}

function renderDelete(area) {
  const claimed = area.texts.filter((t) => claimOf(t));
  const box = h('details', { class: 'delete' }, h('summary', {}, 'Remove saved texts from the app'));
  if (!claimed.length) {
    box.append(h('p', {}, 'Save a text first. Only texts saved with this page, and unchanged since, can be removed.'));
    return box;
  }
  const chosen = new Set();
  const rows = claimed.map((t) => {
    const why = deleteBlocker(t, claimOf(t), area.texts);
    if (!why) chosen.add(t);
    return h('li', { class: why ? 'blocked' : '' },
      h('label', {}, h('input', { type: 'checkbox', checked: !why, disabled: !!why,
        onchange: (e) => { if (e.target.checked) chosen.add(t); else chosen.delete(t); refresh(); } }),
      ` ${t.title || '(untitled)'}`), why ? h('span', { class: 'why' }, ` — ${why}`) : null);
  });
  const appUrl = h('input', { type: 'url', value: guessAppUrl(area.origin), size: 48, oninput: () => refresh() });
  const checked = h('input', { type: 'checkbox', onchange: () => refresh() });
  const out = h('div', { class: 'link-out' });
  const refresh = () => {
    out.replaceChildren();
    if (!chosen.size) { out.append(h('p', {}, 'Nothing selected.')); return; }
    if (!checked.checked) { out.append(h('p', {}, 'Tick the box above once the saved files have been checked.')); return; }
    let link;
    try { link = cleanupLink(appUrl.value, [...chosen].map((t) => t.title)); }
    catch { out.append(h('p', { class: 'why' }, 'That app address is not a valid web address.')); return; }
    const n = chosen.size;
    const shortcut = new Blob([`[InternetShortcut]\r\nURL=${link}\r\n`], { type: 'application/octet-stream' });
    out.append(
      h('p', {}, `Open this link in the browser on the device that holds the texts. The app will ask "This link will delete ${n} text(s) already on this device. Continue?" — `,
        h('strong', {}, `if the number is not ${n}, press Cancel.`), ' Removal cannot be undone in the app.'),
      h('div', { class: 'link' }, h('a', { href: link, target: '_blank', rel: 'noopener' }, link)),
      h('div', { class: 'bar' },
        h('button', { onclick: async (e) => {
          try { await navigator.clipboard.writeText(link); e.currentTarget.textContent = 'Copied'; }
          catch { e.currentTarget.textContent = 'Copy failed — select the link instead'; }
        } }, 'Copy link'),
        h('button', { onclick: () => download(shortcut, `Remove ${n} saved Flextext text${n === 1 ? '' : 's'}.url`) }, 'Save as a shortcut file')));
  };
  box.append(
    h('p', {}, 'The app removes these itself, after asking on the device. This page never changes the browser\'s files. Before removing anything:'),
    h('ol', {},
      h('li', {}, 'Open the saved files (in FLEx, or a text editor) and check that they are complete.'),
      h('li', {}, 'Make sure nobody has edited these texts since this folder was read. If unsure, close the app, choose the folder again, and come back here — a text edited since it was saved will be refused.')),
    h('ul', { class: 'claims' }, rows),
    h('p', {}, h('label', {}, 'App address: ', appUrl)),
    h('p', {}, h('label', {}, checked, ' I have opened the saved files and they are complete.')),
    out);
  refresh();
  return box;
}

function init() {
  $('#engine').textContent = ENGINE_VERSION;
  const input = $('#folder');
  input.addEventListener('change', () => {
    const files = [...input.files].map((f) => ({ path: f.webkitRelativePath || f.name, size: f.size, blob: f }));
    if (files.length) runScan(files);
    input.value = '';
  });
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const entries = await entriesFromDrop([...e.dataTransfer.items]);
    if (entries.length) runScan(entries);
  });
  $('#forget').addEventListener('click', () => {
    if (!confirm('Forget which texts this page has saved? Removal will be offered again only after saving them again.')) return;
    claims = {};
    saveClaims(claims);
    render();
  });
}

if (typeof document !== 'undefined') init();
