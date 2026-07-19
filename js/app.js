/* app.js — UI controller for the Flextext Editor PWA. */

import {
  parseFlextext, serializeFlextext, makeDoc, makeWord, makeSegment,
  getBaselineParagraphs, reconcileBaseline, segmentText, tokenize,
  canMerge, mergeWords, breakPhrase, newGuid,
  surveyWritingSystems, remapWritingSystems,
} from './flextext.js';
import * as db from './db.js';
import { t, getLang, setLang, applyI18n, LANGS, ENGINE_VERSION } from './i18n.js';
import { Player, downloadAudioForDoc, getDownload, clearPartial, driveFileId, isProbablyUrl, probeAudioUrl, ensureAsset, getAsset, fetchFileViaUrl } from './audio.js';
import { convertToMp3 } from './convert.js';
import { losslessSupported, recFormatSupported, PCMRecorder, encodeWav, encodeRecording, normalizePeak, reduceChannels,
         normRecFormat, REC_FORMATS, DEFAULT_REC_FORMAT } from './record-pcm.js';
import { makeZip } from './zip.js';
import { DriveUpload, driveFolderId as parseDriveFolder, getUpload, listPendingUploads, setWorkerUploadTarget } from './upload.js';
import * as Sync from './sync.js';
import { initResearcherPanel } from './researcher-panel.js';
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

// Researcher-console mode: the standalone "Flextext Researcher" app (its index.html sets
// window.__MODE='researcher'), or — LOCAL DEV ONLY — ?mode=researcher on the editor origin.
// In PRODUCTION the editor redirects ?mode=researcher to the standalone app (see setup());
// there is no in-editor URL entry anymore.
const RESEARCHER_MODE = (typeof window !== 'undefined' && window.__MODE === 'researcher') ||
  (new URLSearchParams(location.search).get('mode') === 'researcher' && isLocalDev());
// Crowd mode: the PUBLIC crowd-source recorder (crowd-recorder/index.html sets
// window.__MODE='crowd'). No PWA/SW/sync — an always-fresh page anyone with the link
// can use: welcome → consent → record → submit straight to the worker (which relays
// to the researcher's Drive). It shares this ORIGIN with the field apps, so it must
// NEVER write the shared settings/lang/doc stores — its config lives in memory and
// its only persistence is its OWN IndexedDB database (unsent submissions).
const CROWD_MODE = typeof window !== 'undefined' && window.__MODE === 'crowd';

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
// Custom domain (the …68mh29kgsd.workers.dev host still answers additively, but the
// custom domain is what the Google OAuth consent screen shows + doesn't leak the CF
// account subdomain). REQUIRES: the domain bound on the Worker (wrangler deploy) AND
// https://connect.flextext.app/v1/oauth/google/callback registered in the Google OAuth
// client — deploying this client before both = redirect_uri_mismatch on sign-in.
const DEFAULT_WORKER = 'https://connect.flextext.app';
const DEFAULT_RELAY_TOKEN = '7a93cb82d8ad2bd533a75ddf03bebc92501494ca57dab46c5b9f0c5aef00db34';

// Local-dev environment switch: on localhost the client talks to a LOCAL `wrangler
// dev` worker (with its own .dev.vars permissive CORS + Turnstile TEST keys), so the
// PRODUCTION worker never needs localhost in its allowlist. An explicit
// settings.relayWorker always wins (e.g. a researcher's own R2, or a VM dev URL).
const LOCAL_WORKER = 'http://localhost:8787';                 // `wrangler dev` default
const TURNSTILE_SITE_KEY = '0x4AAAAAADo0TdBBVpldATJ6';        // production widget (rulingants.github.io)
const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';  // Cloudflare always-pass key (local dev only)
function isLocalDev() { return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname); }
function workerBase() {
  const explicit = (settings.relayWorker || '').trim();
  return explicit || (isLocalDev() ? LOCAL_WORKER : DEFAULT_WORKER);
}
function turnstileSiteKey() { return isLocalDev() ? TURNSTILE_TEST_SITE_KEY : TURNSTILE_SITE_KEY; }

/* ---------------- Settings (writing systems) ---------------- */

const SETTINGS_KEY = 'flextext-ws-settings';

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch { return {}; }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  db.broadcastLive('settings');   // live-sync settings to other same-origin windows/apps
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
  const gotSettings = p.has('vern') || p.has('anal') || p.has('welcome') || p.has('btns') || p.has('editorRec') || p.has('autoDel') || p.has('recFormat') || p.has('dsp') || p.has('agc');
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
    if (p.has('send')) {
      s.sendOptions = p.get('send').split(',')
        .filter(o => ['share', 'upload', 'save', 'download'].includes(o));
    }
    // Consent is multi-select. New array params win; legacy single consentMode/consentResp are migrated,
    // preserving "off = off". (Link builders are gone, but legacy links + hand-built URLs still work.)
    if (p.has('consentMode')) {
      const m = p.get('consentMode');
      s.consentAsk = (m === 'text' || m === 'audio') ? [m] : [];
      s.consentConfirm = (m === 'off') ? []
        : [['record', 'signature'].includes(p.get('consentResp')) ? p.get('consentResp') : 'yesno'];
      delete s.consentMode; delete s.consentResp;
    }
    if (p.has('consentAsk')) s.consentAsk = p.get('consentAsk').split(',').filter((x) => x === 'text' || x === 'audio');
    if (p.has('consentConfirm')) s.consentConfirm = p.get('consentConfirm').split(',').filter((x) => ['yesno', 'record', 'signature'].includes(x));
    if (p.has('consentMsg')) s.consentMsg = p.get('consentMsg');
    if (p.has('consentAudio')) s.consentAudio = p.get('consentAudio');
    // Whether a text is deleted from the device after it uploads to Drive
    // (researcher's explicit choice; overrides the per-app default below).
    if (p.has('autoDel')) s.autoDelUploaded = p.get('autoDel') === 'on';
    // Capture (recording) format the device should use; default 32-bit WAV.
    if (p.has('recFormat')) s.recordFormat = normRecFormat(p.get('recFormat'));
    // Optional microphone processing the researcher turned on (comma list).
    if (p.has('dsp')) {
      const on = new Set(p.get('dsp').split(',').filter(Boolean));
      s.nr = on.has('nr'); s.echo = on.has('echo'); s.norm = on.has('norm');
    }
    // AGC mode — its own param: 'off' (default, faithful) | 'on' (auto-gain) | 'auto'.
    if (p.has('agc')) s.agc = ['on', 'off', 'auto'].includes(p.get('agc')) ? p.get('agc') : 'off';
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
    // Preserve a returning Google sign-in fragment (#gauth=<id>.<token>): the
    // researcher panel's consumeGauth() reads it LATER in setup(), so stripping
    // it here would silently drop the session and bounce back to the sign-in
    // screen. route() consumes + strips it once the creds are saved.
    const keepHash = /[#&]gauth=/.test(location.hash || '') ? location.hash : '';
    history.replaceState(null, '', location.pathname + keepHash);
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

const VIEWS = ['texts', 'baseline', 'gloss', 'research', 'help', 'record', 'researcher'];

// The researcher panel is a SEPARATE full-screen view. Its standalone home is the "Flextext
// Researcher" app (RESEARCHER_MODE); inside the editor it's reachable only via the managed-install
// gesture (setupResearchToggle) — there is no ?mode=researcher URL entry here (that redirects to
// the app), and the old emailed ?reset= password-reset flow is gone with Google Sign-In.
let researcherPanelApi = null;   // set in setup(); the research-toggle gesture opens it on managed installs

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
  // The researcher panel is a full takeover with its own in-view header — hide both bars.
  if (home) home.hidden = inEditor || view === 'researcher';
  if (editor) editor.hidden = !inEditor || view === 'researcher';
  if (!inEditor) {
    $$('#topbar-home .top-tab').forEach(b =>
      b.setAttribute('aria-selected', String(b.dataset.view === view)));
  } else {
    $$('#topbar-editor .top-tab').forEach(b =>
      b.setAttribute('aria-selected', String(b.dataset.tab === view)));
  }
  // Landing on the texts list (no open text) is a safe moment to apply a pending auto-update AND a good
  // time to actively check for a new one (covers a user who only flits through the main screen).
  if (view === 'texts') bgUpdateCheck();
  refreshUpdateBanner();   // show/hide the "exit to update" banner as the open-text state changes
}

