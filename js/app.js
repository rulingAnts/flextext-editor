/* app.js — UI controller for the Flextext Editor PWA. */

import {
  parseFlextext, serializeFlextext, makeDoc, makeWord, makeSegment,
  getBaselineParagraphs, reconcileBaseline, segmentText, tokenize,
  canMerge, mergeWords, breakPhrase, newGuid,
  surveyWritingSystems, remapWritingSystems,
} from './flextext.js';
import * as db from './db.js';
import { t, getLang, setLang, applyI18n, LANGS } from './i18n.js';
import { Player, downloadAudioForDoc, getDownload, clearPartial, driveFileId, isProbablyUrl, probeAudioUrl, ensureAsset, getAsset, fetchFileViaUrl } from './audio.js';
import { convertToMp3 } from './convert.js';
import { losslessSupported, PCMRecorder, encodeWav, encodeRecording,
         normRecFormat, REC_FORMATS, DEFAULT_REC_FORMAT } from './record-pcm.js';
import { makeZip } from './zip.js';
import { DriveUpload, driveFolderId as parseDriveFolder, getUpload, listPendingUploads } from './upload.js';
import { esc, newGuid as mkGuid } from './flextext.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Record-only mode: the "Flextext Recorder" app (text-recorder/index.html sets window.__MODE), or
// a record link opened in the editor app (?mode=record). Deliberately NOT
// persisted — the editor must never get stuck in record mode because a shared
// link was opened once on the same origin. The recording/consent/upload engine
// is shared; only the UI differs.
const RECORD_MODE = (typeof window !== 'undefined' && window.__MODE === 'record') ||
  new URLSearchParams(location.search).get('mode') === 'record';

// The Texts-screen "new text" buttons a researcher can show/hide per link.
const ALL_BUTTONS = ['new', 'audio', 'record', 'open'];

// Default Google Drive relay (docs/drive-relay.gs) used for Drive share links
// when the researcher hasn't configured their own. The relay is permissionless
// (it can only fetch link-shared files), so sharing one deployment is safe.
const DEFAULT_RELAY = 'https://script.google.com/macros/s/AKfycbxMQbP4Qij5dCWwQd-FoQJstVYEnjyG1ONwcaQ5CUccd-pUmXGGTCpQ9rZieJY0PE5GUg/exec';

// Cloudflare Worker relay (FREE egress → no 150 MB/day cap, unlike Apps Script).
// Every Drive download routes through this Worker's /drive proxy automatically —
// researchers configure NOTHING; they paste plain Google Drive links exactly as
// before and just stop hitting Google's old daily cap.
//
// DEFAULT_RELAY_TOKEN is deliberately public. It only unlocks reads: proxying
// link-shared (public) Drive files and reading the Worker's R2 store. It can NOT
// upload — writes are gated by a separate owner-only secret (?w=) that lives only
// as a Wrangler secret, never here. And Cloudflare Worker egress is free and
// *throttles* (never bills) past the free quota, so a leaked read token costs
// nothing. Rotate it by changing the Worker's RELAY_SECRET + this constant.
const DEFAULT_WORKER = 'https://flextext-r2-worker.68mh29kgsd.workers.dev';
const DEFAULT_RELAY_TOKEN = '7a93cb82d8ad2bd533a75ddf03bebc92501494ca57dab46c5b9f0c5aef00db34';

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
  const gotSettings = p.has('vern') || p.has('anal') || p.has('welcome') || p.has('btns') || p.has('editorRec') || p.has('autoDel') || p.has('recFormat');
  let settingsChanged = false;
  if (gotSettings) {
    const s = loadSettings();
    const before = JSON.stringify(s);
    const map = { vern: 'vernLang', vernName: 'vernName', vernFont: 'vernFont',
                  anal: 'analLang', analName: 'analName', analFont: 'analFont' };
    for (const [qp, key] of Object.entries(map)) {
      if (p.has(qp)) s[key] = p.get(qp);
    }
    // Custom welcome heading for Phone Recording Mode (includes the language name).
    if (p.has('welcome')) s.recordWelcome = p.get('welcome');
    // Which Texts-screen buttons the coworker sees (empty = none; absent = all).
    if (p.has('btns')) {
      s.toolbarButtons = p.get('btns').split(',').filter(o => ALL_BUTTONS.includes(o));
    } else if (p.has('editorRec')) {
      // Legacy: editorRec=off hid only the Record button.
      const cur = Array.isArray(s.toolbarButtons) ? s.toolbarButtons : ALL_BUTTONS.slice();
      s.toolbarButtons = p.get('editorRec') === 'off'
        ? cur.filter(b => b !== 'record')
        : Array.from(new Set([...cur, 'record']));
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
    if (p.has('consentResp')) s.consentResp = ['record', 'signature'].includes(p.get('consentResp')) ? p.get('consentResp') : 'yesno';
    // Whether a text is deleted from the device after it uploads to Drive
    // (researcher's explicit choice; overrides the per-app default below).
    if (p.has('autoDel')) s.autoDelUploaded = p.get('autoDel') === 'on';
    // Capture (recording) format the device should use; default 32-bit WAV.
    if (p.has('recFormat')) s.recordFormat = normRecFormat(p.get('recFormat'));
    settingsChanged = JSON.stringify(s) !== before;
    saveSettings(s);
  }
  const task = (p.has('audio') || p.has('title') || p.has('flextext') || p.has('replace') || p.has('cleanup'))
    ? { title: p.get('title') || '', audioUrl: p.get('audio') || '',
        flextextUrl: p.get('flextext') || '',
        // Stable file ids (only needed for presigned URLs that change/expire;
        // Drive/direct links derive their id from the URL — see fileIdentity()).
        audioId: p.get('audioId') || '', flextextId: p.get('flextextId') || '',
        // Researcher-controlled overrides of the safe default.
        replace: p.get('replace') || '', cleanup: p.get('cleanup') || '' }
    : null;
  if (gotSettings || task || p.has('lang') || p.has('research') || p.has('mode')) {
    history.replaceState(null, '', location.pathname);
  }
  return { gotSettings, settingsChanged, task };
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

const VIEWS = ['texts', 'baseline', 'gloss', 'research', 'help', 'record'];

function currentView() {
  return VIEWS.find(v => { const el = $('#view-' + v); return el && !el.hidden; }) || 'texts';
}

// Tolerant of missing elements: the Flextext Recorder shell (text-recorder/index.html)
// only contains a subset of the views and topbars, so every lookup is guarded.
function show(view) {
  for (const v of VIEWS) { const el = $('#view-' + v); if (el) el.hidden = v !== view; }
  const inEditor = view === 'baseline' || view === 'gloss' ||
    (view === 'help' && (helpReturnView === 'baseline' || helpReturnView === 'gloss'));
  const home = $('#topbar-home');
  const editor = $('#topbar-editor');
  if (home) home.hidden = inEditor;
  if (editor) editor.hidden = !inEditor;
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
        // Stop any queued/in-flight upload so a deleted text never reaches Drive.
        const up = getUpload(d.id);
        if (up) up.cancel(); else uploadView.delete(d.id);
        await db.deleteDoc(d.id);
        renderUploadQueue();
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
  const titleEl = $('#doc-title');
  if (titleEl) current.title = titleEl.value.trim() || current.title || '';
  // In the editor, skip the full doc write while sitting on the library view.
  // Record mode has no library view (and no #doc-title), so it always saves.
  const textsView = $('#view-texts');
  if (textsView && !textsView.hidden) return;
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
  if (!$('#audio-player')) return; // record mode has no player UI
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
      p.showPending(current.audioError ? audioErrorText(current.audioError) : t('player.pending'));
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
  if (!RECORD_MODE) enterEditor('baseline');
  await attachAudioFile(file);
  // If a recorded verbal assent was captured in the consent gate, store it
  // with this doc so it travels in the upload/save zip bundle.
  if (pendingReceipt) {
    current.consentReceipt = pendingReceipt; // same object captureConsentContext fills
    pendingReceipt = null;
  }
  if (pendingAssent) {
    current.consentClip = pendingAssent.name;
    await db.putMedia('consent:' + current.id, pendingAssent).catch(() => {});
    pendingAssent = null;
  }
  if (pendingPromptAudio) {
    current.consentPromptClip = pendingPromptAudio.name;
    await db.putMedia('consent-prompt:' + current.id, pendingPromptAudio).catch(() => {});
    pendingPromptAudio = null;
  }
  if (current.consentReceipt || current.consentClip || current.consentPromptClip) await persist();
  if (RECORD_MODE) {
    // No editor in record mode: the recording is saved; return to the list.
    current = null;
    show('record');
    renderRecordList();
    toast(t('record.saved'), 4000);
    return;
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
let pendingReceipt = null; // consent audit record, consumed on doc create
let pendingPromptAudio = null; // frozen copy of the spoken prompt, consumed on doc create
let consentCapture = null; // { receipt, promise } in-flight IP/location capture
let lastGeo = null;       // cached approx location, only set once permission is granted
let crec = null;          // consent-assent recorder state

// Geolocation, asked ONCE and never again. The location permission popup is too
// disruptive to fire mid-consent, so on the first user tap we make the single
// request at a calm moment; the browser then remembers the choice forever. If
// the speaker allowed it we read silently thereafter; if they blocked it (or
// dismissed and the browser auto-blocked) we never ask again.
function primeGeolocationOnce() {
  const ask = async () => {
    document.removeEventListener('pointerdown', ask, true);
    if (!navigator.geolocation) return;
    try {
      // Don't even call getCurrentPosition if it's already been blocked.
      if (navigator.permissions) {
        const st = await navigator.permissions.query({ name: 'geolocation' });
        if (st.state === 'denied') return;
      }
      navigator.geolocation.getCurrentPosition(rememberGeo, () => {},
        { timeout: 15000, maximumAge: 300000, enableHighAccuracy: false });
    } catch { /* unsupported / insecure context */ }
  };
  document.addEventListener('pointerdown', ask, true);
}

function rememberGeo(pos) {
  lastGeo = {
    lat: pos.coords.latitude, lon: pos.coords.longitude,
    accuracyMeters: Math.round(pos.coords.accuracy),
    at: new Date(pos.timestamp).toISOString(),
  };
}

// Refresh the cached location WITHOUT ever prompting: only read when the
// permission is already 'granted' (so this can run during the consent flow).
async function readGeoIfGranted() {
  try {
    if (!navigator.geolocation || !navigator.permissions) return;
    const st = await navigator.permissions.query({ name: 'geolocation' });
    if (st.state !== 'granted') return;
    const pos = await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej,
        { timeout: 15000, maximumAge: 300000, enableHighAccuracy: false }));
    rememberGeo(pos);
  } catch { /* no fix / unsupported */ }
}

// Stable per-device id so a researcher can correlate a coworker's submissions.
function deviceId() {
  let id = localStorage.getItem('flextext-device-id');
  if (!id) {
    id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('flextext-device-id', id);
  }
  return id;
}

// Build the consent audit record at the moment permission is given. The IP and
// (if the speaker allowed location once) approxLocation are filled in best
// effort by captureConsentContext; both stay "unavailable" when offline or when
// location was never granted. Location NEVER prompts here — see readGeoIfGranted.
function buildConsentReceipt(assent, signatureName) {
  const now = new Date();
  return {
    app: 'Flextext Editor',
    consentGiven: true,
    responseType: settings.consentResp === 'record' ? 'recorded'
      : settings.consentResp === 'signature' ? 'signature' : 'yesno',
    signatureName: signatureName || '',
    recordedAssentFile: assent?.name || '',
    promptMode: settings.consentMode || 'off',
    promptMessage: settings.consentMsg || '',
    promptAudioUrl: settings.consentMode === 'audio' ? (settings.consentAudio || '') : '',
    promptAudioFile: (settings.consentMode === 'audio' && pendingPromptAudio) ? pendingPromptAudio.name : '',
    timestamp: now.toISOString(),
    localTime: now.toString(),
    timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })(),
    interfaceLang: getLang(),
    deviceId: deviceId(),
    userAgent: navigator.userAgent,
    ipAddress: 'unavailable',
    approxLocation: lastGeo || 'unavailable',
  };
}

