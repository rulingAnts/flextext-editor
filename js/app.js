/* app.js — UI controller for the Flextext Editor PWA. */

import {
  parseFlextext, serializeFlextext, makeDoc, makeWord, makeSegment,
  getBaselineParagraphs, reconcileBaseline, segmentText, tokenize,
  canMerge, mergeWords, breakPhrase, newGuid,
  surveyWritingSystems, remapWritingSystems,
} from './flextext.js';
import * as db from './db.js';
import { t, getLang, setLang, applyI18n, LANGS } from './i18n.js';
import { Player, downloadAudioForDoc, getDownload, clearPartial, driveFileId, isProbablyUrl, probeAudioUrl, ensureAsset, getAsset } from './audio.js';
import { convertToMp3 } from './convert.js';
import { makeZip } from './zip.js';
import { DriveUpload, driveFolderId as parseDriveFolder, getUpload, listPendingUploads } from './upload.js';
import { esc, newGuid as mkGuid } from './flextext.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Default Google Drive relay (docs/drive-relay.gs) used for Drive share links
// when the researcher hasn't configured their own. The relay is permissionless
// (it can only fetch link-shared files), so sharing one deployment is safe.
const DEFAULT_RELAY = 'https://script.google.com/macros/s/AKfycbxMQbP4Qij5dCWwQd-FoQJstVYEnjyG1ONwcaQ5CUccd-pUmXGGTCpQ9rZieJY0PE5GUg/exec';

/* ---------------- Settings (writing systems) ---------------- */

const SETTINGS_KEY = 'flextext-ws-settings';

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch { return {}; }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// One-time normalization. Older builds stored the researcher's send-option
// checkboxes in `sendOptions`, which doubled as a restriction on THIS device.
// Now the checkboxes are a link TEMPLATE (`linkSendOptions`) and a device is
// only restricted by a limit it RECEIVED via a link. Move the old value to the
// template and clear the self-restriction. Runs before any link is processed.
function migrateSettings() {
  const s = loadSettings();
  if (s.linkSendOptions === undefined) {
    if (s.sendOptions?.length) s.linkSendOptions = s.sendOptions;
    delete s.sendOptions;
    saveSettings(s);
  }
}

// Apply settings arriving via shared setup URL (?vern=fau&vernName=Fayu...&lang=id),
// and consume task parameters (?title=...&audio=...). Returns
// { gotSettings, task: {title, audioUrl} | null }.
function applyUrlSettings() {
  const p = new URLSearchParams(location.search);
  if (p.has('lang')) setLang(p.get('lang'));
  if (p.get('research') === 'off') localStorage.setItem(RESEARCH_HIDDEN_KEY, '1');
  if (p.get('research') === 'on') localStorage.removeItem(RESEARCH_HIDDEN_KEY);
  const gotSettings = p.has('vern') || p.has('anal');
  if (gotSettings) {
    const s = loadSettings();
    const map = { vern: 'vernLang', vernName: 'vernName', vernFont: 'vernFont',
                  anal: 'analLang', analName: 'analName', analFont: 'analFont' };
    for (const [qp, key] of Object.entries(map)) {
      if (p.has(qp)) s[key] = p.get(qp);
    }
    if (p.has('upload')) s.uploadFolder = p.get('upload').replace(/[^\w-]/g, '');
    if (p.has('send')) {
      s.sendOptions = p.get('send').split(',')
        .filter(o => ['share', 'upload', 'save', 'download'].includes(o));
    }
    if (p.has('consentMode')) {
      const m = p.get('consentMode');
      s.consentMode = ['off', 'text', 'audio'].includes(m) ? m : 'off';
    }
    if (p.has('consentMsg')) s.consentMsg = p.get('consentMsg');
    if (p.has('consentAudio')) s.consentAudio = p.get('consentAudio');
    if (p.has('consentResp')) s.consentResp = p.get('consentResp') === 'record' ? 'record' : 'yesno';
    saveSettings(s);
  }
  const task = (p.has('audio') || p.has('title'))
    ? { title: p.get('title') || '', audioUrl: p.get('audio') || '' }
    : null;
  if (gotSettings || task || p.has('lang') || p.has('research')) {
    history.replaceState(null, '', location.pathname);
  }
  return { gotSettings, task };
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
  applyHelpResearchVisibility();
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
    () => persist().catch(e => toast(
      e && e.name === 'QuotaExceededError'
        ? t('toast.storageFull')
        : t('toast.autosaveFailed', { msg: e.message }),
      8000)),
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
  updateShareButton();
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
    refreshPlayer();
  } else {
    renderGloss();
    show('gloss');
  }
}

/* ---------------- Audio player (Baseline tab) ---------------- */

let player = null;
let playerDocId = null;

function getPlayer() {
  if (!player) {
    player = new Player($('#audio-player'), {
      labels: {
        get preparing() { return t('player.preparing'); },
        get error() { return t('player.error'); },
      },
      onPeaks: (media) => { db.putMedia(playerDocId, media).catch(() => {}); },
      onRemove: async () => {
        if (!current || isAudioLocked(current)) return;
        if (!confirm(t('player.confirmRemove'))) return;
        await db.deleteMedia(current.id);
        delete current.pendingAudio;
        delete current.audioSource;
        delete current.mediaGuid;
        current.doc.mediaXML = [];
        await persist();
        refreshPlayer();
      },
    });
  }
  return player;
}

// Audio that arrived via a researcher's task link can't be removed by the
// coworker. (The audioSource check covers texts created before this flag.)
function isAudioLocked(rec) {
  return !!rec.audioLocked ||
    !!(rec.audioSource && /^https?:/i.test(rec.audioSource));
}

// Show/refresh the player for the current doc on the Baseline tab.
async function refreshPlayer() {
  const p = getPlayer();
  $('#btn-attach-audio').hidden = true;
  if (!current) { p.hide(); return; }
  playerDocId = current.id;
  const media = await db.getMedia(current.id).catch(() => null);
  if (current.id !== playerDocId || activeTab !== 'baseline') return;
  p.el.remove.hidden = isAudioLocked(current);
  if (media) {
    updateDlControls('done');
    // Re-load only when switching docs (avoid resetting playback position).
    if (p.loadedFor !== current.id) {
      p.loadedFor = current.id;
      await p.load(media);
    } else {
      p.root.hidden = false;
    }
  } else if (current.pendingAudio) {
    p.loadedFor = null;
    const dl = getDownload(current.id);
    if (dl && dl.status === 'downloading') {
      updateDlControls('downloading');
      if (dl.total) {
        const pct = Math.min(99, Math.round((dl.received / dl.total) * 100));
        p.showProgress(t('player.downloading', { pct, got: mbFmt(dl.received), size: mbFmt(dl.total) }), pct / 100);
      } else {
        p.showProgress(t('player.downloadingBytes', { got: mbFmt(dl.received) }), null);
      }
    } else if (dl && dl.status === 'paused') {
      updateDlControls('paused');
      p.showProgress(
        dl.storageIssue
          ? t('player.storagePaused')
          : t('player.pausedAt', { got: mbFmt(dl.received), size: dl.total ? mbFmt(dl.total) : '?' }),
        dl.total ? dl.received / dl.total : 0);
    } else {
      updateDlControls('idle-pending');
      p.showPending(current.audioError || t('player.pending'));
    }
  } else {
    p.loadedFor = null;
    updateDlControls('done');
    p.hide();
    $('#btn-attach-audio').hidden = false;
  }
}