function openHelp() {
  helpReturnView = currentView();
  if (helpReturnView === 'help') helpReturnView = 'texts';
  applyHelpResearchVisibility();
  if (!RECORD_MODE) applyDeleteAllButton(); applyInviteButton();   // ensure the gated Delete-All button is present + current
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
      <button class="doc-done icon-btn"></button>
      <button class="doc-delete icon-btn"></button>`;
    li.querySelector('.doc-name').textContent = (d.done ? '\u2713 ' : '') + (d.title || t('untitled'));
    li.querySelector('.doc-meta').textContent =
      t('texts.meta', { n: d.segCount ?? 0, g: d.glossed ?? 0, date });
    li.querySelector('.doc-open').addEventListener('click', () => openDoc(d.id));

    // "Completed" toggle (researcher setting doneEnabled): mark a text finished right
    // from the list \u2014 reports + auto-uploads (setDocDone confirms first if auto-delete is on).
    const doneBtn = li.querySelector('.doc-done');
    if (doneFeatureOn()) {
      doneBtn.classList.toggle('on', !!d.done);
      doneBtn.title = t(d.done ? 'done.unmarkTitle' : 'done.markTitle');
      doneBtn.innerHTML = d.done ? '&#9745;' : '&#9744;';   // \u2611 / \u2610
      doneBtn.addEventListener('click', () => { setDocDone(d.id, !d.done).catch(() => {}); });
    } else doneBtn.remove();

    // Per-text delete (researcher setting allowDelete, default on).
    const del = li.querySelector('.doc-delete');
    if (allowDeleteOn()) {
      del.title = t('texts.deleteTitle');
      del.innerHTML = '&#128465;';
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
    } else del.remove();
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
  // Multi-WS imports: edit the lines matching THIS device's writing systems;
  // all other languages' lines round-trip untouched (flextext.js pickByLang).
  const { texts, error } = parseFlextext(text, { vernLang: settings.vernLang, analLang: settings.analLang });
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

// The optional per-text "Done" button (researcher setting doneEnabled): marks the
// open text finished (togglable), reports at once, and sends it to Drive unless
// this exact content is already there.
function applyDoneButton() {
  const b = $('#btn-done');
  if (!b) return;
  b.hidden = !(doneFeatureOn() && current);
  if (current) b.textContent = current.done ? t('done.btnDone') : t('done.btn');
}
// Mark ANY text finished/unfinished — driven by the texts-list row toggle AND the
// in-editor button. Works whether or not the text is the one currently open. Marking
// done reports to the panel and auto-uploads (unless that exact content is already on
// Drive); with auto-delete on it confirms first (that combo removes the text after upload).
async function setDocDone(docId, wantDone) {
  const isOpen = current && current.id === docId;
  if (wantDone && deleteAfterUpload() && !confirm(t('done.confirmDelete'))) return;
  let rec;
  if (isOpen) { await persist().catch(() => {}); rec = current; }   // flush pending edits first
  else rec = await db.getDoc(docId);
  if (!rec || !!rec.done === wantDone) return;
  rec.done = wantDone;
  rec.doneAt = wantDone ? Date.now() : null;
  try { await db.putDoc(rec); } catch { /* stays in memory; the report below still reflects it */ }
  if (isOpen) applyDoneButton();
  if (wantDone) {
    toast(t('done.marked'), 5000);
    if (!(rec.uploadedSig && rec.uploadedSig === uploadContentSig(rec))) await uploadDocById(rec.id);
  } else {
    toast(t('done.unmarked'), 4000);
  }
  Sync.reportNow();
  renderDocList();
}
async function toggleDone() {
  if (current) await setDocDone(current.id, !current.done);
}

function enterEditor(tab) {
  applyDoneButton();
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

// Consent is MULTI-SELECT: the researcher may require ANY combination of prompts (text/audio) and
// confirmations (yesno/record/signature), all operating together. Stored as arrays consentAsk /
// consentConfirm. These accessors also migrate the older single consentMode/consentResp values, so a
// device that hasn't re-saved still behaves: old consentMode 'off' → consent off; 'text'/'audio' → that
// one prompt; consentResp → that one confirmation. New keys win once written.
function consentAskList(s) {
  s = s || settings;
  if (Array.isArray(s.consentAsk)) return s.consentAsk.filter((x) => x === 'text' || x === 'audio');
  return (s.consentMode && s.consentMode !== 'off') ? [s.consentMode] : [];
}
function consentConfirmList(s) {
  s = s || settings;
  if (Array.isArray(s.consentConfirm)) return s.consentConfirm.filter((x) => ['yesno', 'record', 'signature'].includes(x));
  // legacy: a confirmation only existed when the prompt was on (consentMode !== 'off')
  return (s.consentMode && s.consentMode !== 'off') ? [s.consentResp || 'yesno'] : [];
}

// Build the consent audit record at the moment permission is given. The IP and
// (if the speaker allowed location once) approxLocation are filled in best
// effort by captureConsentContext; both stay "unavailable" when offline or when
// location was never granted. Location NEVER prompts here — see readGeoIfGranted.
function buildConsentReceipt(assent, signatureName) {
  const now = new Date();
  const ask = consentAskList();
  const confirm = consentConfirmList();
  // Every form of consent actually collected (all enabled operate together). A prompt with no explicit
  // confirmation still records the affirm tap as a yes.
  const responseTypes = [];
  if (confirm.includes('yesno')) responseTypes.push('yesno');
  if (confirm.includes('record')) responseTypes.push('recorded');
  if (confirm.includes('signature')) responseTypes.push('signature');
  if (!responseTypes.length) responseTypes.push('yesno');
  return {
    app: CROWD_MODE ? 'Flextext Crowd Recorder' : 'Flextext Editor',
    consentGiven: true,
    responseTypes,
    responseType: responseTypes.join('+'),               // legacy single field, kept for older readers
    signatureName: signatureName || '',
    recordedAssentFile: assent?.name || '',
    promptModes: ask,
    promptMode: ask.join('+') || 'off',                  // legacy
    promptMessage: settings.consentMsg || '',
    promptAudioUrl: ask.includes('audio') ? (settings.consentAudio || '') : '',
    promptAudioFile: (ask.includes('audio') && pendingPromptAudio) ? pendingPromptAudio.name : '',
    timestamp: now.toISOString(),
    localTime: now.toString(),
    timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })(),
    interfaceLang: getLang(),
    // Crowd: a per-VISIT id, never the persistent shared-origin device id — an
    // anonymous contribution must not be linkable across visits (or to a field
    // worker's app on the same browser).
    deviceId: CROWD_MODE ? crowdSessionId : deviceId(),
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
  // Crowd receipts stay location-free: no raw IP, no geolocation for an anonymous
  // stranger (the worker logs coarse country only, server-side). The field-worker
  // calibration (silent IP + opt-in location) does NOT transfer to the public.
  if (CROWD_MODE) return;
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
    'Forms of consent: ' + (r.responseTypes && r.responseTypes.length ? r.responseTypes : [r.responseType]).join(', ') +
      (r.signatureName ? '  — signed: "' + r.signatureName + '"' : '') +
      (r.recordedAssentFile ? '  — audio: ' + r.recordedAssentFile : ''),
    'Date/time: ' + r.localTime + '  (' + r.timestamp + ', ' + r.timezone + ')',
    '',
    'Prompt(s) shown to the speaker (' + ((r.promptModes && r.promptModes.length ? r.promptModes : (r.promptMode && r.promptMode !== 'off' ? [r.promptMode] : [])).join(' + ') || 'none') + '):',
    (r.promptMessage || ((r.promptModes || []).includes('audio') || r.promptMode === 'audio' ? '(spoken — see prompt audio file below)' : '(none)')),
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

// Stable identity of the consent prompt = the Drive FILE id (NOT the resolved /drive
// URL, which also carries the relay token + worker base and differs dev↔prod). This is
// how the app KNOWS the prompt is unchanged: same file id → keep the cached blob and
// play it offline forever; a different file id → re-download once. So a token rotation
// or environment switch no longer forces a needless re-fetch of the same audio.
function consentAudioIdentity() {
  const raw = settings.consentAudioUrl || '';
  const fromRaw = driveFileId(raw);
  if (fromRaw) return fromRaw;
  try { const src = new URL(settings.consentAudio || '').searchParams.get('src'); if (src) return src; } catch { /* not a URL */ }
  return raw || settings.consentAudio || '';
}

// Keep the cached consent-prompt audio in sync with the researcher's URL.
async function syncConsentAudio() {
  if (consentAskList().includes('audio') && settings.consentAudio) {
    try { await ensureAsset('asset:consent-prompt', settings.consentAudio, consentAudioIdentity()); }
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
  // NOTE: deliberately NO applyUpdateIfSafe() here — consent is given immediately before the record modal
  // opens, so a reload in that gap would re-prompt consent. The recorder's update applies via the
  // saveRecording finally, closeRecordModal (cancel), closeShareMenu, or visibilitychange instead.
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
  const ask = consentAskList();
  const confirm = consentConfirmList();
  if (ask.length === 0 && confirm.length === 0) { onApproved(null); return; }  // consent off

  const wantText = ask.includes('text');
  const wantAudio = ask.includes('audio');
  const needYesno = confirm.includes('yesno');
  const needRecord = confirm.includes('record');
  const needSign = confirm.includes('signature');

  const msgEl = $('#consent-message');
  const audioEl = $('#consent-audio');
  const status = $('#consent-status');
  status.hidden = true;
  // Prompt(s): written reminder if asked (and a message exists); spoken reminder if asked. Both can show.
  msgEl.hidden = !(wantText && settings.consentMsg);
  msgEl.textContent = settings.consentMsg || '';
  audioEl.hidden = true;

  if (wantAudio) {
    status.hidden = false;
    status.textContent = t('consent.loadingAudio');
    try {
      // Crowd: fetch the prompt to MEMORY only — ensureAsset would write the shared
      // media store and clobber a field worker's cached prompt on a shared device.
      const asset = CROWD_MODE
        ? await crowdFetchAsset(settings.consentAudio)
        : (await ensureAsset('asset:consent-prompt', settings.consentAudio, consentAudioIdentity())
           || await getAsset('asset:consent-prompt'));
      if (asset?.blob) {
        audioEl.src = URL.createObjectURL(asset.blob);
        audioEl.hidden = false;
        status.hidden = true;
        audioEl.play?.().catch(() => {});
        // Freeze a copy of the EXACT prompt that was played, to bundle beside the response (IRB).
        const m = asset.name && asset.name.match(/\.[a-z0-9]+$/i);
        const ext = m ? m[0] : (asset.mimeType === 'audio/mpeg' ? '.mp3' : '.audio');
        pendingPromptAudio = { blob: asset.blob, name: 'consent-prompt' + ext, mimeType: asset.mimeType };
      } else {
        status.textContent = t('consent.audioFailed');
      }
    } catch {
      status.textContent = t('consent.audioFailed');
    }
    if (wantText && settings.consentMsg) { msgEl.hidden = false; }
  }

  // Confirmations: show EVERY enabled section; ALL must be satisfied before the affirm proceeds.
  $('#consent-record').hidden = !needRecord;
  $('#consent-sign').hidden = !needSign;
  if (needSign) $('#consent-name').value = '';
  if (needRecord) resetConsentRecordUI();
  // (3) yes/no as RADIOS — shown only when the researcher asked for an explicit
  // yes/no; the submit button below is always the single proceed point.
  $('#consent-yesno').hidden = !needYesno;
  const rYes = $('#consent-choice-yes');
  const rNo = $('#consent-choice-no');
  if (rYes) rYes.checked = false;
  if (rNo) rNo.checked = false;
  $('#consent-yes').textContent = t(needYesno ? 'consent.next' : 'consent.give');

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

  // Unified affirm: every enabled confirmation must be satisfied, then collect the evidence and proceed.
  $('#consent-yes').onclick = async () => {
    if (needYesno) {
      if (rNo && rNo.checked) { closeConsentModal(); toast(t('consent.declined'), 5000); return; }
      if (!rYes || !rYes.checked) { status.hidden = false; status.textContent = t('consent.chooseYesNo'); return; }
    }
    if (needRecord && !crec?.blob) { status.hidden = false; status.textContent = t('consent.needRecording'); return; }
    const nm = needSign ? $('#consent-name').value.trim() : '';
    if (needSign && !nm) { $('#consent-name').focus(); toast(t('consent.needName'), 5000); return; }
    let assent = null;
    if (needRecord && crec?.blob) {
      try {
        const conv = settings.convert || {};
        const res = await convertToMp3(crec.blob, { kbps: conv.kbps || 64, sampleRate: conv.rate || 22050, mono: conv.mono !== false });
        assent = { blob: res.blob, name: 'consent-' + fileStamp() + '.mp3' };
      } catch {
        assent = { blob: crec.blob, name: 'consent-' + fileStamp() + '.webm' };
      }
    }
    proceed(assent, nm);
  };
  $('#consent-cancel').onclick = () => closeConsentModal();
  $('#consent-modal').onclick = (e) => { if (e.target === $('#consent-modal')) closeConsentModal(); };
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
  $('#consent-assent-redo').hidden = true;
  $('#consent-assent-preview').hidden = true;
}

async function startConsentAssent() {
  try {
    // Raw signal for faithful capture: auto-gain makes a loud recording fade out
    // over its length; echo-cancellation + noise-suppression also color the audio.
    // All off — fidelity matters more than call-style cleanup for these recordings.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: dspConstraints(),
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
      $('#consent-assent-redo').hidden = false;
      $('#consent-status').hidden = false;
      $('#consent-status').textContent = t('consent.assentReview');
    });
    recorder.start();
    $('#consent-assent-toggle').innerHTML = '&#9632; ' + `<span>${t('consent.recStop')}</span>`;
  } catch (e) {
    $('#consent-status').hidden = false;
    $('#consent-status').textContent = t('record.micError', { msg: e.message });
    // Embedded crowd page whose host stripped allow="microphone": the failure hits
    // HERE first when the recorder requires a recorded "yes" — same escape hatch
    // as the record modal, painted into the consent modal's status line.
    if (CROWD_MODE && window !== window.top) crowdShowFrameEscape('#consent-status');
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
function recordFormatPref() { return normRecFormat(settings.recordFormat); } // crowd sets settings.recordFormat from its public config

// AGC (automatic gain control) is OFF BY DEFAULT — faithful, unmodified capture is
// the archival-correct default (IASA TC-04 etc.). The tradeoff: Chrome/Android set
// the mic level higher than ideal and a web app cannot lower it, so a loud source
// can CLIP there — the human fix is to watch the meter and back off. Researchers who
// don't need archival quality set agc 'on' (auto-gain) per-link. 'auto' is an explicit
// browser-conditional choice (on Chromium / off Firefox). Evaluated at RECORD time.
function isFirefox() { return /Firefox\/|FxiOS/i.test(navigator.userAgent || ''); }
function effectiveAgc() {
  if (settings.agc === 'on') return true;
  if (settings.agc === 'auto') return !isFirefox(); // explicit browser-conditional choice
  return false; // 'off' or unset → faithful capture (the default)
}

// Microphone DSP constraints. Echo cancellation / noise suppression are OFF by
// default (raw capture; the researcher can turn them on per-link, each flagged
// not-for-archiving). AGC is the exception — it has its own browser-conditional
// default (see effectiveAgc) because it's the only in-browser clip protection.
function dspConstraints() {
  // voiceIsolation is a newer, aggressive denoiser (Chrome / some OS defaults) that
  // can OVERRIDE noiseSuppression:false — pin it off so the standard noiseSuppression
  // flag stays the clean control. Legacy goog*/moz* flags were removed from modern
  // browsers (no-ops) and are intentionally not set. Plain false → ignored where
  // unsupported (e.g. Firefox), honored where supported. NB: the cross-browser
  // input-LEVEL difference (Chrome drives the OS mic volume up; Firefox doesn't) is
  // inherent and not controllable here — AGC (Chromium default) keeps it from clipping.
  return {
    echoCancellation: !!settings.echo,
    autoGainControl: effectiveAgc(),
    noiseSuppression: !!settings.nr,
    voiceIsolation: false,
  };
}

// Live level meter: drives the bar + clip indicator while recording, on BOTH
// capture paths — the lossless worklet exposes peak() directly; the MediaRecorder
// (WebM/MP3) path taps the same mic stream with an AnalyserNode (rec.meterAnalyser).
// The rAF loop self-stops when recording ends.
let meterRAF = null;
function recHasMeter() {
  return !!(rec && ((rec.mode === 'pcm' && rec.pcmRec) || rec.meterAnalyser));
}
function recPeak() { // 0..1 linear peak from whichever capture path is live
  if (!rec) return 0;
  if (rec.mode === 'pcm' && rec.pcmRec) return rec.pcmRec.peak();
  if (rec.meterAnalyser && rec.meterBuf) {
    rec.meterAnalyser.getFloatTimeDomainData(rec.meterBuf);
    let p = 0;
    for (let i = 0; i < rec.meterBuf.length; i++) {
      const a = rec.meterBuf[i] < 0 ? -rec.meterBuf[i] : rec.meterBuf[i];
      if (a > p) p = a;
    }
    return p;
  }
  return 0;
}
function startMeter() {
  stopMeter();
  const meter = $('#record-meter');
  const fill = $('#record-meter-fill');
  const warn = $('#record-clip-warn');
  if (!meter || !fill || !recHasMeter()) return;
  let clipHold = 0;
  const tick = () => {
    if (!rec || !rec.recording || !recHasMeter()) { meterRAF = null; return; }
    const p = recPeak(); // 0..1 linear peak
    // sqrt curve so normal speech sits mid-bar and quiet input is still visible.
    fill.style.width = Math.min(100, Math.round(Math.sqrt(p) * 100)) + '%';
    // Colour reflects the absolute level: green → amber → red near full scale.
    fill.style.background = p >= 0.99 ? '#f44336' : p >= 0.9 ? '#ff9800' : p >= 0.7 ? '#ffc107' : '#4caf50';
    if (p >= 0.99) clipHold = 30;        // hold the warning ~0.5s so a brief clip registers
    const clipping = clipHold > 0;
    if (clipHold > 0) clipHold--;
    meter.classList.toggle('clipping', clipping);
    if (warn) warn.hidden = !clipping;
    meterRAF = requestAnimationFrame(tick);
  };
  meterRAF = requestAnimationFrame(tick);
}
function stopMeter() {
  if (meterRAF) { cancelAnimationFrame(meterRAF); meterRAF = null; }
  const fill = $('#record-meter-fill'); if (fill) fill.style.width = '0%';
  $('#record-meter')?.classList.remove('clipping');
  const warn = $('#record-clip-warn'); if (warn) warn.hidden = true;
}

function recordUI(state, extra = {}) {
  const status = $('#record-status');
  const toggle = $('#record-toggle');
  const inReview = state === 'review';
  toggle.hidden = inReview || state === 'saving';
  toggle.classList.toggle('recording', state === 'recording');
  $('#record-save').hidden = !inReview;
  $('#record-redo').hidden = !inReview;
  $('#record-preview').hidden = !inReview;
  // A title is required before the recording can be saved — except in crowd mode:
  // an anonymous visitor is never asked to name anything (the server names the file).
  $('#record-title-row').hidden = !inReview || CROWD_MODE;
  // Meter + mic-distance hint show while recording on ANY path (the meter reads the
  // worklet on the lossless path, an AnalyserNode tap on the MediaRecorder path).
  const recording = state === 'recording';
  const meterEl = $('#record-meter'); if (meterEl) meterEl.hidden = !(recording && recHasMeter());
  const hintEl = $('#record-hint'); if (hintEl) hintEl.hidden = !recording;
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
    if (CROWD_MODE) crowdApplyCooldown();   // countdown on Send; recording stays free
    setTimeout(() => $('#record-title').focus(), 0);
  } else if (state === 'saving') {
    status.textContent = t('record.converting', { pct: extra.pct ?? 0 });
  }
}

// Save stays disabled until the user names the text (crowd: no title, always ready).
function syncRecordSaveEnabled() {
  $('#record-save').disabled = CROWD_MODE ? crowdCooldownLeft() > 0 : !$('#record-title').value.trim();
}

function discardRecording() {
  stopMeter();
  if (rec) {
    try { if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop(); } catch { /* noop */ }
    try { rec.pcmRec?.cancel(); } catch { /* noop */ } // lossless path owns its own stream/ctx
    try { rec.meterCtx && rec.meterCtx.close(); } catch { /* noop */ } // MediaRecorder-path meter tap
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
  applyUpdateIfSafe();   // back on a safe screen → apply a pending update (esp. record mode, which has no texts list)
}

async function startRecording() {
  const fmt = recordFormatPref();
  const f = REC_FORMATS[fmt];
  try {
    // MediaRecorder-native formats (WebM/Opus, WebM/PCM, MP3) capture through
    // MediaRecorder. webm;codecs=pcm is Chromium-only → if unsupported, a lossless
    // pick degrades to a lossless WAV via the worklet (same fidelity, no warning);
    // a lossy pick with no MediaRecorder at all falls back to MP3.
    if (f.capture === 'media') {
      if (recFormatSupported(fmt)) { await startMediaRecorder(fmt, false); return; }
      if (f.lossless && losslessSupported()) { await startPcm('wav32', false); return; }
      await startMediaRecorder('mp3', f.lossless);
      return;
    }
    // Lossless PCM formats (WAV/FLAC): AudioWorklet path, with MediaRecorder→MP3 fallback.
    if (losslessSupported()) {
      try { await startPcm(fmt, false); return; }
      catch (lossErr) {
        // Browser can't do raw PCM capture (or the user denied the mic on the first
        // attempt) — fall back to MediaRecorder and flag the downgrade.
        console.warn('Lossless capture unavailable; recording compressed MP3 instead.', lossErr);
        if (lossErr && lossErr.name === 'NotAllowedError') throw lossErr; // mic denied: real error, don't double-prompt
        await startMediaRecorder('mp3', true);
        return;
      }
    }
    await startMediaRecorder('mp3', true); // no AudioWorklet at all on this browser
  } catch (e) {
    recordUI('idle');
    $('#record-status').textContent = t('record.micError', { msg: e.message });
    // Embedded crowd page: a host that stripped allow="microphone" fails exactly like
    // a user "Block" — always offer the direct-link escape hatch when framed.
    if (CROWD_MODE && window !== window.top) crowdShowFrameEscape();
  }
}

// AudioWorklet lossless capture (WAV/FLAC). Throws if getUserMedia / the worklet
// fails so startRecording can fall back. fellBack=true flags a downgrade at review.
async function startPcm(fmt, fellBack) {
  const pcmRec = new PCMRecorder();
  try {
    await pcmRec.start({ audio: dspConstraints() }); // getUserMedia + AudioWorklet
  } catch (e) {
    try { pcmRec.cancel(); } catch { /* noop */ } // release any half-open mic stream
    throw e;
  }
  rec = { mode: 'pcm', pcmRec, fmt, fellBack: !!fellBack, recording: true,
          t0: Date.now(), timer: null, blob: null, url: null };
  startRecTimer();
  recordUI('recording');
  startMeter();
}

// MediaRecorder capture path: WebM/Opus + WebM/PCM (kept as-is at save) and MP3
// (the explicit mp3 format, transcoded at save), plus the fallback when lossless
// can't run. `fellBack` true → warn at review time.
async function startMediaRecorder(fmt, fellBack) {
  const f = REC_FORMATS[normRecFormat(fmt)];
  // Raw signal for faithful capture: auto-gain makes a loud recording fade out
  // over its length; echo-cancellation + noise-suppression also color the audio.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: dspConstraints() });
  // Prefer the format's own codec; fall back to a generic supported container.
  const want = f.mediaMime || 'audio/webm';
  const mime = MediaRecorder.isTypeSupported(want) ? want
    : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
    : MediaRecorder.isTypeSupported('audio/ogg') ? 'audio/ogg' : '';
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  rec = { mode: 'mr', stream, recorder, chunks: [], fmt: normRecFormat(fmt), fellBack: !!fellBack,
          recording: true, t0: Date.now(), timer: null, blob: null, url: null,
          meterCtx: null, meterAnalyser: null, meterBuf: null };
  // Tap the same mic stream with an AnalyserNode so the level/clip meter works on
  // this path too (MediaRecorder exposes no level data). Not connected to output.
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const mctx = new AC();
      if (mctx.state === 'suspended') { try { await mctx.resume(); } catch { /* noop */ } }
      const an = mctx.createAnalyser();
      an.fftSize = 1024;
      mctx.createMediaStreamSource(stream).connect(an);
      rec.meterCtx = mctx; rec.meterAnalyser = an; rec.meterBuf = new Float32Array(an.fftSize);
    }
  } catch { /* no meter on this browser; recording still works */ }
  recorder.addEventListener('dataavailable', (e) => { if (e.data.size) rec?.chunks.push(e.data); });
  recorder.addEventListener('stop', () => {
    if (!rec) return; // cancelled
    rec.stream.getTracks().forEach(tr => tr.stop());
    stopMeter();
    try { rec.meterCtx && rec.meterCtx.close(); } catch { /* noop */ }
    rec.meterCtx = rec.meterAnalyser = rec.meterBuf = null;
    clearInterval(rec.timer);
    rec.recording = false;
    rec.blob = new Blob(rec.chunks, { type: recorder.mimeType || mime || 'audio/webm' });
    rec.url = URL.createObjectURL(rec.blob);
    $('#record-preview').src = rec.url;
    recordUI('review');
  });
  recorder.start(3000); // 3s timeslices: flush chunks incrementally so long takes don't pin RAM
  startRecTimer();
  recordUI('recording');
  startMeter();
}

function startRecTimer() {
  const fmtT = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s) % 60).padStart(2, '0');
  rec.timer = setInterval(() => {
    const secs = (Date.now() - rec.t0) / 1000;
    // Auto-STOP (to review — never discard) at the max length: crowd recorders use
    // their public config; a managed device uses the researcher-set maxRecordSeconds
    // (0/absent = no limit).
    const capSecs = CROWD_MODE ? ((CROWD_CFG && CROWD_CFG.maxSeconds) || 0) : (parseInt(settings.maxRecordSeconds, 10) || 0);
    if (capSecs > 0 && rec?.recording && secs >= capSecs) {
      stopRecording().catch(() => {});
      return;
    }
    recordUI('recording', { time: fmtT(secs) });
  }, 250);
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
  stopMeter();
  try {
    const { channels, sampleRate } = await rec.pcmRec.stop();
    if (!channels.length || !channels[0].length) throw new Error('empty');
    rec.channels = channels;
    rec.sampleRate = sampleRate;
    rec.blob = encodeWav(reduceChannels(channels), sampleRate, 32); // preview reflects what we'll save (mono/stereo)
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
  if (!rec || (!rec.blob && !rec.channels)) return;
  let title = $('#record-title').value.trim();
  if (CROWD_MODE) title = title || 'recording';   // anonymous visitor: server names the file
  else if (!title) { syncRecordSaveEnabled(); $('#record-title').focus(); return; } // title required
  recordUI('saving', { pct: 0 });
  savingRecording = true;   // block any auto-update reload until the take is safely written to IndexedDB
  try {
    const stamp = fileStamp();
    let file;
    if (rec.mode === 'pcm') {
      // Decide mono-vs-stereo (drop a dead channel; keep real stereo) — never
      // averaging a live channel with an empty one. Then optional normalize.
      const chans = reduceChannels(rec.channels);
      if (settings.norm) normalizePeak(chans);
      const { blob, ext, mime } = await encodeRecording(chans, rec.sampleRate, rec.fmt,
        (f) => recordUI('saving', { pct: Math.round(f * 100) }));
      file = new File([blob], `recording-${stamp}.${ext}`, { type: mime });
    } else if (REC_FORMATS[rec.fmt] && REC_FORMATS[rec.fmt].save === 'direct') {
      // WebM/Opus or WebM/PCM: keep the captured blob as-is, no transcode. (Auto-
      // normalize can't apply without a decode + re-encode, which defeats the point.)
      const f = REC_FORMATS[rec.fmt];
      file = new File([rec.blob], `recording-${stamp}.${f.ext}`, { type: rec.blob.type || f.mime });
    } else {
      // MediaRecorder take → compressed MP3 (explicit mp3 format, or fallback).
      const conv = settings.convert || {};
      const res = await convertToMp3(rec.blob,
        { kbps: conv.kbps || 64, sampleRate: conv.rate || 22050, mono: conv.mono !== false, normalize: !!settings.norm },
        (f) => recordUI('saving', { pct: Math.round(f * 100) }));
      file = new File([res.blob], `recording-${stamp}.mp3`, { type: 'audio/mpeg' });
    }
    const assent = pendingAssent;     // closeRecordModal clears these; preserve
    const receipt = pendingReceipt;   // them for the new doc
    const promptAudio = pendingPromptAudio;
    closeRecordModal();
    if (CROWD_MODE) {
      // Crowd divert: nothing enters the shared corpus. Bundle + persist to the
      // crowd-only pending store, then submit; the finally below still runs.
      await crowdQueueAndSubmit(file, { assent, receipt, promptAudio });
      return;
    }
    pendingAssent = assent;
    pendingReceipt = receipt;
    pendingPromptAudio = promptAudio;
    await newDocFromAudio(file, title);
  } catch (e) {
    recordUI('review');
    $('#record-status').textContent = t('convert.failed', { msg: e.message });
  } finally {
    savingRecording = false;
    applyUpdateIfSafe();   // take written (or failed) → now safe to apply a deferred update
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

async function openUrlTask(task, mode = 'interactive') {
  const interactive = mode !== 'background';
  // Background commands (a remote 'assign') take the never-clobber allowlist ONLY
  // (plan §A.3): no cleanup, no replace, no UI — just {id, url, title}.
  if (!interactive) task = { title: task.title, audioUrl: task.audioUrl, flextextUrl: task.flextextUrl, audioId: task.audioId, flextextId: task.flextextId };

  // Deliberate cleanup first (e.g. clearing old versions in a back-and-forth check).
  if (interactive && task.cleanup) {
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
    // Already here → open it (interactive) or quietly no-op (background); NEVER re-fetch.
    if (interactive) { current = existing; enterEditor('baseline'); toast(t('task.alreadyHere'), 4000); }
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
  const rec = { id: newGuid(), title: task.title || doc.title || '', created: Date.now(), modified: Date.now(), doc };
  rec.doc.title = rec.title;
  if (task.flextextUrl) {
    rec.flextextId = flextextId;
    if (gotFlextext) rec.flextextSource = task.flextextUrl;
    else rec.pendingFlextext = task.flextextUrl;
  }
  if (task.audioUrl) {
    rec.audioId = audioId;
    rec.pendingAudio = task.audioUrl;
    rec.audioLocked = true;
  }
  Object.assign(rec, docStats(rec.doc));
  await db.putDoc(rec);
  // Background ('assign') must NOT hijack the user's open editor — only adopt
  // `current` + open the editor in interactive mode. Downloads run either way.
  if (interactive) { current = rec; enterEditor('baseline'); toast(t('task.received'), 5000); }
  // Background (remote 'assign'): show the new task in the visible list right away —
  // the field worker has no refresh button, so a pushed assignment must appear on its
  // own. (Audio downloads after this; the doc is listed immediately, pending state and all.)
  else if (RECORD_MODE) renderRecordList(); else renderDocList();
  if (task.flextextUrl && !gotFlextext) {
    if (interactive) toast(t('task.ftReceiving'), 6000);
    tryDownloadFlextext(rec);
  }
  if (task.audioUrl) {
    const ok = await tryDownloadAudio(rec);
    // Success and pause/error UI are painted by the download state handler;
    // only announce a failure the user didn't cause themselves.
    if (interactive && !ok && getDownload(rec.id)?.status !== 'paused') {
      toast(t('player.downloadFailed'), 6000);
    }
  }
  if (!interactive) Sync.reportNow(); // a background-created text changes the inventory
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

// Apply the researcher-controlled Texts-screen button visibility (link btns=… /
// pushed toolbarButtons). Reusable so a pushed changeSettings re-applies it live.
function applyAllowedButtons() {
  const shown = allowedButtons();
  const set = (sel, key) => { const el = $(sel); if (el) el.hidden = !shown.has(key); };
  set('#btn-new', 'new');
  set('#btn-new-audio', 'audio');
  set('#btn-record', 'record');
  set('#btn-import', 'open');
}

// Whether a text/recording should be deleted from THIS device once it has
// uploaded to Drive. Researcher-controlled via the link (autoDel=on|off →
// settings.autoDelUploaded). When the link said nothing, default per app: the
// Flextext Recorder clears sent recordings (gather-and-send, frees phone storage),
// the editor keeps texts (a transcriber may edit them over several sessions).
// Researcher-controlled: may the coworker delete texts on this device? A STANDALONE
// (unlinked) device always can — it's the user's own app. A researcher-managed device
// gets it only when the researcher enables allowDelete: OFF by default, so a barely-
// literate coworker can't lose a text by accident. (Mirrors deleteAllOn().)
function allowDeleteOn() { return !Sync.hasSession() || settings.allowDelete === true; }
// Researcher-controlled: show the coworker a "Done" button on texts (off by default).
function doneFeatureOn() { return settings.doneEnabled === true; }

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

// ---- Connectivity sync (Phase 1) — all inert unless an invite has been claimed ----

// Remote-delete (a sync 'delete' command). Delete-safety as a MECHANISM (plan §A):
// refuse unless the doc is provably, currently on Drive — uploadedFileId present AND
// content unchanged since that backup (uploadedModified === modified). NEVER deletes
// un-uploaded or edited-since work, whatever the researcher sent. Returns true if deleted.
async function deleteConfirmedDoc(docId) {
  const d = await db.getDoc(docId);
  if (!d) return false;
  if (!d.uploadedFileId || d.uploadedModified !== d.modified) {
    console.warn('sync: refusing remote delete — not safely on Drive (un-uploaded or edited since backup):', docId);
    return false;
  }
  await deleteUploadedDoc(docId); // reuse the existing teardown (open-doc + both app modes)
  Sync.reportNow();
  return true;
}

// ---- upload-then-delete intents (the 'uploadDelete' command) ----
// Persisted so a reload between "upload finished" and "delete applied" can't
// orphan the intent. Never deletes by itself: consumption always goes through
// deleteConfirmedDoc's proof-of-backup check.
const PENDING_UPDEL_KEY = 'flextext-pending-upload-delete';
function pendingUpDel() {
  try { return JSON.parse(localStorage.getItem(PENDING_UPDEL_KEY)) || []; } catch { return []; }
}
function setPendingUpDel(ids) {
  try { ids.length ? localStorage.setItem(PENDING_UPDEL_KEY, JSON.stringify(ids)) : localStorage.removeItem(PENDING_UPDEL_KEY); }
  catch { /* private mode: the intent just won't survive a reload */ }
}
// Finish intents whose upload landed before a restart (or whose doc vanished).
async function sweepPendingUpDel() {
  const ids = pendingUpDel();
  if (!ids.length) return;
  const keep = [];
  for (const docId of ids) {
    const d = await db.getDoc(docId).catch(() => null);
    if (!d) continue;                                             // gone — intent done
    if (d.uploadedFileId && d.uploadedModified === d.modified) { await deleteConfirmedDoc(docId); continue; }
    keep.push(docId);                                             // upload still pending — the queue retries it
  }
  setPendingUpDel(keep);
}

// ---- auto-backup (device setting autoBackup + autoBackupMins) ----
// Researcher-enabled safety net: any text changed since its last upload is re-sent
// automatically once it has been QUIET for autoBackupMins (default 15) — each send
// is a fresh timestamped Drive copy, so the quiet timer (not the sweep cadence) is
// what stops a copy per keystroke. Content-signature gated like manual uploads, so
// timestamp-only churn never duplicates. Backs off 30 min per doc after a failure.
const autoBackupTried = new Map();   // docId -> { sig, at }
async function autoBackupSweep() {
  if (RESEARCHER_MODE || CROWD_MODE) return;
  if (settings.autoBackup !== true || !Sync.workerUploadTarget() || !navigator.onLine) return;
  const quietMs = Math.max(1, parseInt(settings.autoBackupMins, 10) || 15) * 60000;
  const nowT = Date.now();
  const metas = await db.listDocs().catch(() => []);
  for (const meta of metas) {
    if (uploadView.has(meta.id) || getUpload(meta.id)) continue;   // queued or in flight
    const d = await db.getDoc(meta.id).catch(() => null);
    if (!d || !d.modified) continue;
    if (nowT - d.modified < quietMs) continue;                     // still being worked on
    if (d.uploadedModified === d.modified) continue;               // this exact state is on Drive
    const sig = uploadContentSig(d);
    if (d.uploadedSig && d.uploadedSig === sig) continue;          // content unchanged since last send
    const tried = autoBackupTried.get(d.id);
    if (tried && tried.sig === sig && nowT - tried.at < 30 * 60000) continue;
    autoBackupTried.set(d.id, { sig, at: nowT });
    await uploadDocById(d.id);                                     // one-at-a-time pump takes it from here
  }
}

// Short, stable title hash for the report — no plaintext titles leave the device (plan §F.2).
async function syncTitleHash(title) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(title || '')));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// A managed device exposes (reports + allows remote upload/management of) its FULL corpus to the
// researcher it is enrolled with — pre-existing texts (created before this enrollment) INCLUDED.
// Enrollment is already gated by the researcher allowlist (A) and an explicit on-device "Connect to
// <researcher>?" consent (B); once the field user has accepted, hiding their existing texts only blocks
// legitimate management. (Drops the earlier created>=enrolledAt data-scoping — "layer C" — per Seth
// 2026-06-30: A+B are the protection against a phished/coerced enrollment now. The created/sharedInstall
// fields are still recorded but no longer gate visibility.)
function docInScope(/* d, enr */) {
  return true;
}

// Re-render the settings-dependent UI in place (no reload) — used by a pushed changeSettings AND by
// the local cross-window live-sync, so a setting change appears immediately in every open window.
function applyLiveSettings() {
  if (RESEARCHER_MODE) return;   // the researcher panel manages its own views
  settings = loadSettings();
  if (RECORD_MODE) { renderRecordView(); renderRecordList(); }   // recorder paints its own Delete-All (gated) in renderRecordView
  else { applyResearchVisibility(); applyAllowedButtons(); fillWsForm(); renderDocList(); applyDeleteAllButton(); applyInviteButton(); applyDoneButton(); }
}

// "Delete All" (full local wipe = clears storage + IndexedDB + caches + the service worker, then reloads
// to a blank slate — also the self-service un-brick for a stale SW). Available on STANDALONE (unlinked)
// apps by default; on a MANAGED device only if the researcher enabled it for that device (settings
// .deleteAllEnabled). Off by default for managed devices.
function deleteAllAllowed() {
  return !Sync.hasSession() || loadSettings().deleteAllEnabled === true;
}
async function runDeleteAll() {
  if (!confirm(t('delall.confirm'))) return;
  await eraseAllData();
}
// Editor: the Delete-All button lives at the bottom of the Help view (reachable in both standalone +
// managed, behind the "?" — not fat-fingerable). Created once, toggled by the gate. (The recorder paints
// its own copy inside renderRecordView, since that view is rebuilt each render.)
function applyDeleteAllButton() {
  const view = $('#view-help'); if (!view) return;
  let btn = $('#btn-delete-all');
  if (deleteAllAllowed()) {
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'btn-delete-all'; btn.type = 'button'; btn.className = 'secondary-btn delall-btn';
      btn.addEventListener('click', runDeleteAll);
      view.appendChild(btn);
    }
    btn.textContent = t('delall.btn'); btn.hidden = false;
  } else if (btn) { btn.hidden = true; }
}
// Setting D: a researcher pushed an app (interface) language for this device. Apply it LIVE — no reload —
// and keep the local language toggle in sync. SET-WITH-OVERRIDE: this is called only when a push ARRIVES
// (not on every re-render), so a field worker who later prefers the other language is never fought.
function applyDeviceLang(lang) {
  if (!LANGS.includes(lang) || lang === getLang()) return false;
  setLang(lang);                                  // persists to LANG_KEY → survives reload
  applyI18n();                                    // repaint all static [data-i18n] markup
  const ls = $('#lang-select'); if (ls) ls.value = lang;  // keep the local toggle from showing a stale value
  return true;
}
// Re-render just the document list (a doc was added/changed/removed in another window).
function refreshLiveLists() {
  if (RESEARCHER_MODE) return;
  if (RECORD_MODE) renderRecordList(); else renderDocList();
}

// The researcher revoked this device — the sync engine auto-released the binding (poll saw 410). Scrub
// the researcher's Google Drive links from local settings (item C: never keep a Drive folder we can no
// longer use), re-render (the device is standalone again → the Settings tab returns), and tell the user.
function onSyncRevoked() {
  const s = loadSettings();
  for (const k of ['uploadFolder', 'uploadUrl', 'consentAudio', 'consentAudioUrl']) delete s[k];
  saveSettings(s);
  settings = loadSettings();
  applyLiveSettings();
  toast(t('sync.revoked'), 8000);
}

// Apply ONE researcher command through the existing idempotent, never-clobber handlers.
async function syncDispatch(cmd) {
  switch (cmd && cmd.type) {
    case 'assign': {
      const task = { title: cmd.title || '' };
      if (cmd.audioUrl) { task.audioUrl = resolveAudioInput(cmd.audioUrl); task.audioId = cmd.id; }
      if (cmd.flextextUrl) { task.flextextUrl = resolveAudioInput(cmd.flextextUrl); task.flextextId = cmd.id; }
      if (task.audioUrl || task.flextextUrl) await openUrlTask(task, 'background');
      break;
    }
    case 'delete':
      await deleteConfirmedDoc(cmd.docId || cmd.id);
      break;
    case 'changeSettings': {
      // MERGE only the researcher-supplied keys; never a whole-object overwrite that
      // would wipe a power-user's relayWorker / uploadFolder (plan §F.1).
      const s = loadSettings();
      Object.assign(s, cmd.settings || {});
      saveSettings(s);
      // A pushed app-language (setting D) takes effect live — set it BEFORE the re-render so the menus
      // repaint in the new language right away (only on the actual push; the local toggle still works after).
      if (cmd.settings && cmd.settings.appLang) applyDeviceLang(cmd.settings.appLang);
      // Reflect pushed changes immediately so the field worker (no refresh button) sees them without
      // reopening — and tell them their researcher made the change. applyLiveSettings reloads + re-renders
      // (editor: visibility/buttons/form/list; recorder: welcome heading + buttons + list).
      applyLiveSettings();
      toast(t('sync.settingsUpdated'), 5000);
      break;
    }
    case 'uploadDelete': {
      // Per-text remote removal, upload-FIRST: back the text up to Drive, and only
      // delete once the upload is CONFIRMED (the delete rides the upload-done hook,
      // gated by deleteConfirmedDoc's proof-of-backup check — a failed upload means
      // the text simply stays). The intent survives reloads in localStorage; the
      // boot/online sweep finishes a delete whose upload landed before a restart.
      const docId = cmd.docId || cmd.id;
      if (!docId) break;
      const d = await db.getDoc(docId).catch(() => null);
      if (!d) break;                                              // already gone — nothing to do
      if (d.uploadedFileId && d.uploadedModified === d.modified) { await deleteConfirmedDoc(docId); break; }
      const ids = pendingUpDel();
      if (!ids.includes(docId)) { ids.push(docId); setPendingUpDel(ids); }
      // Already queued or mid-flight? The intent above is enough — the upload-done
      // hook consumes it. Re-queueing would reset the entry and double-start.
      if (uploadView.has(docId) || getUpload(docId)) break;
      if (current && current.id === docId) await doUpload(true);
      else await uploadDocById(docId);
      break;
    }
    case 'triggerUpload': {
      const docId = cmd.docId || cmd.id;
      if (!docId) break;
      // Data-scoping: never remote-upload a doc this enrollment isn't entitled to
      // (pre-existing / unshared). Defense-in-depth — such docs aren't reported either, so a
      // researcher shouldn't even know their ids.
      const tgt = (current && current.id === docId) ? current : await db.getDoc(docId).catch(() => null);
      if (tgt && !docInScope(tgt, Sync.enrollment())) { console.warn('sync: refusing triggerUpload of out-of-scope doc', docId); break; }
      // Remote-triggered upload — works whether or not the doc is open, so the researcher
      // can pull a text in without the coworker pressing Upload. Reports back on completion.
      if (current && current.id === docId) await doUpload(true);   // researcher-initiated: do NOT mark as user-shared
      else await uploadDocById(docId);
      break;
    }
    default:
      console.warn('sync: unknown command', cmd && cmd.type);
  }
}

// Which PWA shells are cached on THIS browser profile + their version, parsed from the SW cache names
// (flextext-vNN = editor, text-recorder-vNN, flextext-researcher-vNN). Lets the researcher panel show
// whether a managed device is up to date + which apps it has. Null on dev (SW skipped). CacheStorage is
// shared across the three same-origin PWAs, so every installed one shows.
async function listCachedApps() {
  try {
    if (typeof caches === 'undefined') return null;
    const out = {};
    for (const k of await caches.keys()) {
      let m;
      if ((m = k.match(/^flextext-researcher-(.+)$/))) out.researcher = m[1];
      else if ((m = k.match(/^text-recorder-(.+)$/))) out.recorder = m[1];
      else if ((m = k.match(/^flextext-(.+)$/))) out.editor = m[1];
    }
    return out;
  } catch { return null; }
}

// Subtle always-on version badge in the bottom-right corner (all three modes). Shows THIS app's OWN
// version: the editor's is the engine version (same thing); the recorder/researcher show their own
// shell version (from their cache name) since they ship on their own cadence. Informational only —
// pointer-events:none so it never intercepts a tap.
async function showAppVersion() {
  const name = RESEARCHER_MODE ? 'researcher' : (RECORD_MODE ? 'recorder' : 'editor');
  let ver = ENGINE_VERSION;                                   // editor: shell == engine version
  if (RECORD_MODE || RESEARCHER_MODE) {
    const apps = await listCachedApps().catch(() => null);
    ver = (apps && (RECORD_MODE ? apps.recorder : apps.researcher)) || '';   // own shell version (cache name)
  }
  let el = document.getElementById('app-version');
  if (!el) { el = document.createElement('div'); el.id = 'app-version'; el.className = 'app-version'; (document.body || document.documentElement).appendChild(el); }
  el.textContent = ver ? name + ' ' + ver : name;
}

// Inventory for the report. The whole blob is E2EE-encrypted before it leaves the device
// (sync.js), so the actual title + a researcher-relevant settings snapshot ride along: only
// the Ki holder (the researcher) can read them — the Worker/D1 see ciphertext. titleHash is
// kept too (legacy / change-gate). No audio bytes; stable fields so an unchanged list never writes.
async function syncGatherInventory() {
  const metas = await db.listDocs();
  const enr = Sync.enrollment();
  const items = [];
  for (const meta of metas) {
    const d = await db.getDoc(meta.id);
    if (!d) continue;
    if (!docInScope(d, enr)) continue;   // pre-existing / unshared → never reported to this researcher
    const backed = !!d.uploadedFileId;
    items.push({
      id: d.id,
      title: d.title || '',
      titleHash: await syncTitleHash(d.title),
      hasAudio: !!(d.audioSource || d.pendingAudio || d.audioId),
      modified: d.modified,
      done: !!d.done,
      uploadState: backed ? (d.uploadedModified === d.modified ? 'uploaded' : 'changed') : 'local',
      uploadedFileId: d.uploadedFileId || null,
    });
  }
  // The settings the researcher panel can view/prefill for this device (encrypted in transit).
  const snap = {};
  for (const k of ['vernLang', 'vernName', 'vernFont', 'analLang', 'analName', 'analFont',
                   'recordFormat', 'agc', 'nr', 'echo', 'norm',
                   'consentAsk', 'consentConfirm', 'consentMode', 'consentMsg', 'consentResp', 'consentAudioUrl',
                   'appLang', 'uploadFolder', 'toolbarButtons', 'sendOptions', 'autoDelUploaded', 'recordWelcome', 'deleteAllEnabled',
                   'autoBackup', 'autoBackupMins', 'maxRecordSeconds', 'allowDelete', 'doneEnabled']) {
    if (settings[k] !== undefined) snap[k] = settings[k];
  }
  // ua + cachedApps let the panel show which browser/device this install is + whether its apps are
  // current (so the researcher can tell if a coworker hasn't updated). Both are E2EE in the report.
  // engineVersion is the TRUE running engine version (vs cachedApps, which reads cache NAMES that a
  // stale-body precache can make lie) — the reliable brick/stale signal. All E2EE in the report.
  return { type: RECORD_MODE ? 'recorder' : 'editor', items, settings: snap,
           ua: navigator.userAgent, cachedApps: await listCachedApps(), engineVersion: ENGINE_VERSION };
}

// One-time invite link (?invite=<id>#k=<secret>) → bind this install to the
// researcher's instance for async remote management. Quiet background bind; the
// secret rides the URL fragment (out of server logs) and is stripped immediately.
// Claim an invite (from the URL or a pasted link) and drive the shared outcome
// handling. interactive=true (the paste flow) surfaces every failure in plain
// language; the URL path stays quiet on unknowns (never block startup).
async function claimInvite(inviteId, secret, interactive) {
  try {
    const r = await Sync.claim(inviteId, secret);
    if (r.ok) {
      if (r.accepted) toast(t('invite.alreadyLinked'), 5000);   // reused (the other app's link): already set up
      else showInviteConsent(r.researcher);                      // B: user must see who is connecting + accept
      return true;
    }
    if (r.error === 'already_linked') { toast(t('invite.linkedElsewhere'), 9000); return true; }
    if (r.error === 'type_mismatch') { toast(t('toast.linkMismatch'), 6000); return true; }
    if (interactive) {
      if (r.error === 'expired') toast(t('invite.expired'), 8000);
      else if (r.error === 'already_claimed') toast(t('invite.claimed'), 8000);
      else toast(t('invite.pasteBad'), 8000);
    }
    return false;
  } catch {
    if (interactive) toast(t('invite.pasteOffline'), 7000);
    return false;
  }
}

function handleInviteParam() {
  try {
    const p = new URLSearchParams(location.search);
    const inviteId = p.get('invite');
    if (!inviteId) return;
    const frag = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    const secret = frag.get('k') || p.get('k') || '';
    p.delete('invite'); p.delete('k');
    const qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '')); // strip secret from URL/history
    if (!secret) return;
    claimInvite(inviteId, secret, false);
  } catch { /* never block startup */ }
}

// Pull the invite id + secret out of whatever was pasted: the full link, a bare
// "invite=…#k=…" tail, or a whole WhatsApp message containing the link. The
// kiosk path (no URL bar, no link opening) depends on this being forgiving.
function parseInviteInput(text) {
  const s = String(text || '');
  const id = (s.match(/[?&]invite=([0-9a-fA-F-]{8,})/) || [])[1] || null;
  const secret = (s.match(/[#?&]k=([A-Za-z0-9_~.-]{8,})/) || [])[1] || null;
  return { id, secret };
}

// Locked kiosks can't receive/open a URL, so an unenrolled device offers a
// paste box instead: paste the invite link → same claim + consent flow.
function showInvitePasteModal() {
  if (document.querySelector('[data-invite-paste]')) return;   // never stack
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.dataset.invitePaste = '1';
  wrap.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true">
    <h3>${esc(t('invite.pasteTitle'))}</h3>
    <p class="note">${esc(t('invite.pasteIntro'))}</p>
    <textarea id="invite-paste-box" class="invite-paste-box" rows="3" spellcheck="false" placeholder="https://…?invite=…#k=…"></textarea>
    <p class="note" id="invite-paste-status" hidden></p>
    <button class="primary-btn" data-iv="go">${esc(t('invite.pasteGo'))}</button>
    <button class="link-btn" data-iv="cancel">${esc(t('share.cancel'))}</button>
  </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  const status = wrap.querySelector('#invite-paste-status');
  wrap.querySelector('[data-iv="cancel"]').addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('[data-iv="go"]').addEventListener('click', async (e) => {
    const { id, secret } = parseInviteInput(wrap.querySelector('#invite-paste-box').value);
    if (!id || !secret) {
      status.hidden = false;
      status.textContent = t('invite.pasteBad');
      return;
    }
    e.target.disabled = true;
    status.hidden = false;
    status.textContent = t('invite.pasteWorking');
    const handled = await claimInvite(id, secret, true);
    if (handled) { close(); applyInviteButton(); if (RECORD_MODE) renderRecordView(); }
    else { e.target.disabled = false; status.hidden = true; }
  });
  setTimeout(() => wrap.querySelector('#invite-paste-box').focus(), 0);
}

// The editor's entry point for the paste flow: a link at the bottom of the Help
// view (admin territory, reachable via "?"), shown only while UNenrolled — the
// recorder paints its own copy inside renderRecordView.
function applyInviteButton() {
  const view = $('#view-help'); if (!view) return;
  let btn = $('#btn-paste-invite');
  if (!Sync.hasSession()) {
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'btn-paste-invite'; btn.type = 'button'; btn.className = 'secondary-btn delall-btn';
      btn.addEventListener('click', showInvitePasteModal);
      view.appendChild(btn);
    }
    btn.textContent = t('invite.pasteBtn'); btn.hidden = false;
  } else if (btn) { btn.hidden = true; }
}

// B (enrollment consent): show WHO is enrolling this device (Google name + avatar) and require the
// field user to Accept before anything flows — the worker won't deliver the data key until they do,
// so a phished/hijacked invite is inert without a deliberate human OK. Re-shown on reload until decided.
function showInviteConsent(researcher) {
  if (document.querySelector('[data-invite-consent]')) return;   // never stack
  const r = researcher || {};
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.dataset.inviteConsent = '1';
  const av = r.avatar
    ? `<img class="invite-avatar" src="${esc(r.avatar)}" alt="" referrerpolicy="no-referrer" width="56" height="56">` : '';
  wrap.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true">
    <h3>${esc(t('invite.title'))}</h3>
    <div class="invite-who">${av}<div><div class="invite-name">${esc(r.name || t('invite.unknownName'))}</div>${r.email ? `<div class="note">${esc(r.email)}</div>` : ''}</div></div>
    <p class="banner warn-banner">${esc(t('invite.warn'))}</p>
    <button class="primary-btn" data-iv="accept">${esc(t('invite.accept'))}</button>
    <button class="link-btn" data-iv="decline">${esc(t('invite.decline'))}</button>
  </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('[data-iv="accept"]').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const res = await Sync.accept();
    close();
    if (res.ok) {
      const fp = await Sync.deviceFingerprint().catch(() => null);   // device code for the out-of-band check
      toast(fp ? t('toast.linkedFp', { fp }) : t('toast.linked'), 12000);
    } else toast(t('invite.acceptFailed'), 6000);
    if (RECORD_MODE) renderRecordList(); else renderDocList();
  });
  wrap.querySelector('[data-iv="decline"]').addEventListener('click', () => {
    Sync.clearSession();                                   // abandon the binding entirely
    close();
    toast(t('invite.declined'), 6000);
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
    const base = workerBase().replace(/\/+$/, '');
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
  // Same multi-WS selection as importFile: edit this device's WS lines only.
  const { texts, error } = parseFlextext(xml, { vernLang: settings.vernLang, analLang: settings.analLang });
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
    (allow.has('upload') && !!Sync.workerUploadTarget());
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
// Bundle for the OPEN doc: sync the editor DOM into `current` first, then delegate.
async function buildBundle(withTimestamp) {
  if (activeTab === 'baseline' && $('#baseline-text')) applyBaseline();
  if (current && $('#doc-title')) current.title = ($('#doc-title').value.trim()) || current.title || 'Untitled';
  return buildBundleFor(current, withTimestamp);
}

// DOM-free bundle builder for ANY doc record — lets a remote-triggered upload bundle a
// doc that isn't open. Pure: reads only the passed record + IndexedDB media.
async function buildBundleFor(rec, withTimestamp) {
  const xmlBlob = serializeDocBlob(rec);
  const name = docFilename(rec);                  // Title.flextext
  const base = name.replace(/\.flextext$/, '');
  const media = await db.getMedia(rec.id).catch(() => null);
  const userAudio = !!(media && !isAudioLocked(rec));
  const consent = rec.consentClip
    ? await db.getMedia('consent:' + rec.id).catch(() => null)
    : null;
  // The exact spoken prompt that was played, frozen at consent time, so the
  // question and the answer travel together for IRB verification.
  const promptAudio = rec.consentPromptClip
    ? await db.getMedia('consent-prompt:' + rec.id).catch(() => null)
    : null;
  const receipt = rec.consentReceipt || null;
  // If this receipt's best-effort IP/location capture is still in flight, give
  // it a short window so the bundled record isn't needlessly "unavailable".
  if (receipt && consentCapture && consentCapture.receipt === receipt) {
    await Promise.race([consentCapture.promise, new Promise((r) => setTimeout(r, 5000))]);
  }
  const stamp = withTimestamp ? ' ' + fileStamp() : '';
  if (userAudio || consent || promptAudio || receipt) {
    const entries = [{ name, data: xmlBlob }];
    if (userAudio) entries.push({ name: media.name || 'audio.mp3', data: media.blob });
    if (consent?.blob) entries.push({ name: consent.name || rec.consentClip, data: consent.blob });
    if (promptAudio?.blob) entries.push({ name: promptAudio.name || rec.consentPromptClip, data: promptAudio.blob });
    if (receipt) {
      const full = { ...receipt, textTitle: rec.title || '' };
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

// Serialize a doc record to a .flextext XML blob (DOM-free; mirrors exportBlob without the DOM).
function serializeDocBlob(rec) {
  const doc = rec.doc;
  doc.title = rec.title || doc.title || 'Untitled';
  return new Blob([serializeFlextext(doc, settings)], { type: 'application/xml' });
}
function docFilename(rec) {
  const base = (rec.title || 'text').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
  return base + '.flextext';
}

// Queue a doc for upload BY ID — works whether or not it is the open doc, so a researcher
// can trigger an upload remotely (triggerUpload command) without the coworker pressing Upload.
async function uploadDocById(docId) {
  const rec = (current && current.id === docId) ? current : await db.getDoc(docId).catch(() => null);
  if (!rec) return false;
  const bundle = await buildBundleFor(rec, true); // timestamped: Drive never overwrites
  await db.putMedia('upload:' + docId, {
    blob: bundle.blob, name: bundle.filename, mime: bundle.mime,
    total: bundle.blob.size, sent: 0,
    docModified: rec.modified,
    docDone: !!rec.done,   // auto-delete fires only for FINISHED texts
  });
  uploadView.set(docId, { name: bundle.filename, status: 'waiting' });
  renderUploadQueue();
  pumpUploads();
  return true;
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
  const showUpload = allow.has('upload') && !!Sync.workerUploadTarget();
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
        if (deleteAfterUpload() && st.docDone !== false) {   // auto-delete only after marked finished AND safely uploaded
          setPendingUpDel(pendingUpDel().filter((x) => x !== docId));   // auto-delete covers the intent
          deleteUploadedDoc(docId).then(() => Sync.reportNow()); // inventory shrank — tell the panel promptly
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
            d.uploadedSig = uploadContentSig(d);   // remember WHAT was uploaded → skip duplicate re-uploads
          };
          if (current && current.id === docId) stamp(current);
          // Persist the new uploadedFileId, THEN report — so the researcher panel sees the (re)upload
          // land on its very next poll instead of waiting up to a full device-poll cycle (loop-closure:
          // the panel confirms completion by detecting a CHANGED uploadedFileId in the reported inventory).
          db.getDoc(docId).then(async (d) => {
            if (d) { stamp(d); await db.putDoc(d); }
            // A researcher-requested upload-then-delete rides the SAME completion
            // point: the proof-of-backup stamp above is persisted first, so
            // deleteConfirmedDoc's delete-safety check passes only now.
            if (pendingUpDel().includes(docId)) {
              setPendingUpDel(pendingUpDel().filter((x) => x !== docId));
              if (await deleteConfirmedDoc(docId)) toast(t('sync.removedAfterUpload'), 6000);
            }
            return Sync.reportNow();
          }).catch(() => {});
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
    if (!rec || !rec.blob) { // record vanished — drop it
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

  // Chunked streaming uploads report REAL byte progress (indeterminate false);
  // the relay path stays an indeterminate sweep (no byte-level signal exists).
  const indet = !!(active && active.status === 'uploading' && active.indeterminate !== false);
  fill.classList.toggle('indeterminate', indet);
  fill.style.width = indet ? '100%'
    : (active && active.total ? Math.round(((active.sent || 0) / active.total) * 100) + '%' : '0%');

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

// Cheap, non-cryptographic content signature — used ONLY to detect whether a doc actually changed
// since its last upload, so a coworker trained (MS-Office style) to obsessively tap Save doesn't spawn
// a duplicate Drive copy on every press (each upload writes a fresh timestamped file; Drive never
// overwrites). Compares the interlinear content + audio identity + title.
function cheapHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function uploadContentSig(rec) {
  try { return cheapHash(JSON.stringify(rec.doc) + '|' + (rec.audioId || rec.audioSource || '') + '|' + (rec.title || '')); }
  catch { return 'x' + Date.now(); }   // unstringifiable → never matches → always (re)uploads (safe)
}

async function doUpload(researcher = false) {
  if (!current) return;
  try {
    // Sync the open editor into the record (applyBaseline reconciles synchronously) before bundling.
    if (activeTab === 'baseline' && $('#baseline-text')) applyBaseline();
    // Idiot-proofing: if this doc is already on Drive and its CONTENT hasn't changed since that upload,
    // don't make another copy — tell the user it's saved. Stops an obsessive Save-tapper from filling the
    // folder with dozens of identical files. (Researcher-triggered uploads bypass this — a fresh send is
    // exactly what was asked for.)
    if (!researcher && current.uploadedFileId && current.uploadedSig
        && current.uploadedSig === uploadContentSig(current)) {
      await persist();                       // still save the just-synced edit locally
      toast(t('upload.alreadyDone'), 6000);
      return;
    }
    // A USER-initiated upload = the user consenting to share THIS doc with their researcher
    // (it then reports + becomes remote-uploadable). Set it on `current` so later edits keep it.
    if (!researcher) { const enr = Sync.enrollment(); if (enr && enr.installId) current.sharedInstall = enr.installId; }
    // The Finished-Send button IS the coworker saying "done" — mark it so the
    // panel shows it and (with auto-delete on) the text may clear after upload.
    if (!researcher && !current.done) { current.done = true; current.doneAt = Date.now(); applyDoneButton(); }
    await persist();
    await uploadDocById(current.id);
    toast(t('upload.queuedToast'));
  } catch (e) {
    toast(t('upload.error', { msg: e.message }), 9000);
  }
}

function closeShareMenu() { $('#share-menu').hidden = true; applyUpdateIfSafe(); }

/* ---------------- Research tab ---------------- */

function fillWsForm() {
  const f = $('#ws-form');
  // Codes only — the name/font fields are gone (2026-07-13): names were display
  // sugar and fonts device cosmetics; neither belongs in the FLEx export. Legacy
  // stored values keep working where still read (welcome text, doc fonts).
  for (const key of ['vernLang', 'analLang']) {
    if (f.elements[key]) f.elements[key].value = settings[key] || '';
  }
  const cAsk = consentAskList();
  f.elements.askText.checked = cAsk.includes('text');
  f.elements.askAudio.checked = cAsk.includes('audio');
  f.elements.consentMsg.value = settings.consentMsg || '';
  f.elements.consentAudioUrl.value = settings.consentAudioUrl || '';
  const cConf = consentConfirmList();
  f.elements.confYesno.checked = cConf.includes('yesno');
  f.elements.confRecord.checked = cConf.includes('record');
  f.elements.confSign.checked = cConf.includes('signature');
  f.elements.autoDel.checked = !!settings.autoDelUploaded;
  updateConsentFields(f);
}

// Show the written-reminder message field when "written reminder" is checked, the audio field when
// "spoken reminder" is checked (consent is multi-select; both can be on).
function updateConsentFields(f) {
  f.querySelector('.consent-text-field').hidden = !f.elements.askText.checked;
  f.querySelector('.consent-audio-field').hidden = !f.elements.askAudio.checked;
}

// Read the whole Research form into `settings` and persist it. NO validation
// gate (unlike the Save submit, which the browser blocks when a required field
// is empty). Returns the raw upload / consent-audio inputs so callers can warn
// on bad values. Used by Save AND by the copy-link buttons — so a generated
// link always reflects the CURRENT form, not just whatever was last saved.
function applyResearchFormToSettings(f) {
  for (const key of ['vernLang', 'analLang']) {
    settings[key] = f.elements[key].value.trim();
  }
  const cAsk = [];
  if (f.elements.askText.checked) cAsk.push('text');
  if (f.elements.askAudio.checked) cAsk.push('audio');
  settings.consentAsk = cAsk;
  delete settings.consentMode;   // superseded by the consentAsk array
  settings.consentMsg = f.elements.consentMsg.value.trim();
  const cConf = [];
  if (f.elements.confYesno.checked) cConf.push('yesno');
  if (f.elements.confRecord.checked) cConf.push('record');
  if (f.elements.confSign.checked) cConf.push('signature');
  settings.consentConfirm = cConf;
  delete settings.consentResp;   // superseded by the consentConfirm array
  const rawConsentAudio = f.elements.consentAudioUrl.value.trim();
  settings.consentAudioUrl = rawConsentAudio;
  settings.consentAudio = resolveAudioInput(rawConsentAudio);
  settings.autoDelUploaded = !!f.elements.autoDel.checked;
  saveSettings(settings);
  return { rawConsentAudio };
}

function setupResearch() {
  const f = $('#ws-form');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const { rawConsentAudio } = applyResearchFormToSettings(f);
    if (rawConsentAudio && !settings.consentAudio) toast(t('task.badAudio'), 6000);
    renderWsBanner();
    syncConsentAudio();
    toast(t('toast.settingsSaved'));
  });

  ['askText', 'askAudio'].forEach((n) => $('#ws-form').elements[n].addEventListener('change', () => updateConsentFields($('#ws-form'))));

  // Lock down the coworker's interface in person: hide the Research tab on THIS
  // device. The confirm spells out the touch-friendly recovery so nobody gets
  // stranded on a phone with no keyboard.
  $('#btn-hide-research').addEventListener('click', () => {
    if (!confirm(t('research.hideHereConfirm'))) return;
    localStorage.setItem(RESEARCH_HIDDEN_KEY, '1');
    applyResearchVisibility();
    toast(t('research.disabled'));
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
  // Recording-format help modal (researcher-facing archival guidance).
  const rfHelpModal = $('#recformat-help-modal');
  if (rfHelpModal) {
    $('#recformat-help')?.addEventListener('click', () => { rfHelpModal.hidden = false; });
    $('#recformat-help-close')?.addEventListener('click', () => { rfHelpModal.hidden = true; });
    rfHelpModal.addEventListener('click', (e) => { if (e.target === rfHelpModal) rfHelpModal.hidden = true; });
  }
  // AGC mode select — 'off' (faithful) by default; travels with
  // links as its own param so the right clip-protection default follows the device.
  const agcSel = $('#agc-mode');
  if (agcSel) {
    agcSel.value = ['on', 'off', 'auto'].includes(settings.agc) ? settings.agc : 'off';
    agcSel.addEventListener('change', () => {
      settings.agc = ['on', 'off', 'auto'].includes(agcSel.value) ? agcSel.value : 'off';
      saveSettings(settings);
    });
  }
  // Optional microphone-processing toggles — all off by default, each flagged
  // not-for-archiving. Travel with links.
  [['#dsp-nr', 'nr'], ['#dsp-echo', 'echo'], ['#dsp-norm', 'norm']].forEach(([sel, key]) => {
    const cb = $(sel);
    if (!cb) return;
    cb.checked = !!settings[key];
    cb.addEventListener('change', () => { settings[key] = cb.checked; saveSettings(settings); });
  });

  // Audio converter (any recording → small task-ready MP3) — the send-to-assistant
  // distribution format, separate from the recording (capture) format above.
  const cf = $('#convert-form');
  const convPrefs = settings.convert || {};
  if (convPrefs.kbps) cf.elements.convKbps.value = String(convPrefs.kbps);
  if (convPrefs.rate) cf.elements.convRate.value = String(convPrefs.rate);
  cf.addEventListener('change', () => {
    settings.convert = {
      kbps: parseInt(cf.elements.convKbps.value, 10),
      rate: parseInt(cf.elements.convRate.value, 10),
      mono: true, // always mono — a single voice on one mic gains nothing from stereo
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
        mono: true, // always mono
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
  // Managed installs (claimed via an invite) are remote-managed ONLY: the Settings tab is
  // always hidden and cannot be revealed — settings change only through the researcher panel
  // (passphrase-gated). A non-managed device uses the normal hide toggle.
  const hidden = isResearchHidden() || Sync.hasSession();
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
  const hidden = isResearchHidden() || Sync.hasSession();
  const sec = $('#help-researchers');
  const note = $('#help-research-hidden');
  if (sec) sec.hidden = hidden;
  if (note) note.hidden = !hidden;
}

function toggleResearchHidden() {
  // On a managed install the gesture is the passphrase-gated way IN: open the researcher
  // panel instead of exposing the local Settings tab (which stays remote-managed only).
  if (Sync.hasSession()) { if (researcherPanelApi) researcherPanelApi.open(); return; }
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
      ${!Sync.hasSession() ? '<button id="btn-paste-invite" type="button" class="secondary-btn delall-btn"></button>' : ''}
      ${deleteAllAllowed() ? '<button id="btn-delete-all" type="button" class="secondary-btn delall-btn"></button>' : ''}
    </div>`;
  v.querySelector('.record-welcome').textContent = recordWelcomeText();
  v.querySelector('.record-big-label').textContent = t('record.btn');
  v.querySelector('.record-list-h').textContent = t('record.savedH');
  v.querySelector('#record-empty').textContent = t('record.empty');
  $('#btn-record-big').addEventListener('click', () => requestConsentThen(() => openRecordModal()));
  const da = v.querySelector('#btn-delete-all'); if (da) { da.textContent = t('delall.btn'); da.addEventListener('click', runDeleteAll); }
  const pi = v.querySelector('#btn-paste-invite'); if (pi) { pi.textContent = t('invite.pasteBtn'); pi.addEventListener('click', showInvitePasteModal); }
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
    if (allowDeleteOn()) { del.title = t('texts.deleteTitle'); del.innerHTML = '&#128465;'; }
    else del.remove();   // researcher disabled deleting
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

/* ---------------- Crowd mode (public crowd-source recorder) ----------------
 * A plain, always-fresh web page (no SW, no install, no sync): fetch the recorder
 * config by the ?c= id → welcome → the SAME consent gate + record modal the field
 * apps use → zip (audio + consent receipt) → POST to the worker, which relays to
 * the researcher's Drive. The zip is held in a crowd-ONLY IndexedDB database until
 * the worker CONFIRMS delivery (a stranger's recording must survive a tab close /
 * dead network), then deleted. Shared-origin discipline: never loadSettings/
 * saveSettings/setLang(save)/db.* here — a field worker may use this browser.
 */

let CROWD_ID = '';
let CROWD_CFG = null;
let crowdSessionId = '';       // per-VISIT id for the consent receipt (never the shared deviceId)
let crowdState = 'loading';
let crowdPendingCount = 0;
let crowdFlushing = false;
const crowdMemQueue = [];      // fallback when IndexedDB is unavailable (strict private mode)
const crowdAssetCache = new Map();

// -- crowd-only IndexedDB (its OWN database; the editor corpus is never touched) --
const CROWD_DB_NAME = 'flextext-crowd';
function crowdIdbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CROWD_DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('pending', { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function crowdPutPending(item) {
  try {
    const idb = await crowdIdbOpen();
    await new Promise((res, rej) => {
      const tx = idb.transaction('pending', 'readwrite');
      tx.objectStore('pending').put(item);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      // onabort too: a commit-time quota abort (near-full SHARED origin — a field
      // worker's corpus lives here) fires only 'abort'; without this the promise
      // never settles and the take would be silently lost.
      tx.onabort = () => rej(tx.error || new Error('aborted'));
    });
    idb.close();
  } catch { crowdMemQueue.push(item); }   // storage refused → memory-only (still submits)
}
async function crowdListPending() {
  let items = [];
  try {
    const idb = await crowdIdbOpen();
    items = await new Promise((res, rej) => {
      const rq = idb.transaction('pending', 'readonly').objectStore('pending').getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => rej(rq.error);
    });
    idb.close();
  } catch { /* no IDB */ }
  return items.concat(crowdMemQueue);
}
async function crowdDelPending(id) {
  const i = crowdMemQueue.findIndex((x) => x.id === id);
  if (i >= 0) crowdMemQueue.splice(i, 1);
  try {
    const idb = await crowdIdbOpen();
    await new Promise((res, rej) => {
      const tx = idb.transaction('pending', 'readwrite');
      tx.objectStore('pending').delete(id);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error('aborted'));   // a hung delete would wedge crowdFlushing forever
    });
    idb.close();
  } catch { /* nothing persisted */ }
}

// One browser shouldn't fire submissions back-to-back: 60s between NEW recordings
// (per tab, reload-surviving via sessionStorage — deliberately not the shared
// localStorage). Retries of an already-recorded pending item are NOT throttled;
// the serious anti-automation is Turnstile + per-IP limits + budgets.
const CROWD_COOLDOWN_MS = 60000;
function crowdCooldownLeft() {
  try {
    const t = parseInt(sessionStorage.getItem('fx-crowd-last-submit') || '0', 10);
    return Math.max(0, t + CROWD_COOLDOWN_MS - Date.now());
  } catch { return 0; }
}
function crowdMarkSubmitted() {
  try { sessionStorage.setItem('fx-crowd-last-submit', String(Date.now())); } catch { /* private mode */ }
}
let crowdCooldownTimer = null;
// Gate the record modal's SEND during the cooldown. Recording is deliberately
// NEVER blocked — a visitor can record the next story while waiting; only the
// sending is spaced out (the timer starts at the Send tap, see crowdQueueAndSubmit).
function crowdApplyCooldown() {
  clearInterval(crowdCooldownTimer);
  const btn = $('#record-save');
  if (!btn) return;
  const paint = () => {
    const left = crowdCooldownLeft();
    let n = document.getElementById('crowd-cooldown');
    if (left <= 0) {
      clearInterval(crowdCooldownTimer);
      if (n) n.remove();
      syncRecordSaveEnabled();
      return;
    }
    btn.disabled = true;
    if (!n) { n = document.createElement('p'); n.id = 'crowd-cooldown'; n.className = 'note'; btn.insertAdjacentElement('afterend', n); }
    n.textContent = t('crowd.cooldown', { s: Math.ceil(left / 1000) });
  };
  paint();
  if (crowdCooldownLeft() > 0) crowdCooldownTimer = setInterval(paint, 1000);
}

// Consent-prompt audio, fetched to MEMORY only (see requestConsentThen).
async function crowdFetchAsset(url) {
  if (!url) return null;
  if (crowdAssetCache.has(url)) return crowdAssetCache.get(url);
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const blob = await r.blob();
  const m = (blob.type || '').match(/mpeg|mp4|ogg|webm|wav/i);
  const rec = { blob, name: 'consent-prompt.' + (m ? { mpeg: 'mp3', mp4: 'm4a', ogg: 'ogg', webm: 'webm', wav: 'wav' }[m[0].toLowerCase()] : 'mp3'), mimeType: blob.type || 'audio/mpeg' };
  crowdAssetCache.set(url, rec);
  return rec;
}

// -- Turnstile (invisible managed widget; a challenge, if one ever shows, appears
// in the fixed host at the bottom of the page) --
let turnstileLoad = null;
function crowdTurnstileHost() {
  let el = document.getElementById('crowd-turnstile');
  if (!el) { el = document.createElement('div'); el.id = 'crowd-turnstile'; document.body.appendChild(el); }
  return el;
}
function crowdLoadTurnstile() {
  if (!turnstileLoad) {
    turnstileLoad = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => res();
      s.onerror = () => { turnstileLoad = null; rej(new Error('turnstile load failed')); };
      document.head.appendChild(s);
    });
  }
  return turnstileLoad;
}
async function crowdTurnstileToken() {
  await crowdLoadTurnstile();
  const host = crowdTurnstileHost();
  host.innerHTML = '';   // fresh widget per token: reset() would reuse a stale callback
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('turnstile timeout')), 45000);
    try {
      window.turnstile.render(host, {
        sitekey: turnstileSiteKey(),
        callback: (tok) => { clearTimeout(timer); resolve(tok); },
        'error-callback': () => { clearTimeout(timer); reject(new Error('turnstile error')); },
      });
    } catch (e) { clearTimeout(timer); reject(e); }
  });
}