// Best effort, no prompt: fill in the public IP (needs internet) and a fresh
// location reading — but ONLY if the speaker already granted location at the
// one-time first-tap request (readGeoIfGranted never prompts). Failures leave
// the "unavailable" placeholders. Re-persists the owning doc once values arrive.
async function captureConsentContext(receipt) {
  await Promise.allSettled([
    (async () => {
      try {
        const r = await fetch('https://api.ipify.org?format=json', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (r.ok) receipt.ipAddress = (await r.json()).ip || 'unavailable';
      } catch { /* offline / blocked */ }
    })(),
    readGeoIfGranted(),
  ]);
  if (lastGeo) receipt.approxLocation = lastGeo;
  if (current && current.consentReceipt === receipt) { try { await persist(); } catch { /* noop */ } }
}

// Human-readable companion to consent-receipt.json.
function consentReceiptText(r) {
  return [
    'SPEAKER PERMISSION / CONSENT RECORD',
    '',
    'Text: ' + (r.textTitle || '(untitled)'),
    'Consent given: yes',
    'Form of consent: ' + r.responseType +
      (r.responseType === 'signature' ? ' — signed: "' + r.signatureName + '"'
        : r.responseType === 'recorded' ? ' — audio: ' + (r.recordedAssentFile || '(in this bundle)') : ''),
    'Date/time: ' + r.localTime + '  (' + r.timestamp + ', ' + r.timezone + ')',
    '',
    'Prompt shown to the speaker (' + r.promptMode + '):',
    (r.promptMessage || (r.promptMode === 'audio' ? '(spoken — see prompt audio file below)' : '(none)')),
    ...(r.promptAudioFile ? ['Spoken prompt audio (included in this bundle): ' + r.promptAudioFile
      + (r.promptAudioUrl ? '   [source: ' + r.promptAudioUrl + ']' : '')] : []),
    '',
    'Device id: ' + r.deviceId,
    'Interface language: ' + r.interfaceLang,
    'IP address: ' + r.ipAddress,
    'Approximate location: ' + (r.approxLocation && typeof r.approxLocation === 'object'
      ? `${r.approxLocation.lat}, ${r.approxLocation.lon} (±${r.approxLocation.accuracyMeters} m)`
      : 'unavailable'),
    'Browser: ' + r.userAgent,
  ].join('\n');
}

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
  // Clear any leftover capture from a prior attempt FIRST — before the off
  // check returns — so a stale receipt can never ride along on a later
  // recording made while consent is switched off.
  pendingAssent = null;
  pendingReceipt = null;
  pendingPromptAudio = null;
  const mode = settings.consentMode || 'off';
  if (mode === 'off') { onApproved(null); return; }

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
        // Freeze a copy of the EXACT prompt that was played, to bundle beside
        // the response — the prompt may be refined later, so the record must
        // show what THIS speaker was actually asked (IRB verification).
        const m = asset.name && asset.name.match(/\.[a-z0-9]+$/i);
        const ext = m ? m[0] : (asset.mimeType === 'audio/mpeg' ? '.mp3' : '.audio');
        pendingPromptAudio = { blob: asset.blob, name: 'consent-prompt' + ext, mimeType: asset.mimeType };
      } else {
        status.textContent = t('consent.audioFailed');
      }
    } catch {
      status.textContent = t('consent.audioFailed');
    }
    if (settings.consentMsg) { msgEl.hidden = false; }
  }

  const respRecord = settings.consentResp === 'record';
  const respSign = settings.consentResp === 'signature';
  $('#consent-yesno').hidden = respRecord || respSign;
  $('#consent-record').hidden = !respRecord;
  $('#consent-sign').hidden = !respSign;
  if (respSign) $('#consent-name').value = '';
  resetConsentRecordUI();

  $('#consent-modal').hidden = false;

  // On consent, capture the audit record and (best effort, no prompt) IP + location.
  const proceed = (assent, signatureName) => {
    pendingAssent = assent;
    pendingReceipt = buildConsentReceipt(assent, signatureName);
    // Fire-and-forget IP/location fill; keep the handle so buildBundle can
    // briefly await it before zipping the receipt.
    consentCapture = { receipt: pendingReceipt, promise: captureConsentContext(pendingReceipt) };
    closeConsentModal();
    onApproved(assent);
  };

  $('#consent-yes').onclick = () => proceed(null);
  $('#consent-no').onclick = () => { closeConsentModal(); toast(t('consent.declined'), 5000); };
  $('#consent-sign-continue').onclick = () => {
    const nm = $('#consent-name').value.trim();
    if (!nm) { $('#consent-name').focus(); toast(t('consent.needName'), 5000); return; }
    proceed(null, nm);
  };
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
    // Raw signal for faithful capture: auto-gain makes a loud recording fade out
    // over its length; echo-cancellation + noise-suppression also color the audio.
    // All off — fidelity matters more than call-style cleanup for these recordings.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
    });
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