// Ensure the exported flextext references the attached audio.
function ensureMediaRef(rec, name, sourceUrl) {
  if (!rec.mediaGuid) rec.mediaGuid = mkGuid();
  const location = sourceUrl && isProbablyUrl(sourceUrl) ? sourceUrl : (name || 'audio');
  rec.doc.mediaXML = [
    `<media-files offset-type="milliseconds">\n  <media guid="${esc(rec.mediaGuid)}" location="${esc(location)}" />\n</media-files>`,
  ];
}

// Transcriber-initiated: pick an audio file, get a new text with the
// recording loaded in the player, ready to title and type.
async function newDocFromAudio(file, titleOverride) {
  const doc = makeDoc(settings, titleOverride ?? file.name.replace(/\.[^.]+$/, ''));
  current = {
    id: newGuid(),
    title: doc.title,
    created: Date.now(),
    modified: Date.now(),
    doc,
  };
  enterEditor('baseline');
  await attachAudioFile(file);
  // If a recorded verbal assent was captured in the consent gate, store it
  // with this doc so it travels in the upload/save zip bundle.
  if (pendingAssent) {
    current.consentClip = pendingAssent.name;
    await db.putMedia('consent:' + current.id, pendingAssent).catch(() => {});
    await persist();
    pendingAssent = null;
  }
  $('#doc-title').focus();
  $('#doc-title').select();
}

/* ---------------- Speaker-permission (consent) gate ----------------
 * App-wide Research setting. Before recording a new text, optionally show a
 * written or spoken reminder and collect either a Yes/No tap or a recorded
 * verbal "yes". A recorded assent is bundled with the text (separate from
 * the transcription audio) at save time.
 */

let pendingAssent = null; // { blob, name } captured assent, consumed on doc create
let crec = null;          // consent-assent recorder state

// Keep the cached consent-prompt audio in sync with the researcher's URL.
async function syncConsentAudio() {
  if (settings.consentMode === 'audio' && settings.consentAudio) {
    try { await ensureAsset('asset:consent-prompt', settings.consentAudio); }
    catch { /* will retry next time; consent can still show text fallback */ }
  }
}

function discardConsentRec() {
  if (crec) {
    try { if (crec.recorder && crec.recorder.state !== 'inactive') crec.recorder.stop(); } catch { /* noop */ }
    crec.stream?.getTracks().forEach(tr => tr.stop());
    if (crec.url) URL.revokeObjectURL(crec.url);
  }
  crec = null;
  const pv = $('#consent-assent-preview');
  pv.pause?.(); pv.removeAttribute('src'); pv.hidden = true;
}

function closeConsentModal() {
  discardConsentRec();
  const ca = $('#consent-audio');
  ca.pause?.(); ca.removeAttribute('src');
  $('#consent-modal').hidden = true;
}

// Run `onApproved(assent)` once permission is satisfied. assent is a
// { blob, name } when recorded, else null.
async function requestConsentThen(onApproved) {
  const mode = settings.consentMode || 'off';
  if (mode === 'off') { onApproved(null); return; }
  pendingAssent = null;

  const msgEl = $('#consent-message');
  const audioEl = $('#consent-audio');
  const status = $('#consent-status');
  status.hidden = true;
  msgEl.hidden = mode !== 'text' && !settings.consentMsg;
  msgEl.textContent = settings.consentMsg || '';
  audioEl.hidden = true;

  if (mode === 'audio') {
    status.hidden = false;
    status.textContent = t('consent.loadingAudio');
    try {
      const asset = await ensureAsset('asset:consent-prompt', settings.consentAudio)
        || await getAsset('asset:consent-prompt');
      if (asset?.blob) {
        audioEl.src = URL.createObjectURL(asset.blob);
        audioEl.hidden = false;
        status.hidden = true;
        audioEl.play?.().catch(() => {});
      } else {
        status.textContent = t('consent.audioFailed');
      }
    } catch {
      status.textContent = t('consent.audioFailed');
    }
    if (settings.consentMsg) { msgEl.hidden = false; }
  }

  const respRecord = settings.consentResp === 'record';
  $('#consent-yesno').hidden = respRecord;
  $('#consent-record').hidden = !respRecord;
  resetConsentRecordUI();

  $('#consent-modal').hidden = false;

  const proceed = (assent) => { pendingAssent = assent; closeConsentModal(); onApproved(assent); };

  $('#consent-yes').onclick = () => proceed(null);
  $('#consent-no').onclick = () => { closeConsentModal(); toast(t('consent.declined'), 5000); };
  $('#consent-cancel').onclick = () => closeConsentModal();
  $('#consent-modal').onclick = (e) => { if (e.target === $('#consent-modal')) closeConsentModal(); };
  $('#consent-assent-continue').onclick = async () => {
    if (!crec?.blob) return;
    try {
      const conv = settings.convert || {};
      const res = await convertToMp3(crec.blob,
        { kbps: conv.kbps || 64, sampleRate: conv.rate || 22050, mono: conv.mono !== false });
      proceed({ blob: res.blob, name: 'consent-' + fileStamp() + '.mp3' });
    } catch {
      proceed({ blob: crec.blob, name: 'consent-' + fileStamp() + '.webm' });
    }
  };
  $('#consent-assent-redo').onclick = () => { discardConsentRec(); resetConsentRecordUI(); };
  $('#consent-assent-toggle').onclick = () => {
    if (crec?.recorder && crec.recorder.state === 'recording') crec.recorder.stop();
    else startConsentAssent();
  };
}

function resetConsentRecordUI() {
  $('#consent-assent-toggle').hidden = false;
  $('#consent-assent-toggle').innerHTML = '&#9679; ' +
    `<span>${t('consent.recYes')}</span>`;
  $('#consent-assent-continue').hidden = true;
  $('#consent-assent-redo').hidden = true;
  $('#consent-assent-preview').hidden = true;
}