// -- the crowd screen (rendered into #view-record — the crowd shell's only view) --
function crowdRelabelSend() {
  const sv = $('#record-save');
  if (sv) { sv.removeAttribute('data-i18n'); sv.textContent = t('crowd.send'); }
}
function renderCrowdView(state, extra = {}) {
  crowdState = state;
  let v = $('#view-record');
  if (!v) return;
  const welcome = (CROWD_CFG && CROWD_CFG.welcome) || t('crowd.welcomeDefault');
  const pendingBanner = crowdPendingCount
    ? `<p class="banner warn-banner">${esc(t('crowd.pendingNote', { n: crowdPendingCount }))}</p>
       <button id="crowd-retry" class="secondary-btn">${esc(t('crowd.retry'))}</button>`
    : '';
  let body = '';
  if (state === 'loading') body = `<p class="empty-note">${esc(t('crowd.loading'))}</p>`;
  else if (state === 'notfound') body = `<p class="empty-note">${esc(t('crowd.notFound'))}</p>`;
  else if (state === 'closed') body = `<p class="empty-note">${esc(t('crowd.closed'))}</p>`;
  else if (state === 'offline') body = `<p class="empty-note">${esc(t('crowd.offline'))}</p>
    <button id="crowd-reload" class="primary-btn">${esc(t('crowd.retry'))}</button>`;
  else if (state === 'busy') body = `<p class="empty-note">${esc(t('crowd.busy'))}</p>
    <button id="crowd-reload" class="primary-btn">${esc(t('crowd.retry'))}</button>`;
  else if (state === 'sending') body = `<p class="crowd-status">${esc(t('crowd.sending'))}</p>`;
  else if (state === 'thanks') body = `<div class="crowd-thanks">✓</div>
    <p class="crowd-status">${esc(t('crowd.thanks'))}</p>
    <button id="crowd-again" class="primary-btn">${esc(t('crowd.another'))}</button>`;
  else if (state === 'failed') body = `<p class="banner warn-banner">${esc(t('crowd.sendFailed'))}</p>
    ${extra.detail ? `<p class="note">${esc(extra.detail)}</p>` : ''}
    <button id="crowd-retry" class="secondary-btn">${esc(t('crowd.retry'))}</button>
    <button id="crowd-again" class="link-btn">${esc(t('crowd.another'))}</button>`;
  else /* ready */ body = `
    ${pendingBanner}
    <button id="btn-record-big" class="primary-btn record-big">
      <span class="rec-dot"></span><span class="record-big-label">${esc(t('crowd.recordBtn'))}</span></button>
    <p class="note crowd-note">${esc(t('crowd.maxNote', { min: Math.round(((CROWD_CFG && CROWD_CFG.maxSeconds) || 300) / 60) }))}</p>`;
  v.innerHTML = `<div class="record-screen crowd-screen">
    <p class="record-welcome">${esc(welcome)}</p>
    ${body}
  </div>`;
  $('#btn-record-big')?.addEventListener('click', () => requestConsentThen(() => openRecordModal()));
  $('#crowd-again')?.addEventListener('click', () => renderCrowdView('ready'));
  $('#crowd-reload')?.addEventListener('click', () => setupCrowdMode());
  $('#crowd-retry')?.addEventListener('click', () => { crowdFlush(true).catch(() => {}); });
}