// Recording state. Two capture modes share this slot:
//   pcm — lossless: { mode:'pcm', pcmRec, fmt, pcm, sampleRate, ... }
//   mr  — MediaRecorder→MP3 (explicit mp3 choice OR lossless fallback):
//         { mode:'mr', stream, recorder, chunks, fmt:'mp3', fellBack, ... }
// Common: { recording, fmt, t0, timer, blob (preview), url }.
let rec = null;

// The researcher-chosen capture format (default 32-bit WAV). Travels with links.
function recordFormatPref() { return normRecFormat(settings.recordFormat); }

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
    // If a lossless choice couldn't be honored on this browser, the take was
    // captured as compressed MP3 — say so once, plainly, so nobody assumes they
    // archived a lossless recording.
    if (rec?.fellBack && !rec._warned) { rec._warned = true; toast(t('record.fellBack'), 8000); }
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
    try { rec.pcmRec?.cancel(); } catch { /* noop */ } // lossless path owns its own stream/ctx
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
  pendingAssent = null;       // abandon any consent clip if the recording is cancelled
  pendingReceipt = null;      // and its audit record
  pendingPromptAudio = null;  // and the frozen prompt copy
  $('#record-modal').hidden = true;
}

async function startRecording() {
  const fmt = recordFormatPref();
  const wantLossless = REC_FORMATS[fmt].lossless;
  try {
    if (wantLossless && losslessSupported()) {
      const pcmRec = new PCMRecorder();
      try {
        await pcmRec.start(); // getUserMedia + AudioWorklet; throws if unsupported
        rec = { mode: 'pcm', pcmRec, fmt, fellBack: false, recording: true,
                t0: Date.now(), timer: null, blob: null, url: null };
        startRecTimer();
        recordUI('recording');
        return;
      } catch (lossErr) {
        // Browser can't do raw PCM capture (or the user denied the mic on the
        // first attempt) — fall back to MediaRecorder and flag the downgrade.
        console.warn('Lossless capture unavailable; recording compressed MP3 instead.', lossErr);
        try { pcmRec.cancel(); } catch { /* noop */ } // release any half-open mic stream before retrying
        if (lossErr && lossErr.name === 'NotAllowedError') throw lossErr; // mic denied: real error, don't double-prompt
        await startMediaRecorder(true);
        return;
      }
    }
    // Explicit MP3 choice, or lossless not supported on this browser at all.
    await startMediaRecorder(wantLossless);
  } catch (e) {
    recordUI('idle');
    $('#record-status').textContent = t('record.micError', { msg: e.message });
  }
}

// MediaRecorder capture path: the explicit "mp3" recording format, and the
// fallback when lossless can't run. `fellBack` true → warn at review time.
async function startMediaRecorder(fellBack) {
  // Raw signal for faithful capture: auto-gain makes a loud recording fade out
  // over its length; echo-cancellation + noise-suppression also color the audio.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
  });
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
    : MediaRecorder.isTypeSupported('audio/ogg') ? 'audio/ogg' : '';
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  rec = { mode: 'mr', stream, recorder, chunks: [], fmt: 'mp3', fellBack: !!fellBack,
          recording: true, t0: Date.now(), timer: null, blob: null, url: null };
  recorder.addEventListener('dataavailable', (e) => { if (e.data.size) rec?.chunks.push(e.data); });
  recorder.addEventListener('stop', () => {
    if (!rec) return; // cancelled
    rec.stream.getTracks().forEach(tr => tr.stop());
    clearInterval(rec.timer);
    rec.recording = false;
    rec.blob = new Blob(rec.chunks, { type: recorder.mimeType || 'audio/webm' });
    rec.url = URL.createObjectURL(rec.blob);
    $('#record-preview').src = rec.url;
    recordUI('review');
  });
  recorder.start();
  startRecTimer();
  recordUI('recording');
}

function startRecTimer() {
  const fmtT = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s) % 60).padStart(2, '0');
  rec.timer = setInterval(
    () => recordUI('recording', { time: fmtT((Date.now() - rec.t0) / 1000) }), 250);
}

// Stop either capture mode and move to review. MediaRecorder finishes in its
// own 'stop' listener; the PCM path flushes its tail and builds a fast
// 32-bit-float WAV preview (native, instant) from the captured samples.
async function stopRecording() {
  if (!rec || !rec.recording) return;
  if (rec.mode === 'mr') {
    if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
    return;
  }
  rec.recording = false;
  clearInterval(rec.timer);
  try {
    const { pcm, sampleRate } = await rec.pcmRec.stop();
    if (!pcm.length) throw new Error('empty');
    rec.pcm = pcm;
    rec.sampleRate = sampleRate;
    rec.blob = encodeWav(pcm, sampleRate, 32); // preview only; final format chosen on save
    rec.url = URL.createObjectURL(rec.blob);
    $('#record-preview').src = rec.url;
    recordUI('review');
  } catch (e) {
    discardRecording();
    recordUI('idle');
    $('#record-status').textContent = t('record.micError',
      { msg: e.message === 'empty' ? t('record.noAudio') : e.message });
  }
}

async function saveRecording() {
  if (!rec || (!rec.blob && !rec.pcm)) return;
  const title = $('#record-title').value.trim();
  if (!title) { syncRecordSaveEnabled(); $('#record-title').focus(); return; } // title required
  recordUI('saving', { pct: 0 });
  try {
    const stamp = fileStamp();
    let file;
    if (rec.mode === 'pcm') {
      // Lossless: encode the captured PCM to the chosen WAV/FLAC format.
      const { blob, ext, mime } = await encodeRecording(rec.pcm, rec.sampleRate, rec.fmt,
        (f) => recordUI('saving', { pct: Math.round(f * 100) }));
      file = new File([blob], `recording-${stamp}.${ext}`, { type: mime });
    } else {
      // MediaRecorder take → compressed MP3 (explicit mp3 format, or fallback).
      const conv = settings.convert || {};
      const res = await convertToMp3(rec.blob,
        { kbps: conv.kbps || 64, sampleRate: conv.rate || 22050, mono: conv.mono !== false },
        (f) => recordUI('saving', { pct: Math.round(f * 100) }));
      file = new File([res.blob], `recording-${stamp}.mp3`, { type: 'audio/mpeg' });
    }
    const assent = pendingAssent;     // closeRecordModal clears these; preserve
    const receipt = pendingReceipt;   // them for the new doc
    const promptAudio = pendingPromptAudio;
    closeRecordModal();
    pendingAssent = assent;
    pendingReceipt = receipt;
    pendingPromptAudio = promptAudio;
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

// Map a download failure (a Worker/relay error code, an HTTP/network string, or
// an already-human sentence) to a friendly, translated line for the player —
// never a bare code or the misleading "not downloaded yet" (reads as in-progress).
function audioErrorText(error) {
  const e = String(error || '');
  if (e === 'too_large') return t('player.tooLarge');
  if (!e || e === 'download_failed' || /^HTTP \d/.test(e)
      || /Failed to fetch|NetworkError|aborted/i.test(e)
      || ['unauthorized', 'origin_not_allowed', 'bad_src', 'not_found', 'drive_unavailable', 'drive interstitial'].includes(e)) {
    return t('player.downloadFailed');
  }
  return e; // already a human sentence (e.g. a relay's WAV refusal)
}

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
      // Show a friendly reason ("couldn't download — will retry", or "file too
      // large"), never a bare code or the misleading "not downloaded yet".
      p.showPending(error ? audioErrorText(error) : t('player.downloadFailed'));
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
    const rec = await db.getDoc(d.id);
    if (rec?.pendingFlextext) await tryDownloadFlextext(rec);
    if (getDownload(d.id)) continue; // already downloading or paused
    if (rec?.pendingAudio) await tryDownloadAudio(rec);
  }
}

/* ---------------- Task links (?title=...&audio=...) ---------------- */

// Stable identity of a task-delivered file, for dedup + the "already downloaded"
// marker. Order: an explicit id (REQUIRED for presigned URLs that change/expire)
// → the Drive file-id (stable across raw-link / relay / worker URLs that carry
// the id) → the URL itself (stable for direct/Firebase URLs). Backward-compatible:
// docs saved before this change stored a relay URL in audioSource/flextextSource,
// which still resolves to the same drive:<id>, so existing field links keep
// deduping correctly.
function fileIdentity(url, explicitId) {
  const id = (explicitId || '').trim();
  if (id) return 'id:' + id;
  const drive = driveFileId(url);
  if (drive) return 'drive:' + drive;
  const m = String(url || '').match(/[?&](?:id|src)=([\w-]{10,})/);
  if (m) return 'drive:' + m[1];
  return url ? 'url:' + url : '';
}
// A doc's file identity (new docs store *Id; older docs derive it from their
// stored source/pending URL so dedup still works after this change).
function docAudioId(rec) { return rec.audioId || fileIdentity(rec.audioSource || rec.pendingAudio || '', ''); }
function docFlextextId(rec) { return rec.flextextId || fileIdentity(rec.flextextSource || rec.pendingFlextext || '', ''); }