async function startConsentAssent() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
      : MediaRecorder.isTypeSupported('audio/ogg') ? 'audio/ogg' : '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    crec = { stream, recorder, chunks: [], blob: null, url: null };
    recorder.addEventListener('dataavailable', (e) => { if (e.data.size) crec?.chunks.push(e.data); });
    recorder.addEventListener('stop', () => {
      if (!crec) return;
      crec.stream.getTracks().forEach(tr => tr.stop());
      crec.blob = new Blob(crec.chunks, { type: recorder.mimeType || 'audio/webm' });
      crec.url = URL.createObjectURL(crec.blob);
      const pv = $('#consent-assent-preview');
      pv.src = crec.url; pv.hidden = false;
      $('#consent-assent-toggle').hidden = true;
      $('#consent-assent-continue').hidden = false;
      $('#consent-assent-redo').hidden = false;
      $('#consent-status').hidden = false;
      $('#consent-status').textContent = t('consent.assentReview');
    });
    recorder.start();
    $('#consent-assent-toggle').innerHTML = '&#9632; ' + `<span>${t('consent.recStop')}</span>`;
  } catch (e) {
    $('#consent-status').hidden = false;
    $('#consent-status').textContent = t('record.micError', { msg: e.message });
  }
}

/* ---------------- Record new text (microphone modal) ----------------
 * Record → review (listen, re-record as often as needed) → Save converts
 * the take to a small MP3 (using the converter preferences) and creates a
 * new text with it loaded in the player. Cancel/backdrop always cleans up
 * the microphone.
 */

let rec = null; // { stream, recorder, chunks, blob, url, timer, t0 }

function recordUI(state, extra = {}) {
  const status = $('#record-status');
  const toggle = $('#record-toggle');
  const inReview = state === 'review';
  toggle.hidden = inReview || state === 'saving';
  toggle.classList.toggle('recording', state === 'recording');
  $('#record-save').hidden = !inReview;
  $('#record-redo').hidden = !inReview;
  $('#record-preview').hidden = !inReview;
  // A title is required before the recording can be saved.
  $('#record-title-row').hidden = !inReview;
  if (state === 'idle') {
    toggle.textContent = t('record.start');
    status.textContent = t('record.idle');
  } else if (state === 'recording') {
    toggle.textContent = t('record.stop');
    status.textContent = t('record.recording', { time: extra.time || '0:00' });
  } else if (state === 'review') {
    status.textContent = t('record.review');
    syncRecordSaveEnabled();
    setTimeout(() => $('#record-title').focus(), 0);
  } else if (state === 'saving') {
    status.textContent = t('record.converting', { pct: extra.pct ?? 0 });
  }
}

// Save stays disabled until the user names the text.
function syncRecordSaveEnabled() {
  $('#record-save').disabled = !$('#record-title').value.trim();
}

function discardRecording() {
  if (rec) {
    try { if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop(); } catch { /* noop */ }
    rec.stream?.getTracks().forEach(tr => tr.stop());
    clearInterval(rec.timer);
    if (rec.url) URL.revokeObjectURL(rec.url);
  }
  rec = null;
  const pv = $('#record-preview');
  pv.pause?.();
  pv.removeAttribute('src');
}

function openRecordModal() {
  discardRecording();
  $('#record-title').value = '';
  recordUI('idle');
  $('#record-modal').hidden = false;
}

function closeRecordModal() {
  discardRecording();
  pendingAssent = null; // abandon any consent clip if the recording is cancelled
  $('#record-modal').hidden = true;
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
      : MediaRecorder.isTypeSupported('audio/ogg') ? 'audio/ogg' : '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec = { stream, recorder, chunks: [], t0: Date.now(), timer: null, blob: null, url: null };
    recorder.addEventListener('dataavailable', (e) => { if (e.data.size) rec?.chunks.push(e.data); });
    recorder.addEventListener('stop', () => {
      if (!rec) return; // cancelled
      rec.stream.getTracks().forEach(tr => tr.stop());
      clearInterval(rec.timer);
      rec.blob = new Blob(rec.chunks, { type: recorder.mimeType || 'audio/webm' });
      rec.url = URL.createObjectURL(rec.blob);
      $('#record-preview').src = rec.url;
      recordUI('review');
    });
    recorder.start();
    const fmtT = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s) % 60).padStart(2, '0');
    rec.timer = setInterval(
      () => recordUI('recording', { time: fmtT((Date.now() - rec.t0) / 1000) }), 250);
    recordUI('recording');
  } catch (e) {
    recordUI('idle');
    $('#record-status').textContent = t('record.micError', { msg: e.message });
  }
}

async function saveRecording() {
  if (!rec?.blob) return;
  const title = $('#record-title').value.trim();
  if (!title) { syncRecordSaveEnabled(); $('#record-title').focus(); return; } // title required
  const blob = rec.blob;
  recordUI('saving', { pct: 0 });
  try {
    const conv = settings.convert || {};
    const res = await convertToMp3(blob,
      { kbps: conv.kbps || 64, sampleRate: conv.rate || 22050, mono: conv.mono !== false },
      (f) => recordUI('saving', { pct: Math.round(f * 100) }));
    const stamp = fileStamp();
    const file = new File([res.blob], `recording-${stamp}.mp3`, { type: 'audio/mpeg' });
    const assent = pendingAssent;   // closeRecordModal clears it; preserve for the new doc
    closeRecordModal();
    pendingAssent = assent;
    await newDocFromAudio(file, title);
  } catch (e) {
    recordUI('review');
    $('#record-status').textContent = t('convert.failed', { msg: e.message });
  }
}

async function attachAudioFile(file) {
  if (!current) return;
  const media = {
    blob: file, name: file.name, mimeType: file.type || 'audio/mpeg',
    sourceUrl: '', peaks: null, duration: null,
  };
  await db.putMedia(current.id, media);
  current.audioSource = 'local:' + file.name;
  current.audioLocked = false; // user attached it themselves; they may remove it
  delete current.pendingAudio;
  ensureMediaRef(current, file.name, '');
  await persist();
  if (player) player.loadedFor = null;
  refreshPlayer();
}

// Mark a finished download on the doc record (idempotent). Runs from the
// download's state callback so it also fires for resumed/background loads.
async function finalizeAudioDownload(rec) {
  const url = rec.pendingAudio;
  if (!url) return;
  delete rec.pendingAudio;
  delete rec.audioError;
  const media = await db.getMedia(rec.id).catch(() => null);
  rec.audioSource = url;
  ensureMediaRef(rec, media?.name, media?.sourceUrl);
  rec.modified = Date.now();
  await db.putDoc(rec);
  if (current && current.id === rec.id) {
    current = rec;
    if (player) player.loadedFor = null;
    if (activeTab === 'baseline') refreshPlayer();
    toast(t('player.downloaded'));
  }
}

const mbFmt = (b) => (b / 1048576).toFixed(1);
const sizeFmt = (b) => b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : mbFmt(b) + ' MB';