// Framed without allow="microphone": getUserMedia dies instantly with NO prompt —
// indistinguishable by error name from a user "Block". Always offer the escape
// hatch: the direct (top-level) recorder link, which always works. targetSel lets
// the CONSENT modal's record-the-yes path use it too (its error paints elsewhere).
function crowdShowFrameEscape(targetSel = '#record-status') {
  const status = $(targetSel);
  if (!status) return;
  const a = document.createElement('a');
  a.href = location.origin + '/crowd-recorder/?c=' + encodeURIComponent(CROWD_ID);
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = t('crowd.openDirect');
  status.appendChild(document.createElement('br'));
  status.appendChild(a);
}

// Bundle exactly like buildBundleFor does for a field recording: audio + recorded
// assent + frozen prompt + consent-receipt.json/.txt.
async function crowdBuildZip(file, { assent, receipt, promptAudio }) {
  const entries = [{ name: file.name, data: file }];
  if (assent?.blob) entries.push({ name: assent.name, data: assent.blob });
  if (promptAudio?.blob) entries.push({ name: promptAudio.name, data: promptAudio.blob });
  if (receipt) {
    const full = { ...receipt, textTitle: file.name };
    entries.push({ name: 'consent-receipt.json', data: new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' }) });
    entries.push({ name: 'consent-receipt.txt', data: new Blob([consentReceiptText(full)], { type: 'text/plain' }) });
  }
  return makeZip(entries);
}

async function crowdQueueAndSubmit(file, extras) {
  crowdMarkSubmitted();   // the cooldown starts at the Send TAP, not at delivery
  const zip = await crowdBuildZip(file, extras);
  const cap = (CROWD_CFG && CROWD_CFG.maxBytes) || 5 * 1024 * 1024;
  if (zip.size > cap) {
    // Can't shrink it and the server would refuse it — be honest rather than retry forever.
    renderCrowdView('failed', { detail: t('crowd.tooLarge') });
    return;
  }
  await crowdPutPending({ id: mkGuid(), created: Date.now(), blob: zip });
  renderCrowdView('sending');
  await crowdFlush(true);
}

// One item → the worker. ok ONLY on confirmed Drive delivery. Throws with e.code
// carrying the worker's error keyword so crowdFlush can pick the right message.
// Small zips are one POST; big ones go CHUNKED (a single request is platform-
// capped ~100 MB — chunks are not), with the session ticket persisted on the
// pending item so a reload resumes mid-file.
const CROWD_CHUNK_SINGLE_MAX = 16 * 1024 * 1024;
const CROWD_CHUNK = 8 * 1024 * 1024;   // multiple of 256 KiB (Drive chunk rule)
async function crowdSubmitOne(item) {
  if (item.blob.size > CROWD_CHUNK_SINGLE_MAX) return crowdSubmitChunked(item);
  const headers = {};
  if (CROWD_CFG && CROWD_CFG.turnstile) headers['x-fx-turnstile'] = await crowdTurnstileToken();
  const r = await fetch(workerBase() + '/v1/crowd/' + encodeURIComponent(CROWD_ID) + '/submit',
    { method: 'POST', headers, body: item.blob });
  const out = await r.json().catch(() => ({}));
  if (r.ok && out.ok) { await crowdDelPending(item.id); return; }
  const e = new Error(out.error || ('HTTP ' + r.status));
  e.code = out.error || '';
  throw e;
}

async function crowdChunkPut(streamId, range, body) {
  const r = await fetch(workerBase() + '/v1/crowd/' + encodeURIComponent(CROWD_ID) + '/submit/chunk', {
    method: 'PUT',
    headers: { 'x-fx-upload': streamId, 'x-fx-range': range,
               ...(body ? { 'content-type': 'application/octet-stream' } : {}) },
    body,
  });
  return { status: r.status, out: await r.json().catch(() => ({})) };
}

async function crowdSubmitChunked(item) {
  const total = item.blob.size;
  if (!item.streamId) {
    const headers = { 'content-type': 'application/json' };
    if (CROWD_CFG && CROWD_CFG.turnstile) headers['x-fx-turnstile'] = await crowdTurnstileToken();
    const r = await fetch(workerBase() + '/v1/crowd/' + encodeURIComponent(CROWD_ID) + '/submit/start',
      { method: 'POST', headers, body: JSON.stringify({ size: total }) });
    const out = await r.json().catch(() => ({}));
    if (!(r.ok && out.ok && out.uploadId)) { const e = new Error(out.error || ('HTTP ' + r.status)); e.code = out.error || ''; throw e; }
    item.streamId = out.uploadId;
    await crowdPutPending(item);   // the ticket survives a reload → resume mid-file
  }
  // Where does Drive stand? (exact resume after any interruption)
  let p = await crowdChunkPut(item.streamId, `bytes */${total}`, null);
  if (p.out.error === 'session_gone' || p.out.error === 'bad_upload') {
    delete item.streamId; await crowdPutPending(item);
    return crowdSubmitChunked(item);   // fresh session (new Turnstile), single re-entry
  }
  if (p.out.done) { await crowdDelPending(item.id); return; }
  if (!p.out || p.out.done !== false) { const e = new Error(p.out.error || 'chunk probe failed'); e.code = p.out.error || ''; throw e; }
  let offset = p.out.received || 0;
  while (offset < total) {
    const end = Math.min(offset + CROWD_CHUNK, total);
    const res = await crowdChunkPut(item.streamId, `bytes ${offset}-${end - 1}/${total}`, item.blob.slice(offset, end));
    if (res.out.done) { await crowdDelPending(item.id); return; }
    if (res.out.done === false) { offset = res.out.received != null ? res.out.received : end; continue; }
    if (res.out.error === 'session_gone') { delete item.streamId; await crowdPutPending(item); }
    const e = new Error(res.out.error || ('HTTP ' + res.status));
    e.code = res.out.error || '';
    throw e;   // crowdFlush keeps the item; retry resumes from Drive's offset
  }
  // All bytes sent but no done seen — final probe settles it.
  p = await crowdChunkPut(item.streamId, `bytes */${total}`, null);
  if (p.out.done) { await crowdDelPending(item.id); return; }
  const e = new Error('finalize failed'); e.code = p.out.error || ''; throw e;
}

// Drain the pending store oldest-first. interactive=true drives the visitor-facing
// states (sending/thanks/failed); the silent boot retry only updates the counter.
async function crowdFlush(interactive) {
  if (crowdFlushing) return;
  crowdFlushing = true;
  try {
    const items = (await crowdListPending()).sort((a, b) => a.created - b.created);
    crowdPendingCount = items.length;
    let err = null;
    for (const item of items) {
      try { await crowdSubmitOne(item); crowdPendingCount--; }
      catch (e) {
        if (e.code === 'too_large' || e.code === 'too_small') {   // permanently unsendable — drop, don't wedge the queue
          await crowdDelPending(item.id);
          crowdPendingCount--;
        }
        err = e;
        break;   // first failure is almost always the network — stop, retry later
      }
    }
    if (!interactive) { if (crowdState === 'ready') renderCrowdView('ready'); return; }
    if (!err && !crowdPendingCount) renderCrowdView('thanks');
    else if (err && (err.code === 'paused' || err.code === 'budget' || err.code === 'not_found')) renderCrowdView('closed');
    else renderCrowdView('failed', { detail: err && err.code === 'too_large' ? t('crowd.tooLarge') : '' });
  } finally { crowdFlushing = false; }
}

async function setupCrowdMode() {
  crowdSessionId = 'crowd-' + mkGuid();
  const params = new URLSearchParams(location.search);
  CROWD_ID = params.get('c') || '';
  if (params.get('embed') === '1') {
    document.body.classList.add('crowd-embed');
    document.documentElement.classList.add('crowd-embed');   // the height:100% chain starts at <html>
    // Blend with the host page: transparent background + auto-size messages that
    // embed.js (if used) turns into a fitted iframe height. Height only — no data.
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    try {
      // Measure the CONTENT's true bottom edge, not scrollHeight: inside an iframe
      // the body fills the viewport, so scrollHeight can never shrink below the
      // frame's current height — a one-way ratchet. Fixed-position elements (the
      // modals, the Turnstile host) are skipped; an open modal just enforces a
      // minimum tall enough to use it.
      const post = () => {
        let h = 0;
        for (const el of document.body.children) {
          if (getComputedStyle(el).position === 'fixed') continue;
          const r = el.getBoundingClientRect();
          h = Math.max(h, r.bottom + window.scrollY);
        }
        h = Math.ceil(h) + 24;
        // Modals are IN-FLOW cards in embed mode (see .crowd-embed .modal in the
        // CSS) — they're measured like any other content; no special-casing.
        parent.postMessage({ fxCrowd: 'height', h: Math.max(h, 240) }, '*');
      };
      new ResizeObserver(post).observe(document.body);
      setInterval(post, 1200);   // fixed-position changes don't fire the observer — poll cheaply
    } catch { /* no ResizeObserver — the fixed iframe height stands */ }
  }
  settings = {};   // NEVER loadSettings(): this browser may belong to a field worker
  if (params.get('lang') && LANGS.includes(params.get('lang'))) setLang(params.get('lang'), { save: false });
  applyI18n();
  // The public page's audience is the MOST likely to arrive on an iPhone — show the
  // unsupported-WebKit warning here too. Dismiss hides it for this visit only (no
  // localStorage: setupBanners' persisted dismiss would write the shared origin).
  if (isUnsupportedWebKit(navigator.userAgent, navigator.maxTouchPoints || 0)) {
    const wk = $('#webkit-warning');
    if (wk) {
      wk.hidden = false;
      wk.querySelector('.banner-dismiss')?.addEventListener('click', () => { wk.hidden = true; });
    }
  }
  wireSharedModals();   // record + consent modal wiring (fully guarded lookups)
  crowdRelabelSend();
  const langSel = $('#lang-select');
  if (langSel) {
    langSel.value = getLang();
    langSel.addEventListener('change', () => {
      setLang(langSel.value, { save: false });   // in-memory only on the shared origin
      applyI18n();
      crowdRelabelSend();
      renderCrowdView(crowdState);
    });
  }
  show('record');
  renderCrowdView('loading');
  if (!CROWD_ID) { renderCrowdView('notfound'); return; }
  let cfg;
  try {
    const r = await fetch(workerBase() + '/v1/crowd/' + encodeURIComponent(CROWD_ID), { cache: 'no-store' });
    if (r.status === 404) { renderCrowdView('notfound'); return; }
    if (r.status === 429) {
      // Server busy (shared free-plan throttle) ≠ the visitor being offline — say so
      // honestly and retry by itself; a jittered wait keeps a crowd from re-stampeding.
      renderCrowdView('busy');
      setTimeout(() => { if (crowdState === 'busy') setupCrowdMode(); }, 20000 + Math.floor(Math.random() * 20000));
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    cfg = await r.json();
  } catch { renderCrowdView('offline'); return; }
  if (!cfg.enabled) { renderCrowdView('closed'); return; }
  CROWD_CFG = cfg;
  if (LANGS.includes(cfg.lang) && cfg.lang !== getLang() && !params.get('lang')) {
    setLang(cfg.lang, { save: false });
    applyI18n();
    crowdRelabelSend();
    if (langSel) langSel.value = cfg.lang;
  }
  // Feed the shared consent gate + recorder through the in-memory settings object.
  settings = {
    consentAsk: cfg.consentAsk || [],
    consentConfirm: cfg.consentConfirm || [],
    consentMsg: cfg.consentMsg || '',
    consentAudioUrl: cfg.consentAudio || '',
    consentAudio: cfg.consentAudio ? resolveAudioInput(cfg.consentAudio) : '',
    recordFormat: normRecFormat(cfg.recordFormat || 'wav24'),  // researcher-chosen; engine falls back if unsupported
    convert: { kbps: 64, rate: 22050, mono: true },
  };
  renderCrowdView('ready');
  crowdFlush(false).catch(() => {});   // finish any stranded past submission, silently
  window.addEventListener('online', () => { crowdFlush(crowdState === 'failed').catch(() => {}); });
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
    // The researcher panel takes over the full screen (its own header), covering the
    // top install banner — surface an Install button in the panel header instead.
    if (researcherPanelApi && researcherPanelApi.onInstallable) researcherPanelApi.onInstallable();
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

  // Confirm a just-completed auto-update. The flag is set ONLY inside doUpdateReload() right before the
  // reload (tied to a real controllerchange), so it can never show a false "updated".
  try { if (sessionStorage.getItem('fx-updated')) { sessionStorage.removeItem('fx-updated'); toast(t('update.done'), 4000); } } catch { /* noop */ }

  // A new worker took control → reload to run it. RE-CHECK safety HERE (not only when we posted
  // SKIP_WAITING): controllerchange also fires in OTHER tabs (clients.claim) and after an async gap, so
  // a tab that became unsafe (opened a text, started recording) defers its reload until it is safe again.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    if (!forcedApply && !updateSafeNow()) { reloadPending = true; return; }   // forced (manual shortcut) reloads regardless
    doUpdateReload();
  });

  navigator.serviceWorker.register('sw.js').then((reg) => {
    swReg = reg;                                   // expose so bgUpdateCheck() can trigger a fresh check from anywhere
    const check = () => reg.update().catch(() => {});
    // CRITICAL: never post CLEANUP while a new version's COMPLETE cache is waiting/installing — the old
    // worker's cleanup would delete that cache (different version name) and the new worker would activate
    // with no cache (offline brick). The new worker's own activate-time cleanup prunes the old cache safely.
    if (!reg.waiting && !reg.installing) reg.active?.postMessage({ type: 'CLEANUP' });
    // A fully-installed waiting worker = a COMPLETE new cache (install is atomic), ready to apply.
    if (reg.waiting && navigator.serviceWorker.controller) markUpdateReady(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) markUpdateReady(nw);
      });
    });
    // Check for a new version (and apply a ready one, if safe) on load, when the app returns to the
    // foreground, when the network comes back, and every 5 min while open — so an app that stays open
    // (a long recording session, a researcher watching the dashboard) self-updates within minutes
    // instead of up to an hour. A failed download just leaves the old version serving and is retried
    // on the next check (the SW install is all-or-nothing); updates apply only at a safe moment.
    check();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { check(); applyUpdateIfSafe(); } });
    window.addEventListener('online', () => { check(); applyUpdateIfSafe(); });
    setInterval(() => { check(); applyUpdateIfSafe(); }, 5 * 60 * 1000);
    // Manual "check for updates now" — Ctrl/⌃ + Alt/⌥ + U (mirrors the Ctrl+Alt+R research toggle). e.code
    // keys off the physical U so the Mac Option-U dead key (ü) doesn't matter. Forces a check + immediate apply.
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && (e.code === 'KeyU' || e.key === 'u' || e.key === 'U')) {
        e.preventDefault(); forceUpdateCheck();
      }
    });
  }).catch(() => {});
}