// Researcher-controlled cleanup directive (cleanup=all | comma-separated titles)
// for back-and-forth checking. Destructive, so it ALWAYS confirms on the device
// first, showing how many texts it will delete — a stray link can't silently wipe.
async function runTaskCleanup(spec) {
  const docs = await db.listDocs();
  let targets;
  if (spec === 'all') targets = docs;
  else {
    const titles = spec.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    targets = docs.filter(d => titles.includes((d.title || '').toLowerCase()));
  }
  if (!targets.length) return;
  if (!confirm(t('task.cleanupConfirm', { n: targets.length }))) return;
  for (const d of targets) {
    const up = getUpload(d.id);
    if (up) up.cancel(); else uploadView.delete(d.id);
    if (current && current.id === d.id) current = null;
    await db.deleteDoc(d.id);
  }
  renderUploadQueue();
  toast(t('task.cleanupDone', { n: targets.length }), 5000);
}

async function openUrlTask(task) {
  // Deliberate cleanup first (e.g. clearing old versions in a back-and-forth check).
  if (task.cleanup) {
    await runTaskCleanup(task.cleanup);
    if (!task.audioUrl && !task.flextextUrl && !task.title) { renderDocList(); show('texts'); return; }
  }

  const audioId = task.audioUrl ? fileIdentity(task.audioUrl, task.audioId) : '';
  const flextextId = task.flextextUrl ? fileIdentity(task.flextextUrl, task.flextextId) : '';

  // Find an existing text with the same file identity, so re-opening a link — even
  // one whose (presigned) URL changed or expired — never duplicates or re-fetches.
  let existing = null;
  if (audioId || flextextId) {
    for (const d of await db.listDocs()) {
      const rec = await db.getDoc(d.id);
      if (!rec) continue;
      if ((audioId && docAudioId(rec) === audioId) || (flextextId && docFlextextId(rec) === flextextId)) { existing = rec; break; }
    }
  }

  // Default: it's already here → open it, NEVER re-fetch (protects loaded content
  // against a failed/expired re-download).
  if (existing && !task.replace) {
    current = existing;
    enterEditor('baseline');
    toast(t('task.alreadyHere'), 4000);
    return;
  }

  // replace=on with a match → deliberately overwrite the existing copy, but ONLY
  // after a successful fetch (a failed/expired download leaves the old intact).
  if (existing && task.replace) {
    current = existing;
    if (task.title) { current.title = task.title; current.doc.title = task.title; }
    if (task.flextextUrl) { current.flextextId = flextextId; current.pendingFlextext = task.flextextUrl; current.flextextForce = true; }
    if (task.audioUrl) { current.audioId = audioId; current.pendingAudio = task.audioUrl; current.audioLocked = true; }
    await db.putDoc(current);
    enterEditor('baseline');
    toast(t('task.replacing'), 5000);
    if (task.flextextUrl) tryDownloadFlextext(current);
    if (task.audioUrl) {
      const ok = await tryDownloadAudio(current);
      if (!ok && getDownload(current.id)?.status !== 'paused') toast(t('player.downloadFailed'), 6000);
    }
    return;
  }

  // No match → create a new text. If a flextext is attached, its parsed content IS
  // the doc; otherwise an empty doc to transcribe into. When we can't fetch it now
  // (offline), fall back to a placeholder the retry sweep populates later.
  let doc = makeDoc(settings, task.title);
  let gotFlextext = false;
  if (task.flextextUrl && navigator.onLine) {
    try { doc = await buildDocFromFlextextUrl(task.flextextUrl, task.title); gotFlextext = true; }
    catch { /* fall through to placeholder + pending retry */ }
  }
  current = { id: newGuid(), title: task.title || doc.title || '', created: Date.now(), modified: Date.now(), doc };
  current.doc.title = current.title;
  if (task.flextextUrl) {
    current.flextextId = flextextId;
    if (gotFlextext) current.flextextSource = task.flextextUrl;
    else current.pendingFlextext = task.flextextUrl;
  }
  if (task.audioUrl) {
    current.audioId = audioId;
    current.pendingAudio = task.audioUrl;
    current.audioLocked = true;
  }
  Object.assign(current, docStats(current.doc));
  await db.putDoc(current);
  enterEditor('baseline');
  toast(t('task.received'), 5000);
  if (task.flextextUrl && !gotFlextext) {
    toast(t('task.ftReceiving'), 6000);
    tryDownloadFlextext(current);
  }
  if (task.audioUrl) {
    const ok = await tryDownloadAudio(current);
    // Success and pause/error UI are painted by the download state handler;
    // only announce a failure the user didn't cause themselves.
    if (!ok && getDownload(current.id)?.status !== 'paused') {
      toast(t('player.downloadFailed'), 6000);
    }
  }
}