function updateDlControls(status) {
  const box = $('#audio-player .player-dl-controls');
  const pauseBtn = box.querySelector('.player-dl-pause');
  const showing = status === 'downloading' || status === 'paused' || status === 'error' || status === 'idle-pending';
  box.hidden = !showing;
  if (showing) {
    pauseBtn.textContent = status === 'downloading' ? t('player.pauseDl') : t('player.resumeDl');
  }
}

// Live download feedback in the player area (only when the user is looking
// at the doc being downloaded).
function downloadStateHandler(rec) {
  let toastedStorage = false;
  return ({ status, received, total, storage, error }) => {
    if (status === 'done') finalizeAudioDownload(rec).catch(() => {});
    if (status === 'error' && error && rec.audioError !== error) {
      // Remember the reason so reopening the text still explains it.
      rec.audioError = error;
      db.putDoc(rec).catch(() => {});
    }
    if (storage && !toastedStorage) {
      toastedStorage = true;
      toast(t('toast.storageFull'), 9000);
    }
    if (!storage) toastedStorage = false;
    if (!current || rec.id !== current.id || activeTab !== 'baseline') return;
    const p = getPlayer();
    if (status === 'done') { updateDlControls('done'); return; }
    updateDlControls(status);
    if (status === 'downloading') {
      if (total) {
        const pct = Math.min(99, Math.round((received / total) * 100));
        p.showProgress(t('player.downloading', { pct, got: mbFmt(received), size: mbFmt(total) }), pct / 100);
      } else {
        p.showProgress(t('player.downloadingBytes', { got: mbFmt(received) }), null);
      }
    } else if (status === 'paused') {
      p.showProgress(
        storage
          ? t('player.storagePaused')
          : t('player.pausedAt', { got: mbFmt(received), size: total ? mbFmt(total) : '?' }),
        total ? received / total : 0);
    } else if (status === 'error') {
      // Show the real reason (e.g. "this is a WAV file…"), not a vague
      // "not downloaded yet".
      p.showPending(error || t('player.pending'));
    }
  };
}

// Download pending audio for a doc; on failure keep it pending for retry.
async function tryDownloadAudio(rec) {
  if (!rec.pendingAudio) return false;
  if (getDownload(rec.id)?.status === 'paused') return false; // user's pause stands
  delete rec.audioError; // fresh attempt, fresh verdict
  try {
    const media = await downloadAudioForDoc(rec, rec.pendingAudio, downloadStateHandler(rec));
    return !!media; // finalization happens in the state handler
  } catch (e) {
    if (e.storageFull || e.name === 'QuotaExceededError') {
      toast(t('toast.storageFull'), 8000);
    } else if (e.fatal && e.message) {
      // Surface the real reason (e.g. the relay refusing a WAV or an
      // oversized file) instead of a silent generic pending state.
      toast(e.message, 10000);
    }
    return false;
  }
}

// Retry pending downloads for all docs (app start / back online).
// User-paused downloads stay paused — resuming is their choice.
async function retryPendingAudio() {
  if (!navigator.onLine) return;
  const docs = await db.listDocs().catch(() => []);
  for (const d of docs) {
    if (getDownload(d.id)) continue; // already downloading or paused
    const rec = await db.getDoc(d.id);
    if (rec?.pendingAudio) await tryDownloadAudio(rec);
  }
}

/* ---------------- Task links (?title=...&audio=...) ---------------- */