// ---- Auto-update (no prompt) ----
// A fully-installed WAITING worker means a COMPLETE new cache: the SW install precaches the whole shell
// atomically (per-file fetch with retries; if ANY file ultimately fails the install throws → it never
// reaches 'installed' → the OLD version keeps serving). So activating a waiting worker can never serve a
// half-downloaded version. We hold it until a SAFE moment, apply silently, and a post-reload toast
// ('App updated') confirms — set only right before activation, so it can never claim a false update.
let pendingWorker = null;   // a fully-installed waiting SW, ready to activate when safe
let reloadPending = false;  // a controllerchange fired while this tab was unsafe → reload when safe
let reloading = false;      // re-entry guard so we reload exactly once
let savingRecording = false; // a take is being encoded + written to IndexedDB — a reload would abort it
let forcedApply = false;     // user pressed the manual "check for updates" shortcut → apply now even off the safe views
let swReg = null;            // the SW registration, so a fresh update CHECK can be triggered from anywhere
let lastBgCheck = 0;         // throttle the texts-list detection check (don't hammer reg.update on rapid nav)
let updBannerEl = null;      // "new version ready" banner + countdown shown while a text is open
let updCountdownTimer = null;
let updCountdownEnd = 0;
const UPDATE_FORCE_MS = 30000;   // grace before we auto-exit an open text to install (work is auto-saved)