// Download a pending task flextext and populate the placeholder doc — but only
// if the coworker hasn't started transcribing into it, so we never clobber work.
async function tryDownloadFlextext(rec) {
  if (!rec.pendingFlextext || !navigator.onLine) return false;
  // If this is the doc the user is actively editing, flush the live textarea into
  // current.doc and use that live copy for the untouched check — the DB snapshot
  // lags the debounced persist by ~400ms, so checking it could clobber edits the
  // coworker just typed into the placeholder.
  if (current && current.id === rec.id) {
    if (activeTab === 'baseline' && $('#baseline-text') && !$('#view-baseline').hidden) applyBaseline();
    rec = current;
  }
  let newDoc;
  try { newDoc = await buildDocFromFlextextUrl(rec.pendingFlextext, rec.title); }
  catch (e) {
    // Permanent failure (relay refused, or not a usable flextext) → stop retrying
    // and tell the worker, instead of a silent empty placeholder forever. A plain
    // network/HTTP error stays pending for the next retry.
    if (e.fatal || e.parseError) {
      rec.flextextError = e.message;
      delete rec.pendingFlextext;
      await db.putDoc(rec).catch(() => {});
      toast(t('task.ftFailed', { msg: e.message }), 10000);
      return false;
    }
    return false; // transient: keep pending for the next retry
  }
  // Populate the placeholder — unless the coworker already started transcribing,
  // in which case we keep their work (never clobber). flextextForce overrides that
  // for a researcher's deliberate replace=on, but still only AFTER this successful
  // fetch (a failed fetch returned above, leaving the old content untouched).
  const untouched = getBaselineParagraphs(rec.doc).every(p => !p.trim());
  if (untouched || rec.flextextForce) {
    rec.doc = newDoc;
    rec.doc.title = rec.title || newDoc.title || '';
    rec.flextextSource = rec.pendingFlextext;
    delete rec.pendingFlextext;
    delete rec.flextextForce;
    Object.assign(rec, docStats(rec.doc));
    await db.putDoc(rec);
    if (current && current.id === rec.id) {
      current = rec;
      // We may already be sitting on the placeholder's (empty) baseline view.
      // Sync the textarea to the arrived doc BEFORE re-entering, so switchTab's
      // "leaving baseline" applyBaseline() doesn't reconcile the stale empty
      // textarea over the freshly-downloaded content and wipe it.
      const bt = $('#baseline-text');
      if (bt) bt.value = getBaselineParagraphs(rec.doc).join('\n');
      enterEditor('baseline');
    }
    toast(t('task.ftArrived'), 5000);
  } else {
    // The coworker already started typing — keep their work, drop the assignment.
    delete rec.pendingFlextext;
    await db.putDoc(rec);
    toast(t('task.ftSkipped'), 9000);
  }
  return true;
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

// Which Texts-screen "new text" buttons THIS device shows. A received link sets
// settings.toolbarButtons (an array — empty means hide them all); absent = all.
function allowedButtons() {
  return new Set(Array.isArray(settings.toolbarButtons) ? settings.toolbarButtons : ALL_BUTTONS);
}

// Whether a text/recording should be deleted from THIS device once it has
// uploaded to Drive. Researcher-controlled via the link (autoDel=on|off →
// settings.autoDelUploaded). When the link said nothing, default per app: the
// Flextext Recorder clears sent recordings (gather-and-send, frees phone storage),
// the editor keeps texts (a transcriber may edit them over several sessions).
function deleteAfterUpload() {
  return settings.autoDelUploaded === undefined ? RECORD_MODE : !!settings.autoDelUploaded;
}

// Delete a just-uploaded doc + all its media, then refresh whichever list is
// showing. If the doc is open in the editor, leave it first so the user isn't
// stranded on an editor for a text that no longer exists.
function deleteUploadedDoc(docId) {
  if (current && current.id === docId) {
    current = null;
    if (!RECORD_MODE) show('texts');
  }
  return db.deleteDoc(docId).catch(() => {}).then(() => {
    if (RECORD_MODE) renderRecordList(); else renderDocList();
  });
}

// Turn a researcher's audio/flextext input (Drive share link, bare file id, or
// direct URL) into a fetchable URL. A Drive reference routes through a relay; a
// direct https URL (incl. an R2 CDN link) passes through unchanged. Returns ''
// if it can't be understood.
//
// Drive relay selection: every Drive link routes through the Worker's /drive
// proxy (FREE egress → no 150 MB/day cap), automatically and invisibly. The
// (public, read-only) token is baked into the per-file URL so any device can
// fetch it with zero setup. A direct non-Drive URL (e.g. a power user's own R2
// public link) is served as-is, bypassing the Worker entirely.
function resolveAudioInput(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  // Upgrade a legacy Apps Script relay URL back to a Drive link, so links built
  // before the Worker existed also escape the old ~150 MB/day cap on re-resolve.
  if (DEFAULT_RELAY && s.startsWith(DEFAULT_RELAY)) {
    const oldId = new URLSearchParams(s.slice(s.indexOf('?') + 1)).get('id');
    if (oldId) s = 'https://drive.google.com/file/d/' + oldId + '/view';
  }
  const fileId = driveFileId(s);
  const isDrive = fileId && (/drive\.google\.com/.test(s) || !isProbablyUrl(s));
  if (isDrive) {
    const base = (settings.relayWorker || DEFAULT_WORKER).trim().replace(/\/+$/, '');
    const token = (settings.relayToken || DEFAULT_RELAY_TOKEN).trim();
    if (base && token) return `${base}/drive?src=${fileId}&t=${encodeURIComponent(token)}`;
    return DEFAULT_RELAY ? DEFAULT_RELAY + '?id=' + fileId : '';
  }
  if (isProbablyUrl(s)) return s;
  return '';
}

function fileStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/* ---- Task-attached flextext: writing-system validation ----
 * A researcher can attach an already-transcribed/glossed flextext to a task
 * link. We survey its writing-system codes (reusing surveyWritingSystems) and
 * split them into vernacular vs analysis, then HARD-REFUSE the link if they
 * don't match the setup. segnum/meta lines are neutral — a number or metadata
 * WS must not trigger a vern/anal mismatch.
 * (An auto-remap-to-setup option was considered but deferred: a researcher may
 * use several writing systems for several purposes, so a correct remap needs
 * more design. For now the file's codes must already match.) */
const WS_VERN_LABELS = new Set(['wsline.baseline', 'wsline.word', 'wsline.punct', 'wsline.morph', 'wsline.cf']);
const WS_ANAL_LABELS = new Set(['wsline.wordgloss', 'wsline.pos', 'wsline.morphgloss', 'wsline.msa', 'wsline.free', 'wsline.lit', 'wsline.note']);

function analyzeFlextextWs(xmlText) {
  const survey = surveyWritingSystems(xmlText);
  if (survey.error) return { error: survey.error };
  const pick = (labels) => {
    const set = new Set();
    for (const r of survey.rows) if (labels.has(r.label) && r.lang && r.lang !== '(none)') set.add(r.lang);
    return [...set];
  };
  return { error: null, survey, vernCodes: pick(WS_VERN_LABELS), analCodes: pick(WS_ANAL_LABELS) };
}

// Download a task-attached flextext, parse it, and return the first
// interlinear-text doc.
async function buildDocFromFlextextUrl(url, title) {
  const file = await fetchFileViaUrl(url);
  const xml = await file.blob.text();
  const { texts, error } = parseFlextext(xml);
  // A successful fetch of a non-flextext body (Drive 404 HTML page, wrong file,
  // corrupt export) is a PERMANENT failure — tag it so the retry loop stops and
  // surfaces it rather than spinning behind a silent empty placeholder.
  if (error || !texts.length) { const e = new Error(error || 'No readable text in the file.'); e.parseError = true; throw e; }
  const doc = texts[0];
  if (title) doc.title = title;
  return doc;
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
  if (activeTab === 'baseline' && $('#baseline-text')) applyBaseline();
  current.doc.title = ($('#doc-title')?.value.trim()) || current.title || 'Untitled';
  const xml = serializeFlextext(current.doc, settings);
  return new Blob([xml], { type: 'application/xml' });
}

function exportFilename() {
  const t2 = (($('#doc-title')?.value.trim()) || current.title || 'text')
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
  // The exact spoken prompt that was played, frozen at consent time, so the
  // question and the answer travel together for IRB verification.
  const promptAudio = current.consentPromptClip
    ? await db.getMedia('consent-prompt:' + current.id).catch(() => null)
    : null;
  const receipt = current.consentReceipt || null;
  // If this receipt's best-effort IP/location capture is still in flight, give
  // it a short window so the bundled record isn't needlessly "unavailable".
  if (receipt && consentCapture && consentCapture.receipt === receipt) {
    await Promise.race([consentCapture.promise, new Promise((r) => setTimeout(r, 5000))]);
  }
  const stamp = withTimestamp ? ' ' + fileStamp() : '';
  if (userAudio || consent || promptAudio || receipt) {
    const entries = [{ name, data: xmlBlob }];
    if (userAudio) entries.push({ name: media.name || 'audio.mp3', data: media.blob });
    if (consent?.blob) entries.push({ name: consent.name || current.consentClip, data: consent.blob });
    if (promptAudio?.blob) entries.push({ name: promptAudio.name || current.consentPromptClip, data: promptAudio.blob });
    if (receipt) {
      const full = { ...receipt, textTitle: current.title || '' };
      entries.push({ name: 'consent-receipt.json', data: new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' }) });
      entries.push({ name: 'consent-receipt.txt', data: new Blob([consentReceiptText(full)], { type: 'text/plain' }) });
    }
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

/* ---------------- Upload to Google Drive (queued, non-blocking) ----------------
 * Many texts/recordings can sit pending indefinitely: each is persisted in
 * IndexedDB ('upload:'+docId, with its blob) and survives restarts. Uploads run
 * ONE AT A TIME (gentle on weak field connections, and a single clear progress
 * bar). When a connection returns — or on a periodic timer — pending and
 * previously-failed uploads auto-retry forever, so the user can record now and
 * the work leaves the device days/weeks later when there's signal.
 *
 * No byte-level RESUME (the relay takes the whole file as one base64 POST), so a
 * dropped upload retries the whole file — but it is never lost, and Drive never
 * overwrites (timestamped names). True resume would need the Drive REST API.
 */

// In-memory view of the queue (docId -> { name, status, error, indeterminate,
// sent, total }); the blobs themselves stay in IndexedDB. status is one of
// 'waiting' | 'uploading' | 'paused' | 'error'.
const uploadView = new Map();
let uploadListOpen = false;
const RETRY_EVERY_MS = 90000;

function uploadState(docId) {
  return (st) => {
    if (st.status === 'cancelled' || st.status === 'done') {
      uploadView.delete(docId);
      if (st.status === 'done') {
        // Once a text is safely on Drive (status 'done' = confirmed by the relay
        // poll), optionally delete it from the device — see deleteAfterUpload()
        // for who decides (researcher link param, else per-app default). This
        // fires at the single upload-completion point, so it also covers
        // background-retry uploads that finish long after the user tapped Send.
        if (deleteAfterUpload()) {
          deleteUploadedDoc(docId);
          toast(t('record.sentRemoved', { name: st.name }), 6000);
        } else {
          // Record proof-of-backup on the kept doc so a later remote delete can
          // verify the content is safely on Drive (delete-safety, Phase 1).
          // uploadedModified is the SEND-time stamp; a later edit moves modified
          // past it, so it reads as "changed since backup". Stamp the LIVE copy
          // too (if this doc is open) — else the next persist() would write
          // `current` back and silently drop these markers.
          const stamp = (d) => {
            if (st.fileId) d.uploadedFileId = st.fileId;
            d.uploadedModified = (st.docModified != null) ? st.docModified : d.modified;
            d.uploadedAt = Date.now();
          };
          if (current && current.id === docId) stamp(current);
          db.getDoc(docId).then((d) => { if (d) { stamp(d); return db.putDoc(d); } }).catch(() => {});
          toast(t('upload.done', { name: st.name }), 6000);
        }
      }
      renderUploadQueue();
      pumpUploads();
      return;
    }
    uploadView.set(docId, {
      name: st.name, status: st.status, error: st.error,
      indeterminate: st.indeterminate, sent: st.sent, total: st.total,
    });
    renderUploadQueue();
    if (st.status === 'error') pumpUploads(); // don't let one failure block the rest
  };
}

// Start the next waiting upload if nothing is currently uploading or paused.
// Claims the slot synchronously (status -> 'uploading') so re-entrant calls
// can't double-start, then fetches the blob and launches.
function pumpUploads() {
  if (!navigator.onLine) { renderUploadQueue(); return; }
  const entries = [...uploadView.entries()];
  // Only one upload runs at a time. A user-PAUSED item is skipped (it doesn't
  // hold the slot), so the rest of the queue keeps moving past it.
  if (entries.some(([, v]) => v.status === 'uploading')) {
    renderUploadQueue();
    return;
  }
  const next = entries.find(([, v]) => v.status === 'waiting');
  if (!next) { renderUploadQueue(); return; }
  const [docId, v] = next;
  uploadView.set(docId, { ...v, status: 'uploading', indeterminate: true });
  renderUploadQueue();
  db.getMedia('upload:' + docId).then((rec) => {
    // The slot may have been cancelled/deleted during this async read — only
    // proceed if the entry is still present and still ours to upload.
    const cur = uploadView.get(docId);
    if (!cur || cur.status !== 'uploading') return;
    if (!rec || !rec.relayUrl || !rec.blob) { // record vanished — drop it
      uploadView.delete(docId); renderUploadQueue(); pumpUploads(); return;
    }
    new DriveUpload(docId, rec, uploadState(docId)).start();
  }).catch(() => {
    const cur = uploadView.get(docId);
    if (cur) uploadView.set(docId, { ...cur, status: 'error' });
    renderUploadQueue();
  });
}

// Reconcile the view with what's persisted, reset failures to retry, then pump.
// Runs at startup, when the network returns, and on a periodic timer.
async function retryPendingUploads() {
  let pending = [];
  try { pending = await listPendingUploads(); } catch { /* best effort */ }
  const ids = new Set(pending.map((p) => p.docId));
  for (const { docId, rec } of pending) {
    const v = uploadView.get(docId);
    if (!v) uploadView.set(docId, { name: rec.name, status: rec.paused ? 'paused' : 'waiting' });
    else if (v.status === 'error') uploadView.set(docId, { ...v, status: 'waiting' });
  }
  // Drop view entries whose persisted record is gone (done/cancelled), unless
  // one is mid-flight.
  for (const id of [...uploadView.keys()]) {
    if (!ids.has(id) && uploadView.get(id)?.status !== 'uploading') uploadView.delete(id);
  }
  renderUploadQueue();
  pumpUploads();
}

function renderUploadQueue() {
  const bar = $('#upload-bar');
  if (!bar) return;
  const items = [...uploadView.entries()].map(([docId, v]) => ({ docId, ...v }));
  if (!items.length) { bar.hidden = true; return; }
  bar.hidden = false;
  const label = $('#upload-label');
  const fill = $('#upload-fill');
  const pauseBtn = $('#upload-pause');
  const cancelBtn = $('#upload-cancel');
  const toggle = $('#upload-toggle');
  const active = items.find((i) => i.status === 'uploading') || items.find((i) => i.status === 'paused');
  const total = items.length;
  const others = total - (active ? 1 : 0);

  fill.classList.toggle('indeterminate', !!(active && active.status === 'uploading'));
  fill.style.width = active && active.status === 'uploading' ? '100%'
    : (active && active.total ? Math.round((active.sent / active.total) * 100) + '%' : '0%');

  if (active && active.status === 'uploading') {
    label.textContent = t('upload.working', { name: active.name }) +
      (others ? ' · ' + t('upload.more', { n: others }) : '');
  } else if (active && active.status === 'paused') {
    label.textContent = t('upload.pausedSummary', { name: active.name }) +
      (others ? ' · ' + t('upload.more', { n: others }) : '');
  } else {
    label.textContent = navigator.onLine ? t('upload.retrying', { n: total }) : t('upload.waiting', { n: total });
  }

  pauseBtn.hidden = false;
  if (active && active.status === 'uploading') { pauseBtn.textContent = t('upload.pause'); pauseBtn.dataset.docId = active.docId; pauseBtn.dataset.act = 'pause'; }
  else if (active && active.status === 'paused') { pauseBtn.textContent = t('upload.resume'); pauseBtn.dataset.docId = active.docId; pauseBtn.dataset.act = 'resume'; }
  else { pauseBtn.textContent = t('upload.sendNow'); pauseBtn.dataset.docId = ''; pauseBtn.dataset.act = 'retry'; }

  // Always offer to dismiss the lead item — even a single failed/waiting upload
  // (otherwise a stuck single upload would have no escape hatch).
  const lead = active || items[0];
  cancelBtn.hidden = false;
  cancelBtn.dataset.docId = lead.docId;

  if (toggle) {
    if (total > 1) { toggle.hidden = false; toggle.textContent = (uploadListOpen ? '▾ ' : '▸ ') + total; }
    else { toggle.hidden = true; uploadListOpen = false; }
  }

  const list = $('#upload-list');
  if (list) {
    list.hidden = !(uploadListOpen && total > 1);
    if (!list.hidden) {
      list.innerHTML = '';
      for (const it of items) {
        const status = it.status === 'uploading' ? t('upload.uploadingShort')
          : it.status === 'paused' ? t('upload.pausedItem')
          : it.status === 'error' ? t('upload.errorShort')
          : t('upload.queuedShort');
        const li = document.createElement('li');
        li.innerHTML = '<span class="up-name"></span><span class="up-state"></span>' +
          '<button class="up-cancel icon-btn2">✕</button>';
        li.querySelector('.up-name').textContent = it.name;
        li.querySelector('.up-state').textContent = status;
        li.querySelector('.up-cancel').title = t('upload.cancel');
        li.querySelector('.up-cancel').addEventListener('click', async () => {
          const up = getUpload(it.docId);
          if (up) { up.cancel(); }
          else {
            await db.deleteMedia('upload:' + it.docId).catch(() => {});
            uploadView.delete(it.docId);
            renderUploadQueue();
            pumpUploads();
          }
        });
        list.appendChild(li);
      }
    }
  }
}

async function doUpload() {
  if (!current) return;
  const docId = current.id;
  try {
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
      // Content stamp at SEND time (persist() above just set current.modified).
      // Recorded on the doc when the upload completes; a later edit moves
      // modified, so it reads as "changed since this backup" (delete-safety).
      docModified: current.modified,
    };
    await db.putMedia('upload:' + docId, rec);
    uploadView.set(docId, { name: rec.name, status: 'waiting' });
    toast(t('upload.queuedToast'));
    renderUploadQueue();
    pumpUploads();
  } catch (e) {
    toast(t('upload.error', { msg: e.message }), 9000);
  }
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
  // Texts-screen button template (default all on) + the Phone-Recording welcome
  // heading (prefilled from the language name until the researcher edits it).
  const lb = new Set(Array.isArray(settings.linkButtons) ? settings.linkButtons : ALL_BUTTONS);
  f.elements.btnNew.checked = lb.has('new');
  f.elements.btnAudio.checked = lb.has('audio');
  f.elements.btnRecord.checked = lb.has('record');
  f.elements.btnOpen.checked = lb.has('open');
  f.elements.autoDel.checked = !!settings.autoDelUploaded;
  const welcomeEl = $('#record-welcome');
  if (welcomeEl) welcomeEl.value = settings.recordWelcome
    || t('record.welcomeDefault', { lang: settings.vernName || settings.vernLang || '' });
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
  settings.consentResp = ['record', 'signature'].includes(f.elements.consentResp.value) ? f.elements.consentResp.value : 'yesno';
  const rawConsentAudio = f.elements.consentAudioUrl.value.trim();
  settings.consentAudioUrl = rawConsentAudio;
  settings.consentAudio = resolveAudioInput(rawConsentAudio);
  // Link templates (decoupled from this device, like linkSendOptions): which
  // Texts-screen buttons to show + the Phone-Recording welcome heading.
  const lb = [];
  if (f.elements.btnNew.checked) lb.push('new');
  if (f.elements.btnAudio.checked) lb.push('audio');
  if (f.elements.btnRecord.checked) lb.push('record');
  if (f.elements.btnOpen.checked) lb.push('open');
  settings.linkButtons = lb;
  // Auto-delete-after-upload travels with the link as an explicit on/off, so the
  // researcher's current choice always overwrites whatever the device had.
  settings.autoDelUploaded = !!f.elements.autoDel.checked;
  const welcomeEl = $('#record-welcome');
  if (welcomeEl) settings.recordWelcome = welcomeEl.value.trim();
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
    // Delete-after-upload (always travels as explicit on/off).
    p.set('autoDel', settings.autoDelUploaded ? 'on' : 'off');
    p.set('recFormat', normRecFormat(settings.recordFormat)); // capture format travels with every link
    // Which Texts-screen buttons the coworker sees (always travels, like the
    // send options, so the researcher's current choice overwrites older ones).
    p.set('btns', (Array.isArray(settings.linkButtons) ? settings.linkButtons : ALL_BUTTONS).join(','));
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

  // Phone Recording link builder → the sibling /text-recorder/ app (the installable
  // "Flextext Recorder"). Refuses to produce a link until the welcome heading is filled in.
  $('#btn-copy-record-link').addEventListener('click', async () => {
    const f2 = $('#ws-form');
    applyResearchFormToSettings(f2); // link reflects the CURRENT form (+ persists welcome)
    const welcome = ($('#record-welcome').value || '').trim();
    if (!welcome) { $('#record-welcome').focus(); toast(t('recordlink.needWelcome'), 7000); return; }
    if (!f2.elements.vernLang.value.trim()) { toast(t('toast.needVern')); return; }
    if (!f2.elements.analLang.value.trim() && !confirm(t('research.analBlankConfirm'))) return;
    settings.recordWelcome = welcome;
    saveSettings(settings);
    const p = new URLSearchParams();
    const map = { vernLang: 'vern', vernName: 'vernName', vernFont: 'vernFont',
                  analLang: 'anal', analName: 'analName', analFont: 'analFont' };
    for (const [key, qp] of Object.entries(map)) {
      const v = f2.elements[key].value.trim();
      if (v) p.set(qp, v);
    }
    p.set('lang', getLang());
    p.set('welcome', welcome);
    p.set('upload', settings.uploadFolder || '');
    p.set('send', (settings.linkSendOptions?.length
      ? settings.linkSendOptions
      : ['share', 'upload', 'save', 'download']).join(','));
    // Delete-after-upload (always travels as explicit on/off). The recorder
    // also defaults to deleting when no link param is present (see
    // deleteAfterUpload()), but an explicit value lets a researcher turn it off.
    p.set('autoDel', settings.autoDelUploaded ? 'on' : 'off');
    p.set('recFormat', normRecFormat(settings.recordFormat)); // capture format travels with every link
    if (settings.consentMode && settings.consentMode !== 'off') {
      p.set('consentMode', settings.consentMode);
      if (settings.consentMsg) p.set('consentMsg', settings.consentMsg);
      if (settings.consentAudio) p.set('consentAudio', settings.consentAudio);
      p.set('consentResp', settings.consentResp || 'yesno');
    }
    // The recorder is its OWN app at the sibling path /text-recorder/ (a disjoint
    // PWA scope, so it installs separately from the editor). Build that URL from
    // the editor's location: strip the editor's own directory, append the sibling.
    const dir = location.pathname.replace(/[^/]*$/, '');   // /flextext-editor/  (or / in dev)
    const parent = dir.replace(/[^/]+\/$/, '');            // /flextext-editor/ -> /  (dir keeps its own leading slash)
    const url = location.origin + parent + 'text-recorder/?' + p.toString();
    const out = $('#record-link-out');
    out.hidden = false;
    out.textContent = url;
    try {
      await navigator.clipboard.writeText(url);
      toast(t('toast.linkCopied'));
    } catch {
      toast(t('toast.linkCopyManual'));
    }
  });

  // Task link builder (text + audio + optional existing transcription)
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
    let flextextUrl = '';

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
          : err.code === 'notAudio' ? t('task.notAudio', { mime: err.mime || '?' })
          : t('task.checkFailed', { msg: err.message });
        check.textContent = '⚠ ' + msg;
        return; // no link for a bad file
      }
    } else {
      check.hidden = true;
    }

    // Validate an optional attached flextext: show its writing-system codes and
    // HARD-REFUSE the link if vern/anal don't match the setup, so a mismatched
    // file is never sent to a coworker. (Reuses the WS checker's survey.)
    const ftIn = tf.elements.taskFlextext.value.trim();
    const wsOut = $('#task-ws');
    if (ftIn) {
      flextextUrl = resolveAudioInput(ftIn); // same Drive/direct resolution as audio
      if (!flextextUrl) { wsOut.hidden = false; wsOut.textContent = '⚠ ' + t('task.badFlextext'); return; }
      wsOut.hidden = false;
      wsOut.textContent = t('task.ftChecking');
      $('#task-link-out').hidden = true;
      let xml;
      try { xml = await (await fetchFileViaUrl(flextextUrl)).blob.text(); }
      catch (err) { wsOut.textContent = '⚠ ' + t('task.ftFetchFailed', { msg: err.message }); return; }
      // Only the first <interlinear-text> is delivered to the coworker, so refuse a
      // multi-text export — otherwise the WS survey's union of codes gives a false
      // pass/fail and the other texts are silently dropped.
      const parsed = parseFlextext(xml);
      if (parsed.error || !parsed.texts.length) { wsOut.textContent = '⚠ ' + t('task.ftParseFailed', { msg: parsed.error || t('task.ftNone') }); return; }
      if (parsed.texts.length > 1) { wsOut.textContent = '⚠ ' + t('task.ftMultiText', { n: parsed.texts.length }); return; }
      const a = analyzeFlextextWs(xml);
      if (a.error) { wsOut.textContent = '⚠ ' + t('task.ftParseFailed', { msg: a.error }); return; }
      const vernLang = f2.elements.vernLang.value.trim();
      const analLang = f2.elements.analLang.value.trim();
      const vernOk = a.vernCodes.length > 0 && a.vernCodes.every(c => c === vernLang);
      const analOk = !analLang || a.analCodes.length === 0 || a.analCodes.every(c => c === analLang);
      const fmt = (codes) => codes.length ? codes.join(', ') : t('task.ftNone');
      if (vernOk && analOk) {
        wsOut.textContent = '✓ ' + t('task.ftDetected', { vern: fmt(a.vernCodes), anal: fmt(a.analCodes) });
      } else {
        // Hard refuse: the file's writing-system codes must match the setup.
        wsOut.textContent = '⚠ ' + t('task.ftMismatch', {
          vern: fmt(a.vernCodes), vernWant: vernLang || '—',
          anal: fmt(a.analCodes), analWant: analLang || '—',
        });
        return; // no link until the file's codes match
      }
    } else {
      wsOut.hidden = true; // clear any stale ⚠ from a previous flextext attempt
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
    // Delete-after-upload (always travels as explicit on/off).
    p.set('autoDel', settings.autoDelUploaded ? 'on' : 'off');
    p.set('recFormat', normRecFormat(settings.recordFormat)); // capture format travels with every link
    // Which Texts-screen buttons the coworker sees (always travels, like the
    // send options, so the researcher's current choice overwrites older ones).
    p.set('btns', (Array.isArray(settings.linkButtons) ? settings.linkButtons : ALL_BUTTONS).join(','));
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
    if (flextextUrl) p.set('flextext', flextextUrl);
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

  // Recording format (archival capture) — default 32-bit WAV. Travels with links;
  // the recorder app reads it from the link (applyUrlSettings), not this control.
  const rfSel = $('#recformat-select');
  if (rfSel) {
    rfSel.value = recordFormatPref();
    rfSel.addEventListener('change', () => {
      settings.recordFormat = normRecFormat(rfSel.value);
      saveSettings(settings);
    });
  }

  // Audio converter (any recording → small task-ready MP3) — the send-to-assistant
  // distribution format, separate from the recording (capture) format above.
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
  // Touch devices have no keyboard: tap the small ? (Help) button 7× in quick
  // succession to toggle the Research tab. Targeting the Help button — not the
  // whole title bar — avoids accidental triggers from stray taps (barely
  // literate users, wet screens), while staying recoverable without Ctrl+Alt+R.
  let taps = 0, last = 0;
  $$('.help-btn').forEach((el) => {
    el.addEventListener('click', () => {
      const now = Date.now();
      taps = now - last < 1500 ? taps + 1 : 1;
      last = now;
      if (taps >= 7) { taps = 0; toggleResearchHidden(); }
    });
  });
}

/* ---------------- Record-only mode (Phone Recording) ----------------
 * A stripped-down UI for native-speaker coworkers to gather audio on a phone.
 * It reuses the editor's recording / consent / storage / upload engine wholesale
 * (requestConsentThen → openRecordModal → saveRecording → newDocFromAudio →
 * openShareMenu / doUpload); only the surrounding UI differs. Reachable as the
 * installable "Flextext Recorder" app (the sibling /text-recorder/) or via a ?mode=record link.
 */

// The researcher-set welcome heading (includes the language name). Falls back to
// a localized default if a link/device somehow has none.
function recordWelcomeText() {
  const custom = (settings.recordWelcome || '').trim();
  if (custom) return custom;
  // Collapse the gap left when no language name is set (e.g. "Record  texts here").
  return t('record.welcomeDefault', { lang: settings.vernName || settings.vernLang || '' })
    .replace(/\s{2,}/g, ' ').trim();
}

// Build the record-only screen. #view-record is static in the Flextext Recorder shell
// (text-recorder/index.html) and created on demand when a ?mode=record link is opened
// in the editor app — so the record markup has a single source here.
function renderRecordView() {
  let v = $('#view-record');
  if (!v) {
    v = document.createElement('section');
    v.id = 'view-record';
    v.className = 'view';
    ($('main') || document.body).appendChild(v);
  }
  v.innerHTML = `
    <div class="record-screen">
      <p class="record-welcome"></p>
      <button id="btn-record-big" class="primary-btn record-big">
        <span class="rec-dot"></span><span class="record-big-label"></span></button>
      <h3 class="record-list-h"></h3>
      <ul id="record-list" class="doc-list rec-list"></ul>
      <p id="record-empty" class="empty-note" hidden></p>
    </div>`;
  v.querySelector('.record-welcome').textContent = recordWelcomeText();
  v.querySelector('.record-big-label').textContent = t('record.btn');
  v.querySelector('.record-list-h').textContent = t('record.savedH');
  v.querySelector('#record-empty').textContent = t('record.empty');
  $('#btn-record-big').addEventListener('click', () => requestConsentThen(() => openRecordModal()));
}

async function renderRecordList() {
  const ul = $('#record-list');
  if (!ul) return;
  const docs = await db.listDocs();
  ul.innerHTML = '';
  const empty = $('#record-empty');
  if (empty) empty.hidden = docs.length > 0;
  for (const d of docs) {
    const li = document.createElement('li');
    li.className = 'rec-item';
    const date = d.modified ? new Date(d.modified).toLocaleString() : '';
    li.innerHTML = `
      <div class="rec-item-main">
        <span class="doc-name"></span>
        <span class="doc-meta"></span>
      </div>
      <div class="rec-item-actions">
        <button class="rec-send secondary-btn"></button>
        <button class="doc-delete icon-btn"></button>
      </div>`;
    li.querySelector('.doc-name').textContent = d.title || t('untitled');
    li.querySelector('.doc-meta').textContent = date;
    const send = li.querySelector('.rec-send');
    send.textContent = t('record.send');
    const del = li.querySelector('.doc-delete');
    del.title = t('texts.deleteTitle');
    del.innerHTML = '&#128465;';
    send.addEventListener('click', async () => {
      const rec = await db.getDoc(d.id);
      if (!rec) { toast(t('toast.cantOpen')); return; }
      current = rec;
      openShareMenu();
    });
    del.addEventListener('click', async () => {
      if (confirm(t('texts.confirmDelete', { title: d.title || t('untitled') }))) {
        const up = getUpload(d.id);
        if (up) up.cancel(); else uploadView.delete(d.id);
        await db.deleteDoc(d.id);
        if (current && current.id === d.id) current = null;
        renderUploadQueue();
        renderRecordList();
      }
    });
    ul.appendChild(li);
  }
}

function setupRecordMode() {
  renderRecordView();
  renderRecordList();
  show('record');
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

// A dev/LAN host (localhost, the Android-emulator host alias, *.local, or any
// private-network IP) — i.e. the dev server, never the GitHub Pages production
// host. Used to skip the service worker so dev testing always runs fresh files,
// now that the HTTPS dev server makes a LAN origin a secure context where a SW
// would otherwise register and cache.
function isDevHost(h) {
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '10.0.2.2' ||
    h.endsWith('.local') ||
    /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const isDev = isDevHost(location.hostname) &&
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

// Controls present in BOTH the editor and the record-only app: the recording
// modal, the share/save-menu backdrop, and the upload status bar. Every lookup
// is optional so it is safe to call from the minimal record.html page.
function wireSharedModals() {
  $('#record-toggle')?.addEventListener('click', () => {
    if (rec?.recording) stopRecording().catch(() => {});
    else startRecording();
  });
  $('#record-redo')?.addEventListener('click', () => { discardRecording(); recordUI('idle'); });
  $('#record-title')?.addEventListener('input', syncRecordSaveEnabled);
  $('#record-title')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && $('#record-title').value.trim()) {
      e.preventDefault();
      saveRecording().catch(err => toast(t('convert.failed', { msg: err.message }), 6000));
    }
  });
  $('#record-save')?.addEventListener('click', () => {
    saveRecording().catch(err => toast(t('convert.failed', { msg: err.message }), 6000));
  });
  $('#record-cancel')?.addEventListener('click', closeRecordModal);
  $('#record-modal')?.addEventListener('click', (e) => {
    if (e.target === $('#record-modal')) closeRecordModal();
  });
  $('#share-menu')?.addEventListener('click', (e) => { if (e.target === $('#share-menu')) closeShareMenu(); });
  $('#upload-pause')?.addEventListener('click', () => {
    const btn = $('#upload-pause');
    const act = btn.dataset.act;
    const up = getUpload(btn.dataset.docId || '');
    if (act === 'pause') up?.pause();
    else if (act === 'resume') up?.resume();
    else retryPendingUploads(); // "Send now": kick the whole queue
  });
  $('#upload-cancel')?.addEventListener('click', async () => {
    const id = $('#upload-cancel').dataset.docId || '';
    const up = getUpload(id);
    if (up) up.cancel();
    else if (id) {
      await db.deleteMedia('upload:' + id).catch(() => {});
      uploadView.delete(id);
      renderUploadQueue();
      pumpUploads();
    }
  });
  $('#upload-toggle')?.addEventListener('click', () => { uploadListOpen = !uploadListOpen; renderUploadQueue(); });
}

function setup() {
  migrateSettings();
  const { settingsChanged, task } = applyUrlSettings();
  settings = loadSettings();
  applyI18n();

  // Language selector — present in both the editor and the recorder.
  const langSel = $('#lang-select');
  if (langSel) {
    langSel.value = getLang();
    langSel.addEventListener('change', () => {
      setLang(langSel.value);
      applyI18n();
      if (RECORD_MODE) { renderRecordView(); renderRecordList(); return; }
      applyHelpResearchVisibility();
      renderDocList();
      if (!$('#view-gloss').hidden) renderGloss();
    });
  }

  // Shared engine wiring + housekeeping (runs in both modes).
  wireSharedModals();
  setupBanners();
  window.addEventListener('online', () => { retryPendingAudio(); retryPendingUploads(); });
  window.addEventListener('offline', () => { renderUploadQueue(); });
  // Pending uploads AND pending downloads (task audio + attached flextext) keep
  // retrying forever while the app is open — a flaky village link that never
  // fires a clean offline→online edge still gets the work moved eventually.
  setInterval(() => {
    if (!navigator.onLine) return;
    retryPendingAudio(); // also sweeps pending task flextexts
    if (uploadView.size) retryPendingUploads();
  }, RETRY_EVERY_MS);
  retryPendingAudio();
  retryPendingUploads();
  syncConsentAudio(); // fetch/cache the consent prompt audio if configured
  // Ask the browser to protect our storage (texts + recordings) from being
  // silently evicted when the device runs low on space.
  navigator.storage?.persist?.().catch(() => {});
  setupServiceWorker();
  primeGeolocationOnce();

  // ----- Record-only mode: show just the recorder UI and stop here. -----
  if (RECORD_MODE) {
    setupRecordMode();
    return;
  }

  // ----- Full editor wiring -----
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
  // The researcher can show/hide each Texts-screen button via a link (btns=…).
  const shownButtons = allowedButtons();
  $('#btn-new').hidden = !shownButtons.has('new');
  $('#btn-new-audio').hidden = !shownButtons.has('audio');
  $('#btn-record').hidden = !shownButtons.has('record');
  $('#btn-import').hidden = !shownButtons.has('open');
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
    if (settingsChanged) toast(t('toast.setupReceived'), 5000);
  }
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
// Dev-only queue inspection hooks — never exposed on the production host.
if (isDevHost(location.hostname)) {
  Object.assign(window.__app, { uploadView, renderUploadQueue, allowedButtons });
}