async function openUrlTask(task) {
  // Re-opening the same task link must not duplicate the text.
  if (task.audioUrl) {
    const docs = await db.listDocs();
    for (const d of docs) {
      const rec = await db.getDoc(d.id);
      if (rec && (rec.audioSource === task.audioUrl || rec.pendingAudio === task.audioUrl)) {
        current = rec;
        enterEditor('baseline');
        toast(t('task.alreadyHere'), 4000);
        return;
      }
    }
  }
  const doc = makeDoc(settings, task.title);
  current = {
    id: newGuid(),
    title: task.title || '',
    created: Date.now(),
    modified: Date.now(),
    doc,
  };
  if (task.audioUrl) {
    current.pendingAudio = task.audioUrl;
    // Task-delivered audio is part of the assignment: the coworker can't remove it.
    current.audioLocked = true;
  }
  Object.assign(current, docStats(doc));
  current.doc.title = current.title;
  await db.putDoc(current);
  enterEditor('baseline');
  toast(t('task.received'), 5000);
  if (task.audioUrl) {
    const ok = await tryDownloadAudio(current);
    // Success and pause/error UI are painted by the download state handler;
    // only announce a failure the user didn't cause themselves.
    if (!ok && getDownload(current.id)?.status !== 'paused') {
      toast(t('player.downloadFailed'), 6000);
    }
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
        const a = seg.words[i], b = seg.words[i + 1];
        if (!confirm(t('gloss.confirmMerge', { a: a.txt, b: b.txt }))) return;
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
    } else if (e.key === 'Tab') {
      // Tab / Shift+Tab move between word glosses (skipping free-translation
      // lines), like FLEx.
      e.preventDefault();
      focusNextWordGloss(g, e.shiftKey ? -1 : 1);
    } else if (e.key === ' ') {
      // Space advances to the next word's gloss; multi-word glosses use
      // the FLEx dot convention (am.talking.about).
      e.preventDefault();
      focusNextWordGloss(g, 1);
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

// Word-gloss-only navigation (Tab / Space): crosses sentence boundaries but
// skips the free-translation lines.
function focusNextWordGloss(fromInput, dir) {
  const all = $$('#gloss-body .gloss-input');
  const idx = all.indexOf(fromInput);
  const next = all[idx + dir];
  if (next) { next.focus(); next.select?.(); }
}

/* ---------------- Save and send ---------------- */

// Which save/send buttons THIS device shows. Restricted only by a limit the
// device RECEIVED through a link (settings.sendOptions); a researcher composing
// links is never restricted by their own checkboxes (those are linkSendOptions).
function allowedSend() {
  return new Set(settings.sendOptions?.length
    ? settings.sendOptions
    : ['share', 'upload', 'save', 'download']);
}

// Turn a researcher's audio input (Drive share link, bare file id, or direct
// URL) into a fetchable URL: Drive references route through the relay, direct
// https URLs pass through. Returns '' if it can't be understood.
function resolveAudioInput(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const relay = DEFAULT_RELAY;
  const fileId = driveFileId(s);
  const isDrive = fileId && (/drive\.google\.com/.test(s) || !isProbablyUrl(s));
  if (isDrive) return relay ? relay + '?id=' + fileId : '';
  if (isProbablyUrl(s)) return s;
  return '';
}

function fileStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// Hide the whole "Save and send…" button if the researcher disabled
// every option this device could offer.
function updateShareButton() {
  const allow = allowedSend();
  const any = allow.has('share') || allow.has('save') || allow.has('download') ||
    (allow.has('upload') && !!settings.uploadFolder);
  $('#btn-share').hidden = !any;
}

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

// Build what gets saved/uploaded: when the text's audio came from the USER
// (recorded, "new text from audio", or attached) it travels along in a zip;
// task audio from the researcher does not (they already have it).
async function buildBundle(withTimestamp) {
  const xmlBlob = exportBlob();
  const name = exportFilename();                  // Title.flextext
  const base = name.replace(/\.flextext$/, '');
  const media = await db.getMedia(current.id).catch(() => null);
  const userAudio = !!(media && !isAudioLocked(current));
  const consent = current.consentClip
    ? await db.getMedia('consent:' + current.id).catch(() => null)
    : null;
  const stamp = withTimestamp ? ' ' + fileStamp() : '';
  if (userAudio || consent) {
    const entries = [{ name, data: xmlBlob }];
    if (userAudio) entries.push({ name: media.name || 'audio.mp3', data: media.blob });
    if (consent?.blob) entries.push({ name: consent.name || current.consentClip, data: consent.blob });
    const blob = await makeZip(entries);
    return { blob, filename: `${base}${stamp}.zip`, mime: 'application/zip',
      xmlBlob, xmlName: name, zipped: true };
  }
  return { blob: xmlBlob, filename: `${base}${stamp}.flextext`, mime: 'application/xml',
    xmlBlob, xmlName: name, zipped: false };
}

async function openShareMenu() {
  persist();
  const bundle = await buildBundle(false);
  $('#share-filename').textContent = bundle.filename;
  // Chromium only lets navigator.share() send an allowlisted set of file
  // types (images, audio, pdf, .txt, ...) — neither XML nor ZIP qualifies —
  // so Share always sends just the flextext as "<name>.flextext.txt".
  const shareFile = new File([bundle.xmlBlob], bundle.xmlName + '.txt', { type: 'text/plain' });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [shareFile] }));
  const canPick = !!window.showSaveFilePicker;
  const allow = allowedSend();
  const showShare = canShare && allow.has('share');
  const showUpload = allow.has('upload') && !!settings.uploadFolder;
  const showSave = canPick && allow.has('save');
  // Blind download only when no picker is offered (Firefox) or save is off.
  const showDownload = allow.has('download') && !showSave;
  $('#share-share').hidden = !showShare;
  $('#share-upload').hidden = !showUpload;
  $('#share-saveas').hidden = !showSave;
  $('#share-download').hidden = !showDownload;
  $('#share-upload').className = showShare ? 'secondary-btn' : 'primary-btn';
  $('#share-saveas').className = (showShare || showUpload) ? 'secondary-btn' : 'primary-btn';
  $('#share-download').className = (showShare || showUpload || showSave) ? 'secondary-btn' : 'primary-btn';
  $('#share-menu').hidden = false;

  $('#share-share').onclick = async () => {
    try {
      await navigator.share({ files: [shareFile], title: bundle.xmlName });
      closeShareMenu();
    } catch (e) {
      if (e.name !== 'AbortError') toast(t('toast.shareFailed', { msg: e.message }), 5000);
    }
  };
  $('#share-upload').onclick = () => { closeShareMenu(); doUpload(); };
  $('#share-saveas').onclick = async () => {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: bundle.filename,
        types: [bundle.zipped
          ? { description: 'Flextext + audio bundle', accept: { 'application/zip': ['.zip'] } }
          : { description: 'FLEx interlinear text', accept: { 'application/xml': ['.flextext'] } }],
      });
      const w = await handle.createWritable();
      await w.write(bundle.blob);
      await w.close();
      closeShareMenu();
      toast(t('toast.saved'));
    } catch (e) {
      if (e.name !== 'AbortError') toast(t('toast.saveFailed', { msg: e.message }));
    }
  };
  $('#share-download').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(bundle.blob);
    a.download = bundle.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    closeShareMenu();
  };
  $('#share-cancel').onclick = closeShareMenu;
}

/* ---------------- Upload to Google Drive (non-blocking) ---------------- */

function uploadState(docId) {
  return (st) => {
    const bar = $('#upload-bar');
    if (st.status === 'cancelled') { bar.hidden = true; return; }
    if (st.status === 'done') {
      bar.hidden = true;
      toast(t('upload.done', { name: st.name }), 7000);
      return;
    }
    bar.hidden = false;
    const fill = $('#upload-fill');
    const label = $('#upload-label');
    // The proxy upload can't report byte progress (an upload listener would
    // force a CORS preflight the relay can't answer), so show an indeterminate
    // "working" bar while sending.
    const busy = st.status === 'uploading' && st.indeterminate;
    fill.classList.toggle('indeterminate', busy);
    if (busy) {
      fill.style.width = '100%';
      label.textContent = t('upload.working', { name: st.name });
    } else {
      const pct = st.total ? Math.round((st.sent / st.total) * 100) : 0;
      fill.style.width = pct + '%';
      if (st.status === 'uploading') {
        label.textContent = t('upload.progress', { name: st.name, pct, got: mbFmt(st.sent), size: mbFmt(st.total) });
      } else if (st.status === 'paused') {
        label.textContent = t('upload.paused', { name: st.name, pct });
      } else if (st.status === 'error') {
        label.textContent = t('upload.error', { msg: st.error || '?' });
      }
    }
    // One-shot upload: offer Retry on error, Cancel otherwise (no pause/resume).
    const pb = $('#upload-pause');
    if (st.status === 'error') {
      pb.hidden = false;
      pb.textContent = t('upload.retry');
      pb.dataset.docId = docId;
    } else {
      pb.hidden = true;
    }
    $('#upload-cancel').dataset.docId = docId;
  };
}

async function doUpload() {
  if (!current) return;
  const docId = current.id;
  try {
    toast(t('upload.starting'));
    persist();
    const bundle = await buildBundle(true); // timestamped name: Drive never overwrites
    const rec = {
      relayUrl: DEFAULT_RELAY,
      folder: settings.uploadFolder || '',
      blob: bundle.blob,
      name: bundle.filename,
      mime: bundle.mime,
      total: bundle.blob.size,
      sent: 0,
    };
    await db.putMedia('upload:' + docId, rec);
    new DriveUpload(docId, rec, uploadState(docId)).start();
  } catch (e) {
    toast(t('upload.error', { msg: e.message }), 9000);
  }
}

// Uploads persisted from a previous session continue automatically.
async function resumePendingUploads() {
  if (!navigator.onLine) return;
  try {
    for (const { docId, rec } of await listPendingUploads()) {
      if (!getUpload(docId)) new DriveUpload(docId, rec, uploadState(docId)).start();
    }
  } catch { /* best effort */ }
}