function markUpdateReady(worker) {
  pendingWorker = worker;
  applyUpdateIfSafe();        // applies immediately if we're on a safe screen…
  refreshUpdateBanner();      // …otherwise prompt the user to exit their open text so it can apply
}

// Landing on the texts list is a safe apply moment AND a good time to actively CHECK for a new version —
// so a coworker who only ever flits through the main screen (never camps there for the 5-min poll) still
// detects updates. Applies a ready one right away; the detection fetch is throttled so rapid nav can't
// hammer it. (The download/install still happens in the background regardless of which screen they're on.)
function bgUpdateCheck() {
  applyUpdateIfSafe();
  const now = Date.now();
  if (swReg && now - lastBgCheck >= 30000) { lastBgCheck = now; swReg.update().catch(() => {}); }
}

// While a text is OPEN, an auto-update is held (never yank interlinear work mid-keystroke). Rather than
// wait forever for a user who camps in a text, show a visible banner + COUNTDOWN, then auto-exit to the
// Texts list and install. Safe: the open doc is auto-saved (applyUpdateIfSafe flushes persist before the
// reload), so the user loses nothing — they just land on Texts, updated, and reopen. Tap = update now.
function forceUpdateNow() {
  if (updCountdownTimer) { clearInterval(updCountdownTimer); updCountdownTimer = null; }
  show('texts');            // leaves the text (safe view) → show()'s bgUpdateCheck applies it
  applyUpdateIfSafe();      // belt-and-suspenders
}
function paintUpdateCountdown() {
  if (!updBannerEl) return;
  const left = Math.max(0, Math.ceil((updCountdownEnd - Date.now()) / 1000));
  updBannerEl.textContent = t('update.forceExit', { s: left });
  if (left <= 0) {
    // Don't yank a half-saved recording or an open dialog — extend a few seconds and retry.
    if (savingRecording || document.querySelector('.modal:not([hidden])')) { updCountdownEnd = Date.now() + 6000; return; }
    forceUpdateNow();
  }
}
function refreshUpdateBanner() {
  const pending = !!pendingWorker || reloadPending;
  const b = document.getElementById('view-baseline'), g = document.getElementById('view-gloss');
  const editingText = !RECORD_MODE && ((b && !b.hidden) || (g && !g.hidden));
  if (!(pending && editingText)) {                                  // no update OR not in a text → stand down
    if (updCountdownTimer) { clearInterval(updCountdownTimer); updCountdownTimer = null; }
    if (updBannerEl) updBannerEl.hidden = true;
    return;
  }
  if (!updBannerEl) {
    updBannerEl = document.createElement('button');
    updBannerEl.id = 'update-ready-banner';
    updBannerEl.className = 'update-ready-banner';
    updBannerEl.type = 'button';
    updBannerEl.addEventListener('click', forceUpdateNow);          // tap = update right now
    (document.body || document.documentElement).appendChild(updBannerEl);
  }
  updBannerEl.hidden = false;
  if (!updCountdownTimer) {                                         // start the one-shot countdown to auto-exit
    updCountdownEnd = Date.now() + UPDATE_FORCE_MS;
    paintUpdateCountdown();
    updCountdownTimer = setInterval(paintUpdateCountdown, 1000);
  }
}

// Safe = no recording mid-save, no modal/dialog open, AND — in the editor — NOT currently editing an open
// text (the baseline/gloss views). The Texts list, Settings, help, research, and the researcher panel are
// all safe to reload (settings persist on change; nothing to yank). Cold start passes.
function updateSafeNow() {
  if (savingRecording) return false;   // a recording save is mid-write to IndexedDB — a reload would lose the take
  if (document.querySelector('.modal:not([hidden])')) return false;
  if (!RECORD_MODE) {                  // defer ONLY while a text is open for editing — never yank interlinear work
    const b = document.getElementById('view-baseline'), g = document.getElementById('view-gloss');
    if ((b && !b.hidden) || (g && !g.hidden)) return false;
  }
  return true;
}

// Set the "just updated" flag and reload — called ONLY at the moment we actually reload (from
// controllerchange), so the post-reload toast is tied to a real apply and can never be a false "updated".
function doUpdateReload() {
  if (reloading) return;
  reloading = true;
  try { sessionStorage.setItem('fx-updated', '1'); } catch { /* private mode */ }
  location.reload();
}

// Re-checked at every safe moment (foreground-return, landing on the texts list, closing a record/consent
// modal). Flushes a deferred reload first, else activates a ready waiting worker.
function applyUpdateIfSafe() {
  if (reloading) return;
  if (reloadPending) { if (updateSafeNow()) doUpdateReload(); return; }
  if (!pendingWorker || !updateSafeNow()) return;
  const w = pendingWorker; pendingWorker = null;
  // Flush any debounced save so nothing in flight is lost. The flag + reload happen later in
  // doUpdateReload (via controllerchange), which RE-CHECKS safety — so a gap-race can't reload mid-edit.
  Promise.resolve(current ? persist() : null).catch(() => {}).finally(() => {
    w.postMessage({ type: 'SKIP_WAITING' });   // → activate → controllerchange → (if safe) doUpdateReload
  });
}