function closeShareMenu() { $('#share-menu').hidden = true; }

/* ---------------- Research tab ---------------- */

function fillWsForm() {
  const f = $('#ws-form');
  for (const key of ['vernLang', 'vernName', 'vernFont', 'analLang', 'analName', 'analFont']) {
    if (f.elements[key]) f.elements[key].value = settings[key] || '';
  }
  f.elements.uploadUrl.value = settings.uploadUrl || '';
  // The checkboxes are a TEMPLATE for the links you hand out — what the
  // coworker sees. They never restrict this device (allowedSend, below, only
  // honors a restriction this device RECEIVED via a link). Default: all on.
  const link = new Set(settings.linkSendOptions?.length
    ? settings.linkSendOptions : ['share', 'upload', 'save', 'download']);
  f.elements.sendShare.checked = link.has('share');
  f.elements.sendUpload.checked = link.has('upload');
  f.elements.sendSave.checked = link.has('save');
  f.elements.sendDownload.checked = link.has('download');
  f.elements.consentMode.value = settings.consentMode || 'off';
  f.elements.consentMsg.value = settings.consentMsg || '';
  f.elements.consentAudioUrl.value = settings.consentAudioUrl || '';
  f.elements.consentResp.value = settings.consentResp || 'yesno';
  updateConsentFields(f);
}

// Show only the message/audio field relevant to the chosen consent mode.
function updateConsentFields(f) {
  const mode = f.elements.consentMode.value;
  f.querySelector('.consent-text-field').hidden = mode === 'off';
  f.querySelector('.consent-audio-field').hidden = mode !== 'audio';
  f.elements.consentResp.closest('label').hidden = mode === 'off';
}

function sendOptionsFromForm(f) {
  const opts = [];
  if (f.elements.sendShare.checked) opts.push('share');
  if (f.elements.sendUpload.checked) opts.push('upload');
  if (f.elements.sendSave.checked) opts.push('save');
  if (f.elements.sendDownload.checked) opts.push('download');
  return opts;
}

// Read the whole Research form into `settings` and persist it. NO validation
// gate (unlike the Save submit, which the browser blocks when a required field
// is empty). Returns the raw upload / consent-audio inputs so callers can warn
// on bad values. Used by Save AND by the copy-link buttons — so a generated
// link always reflects the CURRENT form, not just whatever was last saved.
function applyResearchFormToSettings(f) {
  for (const key of ['vernLang', 'vernName', 'vernFont', 'analLang', 'analName', 'analFont']) {
    settings[key] = f.elements[key].value.trim();
  }
  const rawUpload = f.elements.uploadUrl.value.trim();
  settings.uploadUrl = rawUpload;
  settings.uploadFolder = rawUpload ? (parseDriveFolder(rawUpload) || '') : '';
  settings.linkSendOptions = sendOptionsFromForm(f); // template for links, not this device
  settings.consentMode = f.elements.consentMode.value;
  settings.consentMsg = f.elements.consentMsg.value.trim();
  settings.consentResp = f.elements.consentResp.value === 'record' ? 'record' : 'yesno';
  const rawConsentAudio = f.elements.consentAudioUrl.value.trim();
  settings.consentAudioUrl = rawConsentAudio;
  settings.consentAudio = resolveAudioInput(rawConsentAudio);
  saveSettings(settings);
  return { rawUpload, rawConsentAudio };
}