// Apply a ready worker NOW because the user asked (the manual shortcut), even if not on a "safe" view —
// still flush state first and still refuse mid-recording-save (the one genuinely unsafe case).
function forceApply(worker) {
  if (savingRecording) { toast(t('update.busyRecording'), 4000); return; }
  forcedApply = true; pendingWorker = null;
  Promise.resolve(current ? persist() : null).catch(() => {}).finally(() => {
    worker.postMessage({ type: 'SKIP_WAITING' });   // → controllerchange → doUpdateReload (forced)
  });
}

// Manual "check for updates now" (Ctrl/⌃+Alt/⌥+U). Forces a SW update check and, if a new version is
// ready/downloading, applies it immediately instead of waiting for the 5-min poll. Toasts the outcome.
async function forceUpdateCheck() {
  if (!('serviceWorker' in navigator)) { toast(t('update.none', { v: ENGINE_VERSION }), 3000); return; }
  toast(t('update.checking'), 2500);
  let reg = null;
  try { reg = await navigator.serviceWorker.getRegistration(); } catch { /* noop */ }
  if (!reg) { toast(t('update.none', { v: ENGINE_VERSION }), 3000); return; }
  if (reg.waiting) { toast(t('update.downloading'), 2500); forceApply(reg.waiting); return; }
  try { await reg.update(); } catch { toast(t('update.checkFailed'), 4000); return; }
  if (reg.waiting) { toast(t('update.downloading'), 2500); forceApply(reg.waiting); return; }
  if (reg.installing) {
    toast(t('update.downloading'), 3000);
    const nw = reg.installing;
    nw.addEventListener('statechange', () => { if (nw.state === 'installed') forceApply(nw); });
    return;
  }
  toast(t('update.none', { v: ENGINE_VERSION }), 3000);   // already current
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

// Complete client wipe → a pristine "no PWA installed" slate. Clears ALL this-origin storage
// (localStorage + sessionStorage), deletes every IndexedDB database, deletes every CacheStorage cache,
// and unregisters all service workers, then reloads. ORDER matters: close the docs DB + clear storage →
// delete IDBs (awaited, never hangs) → delete caches → unregister SW LAST → reload, so the fresh load
// fetches truly uncached (or shows the browser's offline page) with nothing left behind. Origin-wide by
// design (editor + recorder + researcher share this origin) — every key is flextext-* and all ours.
// Used by ?devreset (localhost) AND the researcher panel's "Erase all data" + account-switch guard.
function deleteDB(name) {
  return new Promise((resolve) => {
    let done = false; const fin = () => { if (!done) { done = true; resolve(); } };
    try { const req = indexedDB.deleteDatabase(name); req.onsuccess = fin; req.onerror = fin; req.onblocked = fin; }
    catch { fin(); }
    setTimeout(fin, 2500);   // a blocked delete must never hang the wipe; the reload completes it
  });
}
async function eraseAllData() {
  // Wrap the whole wipe so the reload in `finally` ALWAYS runs — even if a step throws, the page reloads
  // to a blank slate. ORDER is deliberate for a remote-wipe that may be INTERRUPTED on a seized device:
  // destroy the actual CORPUS first (the docs/audio IndexedDB), THEN credentials/settings, THEN caches/SW
  // — so a wipe killed partway has already obliterated the data. (For the non-interrupted cases — local
  // Erase / account-delete — order is immaterial; the whole lot goes.)
  try {
    try { db.close(); } catch { /* noop */ }                     // drop the cached docs-DB handle so the delete isn't blocked
    try {
      let names = [];
      if (indexedDB.databases) { try { names = (await indexedDB.databases()).map((d) => d.name).filter(Boolean); } catch { /* noop */ } }
      // Firefox lacks indexedDB.databases() → union with the known DB names. flextext-editor (the corpus)
      // FIRST so the most sensitive data dies before anything else, then flextext-sync (the install key),
      // then flextext-crowd (an unsent crowd package holds audio + a signed consent receipt — a remote
      // wipe on a seized device must take that too).
      for (const name of new Set(['flextext-editor', 'flextext-sync', 'flextext-crowd', ...names])) await deleteDB(name);
    } catch { /* noop */ }
    try { localStorage.clear(); } catch { /* noop */ }
    try { sessionStorage.clear(); } catch { /* noop */ }
    try { if (window.caches) for (const k of await caches.keys()) await caches.delete(k); } catch { /* noop */ }
    try { for (const r of (await navigator.serviceWorker?.getRegistrations?.()) || []) await r.unregister(); } catch { /* noop */ }
  } finally {
    location.replace(location.pathname);
  }
}
// Dev-only hard reset hook: ?devreset on localhost runs the same wipe (no-op off localhost; see setup()).
async function devReset() { return eraseAllData(); }

// Standalone "Flextext Researcher" app: wire only what the panel needs and boot straight into it
// (no editor/field UI). The shell (flextext-researcher/index.html) provides #view-researcher +
// #toast + an optional language selector. Exit/lock is handled inside the panel (deps.standalone).
function setupResearcherMode() {
  setupBanners();   // install button + (no-op) WebKit warning; shell carries #install-banner
  const langSel = $('#lang-select');
  if (langSel) {
    langSel.value = getLang();
    langSel.addEventListener('change', () => { setLang(langSel.value); applyI18n(); researcherPanelApi.open(); });
  }
  researcherPanelApi = initResearcherPanel({
    root: $('#view-researcher'),
    standalone: true,
    workerBase: () => workerBase(),
    toast: (m, ms) => toast(m, ms),
    loadSettings,
    saveSettings,
    parseDriveFolder,
    resolveAudioInput,
    openView: (v) => show(v),
    goHome: () => {},   // no editor to return to; the panel's Lock button signs out → sign-in
    eraseAllData: () => eraseAllData(),
    canInstall: () => !!installPrompt,
    doInstall: async () => {
      if (!installPrompt) return;
      const p = installPrompt; installPrompt = null;   // usable once
      try { p.prompt(); await p.userChoice; } catch { /* dismissed */ }
      updateInstallBanner();
    },
  });
  researcherPanelApi.open();
}

function setup() {
  // Crowd mode boots FIRST — before applyUrlSettings/migrateSettings/SW/sync can
  // touch the shared-origin storage a field worker's apps may be using on this
  // same browser profile. Everything crowd needs is fetched or in-memory.
  if (CROWD_MODE) { setupCrowdMode(); return; }
  if (isDevHost(location.hostname) && new URLSearchParams(location.search).has('devreset')) { devReset(); return; }
  // Editor-origin ?mode=researcher → hand off to the standalone Researcher app (its own install +
  // service worker). Preserve a returning #gauth fragment so an in-flight Google sign-in still
  // completes there. The standalone shell (window.__MODE='researcher') and local dev keep the
  // panel inline (RESEARCHER_MODE), so they never bounce here.
  if (!RESEARCHER_MODE && new URLSearchParams(location.search).get('mode') === 'researcher') {
    location.replace('https://rulingants.github.io/flextext-researcher/' + (location.hash || ''));
    return;
  }
  migrateSettings();
  const { settingsChanged, task } = applyUrlSettings();
  settings = loadSettings();
  applyI18n();

  // Local live-sync: when another same-origin window/app changes settings or the doc list, re-render
  // here too — no manual refresh. Registered in every mode; the handlers no-op in researcher mode.
  db.onLive((kind) => { if (kind === 'settings') applyLiveSettings(); else if (kind === 'docs') refreshLiveLists(); });

  showAppVersion();   // subtle corner version badge (all modes; fire-and-forget)

  // ----- Standalone Researcher console: boot the panel only; skip ALL field/editor wiring. -----
  if (RESEARCHER_MODE) {
    setupServiceWorker();
    setupResearcherMode();
    return;
  }

  // Connectivity sync engine — inert unless an invite is/was claimed (plan P1).
  Sync.start({
    workerBase: () => workerBase(),
    appType: () => RECORD_MODE ? 'recorder' : 'editor',
    dispatch: syncDispatch,
    gatherInventory: syncGatherInventory,
    onStatus: () => {},
    onRevoked: onSyncRevoked,
    eraseAllData: () => eraseAllData(),   // remote-wipe directive → full local nuke (seized device)
  });
  // Enrolled devices stream uploads through the worker into the researcher's own
  // Drive ("FlexText Uploads / <device>"); unmanaged devices get null → relay as
  // always. Evaluated per attempt inside the upload engine (see upload.js).
  setWorkerUploadTarget(() => Sync.workerUploadTarget());
  handleInviteParam();
  // Re-prompt an unfinished invite acceptance on reload (B): a claimed-but-unaccepted enrollment
  // re-shows the consent dialog. (handleInviteParam shows it for a fresh link; this covers a reload
  // without the link. The dialog guards against stacking, and a claim still in flight has no
  // instanceId yet, so pendingConsent() returns null until the claim lands.)
  { const pend = Sync.pendingConsent(); if (pend) showInviteConsent(pend.researcher); }

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
  window.addEventListener('online', () => { retryPendingAudio(); retryPendingUploads(); autoBackupSweep().then(sweepPendingUpDel).catch(() => {}); });
  window.addEventListener('offline', () => { renderUploadQueue(); });
  // Pending uploads AND pending downloads (task audio + attached flextext) keep
  // retrying forever while the app is open — a flaky village link that never
  // fires a clean offline→online edge still gets the work moved eventually.
  // Auto-backup + finish-pending-deletes ride the same cadence.
  setInterval(() => {
    if (!navigator.onLine) return;
    retryPendingAudio(); // also sweeps pending task flextexts
    if (uploadView.size) retryPendingUploads();
    autoBackupSweep().then(sweepPendingUpDel).catch(() => {});
  }, RETRY_EVERY_MS);
  retryPendingAudio();
  retryPendingUploads();
  autoBackupSweep().then(sweepPendingUpDel).catch(() => {});
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
  applyAllowedButtons();
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
  // Dummy "Save" (Office-web style): work is ALREADY auto-saved continuously — this just flushes any
  // pending save and reassures the coworker, so the obsessive Save reflex never triggers an upload.
  // The real send is the separate "Sudah selesai (Kirim)" button (#btn-share → the send menu).
  $('#btn-save')?.addEventListener('click', async () => {
    if (activeTab === 'baseline' && $('#baseline-text')) applyBaseline();
    try { await persist(); } catch { /* already saved / nothing to flush */ }
    toast(t('toast.autoSaved'), 4000);
  });
  $('#btn-share').addEventListener('click', openShareMenu);
  $('#btn-done')?.addEventListener('click', () => { toggleDone().catch(() => {}); });

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

  // ----- Researcher panel (separate full-screen view; editor mode only) -----
  researcherPanelApi = initResearcherPanel({
    root: $('#view-researcher'),
    workerBase: () => workerBase(),
    turnstileSiteKey: () => turnstileSiteKey(),
    toast: (m, ms) => toast(m, ms),
    loadSettings,
    saveSettings,
    parseDriveFolder,
    resolveAudioInput,
    openView: (v) => show(v),
    goHome: () => { renderDocList(); show('texts'); },
    eraseAllData: () => eraseAllData(),
    onSignedUp: () => { const b = $('#btn-researcher'); if (b) b.hidden = !researcherPanelApi.isSignedUp(); },
    onLocalSettingsSaved: () => {
      settings = loadSettings();
      applyResearchVisibility();
      applyAllowedButtons();
      fillWsForm();
      renderDocList();
    },
  });
  const researcherBtn = $('#btn-researcher');
  if (researcherBtn) {
    researcherBtn.hidden = !researcherPanelApi.isSignedUp();
    researcherBtn.addEventListener('click', () => researcherPanelApi.open());
  }

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
  Object.assign(window.__app, { uploadView, renderUploadQueue, allowedButtons, uploadDocById, buildBundleFor });
}