function setupResearch() {
  const f = $('#ws-form');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const { rawUpload, rawConsentAudio } = applyResearchFormToSettings(f);
    if (rawUpload && !settings.uploadFolder) toast(t('research.badFolder'), 7000);
    if (rawConsentAudio && !settings.consentAudio) toast(t('task.badAudio'), 6000);
    renderWsBanner();
    syncConsentAudio();
    toast(t('toast.settingsSaved'));
  });

  $('#ws-form').elements.consentMode.addEventListener('change', () => updateConsentFields($('#ws-form')));

  // Lock down the coworker's interface in person: hide the Research tab on THIS
  // device. The confirm spells out the touch-friendly recovery so nobody gets
  // stranded on a phone with no keyboard.
  $('#btn-hide-research').addEventListener('click', () => {
    if (!confirm(t('research.hideHereConfirm'))) return;
    localStorage.setItem(RESEARCH_HIDDEN_KEY, '1');
    applyResearchVisibility();
    toast(t('research.disabled'));
  });

  $('#btn-copy-link').addEventListener('click', async () => {
    const f2 = $('#ws-form');
    applyResearchFormToSettings(f2); // link must reflect the CURRENT form, not the last Save
    const p = new URLSearchParams();
    const map = { vernLang: 'vern', vernName: 'vernName', vernFont: 'vernFont',
                  analLang: 'anal', analName: 'analName', analFont: 'analFont' };
    for (const [key, qp] of Object.entries(map)) {
      const v = f2.elements[key].value.trim();
      if (v) p.set(qp, v);
    }
    if (!p.has('vern')) { toast(t('toast.needVern')); return; }
    if (!p.has('anal') && !confirm(t('research.analBlankConfirm'))) return;
    p.set('lang', getLang());
    if ($('#research-off-box').checked) p.set('research', 'off');
    // Upload target + allowed save/send options always travel with the link
    // so the researcher's latest choices overwrite older ones.
    p.set('upload', settings.uploadFolder || '');
    p.set('send', (settings.linkSendOptions?.length
      ? settings.linkSendOptions
      : ['share', 'upload', 'save', 'download']).join(','));
    // Consent (app-wide) travels with every link.
    if (settings.consentMode && settings.consentMode !== 'off') {
      p.set('consentMode', settings.consentMode);
      if (settings.consentMsg) p.set('consentMsg', settings.consentMsg);
      if (settings.consentAudio) p.set('consentAudio', settings.consentAudio);
      p.set('consentResp', settings.consentResp || 'yesno');
    }
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

  // Task link builder (text + audio)
  const tf = $('#task-form');
  tf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f2 = $('#ws-form');
    if (!f2.elements.vernLang.value.trim()) { toast(t('toast.needVern')); return; }
    if (!f2.elements.analLang.value.trim() && !confirm(t('research.analBlankConfirm'))) return;
    applyResearchFormToSettings(f2); // link must reflect the CURRENT form, not the last Save

    const audioIn = tf.elements.taskAudio.value.trim();
    let audioUrl = '';
    if (audioIn) {
      audioUrl = resolveAudioInput(audioIn);
      if (!audioUrl) { toast(t('task.badAudio'), 6000); return; }
    }

    // Validate the audio BEFORE producing a link, so the researcher — not
    // the coworker — finds out about WAVs, oversized files, or unshared
    // Drive links. Costs only the first ~16 KB.
    const check = $('#task-check');
    if (audioUrl) {
      check.hidden = false;
      check.textContent = t('task.checking');
      $('#task-link-out').hidden = true;
      try {
        const info = await probeAudioUrl(audioUrl);
        check.textContent = '✓ ' + t('task.checkOk', {
          name: info.name || '?',
          size: info.size ? sizeFmt(info.size) : '?',
        });
      } catch (err) {
        const msg = err.code === 'wav' ? t('task.wavFile')
          : err.code === 'big' ? t('task.tooBig', { mb: err.mb })
          : t('task.checkFailed', { msg: err.message });
        check.textContent = '⚠ ' + msg;
        return; // no link for a bad file
      }
    } else {
      check.hidden = true;
    }

    const p = new URLSearchParams();
    const map = { vernLang: 'vern', vernName: 'vernName', vernFont: 'vernFont',
                  analLang: 'anal', analName: 'analName', analFont: 'analFont' };
    for (const [key, qp] of Object.entries(map)) {
      const v = f2.elements[key].value.trim();
      if (v) p.set(qp, v);
    }
    p.set('lang', getLang());
    if ($('#research-off-box').checked) p.set('research', 'off');
    // Upload target + allowed save/send options always travel with the link
    // so the researcher's latest choices overwrite older ones.
    p.set('upload', settings.uploadFolder || '');
    p.set('send', (settings.linkSendOptions?.length
      ? settings.linkSendOptions
      : ['share', 'upload', 'save', 'download']).join(','));
    // Consent (app-wide) travels with every link.
    if (settings.consentMode && settings.consentMode !== 'off') {
      p.set('consentMode', settings.consentMode);
      if (settings.consentMsg) p.set('consentMsg', settings.consentMsg);
      if (settings.consentAudio) p.set('consentAudio', settings.consentAudio);
      p.set('consentResp', settings.consentResp || 'yesno');
    }
    const title = tf.elements.taskTitle.value.trim();
    if (title) p.set('title', title);
    if (audioUrl) p.set('audio', audioUrl);
    const url = location.origin + location.pathname + '?' + p.toString();
    const out = $('#task-link-out');
    out.hidden = false;
    out.textContent = url;
    try {
      await navigator.clipboard.writeText(url);
      toast(t('toast.linkCopied'));
    } catch {
      toast(t('toast.linkCopyManual'));
    }
  });

  // Audio converter (any recording → small task-ready MP3)
  const cf = $('#convert-form');
  const convPrefs = settings.convert || {};
  if (convPrefs.kbps) cf.elements.convKbps.value = String(convPrefs.kbps);
  if (convPrefs.rate) cf.elements.convRate.value = String(convPrefs.rate);
  if (convPrefs.mono === false) cf.elements.convMono.checked = false;
  cf.addEventListener('change', () => {
    settings.convert = {
      kbps: parseInt(cf.elements.convKbps.value, 10),
      rate: parseInt(cf.elements.convRate.value, 10),
      mono: cf.elements.convMono.checked,
    };
    saveSettings(settings);
  });
  $('#btn-convert').addEventListener('click', () => $('#convert-file').click());
  $('#convert-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const status = $('#convert-status');
    status.hidden = false;
    status.textContent = t('convert.working', { pct: 0 });
    try {
      const opts = {
        kbps: parseInt(cf.elements.convKbps.value, 10),
        sampleRate: parseInt(cf.elements.convRate.value, 10),
        mono: cf.elements.convMono.checked,
      };
      const res = await convertToMp3(file, opts, (f) => {
        status.textContent = t('convert.working', { pct: Math.round(f * 100) });
      });
      const outName = file.name.replace(/\.[^.]+$/, '') + '.mp3';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(res.blob);
      a.download = outName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      status.textContent = t('convert.done', {
        name: outName,
        out: sizeFmt(res.blob.size),
        in: sizeFmt(file.size),
      });
      window.__lastConvert = { size: res.blob.size, duration: res.duration, channels: res.channels };
    } catch (err) {
      status.textContent = t('convert.failed', { msg: err.message });
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

/* ---------------- Research tab visibility ----------------
 * A researcher can hide the Research tab on a coworker's device by checking
 * the box next to the copy-link buttons (adds &research=off to the link).
 * Re-enable: Ctrl+Alt+R, or a link with ?research=on.
 */

const RESEARCH_HIDDEN_KEY = 'flextext-research-hidden';

function isResearchHidden() {
  return !!localStorage.getItem(RESEARCH_HIDDEN_KEY);
}

function applyResearchVisibility() {
  const hidden = isResearchHidden();
  $$('#topbar-home .top-tab[data-view="research"]').forEach(b => { b.hidden = hidden; });
  if (hidden && !$('#view-research').hidden) {
    renderDocList();
    show('texts');
  }
  applyHelpResearchVisibility();
}

// In the Help view, hide the "For researchers" guide on devices where the
// Research tab is hidden, leaving only a short note about the Ctrl+Alt+R
// shortcut. The two elements live inside the i18n-rendered help body, so this
// re-runs whenever help opens, the language changes, or the tab is toggled.
function applyHelpResearchVisibility() {
  const hidden = isResearchHidden();
  const sec = $('#help-researchers');
  const note = $('#help-research-hidden');
  if (sec) sec.hidden = hidden;
  if (note) note.hidden = !hidden;
}

function toggleResearchHidden() {
  if (isResearchHidden()) {
    localStorage.removeItem(RESEARCH_HIDDEN_KEY);
    toast(t('research.enabled'));
  } else {
    localStorage.setItem(RESEARCH_HIDDEN_KEY, '1');
    toast(t('research.disabled'));
  }
  applyResearchVisibility();
}

function setupResearchToggle() {
  // Desktop: Ctrl+Alt+R.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      toggleResearchHidden();
    }
  });
  // Touch devices have no keyboard: tap the app title 7× in quick succession
  // to toggle the Research tab. Obscure enough that a coworker won't hit it by
  // accident, but recoverable on a phone with no Ctrl+Alt+R.
  let taps = 0, last = 0;
  $$('.app-title').forEach((el) => {
    el.addEventListener('click', () => {
      const now = Date.now();
      taps = now - last < 1500 ? taps + 1 : 1;
      last = now;
      if (taps >= 7) { taps = 0; toggleResearchHidden(); }
    });
  });
}

/* ---------------- Install & platform banners ---------------- */

// True on Safari and on any iPhone/iPad browser (they are all WebKit).
// Pure function for testability.
export function isUnsupportedWebKit(ua, maxTouchPoints) {
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  if (/Macintosh/.test(ua) && maxTouchPoints > 1) return true; // iPadOS desktop-mode UA
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|SamsungBrowser|Firefox|FxiOS/.test(ua);
}

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

let installPrompt = null;

function updateInstallBanner() {
  const dismissed = localStorage.getItem('flextext-dismiss-install-banner');
  $('#install-banner').hidden = !installPrompt || isStandalone() || !!dismissed;
}

function setupBanners() {
  // Dismiss buttons (persisted per banner).
  $$('.banner-dismiss').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.dismiss;
    localStorage.setItem('flextext-dismiss-' + id, '1');
    $('#' + id).hidden = true;
  }));

  if (isUnsupportedWebKit(navigator.userAgent, navigator.maxTouchPoints || 0) &&
      !localStorage.getItem('flextext-dismiss-webkit-warning')) {
    $('#webkit-warning').hidden = false;
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    updateInstallBanner();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    updateInstallBanner();
    toast(t('install.done'), 5000);
  });
  $('#btn-install').addEventListener('click', async () => {
    if (!installPrompt) return;
    const p = installPrompt;
    installPrompt = null; // a prompt event can only be used once
    try {
      p.prompt();
      await p.userChoice;
    } catch { /* user dismissed */ }
    updateInstallBanner();
  });
}

/* ---------------- Service worker & updates ----------------
 * Cache-first shell: clients only change app version when a new service
 * worker (with a bumped VERSION in sw.js) is installed. We actively check
 * for that whenever the app loads or returns to the foreground, and show
 * an Update button when a new version is waiting.
 */

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const isDev = ['localhost', '127.0.0.1'].includes(location.hostname) &&
    !new URLSearchParams(location.search).has('sw');
  if (isDev) {
    // Dev: never let a stale service worker shadow fresh files. A SW left over
    // from a ?sw=1 session (or an older build) would otherwise keep serving old
    // JS from its cache-first store forever — we skip SW *updates* on localhost,
    // so nothing would ever replace it. Unregister any such SW, drop its caches,
    // and reload once so localhost always runs exactly what the dev server sends.
    navigator.serviceWorker.getRegistrations().then((regs) => {
      if (!regs.length) return;
      Promise.all(regs.map((r) => r.unregister()))
        .then(() => (window.caches ? caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))) : null))
        .then(() => location.reload());
    }).catch(() => {});
    return;
  }

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
  migrateSettings();
  const { gotSettings, task } = applyUrlSettings();
  settings = loadSettings();
  applyI18n();

  const langSel = $('#lang-select');
  langSel.value = getLang();
  langSel.addEventListener('change', () => {
    setLang(langSel.value);
    applyI18n();
    applyHelpResearchVisibility();
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
    // Stop any playing audio when leaving the text.
    if (player) { player.hide(); player.loadedFor = null; }
    renderDocList();
    show('texts');
  });

  $('#btn-help-home').addEventListener('click', openHelp);
  $('#btn-help-editor').addEventListener('click', openHelp);
  $('#btn-help-close').addEventListener('click', closeHelp);

  $('#doc-title').addEventListener('input', schedulePersist);
  $('#btn-new').addEventListener('click', () => newDoc());
  $('#btn-new-audio').addEventListener('click', () => $('#new-audio-file').click());
  $('#btn-record').addEventListener('click', () => requestConsentThen(() => openRecordModal()));
  $('#record-toggle').addEventListener('click', () => {
    if (rec?.recorder && rec.recorder.state === 'recording') rec.recorder.stop();
    else startRecording();
  });
  $('#record-redo').addEventListener('click', () => { discardRecording(); recordUI('idle'); });
  $('#record-title').addEventListener('input', syncRecordSaveEnabled);
  $('#record-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && $('#record-title').value.trim()) {
      e.preventDefault();
      saveRecording().catch(err => toast(t('convert.failed', { msg: err.message }), 6000));
    }
  });
  $('#record-save').addEventListener('click', () => {
    saveRecording().catch(err => toast(t('convert.failed', { msg: err.message }), 6000));
  });
  $('#record-cancel').addEventListener('click', closeRecordModal);
  $('#record-modal').addEventListener('click', (e) => {
    if (e.target === $('#record-modal')) closeRecordModal();
  });
  $('#new-audio-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) newDocFromAudio(f).catch(err => toast(t('toast.importFailed', { msg: err.message }), 6000));
  });
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importFile(f).catch(err => toast(t('toast.importFailed', { msg: err.message }), 6000));
  });
  $('#baseline-text').addEventListener('blur', () => { applyBaseline(); });
  $('#btn-share').addEventListener('click', openShareMenu);
  $('#share-menu').addEventListener('click', (e) => { if (e.target === $('#share-menu')) closeShareMenu(); });

  $('#audio-player .player-dl-pause').addEventListener('click', () => {
    if (!current) return;
    const dl = getDownload(current.id);
    if (dl && dl.status === 'downloading') dl.pause();
    else if (dl) dl.resume();
    else if (current.pendingAudio) tryDownloadAudio(current);
  });
  $('#audio-player .player-dl-reset').addEventListener('click', async () => {
    if (!current) return;
    const dl = getDownload(current.id);
    if (dl) dl.reset();
    else if (current.pendingAudio) {
      await clearPartial(current.id);
      tryDownloadAudio(current);
    }
  });

  $('#btn-attach-audio').addEventListener('click', () => $('#attach-audio-file').click());
  $('#attach-audio-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) attachAudioFile(f).catch(err => toast(t('toast.importFailed', { msg: err.message }), 6000));
  });
  window.addEventListener('online', () => { retryPendingAudio(); resumePendingUploads(); });

  $('#upload-pause').addEventListener('click', () => {
    const up = getUpload($('#upload-pause').dataset.docId || '');
    if (!up) return;
    if (up.status === 'uploading') up.pause();
    else up.resume();
  });
  $('#upload-cancel').addEventListener('click', () => {
    const up = getUpload($('#upload-cancel').dataset.docId || '');
    if (up) up.cancel();
    else $('#upload-bar').hidden = true;
  });

  setupBanners();
  setupResearch();
  setupResearchToggle();
  applyResearchVisibility();
  const offBox = $('#research-off-box');
  offBox.checked = !!settings.researchOffChecked;
  offBox.addEventListener('change', () => {
    settings.researchOffChecked = offBox.checked;
    saveSettings(settings);
  });
  if (task) {
    openUrlTask(task).catch(err => {
      toast(t('toast.importFailed', { msg: err.message }), 6000);
      renderDocList();
      show('texts');
    });
  } else {
    renderDocList();
    show('texts');
    if (gotSettings) toast(t('toast.setupReceived'), 5000);
  }
  retryPendingAudio();
  resumePendingUploads();
  syncConsentAudio(); // fetch/cache the consent prompt audio if configured

  // Ask the browser to protect our storage (texts + recordings) from
  // being silently evicted when the device runs low on space.
  navigator.storage?.persist?.().catch(() => {});

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
