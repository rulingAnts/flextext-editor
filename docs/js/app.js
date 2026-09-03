/* app.js — UI controller for the Flextext Editor PWA. */

import {
  parseFlextext, serializeFlextext, makeDoc, makeWord, makeSegment,
  getBaselineParagraphs, reconcileBaseline, segmentText, tokenize,
  canMerge, mergeWords, breakPhrase, newGuid, segmentsFromOffsets,
  surveyWritingSystems, remapWritingSystems, analyzeFlextextWs,
  mergePhrases, baselineFromWords,
} from './flextext.js';
import * as db from './db.js';
import { t, getLang, setLang, applyI18n, LANGS, LANG_NAMES, langCoverage, ENGINE_VERSION, BUILD_TAG } from './i18n.js';
import { Player, downloadAudioForDoc, getDownload, clearPartial, driveFileId, isProbablyUrl, probeAudioUrl, ensureAsset, getAsset, fetchFileViaUrl } from './audio.js';
import { convertToMp3, convertAudio, detectFormat, readWavHeader, validOutputs } from './convert.js';
// NATIVE BRIDGE — the ONLY import of native code in this engine. Everything Android-specific
// lives behind js/native-audio.js and is INERT in a browser. See that file's header before
// changing anything here; ./check-native-containment.sh enforces the boundary.
import { isNativeShell, nativeAudioAvailable, NativeRecorder, releaseCapture, nativePlatform, nativeEngineInfo, describeCapture } from './native-audio.js';
import { losslessSupported, recFormatSupported, PCMRecorder, encodeWav, encodeRecording, normalizePeak, reduceChannels,
         normRecFormat, REC_FORMATS, DEFAULT_REC_FORMAT, pcmRamBudgetBytes, pcmCapStatus } from './record-pcm.js';
import WaveSurfer from './vendor/wavesurfer.esm.js';
import { makeZip } from './zip.js';
import { initStrips, renderStrips, stopStrips, ensurePeaks, docSegments, drawSpanWave, wireSegPlay,
         wireWaveSeek, requestReveal, takeReveal, followLine, attachSpanWave, healSpanWave,
         peaksDurationMs, guessedBoundaries,
         initCut, renderCut, cutHere, cutJoinPrev, cutTogglePlay, cutGuessSplits, stopCut,
         stripSplitAtPlayhead, segProgress } from './segment-strips.js';
import { wavWithBext, captureBext, assembleSegEntries, MANIFEST_NAME, buildSourceManifest,
         sanitizeBase, extOf, mediaNameFor, derivedWavName, conversionCaps,
         loosePlan, buildLooseConversion, durationVerdict } from './seg-exports.js';
// MIN_SEGMENT_MS joins an EXISTING import — segments.js is already a SHELL entry in every
// satellite, so this adds no precache path and cannot repeat the v108 outage.
import { mergeSegments, splitSegment, isAligned, normalizeSegments, MIN_SEGMENT_MS, GUESS_MAX_MS } from './segments.js';
import { initParagraphApp } from './paragraph-ui.js';
import { DriveUpload, driveFolderId as parseDriveFolder, getUpload, listPendingUploads, setWorkerUploadTarget, runChunkedUpload } from './upload.js';
import * as Sync from './sync.js';
import { initResearcherPanel, companionApps } from './researcher-panel.js';
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
// window.__MODE='researcher'), or — DEV HOSTS ONLY — ?mode=researcher on the editor origin
// (localhost AND the Cloudflare staging site, so panel features can be test-driven against the
// staging engine before a release; staging still talks to the PRODUCTION worker).
// In PRODUCTION the editor redirects ?mode=researcher to the standalone app (see setup());
// there is no in-editor URL entry anymore.
const RESEARCHER_MODE = (typeof window !== 'undefined' && window.__MODE === 'researcher') ||
  (new URLSearchParams(location.search).get('mode') === 'researcher' && (isLocalDev() || isStagingHost()));
// Crowd mode: the PUBLIC crowd-source recorder (crowd-recorder/index.html sets
// window.__MODE='crowd'). No PWA/SW/sync — an always-fresh page anyone with the link
// can use: welcome → consent → record → submit straight to the worker (which relays
// to the researcher's Drive). It shares this ORIGIN with the field apps, so it must
// NEVER write the shared settings/lang/doc stores — its config lives in memory and
// its only persistence is its OWN IndexedDB database (unsent submissions).
const CROWD_MODE = typeof window !== 'undefined' && window.__MODE === 'crowd';
// Paragraph Analysis mode: the "Flextext Paragraph Analysis" satellite (paragraph-analysis/
// index.html sets window.__MODE='paragraph'). Boots straight into the grouping app
// (js/paragraph-ui.js) and skips ALL field/editor wiring, like the researcher console. Shell-only
// on purpose — no ?mode= entry: the editor page has no #pa-main container to boot into.
const PARAGRAPH_MODE = typeof window !== 'undefined' && window.__MODE === 'paragraph';
// Consent-collector mode: the "Flextext Consent Collector" satellite (window.__MODE='consent').
// It exists because speaker permission can only be captured at doc CREATION in the record flow —
// there is no path that adds it to a text that already exists. A back catalogue recorded before
// the consent workflow therefore cannot be archived, and cannot be re-recorded either, because the
// speakers have moved on or died. So this app takes texts in by assignment or import exactly as
// the recorder does, adds the consent layer, and hands off through the normal upload/save/send
// system. It sits at the RECORDER's position in setup() because it needs the same sync, upload and
// consent machinery — it is the recorder's sibling, not the researcher's.
// Shell-only, no ?mode= entry: the editor page has no #view-consent to boot into.
const CONSENT_MODE = typeof window !== 'undefined' && window.__MODE === 'consent';
// Segmenter mode: the "Flextext Audio Segmenter" satellite (window.__MODE='segmenter'). Cuts a
// recording into segments and matches them to the lines of a text that already exists — the Cut
// tab and the baseline strips, and deliberately nothing else: no glossing, no free translation,
// no baseline text editing. It reuses segment-strips.js/segments.js unchanged; what makes it an
// app rather than a tab is that it cannot do anything else, which is the same argument
// plans/cut-tab.md makes for the Cut tab itself.
const SEGMENTER_MODE = typeof window !== 'undefined' && window.__MODE === 'segmenter';

// The Texts-screen "new text" buttons a researcher can show/hide per link.
// 'pair' = open a .flextext AND its recording together (v332). Its own key, so a researcher can
// offer it without offering plain file-opening, and vice versa (Seth). A device configured BEFORE
// v332 has a stored list with no 'pair' in it and therefore will not show the button until its
// researcher ticks it — which costs nothing, because the pair button has never been in production
// (it landed on staging in v330). Unconfigured devices get everything, this list being the default.
const ALL_BUTTONS = ['new', 'audio', 'record', 'open', 'pair'];
/* The send options a device can be given. 'download' is deliberately ABSENT: it is a legacy alias
 * of 'save' (see allowedSend) and must never be offered or written again. */
const SEND_OPTIONS = ['share', 'upload', 'save'];

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
/* ONE production widget serves BOTH estates — github.io AND the *.flextext.app origins — which is
 * what keeps a single site key in the client with no per-origin branching.
 * ⚠ Turnstile site keys are HOSTNAME-LOCKED in the dashboard, and that list is invisible from here.
 * A hostname that is not on it renders "Unable to connect to website" and the upload can never
 * start, while the identical code works elsewhere (crowd.flextext.app, 2026-08-05).
 *
 * ⚠ ONLY CROWD-RECORDER ORIGINS NEED A SLOT. This is the entire Turnstile surface: it is rendered
 * only by the crowd upload path below (`crowd-turnstile`, gated on CROWD_CFG.turnstile). The editor
 * and recorder upload to Drive through the worker with a relay token; the researcher panel and the
 * paragraph tool never touch it. The widget's name ("FlexText signup") suggests wider use than it
 * has — do not infer from it. The dashboard caps a widget at 10 hostnames, so listing origins that
 * never render the widget is what makes that cap bite. */
const TURNSTILE_SITE_KEY = '0x4AAAAAADo0TdBBVpldATJ6';
const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';  // Cloudflare always-pass key (local dev only)
function isLocalDev() { return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname); }
// The Cloudflare STAGING site counts as a dev host for the researcher-panel ENTRY only
// (?mode=researcher runs the panel on the staging engine instead of redirecting to the
// production app). Worker base + Turnstile keys deliberately do NOT follow this: staging
// talks to the PRODUCTION worker with the real widget (its origin is CORS-allowlisted).
function isStagingHost() { return /\.(pages|workers)\.dev$/.test(location.hostname); }
/* The STAGING worker (v333, Seth: "we need a dev worker that we can test before we push it to
 * production, to make sure if we break it it doesn't break existing users any more than they
 * already are").
 *
 * ⚠ OPT-IN PER DEVICE — `?devworker=staging` — NOT automatic on the staging origins.
 *
 * Automatic routing was the obvious design and it is wrong twice over. First, isStagingHost() is
 * true for the PRODUCTION Cloudflare apps as well (they are *.workers.dev too), so anything built
 * on it risks pointing real users at a test backend. Second, and decisively: the staging worker
 * binds NO production D1, so the researcher account and enrolled devices simply are not there.
 * Flipping staging over wholesale would leave the staging panel unable to log in — making the test
 * surface WORSE while claiming to make it safer.
 *
 * So it rides the existing settings.relayWorker override, which already wins over every other
 * source and is already persisted and already tested. `?devworker=prod` puts the device back.
 *
 * The staging worker is a separate deployment with its own cache, its own (empty) D1 and no R2
 * binding — see the [env.staging] block in worker/wrangler.toml for why none of those are
 * inherited, and why that is the point. */
const STAGING_WORKER = 'https://flextext-r2-worker-staging.68mh29kgsd.workers.dev';
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

/* One-time cleanup of two DEAD keys.
 *
 * ⚠ THIS FUNCTION USED TO DESTROY DATA, and the bug arrived by a change somewhere else entirely.
 * It moved `sendOptions` into `linkSendOptions` and deleted it, because in that design the
 * checkboxes were a "link template" and a device could only be restricted by a limit it RECEIVED
 * through a link. v289 made sendOptions a real, user-editable device setting again (the Settings
 * tab) — and this migration, untouched and still running on every load until the key existed, threw
 * the user's choice away on the very next reload. Nothing errored; the setting simply came back
 * different. Found by reloading the page in a browser test, not by reading either piece of code:
 * each was self-consistent, and the incompatibility lived only in the pair.
 *
 * `linkSendOptions` / `linkButtons` were never READ by anything, in any app, ever — a template with
 * no consumer. So they are deleted rather than migrated back: reinstating them as a device
 * restriction would newly restrict devices whose owners never asked for one, and the old migration
 * had already cleared the self-restriction they came from. Absent means "all four allowed", which
 * is the safe direction.
 *
 * ⚠ Do not reintroduce either key without a reader, and never write a migration that moves a key
 * the UI can also write. */
function migrateSettings() {
  const s = loadSettings();
  if (s.linkSendOptions === undefined && s.linkButtons === undefined) return;
  delete s.linkSendOptions;
  delete s.linkButtons;
  saveSettings(s);
}

// Apply settings arriving via shared setup URL (?vern=fau&vernName=Fayu...&lang=id),
// and consume task parameters (?title=...&audio=...). Returns
// { gotSettings, task: {title, audioUrl} | null }.
function applyUrlSettings() {
  const p = new URLSearchParams(location.search);
  if (p.has('lang')) setLang(p.get('lang'));
  if (p.get('research') === 'off') localStorage.setItem(RESEARCH_HIDDEN_KEY, '1');
  if (p.get('research') === 'on') localStorage.removeItem(RESEARCH_HIDDEN_KEY);
  /* ?devworker=staging|prod (v333) — point THIS device at the staging backend, or back at
   * production. Deliberately a manual per-device flip and not tied to the origin: see
   * STAGING_WORKER above. Applied before anything reads workerBase(), and persisted, so a reload
   * or an installed PWA keeps it until it is explicitly turned off. */
  const dw = p.get('devworker');
  if (dw) {
    const s = loadSettings();
    if (dw === 'staging') s.relayWorker = STAGING_WORKER;
    else if (dw === 'prod' || dw === 'off') delete s.relayWorker;
    saveSettings(s);
    settings = s;
    console.log('[flextext] backend:', s.relayWorker || DEFAULT_WORKER);
    try { toast('Backend: ' + (s.relayWorker || DEFAULT_WORKER), 6000); } catch { /* pre-DOM */ }
  }
  const gotSettings = p.has('vern') || p.has('anal') || p.has('welcome') || p.has('btns') || p.has('editorRec') || p.has('autoDel') || p.has('recFormat') || p.has('dsp') || p.has('agc') || p.has('segmentation');
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
        .filter(o => ['share', 'upload', 'save', 'download'].includes(o))
        // A link minted before v297 may still say `download`; it means `save`.
        .map(o => (o === 'download' ? 'save' : o));
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
    // Audio Segmentation Mode (researcher opt-in, default OFF). Persisted like every other
    // pushed setting; segmentationEnabled() also honours a live ?segmentation=1 for dev links.
    if (p.has('segmentation')) s.segmentation = ['1', 'on'].includes(p.get('segmentation'));
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
    // `gauth(_error)?=`: the worker now also returns #gauth_error=drive_required when Google
    // sign-in succeeded but Drive access was declined. Same rule — the panel reads it later, so
    // stripping it here would swallow the only explanation the researcher is going to get.
    const keepHash = /[#&]gauth(_error)?=/.test(location.hash || '') ? location.hash : '';
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

const VIEWS = ['texts', 'cut', 'baseline', 'gloss', 'research', 'utilities', 'help', 'record', 'researcher', 'consent', 'segmenter', 'matcher'];

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
/* Build every language <select> from i18n's LANGS — the list of languages whose dictionary is
 * COMPLETE. Hard-coded <option>s are how a half-translated language reaches a user; deriving them
 * means a language appears the moment its last string lands and not one commit sooner. */
function fillLangPickers() {
  for (const sel of $$('#lang-select')) {
    sel.innerHTML = LANGS.map((l) => `<option value="${esc(l)}">${esc(LANG_NAMES[l] || l)}</option>`).join('');
    sel.value = getLang();
  }
}

function show(view) {
  /* ⚠ The single chokepoint for LEAVING the Settings tab, and therefore where a half-typed field is
   * committed. Every route out goes through here — the top tabs, opening a text, the help screen —
   * so guarding this one place beats patching each caller and missing one. */
  if (view !== 'research' && flushLiveSave) flushLiveSave();
  for (const v of VIEWS) { const el = $('#view-' + v); if (el) el.hidden = v !== view; }
  const inEditor = view === 'cut' || view === 'baseline' || view === 'gloss' ||
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
  if (!RECORD_MODE) applyDeleteAllButton(); applyInviteButton(); applyAdminDrawer();   // ensure the gated Delete-All button is present + current
  show('help');
}

function closeHelp() {
  if (helpReturnView === 'gloss' || helpReturnView === 'baseline') {
    if (current) { switchTab(helpReturnView); return; }
    helpReturnView = 'texts';
  }
  if (helpReturnView === 'research') { renderDeviceSetup(); show('research'); }
  else { renderDocList(); show('texts'); }
}

/* ---------------- Document library ---------------- */

async function renderDocList() {
  const docs = await db.listDocs();
  /* Researcher-pushed OPTION (issue #11), default off: alphabetical order for coworkers with long
   * text lists. numeric:true so "Text 2" sorts before "Text 10"; base sensitivity so case and
   * accents do not scatter entries. Default (absent/false) keeps most-recently-modified first. */
  if (settings.sortAlpha === true) {
    docs.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true, sensitivity: 'base' }));
  }
  const ul = $('#doc-list');
  ul.innerHTML = '';
  $('#doc-list-empty').hidden = docs.length > 0;
  const upDel = new Set(pendingUpDel());   // deletes triggered (coworker or researcher) but not yet confirmed
  for (const d of docs) {
    const li = document.createElement('li');
    if (upDel.has(d.id)) li.classList.add('doc-pending-del');   // strikethrough + faded until the removal lands
    const date = d.modified ? new Date(d.modified).toLocaleString() : '';
    li.innerHTML = `
      <button class="doc-open">
        <span class="doc-name"></span>
        <span class="doc-meta"></span>
      </button>
      <button class="doc-done icon-btn"></button>
      <button class="doc-delete icon-btn"></button>`;
    li.querySelector('.doc-name').textContent = (d.done ? '\u2713 ' : '') + (d.title || t('untitled'));
    /* A text whose transcription is still downloading shows THAT instead of "0 sentences", and
     * its row still opens -- openDoc retries the fetch and only enters the editor once the text is
     * really here (v332). Showing 0 sentences for an in-flight text is what made an empty
     * placeholder look like a finished import. */
    const meta = li.querySelector('.doc-meta');
    if (d.pendingFlextext) {
      meta.textContent = t('texts.arriving');
      li.classList.add('doc-arriving');
    } else if (d.pendingAudio) {
      // Assigned AUDIO still arriving (assign-by-upload): a real progress bar off the downloader's
      // own received/total (Range-resume state), painted by the arrival ticker while active.
      li.classList.add('doc-arriving');
      li.dataset.arriving = d.id;
      meta.innerHTML = `<span></span> <span class="doc-dl-bar"><span class="doc-dl-fill"></span></span><span class="doc-dl-pct"></span>`;
      meta.querySelector('span').textContent = t('texts.arriving');
      paintArrivalRow(li, d.id);
    } else {
      meta.textContent = t('texts.meta', { n: d.segCount ?? 0, g: d.glossed ?? 0, date });
    }
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
      del.addEventListener('click', () => { userDeleteDoc(d.id, d.title); });
    } else del.remove();
    ul.appendChild(li);
  }
  syncArrivalTicker();
  renderWsBanner();
}

/* Arrival progress (assign-by-upload): the downloader keeps exact received/total for its
 * Range-resume, so the tile can show REAL byte progress. One light ticker, alive ONLY while a
 * download is actually moving — an idle list costs nothing. The rows repaint in place (no
 * re-render: renderDocList rebuilds listeners and would churn once a second). */
let arrivalTicker = null;
function paintArrivalRow(li, docId) {
  const dl = getDownload(docId);
  const fill = li.querySelector('.doc-dl-fill');
  const pct = li.querySelector('.doc-dl-pct');
  if (!fill) return false;
  const total = (dl && dl.total) || 0;
  if (total) {
    const p = Math.min(100, Math.round(((dl.received || 0) / total) * 100));
    fill.style.width = p + '%';
    if (pct) pct.textContent = p + '%';
  } else {
    fill.style.width = '0%';
    if (pct) pct.textContent = '';
  }
  return !!dl && dl.status === 'downloading';
}
function syncArrivalTicker() {
  const rows = $$('#doc-list li[data-arriving]');
  const active = rows.filter((li) => paintArrivalRow(li, li.dataset.arriving)).length > 0;
  if (active && !arrivalTicker) arrivalTicker = setInterval(syncArrivalTicker, 1000);
  if (!active && arrivalTicker) { clearInterval(arrivalTicker); arrivalTicker = null; }
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
  let rec = await db.getDoc(id);
  if (!rec) { toast(t('toast.cantOpen')); return; }
  /* ⚠ DO NOT OPEN A TEXT WHOSE CONTENT IS STILL IN FLIGHT (Seth, v332).
   *
   * Opening the placeholder let the coworker start typing into an empty baseline while its real
   * transcription was still downloading — and then tryDownloadFlextext's own "never clobber work"
   * guard sees a non-empty doc and DISCARDS the arriving text, permanently. The user cannot know
   * that; they just typed into what looked like their text.
   *
   * So: fetch FIRST, open second. The flextext is a few KB and lands almost instantly, which is
   * also why it is fetched BEFORE the audio (Seth) — audio is the slow half, and waiting for it
   * would block the editor for minutes. Audio keeps streaming in behind the open editor exactly as
   * before; only the TEXT gates the door. A failure leaves the text unopened with the reason
   * shown, rather than opening an empty editor that quietly eats the assignment. */
  if (rec.pendingFlextext) {
    toast(t('task.ftRetrying'), 4000);
    let got = false;
    try { got = await tryDownloadFlextext(rec); } catch { /* reported below */ }
    if (!got) { toast(t('task.ftStillPending'), 9000); renderDocList(); return; }
    rec = (await db.getDoc(id)) || rec;   // re-read: the download rewrote the record
  }
  current = rec;
  resetUndo();
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

/* Import a .flextext AND its recording in ONE step (Seth, v330).
 *
 * ⚠ WHY THIS EXISTS: on a PAIRED device the researcher assigns the pair together, so text and audio
 * arrive attached. An UNPAIRED editor had no equivalent — "Open .flextext file" made a text with no
 * audio and "New text from audio" made audio with no text, and nothing could marry them afterwards.
 * That left the whole segmentation workflow unreachable to a standalone user with a recording and a
 * transcription in hand.
 *
 * Order matters and is deliberate: the TEXT is imported first (so a bad flextext fails before any
 * audio is stored), then the audio is attached to that same record via the existing attachAudioFile
 * path — the same one the researcher-assigned flow ends in, so conversion, peaks, and the
 * segmentation seed all behave identically to an assigned text. */
async function newDocFromPair(files) {
  const list = [...files];
  const isText = (f) => /\.(flextext|xml|txt)$/i.test(f.name) || /(xml|text)/i.test(f.type || '');
  const textFile = list.find(isText);
  const audioFile = list.find((f) => !isText(f));
  if (!textFile || !audioFile) { toast(t('toast.pairNeedsBoth'), 7000); return; }
  /* ⚠ Attach ONLY to a text this call actually opened. importFile leaves `current` untouched when
   * the file holds SEVERAL texts (it lists them instead) or fails to parse — so a bare `if
   * (current)` would happily staple the recording onto whatever doc happened to be open last. */
  const before = current && current.id;
  await importFile(textFile);
  if (!current || (current.id === before)) return;   // nothing new opened: importFile already said why
  await attachAudioFile(audioFile);
  toast(t('toast.pairOpened', { text: textFile.name, audio: audioFile.name }), 6000);
}

async function importFile(file) {
  const text = await file.text();
  // Multi-WS imports: edit the lines matching THIS device's writing systems;
  // all other languages' lines round-trip untouched (flextext.js pickByLang).
  const { texts, error } = parseFlextext(text, { vernLang: settings.vernLang, analLang: settings.analLang });
  if (error) { toast(t('toast.importFailed', { msg: error }), 6000); return; }
  let lastId = null;
  for (const doc of texts) {
    // One phrase per paragraph BEFORE it is stored — see normalizePhraseLines.
    normalizePhraseLines(doc);
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
/* ⚠ THE IN-EDITOR "Mark done" BUTTON IS GONE (Seth, v330): it duplicated "Done — send…", which
 * already marks the text finished as part of sending — two buttons, one meaning, side by side in a
 * topbar that had just gained undo/redo. Un-marking is unaffected: the Texts-list row toggle still
 * does it (setDocDone works on any text, open or not), which is also where a finished text is
 * actually reviewed. Kept as a no-op so every caller stays honest about intent without a null dance. */
function applyDoneButton() { /* no in-editor done button; the Texts-list row toggle owns this */ }
// Mark ANY text finished/unfinished — driven by the texts-list row toggle AND the
// in-editor button. Works whether or not the text is the one currently open. Marking
// done reports to the panel and auto-uploads (unless that exact content is already on
// Drive); with auto-delete on it confirms first (that combo removes the text after upload).
async function setDocDone(docId, wantDone) {
  const isOpen = current && current.id === docId;
  if (wantDone && deleteAfterUpload() && !await confirmDialog(t('done.confirmDelete'))) return;
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
    const onDrive = rec.uploadedSig && rec.uploadedSig === uploadContentSig(rec);
    if (!onDrive) {
      // Content changed since the last send (or never sent) → one final upload. If the
      // researcher has auto-delete on, the upload-done hook removes it once confirmed.
      await uploadDocById(rec.id);
    } else if (deleteAfterUpload()) {
      // Already safely on Drive, nothing to send → honour auto-delete by removing now.
      if (await deleteConfirmedDoc(rec.id)) toast(t('sync.removedAfterUpload'), 6000);
    }
  } else {
    toast(t('done.unmarked'), 4000);
  }
  Sync.reportNow();
  renderDocList();
}
// Kept though the in-editor button is gone (v330): setDocDone is the shared mechanism and this is
// its "the open text" convenience. The Texts-list row toggle and the Done—send path both route
// through setDocDone directly; this stays for the researcher-panel/command surfaces that ask for
// the OPEN doc without knowing its id.
async function toggleDone() {
  if (current) await setDocDone(current.id, !current.done);
}

function enterEditor(tab) {
  applyDoneButton();
  $('#doc-title').value = current.title || '';
  updateShareButton();
  applyCutTabVisibility();
  switchTab(landingTab(tab), /* landing */ true);
}

/* Is this doc still UNCUT — i.e. has nobody done segmentation work on it yet? True for the seeds
 * reconcile() lays down: a single whole-file span, or spans that are all pending/estimated.
 *
 * ⚠ THE GUESS-SPLITS GATE. Guessing boundaries on a text somebody has already cut by hand would
 * throw their work away, so the button only offers itself here (and asks first anywhere else).
 * It used to gate the landing tab as well, until that rule became "the last tab, else no words yet"
 * — see landingTab. */
function docIsUncut(doc) {
  const segs = (doc && doc.segments) || [];
  if (!segs.length) return true;
  if (segs.length === 1) return true;                       // the whole-file seed
  return segs.every((sg) => sg.timePending || sg.timeEstimated);
}

/* Does this text have any words in it yet? The landing rule turns on this rather than on the
 * segmentation state: a text with words is a text somebody is transcribing, and transcribing
 * happens on Baseline. */
function docHasNoText(doc) {
  return !getBaselineParagraphs(doc).some((p) => String(p || '').trim());
}

/* WHICH TAB A TEXT OPENS ON (Seth, 2026-08-13):
 *
 *   (1) the last tab the user had open in THIS text — remembered per text, so coming back to a
 *       half-glossed text puts you where you left off rather than at the start of the workflow;
 *   (2) failing that, and only when there are no words yet: the Cut tab if it is enabled, Baseline
 *       if it is not.
 *
 * ⚠ (1) BEATS (2), which is the whole point of it: a fresh recording lands on Cut, but the moment
 * the user has chosen a tab for that text, their choice is what the text opens on. Without the
 * memory, a text with no words yet — every text at the start of the job — would drag them back to
 * Cut every single time they opened it, however many times they had left for Baseline.
 *
 * ⚠ A REMEMBERED TAB IS STILL SUBJECT TO THE GATES. The researcher can turn the Cut tab off after a
 * device has already used it, and remembering it would then open a tab that is not there.
 *
 * Only ever OVERRIDES the default request, never an explicit one, so every caller that asks for a
 * specific tab still gets it. */
function landingTab(tab) {
  if (tab !== 'baseline') return tab;                       // an explicit request wins
  if (!current || !current.doc) return tab;
  const last = current.lastTab;
  /* ⚠ A remembered tab is still subject to the gates AND to reality: the researcher can switch the
   * Cut tab off after a device has used it, and a text can lose its recording (or never have had one
   * — one curious tap on Cut is enough to remember it). Landing on the "this text has no recording"
   * screen every time would be a worse bug than the one the memory fixes. */
  const lastOk = last && isEditorTab(last)
    && !(last === 'cut' && (!cutTabEnabled() || !docSegments(current.doc).some(isAligned)));
  if (lastOk) return last;
  if (!landOnCutEnabled()) return tab;
  if (!docHasNoText(current.doc)) return tab;               // words already ⇒ this is transcription
  /* ⚠ ONLY WITH AUDIO — landing a text-only doc on a cutting screen would be nonsense. An ALIGNED
   * span proves decoded audio: reconcile() seeds the whole-file span once the recording has decoded
   * and its duration is known. But a NEW recording — the exact case this setting names — has audio
   * the reconcile has NOT measured yet: still downloading (assignment) or still decoding (fresh
   * capture). Requiring alignment alone meant the setting never fired on the FIRST open, the only
   * open that matters for a new recording (issue #9). So the record's own synchronous fields count
   * too: audioSource (attached/downloaded) or pendingAudio still en route — but not a pendingAudio
   * whose download already FAILED, which has no timeline coming. Landing on Cut mid-arrival shows
   * Cut's own loading screen, resolved by finalizeAudioDownload's re-enter when the bytes land.
   * All three checks are record fields — the decision stays SYNCHRONOUS (a media lookup would
   * flash the Baseline tab before switching). */
  const audioHere = docSegments(current.doc).some(isAligned)
    || !!current.audioSource
    || !!(current.pendingAudio && !current.audioError);
  if (!audioHere) return tab;
  return 'cut';
}

/* Remember the tab per TEXT, on the record rather than on `doc` — `doc` is the flextext model and
 * everything in it is serialised into the exported file, where a UI preference has no business.
 * Written on every editor-tab switch and saved with the ordinary debounce, so it survives a reload
 * and rides along with the record like `done` and `title` do. */
function rememberTab(tab) {
  if (!current || !isEditorTab(tab) || current.lastTab === tab) return;
  current.lastTab = tab;
  /* ⚠ NOT schedulePersist(): that goes through persist(), which stamps `modified = Date.now()`.
   * Looking at a tab is not editing the text, and stamping it would be expensive in exactly the
   * places that matter — a text already safely on Drive would report as changed, so the next Save
   * would upload a duplicate copy over a village connection, and the researcher's "unchanged since
   * upload" checks would stop agreeing with reality. Write the record as it is, quietly. */
  const rec = current;
  db.putDoc(rec).catch(() => { /* the memory is a convenience; never surface a toast for it */ });
}

/* The Cut tab's hint must never promise a key the researcher has switched off.
 *
 * ⚠ Swapping the KEY on the element (not just its text) is what keeps a later language change
 * correct — applyI18n reads data-i18n-html, so it re-renders whichever variant is current.
 *
 * ⚠ AND IT IS CALLED FROM THE LIVE-SETTINGS PATH TOO, not only on tab entry: a researcher push
 * lands mid-session (that is the whole point of pushed settings), and a user sitting on the Cut tab
 * would otherwise keep reading "press Backspace to join" for as long as they stayed there, after
 * Backspace had stopped joining. Same class as applyCutTabVisibility below. */
/* The Baseline tab's hint depends on the MODE, because its Enter does. Classic textarea: "a new
 * paragraph". Segmentation strips: a line break AND a boundary in the recording, by two routes (see
 * the keydown handler and segment-strips' onKey). Applied on every entry, so a live researcher push
 * that flips segmentation swaps the sentence without a reload. */
function applyBaselineHint() {
  const hint = document.querySelector('#view-baseline .tab-hint [data-i18n-html]');
  if (!hint) return;
  hint.dataset.i18nHtml = segmentationEnabled() ? 'baseline.hintSeg' : 'baseline.hint';
  hint.innerHTML = t(hint.dataset.i18nHtml);
}

function applyCutHint() {
  const hint = $('#view-cut .tab-hint');
  if (!hint) return;
  hint.dataset.i18nHtml = joinKeysEnabled() ? 'cut.hint' : 'cut.hintNoJoinKey';
  hint.innerHTML = t(hint.dataset.i18nHtml);
}

/* Show or hide the Cut tab button. Called on entry and whenever settings change live, so a
 * researcher push adds or removes the tab without a reload. */
function applyCutTabVisibility() {
  const btn = $('#tab-cut');
  if (btn) btn.hidden = !cutTabEnabled();
}

// Segmentation mode: researcher-pushed setting, with a URL escape (?segmentation=1) so the
// staging site can be test-driven before the panel toggle ships. Default OFF — the plain
// textarea workflow every field user knows is untouched unless this is explicitly on.
/* ⚠ UNSET MEANS ON (Seth, 2026-08-12). Segmentation is the workflow this suite is FOR, so a fresh
 * install and a device whose researcher never touched the setting both get it; only an explicit
 * `false` — a researcher deliberately unchecking the box — turns it off. It used to be
 * `=== true`, i.e. unset meant OFF, which is why a brand-new device opened its first assigned text
 * in the basic editor until the panel pushed a value.
 *
 * The distinction that matters: `false` and `undefined` must NOT be treated alike, or a researcher
 * who turned it off would have it come back on. Never "simplify" this to a truthiness check. */
/* MAY BACKSPACE/DELETE JOIN TWO LINES? (Seth, 2026-08-13)
 *
 * "I'd like to have a researcher panel setting per device (disabled by default) to enable/disable
 *  backspace to join. Our join buttons are reliable enough now that we don't need it, and some users
 *  are finding it too easy to accidentally join lines and then they don't want to split them again."
 *
 * ⚠ DEFAULT OFF, and that is a deliberate behaviour CHANGE for every existing device: the keys work
 * today and stop working on update unless the researcher turns them back on. That is the point —
 * the accident it prevents (a silent join the transcriber then has to find and undo) costs more
 * than the shortcut it removes, now that the ⧉ join buttons are reliable. Hence `=== true`, not
 * `!== false`: absent means OFF here, the opposite of `segmentation`.
 *
 * ⚠ IT GATES THE DELETE KEY TOO, not just Backspace. Delete-at-end-of-line is the same gesture from
 * the other side and produces the identical accidental join; leaving it live would mean the setting
 * removed the accident by one key and kept it by another — the "rule enforced in one place the other
 * path reaches around" drift the backlog warns about. */
function joinKeysEnabled() {
  return settings.backspaceJoin === true;
}

/* THE CUT-TAB FAMILY OF GATES (Seth, 2026-08-13). All default ON — `!== false`, the same polarity
 * as `segmentation` and the OPPOSITE of `backspaceJoin`. The difference is deliberate and worth
 * stating once: backspaceJoin REMOVES a shortcut people were relying on, so absent must mean off;
 * these five ADD or PRESERVE capability, so absent must mean on. Getting either backwards silently
 * changes what a field device does the morning after an update.
 *
 * ⚠ Every one of them is also gated on segmentationEnabled(), because none of them means anything
 * in the classic textarea workflow. A researcher who turns segmentation off should not find five
 * orphaned controls still acting on a UI that no longer exists. */
function cutTabEnabled() { return segmentationEnabled() && settings.cutTab !== false; }
function landOnCutEnabled() { return cutTabEnabled() && settings.landOnCut !== false; }
function joinSplitAllowed(tab) {
  if (!segmentationEnabled()) return true;   // classic mode has its own rules; this is not its gate
  return tab === 'gloss' ? settings.joinSplitGloss !== false : settings.joinSplitBaseline !== false;
}
/* May the CUT tab join two spans that already carry baseline text?
 *
 * ⚠ DEFAULT OFF — `=== true`, unlike its four siblings. Seth, 2026-08-13: "I would like to be able
 * to split and join ANY lines that don't have text. Any segments that don't have text, just not
 * those that do have text." So on the Cut tab a segment carrying text is LOCKED for both gestures,
 * and this setting is the researcher's deliberate opt-in to relax the join half (which is safe in
 * itself — joining only concatenates). Splitting a texted segment is refused regardless: there is
 * no cursor on this tab, so there is no defined place to divide the text. */
function cutJoinTextedAllowed() { return settings.cutJoinTexted === true; }

/* ⚠ WHERE THE TRANSPORT KEYS APPLY — and, just as importantly, where they must NOT.
 *
 * Space (every editor tab) and Enter/Backspace (the Cut tab) are claimed at DOCUMENT level, because
 * the gesture must work whether or not the user has clicked anything since arriving. The cost of
 * that reach is that the same keystroke would be taken from controls that legitimately own it, so
 * this is the one place that decides it, for every one of those keys at once:
 *
 *  - A MODAL IS OPEN ⇒ the keys are the modal's, full stop. Send/consent/record/help dialogs sit
 *    OVER the editor with `activeTab` unchanged, so without this a Space on the share menu's Upload
 *    button would start the recording playing behind the dialog instead of pressing the button, and
 *    Enter would cut the audio. Both static (`.modal[hidden]`) and panel-built modals carry
 *    `class="modal"`, so one selector covers every one of them.
 *  - A CONTROL OUTSIDE THE EDITOR'S SURFACE ⇒ its own key. Save, Done—send, ⟵ Back and Undo live in
 *    the topbar and must keep Enter and Space. The surface is the three editor views plus the dock
 *    player (which is their shared overview, not a separate thing).
 *  - …EXCEPT A TAB BUTTON, which is the whole reason this exists. ⚠ FOCUS STAYS ON THE TAB BUTTON
 *    YOU CLICKED TO GET HERE, so Space was being spent re-activating it: switchTab re-rendered the
 *    list and nothing played, over and over (Seth: "spacebar to play/pause is jammed … the page
 *    glitches/appears to re-render and nothing plays … until I click the big player"). Clicking the
 *    big player cured it only because that moved focus off the button. Re-opening the tab you are
 *    already on is worth nothing; playing the audio is the point of the key.
 *  - A TEXT FIELD ⇒ typing wins, always (`.seg-text`, `#doc-title`: a transcriber typing a space
 *    must get a space). A <select> keeps every transport key EXCEPT Space (Seth, 2026-08-17:
 *    "Space to play should override space to activate a UI control everywhere in the editor" — the
 *    live case is the dock's speed picker: after changing the speed, Space must PLAY, not pop the
 *    dropdown open, because a native speaker cannot be expected to know they must click the player
 *    first). Arrow keys still change the speed from the keyboard; only Space is claimed. Enter and
 *    Backspace still stand down on a select, so the Cut tab's keys can never cut or join off a
 *    focused picker. A RANGE slider keeps nothing: the dock's zoom is the one control a cutter
 *    fiddles with constantly, Space means nothing to it natively, and focus left sitting there was
 *    another way for "spacebar doesn't work" to be true.
 *
 * ⚠ The caller MUST preventDefault when this returns true — that is what stops the focused button
 * from ALSO firing. It is also what makes Space safe on ✂ and ⤙⤚: a native re-click there would cut
 * or join again with no gesture from the user. And on the speed picker it is what keeps the
 * dropdown closed while the audio toggles. */
const EDITOR_SURFACE = '#view-cut, #view-baseline, #view-gloss, #audio-player';
function transportKeysApply(target, key) {
  if (document.querySelector('.modal:not([hidden])')) return false;
  const el = target && target.closest ? target : null;
  if (!el) return true;
  const typing = key === ' '
    ? 'textarea, [contenteditable], input:not([type="range"])'
    : 'textarea, select, [contenteditable], input:not([type="range"])';
  if (el.closest(typing)) return false;
  /* select is in the CONTROL list, so for Space it follows the same rule as a button: claimed
   * inside the editor surface, left alone anywhere else (a settings-form picker keeps its keys). */
  const ctl = el.closest('button, a[href], input, select, [tabindex]');
  if (!ctl) return true;
  if (ctl.classList && ctl.classList.contains('top-tab')) return true;   // the tab that got you here
  return !!ctl.closest(EDITOR_SURFACE);
}

function segmentationEnabled() {
  // The Audio Segmenter IS segmentation mode — there is nothing else for it to be, and a researcher
  // setting that switched it off would leave an app whose every screen is about cutting audio
  // quietly refusing to cut audio.
  if (SEGMENTER_MODE) return true;
  try {
    if (new URLSearchParams(location.search).get('segmentation') === '1') return true;
  } catch { /* noop */ }
  return settings.segmentation !== false;
}

// The tabs that share the media dock (the ONE Player instance).
function isEditorTab(tab) { return tab === 'cut' || tab === 'baseline' || tab === 'gloss'; }

/* Gloss tab, segmentation mode: give every line-group the SAME transport as its baseline strip —
 * left-margin ▶/⏸ (pause-in-place, resume-from-playhead) and a skinny per-line waveform. In flat
 * segmentation mode phrase i IS segment i, so decoration is positional. Rendering-only: all edits
 * still happen through the model. */
/* Heal a legacy flat doc IN PLACE: paragraphs written before the flat-mode guarantee (v153) may
 * carry ZERO segments for empty lines, which skewed the gloss tab's per-segment pairing. Viewing
 * never corrupted data — this simply adds the empty segment each empty line was always supposed to
 * have, so an UNEDITED legacy doc aligns on open instead of waiting for its first edit to trigger
 * reconcileBaseline. Idempotent; persists only when something actually changed. */
function healFlatSegments(doc) {
  if (!segmentationEnabled()) return;
  // Everything this used to do inline is now the pure function below; only the persist is left,
  // because only THIS caller knows the doc it healed is the open one.
  if (normalizePhraseLines(doc)) schedulePersist();
}

/* ⚠ THE SAME REPAIR, AS A PURE FUNCTION ON ANY DOC — no `current`, no persist, no settings gate.
 *
 * It was reachable only from three switchTab paths in the editor, so a doc was carried in its
 * imported shape from the moment it entered the library until somebody happened to open it on a
 * tab that healed it. Everything reading it in between saw N phrases inside one paragraph while
 * doc.segments indexed paragraphs — which is how the Audio Segmenter came to show a 60-phrase text
 * as a single line (Seth: "this tool (and the rest of our suite) needs to be able to handle phrase
 * breaks as if they were paragraph breaks in the way it renders/draws in the app", and "that
 * particular issue is probably an engine-wide issue").
 *
 * Calling it where a foreign .flextext BECOMES a stored doc makes the canonical shape an entry
 * condition instead of something each screen must remember to establish. The switchTab calls stay
 * as belt-and-braces for docs that were stored before this.
 *
 * Returns whether anything changed, so the caller can decide about persisting. */
function normalizePhraseLines(doc) {
  if (!doc || !doc.paragraphs) return false;
  let changed = false;
  /* ⚠ FLATTEN MULTI-PHRASE PARAGRAPHS — one phrase per paragraph, each phrase KEEPING its own
   * offsets (v322; the "gloss join collapsed ALL segments on the first line" field bug).
   *
   * Segmentation mode's whole invariant is line == paragraph == phrase == span, 1:1:1:1 — but an
   * IMPORTED doc can arrive with N phrases in one paragraph (FLEx, or an ELAN round trip). The
   * gloss tab renders one group per PHRASE while getBaselineParagraphs/doc.segments index per
   * PARAGRAPH, so every index-driven edit on such a doc addressed the WRONG line — and the first
   * write's { flatSegments: true } then collapsed each paragraph's phrases into ONE line,
   * destroying per-phrase alignment wholesale (that was the observed "join button joins ALL
   * audio segments" — reconcileBaseline got one collapsed string per paragraph).
   *
   * Promoting each phrase to its own paragraph BEFORE any edit preserves every phrase as its own
   * line with its own imported offsets. The paragraph keeps its guid on its FIRST phrase's new
   * paragraph; the rest mint fresh (FLEx honours guids — a split paragraph is genuinely new
   * containment, same rule as line identity). Text, words, glosses, free translations are the
   * same objects, untouched. */
  /* ⚠ DID THE AUTHOR ACTUALLY DISTINGUISH PHRASES FROM PARAGRAPHS? Two shapes say no:
   *
   *   • ONE paragraph holding every phrase  — the break carries no extra meaning; the file simply
   *     never used paragraphs. (Seth's older Excel-template editor exports this way.)
   *   • MANY paragraphs of one phrase each  — already 1:1; there is nothing to remember.
   *
   * Anything else is a MIXTURE, and a mixture is a decision: Seth's recent FLEx texts use "phrase
   * breaks for clauses, paragraph breaks for sentences". Only then is the grouping worth carrying,
   * and only then does `paraOf` get set — so for every other document the export is bit-identical
   * to what it has always been, which is what makes this safe to add.
   *
   * The flattening itself happens either way and is NOT entropy: it is what lets a paragraph-indexed
   * alignment attach per phrase (phraseRows refuses segs[i] for a multi-phrase paragraph), and a
   * maximally-split export is deliberate so an ELAN annotator only ever MERGES — ELAN cannot split
   * at higher levels. See plans/preserve-paragraph-structure.md. */
  const multi = doc.paragraphs.filter((p) => (p.segments || []).length > 1).length;
  const structured = doc.paragraphs.length > 1 && multi > 0;
  if (multi > 0) {
    doc.paragraphs = doc.paragraphs.flatMap((p) => ((p.segments || []).length > 1
      ? p.segments.map((s, k) => ({
          guid: k === 0 ? p.guid : newGuid(), segments: [s],
          ...(structured ? { paraOf: p.guid } : {}),
        }))
      : [structured ? { ...p, paraOf: p.guid } : p]));
    doc.segments = [];   // paragraph-indexed envelopes are now wrong; re-derive per phrase below
    changed = true;
  }
  for (const p of doc.paragraphs) {
    if (p.segments && !p.segments.length) { p.segments.push(makeSegment('', [])); changed = true; }
  }
  // flextext is the segmentation format (Seth, 2026-08-03): a doc imported with phrase
  // begin/end-time-offset attributes (from us, ELAN, or SayMore) recovers its alignment here —
  // no proprietary sidecar. Only when the doc has no spans of its own; touches doc.segments
  // ONLY, so glosses/free translations cannot be affected by construction.
  if (!doc.segments || !doc.segments.length) {
    const derived = segmentsFromOffsets(doc);
    if (derived) { doc.segments = derived; changed = true; }
  }
  return changed;
}

function decorateGlossSegments() {
  if (!segmentationEnabled() || !current) return;
  const segs = docSegments(current.doc);
  const groups = $('#gloss-body') ? $('#gloss-body').querySelectorAll('.segment') : [];
  const entries = [];
  groups.forEach((g, i) => {
    const seg = segs[i];
    if (!seg || g.querySelector('.gseg-bar')) return;
    const bar = document.createElement('div');
    bar.className = 'gseg-bar';
    const btn = document.createElement('button');
    btn.className = 'gseg-play';
    /* ⚠ NOT IN THE TAB ORDER — see the Baseline ▶. Seth: "we don't want play and join and split
     * controls to be part of the tab (keyboard) order. Just next and previous textbox in order." */
    btn.tabIndex = -1;
    btn.textContent = seg.timePending ? '⋯' : '▶';
    btn.setAttribute('aria-label', t(seg.timePending ? 'seg.pendingTip' : 'seg.playTip'));
    const waveWrap = document.createElement('div');
    waveWrap.className = 'gseg-wavewrap';
    const wave = document.createElement('canvas');
    wave.className = 'gseg-wave';
    waveWrap.appendChild(wave);
    bar.append(btn, waveWrap);
    g.prepend(bar);
    wireSegPlay(btn, seg, () => player, (t2) => { lastPlayTarget = t2; });
    drawSpanWave(wave, seg);
    /* Interactive, same as the baseline strips: click to PARK the playhead (which pauses), drag to
     * scrub. ⚠ THE SHARED wireWaveSeek, not a third copy of it — this tab had its own, which is why
     * "clicking a waveform pauses" had to be written in two places to reach both tabs. It also
     * carries the v326 touch-selects-for-Space behaviour, so that is no longer wired separately. */
    wireWaveSeek(wave, seg, () => player, (s) => { lastPlayTarget = s; });
    // v326: touching a waveform SELECTS it for Space/⏮ — including an unaligned one, which
    // wireWaveSeek deliberately leaves unwired (there is no time in it to seek to).
    if (!isAligned(seg)) wave.addEventListener('pointerdown', () => { lastPlayTarget = seg; });
    entries.push({ btn, seg, wave, wrap: waveWrap });
    /* ⤙⤚ JOIN — in its OWN ROW BETWEEN the two groups it joins (v322, Seth's bug list #5). It used
     * to be the group's last child, a 44px tap target 6px under the full-width free-translation
     * input — an undershot tap meant an accidental join. Outside both groups, a missed tap on the
     * free translation hits padding, not a destructive control. */
    if (i < groups.length - 1 && !(g.nextElementSibling && g.nextElementSibling.classList.contains('gseg-joinrow'))) {
      const joinRow = document.createElement('div');
      joinRow.className = 'gseg-joinrow';
      const join = document.createElement('button');
      join.className = 'gseg-join';
      join.tabIndex = -1;
      join.textContent = '⤙⤚';
      join.setAttribute('aria-label', t('seg.joinTip'));
      join.title = t('seg.joinTip');
      join.addEventListener('click', () => glossJoinLines(i));
      joinRow.appendChild(join);
      g.insertAdjacentElement('afterend', joinRow);
    }
    /* SCISSORS under each chain-link (Seth, v326): the chain joins two words into one lexical item
     * (FLEx-style); the scissors directly below it SPLITS THE LINE at that same word gap -- the
     * one-click version of Enter at that gloss boundary. Wrapped in a column so the pair reads as
     * "this gap: join words / split line". Word-gap index = word cells before the link. */
    g.querySelectorAll('.chain-btn').forEach((link) => {
      if (link.parentElement && link.parentElement.classList.contains('gap-ctl')) return;
      const rowEl = link.parentElement;
      const kids = [...rowEl.children];
      const before = kids.slice(0, kids.indexOf(link)).filter((el) => el.classList.contains('word-cell')).length;
      const wrapEl = document.createElement('span');
      wrapEl.className = 'gap-ctl';
      link.replaceWith(wrapEl);
      wrapEl.appendChild(link);
      const sc = document.createElement('button');
      sc.className = 'scissor-btn';
      sc.tabIndex = -1;
      sc.textContent = '\u2702';
      sc.setAttribute('aria-label', t('gloss.splitTip'));
      sc.title = t('gloss.splitTip');
      sc.addEventListener('click', () => glossSplitAt(i, before));
      wrapEl.appendChild(sc);
    });
    // ⚠ ENTER-SPLIT ON WORD-GLOSS FIELDS: caret at the START of a word's gloss box splits BEFORE
    // that word; at the END, AFTER it. Mid-text Enter does nothing (a stray key cannot split).
    // Word index = cell position: renderSegment appends one .word-cell per seg.words entry,
    // punctuation included, so DOM order IS model order.
    //
    // v322 (Seth's bug list #2/#3) — full BASELINE-TAB KEY PARITY, superseding the old
    // "Backspace never merges on the gloss tab" rule by Seth's explicit request:
    //   - Backspace at the VERY START of the FIRST gloss, or of the free translation, JOINS this
    //     line with the previous one — same key, same result as the baseline strips.
    //   - Enter at the start/end of the free translation splits like the first/last gloss does
    //     (an empty silence line before/after, time at the playhead — glossSplitAt boundary 0/N).
    //   - Both are BOUNDARY-ONLY: mid-text they type/navigate as before, so a stray key cannot
    //     split or join.
    const phrase = current.doc.paragraphs[i] && current.doc.paragraphs[i].segments[0];
    if (phrase) {
      const wordCount = () => (phrase.words || []).length;
      [...g.querySelectorAll('.word-cell')].forEach((cell, w) => {
        const gi = cell.querySelector('.gloss-input');
        if (!gi) return;   // punctuation cell
        gi.addEventListener('keydown', (e) => {
          const atStart = gi.selectionStart === 0 && gi.selectionEnd === 0;
          const atEnd = gi.selectionStart === gi.value.length && gi.selectionEnd === gi.value.length;
          if (e.key === 'Backspace' && atStart && w === 0 && i > 0) {
            if (!joinSplitAllowed('gloss')) return;   // researcher removed join/split on this tab
            if (!joinKeysEnabled()) return;   // researcher-disabled: fall through to normal editing
            e.preventDefault();
            glossJoinLines(i - 1);
            return;
          }
          if (e.key !== 'Enter') return;
          if (!atStart && !atEnd) return;
          if (!joinSplitAllowed('gloss')) return;
          e.preventDefault();
          glossSplitAt(i, atStart ? w : w + 1);
        });
      });
      const fi = g.querySelector('.free-input');
      if (fi) {
        fi.addEventListener('keydown', (e) => {
          const atStart = fi.selectionStart === 0 && fi.selectionEnd === 0;
          const atEnd = fi.selectionStart === fi.value.length && fi.selectionEnd === fi.value.length;
          if (e.key === 'Backspace' && atStart && i > 0 && joinSplitAllowed('gloss') && joinKeysEnabled()) {
            e.preventDefault();
            glossJoinLines(i - 1);
          } else if (e.key === 'Enter' && atStart && joinSplitAllowed('gloss')) {
            e.preventDefault();
            glossSplitAt(i, 0);                    // empty silence line BEFORE this one
          } else if (e.key === 'Enter' && atEnd && joinSplitAllowed('gloss')) {
            e.preventDefault();
            glossSplitAt(i, wordCount());          // empty silence line AFTER this one
          }
        });
      }
    }
  });
  startGlossCursor(entries);
}

/* The gloss playhead: a cursor over whichever mini wave contains the current time, plus live ▶/⏸
 * glyphs — one rAF loop, the gloss twin of the baseline strips' positionCursor. */
let glossRafId = 0;
let glossFollowRow = null;
// (the 4s user-scroll stand-off lives in segment-strips' followLine now, with one shared timestamp)
function startGlossCursor(entries) {
  cancelAnimationFrame(glossRafId);
  const tick = () => {
    const time = player?.playheadMs?.();
    const rolling = player?.playing?.();
    for (const en of entries) {
      if (!isAligned(en.seg)) continue;
      const inSeg = typeof time === 'number' && time >= en.seg.start && time < en.seg.end;
      const want = rolling && inSeg ? '⏸' : '▶';
      if (en.btn.textContent !== want) { en.btn.textContent = want; en.btn.setAttribute('aria-label', t(rolling && inSeg ? 'seg.pauseTip' : 'seg.playTip')); }
      /* v326 (Seth #9): highlight the playing line-group; during CONTINUOUS play (no active span)
       * follow it -- change-of-line only, only when out of sight, 4s user-scroll standoff. */
      const grp = en.wrap.closest('.segment');
      if (grp && grp.classList.contains('gseg-on') !== inSeg) grp.classList.toggle('gseg-on', inSeg);
      /* "Take me to that line" after a seek on the whole-file player (requestReveal). ⚠ It belongs
       * in THIS loop: startGlossTicker in segment-strips.js looks like the gloss ticker and is dead
       * code, so the hook added there in v360 never ran. This tab scrolls the whole line-GROUP. */
      if (grp && inSeg) takeReveal(grp);
      /* ⚠ THE SHARED follow rule, not a fourth copy of it (Seth: "reuse whatever common code you
       * can"). This tab had its own, which is how it kept the v326 span-playback exemption after the
       * others dropped it — so a line played with Space here highlighted off screen and never came
       * into view. Same helper as the Baseline strips and the Cut rows now. */
      if (grp && inSeg) glossFollowRow = followLine(grp, rolling && inSeg, glossFollowRow, player);
      let cur = en.wrap.querySelector('.gseg-cursor');
      if (inSeg) {
        if (!cur) { cur = document.createElement('div'); cur.className = 'gseg-cursor'; en.wrap.appendChild(cur); }
        cur.style.left = (((time - en.seg.start) / (en.seg.end - en.seg.start)) * en.wave.offsetWidth) + 'px';
      } else if (cur) cur.remove();
    }
    glossRafId = requestAnimationFrame(tick);
  };
  glossRafId = requestAnimationFrame(tick);
}
function stopGlossCursor() { cancelAnimationFrame(glossRafId); }

/* Split gloss line i at word boundary `boundary`. Time via splitSegment — the REAL playhead when
 * it sits inside the segment (the dock lives on this tab precisely for that), else interpolation
 * by word position marked timeEstimated. The free translation follows the MAJORITY side (tie →
 * left) — it cannot be auto-split, so it stays whole where most of its words went. Glosses ride
 * their words through the reconcile carry-over pool. */
function glossSplitAt(i, boundary) {
  if (!current) return;
  captureUndo();
  const doc = current.doc;
  const phrase = doc.paragraphs[i] && doc.paragraphs[i].segments[0];
  if (!phrase || !phrase.words) return;
  const words = phrase.words;
  /* Boundary 0 and words.length are LEGAL since v322 (baseline-parity, Seth's bug list #3): Enter
   * at the start of the first gloss / the free translation inserts an EMPTY line BEFORE this one
   * (a silence span, time split at the playhead — exactly what Enter at the start of a baseline
   * strip does); at the end, an empty line AFTER. Only a boundary outside the line is refused. */
  if (boundary < 0 || boundary > words.length) return;
  const free = phrase.free || '';
  // Capture gloss data BEFORE the reconcile: its carry-over pool can attach the original phrase's
  // words to only ONE of the two halves, so the other half would arrive glossless (caught by the
  // verification: right-half glosses came back as '?'). Explicit redistribution by position+text
  // is the guarantee.
  const origWords = words.map((w) => ({ txt: w.txt, gls: w.gls }));
  const leftText = words.slice(0, boundary).map((w) => w.txt).join(' ');
  const rightText = words.slice(boundary).map((w) => w.txt).join(' ');
  const paras = getBaselineParagraphs(doc).slice();
  paras.splice(i, 1, leftText, rightText);
  doc.segments = splitSegment(docSegments(doc), i, {
    playheadMs: player?.playheadMs?.() ?? null,
    fraction: boundary / words.length,
  });
  reconcileBaseline(doc, paras.length ? paras : [''], { flatSegments: true });
  const L = doc.paragraphs[i] && doc.paragraphs[i].segments[0];
  const R = doc.paragraphs[i + 1] && doc.paragraphs[i + 1].segments[0];
  // Re-attach glosses to both halves by position, verifying the token text still matches.
  const reglue = (ph2, src) => {
    if (!ph2 || !ph2.words) return;
    ph2.words.forEach((w, k) => {
      if (src[k] && src[k].txt === w.txt && src[k].gls && !w.gls) w.gls = src[k].gls;
    });
  };
  reglue(L, origWords.slice(0, boundary));
  reglue(R, origWords.slice(boundary));
  if (L && R && free) {
    const leftWins = boundary >= words.length - boundary;   // tie → left
    (leftWins ? L : R).free = free;
    (leftWins ? R : L).free = '';
  }
  schedulePersist();
  stopGlossCursor();
  renderGloss();
  decorateGlossSegments();
}

function glossJoinLines(i) {
  if (!current) return;
  captureUndo();
  const doc = current.doc;
  const paras = getBaselineParagraphs(doc).slice();
  if (i < 0 || i + 1 >= paras.length) return;
  const left = paras[i] ?? '', right = paras[i + 1] ?? '';
  const glue = left && right && !/\s$/.test(left) && !/^\s/.test(right) ? ' ' : '';
  paras.splice(i, 2, left + glue + right);
  // duration matters: without it normalizeSegments skips its clamp passes (the baseline path
  // always passed it; the gloss path forgot — v322 parity fix).
  doc.segments = mergeSegments(docSegments(doc), i, { duration: player?.durationMs?.() ?? null });
  reconcileBaseline(doc, paras.length ? paras : [''], { flatSegments: true });
  schedulePersist();
  stopGlossCursor();
  renderGloss();
  decorateGlossSegments();
}

/* Prepare the Cut tab's audio — the SAME sequence the Baseline strips use, and for the same
 * reasons: the working WAV (lossy sources decode and play ~44ms apart), then peaks, then render.
 *
 * ⚠ The doc-switch guard on every await matters more here than anywhere: the Cut tab is where a
 * user lands on a big unsegmented recording, so the decode is at its slowest and the window for
 * them to hit Back and open something else is at its widest. Rendering into a doc that is no longer
 * open would draw one text's waveform under another's segments. */
let cutShownFor = null;   // the doc whose strips are currently on screen — see below

/* ONE reporter for both tabs (Seth, 2026-08-20): "we need to always make sure our UI is responsive
 * and gives the user some kind of 'loading' response/status bar."
 *
 * The Cut tab and the Baseline strips run the SAME preparation — working WAV, then peaks — so they
 * get the same words in the same order rather than two drifting sets. Stages arrive as bare keys
 * from whichever module is doing the work; this is where they become sentences, because the engine
 * modules must not carry copy.
 *
 * ⚠ A stage with no number passes null and the bar goes indeterminate. Never substitute a guess:
 * a bar that sticks at an invented 40% is what teaches a user to ignore bars. */
function segPrep(sel) {
  const el = () => $(sel);
  return (stage, frac) => {
    const pct = typeof frac === 'number' && isFinite(frac) ? Math.round(frac * 100) : null;
    const msg = stage === 'peaks' ? t('seg.prep.peaks', { pct: pct == null ? 0 : pct })
              : stage === 'convert' ? t('seg.prep.convert')
              : stage === 'decode' ? t('seg.prep.decode')
              : t('seg.prep.read');
    segProgress(el(), msg, frac);
  };
}

/* ⚠ ONE DEFINITION OF "THE RECORDING IS STILL ON ITS WAY" — there were three copies and they had
 * already drifted, in the direction that hurts the people this app is for.
 *
 * landingTab excluded a FAILED download (`pendingAudio && !audioError`); the Cut and Baseline waiting
 * screens did not, even though the Baseline one carries a comment claiming it uses "same test, same
 * two states" as Cut. So on a poor connection — the NORMAL field case — an assigned text whose audio
 * download failed sat on "Loading the recording…" forever. On the Baseline tab that is not merely a
 * wrong message: the branch that shows it also HIDES THE TEXTAREA, so the transcriber could not type
 * at all, waiting on bytes that were never coming. A download that failed must read as failed, so the
 * player can offer its retry and the words can be written meanwhile.
 *
 * ⚠ A USER-PAUSED DOWNLOAD IS ALSO NOT "COMING". Pausing keeps pendingAudio set by design, and the
 * user paused deliberately — usually to work now and fetch the audio later. Treating that as
 * in-flight would hold the same screen against them for as long as they left it paused.
 *
 * Deliberately NOT reused in landingTab: that asks a different question ("does this doc have audio at
 * all, so should we land on Cut?"), and a paused download should still land there. Same fields,
 * different question — which is exactly how these three drifted apart in the first place. */
function audioStillComing(rec, attachingForThisDoc) {
  if (attachingForThisDoc) return true;                  // a local attach in progress always is
  if (!rec || !rec.pendingAudio) return false;
  if (rec.audioError) return false;                      // it failed — say so instead of spinning
  const dl = getDownload(rec.id);
  if (dl && dl.status === 'paused') return false;        // stopped by the user; let them work
  return true;
}

async function prepareCutAudio() {
  const forDoc = current && current.id;
  const main = $('#cut-main'), loading = $('#cut-loading');
  /* ⚠ DO NOT HIDE STRIPS THAT ARE ALREADY THIS DOC'S. Hiding #cut-main collapses the page height,
   * and the browser then clamps the scroll offset to the new maximum — so re-entering the tab for
   * the SAME text threw the user back to the top, which is the very thing v357 fixed for cuts and
   * joins. `switchTab('cut')` is re-entered on every UNDO/REDO (applyUndoState re-renders through
   * it) and on a live settings push, so this was the last route by which a cut still lost your
   * place: undo it and you were at the top again. Not hiding also removes the flicker the plan
   * predicted for undo. A different doc still gets the loading state, because then there is genuinely
   * nothing on screen worth keeping. */
  const reentry = main && !main.hidden && cutShownFor === forDoc;
  if (main && !reentry) main.hidden = true;
  if (loading && !reentry) loading.hidden = false;
  const prog = segPrep('#cut-loading');
  if (!reentry) prog('read', null);
  let media = forDoc ? await db.getMedia(forDoc).catch(() => null) : null;
  media = await segWorkingMedia(forDoc, media, current && current.title, prog);
  if (!current || current.id !== forDoc || activeTab !== 'cut') return;
  if (!media || !media.blob) {
    /* No recording ⇒ nothing to cut. The tab should not have been reachable, but say so rather than
     * showing an empty screen if it was.
     * ⚠ …unless one is ON ITS WAY, which is the normal case for a text just made from a file (the
     * editor opens before the attach finishes) and for an assigned text whose audio is still
     * downloading. Telling those users "this text has no recording" is both wrong and alarming. */
    const coming = audioStillComing(current, attachingAudioFor === forDoc);
    /* ⚠ THE TEXT SPAN, NOT THE CONTAINER. Writing textContent on #cut-loading itself would delete
     * the bar element inside it, and the next text that DOES load would then have no bar to fill. */
    if (loading) {
      loading.hidden = false;
      segProgress(loading, t(coming ? 'seg.loadingAudio' : 'cut.noAudio'), coming ? null : 0);
    }
    return;
  }
  await ensurePeaks(forDoc, media.blob, (playerReadyFor === forDoc && player && player.decodedBuffer) ? player.decodedBuffer() : null, prog);
  if (!current || current.id !== forDoc || activeTab !== 'cut') return;
  if (loading) loading.hidden = true;
  if (main) main.hidden = false;
  cutShownFor = forDoc;
  renderCut();
}

function switchTab(tab, landing) {
  // Leaving baseline: apply baseline edits to the model first.
  if (activeTab === 'baseline' && !$('#view-baseline').hidden) {
    applyBaseline();
  }
  const fromTab = activeTab;      // what we are ARRIVING FROM — see the Cut tab's span-watcher rule
  activeTab = tab;
  /* ⚠ ONLY A TAB THE USER CHOSE IS REMEMBERED. enterEditor's own landing switch passes `landing`,
   * because storing the tab the APP picked would make rule (2) self-fulfilling: the first auto-land
   * on Cut would become "the user's choice" forever, and a researcher later switching landOnCut off
   * would have no effect on any text that had ever been opened. */
  if (!landing) rememberTab(tab);  // …so this text opens here next time (see landingTab)
  if (tab !== 'cut') stopCut();   // never leave the Cut rAF running behind another view
  /* THE CUT TAB — audio only. It shares the dock player and the peaks cache with the Baseline
   * strips, so entering it is the same preparation minus the text UI.
   *
   * ⚠ healFlatSegments FIRST, exactly as the Baseline tab does: an imported doc can arrive with
   * several phrases in one paragraph, and every index-driven edit here assumes 1:1:1:1. Cutting a
   * doc that has not been flattened would address the wrong span. */
  if (tab === 'cut') {
    stopGlossCursor();
    healFlatSegments(current && current.doc);
    show('cut');
    refreshPlayer();
    /* ⚠ NO SPAN TARGET ON THIS TAB (Seth, 2026-08-13): playback runs THROUGH the boundaries here,
     * so nothing may leave a segment behind as "the thing Space and ⏮ act on" — that is what would
     * quietly restore span-limited playback by the back door. Cleared on entry, and kept cleared by
     * the onPlayTarget below, so on the Cut tab Space is continuous and ⏮ is the whole file. */
    lastPlayTarget = null;
    /* ⚠ AND DROP ANY SPAN WATCHER CARRIED IN FROM ANOTHER TAB. `lastPlayTarget` is only the memory
     * of a target; the watcher itself lives on the Player, armed by the last playSpan() — so
     * arriving here straight from a Baseline or Gloss line still playing left a timeupdate handler
     * that PAUSES at that line's end, breaking the tab's promise by its most ordinary route: listen
     * to a line, come over to re-cut it.
     *
     * ⚠ ONLY ON ARRIVAL, though (`fromTab !== 'cut'`). This tab re-enters ITSELF on every undo/redo
     * and on a live settings push, and a blanket clear there would silently cancel an audition the
     * user had just started with a row's ▶ — a watcher THIS tab armed, on purpose. */
    if (fromTab !== 'cut') player?.clearSpan?.();
    applyCutHint();
    initCut({
      getPlayer: () => player,
      getDoc: () => current && current.doc,
      // Which document the peaks cache must belong to before its duration may seed anything.
      getDocId: () => current && current.id,
      getParagraphs: (doc) => getBaselineParagraphs(doc),
      setParagraphs: (doc, paras) => { reconcileBaseline(doc, paras.length ? paras : [''], { flatSegments: true }); schedulePersist(); },
      onPlayTarget: () => { lastPlayTarget = null; },
      capture: () => captureUndo(),
      persist: () => schedulePersist(),
      // Read through a FUNCTION so a researcher push lands mid-session, same rule as joinKeys.
      allowJoinTexted: () => cutJoinTextedAllowed(),
      // Guessing replaces every cut in the text, so hand-made work is confirmed before it goes.
      confirmReplace: () => confirmDialog(t('cut.guessConfirm')),   // async now; cutGuessSplits awaits it
      t,
    });
    prepareCutAudio();
    return;
  }
  if (tab === 'baseline') {
    stopGlossCursor();
    applyBaselineHint();
    if (segmentationEnabled()) {
      // Strip mode: per-segment waveform + single-line text pairs. The textarea stays in the DOM
      // but hidden — switching the researcher setting off returns the classic editor with the
      // same paragraphs (segments are retained on the doc, only the UI hides).
      healFlatSegments(current && current.doc);
      show('baseline');
      refreshPlayer();
      initStrips({
        container: $('#segment-strips'),
        getPlayer: () => player,
        getDoc: () => current && current.doc,
        getDocId: () => current && current.id,   // see peaksDurationFor
        getParagraphs: (doc) => getBaselineParagraphs(doc),
        setParagraphs: (doc, paras) => { reconcileBaseline(doc, paras.length ? paras : [''], { flatSegments: true }); schedulePersist(); },
        onPlayTarget: (seg) => { lastPlayTarget = seg; },
        capture: () => captureUndo(),
        persist: () => schedulePersist(),
        // Read through a FUNCTION, not a captured boolean: initStrips runs once per doc open, and a
        // researcher push (changeSettings) can land mid-session — a snapshot would keep the old
        // answer until the next open, which is the drift this setting exists to remove.
        joinKeys: () => joinKeysEnabled(),
        joinSplit: () => joinSplitAllowed('baseline'),
        t,
      });
      /* ⚠ THE STRIPS DO NOT EXIST UNTIL THE AUDIO DOES (Seth, 2026-08-07): "can we actually have
       * that UI element not load until the audio finishes loading?"
       *
       * They used to be revealed immediately and rendered against whatever was known at that
       * instant — which, on the "New text from audio" path, is NOTHING: newDocFromAudio enters the
       * editor BEFORE it awaits attachAudioFile. The seed then had no duration, so the one span was
       * written `timePending` — the "⋯" button and the flat line — and nothing re-rendered when the
       * decode finally landed. It healed only on re-entry, which is exactly the reported
       * "until I refresh or exit and come back".
       * It hid on short files because the decode won the race; Seth's 6:02 recording in Firefox
       * loses it every time, and four repro attempts at 7s and 90s all missed it for that reason.
       *
       * Waiting is also the HONEST shape: a span seeded before the duration is known is not a
       * placeholder, it is a wrong alignment written to the doc. Better to show nothing yet. */
      const stripsFor = current && current.id;
      $('#segment-strips').hidden = true;
      $('#baseline-text').hidden = true;
      $('#seg-loading').hidden = false;
      const prog = segPrep('#seg-loading');
      prog('read', null);
      (async () => {
        let media = stripsFor ? await db.getMedia(stripsFor).catch(() => null) : null;
        media = await segWorkingMedia(stripsFor, media, current && current.title, prog);   // same WAV the player uses
        if (!current || current.id !== stripsFor || !isEditorTab(activeTab)) return;  // doc switched under us
        /* ⚠ NO AUDIO ⇒ THE CLASSIC EDITOR (Seth): "our app should fall back on the basic editor if
         * there's no attached audio file." Strips over a doc with no recording are all pending by
         * construction — every line a "⋯" and a flat slab, and no way to ever fix one, because
         * there is no timeline to align to. The textarea can at least be typed in. */
        if (!media || !media.blob) {
          /* ⚠ "NO AUDIO" AND "AUDIO NOT HERE YET" ARE DIFFERENT, and treating them alike is the
           * glitch Seth found in the v440 test drive: "it initially loaded the classic text editor
           * while the audio was loading… whatever you typed in the baseline tab ends up on the first
           * line."
           *
           * That window is the NORMAL case, not an edge one — newDocFromAudio enters the editor
           * BEFORE it awaits attachAudioFile, and an assigned text's recording is still downloading.
           * Revealing the textarea there offers an editor the user should never have been given, and
           * because applyBaseline is gated on DOM TRUTH a visible textarea IS their intent on
           * tab-leave: whatever they typed is committed and lands as the first span once the strips
           * finally render. The words are not lost, but they arrive somewhere nobody chose.
           *
           * prepareCutAudio has drawn this distinction since v433; the Baseline tab simply never
           * did. Same test, same two states, so the two tabs now behave alike. */
          const coming = audioStillComing(current, attachingAudioFor === stripsFor);
          if (coming) {
            /* Keep waiting. The tab is re-entered when the attach lands (attachAudioFile re-enters,
             * and the download path re-renders), so the strips appear without anything further here.
             * ⚠ The textarea stays HIDDEN — that is the whole fix. */
            segProgress($('#seg-loading'), t('seg.loadingAudio'), null);
            $('#seg-loading').hidden = false;
            $('#segment-strips').hidden = true;
            return;
          }
          $('#seg-loading').hidden = true;
          $('#segment-strips').hidden = true;
          $('#baseline-text').value = getBaselineParagraphs(current.doc).join('\n');
          if (settings.vernFont) $('#baseline-text').style.fontFamily = quoteFont(settings.vernFont);
          $('#baseline-text').hidden = false;   // ⚠ LAST: applyBaseline reads DOM truth, so the
          return;                               //    value must be in place before it is visible.
        }
        await ensurePeaks(stripsFor, media.blob, (playerReadyFor === stripsFor && player && player.decodedBuffer) ? player.decodedBuffer() : null, prog);
        if (!current || current.id !== stripsFor || !isEditorTab(activeTab)) return;
        $('#seg-loading').hidden = true;
        $('#segment-strips').hidden = false;
        renderStrips();
      })();
    } else {
      $('#segment-strips').hidden = true;
      $('#baseline-text').hidden = false;
      $('#baseline-text').value = getBaselineParagraphs(current.doc).join('\n');
      show('baseline');
      if (settings.vernFont) $('#baseline-text').style.fontFamily = quoteFont(settings.vernFont);
      refreshPlayer();
    }
  } else {
    stopStrips();
    stopGlossCursor();
    healFlatSegments(current && current.doc);
    renderGloss();
    show('gloss');
    // The shared dock stays live on the gloss tab (Seth): full-track player + per-line mini waves.
    refreshPlayer();
    if (segmentationEnabled()) {
      (async () => {
        let media = current ? await db.getMedia(current.id).catch(() => null) : null;
        media = await segWorkingMedia(current && current.id, media, current && current.title);
        await ensurePeaks(current && current.id, media && media.blob, (current && playerReadyFor === current.id && player && player.decodedBuffer) ? player.decodedBuffer() : null);
        decorateGlossSegments();
      })();
    }
  }
}

/* ---------------- Audio player (Baseline tab) ---------------- */

let player = null;
/* v322 (Seth #8/#11): the LAST-USED playback target — a segment span, or null for the whole-file
 * dock player. Space toggles it; the dock's ⏮ rewinds it to ITS start. Set by every segment play
 * button and strip scrub; cleared by any dock interaction (the dock then IS the target). */
let lastPlayTarget = null;

/* ---------------- undo/redo (v323, Seth's bug list #6) ----------------
 * STRUCTURAL operations only: split/join on both tabs, the classic-textarea commit, word
 * chain/unchain — and every Matching-mode cut. Typing INSIDE a field keeps the browser's native
 * undo while the field has focus; a structural op re-renders and ends that scope. Snapshots are
 * {paragraphs, segments} pairs — the two halves every structural edit writes together, so
 * restoring one without the other would desynchronise the 1:1 line invariant. */
const UNDO_CAP = 100;
let undoStack = [], redoStack = [];
function docSnap() {
  return { p: structuredClone(current.doc.paragraphs), s: structuredClone(current.doc.segments || []) };
}
function pushSnap(snap) {
  undoStack.push(snap);
  if (undoStack.length > UNDO_CAP) undoStack.shift();
  redoStack = [];
  updateUndoButtons();
}
/* FOCUS-SESSION text undo (Seth, v326): everything typed during ONE focus of a field is ONE undo
 * step. On focus we snapshot the doc; on blur (or before any structural op, to keep chronology)
 * the snapshot is pushed IF the field changed. While the field is focused and DIRTY, Ctrl+Z stays
 * NATIVE (character-level, the browser's); once the field is back to its focus-start value -- or
 * focus has left -- Ctrl+Z is the app's and steps whole sessions/operations. That answers "native
 * is not compatible with session-scoping": native owns the inside of a session, the app owns
 * everything at and beyond its boundary. */
let fieldUndo = null;   // { el, startValue, snap } for the currently-focused text field
function commitFieldUndo() {
  const f = fieldUndo;
  fieldUndo = null;
  if (!f || !current) return;
  const now = (f.el && typeof f.el.value === 'string') ? f.el.value : null;
  if (now !== null && now === f.startValue) return;   // nothing changed this session
  pushSnap(f.snap);
}
function captureUndo() {
  if (!current) return;
  try {
    commitFieldUndo();          // chronology: the focus-session's BEFORE precedes this op's BEFORE
    pushSnap(docSnap());
  } catch { /* snapshot failed -- skip rather than break the edit */ }
}
function resetUndo() { fieldUndo = null; undoStack = []; redoStack = []; updateUndoButtons(); }
function updateUndoButtons() {
  const u = $('#btn-undo'), r = $('#btn-redo');
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}
function applyUndoState(st, onto) {
  const now = { p: structuredClone(current.doc.paragraphs), s: structuredClone(current.doc.segments || []) };
  onto.push(now);
  current.doc.paragraphs = st.p;
  current.doc.segments = st.s;
  schedulePersist();
  /* ⚠ THE SPANS THE PLAYER WAS WATCHING NO LONGER EXIST. A span watcher captures its stop time and
   * rewind-home when playback starts, and undo has just replaced every segment — so an audition
   * running across an undo would pause at a boundary from the discarded state and throw the playhead
   * back to a start that is not there any more. Same rule as cutHere and cutGuessSplits. */
  player?.clearSpan?.();
  // Re-render whatever is showing; switchTab already knows every mode's render path.
  switchTab(activeTab);
  updateUndoButtons();
}
function doUndo() { commitFieldUndo(); const st = undoStack.pop(); if (st) applyUndoState(st, redoStack); }

function doRedo() { const st = redoStack.pop(); if (st) applyUndoState(st, undoStack); }
let playerDocId = null;
// Which doc's audio the player has FINISHED decoding. decodedBuffer() returns whatever wavesurfer
// currently holds — during a doc switch that is the PREVIOUS doc's audio, and ensurePeaks trusting
// it raced in wrong peaks: plausible-but-wrong waves within the old recording's length, solid bars
// beyond it (Seth's 'previews stop working after a certain point', 2026-08-04). Set only after a
// load RESOLVES, and only if no newer load superseded it.
let playerReadyFor = null;

function getPlayer() {
  if (!player) {
    player = new Player($('#audio-player'), {
      labels: {
        get preparing() { return t('player.preparing'); },
        get error() { return t('player.error'); },
        get errorTruncated() { return t('player.errorTruncated'); },
      },
      // ⚠ Write peaks back to the record's OWN storage key. Keying by playerDocId overwrote the
      // ORIGINAL media with the derived WAV working copy when segmentation mode handed the player
      // the derived record (caught by the originalUntouched check). The derived copy carries its
      // key in mediaKey; an original has none and keeps the old behaviour.
      onPeaks: (media) => { db.putMedia(media.mediaKey || playerDocId, media).catch(() => {}); },
      onRemove: async () => {
        if (!current || isAudioLocked(current)) return;
        if (!await confirmDialog(t('player.confirmRemove'))) return;
        await db.deleteMedia(current.id);
        playerReadyFor = null;   // the decoded buffer no longer corresponds to ANY stored audio
        delete current.pendingAudio;
        delete current.audioSource;
        delete current.mediaGuid;
        current.doc.mediaXML = [];
        await persist();
        refreshPlayer();
      },
      /* CLICKING THE BIG WAVEFORM IS "TAKE ME HERE" (Seth, 2026-08-13), and it means two things:
       *  - playback PAUSES, so the position you just chose stays the position you chose. It used to
       *    run straight on from the click, sliding the playhead off the spot before you could cut;
       *  - and if the line for that instant is off screen, the strips scroll it into the MIDDLE.
       *    Seeking on the whole-file player is how you find your place in a long recording, and
       *    landing there without the line in front of you leaves you hunting for the row you just
       *    picked. This is the other half of "the one overview and the strips stay in sync".
       * The strips honour the request from their own tickers — see requestReveal. */
      onSeekInteraction: () => { player?.pause?.(); requestReveal(); },
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
/* Segmentation working copy (Seth): a NON-WAV source is auto-converted to WAV on load and the WAV
 * becomes the working file for all audio annotation. WHY: compressed codecs carry encoder priming
 * (AAC ≈ 44-48ms) and browsers disagree between decode and playback about where zero is — chop-by-
 * ear boundaries land audibly off. PCM has no priming; with the player and the peaks both on the
 * WAV there is ONE unambiguous timeline.
 *
 * HONESTY RULES (Seth): the converted file is NAMED as converted
 * (<orig>.converted-NOT-ARCHIVAL.wav) and flagged derived:true in its media record, so exports can
 * mark it in filename AND metadata. The ORIGINAL is never touched, replaced, or deleted — the
 * working copy lives beside it under its own key and is a pure derivation (lossy→PCM adds no
 * information; this is a timeline fix, not an upgrade — see audio-archival-standards).
 */
async function segWorkingMedia(docId, media, title = '', onProgress) {
  if (!media || !media.blob) return media;
  const isWav = /wav$/i.test(media.mimeType || '') || /\.wav$/i.test(media.name || '');
  if (isWav || !segmentationEnabled()) return media;
  const key = 'segwav:' + docId;
  const cached = await db.getMedia(key).catch(() => null);
  if (cached && cached.blob && cached.srcName === media.name) return cached;
  /* ⚠ ONLY PAST THE CACHE CHECK. Announcing the conversion before we know one is needed would flash
   * 'preparing…' at every open of an already-converted text — a status line that cries wolf is the
   * one people learn to read past. This point is reached only when the work is genuinely about to
   * happen, and everything after it is seconds long on a field phone. */
  if (typeof onProgress === 'function') onProgress('convert', null);
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ctx.decodeAudioData(await media.blob.arrayBuffer());
    const chans = []; for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    const wavBlob = encodeWav(chans, buf.sampleRate, 16);
    try { ctx.close(); } catch { /* noop */ }
    const rec = { blob: wavBlob, mimeType: 'audio/wav', derived: true, srcName: media.name,
      mediaKey: key,   // peaks writeback targets THIS record, never the original's key
      // v3: named from the STORY TITLE, not from media.name — an assigned text's media.name was
      // the delivery token, and it propagated into this derived copy and every export built on it.
      name: derivedWavName(sanitizeBase(title) || String(media.name || 'audio').replace(/\.[^.]+$/, '')) };
    await db.putMedia(key, rec).catch(() => {});
    return rec;
  } catch { return media; }   // undecodable → play the original; alignment caveat stands
}

async function refreshPlayer() {
  if (!$('#audio-player')) return; // record mode has no player UI
  const p = getPlayer();
  $('#btn-attach-audio').hidden = true;
  if (!current) { p.hide(); return; }
  playerDocId = current.id;
  let media = await db.getMedia(current.id).catch(() => null);
  media = await segWorkingMedia(current.id, media, current.title);   // WAV working copy in segmentation mode
  if (current.id !== playerDocId || !isEditorTab(activeTab)) return;
  p.el.remove.hidden = isAudioLocked(current);
  if (media) {
    updateDlControls('done');
    // Re-load only when switching docs (avoid resetting playback position).
    if (p.loadedFor !== current.id) {
      const loadId = current.id;
      p.loadedFor = loadId;
      playerReadyFor = null;
      await p.load(media);
      if (p.loadedFor === loadId) playerReadyFor = loadId;   // a newer load supersedes silently
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
  /* ⚠ A TEXT MADE FROM A RECORDING OPENS ON THE CUT TAB (Seth, 2026-08-14: "we do want texts to open
   * for the first time in the cut tab if it's enabled. If the user hasn't typed in any baseline
   * text"). landingTab cannot reach this on its own: its proof that audio exists is an ALIGNED span,
   * and at this instant attachAudioFile has not run — no media, no duration, no seed. The caller
   * knows what the rule cannot, that a recording is being attached right now and the text has no
   * words by construction. Both gates still apply, so a researcher who turned either off gets the
   * Baseline tab exactly as before. */
  if (!RECORD_MODE) enterEditor(cutTabEnabled() && landOnCutEnabled() ? 'cut' : 'baseline');
  await attachAudioFile(file);
  // If a recorded verbal assent was captured in the consent gate, store it
  // with this doc so it travels in the upload/save zip bundle.
  // Which microphone this actually came from, and whether it is archive grade. Persisted with the
  // doc because provenance is worthless if it only exists while the record screen is open — the
  // question "was this take made on the USB mic?" is asked weeks later, not at record time.
  if (pendingCapture) {
    current.capture = pendingCapture;
    pendingCapture = null;
  }
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
  // Returned so saveRecording can queue the Lane A media upload for THIS doc — `current` is
  // cleared below in record mode, so the caller cannot read it back.
  const newId = current.id;
  if (RECORD_MODE) {
    // No editor in record mode: the recording is saved; return to the list.
    current = null;
    show('record');
    renderRecordList();
    toast(t('record.saved'), 4000);
    return newId;
  }
  $('#doc-title').focus();
  $('#doc-title').select();
  return newId;
}

/* ---------------- Speaker-permission (consent) gate ----------------
 * App-wide Research setting. Before recording a new text, optionally show a
 * written or spoken reminder and collect either a Yes/No tap or a recorded
 * verbal "yes". A recorded assent is bundled with the text (separate from
 * the transcription audio) at save time.
 */

let pendingAssent = null; // { blob, name } captured assent, consumed on doc create
let pendingCapture = null;   // native capture provenance, awaiting the doc it belongs to
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
    try { await ensureAsset('asset:consent-prompt', settings.consentAudio, consentAudioIdentity(), 'consent-prompt'); }
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

/* ⚠ THE RECORD BUTTON MUST NEVER FAIL IN SILENCE (2026-08-31).
 *
 * requestConsentThen is async, and all three record buttons called it as a bare fire-and-forget
 * listener — no await, no catch. So ANY throw inside the consent gate (a missing element, a stored
 * config in a shape this engine did not expect, an asset call that rejects before the try block)
 * produced an unhandled rejection and a button that did *nothing at all*: no modal, no toast, no
 * visible error. There is no way for a field user — or a researcher — to report that usefully, and
 * no way to tell it apart from a dead click.
 *
 * That is exactly how one crowd recorder came to be "broken" with the Record button inert while a
 * newly created one on the SAME build worked (Seth, 2026-08-31). The cause went with the deleted
 * recorder, which is the second half of the lesson: the silence is what made it undiagnosable.
 *
 * `startConsentThenRecord()` is now the ONE way the buttons enter this, and a failure says so and
 * is logged. It does not pretend to fix whatever threw — it makes the next one reportable. */
function startConsentThenRecord() {
  Promise.resolve()
    .then(() => requestConsentThen(() => openRecordModal()))
    .catch((err) => {
      console.error('[flextext] consent gate failed before recording', err);
      toast(t('consent.gateFailed'), 9000);
    });
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
        : (await ensureAsset('asset:consent-prompt', settings.consentAudio, consentAudioIdentity(), 'consent-prompt')
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
// The meter must also run while the mic is merely WARM (open, not yet recording). That is not a
// nicety: a warm mic is a live mic, and a moving meter is the only "it is listening" signal a
// non-reading user can actually verify. If this ever stops covering the warm case, pre-warm becomes
// an undisclosed open microphone.
function recHasMeter() {
  if (warmMic && warmMic.pcmRec) return true;
  return !!(rec && ((rec.mode === 'pcm' && rec.pcmRec) || rec.meterAnalyser));
}
function recPeak() { // 0..1 linear peak from whichever capture path is live
  if (!rec) return warmMic && warmMic.pcmRec ? warmMic.pcmRec.peak() : 0;
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
    if ((!rec || !rec.recording) && !warmMic) { meterRAF = null; return; }
    if (!recHasMeter()) { meterRAF = null; return; }
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
    // Do not offer Record until the mic is genuinely open. Tapping early used to "work" — it waited
    // for the warm-up and then started — but the speaker had already begun talking into a mic that
    // was not listening yet, and the pre-roll buffer was still empty, so the opening words were lost
    // anyway. On a fast Mac that needs deliberate fast-clicking to hit; on a cheap phone, where
    // opening the mic takes far longer, it is what a normal-speed user gets. Gating moves the wait
    // to before anyone speaks, which is the only place it is harmless.
    applyWarmGate();
  } else if (state === 'recording') {
    toggle.textContent = t('record.stop');
    status.textContent = t('record.recording', { time: extra.time || '0:00' })
      + (extra.warn ? '  ' + extra.warn : '');
  } else if (state === 'review') {
    status.textContent = t('record.review');
    // Auto-stopped on the memory ceiling: say so plainly, and lead with the fact that the take
    // survived. A recording that ends by itself reads as a failure unless it is named as not one.
    if (rec?._memStopped && !rec._memStopWarned) { rec._memStopWarned = true; toast(t('record.memStopped'), 9000); }
    // If a lossless choice couldn't be honored on this browser, the take was
    // captured as compressed MP3 — say so once, plainly, so nobody assumes they
    // archived a lossless recording.
    if (rec?.fellBack && !rec._warned) { rec._warned = true; toast(t('record.fellBack'), 8000); }
    // WHICH MICROPHONE this take actually came from. This is the readout that makes testing a USB
    // microphone possible at all: plug it in, record, and read whether the phone really used it.
    // Without it the only test is recording twice and listening, which cannot distinguish "the
    // phone ignored the mic" from "the mic is poor". Native only — null on every browser path, so
    // the line simply does not appear there.
    showCaptureProvenance(rec && rec.mode === 'native' ? describeCapture(rec.nativeMeta) : null);
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
    try { rec.nrec?.cancel(); } catch { /* noop */ }   // native path: release the mic + drop its partial file
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

/* ---------------- mic pre-warm ----------------
 * Opening the mic takes real time (getUserMedia + AudioWorklet — comfortably a second on a cheap
 * phone). Doing it on the record TAP means the speaker is already talking while the interface is
 * still opening, and their first word is simply absent from the file. Warming when the record
 * screen opens moves that wait to a moment when nobody is speaking; the ring buffer in PCMRecorder
 * then covers what is left, including a speaker who starts before the tap.
 *
 * ⚠ THE MIC IS GENUINELY LIVE WHILE WARM. Three rules follow, and none are optional:
 *   1. Warm only AFTER consent. Every entry point is requestConsentThen(() => openRecordModal()),
 *      so warming here is post-consent by construction — keep it that way.
 *   2. Release when the screen closes AND when the app is backgrounded. Holding a hot mic behind
 *      another app is indefensible regardless of what we do with the audio.
 *   3. The level meter is the disclosure. A non-reading user cannot verify a privacy claim, but
 *      they can see a meter move.
 * Warming is best-effort: any failure leaves warmMic null and the tap takes the original path, so
 * this can degrade but never block a recording. */
let warmMic = null;             // { pcmRec } once the graph is live
let warmMicPending = null;      // in-flight warm, so a fast tap can await it instead of racing

/* How much audio to keep from BEFORE the tap. The single knob — tune it here.
 *
 * Cost is negligible and was measured, not assumed: float32 @48k mono is ~187 KB/s, so 4s is
 * ~0.73 MB. For scale, the take itself is held in RAM on this path at the same rate — a 10-minute
 * recording is ~110 MB — so the pre-roll is well under 1% of what a real recording already costs.
 * Memory is not the reason to keep this small.
 *
 * The real trade is LEADING ROOM TONE: every file starts with up to this much of the room before
 * anyone spoke. That is the right way to err (an archive would rather have room tone than a clipped
 * first word — it also documents the noise floor), but it is not free at corpus scale.
 *
 * 4s because Fayu speakers habitually start before the button. Raise it if field use shows people
 * still being clipped; 8s is still only ~1.5 MB. */
const PRE_ROLL_SEC = 4;

/* Gate the Record button on the mic actually being open.
 *
 * ⚠ THIS MUST NEVER STRAND ANYONE. A disabled button with no way out is worse than a slightly
 * clipped recording: the user is simply stuck, with no idea why, and no path forward. So the gate
 * opens on ANY terminal outcome — warm succeeded, warm failed, or the deadline passed — and a
 * failed warm just means the tap takes the original cold-open path, exactly as before pre-warm
 * existed. The gate is an improvement on a working system, never a precondition for it. */
const WARM_GATE_MAX_MS = 4000;
let warmGateDeadline = 0;

function warmGateOpen() {
  // Open if the mic is ready, if nothing is warming, or if we have waited long enough that a
  // further wait is worse than a cold start.
  return !!warmMic || !warmMicPending || Date.now() > warmGateDeadline;
}

function applyWarmGate() {
  const toggle = $('#record-toggle');
  const status = $('#record-status');
  if (!toggle) return;
  const open = warmGateOpen();
  toggle.disabled = !open;
  toggle.classList.toggle('warming', !open);
  if (!open) {
    // Text is the WEAKEST part of this for a barely-literate user, so it is deliberately not the
    // only signal — the button is visibly disabled too. Keep both.
    if (status) status.textContent = t('record.warming');
    setTimeout(() => { if (!$('#record-modal')?.hidden && !rec?.recording) applyWarmGate(); }, 120);
  } else if (status && status.textContent === t('record.warming')) {
    status.textContent = t('record.idle');
  }
}

async function warmUpMic() {
  // Structural guard, not just a DOM check: these apps have no recording feature at all, so there
  // is no path on which opening the microphone could ever be correct.
  /* ⚠ SEGMENTER_MODE belongs here and CONSENT_MODE deliberately does NOT. The segmenter only cuts
   * audio that already exists, so opening a microphone would be a permission prompt for a feature
   * it does not have. The consent collector RECORDS — the spoken "yes" is one of the three
   * confirmation forms — so it must warm the mic exactly as the recorder does. */
  if (PARAGRAPH_MODE || RESEARCHER_MODE || SEGMENTER_MODE) return;
  if (warmMic || warmMicPending || rec?.recording) return;
  // Only the AudioWorklet path benefits: native capture opens its own device, and MediaRecorder
  // cannot pre-roll (its chunks are encoded and not safely splittable).
  const fmt = recordFormatPref();
  if (REC_FORMATS[fmt]?.capture === 'media') return;
  if (nativeAudioAvailable() && NATIVE_ENCODING[fmt]) return;
  if (!losslessSupported()) return;
  const pcmRec = new PCMRecorder();
  warmGateDeadline = Date.now() + WARM_GATE_MAX_MS;
  warmMicPending = (async () => {
    try {
      await pcmRec.warm({ audio: dspConstraints(), preRollSec: PRE_ROLL_SEC });
      warmMic = { pcmRec };
      startMeter();                       // the meter IS the disclosure that the mic is open
    } catch (e) {
      try { pcmRec.cancel(); } catch { /* noop */ }
      warmMic = null;                     // stay silent: the tap will just open the mic itself
      console.warn('Mic pre-warm unavailable; recording will open the mic on tap.', e);
    } finally { warmMicPending = null; applyWarmGate(); }
  })();
  await warmMicPending;
}

function releaseWarmMic() {
  if (warmMic) { try { warmMic.pcmRec.cancel(); } catch { /* noop */ } }
  warmMic = null;
  if (!rec?.recording) stopMeter();
}

/* Never hold an open mic behind another app.
 *
 * ⚠ THE ELEMENT MUST EXIST BEFORE ITS `hidden` MEANS ANYTHING (Seth, 2026-08-05: "our paragraph
 * analysis tool is still requesting microphone permissions it doesn't need"). The old test was
 * `!$('#record-modal')?.hidden` — and in an app that HAS no record modal that is `!undefined`,
 * i.e. TRUE. So every time the Paragraph Analysis tool (or the researcher panel) regained focus,
 * it warmed the mic and the browser asked for permission. Nothing was ever recorded; the prompt
 * alone is the harm, and asking for a permission you cannot use is how apps teach people to click
 * "allow" without reading. */
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !rec?.recording) { releaseWarmMic(); return; }
  const modal = $('#record-modal');
  if (modal && !modal.hidden && !rec?.recording) warmUpMic();
});

function openRecordModal() {
  discardRecording();
  $('#record-title').value = '';
  warmUpMic();      // fire-and-forget; sets the pending flag synchronously, before the gate is read
  recordUI('idle'); // applies the warm gate, which now sees the warm-up already in flight
  $('#record-modal').hidden = false;
}

function closeRecordModal() {
  releaseWarmMic();
  discardRecording();
  pendingAssent = null;       // abandon any consent clip if the recording is cancelled
  pendingReceipt = null;      // and its audit record
  pendingPromptAudio = null;  // and the frozen prompt copy
  $('#record-modal').hidden = true;
  applyUpdateIfSafe();   // back on a safe screen → apply a pending update (esp. record mode, which has no texts list)
}

// Why the native path bowed out this attempt, so a fallback failure can name BOTH causes.
let lastNativeError = null;

async function startRecording() {
  lastNativeError = null;
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
    // NATIVE capture first, for the WAV formats only. This is the whole point of the Android
    // apps: AudioRecord can capture a TRUE integer bit depth (the web cannot — Web Audio is
    // float32 by spec) and can force AGC/NS/AEC off. FLAC and the lossy formats deliberately
    // fall through to the existing browser paths for now.
    if (nativeAudioAvailable() && NATIVE_ENCODING[fmt]) {
      try { await startNative(fmt); return; }
      catch (natErr) {
        if (natErr && natErr.name === 'NotAllowedError') throw natErr;   // mic denied is a real error
        // ⚠ REMEMBER WHY NATIVE FAILED. Falling back is right, but silently swallowing the reason
        // meant the user saw only the BROWSER's error — so a native fault (no device found by
        // ffmpeg, ffmpeg missing, a bad device name) was reported as whatever getUserMedia said
        // afterwards, which is a different subsystem with a different cause. That made the first
        // Windows failure undiagnosable from the message alone.
        lastNativeError = (natErr && (natErr.message || natErr.name)) || 'unknown';
        console.error('[flextext] native capture failed; falling back to the browser path:', natErr);
      }
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
    // If native was tried and failed FIRST, both reasons matter: the browser error alone points at
    // the wrong subsystem entirely.
    const msg = lastNativeError
      ? t('record.micErrorBoth', { native: lastNativeError, browser: e.message })
      : t('record.micError', { msg: e.message });
    $('#record-status').textContent = msg;
    console.error('[flextext] recording failed. native:', lastNativeError || '(not attempted)', 'browser:', e);
    // Embedded crowd page: a host that stripped allow="microphone" fails exactly like
    // a user "Block" — always offer the direct-link escape hatch when framed.
    if (CROWD_MODE && window !== window.top) crowdShowFrameEscape();
  }
}

// App format -> native encoding id. Only the WAV formats map: the native side writes a finished
// WAV, so these need no re-encoding at all. (`wav32` is IEEE float, matching encodeWav's format 3.)
const NATIVE_ENCODING = { wav16: 'pcm16', wav24: 'pcm24', wav32: 'float32' };

// Native (Android AudioRecord) capture. Produces a FINISHED WAV file on device — the bytes never
// pass through JS during capture, which is what keeps a long take from exhausting memory on a
// cheap phone. Throws so startRecording can fall back to the browser paths.
async function startNative(fmt) {
  const nrec = new NativeRecorder();
  const meta = await nrec.start({
    encoding: NATIVE_ENCODING[fmt],
    sampleRate: 48000,
    channels: 1,
    notificationTitle: t('record.btn'),
    notificationText: t('record.recording', { time: '' }).trim(),
  });
  rec = { mode: 'native', nrec, fmt, fellBack: false, recording: true, nativeMeta: meta,
          t0: Date.now(), timer: null, blob: null, url: null };
  startRecTimer();
  recordUI('recording');
  startMeter();
}

// AudioWorklet lossless capture (WAV/FLAC). Throws if getUserMedia / the worklet
// fails so startRecording can fall back. fellBack=true flags a downgrade at review.
async function startPcm(fmt, fellBack) {
  // Prefer the already-open mic. If a warm-up is still in flight (the user tapped immediately),
  // wait for it rather than opening a SECOND device — two concurrent getUserMedia calls on a cheap
  // phone is how you get a failed recording.
  if (warmMicPending) { try { await warmMicPending; } catch { /* fall through to a cold open */ } }
  let pcmRec = warmMic?.pcmRec || null;
  let preRollSec = 0;
  if (pcmRec) {
    warmMic = null;                       // ownership moves to `rec`; no double-teardown
    preRollSec = pcmRec.arm().preRollSec;
  } else {
    pcmRec = new PCMRecorder();
    try {
      await pcmRec.start({ audio: dspConstraints() }); // getUserMedia + AudioWorklet
    } catch (e) {
      try { pcmRec.cancel(); } catch { /* noop */ } // release any half-open mic stream
      throw e;
    }
  }
  /* The microphone's own name, straight from the opened track. It is the ONE thing the browser
   * path can say about the hardware — a USB interface or a headset reports a real label — and it is
   * gone the moment the stream is stopped, so it is captured here rather than at save time. Not a
   * quality claim: a label is what the OS calls the device, nothing more. */
  let micLabel = null;
  try { micLabel = pcmRec.stream?.getAudioTracks?.()[0]?.label || null; } catch { micLabel = null; }
  rec = { mode: 'pcm', pcmRec, fmt, fellBack: !!fellBack, recording: true, preRollSec, micLabel,
          // The take already contains preRollSec of audio, so the elapsed clock must start there
          // or the displayed time drifts from the file's real length.
          t0: Date.now() - Math.round(preRollSec * 1000), timer: null, blob: null, url: null };
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
    // Second, INDEPENDENT ceiling: the memory this device can actually hold (lossless path only).
    // Whichever limit comes first wins, and both stop to review with the take intact. This one is
    // a safety net rather than a policy — without it the browser kills the tab instead, which
    // loses the take silently and is not catchable, so there is no error path to fall back on.
    const mem = pcmMemStatus();
    if (mem.level === 'stop' && rec?.recording) {
      rec._memStopped = true;
      stopRecording().catch(() => {});
      return;
    }
    let warn = '';
    if (mem.level === 'warn') {
      if (!rec._memWarned) { rec._memWarned = true; toast(t('record.memWarn'), 8000); }
      warn = t('record.memLeft', { mins: Math.max(1, Math.ceil(mem.secsLeft / 60)) });
    }
    recordUI('recording', { time: fmtT(secs), warn });
  }, 250);
}

// Device types we have translated names for. Anything outside this set is displayed verbatim.
const CAPTURE_DEV_KEYS = new Set([
  'builtin_mic', 'wired_headset', 'usb_device', 'usb_accessory', 'usb_headset',
  'bluetooth_sco', 'ble_headset', 'telephony', 'unknown',
  'virtual',   // desktop only — loopback/virtual cables, never a real microphone
]);

/* Render "recorded with X" under the review player, plus an honest archival verdict.
 *
 * Deliberately shows the DEVICE first: that is the fact being tested when someone plugs in a USB
 * microphone, and it is the one the researcher cannot otherwise obtain. The archival line is only
 * drawn when the app actually knows — an older APK reports nothing, and silence must not be
 * rendered as a negative verdict. */
function showCaptureProvenance(cap) {
  const host = $('#record-status');
  if (!host) return;
  let el = document.getElementById('record-capture-info');
  if (!cap) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'record-capture-info';
    el.className = 'note record-capture-info';
    host.insertAdjacentElement('afterend', el);
  }
  const bits = [];
  // t() falls back to the KEY when a string is missing, which would print "record.cap.dev.usb_device"
  // at a field user. So only translate types we actually have strings for; show anything else raw,
  // which is at least true. The plugin can emit "type_<n>" for an Android type we have not named.
  // Prefer the ACTUAL MODEL the OS reported ("Samson Q2U") over the generic category, but show both
  // when both are known: the model alone does not tell a non-technical user whether the external mic
  // was used, which is the entire question being answered. Android's product name is often generic
  // ("USB Audio Device") or absent, so the category is a genuine fallback, not decoration.
  // An Android type we have no name for ("type_29") is meaningless to a field user. It is still
  // better than nothing when it is ALL we have, but it must never be appended to a perfectly good
  // model name — "Weird Mic 9000 (type_29)" reads as a fault in the app.
  const kindKnown = !!(cap.deviceType && CAPTURE_DEV_KEYS.has(cap.deviceType));
  const kind = kindKnown ? t('record.cap.dev.' + cap.deviceType) : (cap.deviceType || null);
  // A "model" that just restates the category adds nothing — don't print "USB Audio Device (a USB
  // microphone)".
  const modelIsUseful = cap.device && kindKnown
    && cap.device.toLowerCase().replace(/[^a-z]/g, '') !== kind.toLowerCase().replace(/[^a-z]/g, '');
  const dev = modelIsUseful ? t('record.cap.model', { model: cap.device, kind })
            : (cap.device || kind);
  if (dev) bits.push(t('record.cap.via', { device: dev }));
  if (cap.label) bits.push(cap.label);
  el.textContent = bits.join(' · ');
  el.classList.toggle('capture-warn', cap.archival === false || cap.wireless === true);
  if (cap.archival === false || cap.wireless) {
    const why = cap.archivalReason || t('record.cap.notArchival');
    el.textContent += ' — ' + why;
  }
}

// Where the current take stands against the memory this device can hold. ONLY the lossless PCM
// path accumulates in RAM — MediaRecorder flushes to disk-backed Blobs on its 3s timeslice, and
// the native path writes straight to a file — so no other mode can reach this limit.
function pcmMemStatus() {
  if (!rec || rec.mode !== 'pcm' || !rec.pcmRec) return { frac: 0, secsLeft: Infinity, level: 'ok' };
  return pcmCapStatus({
    bytesHeld: rec.pcmRec.bytesHeld(),
    bytesPerSecond: rec.pcmRec.bytesPerSecond(),
    budgetBytes: pcmRamBudgetBytes(navigator.deviceMemory),
  });
}

// Stop either capture mode and move to review. MediaRecorder finishes in its
// own 'stop' listener; the PCM path flushes its tail and builds a fast 16-bit
// WAV preview (native, instant) from the captured samples.
async function stopRecording() {
  if (!rec || !rec.recording) return;
  if (rec.mode === 'mr') {
    if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
    return;
  }
  rec.recording = false;
  clearInterval(rec.timer);
  stopMeter();
  if (rec.mode === 'native') {
    // Native hands back a complete WAV plus its provenance record. Nothing to encode.
    try {
      const { blob, meta } = await rec.nrec.stop();
      if (!blob || !blob.size) throw new Error('empty');
      rec.blob = blob;
      rec.nativeMeta = meta;
      rec.url = URL.createObjectURL(rec.blob);
      $('#record-preview').src = rec.url;
      recordUI('review');
    } catch (e) {
      discardRecording();
      recordUI('idle');
      $('#record-status').textContent = t('record.micError',
        { msg: e.message === 'empty' ? t('record.noAudio') : e.message });
    }
    return;
  }
  try {
    const { channels, sampleRate } = await rec.pcmRec.stop();
    if (!channels.length || !channels[0].length) throw new Error('empty');
    rec.channels = channels;
    rec.sampleRate = sampleRate;
    // Preview reflects what we'll save (mono/stereo) but is encoded at 16-bit, NOT 32: it exists
    // only to feed the <audio> element for a review listen and is thrown away at save — the file
    // is re-encoded from rec.channels, which is untouched, so nothing about fidelity depends on
    // it. At 32-bit this was the single largest allocation in the whole recording path (a full
    // extra copy of the take, at the widest possible depth, on top of the take itself). For the
    // 24/16-bit formats it is also a MORE honest preview, since those clamp identically.
    rec.blob = encodeWav(reduceChannels(channels), sampleRate, 16);
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

/* Everything this environment can HONESTLY say about a recording, for the file's own metadata.
 *
 * ⚠ COLLECT, NEVER ASSUME. Each field is either something the platform reported or something this
 * app did; nothing is inferred to fill a gap, because a confident wrong provenance is worse than a
 * missing one — it gets trusted. A browser cannot know its microphone's real resolution, so it does
 * not claim one; only a native shell reporting depthVerified may state a captured depth as fact.
 *
 * The native shells are the richer source BY DESIGN (Android AudioRecord / the Electron bridge open
 * the device themselves), and describeCapture() already normalises what they report — including the
 * case that matters most, an APK built before a field existed, where absence must read as "not
 * reported" and never as a negative verdict. ⚠ Read through that function only; js/native-audio.js
 * is the native contract boundary and is not to be touched from here. */
function recordingProvenance(r) {
  const nat = (r && r.mode === 'native') ? describeCapture(r.nativeMeta) : null;
  return {
    mode: nat ? 'native' : 'browser',
    platform: nativePlatform() || (isNativeShell() ? 'native shell' : 'browser'),
    app: 'FlexText Editor',
    appVersion: ENGINE_VERSION,
    native: nat,
    // Browser-path DSP. These are OUR settings, so they are facts about what we asked the browser
    // for — not a claim about what it actually did, which no web API will tell us.
    agc: !nat ? effectiveAgc() : undefined,
    nr: !nat ? !!settings.nr : undefined,
    echo: !nat ? !!settings.echo : undefined,
    normalized: !nat ? !!settings.norm : undefined,
    micLabel: (!nat && r && r.micLabel) ? r.micLabel : undefined,
  };
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
    if (rec.mode === 'native') {
      // Already a finished WAV at the exact format the device really captured — no re-encode.
      // (Auto-normalize is deliberately NOT applied: it would edit an archival master, and the
      // whole reason for the native path is an unmodified capture.)
      /* ⚠ The bext chunk is ADDED, and adds nothing to the audio: wavWithBext splices a metadata
       * chunk after `fmt ` and fixes the RIFF size — not one sample is touched, which is why this
       * does not contradict "unmodified capture". This is the take with the RICHEST provenance
       * available anywhere in the suite (real mic, routing, whether the OS processors were off,
       * whether the depth was verified), so it is the one most worth recording. On any failure the
       * untouched capture is used. */
      let natBytes = rec.blob;
      try {
        natBytes = new Blob([wavWithBext(await rec.blob.arrayBuffer(), captureBext(recordingProvenance(rec)))],
                            { type: 'audio/wav' });
      } catch { natBytes = rec.blob; }
      file = new File([natBytes], `recording-${stamp}.wav`, { type: 'audio/wav' });
    } else if (rec.mode === 'pcm') {
      // The preview blob has done its job (the review listen) and is a whole extra copy of the
      // take. Release it BEFORE allocating the encode buffer — holding both at once is a large
      // enough peak on a long take to be the thing that kills the tab, and the tab dying here
      // loses a recording the user has already decided to keep. rec.channels is deliberately NOT
      // freed: if the encode throws, the user lands back on review and Save must still work.
      const pv = $('#record-preview');
      try { pv.pause(); } catch { /* noop */ }
      pv.removeAttribute('src');
      try { pv.load(); } catch { /* noop */ }
      if (rec.url) { URL.revokeObjectURL(rec.url); rec.url = null; }
      rec.blob = null;
      // Decide mono-vs-stereo (drop a dead channel; keep real stereo) — never
      // averaging a live channel with an empty one. Then optional normalize.
      const chans = reduceChannels(rec.channels);
      if (settings.norm) normalizePeak(chans);
      const { blob, ext, mime } = await encodeRecording(chans, rec.sampleRate, rec.fmt,
        (f) => recordUI('saving', { pct: Math.round(f * 100) }), recordingProvenance(rec));
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
    // ABSORB-THEN-DELETE: grab the on-device capture path BEFORE closeRecordModal() clears `rec`.
    // The native file is released only after the bytes are safely stored below — never before,
    // because until then those bytes exist ONLY on disk and losing them loses field data.
    const nativePath = (rec.mode === 'native' && rec.nativeMeta) ? rec.nativeMeta.path : null;
    // Same reason as nativePath: grab it BEFORE closeRecordModal() clears `rec`.
    pendingCapture = (rec.mode === 'native') ? describeCapture(rec.nativeMeta) : null;
    closeRecordModal();
    if (CROWD_MODE) {
      // Crowd divert: nothing enters the shared corpus. Bundle + persist to the
      // crowd-only pending store, then submit; the finally below still runs.
      await crowdQueueAndSubmit(file, { assent, receipt, promptAudio });
      if (nativePath) await releaseCapture(nativePath);   // stored in the crowd pending store
      return;
    }
    pendingAssent = assent;
    pendingReceipt = receipt;
    pendingPromptAudio = promptAudio;
    const newId = await newDocFromAudio(file, title);
    if (nativePath) await releaseCapture(nativePath);     // now safely in IndexedDB
    // LANE A (assign-by-upload rule 4): the take + consent artifacts leave ASAP on their own zip.
    // Linked devices only — a standalone device has no upload target, and queueing would grow a
    // stuck queue bar it can never drain.
    if (newId && Sync.workerUploadTarget()) { try { await queueMediaUpload(newId); } catch { /* the Lane B catch-up re-queues it */ } }
  } catch (e) {
    recordUI('review');
    $('#record-status').textContent = t('convert.failed', { msg: e.message });
  } finally {
    savingRecording = false;
    applyUpdateIfSafe();   // take written (or failed) → now safe to apply a deferred update
  }
}

/* Which doc is having a recording attached to it AT THIS MOMENT. The Cut tab needs it: it opens
 * before the attach finishes (see newDocFromAudio) and would otherwise announce "this text has no
 * recording" about a file that is landing as it says so. */
let attachingAudioFor = null;

async function attachAudioFile(file) {
  if (!current) return;
  attachingAudioFor = current.id;
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
  /* ⚠ THE STRIPS MUST BE REBUILT, NOT JUST THE PLAYER. newDocFromAudio enters the editor BEFORE it
   * awaits this function, so when the Baseline tab first set itself up there was no media at all —
   * segmentation mode has nothing to show and correctly says so. This is the moment that stops
   * being true, and nothing else will notice: attaching audio is not a tab switch and not a
   * settings change. Without this the "Loading the recording…" line sits there for good on every
   * new text made from a file. */
  attachingAudioFor = null;
  if (segmentationEnabled() && isEditorTab(activeTab)) switchTab(activeTab);
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
  // The texts list paints "still arriving…" from pendingAudio; the arrival ticker only
  // repaints PROGRESS on existing rows. When the download completes, the row must be
  // rebuilt or the chip stays "arriving" until the next full render (i.e. a reload).
  refreshList();
  if (current && current.id === rec.id) {
    current = rec;
    if (player) player.loadedFor = null;
    if (isEditorTab(activeTab)) refreshPlayer();
    /* ⚠ SAME RE-ENTER AS attachAudioFile, SAME REASON: the open tab set itself up while the audio
     * was still arriving, and a background download completing is not a tab switch and not a
     * settings change — nothing else will notice. Without this, a text opened onto Cut mid-download
     * (landingTab now lands there — issue #9) shows "Loading the recording…" FOREVER once the bytes
     * have actually landed; refreshPlayer alone updates only the transport bar. */
    if (segmentationEnabled() && isEditorTab(activeTab)) switchTab(activeTab);
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
    if (!current || rec.id !== current.id || !isEditorTab(activeTab)) return;
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
  if (!await confirmDialog(t('task.cleanupConfirm', { n: targets.length }))) return;
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
  // (plan §A.3): no cleanup, no replace, no UI. ⚠ docId and folderId MUST be in this list —
  // stripping docId here is what silently killed the v137 same-id-everywhere fix (the adopt at
  // the new-rec branch below read a field this line had already dropped) and split every assigned
  // text into two Drive folders. folderId/assigned ride the same lane (assign-by-upload):
  // the folder id lets the first upload skip the dedupe search entirely.
  if (!interactive) task = { title: task.title, audioUrl: task.audioUrl, flextextUrl: task.flextextUrl, audioId: task.audioId, flextextId: task.flextextId, docId: task.docId, folderId: task.folderId, assigned: task.assigned };

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
    if (task.folderId) current.driveFolderId = task.folderId;   // upload echoes it — dedupe search never runs
    if (task.assigned) current.assigned = true;
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
  // ⚠ ADOPT the researcher's assign id as this doc's identity when one was given. The panel keys
  // EVERYTHING on that id — the history log, the assigned-audio cache, and the per-text Drive
  // folder tag. Minting a fresh guid here (the old behaviour) split every assigned text into two
  // identities: the panel's id (history "Assigned" row, audio cache, assign-copy folder) and the
  // device's id (inventory, uploads — which then landed in a SECOND Drive folder). One text, two
  // folders, and no menu could see the other half. Same id everywhere is the fix; the guid remains
  // for docs the user creates locally, which have no researcher identity.
  const rec = { id: task.docId || newGuid(), title: task.title || doc.title || '', created: Date.now(), modified: Date.now(), doc };
  rec.doc.title = rec.title;
  // Assignment identity beyond the id (assign-by-upload): the Drive folder the panel already
  // created (first upload verifies it by files.get — no tag search, no "Title (n)" duplicates)
  // and the assigned mark that keeps researcher-delivered audio off the upload lanes.
  if (task.folderId) rec.driveFolderId = task.folderId;
  if (task.assigned) rec.assigned = true;
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
  else refreshList();
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
    /* v327: a fetch REJECTION (TypeError — no HTTP response at all) gets its OWN message. It is
     * the CORS/origin-blocked shape as much as the offline shape, and a browser cannot tell them
     * apart — so "not arrived yet, still retrying" hid a permanent configuration failure behind a
     * message promising progress. Still transient (it keeps retrying), but now it says the
     * connection was REFUSED rather than merely slow. */
    /* ⚠ v329: SAY WHY, ALWAYS. Every non-fatal failure used to retry in silence behind "the text
     * has not arrived yet", which promises progress — so an HTTP 401 (wrong relay token), 403
     * (origin not allow-listed), 404 (file not shared) and a genuine outage were ONE
     * indistinguishable message, and each guess cost a field round-trip. The real reason is
     * already in e.message ("HTTP 401", "NetworkError…", "Timed out…") — show it. Still transient
     * (it keeps retrying); the researcher just learns which of those it is. */
    toast(t('task.ftRetryReason', { msg: e.message || '?' }), 12000);
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
  // Apply from the textarea only when the textarea IS the live editor — DOM truth, not setting
  // truth. In strip mode the doc is edited directly on every keystroke, and during a LIVE
  // settings flip the setting has already changed while the screen still shows the previous
  // editor: keying this guard off segmentationEnabled() made the OFF-flip read the hidden,
  // empty textarea and reconcile the doc's text to NOTHING (caught in v158 verification).
  // Conversely the ON-flip must still run: the visible textarea may hold unsaved keystrokes.
  const ta = $('#baseline-text');
  if (!ta || ta.hidden) return;
  const text = ta.value;
  /* ⚠ BLANK LINES ARE DATA WHEN THE DOC CARRIES TIME ALIGNMENT — do not filter them (Seth's
   * round-trip corruption, 2026-08-16). In a classic transcription a blank textarea line is a
   * separator and dropping it is right. But an ALIGNED doc's blank lines are real timed spans
   * (silence), 1:1 with doc.segments — and this textarea IS the live editor for exactly such a doc
   * whenever it opens before its audio attaches (the pair-import flow: text first, then audio).
   * Filtering there deleted every blank paragraph, and the span list then truncated positionally —
   * 53 lines/23 blanks became 30 lines paired against the first 30 spans, silences included, with
   * the recording "ending" a half-minute early. Reproduced with the field file before fixing.
   * Gate on DOC truth (does it carry spans/offsets), not on the segmentation setting — the same
   * rule the ta.hidden guard above follows, and it protects an aligned doc on a device where
   * segmentation is OFF just the same. */
  const aligned = (current.doc.segments || []).length > 0
    || current.doc.paragraphs.some((p) => (p.segments || []).some(
      (s) => s.attrs && s.attrs['begin-time-offset'] != null));
  const paras = text.split('\n').map(s => s.trim()).filter((s, i, arr) => aligned || s || arr.length === 1);
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
      if (!seg.words.length && !seg.baseline.trim()) {
        // Blank line: in segmentation mode it IS a line — a timed span (usually silence) that must
        // hold its slot here, because decorateGlossSegments pairs .segment groups to doc.segments
        // POSITIONALLY. Skipping it (the classic behaviour, kept when segmentation is off) shifted
        // every waveform after a blank onto the wrong gloss/free line (Seth's misalignment report).
        // A placeholder row: numbered, dimmed label, nothing to gloss — but the slot, and the
        // skinny waveform the decorator will attach to it, exist.
        if (segmentationEnabled()) {
          any = true;
          segnum++;
          body.appendChild(renderBlankSegment(segnum));
        }
        continue;
      }
      any = true;
      segnum++;
      body.appendChild(renderSegment(seg, segnum, vernFont, analFont));
    }
  }
  $('#gloss-empty').hidden = any;
}

function renderBlankSegment(segnum) {
  const div = document.createElement('div');
  div.className = 'segment seg-blank';
  const row = document.createElement('div');
  row.className = 'word-row';
  const num = document.createElement('span');
  num.className = 'segnum';
  num.textContent = segnum;
  const lbl = document.createElement('span');
  lbl.className = 'blank-label';
  lbl.textContent = t('gloss.blankLine');
  row.append(num, lbl);
  div.appendChild(row);
  return div;
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
      link.addEventListener('click', async () => {
        const a = seg.words[i], b = seg.words[i + 1];
        if (!await confirmDialog(t('gloss.confirmMerge', { a: a.txt, b: b.txt }))) return;
        captureUndo();          // v332: chaining words is undoable like every other structural edit
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
  /* ⚠ THE FREE TRANSLATION IS PART OF THE SAME WALK. Without this it had no Tab handler at all, so
   * Tab out of it fell back to the native order — which is the next BUTTON, not the next gloss.
   * focusNextWordGloss walks '.gloss-input, .free-input' in DOM order, so the last gloss of a line
   * tabs into its own free translation and the free translation tabs on to the next line's first
   * gloss, with Shift+Tab exactly in reverse (Seth, 2026-08-13).
   *
   * ⚠ Tab ONLY. Enter and Space keep their ordinary meaning in a free-translation box — it is a
   * sentence of prose, not a word gloss, so a space must remain a space. */
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    focusNextWordGloss(input, e.shiftKey ? -1 : 1);
  });
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
      /* ⚠ YIELD AT BOUNDARIES IN SEGMENTATION MODE (v322). decorateGlossSegments attaches a second
       * keydown on this same input that SPLITS the line when the caret is at the start/end — and
       * both listeners fire (preventDefault does not stop a sibling listener). Pre-v322 this one
       * moved focus first and the split then re-rendered, discarding it. Boundary Enter belongs to
       * the split; mid-text Enter keeps the FLEx-style focus walk. */
      const atStart = g.selectionStart === 0 && g.selectionEnd === 0;
      const atEnd = g.selectionStart === g.value.length && g.selectionEnd === g.value.length;
      if (segmentationEnabled() && (atStart || atEnd)) return;
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
    un.tabIndex = -1;
    un.title = t('gloss.breakTitle');
    un.textContent = t('gloss.breakLabel');
    un.addEventListener('click', () => {
      captureUndo();          // v332: unchaining too
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

/* Tab / Space navigation. v347: this used to walk `.gloss-input` ONLY, skipping the
 * free-translation line "like FLEx" — so tabbing off the last gloss of a sentence jumped straight to
 * the first gloss of the NEXT sentence and the free translation could only be reached with the
 * mouse or with Enter.
 *
 * Seth, 2026-08-13: "after the last gloss, it should tab to the free translation, not skip over the
 * free translation to the first gloss of the next segment." So the free line is now part of the
 * walk, which makes Tab agree with Enter (focusNextGloss) instead of quietly disagreeing with it.
 *
 * ⚠ The ORDER comes from the DOM, not from the selector: querySelectorAll with a comma-separated
 * selector returns document order, so this is gloss, gloss, …, free, then the next sentence. Writing
 * it as two separate queries and concatenating would put every free line after every gloss — the
 * same list, in an order that makes no sense to a typist. */
function focusNextWordGloss(fromInput, dir) {
  const all = $$('#gloss-body .gloss-input, #gloss-body .free-input');
  const idx = all.indexOf(fromInput);
  const next = all[idx + dir];
  if (next) { next.focus(); next.select?.(); }
}

/* ---------------- Save and send ---------------- */

/* Which save/send buttons THIS device shows — settings.sendOptions, set either by a researcher
 * push, a link, or (since v289) the device's own Settings tab. Absent or empty means all of them.
 *
 * ⚠ 'download' IS A LEGACY ALIAS OF 'save', NOT A SEPARATE CAPABILITY (Seth, 2026-08-07). They were
 * two checkboxes that could never both take effect: the share menu showed the file PICKER when the
 * browser had one and a blind download only when it did not, so the second was a fallback for the
 * first rather than a peer. Worse, `save` alone on Firefox — which has no showSaveFilePicker —
 * produced a share menu with NO BUTTONS IN IT, so "Done · Send" appeared to do nothing at all.
 *
 * Now ONE setting, one button, and the button quietly uses whichever mechanism the browser has.
 * The old value is still READ so that devices already carrying it, and any link that still sends
 * `send=download`, keep working — it must never be written again. */
function allowedSend() {
  const stored = settings.sendOptions?.length ? settings.sendOptions : SEND_OPTIONS;
  const out = new Set(stored);
  if (out.has('download')) out.add('save');     // legacy alias — a device set up before v297
  return out;
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
  set('#btn-new-pair', 'pair');
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
/* REPAINT WHICHEVER LIST THIS APP ACTUALLY HAS.
 *
 * ⚠ THERE WERE EIGHT COPIES OF `if (RECORD_MODE) renderRecordList(); else renderDocList()`, and
 * every one of them was a latent crash in the two satellite apps: renderDocList() reads #doc-list
 * and #doc-list-empty unguarded, and neither exists in the Consent Collector or the Audio
 * Segmenter. Nothing had reached them yet only because those apps fork before the editor wiring —
 * so the first satellite feature to call a shared path (deleting a text, below) would have been the
 * one to find out. Five modes, one place, and the next mode added is one edit rather than nine.
 *
 * Researcher-controlled, default ON when this device has no researcher session at all — an unpaired
 * device is somebody working alone, and there is nobody to ask for permission. */
function refreshList() {
  if (CONSENT_MODE) return ccRenderList();
  if (SEGMENTER_MODE) return sgRenderList();
  if (RECORD_MODE) return renderRecordList();
  return renderDocList();
}

function allowDeleteOn() { return !Sync.hasSession() || settings.allowDelete === true; }
// Researcher-controlled: may this device add a blank text line in the matcher? Same shape and
// default as the two below — on when there is no researcher session.
function allowBlankLinesOn() { return !Sync.hasSession() || settings.allowBlankLines === true; }
// Researcher-controlled: may this device swap a text's recording for a different file?
// Same shape and same default as allowDeleteOn — unpaired means working alone, so it is on.
function allowAudioSwapOn() { return !Sync.hasSession() || settings.allowAudioSwap === true; }
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
    refreshList();
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

// The coworker's own per-text delete button. SAFE by default: confirm, then if uploading
// is configured and this text isn't already provably on Drive, make ONE final upload and
// remove it only once that's CONFIRMED (never lose un-uploaded or edited-since work) — the
// same upload-first path as the researcher's remote delete. A standalone device (no upload
// target) just deletes locally. Used by both the editor list and the recorder list.
async function userDeleteDoc(docId, title) {
  const d = await db.getDoc(docId).catch(() => null);
  const uploads = !!Sync.workerUploadTarget();
  const backedUp = d && d.uploadedFileId && d.uploadedModified === d.modified;
  const willUpload = d && uploads && !backedUp;
  const msg = willUpload
    ? t('texts.confirmDeleteUpload', { title: title || t('untitled') })
    : t('texts.confirmDelete', { title: title || t('untitled') });
  if (!await confirmDialog(msg)) return;
  if (!d || !uploads || backedUp) {
    // Nothing to preserve (gone / no upload target / already safely on Drive) → remove now,
    // cancelling any stray queued upload so it can't resurrect.
    const up = getUpload(docId); if (up) up.cancel(); else uploadView.delete(docId);
    if (current && current.id === docId) current = null;
    await db.deleteDoc(docId).catch(() => {});
    renderUploadQueue();
    refreshList();
    Sync.reportNow();
    return;
  }
  // Uploading configured + changed/never-sent → final upload, delete once it lands (survives
  // reloads via pendingUpDel; the upload-done hook + boot sweep finish the removal).
  const ids = pendingUpDel();
  if (!ids.includes(docId)) { ids.push(docId); setPendingUpDel(ids); }
  toast(t('texts.deleteUploadFirst'), 6000);
  if (!(uploadView.has(docId) || getUpload(docId))) {
    if (current && current.id === docId) await doUpload(true);
    else await uploadDocById(docId);
  }
  refreshList();
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
  const segBefore = settings.segmentation === true;
  settings = loadSettings();
  if (RECORD_MODE) { renderRecordView(); renderRecordList(); }   // recorder paints its own Delete-All (gated) in renderRecordView
  else {
    applyResearchVisibility(); applyAllowedButtons(); fillDeviceSetup(); renderDocList(); applyDeleteAllButton(); applyInviteButton(); applyDoneButton();
    applyCutTabVisibility();   // a pushed cutTab toggle adds/removes the tab without a reload
    applyCutHint();            // …and a pushed backspaceJoin re-words the hint it gates, in place
    // A pushed segmentation toggle takes effect LIVE if the coworker is sitting in the editor:
    // re-enter the visible tab so strips appear/hide without a reload. Gated on the actual flag
    // changing — a plain settings broadcast must never yank the caret mid-typing. currentView()
    // (not activeTab) so a user on the Texts list is never pulled into the editor.
    const v = currentView();
    if (current && (v === 'cut' || v === 'baseline' || v === 'gloss') && (settings.segmentation === true) !== segBefore) {
      switchTab(v);
    }
  }
}

// "Delete All" (full local wipe = clears storage + IndexedDB + caches + the service worker, then reloads
// to a blank slate — also the self-service un-brick for a stale SW). Available on STANDALONE (unlinked)
// apps by default; on a MANAGED device only if the researcher enabled it for that device (settings
// .deleteAllEnabled). Off by default for managed devices.
function deleteAllAllowed() {
  /* ⚠ adminUnlocked() OVERRIDES the researcher's setting, on purpose — see the admin drawer. The
   * default (off for managed devices) protects a coworker from wiping their own work; it must not
   * also stop the researcher holding that same phone from recovering it. */
  return !Sync.hasSession() || loadSettings().deleteAllEnabled === true || adminUnlocked();
}
async function runDeleteAll() {
  if (!await confirmDialog(t('delall.confirm'))) return;
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
  refreshList();
}

// The researcher revoked this device — the sync engine auto-released the binding (poll saw 410). Scrub
// the researcher's Google Drive links from local settings (item C: never keep a Drive folder we can no
// longer use), re-render (the device is standalone again → the Settings tab returns), and tell the user.
function onSyncRevoked() {
  const s = loadSettings();
  /* ⚠ consentAudioFile goes too. While this device was managed, the researcher's Drive prompt was
   * fetched into the SAME media key a locally-picked file uses, overwriting it. So a leftover
   * consentAudioFile record would name a file whose bytes are no longer there — the Settings tab
   * would claim a local prompt is in force and play the ex-researcher's audio. Drop the claim; the
   * user re-picks a file, which is honest and takes one tap. */
  for (const k of ['uploadFolder', 'uploadUrl', 'consentAudio', 'consentAudioUrl', 'consentAudioFile']) delete s[k];
  saveSettings(s);
  settings = loadSettings();
  applyLiveSettings();
  toast(t('sync.revoked'), 8000);
}

// Apply ONE researcher command through the existing idempotent, never-clobber handlers.
async function syncDispatch(cmd) {
  switch (cmd && cmd.type) {
    case 'assign': {
      // assigned marks the doc as researcher-delivered from birth: assigned-from-Drive audio
      // never re-uploads, and Lane B keeps its flextext bare (assign-by-upload rule 4).
      // folderId (new panels only) is the per-text Drive folder minted at assignment upload —
      // stamping it before the FIRST device upload means the dedupe search never runs at all.
      const task = { title: cmd.title || '', docId: cmd.id || '', folderId: cmd.folderId || '', assigned: true };
      if (cmd.audioUrl) { task.audioUrl = resolveAudioInput(cmd.audioUrl); task.audioId = cmd.id; }
      if (cmd.flextextUrl) { task.flextextUrl = resolveAudioInput(cmd.flextextUrl); task.flextextId = cmd.id; }
      if (task.audioUrl || task.flextextUrl) await openUrlTask(task, 'background');
      break;
    }
    case 'delete':
      await deleteConfirmedDoc(cmd.docId || cmd.id);
      break;
    case 'setDone':
      // Researcher toggles finished-state from the panel. Reuses the device's own setDocDone (v100)
      // so the auto-delete-after-upload gating and confirm rules behave exactly as a local tap.
      await setDocDone(cmd.docId || cmd.id, !!cmd.done);
      break;
    case 'changeSettings': {
      // MERGE only the researcher-supplied keys; never a whole-object overwrite that
      // would wipe a power-user's relayWorker / uploadFolder (plan §F.1).
      const s = loadSettings();
      /* ⚠⚠ A REMOTE COMMAND MAY NEVER SET A CONTROL-PLANE KEY. `relayWorker` is what workerBase()
       * returns — the origin this device polls, reports to and uploads to. A pushed settings patch
       * that could set it would hand whoever sent it the device's entire backend: the install
       * credentials on the next poll, every recording and text thereafter, and a fabricated desired
       * lane answering { wipe: true }, which sync.js honours before every gate. The 2026-08-21 sweep
       * demonstrated exactly that from a member holding only manageDevices.
       *
       * ⚠ THIS HAS TO LIVE HERE, not in the worker. Settings are E2EE — the worker stores ciphertext
       * and cannot inspect what it is forwarding, so it can never allow-list these keys. The device
       * is the only place that sees them in the clear, which makes it the only place the rule can be
       * enforced. The worker's matching check (a payload must be encrypted) is defence in depth, not
       * the fix.
       *
       * ⚠ It is a REFUSAL, not a silent strip: a researcher who pushed one needs to know it did not
       * apply. Setting it locally — the settings UI, a dev URL — is untouched and still works. */
      const REMOTE_FORBIDDEN = ['relayWorker'];
      const patch = { ...(cmd.settings || {}) };
      const refused = REMOTE_FORBIDDEN.filter((k) => Object.prototype.hasOwnProperty.call(patch, k));
      for (const k of refused) delete patch[k];
      if (refused.length) {
        try { console.warn('changeSettings: refused control-plane key(s)', refused.join(', ')); } catch { /* noop */ }
        try { toast(t('sync.settingsKeyRefused', { keys: refused.join(', ') }), 8000); } catch { /* noop */ }
      }
      Object.assign(s, patch);
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
      else if ((m = k.match(/^flextext-paragraph-(.+)$/))) out.paragraph = m[1];   // before the generic flextext-* (editor) match
      else if ((m = k.match(/^flextext-(.+)$/))) out.editor = m[1];
    }
    return out;
  } catch { return null; }
}

/* Subtle always-on version badge in the bottom-right corner: the app's name and the ENGINE version,
 * in every mode. Informational only — pointer-events:none so it never intercepts a tap.
 *
 * ONE NUMBER, everywhere (Seth, 2026-08-19: "we don't need to track those separate versions
 * anymore — the version is good enough"). The researcher and paragraph apps used to read
 * "engine/shell" and the recorder showed its own shell number alone. Two reasons that is gone:
 *
 *  - It was redundant. version-sync makes every satellite's VERSION and ENGINE move together in the
 *    same commit, so the shell counter is a fixed relabelling of the engine number that only the
 *    source tree can decode. "researcher v231" answers no question a bug report asks; every other
 *    surface in the suite — the live-version strip, a device's reported version, the stale badge,
 *    the changelog — already talks in ENGINE versions.
 *  - The dropped half was the UNRELIABLE half. `listCachedApps()` reads cache NAMES, which a
 *    stale-body precache can make lie; ENGINE_VERSION is compiled into the i18n module actually
 *    running. See syncGatherInventory, which reports both for exactly that reason — the panel's
 *    cross-app staleness signal still gets `cachedApps`, and it is read there beside the
 *    authoritative number rather than shown alone on a screen. */
/* WHO MADE THIS FILE — one string, for every export that can carry provenance.
 *
 * Seth, 2026-09-03: "Our apps should leave metadata 'created by...' in exported files whenever the
 * schema or file format allows that." The immediate reason is an hour I had just wasted: asked what
 * FLEx's numbering looks like, I measured 95 .flextext files from the corpus and concluded we
 * matched it — then found that 68 of them had been written by THIS SERIALIZER, identifiable only by
 * its indentation. The conclusion was circular and the provenance had to be reverse-engineered from
 * whitespace. A file that says what wrote it answers that in one line, years later, to somebody who
 * has never seen this repo.
 *
 * The app NAME matters as much as the version: five apps share this engine, and "which of them
 * produced this" is exactly what a mixed corpus stops being able to tell you.
 *
 * ⚠ NOT read from module state by seg-exports — that module takes provenance as a PARAMETER by
 * design (see its note: "the old version read app.js module state directly, which is exactly what a
 * second writer cannot do"). This is the value the callers pass in. */
function producedBy() {
  const key = RESEARCHER_MODE ? 'research.appName'
    : RECORD_MODE ? 'record.appName'
    : PARAGRAPH_MODE ? 'para.appName'
    : CONSENT_MODE ? 'consentapp.appName'
    : SEGMENTER_MODE ? 'segapp.appName'
    : 'app.name';
  // English deliberately, not t(): this is a provenance record for an archive, not UI text, and it
  // must read the same to whoever opens the file — which is not necessarily who made it.
  const en = { 'research.appName': 'Flextext Researcher', 'record.appName': 'Flextext Recorder',
               'para.appName': 'Flextext Paragraph Analysis Tool',
               'consentapp.appName': 'Flextext Consent Collector',
               'segapp.appName': 'Flextext Audio Segmenter', 'app.name': 'Flextext Editor' };
  return `${en[key]} ${ENGINE_VERSION}${BUILD_TAG ? ' (' + BUILD_TAG + ')' : ''}`;
}

function showAppVersion() {
  const name = RESEARCHER_MODE ? 'researcher'
    : RECORD_MODE ? 'recorder'
    : PARAGRAPH_MODE ? 'paragraph'
    : CONSENT_MODE ? 'consent'
    : SEGMENTER_MODE ? 'segmenter'
    : 'editor';
  let ver = ENGINE_VERSION;
  /* On a feature/staging build the human-facing name of the build LEADS, with the numeric version
   * kept after it — the number is still what every bug report, device report and deploy-order rule
   * is written in, so it must not disappear. Production has no tag and reads exactly as before. */
  if (BUILD_TAG) ver = BUILD_TAG + ' \u00b7 ' + ver;
  let el = document.getElementById('app-version');
  if (!el) { el = document.createElement('div'); el.id = 'app-version'; el.className = 'app-version'; (document.body || document.documentElement).appendChild(el); }
  el.textContent = name + ' ' + ver;
}

// Inventory for the report. The whole blob is E2EE-encrypted before it leaves the device
// (sync.js), so the actual title + a researcher-relevant settings snapshot ride along: only
// the Ki holder (the researcher) can read them — the Worker/D1 see ciphertext. titleHash is
// kept too (legacy / change-gate). No audio bytes; stable fields so an unchanged list never writes.
async function syncGatherInventory() {
  /* Which docs still have bytes in the queue. Read from the PERSISTED queue rather than the
   * in-memory view: the persisted record is the durable one (it survives a reload and is deleted
   * only on completion), and it carries the real docId — the view is keyed by upload key, which for
   * an original is "<key>:<slot>" and would not match a doc id. */
  const stillUploading = new Set();
  for (const it of await listPendingUploads().catch(() => [])) {
    const id = (it && it.rec && it.rec.docId) || (it && it.docId) || '';
    if (id) stillUploading.add(id);
  }

  const metas = await db.listDocs();
  const enr = Sync.enrollment();
  const upDel = new Set(pendingUpDel());   // a delete is in flight (upload-first) but not yet confirmed
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
      pendingDelete: upDel.has(d.id),   // panel shows it struck-through/faded until it's gone
      // 'uploaded' when the exact state is on Drive — by timestamp, or by content signature
      // (heals docs whose modified drifted past the upload with no content change, e.g. a
      // persist() tick landing mid-upload; the strict delete-safety checks stay timestamp-only).
      /* ⚠ "uploaded" MEANS ALL OF IT, NOT THE FIRST FILE (Seth, 2026-09-01: the chip "changes to
       * uploaded before all the files have finished uploading… audio is still uploading, but the
       * text registers uploaded"). He guessed the cause exactly: a doc is NOT one upload. Since the
       * v2 source package it is the main file PLUS one queue entry per original — see the
       * "individual role-tagged files in <Storyname>/originals/" note — and uploadedFileId /
       * uploadedSig are stamped when the MAIN one lands. With audio still in the queue the chip
       * already read "uploaded ✓", which tells a researcher the recording is safe when it is not.
       * That is the one direction this chip must never be wrong in. */
      uploadState: stillUploading.has(d.id)
        ? 'uploading'
        : (backed ? ((d.uploadedModified === d.modified || (d.uploadedSig && d.uploadedSig === uploadContentSig(d))) ? 'uploaded' : 'changed') : 'local'),
      uploadedFileId: d.uploadedFileId || null,
      // Which mic this take came from + whether it is archive grade (native captures only; null
      // everywhere else). E2EE like the rest of the inventory. Lets a researcher audit provenance
      // long after the fact, and see at a glance whether a deployed USB mic is actually being used
      // on that device — which is the question this whole readout exists to answer.
      capture: d.capture || null,
    });
  }
  // The settings the researcher panel can view/prefill for this device (encrypted in transit).
  const snap = {};
  for (const k of ['vernLang', 'vernName', 'vernFont', 'analLang', 'analName', 'analFont',
                   'recordFormat', 'agc', 'nr', 'echo', 'norm',
                   'consentAsk', 'consentConfirm', 'consentMode', 'consentMsg', 'consentResp', 'consentAudioUrl',
                   'appLang', 'uploadFolder', 'toolbarButtons', 'sendOptions', 'autoDelUploaded', 'recordWelcome', 'deleteAllEnabled',
                   'autoBackup', 'autoBackupMins', 'maxRecordSeconds', 'allowDelete', 'doneEnabled', 'sortAlpha',
                   'segmentation', 'backspaceJoin', 'cutTab', 'landOnCut', 'joinSplitBaseline', 'joinSplitGloss', 'cutJoinTexted', 'exportEaf', 'exportSaymore', 'exportPreview', 'exportJson']) {
    if (settings[k] !== undefined) snap[k] = settings[k];
  }
  // ua + cachedApps let the panel show which browser/device this install is + whether its apps are
  // current (so the researcher can tell if a coworker hasn't updated). Both are E2EE in the report.
  // engineVersion is the TRUE running engine version (vs cachedApps, which reads cache NAMES that a
  // stale-body precache can make lie) — the reliable brick/stale signal. All E2EE in the report.
  return { type: RECORD_MODE ? 'recorder' : 'editor', items, settings: snap,
           ua: navigator.userAgent, cachedApps: await listCachedApps(), engineVersion: ENGINE_VERSION,
           // Which shell this install runs in. Each shell is its own storage sandbox, so the
           // panel must be able to tell a PWA apart from an APK on the same handset.
           platform: nativePlatform(), nativeEngine: nativeEngineInfo() };
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
      else showInviteConsent();                                  // B: the field user must approve this enrollment
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

/* ── THE EDITOR'S OWN CONFIRM ─────────────────────────────────────────────────────────────────────
 *
 * The panel replaced its sixteen native dialogs long ago; the editor's nine outlived them, which is
 * backwards — the editor is the app a field transcriber uses all day, often on an Android phone
 * where a system dialog is the most jarring thing on screen and its buttons are the smallest.
 * (In-app Known issue, cleared here.)
 *
 * ⚠ `class="modal"` IS LOAD-BEARING, not styling. The editor's global key handler treats
 * `.modal:not([hidden])` as "a dialog owns the keyboard" — that is what stops Space from playing the
 * recording behind an open dialog and Enter from cutting audio (see the transport-keys comment).
 * A confirm built without that class would be a dialog the spacebar plays straight through.
 *
 * ⚠ AND IT NEVER STACKS. A second confirm while one is open resolves FALSE rather than opening a
 * dialog over a dialog: the caller asked "may I do this destructive thing", and the honest answer
 * when we cannot ask cleanly is no. (Same never-stack guard as showInvitePasteModal below.)
 *
 * Escape and the backdrop mean CANCEL — the safe answer for every one of the nine callers, all of
 * which guard a destructive or irreversible act. */
function confirmDialog(message) {
  return new Promise((resolve) => {
    if (document.querySelector('[data-confirm-dialog]')) { resolve(false); return; }
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.dataset.confirmDialog = '1';
    wrap.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true">
      <p style="white-space:pre-wrap">${esc(message)}</p>
      <button class="primary-btn" data-cf="ok">${esc(t('panel.confirm.ok'))}</button>
      <button class="link-btn" data-cf="cancel">${esc(t('share.cancel'))}</button>
    </div>`;
    document.body.appendChild(wrap);
    const prevFocus = document.activeElement;
    let done = false;
    const finish = (answer) => {
      if (done) return;                       // Escape + click can both fire; the first one wins
      done = true;
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch { /* noop */ }
      resolve(answer);
    };
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    }
    document.addEventListener('keydown', onKey, true);
    wrap.querySelector('[data-cf="ok"]').addEventListener('click', () => finish(true));
    wrap.querySelector('[data-cf="cancel"]').addEventListener('click', () => finish(false));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) finish(false); });
    // Focus the dialog's own button, so the keyboard is inside the dialog immediately and Tab
    // cannot wander back into the editor underneath it on the first press.
    try { wrap.querySelector('[data-cf="ok"]').focus(); } catch { /* noop */ }
  });
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

/* THE PAIRING BANNER — the code, in large type, for as long as the pairing is unfinished.
 *
 * Seth, 2026-08-20: "show a large type, 6 digit random code that is persistent and visible on both
 * devices until both ends have approved the pairing."
 *
 * ⚠ THE BUG THIS REPLACES, stated plainly because it is easy to reintroduce: the device's code used
 * to live ONLY inside a 12-second toast. No screen in the editor would show it again — not Settings,
 * not Help — while the researcher's panel went on refusing to approve until the coworker read it
 * aloud. Someone who blinked was not inconvenienced, they were STUCK, and the only correct move left
 * was to refuse. A value another party depends on must never be carried by a transient control.
 *
 * ⚠ SO IT COMES DOWN ON THE OUTCOME, NEVER ON A CLOCK — the same rule the panel's pending markers
 * follow. Sync.pairCode() is '' once the poll has seen the approval, and that is the only thing that
 * retires this. */
/* THE DEVICE'S OWN NAME, in the title bar (Seth, 2026-08-20).
 *
 * > "we also need a way to be 100% sure that the device we're using DOES in fact match the device
 * >  listed in the tile… the Title after Flextext Editor or Flextext Recorder also lists the
 * >  'device nickname' after it that the researcher put in the researcher panel."
 *
 * ⚠ WHY THIS IS WORTH A WORKER FIELD. The panel names devices and the device was never told, so the
 * only way to identify the install in front of you was to compare engine versions and guess. That
 * ambiguity produced a genuine scare during the v439 test drive: an editor showing an empty text
 * list could not be told apart from a DIFFERENT editor, in another browser profile, that had simply
 * never held those texts. IndexedDB is per-origin and the doc store is not session-scoped, so the
 * two are indistinguishable from the outside — for several minutes it looked like unpairing had
 * destroyed a coworker's work. A name on screen ends that in one glance.
 *
 * ⚠ APPENDED, NEVER textContent ON THE TITLE. The editor's .app-title contains the logo <img>;
 * rewriting its text would delete the logo. Its own element, created once. */
function refreshDeviceName() {
  const host = document.querySelector('.app-title');
  if (!host) return;
  const name = (typeof Sync !== 'undefined' && Sync.deviceNickname) ? Sync.deviceNickname() : '';
  let el = host.querySelector('.app-device');
  if (!name) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('span'); el.className = 'app-device'; host.appendChild(el); }
  el.textContent = name;
  /* The full sentence for a screen reader: visually this reads as a continuation of the app name,
   * but announced on its own it is just a bare person's name with no context. */
  el.setAttribute('aria-label', t('device.nameAria', { name }));
}

let pairBannerEl = null;
function refreshPairBanner() {
  const code = (typeof Sync !== 'undefined' && Sync.pairCode) ? Sync.pairCode() : '';
  if (!code) { if (pairBannerEl) pairBannerEl.hidden = true; return; }
  if (!pairBannerEl) {
    pairBannerEl = document.createElement('div');
    pairBannerEl.id = 'pair-banner';
    pairBannerEl.className = 'pair-banner';
    /* aria-live so the code is ANNOUNCED when it appears, and role=status rather than alert: this is
     * a standing state to be read at leisure, not an interruption. */
    pairBannerEl.setAttribute('role', 'status');
    pairBannerEl.setAttribute('aria-live', 'polite');
    (document.body || document.documentElement).appendChild(pairBannerEl);
  }
  /* ⚠ SPACED-OUT DIGITS FOR THE SCREEN READER ONLY. "420349" is read as four hundred and twenty
   * thousand three hundred and forty-nine, which nobody can compare against a panel; "4 2 0 3 4 9"
   * is. The visible text stays unspaced so the two screens look identical. */
  pairBannerEl.innerHTML = `<div class="pair-banner-title">${esc(t('pair.title'))}</div>`
    + `<div class="pair-code" aria-label="${esc(t('invite.codeAria', { code: code.split('').join(' ') }))}">${esc(code)}</div>`
    + `<div class="pair-banner-note">${esc(t('pair.note'))}</div>`;
  pairBannerEl.hidden = false;
}

// The editor's entry point for the paste flow: a link at the bottom of the Help
// view (admin territory, reachable via "?"), shown only while UNenrolled — the
// recorder paints its own copy inside renderRecordView.
function applyInviteButton() {
  // ⚠ PUT IT WHERE THE PERSON ACTUALLY IS. This used to live ONLY at the bottom of the help screen,
  // so enrolling an editor meant knowing to open Help first — while the recorder paints the same
  // button straight onto its main view. Same feature, two very different chances of being found,
  // and the editor's was effectively hidden (Seth: "it's buried in the help modal").
  //
  // The toolbar copy is the discoverable one; the help copy stays for anyone who went looking there.
  // Both disappear once the device is enrolled, since claiming twice is not a thing.
  const enrolled = Sync.hasSession();

  const place = (host, id, cls) => {
    if (!host) return;
    let btn = document.getElementById(id);
    if (enrolled) { if (btn) btn.hidden = true; return; }
    if (!btn) {
      btn = document.createElement('button');
      btn.id = id; btn.type = 'button'; btn.className = cls;
      btn.addEventListener('click', showInvitePasteModal);
      host.appendChild(btn);
    }
    btn.textContent = t('invite.pasteBtn');
    btn.hidden = false;
  };

  // The editor's main screen — the toolbar it already uses for New text / Record.
  place(document.querySelector('#view-texts .toolbar'), 'btn-paste-invite-bar', 'secondary-btn');
  // The original help-screen copy, kept so nobody who learned that route loses it.
  place($('#view-help'), 'btn-paste-invite', 'secondary-btn delall-btn');
}

// B (enrollment consent): show WHO is enrolling this device (Google name + avatar) and require the
// field user to Accept before anything flows — the worker won't deliver the data key until they do,
// so a phished/hijacked invite is inert without a deliberate human OK. Re-shown on reload until decided.
function showInviteConsent() {
  if (document.querySelector('[data-invite-consent]')) return;   // never stack
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.dataset.inviteConsent = '1';
  /* ⚠ THE RESEARCHER'S NAME, EMAIL AND FACE ARE NO LONGER SHOWN HERE (Seth, 2026-08-20). This
   * screen used to answer "do you recognise this person?" with a photo and an address, which put a
   * named individual's contact details on the lock screen of every device that opens an invite
   * link — including one that later leaves the team's control. Minimising what a device carries
   * about the people in a project is part of the privacy and research-ethics obligations this suite
   * owes the communities it serves.
   *
   * ⚠ AND THE CHECK IT REPLACES IS STRONGER, not merely quieter. "Do you recognise this face" is
   * answerable by anyone who has seen the researcher's public profile; "does this number match the
   * one on their screen" is answerable only by someone actually in contact with them, about THIS
   * pairing. The code is what the person is asked to verify, so the code is what this screen shows.
   *
   * ⚠ `researcher` is still ACCEPTED and still stored on the session — the recorder's own flow and
   * the worker response both carry it, and removing it here is a UI decision, not a protocol one. */
  const code = Sync.pairCode();
  const codeBlock = code
    ? `<p class="note">${esc(t('invite.codeIntro'))}</p><div class="pair-code" role="text" aria-label="${esc(t('invite.codeAria', { code: code.split('').join(' ') }))}">${esc(code)}</div>`
    : `<p class="note">${esc(t('invite.codeMissing'))}</p>`;
  wrap.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true">
    <h3>${esc(t('invite.title'))}</h3>
    ${codeBlock}
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
      /* ⚠ NO TOAST WITH THE CODE IN IT. That toast WAS this bug: it carried the only copy of a value
       * the researcher's panel then refused to proceed without, and it expired. The banner below
       * stays up until the pairing is approved, so the question "what is my code" has an answer for
       * as long as anyone can be asking it. */
      refreshPairBanner();
    } else toast(t('invite.acceptFailed'), 6000);
    refreshList();
  });
  wrap.querySelector('[data-iv="decline"]').addEventListener('click', () => {
    Sync.clearSession();                                   // abandon the binding entirely
    close();
    toast(t('invite.declined'), 6000);
    refreshList();
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
  // v327: drive.USERCONTENT.google.com (the direct-download host driveLink() itself builds) must
  // also count as Drive — it does not contain the substring "drive.google.com", so a pasted
  // download link skipped the relay and was fetched directly (no CORS headers → dead fetch).
  const isDrive = fileId && (/drive(?:\.usercontent)?\.google\.com/.test(s) || !isProbablyUrl(s));
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
 * link. analyzeFlextextWs (flextext.js — shared with the researcher panel's
 * assign-time check) surveys its writing-system codes and splits them into
 * vernacular vs analysis; the device HARD-REFUSES the link if they don't match
 * the setup.
 * (An auto-remap-to-setup option was considered but deferred: a researcher may
 * use several writing systems for several purposes, so a correct remap needs
 * more design. For now the file's codes must already match.) */

// Download a task-attached flextext, parse it, and return the first
// interlinear-text doc.
async function buildDocFromFlextextUrl(url, title) {
  /* ⚠ RESOLVE FIRST (v327 — the real "0 sentences" bug, reproduced with two different texts).
   * The panel sends the RAW pasted Drive URL (deliberately: raw is durable; each device resolves
   * with ITS OWN worker base + token at fetch time). The AUDIO pipeline has always done that
   * resolve (resolveAudioInput) — this flextext path never did, so the device fetched
   * drive.google.com DIRECTLY: no CORS headers, the fetch REJECTS, the error classifies as
   * transient, and the assignment retried forever and failed forever, deterministically, while
   * the audio beside it arrived fine. Same resolver as audio, same relay, same token. */
  const file = await fetchFileViaUrl(resolveAudioInput(url) || url);
  const xml = await file.blob.text();
  // Same multi-WS selection as importFile: edit this device's WS lines only.
  const { texts, error } = parseFlextext(xml, { vernLang: settings.vernLang, analLang: settings.analLang });
  // A successful fetch of a non-flextext body (Drive 404 HTML page, wrong file,
  // corrupt export) is a PERMANENT failure — tag it so the retry loop stops and
  // surfaces it rather than spinning behind a silent empty placeholder.
  if (error || !texts.length) { const e = new Error(error || 'No readable text in the file.'); e.parseError = true; throw e; }
  const doc = texts[0];
  // A researcher-assigned text is a foreign .flextext like any other, so it gets the same canonical
  // shape on entry — see normalizePhraseLines. Its callers store it straight away.
  normalizePhraseLines(doc);
  if (title) doc.title = title;
  return doc;
}

/* Can THIS browser hand a file to another app? Desktop Firefox and Safari cannot — navigator.share
 * with files is Chromium and mobile only. The menu shares the flextext as text/plain, so a
 * text/plain probe answers exactly the question the menu will ask. */
function canShareFiles() {
  try {
    return !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'a.txt', { type: 'text/plain' })] }));
  } catch { return false; }
}

/* What this device can ACTUALLY do with a finished text, right now — permission AND capability.
 *
 * ⚠ ONE FUNCTION, USED BY BOTH the Send button's visibility and the menu it opens. They used to
 * compute this separately and could therefore disagree, and they did: the button counted
 * `allow.has('share')` while the menu additionally required navigator.canShare, so a device
 * permitted only Share showed a Send button that opened an EMPTY MENU. The same shape of bug hit
 * 'save' on Firefox. A button that opens nothing is the worst version of "cannot act": it does not
 * even look disabled. Keep these in one place so the two can never drift again. */
function sendCapabilities() {
  const allow = allowedSend();
  const caps = {
    share: allow.has('share') && canShareFiles(),
    upload: allow.has('upload') && !!Sync.workerUploadTarget(),
    // Always writable when permitted: a file picker where the browser has one, a plain download
    // where it does not. There is no browser in which this is unavailable.
    save: allow.has('save'),
  };
  /* ⚠ A DEVICE MUST NEVER BE LEFT WITH NO WAY TO GET ITS WORK OFF (Seth, 2026-08-14, reasoning it
   * out before it bit anyone: "if I pair a device, set it to upload only, and then unpair it, the
   * last setting it had was 'upload' — will it automatically enable the defaults?").
   *
   * It did not. `sendOptions` is a PERSISTED device setting and unpairing does not touch it, so an
   * upload-only device that loses its pairing computes share:false, upload:false (no target),
   * save:false — and updateShareButton then hides the entire Send button. The transcription is
   * stranded in IndexedDB with no route out and nothing on screen even hinting why.
   *
   * A researcher's "upload only" means "send your work through MY pipeline", and that is a sensible
   * restriction exactly as long as the pipeline exists. Once the device is unpaired the restriction
   * enforces nothing at all — it only destroys work. So when NOTHING is possible, saving becomes
   * possible: the one route that needs no server, no pairing and no permission from anyone.
   *
   * ⚠ This is not a hole in the seized-device story. Revocation is not a wipe — the panel has a
   * REMOTE WIPE directive for that (eraseAllData), and anyone holding the hardware can read
   * IndexedDB regardless. Hiding a button never protected data from its holder; it only ever
   * protected it from its author.
   *
   * It also closes a second, older instance of the same trap that this file already documents: a
   * device permitted ONLY 'share', on a browser with no navigator.share (desktop Firefox), had every
   * capability false and the button hidden. Same stranding, different route. */
  if (!caps.share && !caps.upload && !caps.save) caps.save = true;
  return caps;
}

// Hide the whole "Save and send…" button if nothing it opens could actually do anything.
function updateShareButton() {
  const c = sendCapabilities();
  const any = c.share || c.upload || c.save;
  $('#btn-share').hidden = !any;
}

function exportBlob() {
  if (activeTab === 'baseline' && $('#baseline-text')) applyBaseline();
  current.doc.title = ($('#doc-title')?.value.trim()) || current.title || 'Untitled';
  const xml = serializeFlextext(current.doc, settings, { segTimes: segmentationEnabled(), producedBy: producedBy() });
  return new Blob([xml], { type: 'application/xml' });
}

function exportFilename() {
  return (sanitizeBase(($('#doc-title')?.value.trim()) || current.title) || 'text') + '.flextext';
}

// Build what gets saved/uploaded: when the text's audio came from the USER
// (recorded, "new text from audio", or attached) it travels along in a zip;
// task audio from the researcher does not (they already have it).
// Bundle for the OPEN doc: sync the editor DOM into `current` first, then delegate.
async function buildBundle(withTimestamp) {
  if (activeTab === 'baseline' && $('#baseline-text')) applyBaseline();
  if (current && $('#doc-title')) current.title = ($('#doc-title').value.trim()) || current.title || 'Untitled';
  // The share/save/download menu is the LOCAL path → full segmentation exports (preview page with
  // embedded audio + bext-stamped derived WAV). Uploads never get those — field bandwidth pays.
  return buildBundleFor(current, withTimestamp, { full: true });
}

// DOM-free bundle builder for ANY doc record — lets a remote-triggered upload bundle a
// doc that isn't open. Pure: reads only the passed record + IndexedDB media.
async function buildBundleFor(rec, withTimestamp, opts = {}) {
  const name = docFilename(rec);                  // Title.flextext
  const base = name.replace(/\.flextext$/, '');
  const media = await db.getMedia(rec.id).catch(() => null);
  const userAudio = !!(media && !isAudioLocked(rec));
  // Segmentation exports — RESEARCHER-SELECTED (Seth, 2026-08-03): exportEaf / exportSaymore /
  // exportPreview device settings choose which annotation files ride the bundles. An UNSET value
  // follows the mode: basic editor → flextext only (plus the audio, as always); Audio
  // Segmentation Mode → all three on. All of them additionally require real alignment to exist —
  // an EAF with no times is pointless. EAFs are small text and ride every bundle incl. uploads;
  // the preview page (audio embedded base64) and the derived WAV ride LOCAL bundles only
  // (opts.full) — field upload bandwidth never pays for embedded audio. Media reference: the WAV
  // working copy when one exists — the segment times live on ITS timeline — else the original.
  // The original media is never modified; bext goes on the DERIVED copy only.
  // Fall back to the flextext-native offsets: an imported aligned doc that was never OPENED in
  // segmentation mode has no doc.segments yet, but its phrases carry the alignment — without the
  // fallback its bundles silently shipped without EAFs (audit find).
  const spans = (Array.isArray(rec.doc && rec.doc.segments) && rec.doc.segments.length)
    ? rec.doc.segments
    : ((rec.doc && segmentsFromOffsets(rec.doc)) || []);
  const hasAligned = spans.some((s) => typeof s.start === 'number' && typeof s.end === 'number' && !s.timePending);
  const expDefault = segmentationEnabled();
  /* ⚠ THE EMBEDDING OUTPUTS ARE SIZE-GATED, HERE, BY THE SAME conversionCaps THE PANEL READS. The
   * listening page and the .fxpa each carry the recording as base64 — the byte-string, its base64
   * and the assembled document all alive at once, twice over — and on a six-minute WAV that is
   * several hundred megabytes of strings in one call. Firefox answered "allocation size overflow"
   * to the satellite download of exactly such a text (Seth, 2026-09-03: "not a particularly large
   * text"). The recording itself still rides as a FILE; only the copies-inside-text are dropped,
   * and `trimmed` says so, so a caller can tell the user rather than let the zip look complete.
   * opts.wants lets a caller decide per output — the satellites never want the embeds at all. */
  const caps = media ? conversionCaps({
    bytes: (media.blob && media.blob.size) || 0,
    isWav: /\.wav$/i.test(String(media.name || '')) || /wav/i.test(String(media.mimeType || '')),
  }) : conversionCaps({ bytes: 0, isWav: true });
  const w = opts.wants || {};
  const wantEaf = w.eaf ?? settings.exportEaf ?? expDefault;
  const wantSaymore = w.saymore ?? settings.exportSaymore ?? expDefault;
  const wantPreview = (w.preview ?? settings.exportPreview ?? expDefault) && caps.preview;
  const wantJson = (w.fxpa ?? settings.exportJson ?? expDefault) && caps.fxpaAudio;
  const trimmed = [];
  if ((w.preview ?? settings.exportPreview ?? expDefault) && !caps.preview) trimmed.push('preview');
  if ((w.fxpa ?? settings.exportJson ?? expDefault) && !caps.fxpaAudio) trimmed.push('fxpa');
  // The flextext's OWN media-files reference is part of the flextext, not an optional annotation
  // export — resolve the working-media name whenever alignment exists, regardless of checkboxes.
  let segMediaName = '';
  let segMedia = null;
  if (hasAligned && media) {
    const working = await db.getMedia('segwav:' + rec.id).catch(() => null);
    segMedia = (working && working.blob && working.srcName === media.name) ? working : media;
    /* v3: the exported name is derived from the STORY TITLE, never from the stored media name.
     * A text assigned before the download fix has media.name === the delivery token, and reading
     * it here is what produced `bwpX_YzJZRolHdh_.converted-NOT-ARCHIVAL.wav`. Deriving it fixes
     * those texts on their next export, with no migration and no re-download. */
    segMediaName = segMedia.derived ? derivedWavName(base) : mediaNameFor(base, segMedia);
  }
  /* LANE B (assign-by-upload rule 4): an UPLOAD is the BARE .flextext — never zipped. The
   * recording + consent artifacts leave on their own Lane A zip the moment a recording is saved
   * (queueMediaUpload), and the panel builds the EAF/SayMore/preview conversions on demand from
   * the same shared assembler — so field upload bandwidth pays for the text alone, and the
   * derived-WAV re-upload leak for assigned texts is gone by construction. An assigned/locked doc
   * references its ORIGINAL media name (the assigned file itself — a working-copy name would
   * point at a file that is nowhere in the folder). Local saves (opts.full) are untouched. */
  if (!opts.full) {
    const uploadMediaName = (hasAligned && media)
      ? (isAudioLocked(rec) ? mediaNameFor(base, media) : segMediaName)
      : undefined;
    const bare = serializeDocBlob(rec, uploadMediaName);
    const bstamp = withTimestamp ? ' ' + fileStamp() : '';
    return { blob: bare, filename: `${base}${bstamp}.flextext`, mime: 'application/xml',
      xmlBlob: bare, xmlName: name, zipped: false };
  }
  // Shared with the panel's Downloads conversions (assign-by-upload): the entries the researcher
  // downloads are built by the SAME function as the entries the device bundles.
  const segEntries = await assembleSegEntries({
    doc: rec.doc, title: rec.title || base, base, media, segMedia,
    producedBy: producedBy(),
    wants: { eaf: wantEaf, saymore: wantSaymore, preview: wantPreview, fxpa: wantJson },
    vern: settings.vernLang || rec.doc.vernLang || 'und',
    anal: settings.analLang || rec.doc.analLang || 'en',
    full: !!opts.full,
  });
  const xmlBlob = serializeDocBlob(rec, segMediaName || undefined);
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
  if (userAudio || consent || promptAudio || receipt || segEntries.length) {
    const entries = [{ name, data: xmlBlob }, ...segEntries];
    /* The zip entry name and the EAF's media reference MUST be the same string — both are now
     * title-derived, so they cannot disagree (they would have if only one side were fixed). */
    if (userAudio) entries.push({ name: mediaNameFor(base, media), data: media.blob });
    if (consent?.blob) entries.push({ name: consent.name || rec.consentClip, data: consent.blob });
    if (promptAudio?.blob) entries.push({ name: promptAudio.name || rec.consentPromptClip, data: promptAudio.blob });
    if (receipt) {
      const full = { ...receipt, textTitle: rec.title || '' };
      entries.push({ name: 'consent-receipt.json', data: new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' }) });
      entries.push({ name: 'consent-receipt.txt', data: new Blob([consentReceiptText(full)], { type: 'text/plain' }) });
    }
    const blob = await makeZip(entries);
    return { blob, filename: `${base}${stamp}.zip`, mime: 'application/zip',
      xmlBlob, xmlName: name, zipped: true, trimmed, entries };
  }
  return { blob: xmlBlob, filename: `${base}${stamp}.flextext`, mime: 'application/xml',
    xmlBlob, xmlName: name, zipped: false, trimmed };
}

// Serialize a doc record to a .flextext XML blob (DOM-free; mirrors exportBlob without the DOM).
// mediaName (optional) lets aligned segments reference their audio via flextext's native
// media-files block; timestamps ride as begin/end offsets + note items either way.
function serializeDocBlob(rec, mediaName) {
  const doc = rec.doc;
  doc.title = rec.title || doc.title || 'Untitled';
  // Timing emission follows the mode (Seth): basic editor → a clean classic flextext, even when
  // the doc still carries spans from earlier segmentation work. Imported attrs round-trip either way.
  return new Blob([serializeFlextext(doc, settings, { mediaName, segTimes: segmentationEnabled(), producedBy: producedBy() })], { type: 'application/xml' });
}

function docFilename(rec) {
  // ONE rule, shared with the source package and the worker's Drive folder name (seg-exports.js
  // sanitizeBase). This used to cap at 80 while the package used 120 — the v3 work order's
  // "pick one rule and share it".
  return (sanitizeBase(rec.title) || 'text') + '.flextext';
}

// Queue a doc for upload BY ID — works whether or not it is the open doc, so a researcher
// can trigger an upload remotely (triggerUpload command) without the coworker pressing Upload.
async function uploadDocById(docId) {
  const rec = (current && current.id === docId) ? current : await db.getDoc(docId).catch(() => null);
  if (!rec) return false;
  const bundle = await buildBundleFor(rec, true); // Lane B bare flextext; timestamped: Drive never overwrites
  await db.putMedia('upload:' + docId, {
    blob: bundle.blob, name: bundle.filename, mime: bundle.mime,
    total: bundle.blob.size, sent: 0,
    // Wire identity: upload.js sends rec.docId when present, else its queue key. Lane B's key IS
    // the docId, so old queued records (no docId field) keep uploading unchanged after an update.
    docId,
    docModified: rec.modified,
    // Signature of the content actually going to Drive, so completion can stamp
    // uploadedSig from the QUEUED content (not whatever the doc holds by then).
    docSig: uploadContentSig(rec),
    docDone: !!rec.done,   // auto-delete fires only for FINISHED texts
    // Text identity for the per-text Drive folder ("FlexText Uploads / <device> / <title>").
    // The WORKER resolves the folder from docId (rename-proof appProperties tag); the title is
    // display-only at folder creation. Legacy queued records lack both → device-folder root,
    // exactly the old behaviour.
    docTitle: rec.title || '',
    // The per-text Drive folder id from the LAST successful upload: the worker verifies it by
    // files.get (strongly consistent) instead of tag-SEARCHING (eventually consistent), which is
    // what stopped every upload minting a fresh "Title (n)" folder.
    docFolderId: rec.driveFolderId || '',
  });
  uploadView.set(docId, { name: bundle.filename, status: 'waiting' });
  renderUploadQueue();
  // Lane split catch-up: a text whose media never left the device on ANY lane (recorded before the
  // split, or a user-attached file) still has to get its recording out — queue Lane A beside this.
  // Docs with an old zip upload (uploadedFileId) already have their audio inside that bundle.
  if (!rec.mediaUploaded && !rec.sourcePackaged && !rec.uploadedFileId) { try { await queueMediaUpload(docId); } catch { /* Lane B proceeds regardless */ } }
  pumpUploads();
  return true;
}

/* LANE A (assign-by-upload rule 4): the recording + consent artifacts (clip, prompt, receipt)
 * leave the device ASAP after a recording is saved, as ONE zip through the same tolerant queue —
 * zips exist ONLY for this. Queue key 'media:<docId>' (persisted as 'upload:media:<docId>') so it
 * sits beside the text's own Lane B record; the wire docId rides IN the record (upload.js sends
 * rec.docId), so the worker files it under the same per-text folder. docDone:false — a media zip
 * must never trigger auto-delete, and completion stamps mediaUploaded only, never the text's
 * backup proof (uploadedFileId/uploadedSig certify the TEXT). */
async function queueMediaUpload(docId) {
  const rec = (current && current.id === docId) ? current : await db.getDoc(docId).catch(() => null);
  if (!rec) return false;
  if (isAudioLocked(rec)) return false;              // assigned-from-Drive audio never re-uploads
  if (rec.mediaUploaded || rec.sourcePackaged) return false;   // v2: queued once, each part retries on its own
  const key = 'media:' + docId;
  if (uploadView.has(key) || await db.getMedia('upload:' + key).catch(() => null)) return false;
  const media = await db.getMedia(docId).catch(() => null);
  if (!media || !media.blob) return false;
  const consent = rec.consentClip ? await db.getMedia('consent:' + docId).catch(() => null) : null;
  const promptAudio = rec.consentPromptClip ? await db.getMedia('consent-prompt:' + docId).catch(() => null) : null;
  const receipt = rec.consentReceipt || null;
  // Same short wait as the full-bundle path: an in-flight IP/location capture gets its window so
  // the bundled record isn't needlessly "unavailable".
  if (receipt && consentCapture && consentCapture.receipt === receipt) {
    await Promise.race([consentCapture.promise, new Promise((r) => setTimeout(r, 5000))]);
  }
  /* v2 SOURCE PACKAGE: individual role-tagged files in "<Storyname>/originals/", not one zip.
   * A zip hid the audio from every other tool in the suite (the Files menu could not offer the
   * original recording, and saved ELAN/SayMore bundles came out with no WAV). Uploading the pieces
   * separately gives an assigned text and a recorded text the SAME folder shape.
   *
   * Each piece is its own queue record, so each retries forever on its own — the set can be
   * briefly incomplete on a bad connection, which is what the manifest is for: it declares the
   * intended files, so a consumer compares that list against the folder and can NAME what has not
   * arrived instead of silently showing a partial package. It is written FIRST for exactly that
   * reason. Completeness is DERIVED from the comparison; there is deliberately no `complete` flag
   * to go stale. */
  const base = sanitizeBase(rec.title) || 'text';
  const audioName = base + extOf(media.name || '', media.mimeType || media.mime || '');
  const parts = [];
  parts.push({ slot: 'audio', name: audioName, role: 'source-audio', blob: media.blob,
               mime: media.mimeType || media.mime || 'application/octet-stream' });
  if (consent?.blob) parts.push({ slot: 'consent', name: 'consent-response' + extOf(consent.name || '', consent.mimeType || ''), role: 'consent-clip', blob: consent.blob, mime: consent.mimeType || 'audio/mpeg' });
  if (promptAudio?.blob) parts.push({ slot: 'prompt', name: 'consent-prompt' + extOf(promptAudio.name || '', promptAudio.mimeType || ''), role: 'consent-prompt', blob: promptAudio.blob, mime: promptAudio.mimeType || 'audio/mpeg' });
  if (receipt) {
    const full = { ...receipt, textTitle: rec.title || '' };
    parts.push({ slot: 'receiptjson', name: 'consent-receipt.json', role: 'consent-receipt',
                 blob: new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' }), mime: 'application/json' });
    parts.push({ slot: 'receipttxt', name: 'consent-receipt.txt', role: 'consent-receipt',
                 blob: new Blob([consentReceiptText(full)], { type: 'text/plain' }), mime: 'text/plain' });
  }

  const manifest = buildSourceManifest({
    docId: rec.id, title: rec.title || '',
    origin: isAudioLocked(rec) ? 'assigned' : 'recorded',
    originatedAt: rec.created || null,
    engine: ENGINE_VERSION, buildTag: BUILD_TAG,
    vern: settings.vernLang || '', anal: settings.analLang || '',
    files: parts.map((p) => ({ name: p.name, role: p.role, mime: p.mime, bytes: p.blob.size })),
    audio: { name: audioName, mime: parts[0].mime, bytes: media.blob.size, derived: false },
    consent: {
      /* Derived through the ACCESSOR, not the raw key: `settings.consentMode` is the legacy single
       * value and device-setup DELETES it on every save (the migration), so reading it here made
       * every manifest say 'off' whatever the device actually asked (found in the 2026-08-25
       * triage). consentAskList() speaks both dialects — modern array, legacy single — so the
       * manifest records what the device really prompts: 'off', 'text', 'audio', or 'text+audio'. */
      mode: (() => { const ask = consentAskList(); return ask.length ? ask.join('+') : 'off'; })(),
      prompt: !!rec.consentPromptClip,
      response: !!rec.consentClip,
      receipt: !!rec.consentReceipt,
    },
    /* WHICH DEVICE recorded this — the question schema 1 could not answer from Drive alone.
     * ⚠ NO `name`: a device does not know its own nickname (it lives in D1, is researcher-set and
     * renameable), and a manifest is written once. Recording a name here would freeze whatever it
     * was at package time and quietly disagree with the panel after the first rename. The id is the
     * durable fact; resolving it to a name is the reader's job.
     * An unmanaged device has no instance id and says so with '' rather than claiming another kind. */
    source: { kind: 'device', id: (Sync.enrollment() || {}).instanceId || '' },
  });
  const queue = [
    { slot: 'manifest', name: MANIFEST_NAME, role: 'manifest', mime: 'application/json',
      blob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }) },
    ...parts,
  ];
  for (const p of queue) {
    const k = key + ':' + p.slot;
    if (uploadView.has(k) || await db.getMedia('upload:' + k).catch(() => null)) continue;
    await db.putMedia('upload:' + k, {
      blob: p.blob, name: p.name, mime: p.mime,
      total: p.blob.size, sent: 0,
      docId, lane: 'media',
      sub: 'originals', role: p.role,        // → x-fx-sub / x-fx-role (upload.js)
      docModified: rec.modified,
      docDone: false,
      docTitle: rec.title || '',
      docFolderId: rec.driveFolderId || '',
    });
    uploadView.set(k, { name: p.name, status: 'waiting' });
  }
  // Queued, so the catch-up never re-enqueues: each part now retries on its own, forever.
  if (current && current.id === docId) current.sourcePackaged = true;
  await db.getDoc(docId).then(async (d) => { if (d) { d.sourcePackaged = true; await db.putDoc(d); } }).catch(() => { /* best effort */ });
  renderUploadQueue();
  pumpUploads();
  return true;
}


// sanitizeBase / extOf now live in seg-exports.js (imported above) — the ONE naming rule shared by
// the device, the panel and the downloader. See the FILE NAMING block there for why.

/* buildSourceManifest now lives in seg-exports.js — the ONE builder shared by the device (here),
 * the panel and the crowd page. It used to live here and the panel kept a hand-copied literal of
 * the same shape; see the block there for why two writers of one contract is the bug. */

/* AFTER A SUCCESSFUL SEND, GO BACK TO THE TEXTS LIST (Seth, 2026-08-13).
 *
 * "when the user clicks 'Done - and send' after it's done sending, navigation returns them back to
 *  the main page (with the texts listed)."
 *
 * The workflow this completes: a transcriber finishes a text, sends it, and is ready for the next
 * one. Leaving them on the text they just finished makes them find their own way back, and the
 * commonest way people "leave" a finished text is to start editing it again by accident.
 *
 * ⚠ SAME ORDER AS #btn-back, AND THE ORDER IS LOAD-BEARING: applyBaseline, then persist, and only
 * THEN show('texts'). `persist()` deliberately skips the full doc write while the texts view is
 * visible, so navigating first would drop the last edit — the same trap documented for the Back
 * button. Reusing that exact sequence is why this is one helper and not three call sites.
 *
 * ⚠ ONLY ON SUCCESS. Never after an AbortError (the user dismissed the picker or the share sheet),
 * never after a failure — navigating away from a send that did NOT happen would hide the failure
 * behind a screen change and read as success. */
/* Which doc's upload, if any, should return the user to the list when it lands. Cleared whenever it
 * is honoured or becomes moot — never a standing subscription. */
let returnAfterUploadOf = null;

async function returnToLibraryAfterSend() {
  if (activeTab === 'baseline') applyBaseline();
  try { await persist(); } catch { /* already saved / nothing to flush */ }
  current = null;
  leaveEditor();
  renderDocList();
  show('texts');
}

/* LEAVING THE TEXT ENTIRELY — the cleanup both exits share (⟵ Back, and the return-to-list after a
 * successful send). The editor's three tab tickers are per-view rAF loops, and only switchTab ever
 * stopped them — so leaving from the Gloss or Cut tab left a 60fps loop doing ~3,600 DOM queries a
 * second against hidden nodes for as long as the texts list sat open (measured, v368 audit), plus
 * ~25MB of strip/gloss canvas backing store idling behind the list on a 60-line text. Stop the
 * loops, drop the canvases, and forget the Cut tab's "already on screen" claim so the next open
 * rebuilds through its loading state instead of trusting an emptied container. Re-entry is safe by
 * construction: every tab rebuilds its own view on entry (renderStrips / renderGloss / renderCut via
 * prepareCutAudio), so nothing here is state the editor expects to find again. */
function leaveEditor() {
  stopStrips();
  stopCut();
  stopGlossCursor();
  cutShownFor = null;
  for (const sel of ['#segment-strips', '#cut-strips', '#gloss-body']) {
    const el = $(sel);
    if (el) el.innerHTML = '';
  }
  if (player) { player.hide(); player.loadedFor = null; }
}

async function openShareMenu() {
  persist();
  const bundle = await buildBundle(false);
  // Said, not silently dropped: a bundle that quietly lacks the listening page is one the user
  // discovers on the tab that needed it.
  if (bundle.trimmed && bundle.trimmed.length) toast(t('share.trimmedBig'), 8000);
  $('#share-filename').textContent = bundle.filename;
  // Chromium only lets navigator.share() send an allowlisted set of file
  // types (images, audio, pdf, .txt, ...) — neither XML nor ZIP qualifies —
  // so Share always sends just the flextext as "<name>.flextext.txt".
  const shareFile = new File([bundle.xmlBlob], bundle.xmlName + '.txt', { type: 'text/plain' });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [shareFile] }));
  const canPick = !!window.showSaveFilePicker;
  const caps = sendCapabilities();                       // the SAME rules the Send button used
  const showShare = canShare && caps.share;
  const showUpload = caps.upload;
  /* ⚠ ONE SAVE BUTTON, AND IT IS NEVER HIDDEN BY A MISSING BROWSER FEATURE. It used to be two —
   * the picker button, and a blind-download button shown only when the picker was absent. On
   * Firefox that meant a device allowed ONLY 'save' got an empty share menu, because the picker
   * button was hidden and the download button was not permitted. The setting was unsatisfiable and
   * said nothing. Now the permission decides whether the button exists and the BROWSER decides how
   * it behaves; a writing method always exists, so this can no longer render nothing. */
  const showSave = caps.save;
  $('#share-share').hidden = !showShare;
  $('#share-upload').hidden = !showUpload;
  $('#share-saveas').hidden = !showSave;
  $('#share-download').hidden = true;                  // retired; the markup stays for older shells
  $('#share-upload').className = showShare ? 'secondary-btn' : 'primary-btn';
  $('#share-saveas').className = (showShare || showUpload) ? 'secondary-btn' : 'primary-btn';
  $('#share-saveas').textContent = t(canPick ? 'share.saveas' : 'share.download');
  $('#share-menu').hidden = false;

  $('#share-share').onclick = async () => {
    try {
      await navigator.share({ files: [shareFile], title: bundle.xmlName });
      closeShareMenu();
      await returnToLibraryAfterSend();
    } catch (e) {
      if (e.name !== 'AbortError') toast(t('toast.shareFailed', { msg: e.message }), 5000);
    }
  };
  /* ⚠ UPLOAD RETURNS WHEN THE UPLOAD ACTUALLY FINISHES (Seth: "after finished uploading"), not when
   * the button is tapped — so it records an INTENT here and the completion point acts on it.
   *
   * The intent is per-DOC, and that is the safety property: an upload can take minutes on a village
   * connection, and in that time the transcriber may open another text. Navigating then would yank
   * them out of whatever they had started typing, triggered by a network event they cannot see
   * coming. So the completion point returns only if they are STILL on the text they sent. If they
   * moved on, the intent is simply dropped — the upload still completes and the global bar still
   * reports it. */
  $('#share-upload').onclick = () => { closeShareMenu(); returnAfterUploadOf = current ? current.id : null; doUpload(); };
  /* ⚠ ONE HANDLER, TWO MECHANISMS, and the fallback is not optional. showSaveFilePicker is
   * Chromium/Edge only — Firefox and Safari have never had it — so a save path that depends on it
   * simply does not exist for a large share of users. It picks the best available method and always
   * writes the file: a picker where there is one (choose folder and name), a plain download where
   * there is not (straight to Downloads). A researcher configuring a device is choosing WHETHER
   * this device may write files, never which browser API does it. */
  const blindDownload = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(bundle.blob);
    a.download = bundle.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    closeShareMenu();
    returnToLibraryAfterSend();
  };
  $('#share-saveas').onclick = async () => {
    if (!window.showSaveFilePicker) { blindDownload(); return; }
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
      await returnToLibraryAfterSend();
    } catch (e) {
      if (e.name === 'AbortError') return;                 // the user closed the picker: not a failure
      /* The picker EXISTED but refused — a cross-origin iframe, a locked-down policy, a quota. The
       * work still has to leave the device, so fall back rather than report a dead end. */
      blindDownload();
    }
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
        // LANE A ('media:<docId>') completion: the recording + consent zip is on Drive. Stamp the
        // folder echo + mediaUploaded ONLY — a media zip does not certify the TEXT as backed up,
        // so uploadedFileId/uploadedSig (the delete-safety proof) stay untouched, and docDone is
        // always false on these records so the auto-delete branch below can never fire for one.
        if (String(docId).startsWith('media:')) {
          // v2 keys are 'media:<docId>:<slot>' (one record per source file); v1 keys were
          // 'media:<docId>'. Strip a trailing slot so an in-flight OLD record still resolves.
          const realId = String(docId).slice(6).replace(/:[a-z]+$/, '');
          const slot = (String(docId).match(/:([a-z]+)$/) || [])[1] || '';
          const stampA = (d) => {
            if (st.folderId) d.driveFolderId = st.folderId;   // next upload echoes it (folder dedupe)
            // The RECORDING landing is what 'the media left the device' means; the manifest and the
            // small consent files ride their own records and retry independently.
            if (!slot || slot === 'audio') d.mediaUploaded = true;
          };
          if (current && current.id === realId) stampA(current);
          db.getDoc(realId).then(async (d) => {
            if (d) { stampA(d); await db.putDoc(d); }
            return Sync.reportNow();
          }).catch(() => {});
          toast(t('upload.done', { name: st.name }), 6000);
          renderUploadQueue();
          pumpUploads();
          return;
        }
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
            if (st.folderId) d.driveFolderId = st.folderId;   // next upload echoes it (folder dedupe)
            // What's on Drive is the QUEUED content — stamp its sig, not the doc's current one
            // (an edit mid-upload must read as "changed", not get certified by its own upload).
            d.uploadedSig = st.docSig || uploadContentSig(d);
            // The queue-time modified snapshot goes stale when persist()'s unconditional
            // Date.now() bump lands between queue and completion with NO content change —
            // the doc then reads "edited since backup" forever. When the sig proves the
            // content on Drive IS this content, stamp the live modified instead.
            const sameContent = st.docSig && uploadContentSig(d) === st.docSig;
            d.uploadedModified = sameContent ? d.modified
              : ((st.docModified != null) ? st.docModified : d.modified);
            d.uploadedAt = Date.now();
          };
          if (current && current.id === docId) stamp(current);
          /* "Done and send" → back to the list, now that the bytes are actually on Drive. Guarded on
           * the user still being on that same text: if they moved on, dropping the intent is the
           * correct outcome, not a deferred navigation waiting to surprise them. */
          if (returnAfterUploadOf === docId) {
            returnAfterUploadOf = null;
            if (current && current.id === docId) returnToLibraryAfterSend();
          }
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
  /* ⚠ AN UNPAIRED DEVICE MUST NOT SPIN (Seth, 2026-08-14, after deleting a device from the panel:
   * "It's an unpaired flextext PWA. Which begs the question why it's trying to upload at all.").
   *
   * The queue is device-local and OUTLIVES the pairing that created it — nothing linked the two, so
   * unlinking a device left its queued bundles retrying against a target that had become null.
   * Every RETRY_EVERY_MS the sweep reset them to 'waiting', the pump started one, upload.js threw
   * "Uploads need this device to be linked to a researcher", and the row said "Failed — will retry"
   * (v372 made that sentence visible; it should never have been reached this often at all). Forever,
   * on battery, promising something that could not happen.
   *
   * So a missing target is a HELD state, not a failure: the items stay exactly as they are, nothing
   * is started, and the tray says why. ⚠ HELD, NEVER DISCARDED — unpairing is routine and often
   * temporary (a re-pair, a device swap), and these blobs are the only copy of a bundle that may
   * represent hours of transcription. They resume by themselves the moment the device is paired
   * again, because the target is read fresh on every attempt. */
  if (!Sync.workerUploadTarget()) { renderUploadQueue(); return; }
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
  /* ⚠ AN UNPAIRED DEVICE STILL RECONCILES THE VIEW — it just does not RETRY. Getting this wrong is
   * easy and was caught by the browser check: an early return here left the held bundles invisible,
   * which is worse than the bug it was fixing. The user must be able to SEE that their work is
   * queued and safe; what they must not get is a promise to send it. */
  const paired = !!Sync.workerUploadTarget();
  let pending = [];
  try { pending = await listPendingUploads(); } catch { /* best effort */ }
  const ids = new Set(pending.map((p) => p.docId));
  for (const { docId, rec } of pending) {
    const v = uploadView.get(docId);
    if (!v) uploadView.set(docId, { name: rec.name, status: rec.paused ? 'paused' : 'waiting' });
    // The error→waiting reset IS the retry, so it is the thing an unpaired device withholds.
    else if (v.status === 'error' && paired) uploadView.set(docId, { ...v, status: 'waiting' });
  }
  // Drop view entries whose persisted record is gone (done/cancelled), unless
  // one is mid-flight.
  for (const id of [...uploadView.keys()]) {
    if (!ids.has(id) && uploadView.get(id)?.status !== 'uploading') uploadView.delete(id);
  }
  renderUploadQueue();
  if (paired) pumpUploads();   // held otherwise — the items stay, nothing is started
}

/* Keep the version badge clear of the tray: it is fixed to the same corner, and the tray's height
 * changes as items arrive and as the list is expanded. See .app-version in app.css. */
function setUploadBarHeightVar(bar) {
  const h = (bar && !bar.hidden) ? bar.offsetHeight : 0;
  document.documentElement.style.setProperty('--upload-bar-h', h ? h + 'px' : '0px');
}

function renderUploadQueue() {
  const bar = $('#upload-bar');
  if (!bar) return;
  const items = [...uploadView.entries()].map(([docId, v]) => ({ docId, ...v }));
  if (!items.length) { bar.hidden = true; setUploadBarHeightVar(bar); return; }
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
  } else if (!Sync.workerUploadTarget()) {
    // "will retry shortly" is a promise this device cannot keep while it is unpaired.
    label.textContent = t('upload.heldSummary', { n: total });
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

  /* ── WHICH SERVER, AND A WAY BACK (v372) ──────────────────────────────────────────────────────
   * Shown only while something is actually failing, so a healthy queue stays silent. Two jobs:
   *   1. NAME THE BACKEND. "Failed — will retry" forever, with no way to learn what it was even
   *      talking to, is what stranded a production instance for hours (Seth, 2026-08-14). The host
   *      is the first fact any diagnosis needs, and DevTools is not available in the field.
   *   2. OFFER THE WAY BACK when this device is NOT on the normal backend. The dev override
   *      (?devworker=staging) persists silently per device, and the staging worker refuses
   *      production origins BY DESIGN — a guard that is correct but, until now, indistinguishable
   *      from a broken release. ⚠ NEVER auto-revert: a field device quietly repointing itself at a
   *      test backend is exactly what that guard exists to make loud. The user taps, or nothing. */
  const diag = $('#upload-diag'), diagText = $('#upload-diag-text'), diagFix = $('#upload-diag-fix');
  if (diag) {
    const unpaired = !Sync.workerUploadTarget();
    const failing = items.some((i) => i.status === 'error');
    diag.hidden = !(failing || unpaired);
    if (unpaired) {
      /* The honest sentence for the commonest cause of a stuck queue that ISN'T a network problem:
       * this device is not linked to a researcher, so there is nowhere for these to go. Naming the
       * remedy matters more than naming the fault — the person reading it is stuck, not curious. */
      diagText.textContent = t('upload.diagUnpaired');
      diagFix.hidden = true;
    } else if (failing) {
      const base = workerBase();
      let host = base;
      try { host = new URL(base).host; } catch { /* keep the raw string */ }
      const offBase = base !== DEFAULT_WORKER;
      diagText.textContent = t(offBase ? 'upload.diagOther' : 'upload.diagServer', { host });
      diagFix.hidden = !offBase;
      if (offBase) {
        diagFix.textContent = t('upload.diagUseNormal');
        diagFix.onclick = () => {
          // Clearing the override is what workerBase() reads: it falls back to DEFAULT_WORKER.
          delete settings.relayWorker;
          saveSettings(settings);
          toast(t('upload.diagSwitched'), 5000);
          renderUploadQueue();
          pumpUploads();
        };
      }
    }
  }

  const list = $('#upload-list');
  if (list) {
    list.hidden = !(uploadListOpen && total > 1);
    if (!list.hidden) {
      list.innerHTML = '';
      for (const it of items) {
        /* ⚠ SHOW THE REAL REASON. The upload already carried `error` all the way here and the row
         * threw it away for a fixed "Failed — will retry" — so a permanently-stuck queue (a device
         * whose researcher link lapsed; an app pointed at a backend that refuses its origin) looked
         * exactly like a weak signal, forever. Seth, 2026-08-14, on a jammed production instance:
         * "how do I troubleshoot that?" — the answer has to be ON THE SCREEN, because the person
         * this happens to in the field has no DevTools and no way to ask. */
        const heldNow = !Sync.workerUploadTarget();
        const status = heldNow ? t('upload.heldShort')
          : it.status === 'uploading' ? t('upload.uploadingShort')
          : it.status === 'paused' ? t('upload.pausedItem')
          : it.status === 'error' ? (it.error || t('upload.errorShort'))
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
  // LAST: the tray's final height, after every row and the diagnosis line are in place.
  setUploadBarHeightVar(bar);
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

/* ---------------- Settings tab: DEVICE SETUP ----------------------------------------------------
 *
 * The Settings tab IS the device-setup surface. It carries the same fields a researcher would push
 * to a managed device, so somebody can set up a STANDALONE app for their own use — no researcher
 * account, no pairing, no Google sign-in. It REPLACES the older hand-rolled ws-form /
 * recformat-form, which covered a subset of the same stored keys.
 *
 * ⚠ MODELLED ON js/researcher-panel.js, DELIBERATELY NOT SHARED WITH IT. That module is also loaded
 * by the standalone Researcher app, so routing an editor screen through it would put every
 * satellite's settings form on the critical path of an editor change. The cost is a field list that
 * has to be kept in step BY HAND: when GROUPS changes in researcher-panel.js, mirror it in
 * SETUP_GROUPS below. test/device-setup.test.mjs pins the overlap so the drift is loud.
 *
 * FOUR RULES SHAPE WHAT IS HERE (Seth, 2026-08-07):
 *
 * 1. SETUP ONLY. These settings configure how the app BEHAVES on this device. Anything about WHICH
 *    TEXTS a worker handles — assignments, upload targets, corpus operations — is management, and
 *    there is nobody managing a standalone device. None of it appears here.
 *
 * 2. UNPAIRED ONLY. A paired device is configured by its researcher (pushed, encrypted). A second
 *    editable surface for the same values is a second source of truth, and the two would silently
 *    disagree the moment either side changed. applyResearchVisibility() already hides the whole
 *    Settings tab while Sync.hasSession(); renderDeviceSetup() ALSO refuses to build the form for a
 *    paired device, so the rule survives any future route that reaches the tab another way.
 *
 * 3. UPLOAD CANNOT BE CHOSEN HERE. Uploading rides the researcher's Google account; a standalone
 *    device has no OAuth to use, and openShareMenu() already hides the Upload button whenever
 *    Sync.workerUploadTarget() is null. Offering the checkbox would be offering a lie.
 *
 * 4. ⚠ BUT IT IS NOT A DISABLED CHECKBOX. A control that cannot act must SAY what is missing, never
 *    sit there greyed out looking broken (Seth's standing rule, from a real field report). So every
 *    upload-dependent control is REPLACED by a sentence naming what is missing, with the action that
 *    would supply it — the invite-paste pairing flow — attached to it.
 *
 * ⚠ EVERY PANEL FIELD IS PRESENT (Seth, 2026-08-07, revising the first cut). The first version
 * DROPPED the fields that do nothing on a standalone device. That was worse, not better: a
 * researcher who knows the panel came here, found fields missing, and could not tell whether they
 * had been removed, renamed, or were a bug. So the form now mirrors the panel field for field, and
 * anything inert is DISABLED WITH ITS OWN REASON attached (`off:` below) rather than absent.
 *
 * ⚠ AND "DISABLED" HERE STILL HAS TO SPEAK. Seth's standing rule is that a control which cannot act
 * must say what is missing rather than sit there greyed out looking broken. A disabled control
 * satisfies it ONLY because every one carries a visible reason underneath AND answers a click with
 * that same reason (setupOffHtml + the `.setup-off` click handler). Strip either half and this is
 * back to the bug the rule exists to prevent.
 *
 * The ONE deliberate divergence from the panel: consent audio. A paired device receives a Drive URL
 * from its researcher and keeps doing so; a STANDALONE app has no researcher and no reason to route
 * a local file through Drive, so it gets a file picker in that field's place. See SETUP_CONSENT_FILE.
 */

const SETUP_AGC_OPTS = ['off', 'on', 'auto'];
/* ⚠ NO 'download' HERE. It and 'save' were two checkboxes for ONE capability — the share menu used
 * a file picker where the browser had one and a blind download where it did not, so the second was
 * a fallback for the first and they could never both appear. Worse, 'save' alone on Firefox (no
 * showSaveFilePicker) produced a share menu with no buttons in it. One option now; the button picks
 * its own mechanism. allowedSend() still READS the old value so existing devices keep working. */
const SETUP_SEND_OPTS = ['share', 'upload', 'save'];
/* ⚠ The gated send options now live on the FIELD itself (`offOpts`, a { value: reasonKey } map) and
 * are extended at render time by setupOffOpts() with anything the BROWSER cannot do — Share on
 * desktop Firefox and Safari. Kept as one constant would have been a lie the moment the second
 * source of truth appeared. readDeviceSetup() asks setupOffOpts() for the live list, so a gated
 * option's stored value is carried through untouched however it came to be gated. */
/* The annotation exports whose UNSET value follows Audio Segmentation Mode (see buildBundleFor).
 * They live in the same group as the mode switch here, so both get flipped in one save — which is
 * exactly where "unset follows the mode" is easiest to break. */
const SETUP_EXPORT_KEYS = ['exportEaf', 'exportSaymore', 'exportPreview', 'exportJson'];
/* Bytes per second per recording format, for the max-length size readout. Mirrors CROWD_BPS in
 * researcher-panel.js; approximate on purpose — it answers "will this fit on a phone?", not "how
 * many bytes exactly". */
const SETUP_BPS = { mp3: 8000, opus: 6000, webmpcm: 187500, wav16: 96000, wav24: 144000, wav32: 192000, flac24: 110000 };

/* The setup groups, in tab order — the researcher panel's GROUPS, field for field.
 *
 * `off: '<i18n key>'`  the field is inert on an unpaired device: rendered DISABLED, with that key
 *                      as the reason shown under it and toasted when it is clicked.
 * `offOpts: [...]`     same, for individual options inside a multicheck.
 * `standalone: true`   this field exists ONLY here, never in the panel (the consent file picker).
 */
const SETUP_GROUPS = [
  { id: 'languages', legend: 'panel.legend.languages', note: 'research.note', fields: [
    // The panel pushes this to a managed device. Here the toolbar's own language selector is the
    // live control, so a second one could only disagree with it.
    // Derived from LANGS for the same reason the pickers are: a researcher must not be able to push
    // a language to a device that cannot render it.
    { k: 'appLang', type: 'select', opts: ['follow', ...LANGS], optPrefix: 'panel.opt.appLang.', off: 'setup.off.appLang' },
    // Codes ONLY — the name/font fields went in 2026-07-13 (names were display sugar, fonts device
    // cosmetics; neither belongs in the FLEx export). tip = the case-sensitivity warning.
    { k: 'vernLang', type: 'text', ph: 'fau', tip: 'research.wsCase', note: 'research.wsCase' },
    { k: 'analLang', type: 'text', ph: 'en', tip: 'research.wsCase' },
  ] },
  /* Audio Segmentation Mode + the exports it governs, on their own tab (Seth, 2026-08-07). They
   * were the tail of the Buttons tab, which filed a mode that rewrites both editing tabs — and the
   * annotation files a text ships with — under a heading about which buttons show. */
  { id: 'segmentation', fields: [
    // Default OFF — the classic textarea workflow is untouched unless deliberately enabled.
    { k: 'segmentation', type: 'checkbox', note: 'panel.f.segmentationNote' },
    { k: 'backspaceJoin', type: 'checkbox', note: 'panel.f.backspaceJoinNote' },
    { k: 'cutTab', type: 'checkbox', note: 'panel.f.cutTabNote' },
    { k: 'landOnCut', type: 'checkbox', note: 'panel.f.landOnCutNote' },
    { k: 'joinSplitBaseline', type: 'checkbox', note: 'panel.f.joinSplitBaselineNote' },
    { k: 'joinSplitGloss', type: 'checkbox', note: 'panel.f.joinSplitGlossNote' },
    { k: 'cutJoinTexted', type: 'checkbox', note: 'panel.f.cutJoinTextedNote' },
    // An UNSET export follows the mode, so deviceSetupValues prefills the EFFECTIVE value (see
    // buildBundleFor) — a box reading "off" for an export the device actually writes would be a lie
    // about what leaves this machine.
    { k: 'exportEaf', type: 'checkbox' },
    { k: 'exportSaymore', type: 'checkbox' },
    { k: 'exportPreview', type: 'checkbox' },
    // .fxpa: local saves only, never uploads (bandwidth).
    { k: 'exportJson', type: 'checkbox', note: 'panel.f.exportsNote' },
  ] },
  { id: 'recording', notice: 'pwaAudio', fields: [
    { k: 'recordFormat', type: 'select', opts: Object.keys(REC_FORMATS), optPrefix: 'panel.opt.fmt.', help: 'recfmt' },
    { k: 'maxRecordSeconds', type: 'range' },   // auto-stop cap (0 = no limit) + live size readout
    { k: 'agc', type: 'select', opts: SETUP_AGC_OPTS, optPrefix: 'panel.opt.agc.', note: 'recformat.agcNote' },
    { k: 'nr', type: 'checkbox' }, { k: 'echo', type: 'checkbox' }, { k: 'norm', type: 'checkbox' },
    // One-tap archive-grade capture: 24-bit WAV with EVERY processing stage off (AGC/NR/echo/
    // normalization are prohibited on preservation masters).
    { k: 'archivalDefaults', type: 'action' },
  ] },
  { id: 'consent', legend: 'consent.legend', fields: [
    // Consent is multi-select: any combination of prompts + confirmations, all required together.
    // ⚠ NOTHING HERE IS HIDDEN UNTIL ITS BOX IS TICKED any more. The first cut carried the old
    // ws-form's progressive disclosure across, and the result read as "the consent tab has
    // checkboxes and no fields" — Seth looked at it and reported the fields missing. The panel shows
    // them all, always; so does this.
    { k: 'consentAsk', type: 'multicheck', opts: ['text', 'audio'], optPrefix: 'panel.opt.ask.' },
    /* ⚠ `dynOff` — greyed while "Written reminder" is UNTICKED (Seth, 2026-08-07), not hidden. The
     * two are not the same thing: hiding it is what made the tab read as having no fields, and a box
     * you can type a whole consent script into that nothing will ever show is its own quiet lie.
     * The text is KEPT while it is off, so unticking and re-ticking does not cost the typing. */
    { k: 'consentMsg', type: 'textarea', dynOff: 'setup.off.consentMsg' },
    // THE ONE DIVERGENCE FROM THE PANEL — a file picker where the panel has a Drive URL box.
    { k: 'consentAudioFile', type: 'file', accept: 'audio/*', standalone: true, note: 'setup.consentFileNote' },
    { k: 'consentConfirm', type: 'multicheck', opts: ['yesno', 'record', 'signature'], optPrefix: 'panel.opt.conf.', note: 'consent.note' },
  ] },
  { id: 'sending', legend: 'research.sendLegend', details: ['relay.summary', 'relay.note'], detailsOff: 'setup.off.relay', fields: [
    // Upload rides the researcher's Google Drive (see notes/uploadoauthdriveplan): a standalone
    // device holds no OAuth, and openShareMenu() already hides the button when there is no target.
    { k: 'sendOptions', type: 'multicheck', opts: SETUP_SEND_OPTS, optPrefix: 'panel.opt.send.',
      offOpts: { upload: 'setup.off.upload' }, note: 'setup.sendNote' },
    // Both of these are downstream of an upload that cannot happen: autoBackupSweep() bails on
    // !Sync.workerUploadTarget(), and deleteAfterUpload() is only ever consulted once an upload
    // has succeeded. Dead switches, so they say so.
    { k: 'autoDel', type: 'checkbox', off: 'setup.off.autoDel', note: 'research.autoDelNote' },
    { k: 'autoBackup', type: 'checkbox', off: 'setup.off.autoBackup' },
    { k: 'autoBackupMins', type: 'select', opts: ['5', '15', '30', '60'], optPrefix: 'panel.opt.abm.', off: 'setup.off.autoBackup' },
    // Left ENABLED on purpose: it is the Recorder's welcome heading, which this app does not paint —
    // but the same origin opened with ?mode=record does, so it is not inert, just not visible here.
    { k: 'recordWelcome', type: 'text' },
  ] },
  { id: 'other', fields: [
    { k: 'buttons', type: 'multicheck', opts: ALL_BUTTONS, optPrefix: 'panel.opt.btn.' },
    // deleteAllAllowed() and allowDeleteOn() both short-circuit on !Sync.hasSession(), so on a
    // standalone app these are already ON and cannot be turned off — the switch would be a lie.
    { k: 'deleteAllEnabled', type: 'checkbox', off: 'setup.off.deleteAllEnabled' },
    { k: 'allowDelete', type: 'checkbox', off: 'setup.off.allowDelete' },
    // "Done" reports to a researcher and auto-uploads. Neither end exists here.
    { k: 'doneEnabled', type: 'checkbox', off: 'setup.off.doneEnabled' },
    // Fully meaningful standalone (a local list order), so no `off` note — unlike its neighbours.
    { k: 'sortAlpha', type: 'checkbox' },
  ] },
];

/* CONSENT AUDIO ON A STANDALONE APP — a picked file, not a Drive link.
 *
 * ⚠ THIS ADDS NO NEW ROUTE THROUGH THE CONSENT FLOW, and that is the whole design. requestConsentThen
 * already reads the prompt as:
 *     ensureAsset('asset:consent-prompt', settings.consentAudio, …) || getAsset('asset:consent-prompt')
 * ensureAsset returns null the moment there is no URL, so a blob written straight into that same
 * media key is picked up by the EXISTING fallback — playback, the IRB freeze of the exact prompt
 * that was played, and the copy bundled beside the response all keep working untouched.
 *
 * ⚠ URL AND FILE CANNOT BOTH BE LIVE: ensureAsset re-fetches into that one key and would overwrite
 * the picked file. So a URL always WINS — `consentLocalAudio()` reports a local file only while
 * settings.consentAudio is empty. That is what makes a later pairing safe: the researcher pushes a
 * Drive URL, it takes precedence with no migration step, and nothing here has to notice.
 *
 * The picked File is held in memory until Save, so cancelling a half-edited form cannot replace the
 * prompt a device is already using.
 */
let pendingConsentFile = null;
// The local consent prompt in force, or null. A pushed Drive URL silently outranks it (see above).
function consentLocalAudio() {
  return (!settings.consentAudio && settings.consentAudioFile) ? settings.consentAudioFile : null;
}

const setupFmtDur = (secs) => { const m = Math.floor(secs / 60), s = secs % 60; return s ? `${m} min ${s} s` : `${m} min`; };
const setupMb = (bytes) => { const mb = bytes / 1048576; return mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1); };

/* A field that cannot act on a standalone device. Renders the reason UNDER the control, always
 * visible — and the `.setup-off` click handler toasts the same sentence, because a subtle line is
 * easy to miss and a click is exactly what someone does when a control refuses them.
 *
 * ⚠ The visible reason is not decoration. A bare `disabled` attribute reads as "broken", which is
 * the bug Seth's standing rule exists to prevent; the reason is what makes disabling honest instead.
 * Never render an `off:` field without it. */
function setupOffHtml(why) {
  return `<p class="note setup-off-why">${esc(t(why))}</p>`;
}
/* Which options of a multicheck this DEVICE cannot offer, and WHY — { value: reasonKey }.
 *
 * Two sources. `f.offOpts` is a fixed rule of the surface (upload needs a paired researcher, which
 * a standalone app can never have). The rest is asked of the BROWSER, because some of it is not
 * knowable in advance: desktop Firefox and Safari have no navigator.share for files, so ticking
 * Share there configures a button that cannot appear.
 *
 * ⚠ THIS IS ONLY SOUND BECAUSE THIS FORM CONFIGURES **THIS** DEVICE. The researcher panel must
 * never capability-gate: it configures OTHER people's devices, whose browsers it cannot see, and
 * disabling Share there because the RESEARCHER's laptop lacks it would withhold a working feature
 * from every phone in the field. */
function setupOffOpts(f) {
  const out = { ...(f.offOpts || {}) };
  if (f.k === 'sendOptions' && !canShareFiles()) out.share = 'setup.off.share';
  return out;
}

// The short marker that sits inline with the label, so the row reads as unavailable at a glance.
function setupOffMark() { return `<span class="setup-off-mark">${esc(t('setup.offMark'))}</span>`; }

// One field → its markup. `data-sf` (not the panel's `data-f`) so the two forms can never select
// into each other if the researcher panel is opened while the Settings tab is in the DOM.
function setupFieldHtml(f) {
  const label = esc(t('panel.f.' + f.k));
  const tip = f.tip ? ` title="${esc(t(f.tip))}"` : '';
  const note = f.note ? `<p class="note">${t(f.note)}</p>` : '';
  // An inert field keeps its real control, disabled, plus a reason. `data-off` carries the reason
  // to the click handler; `.setup-off` is what CSS greys and what the handler listens for.
  const off = f.off ? ' disabled' : '';
  const offWrap = (inner) => (f.off
    ? `<div class="setup-off" data-off="${esc(f.off)}">${inner}${setupOffHtml(f.off)}</div>` : inner);

  if (f.type === 'checkbox') {
    return offWrap(`<label class="check-label"><input type="checkbox" data-sf="${f.k}"${off}> ${label}${f.off ? ' ' + setupOffMark() : ''}</label>${note}`);
  }
  if (f.type === 'multicheck') {
    const offOpts = setupOffOpts(f);                     // { optionValue: reasonKey }
    const boxes = f.opts.map((o) => {
      const why = offOpts[o];
      // ⚠ The option keeps its real checkbox, disabled — NOT a <span>. The first cut rendered it as
      // italic text and Seth read that as the control having gone missing rather than being off.
      return `<label class="check-label rp-inline${why ? ' setup-off' : ''}"${why ? ` data-off="${esc(why)}"` : ''}>`
           + `<input type="checkbox" data-sf="${f.k}" data-v="${o}"${why ? ' disabled' : ''}> ${esc(t((f.optPrefix || '') + o))}</label>`;
    }).join('');
    // One reason line per DISTINCT reason — two gated options for the same cause say it once.
    const whys = [...new Set(Object.values(offOpts))].map(setupOffHtml).join('');
    return `<div class="rp-field"><span>${label}</span><div class="rp-multi">${boxes}</div>${whys}</div>${note}`;
  }
  if (f.type === 'action') {
    return `<div class="rp-field"><button type="button" class="secondary-btn" data-sact="${f.k}">${label}</button></div>`
         + `<p class="note">${esc(t('panel.f.archivalNote'))}</p>`;
  }
  if (f.type === 'range') {
    return `<label class="rp-field"><span>${label} — <span id="ds-maxrec-lbl"></span></span>`
         + `<input type="range" data-sf="${f.k}" min="0" max="3600" step="10"></label><p class="note" id="ds-maxrec-est"></p>`;
  }
  /* The consent prompt as a LOCAL FILE (standalone only — a paired device is handed a Drive URL by
   * its researcher). `data-sfile`, deliberately NOT `data-sf`: a file input's .value is a fake path,
   * so it must stay out of collectDeviceSetup/fillDeviceSetup entirely. */
  if (f.type === 'file') {
    return `<div class="rp-field"><span>${label}</span>`
         + `<input type="file" data-sfile="${f.k}" accept="${esc(f.accept || '')}">`
         + `<p class="note ds-consent-file" id="ds-consent-file"></p></div>${note}`;
  }
  if (f.type === 'select') {
    const opts = f.opts.map((o) => `<option value="${esc(o)}">${esc(f.optPrefix ? t(f.optPrefix + o) : o)}</option>`).join('');
    // The recording format is the one setting whose consequences are invisible here — whether the
    // result can be called an archival master at all is not guessable from a name in a dropdown.
    const help = f.help === 'recfmt'
      ? `<p class="note"><button type="button" class="link-btn" data-sact="recfmtHelp">${esc(t('recfmt.helpLink'))}</button></p>` : '';
    return offWrap(`<label class="rp-field"><span>${label}${f.off ? ' ' + setupOffMark() : ''}</span><select data-sf="${f.k}"${off}>${opts}</select></label>`) + help + note;
  }
  /* A field that goes on and off with ANOTHER field on the same form. The wrapper, the mark and the
   * reason line are all rendered up front and toggled by updateSetupConditionals — building them on
   * demand would mean the enabled state has no `.setup-off` for the click handler to find, which is
   * the half of the rule that makes a greyed control answer when someone clicks it. */
  if (f.type === 'textarea') {
    const body = `<label class="rp-field"><span>${label}${f.dynOff ? ` <span class="setup-off-mark" hidden></span>` : ''}</span>`
               + `<textarea data-sf="${f.k}" rows="2"></textarea></label>`;
    if (!f.dynOff) return body + note;
    return `<div class="setup-dyn" data-dynoff="${esc(f.dynOff)}">${body}`
         + `<p class="note setup-off-why" hidden>${esc(t(f.dynOff))}</p></div>${note}`;
  }
  const ph = f.ph ? ` placeholder="${esc(f.ph)}"` : '';
  return offWrap(`<label class="rp-field"${tip}><span>${label}${f.off ? ' ' + setupOffMark() : ''}</span><input data-sf="${f.k}" spellcheck="false"${ph}${tip}${off}></label>`) + note;
}

// The archive-quality warning heading the Recording group. A website-installed (PWA) device cannot
// make archive-grade recordings, and it is the single most consequential thing someone can get
// wrong here without ever being told.
function setupNoticeHtml(kind) {
  if (kind !== 'pwaAudio') return '';
  return `<div class="rp-notice"><b>${esc(t('panel.notice.audioTitle'))}</b>${t('panel.notice.audioBody')}`
       + `<p class="note">${esc(t('panel.notice.audioSoon'))}</p></div>`;
}

function setupGroupHtml(g) {
  const notice = g.notice ? setupNoticeHtml(g.notice) : '';
  const note = g.note ? `<p class="note">${t(g.note)}</p>` : '';
  // detailsOff: the disclosure is about a route this device does not have (the >500 MB upload
  // note). Greyed and unopenable, with the same reason treatment as any other inert control —
  // removing it would leave a researcher wondering where the guidance went.
  const details = !g.details ? ''
    : (g.detailsOff
        ? `<div class="setup-off" data-off="${esc(g.detailsOff)}"><p class="advanced-off">${esc(t(g.details[0]))} ${setupOffMark()}</p>${setupOffHtml(g.detailsOff)}</div>`
        : `<details class="advanced"><summary>${esc(t(g.details[0]))}</summary><div class="note">${t(g.details[1])}</div></details>`);
  const fields = g.fields.map(setupFieldHtml).join('');
  return `<div class="rp-group" id="ds-grp-${g.id}" role="tabpanel" aria-labelledby="ds-tab-${g.id}" data-group="${g.id}" hidden>`
       + `${notice}${note}<fieldset class="rp-fieldset"><legend>${esc(t(g.legend || 'panel.grp.' + g.id))}</legend>${fields}${details}</fieldset></div>`;
}

// Stored settings → the form's canonical values.
function deviceSetupValues() {
  const s = settings || {};
  const v = {};
  for (const g of SETUP_GROUPS) for (const f of g.fields) {
    // ⚠ An `off:` field is still filled from the stored value. Disabled means "you cannot change
    // this here", never "this shows nothing" — a greyed box displaying a blank where a real setting
    // lives would misreport the device.
    if (f.type === 'action' || f.type === 'file') continue;
    // sendOptions / toolbarButtons: absent or empty means "all of them" to allowedSend() and
    // allowedButtons(), so show all of them ticked rather than an empty row that reads as "none".
    if (f.k === 'sendOptions') v.sendOptions = s.sendOptions?.length ? s.sendOptions : SETUP_SEND_OPTS.slice();
    else if (f.k === 'buttons') v.buttons = Array.isArray(s.toolbarButtons) ? s.toolbarButtons : ALL_BUTTONS.slice();
    else if (f.k === 'consentAsk') v.consentAsk = consentAskList();
    else if (f.k === 'consentConfirm') v.consentConfirm = consentConfirmList();
    else if (f.k === 'autoDel') v.autoDel = !!s.autoDelUploaded;                       // stored as autoDelUploaded
    // Unset export toggles follow Audio Segmentation Mode — show the EFFECTIVE value.
    else if (SETUP_EXPORT_KEYS.includes(f.k)) v[f.k] = s[f.k] ?? segmentationEnabled();
    /* The unpaired device's OWN Settings tab has the same unset-means-on rule as the panel and
     * segmentationEnabled() — a fresh standalone install must not render the box unchecked and
     * then SAVE a false, which is exactly how a paired device lost the mode on its first push
     * (Seth, 2026-08-12). One default, three surfaces. */
    else if (f.k === 'segmentation') v.segmentation = s.segmentation !== false;
    else if (f.k === 'cutTab') v.cutTab = s.cutTab !== false;
    else if (f.k === 'landOnCut') v.landOnCut = s.landOnCut !== false;
    else if (f.k === 'joinSplitBaseline') v.joinSplitBaseline = s.joinSplitBaseline !== false;
    else if (f.k === 'joinSplitGloss') v.joinSplitGloss = s.joinSplitGloss !== false;
    else if (f.k === 'cutJoinTexted') v.cutJoinTexted = s.cutJoinTexted === true;
    else if (f.k === 'recordFormat') v.recordFormat = recordFormatPref();
    else if (f.k === 'agc') v.agc = SETUP_AGC_OPTS.includes(s.agc) ? s.agc : 'off';
    else if (f.type === 'checkbox') v[f.k] = !!s[f.k];
    else if (f.type === 'range') v[f.k] = parseInt(s[f.k], 10) || 0;
    else if (f.type === 'select') v[f.k] = s[f.k] || f.opts[0];
    else v[f.k] = s[f.k] || '';
  }
  return v;
}

function fillDeviceSetup() {
  /* ⚠ NEVER REFILL THE FORM FROM ITS OWN SAVE — see saveDeviceSetupLive. applyLiveSettings()
   * repaints every settings-driven surface and this is one of them, so a save triggered by typing
   * would rewrite the input under the caret and jump it to the end on every keystroke. The form is
   * already showing exactly what was stored: it is where the value came from. */
  if (savingLive) return;
  const box = $('#device-setup');
  if (!box || !box.querySelector('[data-sf]')) return;   // not built (no Settings tab, or paired)
  const v = deviceSetupValues();
  box.querySelectorAll('[data-sf]').forEach((el) => {
    const k = el.dataset.sf;
    if (el.type === 'checkbox') el.checked = el.dataset.v ? (Array.isArray(v[k]) && v[k].includes(el.dataset.v)) : !!v[k];
    else el.value = v[k] != null ? v[k] : '';
  });
  updateSetupConditionals(box);
}

// Collect the form keyed by field id. Shared by the save and the validation gate.
function collectDeviceSetup(box) {
  const raw = {};
  box.querySelectorAll('[data-sf]').forEach((el) => {
    const k = el.dataset.sf;
    if (el.type === 'checkbox' && el.dataset.v) { (raw[k] = raw[k] || []); if (el.checked) raw[k].push(el.dataset.v); }
    else if (el.type === 'checkbox') raw[k] = el.checked;
    else raw[k] = (el.value || '').trim();
  });
  return raw;
}

/* Form → a settings patch. Only keys whose control is actually IN the form are written: a field
 * this surface drops (auto-backup and its interval) must keep whatever is stored, never be reset to
 * a default the user was never shown. */
function readDeviceSetup(box) {
  const raw = collectDeviceSetup(box);
  const patch = {};
  const has = (k) => !!box.querySelector(`[data-sf="${k}"]`);
  // Keys whose stored name or type differs from the form field are written explicitly below.
  const SPECIAL = ['sendOptions', 'buttons', 'autoDel', 'maxRecordSeconds', 'recordFormat', 'agc',
                   ...SETUP_EXPORT_KEYS];
  for (const g of SETUP_GROUPS) for (const f of g.fields) {
    /* ⚠ `f.off` fields are DISPLAYED but never WRITTEN. They show the stored value greyed; writing
     * it back would let this surface silently re-assert a setting the user was told it does not
     * control — and would clobber whatever a researcher pushes the moment the device is paired. */
    if (f.type === 'action' || f.type === 'file' || f.off || SPECIAL.includes(f.k) || !has(f.k)) continue;
    patch[f.k] = raw[f.k];
  }
  /* ⚠ Exports: store an override ONLY when it DIFFERS from what Audio Segmentation Mode implies,
   * and store `undefined` (the save then deletes the key) when it matches again. Writing all four
   * every time would pin them the moment anybody opened this page — so turning the mode on and
   * saving in one go would silently write the exports OFF, and the .eaf files the mode promises
   * would never appear with nothing anywhere to explain it. */
  const segOn = !!raw.segmentation;
  for (const k of SETUP_EXPORT_KEYS) if (has(k)) patch[k] = (!!raw[k] === segOn) ? undefined : !!raw[k];
  patch.autoDelUploaded = !!raw.autoDel;                                  // the key the field client reads
  patch.maxRecordSeconds = parseInt(raw.maxRecordSeconds, 10) || 0;       // 0 = no limit
  patch.recordFormat = normRecFormat(raw.recordFormat);
  patch.agc = SETUP_AGC_OPTS.includes(raw.agc) ? raw.agc : 'off';
  patch.toolbarButtons = raw.buttons || [];
  /* Consent audio: this surface only ever sets a LOCAL FILE. It deliberately does not touch
   * consentAudioUrl / consentAudio — those belong to the researcher-pushed Drive route, and a
   * standalone device that is later paired must receive them intact. The blob itself is written to
   * the media store by the Save handler; this records only what it is, for display and validation. */
  if (pendingConsentFile) {
    patch.consentAudioFile = { name: pendingConsentFile.name, size: pendingConsentFile.size,
                               mime: pendingConsentFile.type || 'audio/mpeg' };
  }
  /* ⚠ The Upload option is not OFFERED here, so it must not be silently REMOVED either. Carry the
   * stored value through — mirroring allowedSend()'s "absent or empty means all four" — or a device
   * that is later paired would come up with uploading switched off and nothing to explain it. */
  patch.sendOptions = raw.sendOptions || [];
  const before = new Set(settings.sendOptions?.length ? settings.sendOptions : SETUP_SEND_OPTS);
  const gated = Object.keys(setupOffOpts(SETUP_GROUPS.flatMap((g) => g.fields).find((f) => f.k === 'sendOptions')));
  for (const o of gated) if (before.has(o) && !patch.sendOptions.includes(o)) patch.sendOptions.push(o);
  return patch;
}

/* Minimal-usable check: flag anything blank that would BREAK this device. ⚠ Since the Save button
 * went, this can no longer REFUSE a setup — the value is already stored by the time it runs — so it
 * warns, permanently and unmissably, instead. See flagSetupProblems' `advisory`.
 * Required: both writing-system codes (the WS is built only when vernLang
 * is set, and analLang silently falls back to 'en' — wrong for non-English work); the consent audio
 * link IF a spoken reminder is asked for; the consent message IF a written one is. Everything else
 * has a safe default. Returns [{ group, field, msg }] — empty means OK. */
function validateDeviceSetup(raw) {
  const blank = (v) => !v || !String(v).trim();
  const out = [];
  if (blank(raw.vernLang)) out.push({ group: 'languages', field: 'vernLang', msg: t('panel.val.vernLang') });
  if (blank(raw.analLang)) out.push({ group: 'languages', field: 'analLang', msg: t('panel.val.analLang') });
  /* ⚠ A DEVICE MUST HAVE SOME WAY TO GET WORK OUT (Seth, 2026-08-07): "it is definitely possible to
   * set up an app as a dead end that can't save or send anything outside browser storage." Ticking
   * nothing here produced exactly that — texts recorded and glossed into IndexedDB with no route to
   * a file, a phone, or a researcher, and nothing anywhere saying so.
   *
   * ⚠ UPLOAD DOES NOT COUNT ON THIS FORM. It is disabled here precisely because a standalone app
   * has no Drive account, so accepting it as "a way out" would let the dead end back in through the
   * one control that cannot act. Share is browser-dependent; Save always works (picker or plain
   * download), so a valid setup always exists. */
  /* ⚠ SHARE IS NOT A WAY OUT FOR THE WORK, only for the words (Seth, 2026-08-07). Chromium's
   * navigator.share() accepts an allowlisted set of file types, and neither XML nor ZIP is on it —
   * so Share sends the bare .flextext renamed .txt and NOTHING else: no audio, no EAF, no .fxpa, no
   * preview page, no derived WAV. A device permitted only Share can record and gloss and align for
   * weeks and never get one second of audio off itself. That is the dead end, wearing a working
   * button. Save always works here (picker, or a plain download where the browser has no picker),
   * so a valid setup always exists; upload is disabled on this form and cannot count. */
  const send = Array.isArray(raw.sendOptions) ? raw.sendOptions : [];
  if (!send.includes('save')) {
    out.push({ group: 'sending', field: 'sendOptions', msg: t('setup.val.sendNone') });
  }
  const ask = Array.isArray(raw.consentAsk) ? raw.consentAsk : [];
  // A spoken reminder needs SOMETHING to play: a file picked just now, one already stored, or a
  // Drive URL a researcher pushed before this device was unpaired again.
  const haveAudio = !!(pendingConsentFile || consentLocalAudio() || settings.consentAudio);
  if (ask.includes('audio') && !haveAudio) out.push({ group: 'consent', field: 'consentAudioFile', msg: t('setup.val.consentFile') });
  if (ask.includes('text') && blank(raw.consentMsg)) out.push({ group: 'consent', field: 'consentMsg', msg: t('panel.val.consentMsg') });
  return out;
}

// Paint validation errors where they cannot be missed: a banner listing every problem field WITH
// its tab (each entry jumps there), a red dot on each offending tab, and an inline "why" on the
// field. Cleared and recomputed on every save. Same shape — and the same CSS — as the researcher
// panel's flagProblems, so an error looks the same in both places.
/* ⚠ Finds a field by EITHER attribute. The consent file picker is `data-sfile` (a file input's
 * .value is a fake path, so it has to stay out of collect/fill) — and a validation problem naming
 * it would otherwise attach to nothing: the banner appeared, the field said nothing, and the form
 * looked like it was refusing for no reason. Caught by the browser test, not by reading. */
const setupFieldEl = (box, k) => box.querySelector(`[data-sf="${k}"], [data-sfile="${k}"]`);

/* ⚠ `advisory` IS THE WHOLE DIFFERENCE THE SAVE BUTTON'S REMOVAL MADE, and it is not cosmetic.
 * A blocking check ran once, on a deliberate click, and could fairly take the tab, the focus and a
 * toast — the user had just asked for the form to be judged. A live save re-checks after every
 * keystroke, and doing any of those things then is actively hostile: it would yank the tab away
 * mid-edit, pull focus out of the field being typed in, and toast on every character.
 * So in advisory mode the marks are painted and NOTHING MOVES. The banner and the red tab dots are
 * permanent and unmissable, which is what has to carry the weight now that nothing can refuse. */
function flagSetupProblems(box, problems, showGroup, { advisory = false } = {}) {
  box.querySelectorAll('.rp-invalid').forEach((el) => el.classList.remove('rp-invalid'));
  box.querySelectorAll('.rp-fielderr').forEach((el) => el.remove());
  box.querySelectorAll('.rp-tab.rp-tab-err').forEach((el) => el.classList.remove('rp-tab-err'));
  const old = box.querySelector('.rp-valbanner'); if (old) old.remove();
  if (!problems.length) return;

  const labelFor = (p) => t('panel.val.fieldAtTab', { field: t('panel.f.' + p.field), tab: t('panel.grp.' + p.group) });
  for (const p of problems) {
    const el = setupFieldEl(box, p.field);
    if (el) {
      const wrap = el.closest('.rp-field, .check-label') || el;
      wrap.classList.add('rp-invalid');
      const err = document.createElement('div');
      err.className = 'rp-fielderr';
      err.textContent = p.msg;
      wrap.appendChild(err);
    }
    const tab = box.querySelector(`.rp-tab[data-tab="${p.group}"]`);
    if (tab) tab.classList.add('rp-tab-err');   // errors on other tabs stay visible too
  }
  const banner = document.createElement('div');
  banner.className = 'rp-valbanner';
  banner.innerHTML = `<strong>${esc(t('panel.val.bannerTitle'))}</strong><ul>${problems.map((p) =>
    `<li><button type="button" class="rp-valjump" data-grp="${esc(p.group)}" data-fld="${esc(p.field)}">${esc(labelFor(p))}</button></li>`).join('')}</ul>`;
  /* ⚠ BELOW THE TAB ROW, NOT ABOVE IT — and this is a bug fix, not a layout preference.
   * The panel's banner sits above its tabs safely because it only ever appears on a deliberate Save
   * click, when nothing else is in flight. Here it can appear at ANY moment, and the moment it most
   * often does is mousedown on a tab: pressing the tab blurs the text field, `change` fires, the
   * save runs, the banner is inserted — and if it goes above the tabs the whole row jumps down
   * between press and release, so mouseup lands somewhere else and THE TAB CLICK IS SWALLOWED.
   * Caught by the browser test, which could not reach the consent tab after typing in Languages.
   * Below the row, the navigation never moves; only the fields under it do, which they were about
   * to anyway. */
  const tabs = box.querySelector('.rp-tabs');
  if (tabs && tabs.parentNode) tabs.parentNode.insertBefore(banner, tabs.nextSibling); else box.prepend(banner);
  banner.querySelectorAll('.rp-valjump').forEach((btn) => btn.addEventListener('click', () => {
    showGroup(btn.dataset.grp);
    const f = setupFieldEl(box, btn.dataset.fld);
    if (f) { try { f.focus(); } catch { /* noop */ } }
  }));
  if (advisory) return;                 // never move the tab, the focus or the toast while typing
  showGroup(problems[0].group);
  const first = setupFieldEl(box, problems[0].field);
  if (first) { try { first.focus(); } catch { /* noop */ } }
  const firstLabel = labelFor(problems[0]);
  toast(problems.length === 1
    ? t('panel.val.summaryOne', { field: firstLabel })
    : t('panel.val.summaryMany', { field: firstLabel, more: problems.length - 1 }), 6000);
}

/* Audio Segmentation Mode was just toggled. Move the export boxes that are STILL FOLLOWING it
 * (no stored value of their own) so the form shows what the device would actually write. An export
 * the user has deliberately set is an override and is left exactly where they put it. */
function syncSetupExports(box) {
  const seg = box.querySelector('[data-sf="segmentation"]');
  if (!seg) return;
  for (const k of SETUP_EXPORT_KEYS) {
    if (settings[k] !== undefined) continue;
    const el = box.querySelector(`[data-sf="${k}"]`);
    if (el) el.checked = seg.checked;
  }
}

/* Switch a field that depends on ANOTHER field on this form on or off. It reuses `.setup-off` — the
 * same class, the same greying, the same click-to-explain — so a control that is off for a live
 * reason is indistinguishable from one that is off for a structural reason. That is deliberate: to
 * the person looking at it, "off because you unticked the box above" and "off because this app has
 * no researcher" are the same question, and both deserve the same answer in the same place. */
function setupDynOff(box, key, off) {
  const ctrl = box.querySelector(`[data-sf="${key}"]`);
  const wrap = ctrl && ctrl.closest('.setup-dyn[data-dynoff]');
  if (!wrap) return;
  const why = wrap.querySelector('.setup-off-why');
  const mark = wrap.querySelector('.setup-off-mark');
  wrap.classList.toggle('setup-off', off);
  // `data-off` is what the capture-phase click handler reads, so it must appear and disappear with
  // the state — left behind, an ENABLED field would toast an explanation for something that is on.
  if (off) wrap.dataset.off = wrap.dataset.dynoff; else delete wrap.dataset.off;
  if (ctrl) ctrl.disabled = off;
  if (why) why.hidden = !off;
  if (mark) { mark.hidden = !off; mark.textContent = t('setup.offMarkDyn'); }
}

/* Live bits that depend on other fields. ⚠ The consent message / audio rows are NOT hidden until
 * their reminder is ticked any more — the panel shows them always, and hiding them here read as
 * "the consent tab has no fields" (Seth, 2026-08-07). Only the max-length readout is live now,
 * plus the line naming the consent audio actually in force. */
function updateSetupConditionals(box) {
  const slider = box.querySelector('[data-sf="maxRecordSeconds"]');
  const lbl = box.querySelector('#ds-maxrec-lbl'), est = box.querySelector('#ds-maxrec-est');
  if (slider && lbl && est) {
    const secs = parseInt(slider.value, 10) || 0;
    const fmtSel = box.querySelector('[data-sf="recordFormat"]');
    const bps = SETUP_BPS[fmtSel ? fmtSel.value : DEFAULT_REC_FORMAT] || SETUP_BPS[DEFAULT_REC_FORMAT];
    lbl.textContent = secs ? setupFmtDur(secs) : t('panel.f.maxRecUnlimited');
    est.textContent = secs ? t('panel.crowd.estimate', { mb: setupMb(bps * secs) })
                           : t('panel.f.perMinEstimate', { mb: setupMb(bps * 60) });
  }
  /* "Written reminder" off ⇒ the consent message is inert (Seth, 2026-08-07). Same two halves as
   * every other disabled control here: greyed AND saying why, inline and on click. Turning it back
   * on restores the text — nothing is cleared, only ignored. */
  const askText = !!box.querySelector('[data-sf="consentAsk"][data-v="text"]:checked');
  setupDynOff(box, 'consentMsg', !askText);

  const cf = box.querySelector('#ds-consent-file');
  if (cf) {
    const local = consentLocalAudio();
    /* Three states, and they must be distinguishable: a file being written to the media store right
     * now, a file already in force, or nothing. The first is brief but not instant — a long prompt
     * is megabytes — and it is the window in which the file is NOT yet the one that would play. */
    /* ⚠ "Now playing" MUST NOT BE SAID WHEN IT IS NOT PLAYING. A file can be stored while the
     * Spoken reminder box is unticked, and then nothing plays — Seth picked an mp3, saw this line
     * claim it was in use, recorded, and got no audio. The file was fine; the sentence was false.
     * A stored file and an enabled prompt are two different facts, so say which one you have. */
    const askAudio = !!box.querySelector('[data-sf="consentAsk"][data-v="audio"]:checked');
    if (pendingConsentFile) cf.textContent = t('setup.consentFilePending', { name: pendingConsentFile.name });
    else if (local && askAudio) cf.textContent = t('setup.consentFileCurrent', { name: local.name });
    else if (local) cf.textContent = t('setup.consentFileIdle', { name: local.name });
    // A researcher-pushed Drive URL outranks any local file, so say so rather than showing "none".
    else if (settings.consentAudio) cf.textContent = t('setup.consentFileFromResearcher');
    else cf.textContent = t('setup.consentFileNone');
  }
}

/* Build the Settings tab's form. Called on every entry to the tab (and after a live settings
 * change), so the language, the stored values and the pairing state are always current.
 *
 * ⚠ RULE 2 IS ENFORCED HERE, not only by the tab's visibility: a paired device gets NO editable
 * surface, because its settings come from its researcher and a second one would disagree. */
function renderDeviceSetup() {
  const box = $('#device-setup');
  if (!box) return;                                   // satellite shells have no Settings tab
  if (Sync.hasSession()) { box.replaceChildren(); box.innerHTML = `<p class="note">${esc(t('setup.managed'))}</p>`; return; }

  /* ⚠ The listeners below are delegated to `form`, a FRESH element on every render, and installed
   * by replacing #device-setup's children. Attaching them to #device-setup itself would stack a new
   * set on every entry to the Settings tab — that element survives a re-render, so one Save click
   * would eventually save N times. Discarding the wrapper discards its listeners with it. */
  const form = document.createElement('div');
  form.innerHTML = `
    <div class="rp-tabs" role="tablist">${SETUP_GROUPS.map((g, i) =>
      `<button type="button" class="rp-tab${i === 0 ? ' on' : ''}" role="tab" id="ds-tab-${g.id}" aria-controls="ds-grp-${g.id}" aria-selected="${i === 0}" data-tab="${g.id}">${esc(t('panel.grp.' + g.id))}</button>`).join('')}</div>
    <div class="rp-groups">${SETUP_GROUPS.map(setupGroupHtml).join('')}</div>
    <p class="note rp-enc">${esc(t('setup.localNote'))}</p>
    <p class="note ds-saved" id="ds-saved" role="status" aria-live="polite"></p>`;
  box.replaceChildren(form);

  /* Only ever non-null between the file dialog closing and the save that immediately follows it.
   * Cleared on a rebuild so a pick that failed to commit is not re-attempted against a fresh form. */
  pendingConsentFile = null;
  const groups = form.querySelectorAll('.rp-group');
  const showGroup = (id) => {
    if (flushLiveSave) flushLiveSave();   // a half-typed field must not wait on a hidden tab
    groups.forEach((g) => { g.hidden = g.dataset.group !== id; });
    form.querySelectorAll('.rp-tab').forEach((b) => {
      const on = b.dataset.tab === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
  };
  form.querySelectorAll('.rp-tab').forEach((b) => b.addEventListener('click', () => showGroup(b.dataset.tab)));
  showGroup(SETUP_GROUPS[0].id);

  form.addEventListener('change', (e) => {
    // Only when the MODE switch itself moves: re-deriving on every change would undo an export the
    // user had just clicked off.
    if (e.target && e.target.dataset && e.target.dataset.sf === 'segmentation') syncSetupExports(form);
    /* The consent prompt file. Held in memory only as far as the save on the next line — a file
     * input's .value is a fake path, so it cannot go through collect/read like every other field.
     * A pick that fails to commit (quota, private mode) leaves the OLD prompt in place. */
    if (e.target && e.target.dataset && e.target.dataset.sfile === 'consentAudioFile') {
      const file = e.target.files && e.target.files[0];
      if (file) {
        // Refuse a non-audio pick HERE rather than at play time, when the speaker is waiting.
        if (file.type && !/^audio\//.test(file.type)) {
          e.target.value = '';
          toast(t('setup.consentFileNotAudio', { name: file.name }), 6000);
          return;
        }
        pendingConsentFile = file;
      }
    }
    updateSetupConditionals(form);
    // A committed choice — a box ticked, a dropdown moved, a text field left. Store it NOW.
    saveDeviceSetupLive(form, showGroup, { immediate: true });
  });
  /* Typing. Debounced, because a save per keystroke would repaint the doc list under the user —
   * but still a save, so nothing is ever sitting in the form waiting to be lost. `change` fires on
   * blur for text fields and would cover it, except that a user who types a writing-system code and
   * closes the tab without leaving the field never blurs. */
  form.addEventListener('input', (e) => {
    if (e.target.type === 'range') updateSetupConditionals(form);
    if (e.target.type === 'file') return;         // handled by `change`, with the blob
    saveDeviceSetupLive(form, showGroup);
  });
  /* ⚠ THE HALF THAT MAKES DISABLING HONEST. A disabled control is what someone clicks when it
   * refuses them, so the click has to answer. Capture phase and a listener on the CONTAINER,
   * because a disabled <input> dispatches no events of its own — the click lands on the wrapping
   * label/div, which is exactly what carries data-off. */
  form.addEventListener('click', (e) => {
    const off = e.target.closest('.setup-off');
    if (off && off.dataset.off) { toast(t(off.dataset.off), 7000); return; }
  }, true);
  form.addEventListener('click', (e) => {
    const act = e.target.closest('[data-sact]');
    if (!act) return;
    const which = act.dataset.sact;
    // Rule 4's action: the same invite-paste flow the Texts toolbar offers, reached FROM the
    // explanation of what is missing rather than from somewhere the reader has to go and find.
    if (which === 'pair') { showInvitePasteModal(); return; }
    if (which === 'recfmtHelp') { const m = $('#recformat-help-modal'); if (m) m.hidden = false; return; }
    if (which === 'archivalDefaults') {
      const set = (k, v) => { const el = form.querySelector(`[data-sf="${k}"]`); if (el) el.value = v; };
      set('recordFormat', 'wav24');
      set('agc', 'off');
      for (const k of ['nr', 'echo', 'norm']) { const el = form.querySelector(`[data-sf="${k}"]`); if (el) el.checked = false; }
      updateSetupConditionals(form);
      toast(t('panel.f.archivalSet'), 4000);
      // Setting .value/.checked from script fires no `change`, so this one has to save itself.
      saveDeviceSetupLive(form, showGroup, { immediate: true });
      return;
    }
  });

  fillDeviceSetup();
  /* ⚠ PAINT THE PROBLEMS ON ENTRY, not only after an edit (Seth, 2026-08-07): "if I clear it,
   * switch to the text tab, and then switch back, the warning banner is gone. That validation
   * behavior only BLOCKED me from saving unworkable changes when those changes required a Save
   * button."
   *
   * He is right, and it was the real cost of removing the button. A blocking check needed to run
   * only at the moment of saving, because nothing broken could get past it. An advisory one has no
   * such moment — so if it is painted only in response to an edit, a device left half-configured
   * looks completely fine the next time anybody opens the page. The warning has to be a property of
   * the STATE, not a reaction to a keystroke; that is what makes it a real replacement for the
   * refusal rather than a softer version of it. Advisory here too: opening the tab must not seize
   * a tab or the focus, only show what is wrong. */
  flagSetupProblems(form, validateDeviceSetup(collectDeviceSetup(form)), showGroup, { advisory: true });
}

/* ⚠ SETTINGS SAVE THEMSELVES, THE MOMENT THEY CHANGE (Seth, 2026-08-07). There is no Save button.
 *
 * The Save-button version lost work in a way nobody could see coming: pick a consent file, and the
 * tick you had already put in "Spoken reminder" was sitting in unsaved form state, one navigation or
 * re-render away from being gone. Every "did that take?" question, and every bug of the shape "it
 * forgot what I set", comes from the gap between changing a control and committing it. Removing the
 * gap removes the whole class rather than the instance.
 *
 * VALIDATION BECOMES ADVISORY, and that is the real trade. It used to BLOCK the save, which is what
 * stopped a half-configured device existing. It can no longer block — the value is already stored —
 * so the problems are painted as persistent, unmissable warnings instead. That is the honest
 * position: the researcher is mid-edit, and refusing to remember what they typed does not make the
 * device more correct, it just loses the typing.
 *
 * ⚠ NEVER REFILL THE FORM FROM ITS OWN SAVE. applyLiveSettings() repaints every settings-driven
 * surface, and fillDeviceSetup() is one of them — so a save triggered by typing would rewrite the
 * input under the caret and jump it to the end on every keystroke. `savingLive` makes
 * fillDeviceSetup a no-op for the duration; the form is already showing exactly what was stored,
 * because it is where the value came from. */
let savingLive = false;
let liveSaveTimer = null;
/* The debounced save, callable early. ⚠ 500ms is short but it is not zero, and "typed the last
 * character and walked away" is precisely the case this whole change exists to stop losing — so
 * every way out of the form flushes it: switching tab, hiding the page, closing it. */
let flushLiveSave = null;

async function saveDeviceSetupLive(form, showGroup, { immediate = false } = {}) {
  clearTimeout(liveSaveTimer);
  flushLiveSave = null;
  if (!immediate) {
    // Typing: settle first. A save per keystroke would re-render the doc list under the user.
    flushLiveSave = () => saveDeviceSetupLive(form, showGroup, { immediate: true });
    liveSaveTimer = setTimeout(() => { if (flushLiveSave) flushLiveSave(); }, 500);
    return;
  }
  /* A re-render (leaving and re-entering the Settings tab) replaces the form wrapper. A timer that
   * fires afterwards holds the DETACHED one, and writing from it would restore whatever it happened
   * to be showing over the live form's values. */
  if (!form.isConnected) return;
  /* Commit a picked prompt to the media key requestConsentThen already falls back to. BEFORE the
   * settings write, so a failure here (quota, private mode) leaves the old prompt AND the old
   * setting in place rather than a setting pointing at nothing. */
  if (pendingConsentFile) {
    const f = pendingConsentFile;
    try {
      await db.putMedia('asset:consent-prompt', {
        blob: f, name: f.name, mimeType: f.type || 'audio/mpeg',
        // sourceId marks WHICH file this is, the role a Drive id plays for the URL route.
        sourceId: `local:${f.name}:${f.size}:${f.lastModified || 0}`,
      });
    } catch (err) {
      toast(t('setup.consentFileFailed', { msg: err.message }), 8000);
      return;
    }
  }
  /* ⚠ readDeviceSetup READS `pendingConsentFile` — clearing it before this line is why "Consent
   * audio doesn't play, nothing shows up" (Seth, 2026-08-07). The blob went into the media store
   * correctly, but `settings.consentAudioFile` was never written, so consentLocalAudio() returned
   * null and the prompt the user had just chosen was invisible to every consumer of it. Clear it
   * AFTER the patch has recorded which file is now in force. */
  const patch = readDeviceSetup(form);
  pendingConsentFile = null;
  Object.assign(settings, patch);
  // An undefined in the patch means "go back to having no stored value" (the export toggles that
  // follow the mode). Object.assign would leave the key present-but-undefined, which is NOT the
  // same thing to `??` once it has been through JSON.
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete settings[k];
  delete settings.consentMode;                 // superseded by the consentAsk array
  delete settings.consentResp;                 // superseded by the consentConfirm array
  saveSettings(settings);
  settings = loadSettings();
  savingLive = true;
  try {
    applyLiveSettings();                       // buttons, WS banner, doc list, live segmentation flip
    syncConsentAudio();
  } finally { savingLive = false; }
  // The consent-file line depends on the stored state, and this is the one bit of the form that is
  // NOT where the value came from — so repaint just that.
  updateSetupConditionals(form);
  flagSetupProblems(form, validateDeviceSetup(collectDeviceSetup(form)), showGroup, { advisory: true });
  markSetupSaved(form);
}

/* A quiet, non-blocking confirmation. Without the Save button there is no moment of commitment, so
 * something has to say "that was kept" — but a toast per keystroke would be its own kind of noise. */
function markSetupSaved(form) {
  const el = form.querySelector('#ds-saved');
  if (!el) return;
  el.textContent = t('setup.savedLive');
  el.classList.add('on');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('on'), 1800);
}

/* Leaving the page mid-debounce. `visibilitychange` is the one that actually fires on mobile — a
 * backgrounded or swiped-away PWA may never get `pagehide` at all, and on iOS never gets `unload`.
 * The settings write itself is synchronous localStorage, so it completes inside either callback. */
document.addEventListener('visibilitychange', () => { if (document.hidden && flushLiveSave) flushLiveSave(); });
window.addEventListener('pagehide', () => { if (flushLiveSave) flushLiveSave(); });

/* ---------------- Utilities: the audio converter ------------------------------------------------
 *
 * ⚠ MIRRORS researcher-panel.js audioConverterModal() FEATURE FOR FEATURE, and is deliberately not
 * shared with it (same reason as SETUP_GROUPS: that module is also the standalone Researcher app's,
 * so an editor screen must not route through it). Before this, the editor offered MP3 only, at a
 * fixed bitrate and sample rate — so a standalone researcher simply could not reach conversions the
 * panel performs. Keep the two in step by hand; test/audio-converter.test.mjs makes drift loud.
 *
 * ⚠ WHAT validOutputs() ENFORCES, AND WHY IT IS NOT A UI DETAIL: only DOWNWARD conversions are ever
 * offered. A lossy source can become a smaller MP3 and nothing else — never WAV or FLAC, because
 * that produces a file which LOOKS archival and is not ("fake lossless"; the lossy damage is
 * permanent). The option list comes from the source's real format and bit depth, so the UI cannot
 * offer a conversion the rules forbid. Never widen this list from the UI side.
 */
function ucFmtLabel(v) { const s = t('convert.fmt.' + v); return s === 'convert.fmt.' + v ? v : s; }

/* A small WaveSurfer player. split:true stacks one waveform PER CHANNEL, so a stereo file shows
 * both — which is what makes the "left"/"right" mono options meaningful: you can SEE which channel
 * carries the voice before choosing. normalize is off when split, so a near-silent channel reads as
 * flat (honest) instead of being boosted to look like signal. */
function ucMakePlayer(host, url, split) {
  host.innerHTML = `<button type="button" class="player-play cv-play" aria-label="${esc(t('convert.play'))}">▶</button><div class="cv-wave"></div>`;
  host.hidden = false;
  const ws = WaveSurfer.create({
    container: host.querySelector('.cv-wave'),
    url, height: split ? 38 : 54, normalize: !split,
    waveColor: '#9db4d4', progressColor: '#1f4f8f', cursorColor: '#c0392b', cursorWidth: 2,
    dragToSeek: true, splitChannels: split ? true : undefined,
  });
  const btn = host.querySelector('.cv-play');
  btn.onclick = () => { try { ws.playPause(); } catch { /* not ready */ } };
  ws.on('play', () => { btn.textContent = '⏸'; });
  ws.on('pause', () => { btn.textContent = '▶'; });
  ws.on('finish', () => { btn.textContent = '▶'; });
  ws.on('error', (e) => { console.warn('converter player:', e); });
  return ws;
}

/* ── MAKE FILES FROM A PICKED .flextext + ITS RECORDING ────────────────────────────────────────
 * Seth, 2026-08-14, and this is the whole specification: "exactly the same thing that our files drop
 * down box already does for texts that are on Google Drive, except that the user can submit their
 * own flextext and matching audio file … a backup way to do it with files they just happen to have
 * lying around that match. That's the goal of this utility, period."
 *
 * So the rows, the wants, the naming and the degradations are the Files ▾ menu's, and they are
 * shared rather than re-decided: js/seg-exports.js owns loosePlan() and buildLooseConversion(), and
 * the panel's copy of this widget calls exactly the same two functions. Only the DOM differs — the
 * editor's Utilities is static markup, the panel's is a built modal, and there is no shared UI layer
 * between them to put a widget in.
 *
 * ⚠ NO NEW MODULE AND NO NEW IMPORT EDGE. Everything here was already imported by this file; the
 * only change to the import block is three more names on the existing seg-exports line. That is
 * deliberate: a new top-level import in app.js is a new SHELL entry in the editor AND all three
 * satellite service workers, and getting that wrong is the v108 outage. */
function wireFileExporter() {
  const $$id = (id) => document.getElementById(id);
  const ftBtn = $$id('ex-pick-ft'), auBtn = $$id('ex-pick-audio');
  if (!ftBtn || !auBtn) return;              // markup absent (a satellite shell) — nothing to wire
  const ftIn = $$id('ex-ft'), auIn = $$id('ex-audio');
  const srcEl = $$id('ex-src'), warnEl = $$id('ex-warn'), rowsEl = $$id('ex-rows'), statusEl = $$id('ex-status');
  let st = { doc: null, ftBlob: null, ftName: '', audio: null, plan: null, base: 'text', busy: false };

  const say = (msg, kind) => {
    statusEl.hidden = !msg;
    statusEl.textContent = msg || '';
    statusEl.className = 'note rp-ex-msg' + (kind ? ' rp-as-' + kind : '');
  };
  /* Reason CODES come back from the shared planner; the sentences live here, because seg-exports has
   * no i18n by rule. One map, so a row's greyed-out explanation and a failed build say the same. */
  const why = (code) => ({
    noText: t('exp.no.text'), noAudio: t('exp.no.audio'), noAlign: t('panel.dl.noAlign'),
    badAlign: t('exp.no.badAlign'), tooBig: t('panel.dl.previewTooBig', { size: sizeFmt(st.plan?.caps?.est || 0) }),
  }[code] || '');

  function reset(keepFiles) {
    if (!keepFiles) st = { doc: null, ftBlob: null, ftName: '', audio: null, plan: null, base: 'text', busy: false };
    rowsEl.hidden = true; rowsEl.innerHTML = '';
    warnEl.hidden = true; say('');
  }

  ftBtn.addEventListener('click', () => ftIn.click());
  auBtn.addEventListener('click', () => auIn.click());

  ftIn.addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    reset(true);
    let xml = '';
    try { xml = await f.text(); } catch { say(t('exp.readFailed'), 'err'); return; }
    const parsed = parseFlextext(xml, { vernLang: settings.vernLang, analLang: settings.analLang });
    if (parsed.error || !parsed.texts.length) { say(t('task.ftParseFailed', { msg: parsed.error || t('task.ftNone') }), 'err'); return; }
    const doc = parsed.texts[0];
    /* ⚠ THE TIMES COME FROM THE FILE, and segmentsFromOffsets returns NULL (not []) when nothing
     * carries offsets — the same call the panel and the editor already make on import. */
    doc.segments = segmentsFromOffsets(doc) || [];
    st.doc = doc;
    st.ftBlob = f;                                  // byte-for-byte; never re-serialized
    st.ftName = f.name;
    st.base = sanitizeBase(doc.title || f.name.replace(/\.[^.]+$/, '')) || 'text';
    if (parsed.texts.length > 1) say(t('exp.multiText', { n: parsed.texts.length }), 'warn');
    render();
  });

  auIn.addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    st.audio = { blob: f, name: f.name, mimeType: f.type || 'application/octet-stream', size: f.size, durationMs: 0 };
    /* ⚠ DO THE TWO FILES BELONG TOGETHER? (Seth: "check to make sure the duration matches".) Free
     * for a WAV — readWavHeader gives frames/rate off a 64 KB slice, no decode. A lossy source
     * cannot be measured without decoding it, so it stays 0 and durationVerdict says 'unknown'
     * rather than guessing. */
    try {
      /* ⚠ An ArrayBuffer, NOT a Uint8Array — readWavHeader does `new DataView(buf)`, which throws
       * on a typed array, and the catch below would have swallowed it into a silent durationMs of
       * 0. That reads as "undecodable", so the pair check would have been permanently OFF while
       * looking implemented. Caught by test/browser/loose-exporter.playwright.mjs.
       *
       * 64 KB is enough for the whole answer: the data chunk's DECLARED size is in its header, so
       * frames/rate come out right without reading a 200 MB file. */
      const h = readWavHeader(await f.slice(0, 65536).arrayBuffer());
      if (h && h.sampleRate && h.frames) st.audio.durationMs = Math.round((h.frames / h.sampleRate) * 1000);
    } catch { /* not a WAV, or unreadable — 'unknown' is the honest answer */ }
    render();
  });

  function render() {
    if (!st.doc) { srcEl.textContent = ''; reset(true); return; }
    const a = st.audio;
    const isWav = !!a && (/\.wav$/i.test(a.name) || /wav$/i.test(a.mimeType || ''));
    st.plan = loosePlan({ doc: st.doc, hasAudio: !!a, audioBytes: a ? a.size : 0, isWav });
    srcEl.textContent = t('exp.src', {
      ft: st.ftName, lines: st.plan.rows, aligned: st.plan.alignedRows,
      audio: a ? `${a.name} (${sizeFmt(a.size)})` : t('exp.noAudioYet'),
    });
    /* TWO pair-level complaints share this one line, and audioUnaligned WINS. They are NOT mutually
     * exclusive — an earlier version claimed so and an adversarial review executed the
     * counterexample: a badAlign text (overlapping offsets) has aligned rows, so spanEnd > 0 and
     * the duration verdict can read 'short' at the same time. But that spanEnd was computed from
     * the very offsets that are unusable, so the mismatch message would be built on garbage and
     * would displace the one sentence that explains the state. Neither blocks — the user may know
     * something we do not. */
    const verdict = a ? durationVerdict({ spanEndMs: st.plan.spanEnd, durationMs: a.durationMs }) : 'unknown';
    warnEl.hidden = !(verdict === 'short' || st.plan.audioUnaligned);
    if (st.plan.audioUnaligned) {
      // Seth, 2026-08-16: a recording was supplied that nothing here can use — say so loudly.
      warnEl.textContent = t('exp.noAlignAudio');
      warnEl.className = 'note rp-ex-msg rp-as-warn';
    } else if (verdict === 'short') {
      warnEl.textContent = t('exp.mismatch', { text: fmtClockMs(st.plan.spanEnd), audio: fmtClockMs(a.durationMs) });
      warnEl.className = 'note rp-ex-msg rp-as-warn';
    }
    rowsEl.hidden = false;
    rowsEl.innerHTML = '';
    for (const kind of ['elan', 'saymore', 'preview', 'fxpa', 'flextext']) {
      const p = st.plan[kind];
      /* The preview row is honest about which flavor a click will build: the LISTENING page when
       * the recording embeds, the text-only INTERLINEAR page otherwise (Seth, 2026-08-16).
       * ⚠ p.ok GATES THE RENAME. A REFUSED row keeps the listening-page name, because the refused
       * flavor IS the listening page — tooBig refuses embedding, and an "Interlinear page" labelled
       * too-large-for-audio would contradict itself (the text flavor has no audio to be too big).
       * Caught by adversarial review; the same fix lives in researcher-panel.js. */
      const rowKey = kind === 'preview' && p.ok && !st.plan.previewEmbed ? 'previewText' : kind;
      const row = document.createElement('div');
      row.className = 'rp-dl-item' + (p.ok ? '' : ' rp-dl-pending');
      const sub = p.ok ? t('exp.sub.' + rowKey) : why(p.reason);
      row.innerHTML = '<span class="rp-dl-name"></span><span class="rp-dl-sub"></span>';
      row.querySelector('.rp-dl-name').textContent = t('exp.row.' + rowKey);
      row.querySelector('.rp-dl-sub').textContent = sub;
      if (p.ok) {
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        const go = () => build(kind);
        row.addEventListener('click', go);
        row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
      } else row.setAttribute('aria-disabled', 'true');
      rowsEl.appendChild(row);
    }
  }

  async function build(kind) {
    if (st.busy) { say(t('panel.dl.oneAtATime'), 'warn'); return; }
    st.busy = true;
    say(t('panel.dl.working'));
    try {
      const r = await buildLooseConversion({
        kind, doc: st.doc, base: st.base, title: st.doc.title || st.base,
        producedBy: producedBy(),
        flextextBlob: st.ftBlob, audio: st.audio, plan: st.plan,
        vern: st.doc.vernLang || settings.vernLang || 'und',
        anal: st.doc.analLang || settings.analLang || 'en',
        // The impure step seg-exports refuses to own — see its header.
        convertWav: async (blob) => (await convertAudio(await blob.arrayBuffer(), { format: 'wav', wavBits: 16 })).blob,
        onPhase: (ph) => say(t('exp.phase.' + ph)),
      });
      if (!r.entries.length) { say(t('panel.dl.zipFailed'), 'err'); return; }
      const out = r.zip ? await makeZip(r.entries) : r.entries[0].data;
      // The same save idiom the WS checker beside this uses — a synthetic <a download>, revoked late.
      const a = document.createElement('a');
      a.href = URL.createObjectURL(out);
      a.download = r.saveName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      const notes = (r.notes || []).map((n) => ({
        lossyTiming: t('panel.dl.lossyTiming'), fxpaNoAudio: t('panel.dl.fxpaNoAudioSub'),
        eafNoMedia: t('exp.eafNoMedia'), previewNoAudio: t('exp.noAlignAudio'),
      }[n])).filter(Boolean);
      say(t('exp.done', { name: r.saveName }) + (notes.length ? ' ' + notes.join(' ') : ''), 'ok');
    } catch (err) {
      console.warn('[flextext] loose-file conversion failed:', err);
      say(err && err.code === 'ZIP_TOO_LARGE' ? t('panel.dl.zipTooLarge') : t('panel.dl.zipFailed'), 'err');
    } finally { st.busy = false; }
  }
}

// mm:ss for a duration, for the pair-mismatch warning only.
function fmtClockMs(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function wireAudioConverter() {
  if (!$('#uc-file')) return;                    // satellite shells have no Utilities tab
  let srcBuf = null, srcInfo = null, srcName = '', srcSize = 0;
  let srcWs = null, outWs = null, srcUrl = null, outUrl = null;
  const status = $('#uc-status'), form = $('#uc-form'), fmtSel = $('#uc-fmt'),
        monoRow = $('#uc-mono-row'), mp3opts = $('#uc-mp3opts');
  // Players hold a decoded buffer and an object URL each; drop both before making new ones, or a
  // few conversions in a row leave the tab holding every file it has opened.
  const destroyPlayers = () => {
    for (const w of [srcWs, outWs]) { try { w && w.destroy(); } catch { /* noop */ } }
    for (const u of [srcUrl, outUrl]) { try { u && URL.revokeObjectURL(u); } catch { /* noop */ } }
    srcWs = outWs = srcUrl = outUrl = null;
  };
  const syncMp3Vis = () => {
    const o = (srcInfo && srcInfo.outs.find((x) => x.value === fmtSel.value)) || {};
    mp3opts.hidden = o.format !== 'mp3';         // bitrate/rate mean nothing for WAV or FLAC
  };
  const setStereoUi = (stereo) => { monoRow.hidden = !stereo; $('#uc-chan-hint').hidden = !stereo; };

  $('#uc-pick').addEventListener('click', () => $('#uc-file').click());
  $('#uc-help').addEventListener('click', () => { const m = $('#recformat-help-modal'); if (m) m.hidden = false; });
  fmtSel.addEventListener('change', syncMp3Vis);

  $('#uc-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    destroyPlayers();
    $('#uc-out-wrap').hidden = true; status.hidden = true;
    srcName = file.name; srcSize = file.size;
    try { srcBuf = await file.arrayBuffer(); }
    catch (err) { status.hidden = false; status.textContent = t('convert.failed', { msg: err.message }); return; }
    const fmt = detectFormat(srcBuf);
    let bits = null, chans = null, rate = null;
    if (fmt === 'wav') { const h = readWavHeader(srcBuf); if (h) { bits = h.bitsPerSample; chans = h.channels; rate = h.sampleRate; } }
    const outs = validOutputs(fmt, bits);
    srcInfo = { fmt, bits, chans, outs };
    // What we cheaply know about the source. textContent, not innerHTML — a file name is untrusted.
    const parts = [fmt ? fmt.toUpperCase() : t('convert.fmtUnknown')];
    if (bits) parts.push(t('convert.bit', { n: bits }));
    if (chans) parts.push(chans >= 2 ? t('convert.stereo') : t('convert.monoSrc'));
    if (rate) parts.push(rate + ' Hz');
    parts.push(sizeFmt(srcSize));
    $('#uc-src').textContent = t('convert.src', { name: srcName, detail: parts.join(' · ') });
    fmtSel.innerHTML = outs.map((o) => `<option value="${esc(o.value)}">${esc(ucFmtLabel(o.value))}</option>`).join('');
    setStereoUi(chans == null || chans >= 2);    // assume stereo until the decoded count says otherwise
    $('#uc-before-cap').hidden = false;
    form.hidden = false; syncMp3Vis();
    srcUrl = URL.createObjectURL(file);
    srcWs = ucMakePlayer($('#uc-src-player'), srcUrl, true);
    // The DECODED channel count is the authority — it covers sources we cannot header-sniff.
    srcWs.on('ready', () => {
      let nch = chans || 1;
      try { const d = srcWs.getDecodedData(); if (d) nch = d.numberOfChannels; } catch { /* noop */ }
      setStereoUi(nch >= 2);
    });
  });

  $('#uc-go').addEventListener('click', async () => {
    if (!srcBuf || !srcInfo) return;
    const o = srcInfo.outs.find((x) => x.value === fmtSel.value); if (!o) return;
    const opts = { format: o.format, mono: monoRow.hidden ? 'keep' : $('#uc-mono').value };
    if (o.format === 'wav') opts.wavBits = o.wavBits;
    if (o.format === 'flac') opts.flacBits = o.flacBits;
    if (o.format === 'mp3') { opts.kbps = parseInt($('#uc-kbps').value, 10); opts.sampleRate = parseInt($('#uc-rate').value, 10); }
    status.hidden = false; status.textContent = t('convert.working', { pct: 0 });
    try {
      const res = await convertAudio(srcBuf, opts, (f) => { status.textContent = t('convert.working', { pct: Math.round(f * 100) }); });
      /* ⚠ NAME IT AS DERIVED. Without this a 32-bit master converted to 24-bit downloads under the
       * SAME filename — same extension, same folder, indistinguishable from the original it was
       * made from. The bext chunk inside survives a rename; the name is what someone reads first.
       * Both, deliberately: neither alone is enough. */
      const outName = srcName.replace(/\.[^.]+$/, '') + (res.derived ? '-converted' : '') + '.' + res.ext;
      const dlUrl = URL.createObjectURL(res.blob);
      const a = document.createElement('a'); a.href = dlUrl; a.download = outName; a.click();
      setTimeout(() => URL.revokeObjectURL(dlUrl), 30000);
      status.textContent = t('convert.done', { name: outName, out: sizeFmt(res.blob.size), in: sizeFmt(srcSize) });
      try { if (outWs) outWs.destroy(); } catch { /* noop */ }
      try { if (outUrl) URL.revokeObjectURL(outUrl); } catch { /* noop */ }
      outUrl = URL.createObjectURL(res.blob);
      $('#uc-out-wrap').hidden = false;
      outWs = ucMakePlayer($('#uc-out-player'), outUrl, false);
      window.__lastConvert = { size: res.blob.size, ext: res.ext };
    } catch (err) { status.textContent = t('convert.failed', { msg: err.message }); }
  });
}

function setupResearch() {
  // Lock down the coworker's interface in person: hide the Settings tab on THIS device. The confirm
  // spells out the touch-friendly recovery so nobody gets stranded on a phone with no keyboard.
  $('#btn-hide-research').addEventListener('click', async () => {
    if (!await confirmDialog(t('research.hideHereConfirm'))) return;
    localStorage.setItem(RESEARCH_HIDDEN_KEY, '1');
    applyResearchVisibility();
    toast(t('research.disabled'));
  });

  // Recording-format help modal (researcher-facing archival guidance), opened from the Recording
  // group's "which format should I choose?" link.
  const rfHelpModal = $('#recformat-help-modal');
  if (rfHelpModal) {
    $('#recformat-help-close')?.addEventListener('click', () => { rfHelpModal.hidden = true; });
    rfHelpModal.addEventListener('click', (e) => { if (e.target === rfHelpModal) rfHelpModal.hidden = true; });
  }

  wireAudioConverter();
  wireFileExporter();

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
  markSetupTabProblems();
  applyHelpResearchVisibility();
}

/* ⚠ THE OTHER HALF OF LOSING THE SAVE BUTTON. Painting the banner when the tab is OPEN is not
 * enough on its own: the old check could not be walked away from, because a broken setup simply
 * would not save. Nothing now stops someone leaving this device unable to work and never opening
 * Settings again — so the tab itself has to carry the fact, where it is seen without going to look.
 * A dot, not a number or a colour alone: it has to survive being small, and it must not read as an
 * error the user caused just now. Validation runs off STORED settings, not the form, so this is
 * correct at startup, before the form has ever been built. */
function markSetupTabProblems() {
  const tab = $('#topbar-home .top-tab[data-view="research"]');
  if (!tab) return;
  if (Sync.hasSession()) { tab.classList.remove('tab-warn'); return; }   // managed: not this device's call
  const problems = validateDeviceSetup(deviceSetupValues());
  tab.classList.toggle('tab-warn', problems.length > 0);
  if (problems.length) tab.title = t('setup.tabWarn', { n: problems.length });
  else tab.removeAttribute('title');
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
  /* ⚠ A managed install still does NOT get the local Settings tab — settings stay remote-managed.
   * It used to open the researcher panel here instead; that route now lives as a button in the
   * admin drawer (see applyAdminDrawer), because opening it from this function navigated away from
   * the very drawer the gesture exists to reveal. Nothing is lost: the drawer opens on the same
   * gesture and the panel is one tap further in. */
  if (Sync.hasSession()) return;
  if (isResearchHidden()) {
    localStorage.removeItem(RESEARCH_HIDDEN_KEY);
    toast(t('research.enabled'));
  } else {
    localStorage.setItem(RESEARCH_HIDDEN_KEY, '1');
    toast(t('research.disabled'));
  }
  applyResearchVisibility();
}

/* ---------------- THE ADMIN DRAWER — the back-door for a stuck device (Seth, 2026-08-20) --------
 * "We need a back-door for researchers to be able to unpair stuck editor clients without data loss
 * or clearing browser storage. Used to be clicking the help menu seven times exposed settings
 * normally hidden. I think now what we should do is have that enable or disable the pair/unpair and
 * erase all buttons at the bottom of the help menu, even if the researcher disabled them in the
 * researcher panel."
 *
 * ⚠ WHY A LOCAL BACK-DOOR AT ALL, when the researcher panel can already revoke a device: because
 * the panel's revoke travels over the NETWORK, and a device is usually "stuck" precisely when that
 * route does not work — offline, a binding the worker no longer recognises, a session that will not
 * settle. The panel can only fix a device that is still listening. This gesture works on a phone in
 * a village with no signal, held in the researcher's hand.
 *
 * ⚠ AND IT OVERRIDES THE RESEARCHER'S OWN SETTING, deliberately. deleteAllEnabled is off by default
 * for managed devices so a coworker cannot wipe their work by accident — a good default that
 * becomes a trap the moment the device needs recovering and the person holding it is the researcher.
 * The gesture is the distinction: seven deliberate taps is not something a wet screen or a barely
 * literate user does by accident, which was the reason the gesture targets the small ? button
 * rather than the title bar in the first place.
 *
 * ⚠ UNPAIRING IS NOT ERASING. Unpair drops the BINDING and the researcher's Drive links and keeps
 * every text, recording and setting — that is the whole point of "without data loss or clearing
 * browser storage". Delete-All is the other button and it is the destructive one. They sit together
 * because they are found together, not because they are alike; the drawer says which is which. */
const ADMIN_UNLOCK_KEY = 'flextext-admin-unlock';
function adminUnlocked() { return !!localStorage.getItem(ADMIN_UNLOCK_KEY); }

function toggleAdminUnlock() {
  const on = !adminUnlocked();
  if (on) localStorage.setItem(ADMIN_UNLOCK_KEY, '1');
  else localStorage.removeItem(ADMIN_UNLOCK_KEY);
  applyDeleteAllButton();      // its gate now answers differently
  applyAdminDrawer();
  /* ⚠ SHOW THE DRAWER, do not just announce it. The buttons live at the bottom of Help, so a
   * researcher who fires the gesture from the texts list would otherwise be told something had
   * happened somewhere they cannot see. Only on unlock — locking from inside Help should leave you
   * where you are. */
  if (on && currentView() !== 'help') openHelp();
  toast(t(on ? 'admin.unlocked' : 'admin.locked'), 6000);
}

/* Unpair THIS device, locally and completely, without touching a single text.
 *
 * ⚠ LOCAL ONLY, and that is not a shortcut. There is no client→server "release" call — the worker
 * learns a device is gone when the researcher revokes it in the panel, which is a separate and still
 * necessary step. What this fixes is the DEVICE: a binding it cannot use is dropped so the app
 * becomes standalone again and the coworker can keep working. Saying otherwise in the UI would be a
 * lie about what the button did. */
async function runAdminUnpair() {
  if (!Sync.hasSession()) { toast(t('admin.unpairNone'), 6000); return; }
  if (!await confirmDialog(t('admin.unpairConfirm'))) return;
  Sync.clearSession();
  /* The same scrub a researcher-initiated revoke does — a Drive folder this device may no longer
   * reach must not be left behind claiming to be live. See onSyncRevoked for why consentAudioFile
   * goes with them. */
  const st = loadSettings();
  for (const k of ['uploadFolder', 'uploadUrl', 'consentAudio', 'consentAudioUrl', 'consentAudioFile']) delete st[k];
  saveSettings(st);
  settings = loadSettings();
  applyLiveSettings();
  applyAdminDrawer();
  toast(t('admin.unpairDone'), 10000);
}

/* The drawer itself: built once, then shown/hidden. It is APPENDED to the Help view, the same way
 * the Delete-All and invite buttons already are, so there is one convention for "admin territory
 * lives at the bottom of Help" rather than two. */
function applyAdminDrawer() {
  const view = $('#view-help'); if (!view) return;
  let box = $('#admin-drawer');
  if (!adminUnlocked()) { if (box) box.hidden = true; return; }
  if (!box) {
    box = document.createElement('div');
    box.id = 'admin-drawer';
    box.className = 'admin-drawer';
    box.innerHTML = '<h3></h3><p class="note"></p>'
      + '<button type="button" id="btn-admin-unpair" class="secondary-btn"></button>'
      + '<button type="button" id="btn-admin-panel" class="secondary-btn"></button>';
    box.querySelector('#btn-admin-unpair').addEventListener('click', runAdminUnpair);
    /* ⚠ THE PANEL ROUTE MOVED HERE RATHER THAN DISAPPEARING. The gesture used to open the researcher
     * panel outright on a managed install — the only way in on a coworker's phone, since the
     * Researcher button is hidden unless an account is signed up on the device. Opening it outright
     * is now wrong (it navigates away from the drawer this gesture exists to reveal), so it is a
     * button in the drawer: same route, one more tap, and visible instead of secret. */
    box.querySelector('#btn-admin-panel').addEventListener('click', () => {
      if (researcherPanelApi) researcherPanelApi.open();
    });
    view.appendChild(box);
  }
  box.querySelector('h3').textContent = t('admin.title');
  box.querySelector('p').textContent = t('admin.note');
  const unpair = box.querySelector('#btn-admin-unpair');
  unpair.textContent = t('admin.unpair');
  unpair.disabled = !Sync.hasSession();
  box.querySelector('#btn-admin-panel').textContent = t('admin.panel');
  box.hidden = false;
  /* ⚠ LAST, so the drawer is the bottom of the view even though Delete-All was appended earlier.
   * Delete-All is the destructive one and belongs BELOW the recoverable controls, not above them. */
  const del = $('#btn-delete-all');
  if (del && del.parentNode === view) view.appendChild(del);
}

function setupResearchToggle() {
  /* ⚠ ONE GESTURE, TWO JOBS, in this order. It still does what it always did — the Settings tab on a
   * standalone device — and it now also toggles the admin drawer, which is the half that works when
   * a device is stuck. Both, rather than a replacement, because the old behaviour is documented in
   * the field and someone reaching for it should still find it. */
  const fire = () => { toggleResearchHidden(); toggleAdminUnlock(); };
  // Desktop: Ctrl+Alt+R.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      fire();
    }
  });
  // Touch devices have no keyboard: tap the small ? (Help) button 7× in quick
  // succession. Targeting the Help button — not the whole title bar — avoids accidental
  // triggers from stray taps (barely literate users, wet screens), while staying
  // recoverable without Ctrl+Alt+R.
  let taps = 0, last = 0;
  $$('.help-btn').forEach((el) => {
    el.addEventListener('click', () => {
      const now = Date.now();
      taps = now - last < 1500 ? taps + 1 : 1;
      last = now;
      if (taps >= 7) { taps = 0; fire(); }
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
  $('#btn-record-big').addEventListener('click', startConsentThenRecord);
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
  const upDel = new Set(pendingUpDel());   // deletes triggered but not yet confirmed
  for (const d of docs) {
    const li = document.createElement('li');
    li.className = 'rec-item';
    if (upDel.has(d.id)) li.classList.add('doc-pending-del');   // strikethrough + faded until removal lands
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
    send.addEventListener('click', async () => {
      const rec = await db.getDoc(d.id);
      if (!rec) { toast(t('toast.cantOpen')); return; }
      current = rec;
      openShareMenu();
    });
    if (allowDeleteOn()) {
      del.title = t('texts.deleteTitle');
      del.innerHTML = '&#128465;';
      del.addEventListener('click', () => { userDeleteDoc(d.id, d.title); });
    } else del.remove();   // researcher disabled deleting
    ul.appendChild(li);
  }
}

/* ─────────────────── CONSENT COLLECTOR (__MODE = 'consent') ───────────────────
 * Adds speaker permission to texts that ALREADY EXIST.
 *
 * The engine can only attach consent at doc creation: newDocFromAudio consumes pendingAssent /
 * pendingReceipt / pendingPromptAudio and nothing else ever writes those fields. That is fine for
 * a text being recorded now and useless for a back catalogue — which cannot be re-recorded either,
 * because the speakers have moved on or died. Archives require consent, so those texts are stuck.
 *
 * THE RECORD PRODUCED HERE IS NOT SECOND-CLASS. It runs the same requestConsentThen flow, builds
 * the same receipt through buildConsentReceipt, stores the same three fields under the same media
 * keys, and therefore exports and uploads through the existing Lane A path with no special case
 * anywhere downstream. A retrofitted text and a natively recorded one are indistinguishable, which
 * is the whole requirement: an archive cannot be asked to trust two grades of consent.
 *
 * GROUP CONSENT is the reason this is an app and not a button. Permission is given by a PERSON
 * about THEIR body of work: a speaker sits down once and says yes to the fourteen stories they
 * told you over three years. Walking them through fourteen identical dialogues is not more
 * rigorous, it is worse, because it invites fatigue-clicking, which is exactly what consent must
 * not be. So: group by speaker, select, ask once, copy the result to each text.
 */

// Docs carry no speaker field: the engine never needed one. The collector adds `consentSpeaker`,
// because grouping is the point and there is nothing else to group on. Seeded from an existing
// receipt's typed signature where there is one, so a text that already has consent lands in the
// right group without being touched.
const ccSpeakerOf = (d) => (d.consentSpeaker
  || (d.consentReceipt && d.consentReceipt.signatureName)
  || '').trim();

// Three states, because "has a receipt" is not the same as "has everything it needs". A text whose
// receipt says a recorded assent was collected but whose clip never reached this device is
// INCOMPLETE, and saying so is the difference between a usable archive record and a surprise at
// deposit time.
function ccStateOf(d) {
  const r = d.consentReceipt;
  if (!r) return 'none';
  const wantsClip = Array.isArray(r.responseTypes) && r.responseTypes.includes('recorded');
  if (wantsClip && !d.consentClip) return 'partial';
  return 'full';
}

let ccSelected = new Set();

/* Write consent onto texts that already exist: the one capability the engine lacks.
 *
 * EACH TEXT GETS ITS OWN COPY of the receipt. captureConsentContext mutates the receipt object in
 * place to fill in IP and location; a single shared object would make one text's lookup appear on
 * every text in the group, and any later edit to one would silently rewrite all of them.
 */
async function ccAttachConsent(ids, { assent, receipt, promptAudio }) {
  const attached = [];
  for (const id of ids) {
    const rec = await db.getDoc(id);
    if (!rec) continue;
    if (receipt) {
      rec.consentReceipt = structuredClone(receipt);
      rec.consentReceipt.collectedBy = 'Flextext Consent Collector';
      // Recorded because it is a material fact about how permission was given: an auditor reading
      // one of these should be able to see it was a single conversation covering N texts, not N
      // separate askings.
      if (ids.length > 1) {
        rec.consentReceipt.groupConsent = { size: ids.length, textIds: ids.slice() };
      }
    }
    if (assent) {
      rec.consentClip = assent.name;
      await db.putMedia('consent:' + id, assent).catch(() => {});
    }
    if (promptAudio) {
      rec.consentPromptClip = promptAudio.name;
      await db.putMedia('consent-prompt:' + id, promptAudio).catch(() => {});
    }
    rec.modified = Date.now();
    await db.putDoc(rec);
    attached.push(id);
  }
  db.broadcastLive('docs');
  return attached;
}

// Run the shared consent flow, then fan the result out over the selection.
async function ccCollectFor(ids) {
  if (!ids.length) return;
  await requestConsentThen(async () => {
    // Consent is configured OFF: requestConsentThen calls back with no receipt built. Retrofitting
    // nothing onto a text would be worse than refusing, so say why.
    if (!pendingReceipt) { toast(t('cc.consentOff')); return; }
    /* Let the IP/location fill finish BEFORE the receipt is copied. It mutates the object in
     * place, so copying first would freeze N receipts at "unavailable" while the original filled
     * in, and the group would carry weaker records than a single text would. The 5s cap is the
     * same bound buildBundleFor uses: a slow lookup must not hold a speaker at the table. */
    if (consentCapture && consentCapture.promise) {
      await Promise.race([consentCapture.promise, new Promise((r) => setTimeout(r, 5000))]);
    }
    const payload = { assent: pendingAssent, receipt: pendingReceipt, promptAudio: pendingPromptAudio };
    const done = await ccAttachConsent(ids, payload);
    pendingAssent = null; pendingReceipt = null; pendingPromptAudio = null;
    ccSelected.clear();
    toast(done.length === 1 ? t('cc.savedOne') : t('cc.savedMany').replace('{n}', done.length));
    renderConsentView();
  });
}

function renderConsentView() {
  const view = $('#view-consent');
  if (!view) return;
  view.innerHTML = `
    <p class="tab-hint" data-i18n-html="cc.hint"></p>
    <div id="cc-actions" class="cc-actions" hidden>
      <span id="cc-count" class="cc-count"></span>
      <button id="cc-collect" class="primary-btn"></button>
      <button id="cc-clear" class="link-btn"></button>
    </div>
    <div id="cc-groups"></div>
    <p id="cc-empty" class="empty-note" data-i18n-html="cc.empty" hidden></p>`;
  applyI18n(view);
  satImportBar(view);
  ccRenderList();
}

async function ccRenderList() {
  const box = $('#cc-groups');
  if (!box) return;
  const docs = await db.listDocs();
  const empty = $('#cc-empty');
  if (empty) empty.hidden = docs.length > 0;

  // Group by speaker, unassigned last: it is a to-do pile, not a speaker.
  const groups = new Map();
  for (const d of docs) {
    const k = ccSpeakerOf(d) || ' ';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  const keys = [...groups.keys()].sort((a, b) =>
    (a === ' ' ? 1 : b === ' ' ? -1 : a.localeCompare(b)));

  box.innerHTML = '';
  for (const k of keys) {
    const items = groups.get(k);
    const named = k !== ' ';
    const missing = items.filter((d) => ccStateOf(d) !== 'full');
    const sec = document.createElement('section');
    sec.className = 'cc-group';
    sec.innerHTML = `
      <header class="cc-group-head">
        <label class="cc-pick"><input type="checkbox" class="cc-group-all"></label>
        <span class="cc-speaker"></span>
        <span class="cc-tally"></span>
      </header>
      <ul class="cc-list"></ul>`;
    const spk = sec.querySelector('.cc-speaker');
    spk.textContent = named ? k : t('cc.unassigned');
    if (!named) spk.classList.add('muted');
    sec.querySelector('.cc-tally').textContent = missing.length
      ? t('cc.tallyNeed').replace('{n}', missing.length).replace('{total}', items.length)
      : t('cc.tallyDone').replace('{total}', items.length);

    const ul = sec.querySelector('.cc-list');
    for (const d of items) {
      const st = ccStateOf(d);
      const li = document.createElement('li');
      li.className = 'cc-item cc-' + st;
      li.innerHTML = `
        <label class="cc-pick"><input type="checkbox" class="cc-one"></label>
        <span class="cc-title"></span>
        <span class="cc-state"></span>
        <input class="cc-speaker-in" size="14">`;
      li.querySelector('.cc-title').textContent = d.title || t('untitled');
      satRowControls(li, d);
      li.querySelector('.cc-state').textContent =
        st === 'full' ? t('cc.stateFull') : st === 'partial' ? t('cc.statePartial') : t('cc.stateNone');
      const cb = li.querySelector('.cc-one');
      cb.checked = ccSelected.has(d.id);
      cb.onchange = () => {
        if (cb.checked) ccSelected.add(d.id); else ccSelected.delete(d.id);
        ccSyncActions();
      };
      const sp = li.querySelector('.cc-speaker-in');
      sp.value = ccSpeakerOf(d);
      sp.placeholder = t('cc.speakerPh');
      // Saved on change, not per keystroke: this rewrites the doc record.
      sp.onchange = async () => {
        const rec = await db.getDoc(d.id);
        if (!rec) return;
        rec.consentSpeaker = sp.value.trim();
        rec.modified = Date.now();
        await db.putDoc(rec);
        db.broadcastLive('docs');
        ccRenderList();
      };
      ul.appendChild(li);
    }

    const all = sec.querySelector('.cc-group-all');
    all.checked = items.length > 0 && items.every((d) => ccSelected.has(d.id));
    all.onchange = () => {
      for (const d of items) {
        if (all.checked) ccSelected.add(d.id); else ccSelected.delete(d.id);
      }
      ccRenderList();
    };
    box.appendChild(sec);
  }
  ccSyncActions();
}

function ccSyncActions() {
  const bar = $('#cc-actions');
  if (!bar) return;
  const n = ccSelected.size;
  bar.hidden = n === 0;
  const count = $('#cc-count');
  if (count) count.textContent = n === 1 ? t('cc.selOne') : t('cc.selMany').replace('{n}', n);
  const go = $('#cc-collect');
  if (go) { go.textContent = t('cc.collect'); go.onclick = () => ccCollectFor([...ccSelected]); }
  const clr = $('#cc-clear');
  if (clr) { clr.textContent = t('cc.clearSel'); clr.onclick = () => { ccSelected.clear(); ccRenderList(); }; }
}

function setupConsentMode() {
  renderConsentView();
  show('consent');
}

/* ─────────────────── BRINGING TEXTS INTO A SATELLITE ───────────────────
 * Shared by the Consent Collector and the Audio Segmenter, because without it neither app can be
 * used at all by anyone who is not already paired to a researcher.
 *
 * ⚠ EACH SATELLITE IS ITS OWN ORIGIN, AND THAT IS EASY TO FORGET WHILE DEVELOPING. On localhost
 * every app is served from one port, so they share one IndexedDB and the recorder's texts simply
 * appear here. In production consent.flextext.app and audio-segmenter.flextext.app are separate
 * origins from the editor and the recorder, so they share NOTHING — a text recorded this morning is
 * invisible to the collector this afternoon. The only cross-origin path the engine has is the
 * researcher assignment channel, and that needs a pair code. So a colleague who installs either app
 * and has not been paired sees an empty list with no way to fill it, for ever.
 *
 * Seth's brief for the collector said it plainly: "support moving texts from other devices". This is
 * that. It is deliberately the SAME importer for both apps, differing only in its label, because
 * the two apps want the same thing — a .flextext you already have, and for the segmenter the
 * recording that goes with it.
 *
 * ⚠ NOT importFile(). That one ends by calling openDoc(), which enters the editor these apps do not
 * have, and renderDocList(), which needs a library view they do not have either. Reusing it would
 * mean giving the satellites a half-editor to be dropped into.
 */
const SAT_ACCEPT = '.flextext,.xml,.txt,text/plain,text/xml,application/xml,'
  + 'audio/*,.mp3,.wav,.m4a,.flac,.ogg';

const satIsText = (f) => /\.(flextext|xml|txt)$/i.test(f.name) || /(xml|text)/i.test(f.type || '');
const satBase = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();

/* Pair a recording with its text: BY FILENAME when the names agree, OTHERWISE IN THE ORDER PICKED.
 *
 * ⚠ A MATCHING NAME IS A CONVENIENCE, NOT A REQUIREMENT (Seth): "I don't want you to require the
 * input audio to have the same name as the flextext file … we can trust the user to be intelligent
 * enough to notice it's not matching." Requiring it meant a linguist whose recorder writes
 * REC0042.wav beside StoryOfTheFlood.flextext — which is what recorders actually do — got the text
 * with no audio and a scolding, for picking exactly the two files they meant.
 *
 * So names are tried first (they make a folder of many pairs land correctly in one pick), and
 * whatever is left over is paired in the order it was chosen.
 *
 * ⚠ THE ONE REFUSAL THAT STAYS is a .flextext holding SEVERAL texts: there is genuinely no way to
 * know which of them a recording belongs to. That is not a naming question and no amount of user
 * intelligence resolves it from the files alone — and a recording stapled to the wrong story is a
 * mistake nobody can see afterwards. */
async function satImportFiles(files) {
  const list = [...files];
  const textFiles = list.filter(satIsText);
  const audioFiles = list.filter((f) => !satIsText(f));
  /* ⚠ THE SEGMENTER NEEDS TEXT; THE CONSENT COLLECTOR DOES NOT (Seth, 2026-09-03: "Consent
   * collector shouldn't be flextext ONLY that it imports. It can import either or both flextext
   * and audio"). Permission attaches to a recording as readily as to a transcript — a story that
   * has only been recorded still needs its speaker's yes. So here a recording with no text becomes
   * a text of its own: the audio, a title from the filename, and no words yet — the same record the
   * editor's "New text from audio" makes. The segmenter keeps the refusal: it has nothing to match
   * a recording against. */
  const audioAlone = CONSENT_MODE;
  if (!textFiles.length && !audioAlone) { toast(t('sat.needText'), 7000); return; }

  // Parse everything BEFORE pairing anything: how many texts a file holds decides whether it may
  // take a recording at all, and that is not knowable from its name.
  const parsed = [];
  const failed = [];
  for (const f of textFiles) {
    let out;
    try { out = parseFlextext(await f.text(), { vernLang: settings.vernLang, analLang: settings.analLang }); }
    catch (err) { failed.push(f.name + ' — ' + err.message); continue; }
    if (out.error) { failed.push(f.name + ' — ' + out.error); continue; }
    const texts = out.texts || [];
    if (!texts.length) { failed.push(f.name + ' — ' + t('sat.noTexts')); continue; }
    parsed.push({ file: f, texts, mate: null });
  }

  /* ⚠ TWO PASSES, AND THE ORDER MATTERS. Claiming namesakes first is what stops an earlier text
   * with no matching name from swallowing a later text's own recording: given
   * [A.flextext, B.flextext, B.wav], a single greedy pass hands B.wav to A and leaves B silent —
   * the two files whose names DO agree ending up apart, which is the one outcome naming was
   * supposed to prevent. */
  const claimed = new Set();
  const single = (e) => e.texts.length === 1;      // several texts in a file ⇒ no recording, see below
  for (const e of parsed) {
    if (!single(e)) continue;
    const named = audioFiles.find((a) => satBase(a.name) === satBase(e.file.name) && !claimed.has(a));
    if (named) { e.mate = named; claimed.add(named); }
  }
  const spare = audioFiles.filter((a) => !claimed.has(a));
  for (const e of parsed) {
    if (e.mate || !single(e) || !spare.length) continue;
    e.mate = spare.shift();
    claimed.add(e.mate);
  }
  // A recording offered to a file holding several texts is reported, not silently dropped.
  const ambiguous = parsed.some((e) => !single(e)
    && audioFiles.some((a) => satBase(a.name) === satBase(e.file.name)));

  let added = 0, paired = 0;
  for (const e of parsed) {
    for (const doc of e.texts) {
      normalizePhraseLines(doc);      // canonical shape on entry — see normalizePhraseLines
      const rec = {
        id: newGuid(),
        title: doc.title || e.file.name.replace(/\.(flextext|xml|txt)$/i, ''),
        created: Date.now(), modified: Date.now(), doc,
      };
      Object.assign(rec, docStats(doc));
      if (e.mate) {
        await db.putMedia(rec.id, {
          blob: e.mate, name: e.mate.name, mimeType: e.mate.type || 'audio/mpeg',
          sourceUrl: '', peaks: null, duration: null,
        });
        rec.audioSource = 'local:' + e.mate.name;
        rec.audioLocked = false;          // the user brought it themselves; they may remove it
        ensureMediaRef(rec, e.mate.name, '');   // so an export still references the recording
        paired++;
      }
      await db.putDoc(rec);
      added++;
    }
  }

  // A recording nothing claimed becomes its own text — see audioAlone above.
  let recordings = 0;
  if (audioAlone) {
    for (const a of audioFiles) {
      if (claimed.has(a)) continue;
      const doc = makeDoc(settings, a.name.replace(/\.[^.]+$/, ''));
      const rec = { id: newGuid(), title: doc.title, created: Date.now(), modified: Date.now(), doc };
      Object.assign(rec, docStats(doc));
      await db.putMedia(rec.id, {
        blob: a, name: a.name, mimeType: a.type || 'audio/mpeg',
        sourceUrl: '', peaks: null, duration: null,
      });
      rec.audioSource = 'local:' + a.name;
      rec.audioLocked = false;
      ensureMediaRef(rec, a.name, '');
      await db.putDoc(rec);
      claimed.add(a);
      recordings++;
    }
  }

  db.broadcastLive('docs');
  refreshList();

  // Say exactly what happened, including what did NOT: a recording silently dropped is the kind of
  // thing a user only discovers weeks later, on the tab that needed it.
  if (added) {
    const key = added === 1
      ? (paired ? 'sat.importedOneAudio' : 'sat.importedOne')
      : (paired ? 'sat.importedManyAudio' : 'sat.importedMany');
    toast(t(key, { n: added, paired }), 6000);
  }
  if (recordings) toast(t(recordings === 1 ? 'sat.importedOneRecording' : 'sat.importedManyRecordings', { n: recordings }), 6000);
  const orphans = audioFiles.filter((a) => !claimed.has(a));
  // Where a recording stands on its own anyway, "left off" is not what happened to it.
  if (ambiguous && !audioAlone) toast(t('sat.audioAmbiguous'), 8000);
  else if (orphans.length) toast(t('sat.audioUnmatched', { names: orphans.map((f) => f.name).join(', ') }), 8000);
  for (const why of failed) toast(t('toast.importFailed', { msg: why }), 8000);
}


/* One file picker, as a promise. Built and thrown away per use so a stale <input> can never hand
 * back last time's file. A cancelled picker fires 'cancel' in current browsers; where it does not,
 * the element is simply removed and the promise never settles — the caller only awaits to decide
 * whether to act, so nothing is stranded that matters. */
function pickOneFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.hidden = true;
    document.body.appendChild(input);
    const done = (f) => { input.remove(); resolve(f || null); };
    input.addEventListener('change', () => done(input.files && input.files[0]), { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });
    input.click();
  });
}

/* SWAP A TEXT'S RECORDING FOR A DIFFERENT FILE (researcher setting allowAudioSwap, default on when
 * this device has no researcher session). The reason it exists is the ordinary one: you attached
 * the wrong file, or a better copy of the right one turned up.
 *
 * ⚠ IT THROWS AWAY THE CUTS, AND IT HAS TO. Every span in doc.segments is a pair of times INTO THE
 * OLD RECORDING. Against a different file those numbers are not approximately right, they are
 * meaningless — line three would point at whatever happens to be at 0:47 of the new audio. Keeping
 * them would leave a text that looks aligned and is not, which is worse than an obviously unaligned
 * one because nobody re-checks a green tick. So it is said plainly first and only then done.
 *
 * ⚠ AND IT REFUSES ON AUDIO THE COWORKER DOES NOT OWN — isAudioLocked covers a recording that
 * arrived from a researcher's task link, which this device may use but must not replace. */
async function satReplaceAudio(id) {
  const rec = await db.getDoc(id);
  if (!rec) { toast(t('toast.cantOpen')); return; }
  if (isAudioLocked(rec)) { toast(t('sat.audioLocked'), 8000); return; }
  const spans = docSegments(rec.doc).filter((x) => x && !x.timePending).length;
  if (spans && !await confirmDialog(t('sat.replaceLosesCuts').replace('{n}', spans))) return;
  const f = await pickOneFile('audio/*,.mp3,.wav,.m4a,.flac,.ogg');
  if (!f) return;
  const fresh = await db.getDoc(id);          // the dialog and the picker are both async
  if (!fresh) { toast(t('toast.cantOpen')); return; }
  await db.putMedia(id, {
    blob: f, name: f.name, mimeType: f.type || 'audio/mpeg',
    sourceUrl: '', peaks: null, duration: null,
  });
  /* The derived WAV working copy is a conversion OF THE OLD FILE and would otherwise keep being
   * used in preference to the new one — segWorkingMedia looks it up by key, not by content. */
  await db.deleteMedia('segwav:' + id).catch(() => {});
  if (spans) fresh.doc.segments = [];
  fresh.audioSource = 'local:' + f.name;
  fresh.audioLocked = false;
  delete fresh.pendingAudio;
  delete fresh.audioError;
  ensureMediaRef(fresh, f.name, '');
  fresh.modified = Date.now();
  await db.putDoc(fresh);
  // The player may still be holding the old recording for this doc.
  if (player && player.loadedFor === id) { player.loadedFor = null; playerReadyFor = null; }
  db.broadcastLive('docs');
  refreshList();
  toast(t(spans ? 'sat.audioReplacedCuts' : 'sat.audioReplaced'), 6000);
}

/* The per-row controls both satellites share. Each is a researcher permission, and each defaults to
 * ON for a device with no researcher session — an unpaired device is somebody working alone, and
 * there is nobody to ask. */
function satRowControls(host, d) {
  /* ⚠ A WAY OUT FOR A DEVICE THAT IS NOT PAIRED. Seth hit this on the first real text
   * (2026-09-03): 149 cuts and nine joins in, "I'm ready to export, but it's not giving me the
   * option." Work left this origin only through the shared upload pump, which needs a researcher
   * pairing — an unpaired device had no download at all. This is the editor's own bundle
   * (buildBundleFor — the same entries a paired device uploads): the .flextext with its times,
   * the .eaf, and the recording, zipped. It exports what Done has COMMITTED; a draft in progress
   * is not in the doc, and the toast says so rather than letting a file that lacks it look done. */
  if (SEGMENTER_MODE || CONSENT_MODE) {
    const b = document.createElement('button');
    b.className = 'icon-btn2 sat-export';
    b.textContent = '⤓';                 // ⤓ — a glyph, words in the tooltip, per the suite's rule
    b.title = t('sat.export');
    b.setAttribute('aria-label', t('sat.export'));
    b.addEventListener('click', (e) => { e.stopPropagation(); satExport(d.id); });
    host.appendChild(b);
  }
  if (allowAudioSwapOn() && SEGMENTER_MODE) {
    const b = document.createElement('button');
    b.className = 'icon-btn2 sat-swap';
    b.textContent = '\u266B';                 // ♫ — a glyph, words in the tooltip, per the suite's rule
    b.title = t('sat.replaceAudio');
    b.setAttribute('aria-label', t('sat.replaceAudio'));
    b.addEventListener('click', (e) => { e.stopPropagation(); satReplaceAudio(d.id); });
    host.appendChild(b);
  }
  if (allowDeleteOn()) {
    const b = document.createElement('button');
    b.className = 'icon-btn2 sat-del';
    b.textContent = '\uD83D\uDDD1';           // 🗑
    b.title = t('texts.deleteTitle');
    b.setAttribute('aria-label', t('texts.deleteTitle'));
    // userDeleteDoc owns the whole rule — the confirm, the upload-first case, the queued-upload
    // cancel — and now repaints through refreshList(), so it works here unchanged.
    b.addEventListener('click', (e) => { e.stopPropagation(); userDeleteDoc(d.id, d.title); });
    host.appendChild(b);
  }
}

/* The one control, built in JS so neither shell needs its own copy of the markup (and so a shell
 * that has not been rebuilt cannot end up with a button wired to nothing). */
/* Which of the three files — Seth (2026-09-03): "we do want direct ELAN export from the audio
 * segmenter." The bundle is built once either way; the choice is what is KEPT of it. */
function satExportChoice() {
  return new Promise((resolve) => {
    if (document.querySelector('[data-confirm-dialog]')) { resolve(null); return; }
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.dataset.confirmDialog = '1';
    wrap.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true">
      <h3>${esc(t('sat.exportTitle'))}</h3>
      <button class="primary-btn" data-x="all">${esc(t('sat.exportAll'))}</button>
      <button class="secondary-btn" data-x="eaf">${esc(t('sat.exportEaf'))}</button>
      <button class="secondary-btn" data-x="flextext">${esc(t('sat.exportFlextext'))}</button>
      <button class="link-btn" data-x="">${esc(t('share.cancel'))}</button>
    </div>`;
    document.body.appendChild(wrap);
    const finish = (v) => { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(v || null); };
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); } }
    document.addEventListener('keydown', onKey, true);
    wrap.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => finish(b.dataset.x)));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) finish(null); });
    wrap.querySelector('[data-x="all"]').focus();
  });
}

async function satExport(id) {
  const rec = await db.getDoc(id);
  if (!rec) { toast(t('toast.cantOpen')); return; }
  const kind = await satExportChoice();
  if (!kind) return;
  if (rec.matchDraft) toast(t('sat.exportDraft'), 8000);
  toast(t('sat.exporting'), 3000);
  let bundle;
  /* The three files a linguist wants from this app, and nothing that embeds the recording INSIDE
   * a text file: the listening page and the .fxpa base64 the audio — see buildBundleFor — and on
   * the first six-minute WAV that was "allocation size overflow" in Firefox, with no download at
   * all. The recording rides as a file, which costs nothing to assemble. */
  try { bundle = await buildBundleFor(rec, true, { full: true, wants: { eaf: true, saymore: false, preview: false, fxpa: false } }); }
  catch (err) { toast(t('sat.exportFailed', { msg: err.message }), 8000); return; }
  let blob = bundle.blob, filename = bundle.filename;
  if (kind === 'flextext') { blob = bundle.xmlBlob; filename = bundle.xmlName; }
  else if (kind === 'eaf') {
    const e = (bundle.entries || []).find((x) => /\.eaf$/i.test(x.name));
    if (!e) { toast(t('sat.exportNoEaf'), 8000); return; }
    blob = e.data; filename = e.name;
  } else if (!bundle.zipped) toast(t('sat.exportNoAudio'), 6000);
  // The editor's own blind-download idiom (openShareMenu): a synthetic <a download>, revoked late.
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

function satImportBar(host) {
  const bar = document.createElement('div');
  bar.className = 'sat-tools';
  const btn = document.createElement('button');
  btn.className = 'secondary-btn';
  btn.id = 'sat-import';
  btn.textContent = t(SEGMENTER_MODE ? 'sat.openPair' : CONSENT_MODE ? 'sat.openAny' : 'sat.open');
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;          // a morning's worth of pairs in one go
  input.accept = SAT_ACCEPT;
  input.hidden = true;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', (e) => {
    const fs = [...e.target.files];
    e.target.value = '';          // so picking the SAME file again still fires
    if (fs.length) satImportFiles(fs).catch((err) => toast(t('toast.importFailed', { msg: err.message }), 6000));
  });
  bar.append(btn, input);
  host.prepend(bar);
}

/* ─────────────────── AUDIO SEGMENTER (__MODE = 'segmenter') ───────────────────
 * Cuts a recording into segments and matches them to the lines of a text that already exists.
 * That is the entire product. No glossing, no free translation, no baseline text editing.
 *
 * IT ADDS NO SEGMENTATION ENGINE. Segmentation Mode already exists in the editor (v158+): the Cut
 * tab, segment-strips.js and segments.js do the work, and this app reuses them unchanged by
 * providing the same DOM and calling the same switchTab(). What makes it an app rather than a tab
 * is that it cannot do anything else — the same argument plans/cut-tab.md makes for the Cut tab
 * itself, applied one level up: a worker who can only segment cannot be half-segmenting and
 * half-glossing, and does not have to decide which they are doing.
 *
 * ⚠ SEGMENTING EDITS TEXT. segments[i] IS baseline paragraph i, so a cut inserts an empty
 * paragraph and a join merges two. That is why this app opens real docs and writes them back
 * through the normal save path rather than treating audio as a separate artifact.
 */

// Segmentation only means something once the recording is attached and the text has lines to
// match. Reporting that plainly is more useful than a disabled row with no reason on it.
/* ⚠ BOTH SIGNALS USED TO BE WRONG, AND EITHER ONE ALONE MADE THIS APP UNUSABLE ON REAL DATA.
 *
 *  - "has audio" read `d.mediaName`, a field NOTHING IN THE SUITE WRITES (see db.mediaKeys). Every
 *    text on a real device therefore reported "no recording attached" and had its Open button
 *    disabled — the segmenter could not be entered at all except on a hand-made fixture that
 *    happened to carry the field. The media store is the fact, and `have` is its key set.
 *  - "how many spans" read `d.segCount`, which is docStats' count of PHRASES — how much TEXT the
 *    doc holds. A 30-line transcript with no cuts made reported itself as fully segmented.
 *    spanCount is the real one, counted from doc.segments in the projection.
 *
 * A text whose recording is still downloading is not "no audio": saying so would send a user to
 * attach a file that is already on its way. */
function sgStateOf(d, have) {
  if (!have.has(d.id)) return d.pendingAudio ? 'coming' : 'noaudio';
  return (Number(d.spanCount) || 0) > 0 ? 'some' : 'none';
}

function renderSegmenterView() {
  const view = $('#view-segmenter');
  if (!view) return;
  view.innerHTML = `
    <p class="tab-hint" data-i18n-html="sg.hint"></p>
    <ul id="sg-list" class="doc-list"></ul>
    <p id="sg-empty" class="empty-note" data-i18n-html="sg.empty" hidden></p>`;
  applyI18n(view);
  satImportBar(view);
  sgRenderList();
}

async function sgRenderList() {
  const ul = $('#sg-list');
  if (!ul) return;
  // One list read and one media-key read for the whole library, not a getMedia per row.
  const [docs, have] = await Promise.all([db.listDocs(), db.mediaKeys().catch(() => new Set())]);
  const empty = $('#sg-empty');
  if (empty) empty.hidden = docs.length > 0;
  ul.innerHTML = '';
  for (const d of docs) {
    const st = sgStateOf(d, have);
    const li = document.createElement('li');
    li.className = 'rec-item sg-' + st;
    li.innerHTML = `
      <div class="rec-item-main">
        <span class="doc-name"></span>
        <span class="doc-meta"></span>
      </div>
      <div class="rec-item-actions">
        <button class="sg-open secondary-btn"></button>
      </div>`;
    li.querySelector('.doc-name').textContent = d.title || t('untitled');
    li.querySelector('.doc-meta').textContent =
      d.hasDraft ? t('sg.inProgress')
      : st === 'noaudio' ? t('sg.noAudio')
      : st === 'coming' ? t('seg.loadingAudio')
      : st === 'some' ? (d.spanCount === 1 ? t('sg.oneSpan') : t('sg.someSpans').replace('{n}', d.spanCount))
      : t('sg.noSpans');
    satRowControls(li.querySelector('.rec-item-actions'), d);
    const open = li.querySelector('.sg-open');
    open.textContent = t('sg.open');
    // No audio means nothing to match. Leaving the button live would open a matcher that can only
    // say "attach a recording", which is a worse way to learn the same fact. A recording still on
    // its way is the same for now, and the list re-renders when it lands (onLive → sgRenderList).
    if (st === 'noaudio' || st === 'coming') open.disabled = true;
    else open.addEventListener('click', () => mgOpen(d.id));
    ul.appendChild(li);
  }
}

async function sgOpen(id) {
  const rec = await db.getDoc(id);
  if (!rec) { toast(t('toast.cantOpen')); return; }
  current = rec;
  // enterEditor() wires the tab row and the shared player dock, then switchTab('cut') runs the
  // real Cut tab: same peaks pipeline, same strips, same guess-the-lines. Nothing is reimplemented.
  enterEditor('cut');
}

/* ─────────────────── THE MATCHER (audio segmenter) ───────────────────
 * Two panes. Audio spans on the left, text lines on the right, split and joined INDEPENDENTLY,
 * then mapped piece to piece until everything is paired and the user presses Done.
 *
 * ⚠ THIS IS NOT THE ENGINE'S MODEL, AND THAT IS THE WHOLE BUILD. Everywhere else in the suite
 * `segments[i]` IS baseline line i: the two are index-locked, so cutting audio inserts a text line
 * and cutting text moves an audio boundary. That coupling is right for the Cut tab, where you are
 * transcribing as you cut. It is wrong here, because the two jobs arrive already done and out of
 * step: a recording cut by silence and a text typed by a linguist will not agree on where the
 * pieces fall, and forcing them to agree while you work means every correction on one side damages
 * the other.
 *
 * So the matcher holds three things — a span list, a line list, and a MAPPING between them — and
 * only collapses back to the index-locked shape at the end, in mgCommit(). Nothing downstream has
 * to learn a new model: the doc that comes out is the doc the rest of the suite already reads.
 *
 * The mapping is many-to-one on purpose: several spans may belong to one line (a speaker restarts,
 * or pauses mid-sentence), and one span may cover several lines. What must be true at Done is only
 * that nothing is left unmapped, which is what mgComplete() checks.
 */

let MG = null;   // { spans, lines, map, selSpan, selLine, docId }

const mgFmt = (ms) => {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, ms) / 1000;
  return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
};

// The interlinear line, as a line: vernacular words over their glosses, free translation beneath.
// Rendered from the doc's own phrase objects, so what the linguist typed in FLEx is what shows.
function mgLineText(line) {
  const words = line.phrases.flatMap((p) => p.words || []);
  return {
    words: words.filter((w) => !w.punct).map((w) => ({ txt: w.txt || '', gls: w.gls || '' })),
    free: line.phrases.map((p) => p.free || '').filter(Boolean).join(' '),
  };
}

function mgLoad(rec) {
  const paras = (rec.doc && rec.doc.paragraphs) || [];
  MG = {
    docId: rec.id,
    // Spans carry their own ids so a split or join never depends on array position — the position
    // is exactly what the user is about to change.
    /* ⚠ `timePending`, NOT a local flag name. isAligned() — the gate every shared audio helper
     * checks before it will play, seek or draw a span — reads that exact field, so a span whose
     * pending state hid under a different name would be silently treated as aligned and offered a
     * ▶ that plays from 0 to 0. `timeEstimated` rides along untouched: an estimate IS a timeline,
     * so it stays playable, and mgCommit must give it back rather than promote it to a measurement. */
    /* ⚠ doc.segments, NOT rec.segments. `doc.segments` is where the spans live and the ONLY place
     * the rest of the suite looks: segment-strips writes it on every cut, join and guess; the
     * flextext exporter and the EAF/bundle builders read it. Reading a top-level `rec.segments`
     * found nothing on any text the Cut tab had actually produced — the left pane came up empty on
     * every real document, and only a hand-made fixture that happened to store them at the top
     * level made this look like it worked. */
    /* ⚠ ONLY THE ALIGNED SEGMENTS ARE AUDIO. doc.segments is index-locked to the LINES, so a text
     * with 14 lines and one cut holds 14 entries — one real span and thirteen `timePending`
     * placeholders standing for lines, not for sound. Listing all of them put thirteen rows in the
     * Audio pane reading "No time yet — scrub to the right spot and press Enter again" (Cut-tab
     * guidance that means nothing here), each offering a ▶ for audio that does not exist — while
     * the 61 seconds of recording that had NOT been cut appeared nowhere at all.
     *
     * The Audio pane is a list of pieces of audio. "This line has no recording" is a fact about the
     * TEXT side, and mgCommit already writes it back as timePending. */
    /* ⚠ ROW i ON THE LEFT IS ROW i ON THE RIGHT — that is the whole pairing (Seth, 2026-09-03:
     * "just make sure line numbers on left and right match and then match automatically from
     * that"). Nothing is picked and nothing is linked; a split or a join on either side moves every
     * number after it, on purpose, because lining the numbers up IS the work.
     *
     * So the list is NOT filtered to the segments that have audio: a line committed without a
     * recording keeps a placeholder row here, or every line after it would slide up one number and
     * pair with the wrong sound. The placeholder says "no audio" and can be joined away. When NO
     * segment has audio there is nothing to hold in place, and mgPrepareAudio seeds the whole file. */
    spans: docSegments(rec.doc).map((s, i) => ({
      id: 'sp' + i, start: Number(s.start) || 0, end: Number(s.end) || 0,
      timePending: !!s.timePending || !(Number(s.end) > Number(s.start)), timeEstimated: !!s.timeEstimated,
    })),
    /* `paraOf` rides along untouched: it is the memory of which ORIGINAL paragraph this line came
     * from, set only for files whose author distinguished phrases from paragraphs. The matcher never
     * shows it — every phrase is its own line here regardless — but dropping it would silently
     * flatten a deliberately structured text the first time somebody opened it to cut audio. */
    lines: paras.map((p, i) => ({ id: 'ln' + i, phrases: (p.segments || []).slice(), guid: p.guid, paraOf: p.paraOf })),
    selSpan: null, selLine: null,
  };
  if (!MG.spans.some((sp) => !sp.timePending)) MG.spans = [];
}

/* ⚠ NOT EVERYTHING HAS TO MATCH, AND REQUIRING IT WAS WRONG.
 *
 * Seth: "we should be able to have empty audio segments that don't map to text … it should be
 * possible to skip lines of text before audio matches text again. Just like we can do with our
 * editor and paragraph analysis tool."
 *
 * Both leftovers are legitimate and mean different things:
 *   • AUDIO WITH NO TEXT — silence, a false start, the linguist talking, a dog. It is not part of
 *     the text and never will be. mgCommit simply does not carry it into doc.segments.
 *   • TEXT WITH NO AUDIO — a line whose recording has not been found, or was never made. The engine
 *     has always had a word for that: the span is written `timePending`, exactly as the Cut tab
 *     leaves an uncut line, and every downstream reader already handles it.
 *
 * Demanding a total bijection made a single unusable second of tape block Done for ever, on a job
 * whose whole point is that the two sides do NOT correspond one to one. So Done needs only that the
 * user has actually done something — one pair — and the status line reports the leftovers as
 * information rather than as an error. */
// Done needs one piece of audio to write; the pairing itself is the row order, so nothing else.
const mgComplete = () => !!MG && MG.spans.some((sp) => !sp.timePending);

/* ─────────────── AUTOSAVE THE WORK IN PROGRESS ───────────────
 *
 * ⚠ THIS SCREEN USED TO HOLD EVERYTHING IN MEMORY AND WRITE NOTHING UNTIL "Done", AND SETH LOST A
 * SESSION TO IT: "I was partway through my work and I lost it all. It jumped back to the start.
 * That's fine while developing, but we don't want that to happen with real work later."
 *
 * I had reasoned about that trade the wrong way round. "Nothing is written until Done" reads as a
 * safety property — Back discards cleanly, the doc is never half-edited — and it is, right up until
 * a reload. Then it is simply an hour of matching a 40-minute recording, gone, with no warning that
 * it was ever at risk. A service worker update, a browser tab reclaimed on a cheap phone, a
 * mis-tapped Back: none of those are unusual in the field, and all of them cost everything.
 *
 * Everything else in this suite autosaves continuously (schedulePersist, 400ms). Seth: "It should
 * be auto-saving just like the rest of our app does." So it does, on the same cadence.
 *
 * ⚠ THE DRAFT MUST NOT LOOK LIKE AN EDIT TO THE DOCUMENT. `modified` is what upload staleness is
 * judged by (uploadedModified !== modified), so bumping it would queue a re-upload of a text whose
 * content has not changed — over a village connection, repeatedly, every 400ms of matching. The
 * draft is written beside the doc and `modified` is deliberately left alone. listDocs projects only
 * named fields, so it costs the list nothing either.
 *
 * ⚠ AND BACK NO LONGER DISCARDS. It cannot: a control that throws away an hour of work on one tap
 * has no business being the way out of a screen. Back keeps the draft and the row says so; the
 * resume notice carries the explicit "start over". Done commits and clears it. */
let mgDraftTimer = 0;
function mgSaveDraft() {
  if (!MG) return;
  clearTimeout(mgDraftTimer);
  mgDraftTimer = setTimeout(async () => {
    if (!MG) return;
    const id = MG.docId;
    try {
      const rec = await db.getDoc(id);
      if (!rec || !MG || MG.docId !== id) return;      // left, or a different text, while we read
      rec.matchDraft = {
        at: Date.now(),
        spans: MG.spans,
        lines: MG.lines,
      };
      await db.putDoc(rec);        // ⚠ rec.modified deliberately NOT touched — see above
      /* ⚠ AND KEEP `current` IN STEP, or persist() will quietly undo this.
       *
       * Two code paths write this record from DIFFERENT in-memory copies: mgSaveDraft re-reads it
       * from storage, while persist() writes the `current` object captured when the text was opened.
       * `current` never learns about a draft written after that moment — so the next persist()
       * (healFlatSegments schedules one on open, and anything else may) writes the WHOLE record back
       * with the draft it remembers, which is the starting state. Seth saw exactly that: "It said my
       * work was saved, but what was saved was the starting state."
       *
       * A last-write-wins race between two writers of one record is not fixable by ordering; they
       * have to agree on the value. So the draft is written to both. */
      if (current && current.id === id) current.matchDraft = rec.matchDraft;
      db.broadcastLive('docs');
    } catch (e) {
      toast(t(e && e.name === 'QuotaExceededError' ? 'toast.storageFull'
                                                   : 'toast.autosaveFailed', { msg: e.message }), 8000);
    }
  }, 400);
}

// Committed, or explicitly started over: the draft has served its purpose.
async function mgClearDraft(id) {
  clearTimeout(mgDraftTimer);
  try {
    const rec = await db.getDoc(id);
    if (!rec || !rec.matchDraft) return;
    delete rec.matchDraft;
    await db.putDoc(rec);
    if (current && current.id === id) delete current.matchDraft;   // same two-writer rule
    db.broadcastLive('docs');
  } catch { /* a draft we could not clear is harmless: reopening simply offers to resume */ }
}

/* UNDO/REDO FOR THE MATCHER (Seth). The editor has had a ring since v323, but it snapshots
 * current.doc — and the matcher's whole design is that it does NOT touch the doc until Done. Its
 * state is MG: the spans, the lines and the mapping between them. So it needs its own ring, over
 * that.
 *
 * Snapshot rather than an op log, for the same reason the editor chose one: every verb here
 * (split, join, guess, map, unmap) rewrites the arrays wholesale, so an inverse-op scheme would be
 * five inverses to get right and one to get wrong. A whole-state copy is a few kilobytes.
 *
 * ⚠ CAPTURED BEFORE THE CHANGE, by the mutating function itself — never by the click handler, so
 * the keyboard and any future caller get the same history. And ✨ Guess captures too: it replaces
 * every span at once, which is precisely the action a user most wants back.
 *
 * ⚠ SELECTION IS PART OF THE STATE. Undoing a pairing that was made by two clicks must not leave
 * the first click still armed, or the next click pairs something the user never chose. */
const MG_UNDO_MAX = 40;
let mgUndoStack = [];
let mgRedoStack = [];
const mgSnap = () => ({
  spans: MG.spans.map((s2) => ({ ...s2 })),
  lines: MG.lines.map((l) => ({ ...l, phrases: structuredClone(l.phrases) })),
  selSpan: MG.selSpan, selLine: MG.selLine, pendingWordCut: MG.pendingWordCut || null,
});
function mgCapture() {
  if (!MG) return;
  mgUndoStack.push(mgSnap());
  if (mgUndoStack.length > MG_UNDO_MAX) mgUndoStack.shift();
  mgRedoStack = [];                    // a new edit forks the future, as everywhere else
}
function mgApply(st) {
  MG.spans = st.spans; MG.lines = st.lines;
  MG.selSpan = st.selSpan; MG.selLine = st.selLine; MG.pendingWordCut = st.pendingWordCut;
  /* The player was watching spans that may no longer exist — the same rule applyUndoState follows
   * in the editor. An audition running across an undo would stop at a boundary from the discarded
   * state and throw the playhead back to a start that is not there any more. */
  player?.clearSpan?.();
  mgDraw();
}
function mgUndoOnce() { if (!MG || !mgUndoStack.length) return; mgRedoStack.push(mgSnap()); mgApply(mgUndoStack.pop()); }
function mgRedoOnce() { if (!MG || !mgRedoStack.length) return; mgUndoStack.push(mgSnap()); mgApply(mgRedoStack.pop()); }

/* Mapping is two clicks: pick a span, pick a line. Clicking a mapped pair again unmaps it, which
 * is the only undo a matching screen actually needs — there is no partial state to unwind. */
/* The number badge links nothing — row i IS row i, and the two sit side by side. Tapping one
 * highlights the pair, which is all a number can usefully do now. Nothing here is undoable: no
 * state the file will carry changes. */
function mgPick(kind, id) {
  const list = kind === 'span' ? MG.spans : MG.lines;
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return;
  const same = kind === 'span' ? MG.selSpan === id : MG.selLine === id;
  MG.selSpan = same ? null : (MG.spans[i] ? MG.spans[i].id : null);
  MG.selLine = same ? null : (MG.lines[i] ? MG.lines[i].id : null);
  mgDraw();
}

/* ─────────────── MOVING A BOUNDARY ───────────────
 *
 * ⚠ ONE RULE, ONE FUNCTION, BOTH SURFACES. The overview marks and a span's own edges move the same
 * thing — the join between span i and span i+1 — so they share this, and the ordering constraint
 * cannot be enforced correctly in one place and sloppily in the other.
 *
 * Seth: "we have to make sure you can't drag them BEYOND other boundaries they run into. Like they
 * have to stay in sequence." The clamp is expressed against the NEIGHBOURING SPANS rather than the
 * neighbouring boundaries, which is the same constraint said in the form that cannot be got wrong:
 * a boundary may not pass its own span's start, nor the next span's end, and must leave a real
 * segment on each side (MIN_SEGMENT_MS — the same floor ✂ refuses below).
 *
 * Returns false when nothing moved, so a drag that hits the stop does not churn the display.
 */
function mgMoveBoundary(i, ms) {
  if (!MG || !Number.isFinite(ms)) return false;
  const a = MG.spans[i], b = MG.spans[i + 1];
  if (!a || !b || a.timePending || b.timePending) return false;
  const lo = a.start + MIN_SEGMENT_MS;
  const hi = b.end - MIN_SEGMENT_MS;
  if (hi <= lo) return false;                       // no room between the neighbours; refuse
  const t = Math.round(Math.min(hi, Math.max(lo, ms)));
  if (t === a.end) return false;
  a.end = t;
  b.start = t;
  return true;
}

/* Repaint just the two rows a drag is moving, plus the overview marks.
 *
 * ⚠ NOT mgDraw(). A full redraw rebuilds every row and every canvas — measured at 58ms for 30 spans
 * — which is fine for a click and useless at pointermove rates: the boundary would lag the finger
 * by several frames, which is precisely the feedback the drag exists to give. The full redraw
 * happens once, on release. */
function mgLiveBoundary(i) {
  const body = $('#mg-body');
  if (!body || !MG) return;
  for (const k of [i, i + 1]) {
    const sp = MG.spans[k];
    if (!sp) continue;
    const row = body.querySelector(`.mg-span[data-sp="${CSS.escape(sp.id)}"]`);
    if (!row) continue;
    const time = row.querySelector('.mg-time');
    if (time) time.textContent = `${mgFmt(sp.start)} – ${mgFmt(sp.end)}`;
    const wave = row.querySelector('.mg-wave');
    if (wave) drawSpanWave(wave, sp);
  }
  player?.setBoundaries?.(mgBoundaryTimes());
}

/* The gesture, shared by the overview marks and the span edges: capture once at the start (so a
 * whole drag is ONE undo, not forty), move live, and settle with a full redraw. */
function mgBoundaryDrag(i, ms, phase) {
  if (!MG) return;
  if (phase === 'start') { mgCapture(); player?.pause?.(); return; }
  if (phase === 'end') { mgDraw(); return; }
  if (mgMoveBoundary(i, ms)) mgLiveBoundary(i);
}

// ── independent editing, left side ────────────────────────────────────────────────────────────
/* ⚠ CUT WHERE THE PLAYHEAD IS, and only fall back to the midpoint when it is somewhere else. The
 * Cut tab has meant this by "split" since v158 (cutHere), and now that these rows carry the same
 * waveform and the same click-to-park behaviour, a ✂ that ignored the parked playhead would look
 * identical to the Cut tab's and do something different — the user listens to the join, parks the
 * cursor on it, presses ✂, and the cut lands in the middle of the span instead. The midpoint is
 * kept for the case it is actually right for: a span nobody has listened into yet. */
function mgSplitSpan(id) {
  const i = MG.spans.findIndex((s) => s.id === id);
  if (i < 0) return;
  mgCapture();
  const sp = MG.spans[i];
  const head = player?.playheadMs?.();
  const inside = typeof head === 'number' && head > sp.start && head < sp.end;
  const at = Math.round(inside ? head : (sp.start + sp.end) / 2);
  if (at - sp.start < MIN_SEGMENT_MS || sp.end - at < MIN_SEGMENT_MS) { toast(t('mg.tooShort')); return; }
  const a = { ...sp, id: sp.id + 'a', end: at };
  const b = { ...sp, id: sp.id + 'b', start: at };
  /* The two halves are new spans, so whatever the player was watching is gone — the same rule
   * cutHere follows. Without this the audition runs on to a stop time that no longer exists. */
  player?.clearSpan?.();
  MG.spans.splice(i, 1, a, b);
  mgDraw();
}

function mgJoinSpan(id) {
  const i = MG.spans.findIndex((s) => s.id === id);
  if (i <= 0) return;
  mgCapture();
  const prev = MG.spans[i - 1], cur = MG.spans[i];
  /* An estimate joined to a measurement is an estimate: the merged span is only as good as its
   * weaker half, and saying otherwise would launder a guess into a timestamp. */
  MG.spans.splice(i - 1, 2, {
    ...prev, id: prev.id + '+', end: cur.end,
    timePending: !!(prev.timePending || cur.timePending),
    timeEstimated: !!(prev.timeEstimated || cur.timeEstimated),
  });
  player?.clearSpan?.();
  mgDraw();
}

// ── independent editing, right side ───────────────────────────────────────────────────────────
/* Splitting a text line takes TWO points, and that is not a UI flourish: an interlinear line is a
 * word/gloss run plus a free translation, and the FT is prose that does not align word by word. So
 * where the words break tells you nothing about where the translation breaks, and the user has to
 * say both — a scissors position in the word run, and a space in the free translation. */
function mgSplitLine(id, wordIdx, ftCharIdx) {
  const i = MG.lines.findIndex((l) => l.id === id);
  if (i < 0) return;
  const line = MG.lines[i];
  const flat = line.phrases.flatMap((p) => p.words || []);
  /* ⚠ wordIdx COUNTS VISIBLE WORDS. The pane draws mgLineText(line).words, which drops punctuation
   * tokens, so the index the scissors carries is into THAT list — slicing `flat` with it landed one
   * token early for every comma before the cut. Walk to the wordIdx-th lexical word instead; any
   * punctuation sitting before it trails the word it follows, so it stays on the left. */
  let seen = 0, at = -1;
  for (let k = 0; k < flat.length; k++) {
    if (flat[k].punct) continue;
    if (seen === wordIdx) { at = k; break; }
    seen++;
  }
  if (wordIdx <= 0 || at < 0) { toast(t('mg.badSplit')); return; }
  mgCapture();   // after the refusal, or a split that did nothing still left an undo step behind
  const ft = mgLineText(line).free;
  const left = ft.slice(0, ftCharIdx).trim(), right = ft.slice(ftCharIdx).trim();
  // Both halves belong to the paragraph the line came from — a split inside a sentence does not
  // make a new sentence. (Seth: "as close as possible to where it originally was".)
  // ⚠ The suffix is EXPLICIT. It used to come from which half a free translation matched, so with
  // no free translation both halves were '…a' — two lines, one id, and a map that could only ever
  // reach the first of them.
  const mk = (words, free, sfx) => ({
    id: line.id + sfx,
    guid: newGuid(),
    paraOf: line.paraOf,
    phrases: [makeSegment(baselineFromWords(words), words, { free })],
  });
  MG.lines.splice(i, 1, mk(flat.slice(0, at), left, 'a'), mk(flat.slice(at), right, 'b'));
  mgDraw();
}

/* INSERT A BLANK TEXT LINE (researcher setting allowBlankLines, default on with no researcher
 * session — the same shape as allowDeleteOn, and the same reasoning: an unpaired device is somebody
 * working alone).
 *
 * The mirror of leftover audio. A recording contains things the transcript does not yet: an aside, a
 * cough, a question from the linguist, a passage nobody has written down. Leaving that audio
 * unmatched works (it is simply left out), but it is not always what you mean — sometimes the right
 * answer is "this IS a line, we just have no words for it yet". A blank line can be paired with it,
 * and comes out as a real segment with an empty phrase, which is exactly how the Cut tab has always
 * represented a span whose words are not typed.
 *
 * Inherits paraOf from the line above, so inserting inside a sentence does not start a new one. */
function mgInsertLine(after) {
  if (!MG) return;
  mgCapture();
  const above = MG.lines[after];
  const line = {
    id: 'ln+' + (MG.lines.length + 1) + '-' + Math.random().toString(36).slice(2, 6),
    guid: newGuid(),
    phrases: [makeSegment('', [])],
  };
  if (above && above.paraOf != null) line.paraOf = above.paraOf;
  MG.lines.splice(after + 1, 0, line);
  mgDraw();
}

function mgJoinLine(id) {
  const i = MG.lines.findIndex((l) => l.id === id);
  if (i <= 0) return;
  mgCapture();
  const prev = MG.lines[i - 1], cur = MG.lines[i];
  /* The merged line takes the FIRST line's paragraph. If the two were in different paragraphs the
   * break between them is exactly what the user just removed, so losing it is the point — and if
   * that leaves the second paragraph's remaining lines non-consecutive, serializeFlextext detects it
   * and falls back to a flat export rather than emitting one guid on two <paragraph>s.
   *
   * ⚠ ONE PHRASE, NOT TWO. This line first concatenated the phrase arrays, which committed as a
   * paragraph holding two segments — and the next mgOpen's healFlatSegments split it straight back
   * and cleared doc.segments to re-derive them, so the join AND the whole matching session were
   * gone before the list had finished drawing. mergePhrases builds the one segment the rest of
   * the suite reads as one line; see it for what it keeps. (Not segments.js's mergeSegments —
   * that one joins two AUDIO spans, which is the ⤴ on the other pane.) */
  MG.lines.splice(i - 1, 2, { id: prev.id + '+', guid: prev.guid, paraOf: prev.paraOf,
    phrases: [mergePhrases([...prev.phrases, ...cur.phrases])] });
  mgDraw();
}

/* Collapse back to the index-locked model the rest of the suite reads.
 *
 * Spans are ordered by time; each line takes the earliest span mapped to it, and lines with several
 * spans are given the union of their extent. That is the only reading that cannot lose audio: a
 * line covering three spans is one line of text that took three bursts to say, so its span runs
 * from the first burst to the last.
 */
async function mgCommit() {
  const rec = await db.getDoc(MG.docId);
  if (!rec) { toast(t('toast.cantOpen')); return; }
  rec.doc = rec.doc || {};
  /* ROW i PAIRS WITH ROW i. Audio left over at the end gets a blank line each (Seth, 2026-09-03:
   * "add empty text lines for extra audio at the end that is unmatched"), so no piece of the
   * recording is dropped for want of words — the words can be typed later, in the editor. Lines
   * left over at the end simply have no audio yet, which the file already knows how to say. */
  const lines = MG.lines.slice();
  const last = lines[lines.length - 1];
  // Up to the last piece of REAL audio: a trailing "no audio" placeholder earns no blank line.
  const padTo = MG.spans.reduce((m, s, i) => (s.timePending ? m : i + 1), 0);
  for (let i = lines.length; i < padTo; i++) {
    lines.push({
      id: 'ln+end' + i, guid: newGuid(), phrases: [makeSegment('', [])],
      ...(last && last.paraOf != null ? { paraOf: last.paraOf } : {}),
    });
  }
  const blankAdded = lines.length - MG.lines.length;
  /* ⚠ WRITE doc.segments, NOT rec.segments — the same field mgLoad reads and the only one anything
   * else does. A top-level rec.segments is read by nothing in this suite, so a whole matching
   * session written there would have been silently discarded: the toast said "saved", the record
   * grew a field, and the document's alignment was exactly as it had been. */
  rec.doc.segments = lines.map((l, i) => {
    const sp = MG.spans[i];
    if (!sp || sp.timePending) return { start: 0, end: 0, timePending: true };
    // An estimated time stays labelled as one all the way through: exports and the archive care
    // whether a boundary was measured or guessed, and the matcher is not what turns one into the other.
    return sp.timeEstimated ? { start: sp.start, end: sp.end, timeEstimated: true }
                            : { start: sp.start, end: sp.end };
  });
  /* ⚠ ONE PHRASE PER LINE AT THE CHOKE POINT, not only where a join is made. mgJoinLine merges as
   * it goes now, but a draft autosaved by v567 still carries the lines it joined as TWO phrases —
   * Seth's first real text had nine of them — and committing those as two-segment paragraphs is
   * precisely what the next open unwinds, alignment and all. Every line becomes one segment here,
   * whatever wrote it. */
  rec.doc.paragraphs = lines.map((l) => ({
    guid: l.guid || newGuid(),
    segments: l.phrases.length > 1 ? [mergePhrases(l.phrases)] : l.phrases,
    ...(l.paraOf == null ? {} : { paraOf: l.paraOf }),
  }));
  // docStats, like every other writer — segCount means PHRASES here, and hand-setting it to the
  // span count would have made this app's texts report a different kind of number from everyone
  // else's in the shared library list.
  Object.assign(rec, docStats(rec.doc));
  rec.modified = Date.now();
  await db.putDoc(rec);
  /* ⚠ THE OBJECT persist() WRITES. mgOpen pointed `current` at the record as it was BEFORE this
   * session; everything above went into a fresh copy. applyUpdateIfSafe() flushes persist() ahead
   * of a service-worker update — and persist()'s "skip while on the list" guard looks for
   * #view-texts, which the segmenter shell does not have — so the pre-match `current` was written
   * straight over this commit, with a fresh `modified` that queued the reverted text for upload.
   * Same rule as the draft: two writers, one record, so they hold the same object. */
  current = rec;
  db.broadcastLive('docs');
  const noAudio = rec.doc.segments.filter((x) => x.timePending).length;
  await mgClearDraft(MG.docId);        // committed: the draft has served its purpose
  toast(t('mg.committed').replace('{n}', rec.doc.segments.length));
  // Said AFTER the save and separately: what Done added or left without audio is not a failure,
  // but it must not be a surprise either.
  if (blankAdded || noAudio) {
    toast(t('mg.committedLeftover').replace('{a}', blankAdded).replace('{t}', noAudio), 9000);
  }
  mgClose();
  sgRenderList();
}

// One "+" row. Icon, not a sentence — the suite's low-literacy rule; the words live in the tooltip.
function mgInsertRow(after) {
  const row = document.createElement('div');
  row.className = 'mg-insertrow';
  const b = document.createElement('button');
  b.className = 'mg-insert';
  b.type = 'button';
  b.textContent = '+';
  b.title = t('mg.addLine');
  b.setAttribute('aria-label', t('mg.addLine'));
  b.addEventListener('click', () => mgInsertLine(after));
  row.appendChild(b);
  return row;
}

function mgDraw() {
  const box = $('#mg-body');
  if (!box || !MG) return;
  /* ⚠ KEEP BOTH PANES WHERE THEY WERE. mgDraw rebuilds the whole body on every pick, split, join and
   * unmap — which was survivable when a row was one line of text and is not now: each pane scrolls
   * independently (that is the point of two panes; the span you are matching and the line you are
   * matching it to are rarely the same distance down), so a rebuild that reset both to the top threw
   * the user back to the beginning of a 200-span recording every time they mapped a pair. Same
   * failure renderCut fixed for the Cut tab in v357, same fix. */
  const keep = (() => { const el = box.querySelector('#mg-rows'); return el ? el.scrollTop : 0; })();
  // Row i pairs with row i, and a pair is coloured only when its audio is real — a placeholder
  // "no audio" row and its line are a pair with nothing to hear, so they stay uncoloured.
  const pairs = Math.min(MG.spans.length, MG.lines.length);
  const paired = (i) => i < pairs && !MG.spans[i].timePending;
  /* A colour per pair: the pairing has to be readable at a glance, and on a cheap phone in daylight
   * a thin connecting line would not be.
   *
   * ⚠ SPACED BY THE GOLDEN ANGLE, NOT HASHED. A string hash over the line ids gave adjacent lines
   * adjacent hues — measured on a three-line text: 326°, 327°, 328°, three shades of the same pink.
   * The colour channel was doing nothing, and doing nothing invisibly, because each pair genuinely
   * had its "own" hue. Stepping by 137.508° from the line's INDEX is what actually separates
   * neighbours, which is the only case that matters: nobody confuses line 1 with line 40. */
  const hueAt = (i) => Math.round(i * 137.508) % 360;

  box.innerHTML = `
    ${MG.resumed ? `<p class="mg-resumed"><span></span><button id="mg-fresh" class="link-btn"></button></p>` : ''}
    <div class="mg-rowhead"><h3 data-i18n="mg.audio">Audio</h3><h3 data-i18n="mg.text">Text</h3></div>
    <ul class="mg-rows" id="mg-rows"></ul>`;
  applyI18n(box);
  if (MG.resumed) {
    box.querySelector('.mg-resumed span').textContent = t('mg.resumed');
    const fresh = box.querySelector('#mg-fresh');
    fresh.textContent = t('mg.startOver');
    fresh.onclick = () => mgStartOver();
  }

  /* ⚠ THE LEFT PANE IS THE CUT TAB'S ROW, NOT A LIST OF TIMESTAMPS. It was one — "0:04 – 0:09" as
   * text — and that is unusable for the job: matching a span to a line means knowing WHICH span,
   * and a span is identified by what it sounds like, not by when it starts. Seth, on this build:
   * "it can definitely re-use/adapt/repurpose a lot of what we made on the cut tab (auto scrolling,
   * big player/segments, sync between big player and segment player, etc)".
   *
   * So every piece here is the shared one, wired exactly as renderCut wires it: wireSegPlay for the
   * ▶ (plays THIS span only, and pauses in place on a second press), wireWaveSeek for click-to-park
   * and drag-to-scrub, attachSpanWave for the peaks and their resize/decode repair, and mgTicker for
   * the cursor, the ▶/⏸ glyph and the follow-scroll. Nothing is a second implementation — the
   * matcher would otherwise be the fourth waveform list in this suite and the first to feel wrong.
   *
   * The times stay, under the wave, because a matcher IS partly a bookkeeping screen. */
  /* ONE LIST, ROW i LEFT BESIDE ROW i RIGHT (Seth, 2026-09-03: "we don't even completely need our
   * two panes to scroll independently. Because they should be matching one to one. And when they
   * don't, the solution is to split, join, or add empty lines"). The cells are built first, then
   * zipped into rows; a side that runs out shows an empty cell saying what Done will do about it. */
  const spanEls = [];
  MG.spans.forEach((sp, i) => {
    const li = document.createElement('div');
    li.className = 'mg-item mg-span' + (paired(i) ? ' mg-mapped' : '') + (MG.selSpan === sp.id ? ' mg-sel' : '')
      + (sp.timePending ? ' seg-pending' : '') + (sp.timeEstimated ? ' seg-est' : '')
      + (i >= MG.lines.length ? ' mg-extra' : '');
    li.dataset.sp = sp.id;
    if (i < MG.lines.length) li.dataset.ln = MG.lines[i].id;   // its partner, for the linked highlight
    if (paired(i)) li.style.setProperty('--mg-hue', hueAt(i));
    li.innerHTML = `<button class="mg-pick"></button>
      <button class="seg-play mg-play"></button>
      <div class="mg-wavewrap"><canvas class="seg-wave mg-wave"></canvas></div>
      <span class="mg-time"></span>
      <span class="mg-actions">
        <button class="mg-split icon-btn2" title="${esc(t('mg.splitSpan'))}">✂</button>
        <button class="mg-join icon-btn2" title="${esc(t('mg.joinPrev'))}"${i === 0 ? ' disabled' : ''}>⤴</button>
      </span>`;
    li.querySelector('.mg-time').textContent = sp.timePending
      ? t('mg.noAudioRow')
      : `${mgFmt(sp.start)} – ${mgFmt(sp.end)}`;
    const pick = li.querySelector('.mg-pick');
    pick.textContent = String(i + 1);
    pick.title = t('mg.badgeTip');
    pick.onclick = () => mgPick('span', sp.id);
    li.querySelector('.mg-split').onclick = () => mgSplitSpan(sp.id);
    li.querySelector('.mg-join').onclick = () => mgJoinSpan(sp.id);

    const play = li.querySelector('.mg-play');
    const wave = li.querySelector('.mg-wave');
    play.textContent = sp.timePending ? '⋯' : '▶';
    play.setAttribute('aria-label', t(sp.timePending ? 'seg.pendingTip' : 'seg.playTip'));
    wireSegPlay(play, sp, () => player, (s2) => { lastPlayTarget = s2; });
    wireWaveSeek(wave, sp, () => player, (s2) => { lastPlayTarget = s2; });
    // v326 everywhere else in the suite: touching a waveform selects it for Space/⏮ — including an
    // unaligned one, which wireWaveSeek deliberately leaves unwired (no timeline to seek into).
    if (sp.timePending) wave.addEventListener('pointerdown', () => { lastPlayTarget = sp; });
    attachSpanWave(wave, sp);
    /* ⚠ EDGE HANDLES ARE THE FINE ADJUSTMENT; the overview marks are the coarse one. Dragging an
     * edge moves the boundary this span SHARES with its neighbour — the right edge of span i and
     * the left edge of span i+1 are the same line, so both drag the same thing and either can be
     * grabbed, whichever is nearer the thumb.
     *
     * ⚠ THE SCALE IS FROZEN AT PICK-UP. The strip is drawn to this span's own range, so the range
     * changes as you drag it; recomputing ms-per-pixel each move would make the boundary accelerate
     * away from the finger. Captured once, the gesture stays 1:1 with what was on screen when it
     * began. The first and last edges of the recording are not boundaries and get no handle. */
    const wrapEl = li.querySelector('.mg-wavewrap');
    for (const side of ['l', 'r']) {
      const bi = side === 'l' ? i - 1 : i;              // which boundary this edge is
      if (bi < 0 || bi >= MG.spans.length - 1) continue;
      const h = document.createElement('span');
      h.className = 'mg-edge mg-edge-' + side;
      h.title = t('mg.dragEdge');
      h.setAttribute('aria-label', t('mg.dragEdge'));
      h.addEventListener('pointerdown', (ev) => {
        ev.preventDefault(); ev.stopPropagation();      // not a seek, not a row select
        try { h.setPointerCapture(ev.pointerId); } catch { /* comfort only */ }
        const w = wave.clientWidth || 1;
        const perPx = Math.max(1, sp.end - sp.start) / w;
        const x0 = ev.clientX;
        const t0 = bi === i ? sp.end : sp.start;
        mgBoundaryDrag(bi, null, 'start');
        const move = (e2) => mgBoundaryDrag(bi, t0 + (e2.clientX - x0) * perPx, 'move');
        const up = () => {
          h.removeEventListener('pointermove', move);
          h.removeEventListener('pointerup', up);
          h.removeEventListener('pointercancel', up);
          mgBoundaryDrag(bi, null, 'end');
        };
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', up);
        h.addEventListener('pointercancel', up);
      });
      wrapEl.appendChild(h);
    }
    spanEls.push(li);
  });

  const lineEls = [];
  MG.lines.forEach((ln, i) => {
    const txt = mgLineText(ln);
    const li = document.createElement('div');
    li.className = 'mg-item mg-line' + (paired(i) ? ' mg-mapped' : '') + (MG.selLine === ln.id ? ' mg-sel' : '')
      + (i >= MG.spans.length ? ' mg-extra' : '');
    li.dataset.ln = ln.id;
    if (paired(i)) li.style.setProperty('--mg-hue', hueAt(i));
    li.innerHTML = `<button class="mg-pick"></button>
      <div class="mg-interlinear"><div class="mg-words"></div><div class="mg-ft"></div></div>
      <span class="mg-actions">
        <button class="mg-join icon-btn2" title="${esc(t('mg.joinPrev'))}"${i === 0 ? ' disabled' : ''}>⤴</button>
      </span>`;
    li.querySelector('.mg-pick').textContent = String(i + 1);
    li.querySelector('.mg-pick').title = t('mg.badgeTip');
    li.querySelector('.mg-pick').onclick = () => mgPick('line', ln.id);
    /* ⚠ THIS HANDLER WAS MISSING and the button had been inert since the pane was built — it
     * rendered, it enabled and disabled correctly on the first row, and it did nothing (Seth: "text
     * join doesn't appear to be working"). The span row's ⤴ was wired two loops above, which is
     * exactly why it went unnoticed: the control existed, looked identical, and worked on one side. */
    li.querySelector('.mg-join').onclick = () => mgJoinLine(ln.id);
    const wbox = li.querySelector('.mg-words');
    txt.words.forEach((w, wi) => {
      // The scissors BETWEEN word and gloss is the first of the two split points. It sits in the
      // gap it would cut, so there is nothing to explain.
      if (wi > 0) {
        const cut = document.createElement('button');
        cut.className = 'mg-scissors';
        cut.textContent = '✂';
        cut.title = t('mg.cutHere');
        cut.onclick = () => { MG.pendingWordCut = { line: ln.id, at: wi }; mgDraw(); toast(t('mg.nowPickFt')); };
        if (MG.pendingWordCut && MG.pendingWordCut.line === ln.id && MG.pendingWordCut.at === wi) cut.classList.add('mg-armed');
        wbox.appendChild(cut);
      }
      const stack = document.createElement('span');
      stack.className = 'mg-wstack';
      stack.innerHTML = '<span class="mg-w"></span><span class="mg-g"></span>';
      stack.querySelector('.mg-w').textContent = w.txt;
      stack.querySelector('.mg-g').textContent = w.gls;
      wbox.appendChild(stack);
    });
    const ftbox = li.querySelector('.mg-ft');
    if (MG.pendingWordCut && MG.pendingWordCut.line === ln.id) {
      // Second point: a space in the free translation. Every space is a target.
      const ft = txt.free;
      let last = 0;
      ft.split(/(\s+)/).forEach((piece) => {
        if (/^\s+$/.test(piece)) {
          const b = document.createElement('button');
          b.className = 'mg-ftgap';
          b.title = t('mg.splitHere');
          const at = last;
          b.onclick = () => { const w = MG.pendingWordCut.at; MG.pendingWordCut = null; mgSplitLine(ln.id, w, at); };
          ftbox.appendChild(b);
        } else {
          const s = document.createElement('span');
          s.textContent = piece;
          ftbox.appendChild(s);
        }
        last += piece.length;
      });
    } else {
      ftbox.textContent = txt.free;
    }
    const cell = document.createElement('div');
    cell.className = 'mg-cell';
    /* ⚠ BETWEEN the rows it inserts between, and one ABOVE the first — the same positional rule the
     * join controls follow (v322): a control that sits where its result will appear needs no label.
     * On the TEXT side only: a blank line is the only thing this screen invents. */
    if (allowBlankLinesOn() && i === 0) cell.appendChild(mgInsertRow(-1));
    cell.appendChild(li);
    if (allowBlankLinesOn()) cell.appendChild(mgInsertRow(i));
    lineEls.push(cell);
  });

  const rowsEl = box.querySelector('#mg-rows');
  const n = Math.max(MG.spans.length, MG.lines.length);
  for (let i = 0; i < n; i++) {
    const row = document.createElement('li');
    row.className = 'mg-row' + (paired(i) ? ' mg-row-paired' : '');
    const left = document.createElement('div');
    left.className = 'mg-cell';
    if (spanEls[i]) left.appendChild(spanEls[i]);
    else { left.classList.add('mg-cell-empty'); left.textContent = t('mg.noAudioCell'); }
    let right = lineEls[i];
    if (!right) {
      right = document.createElement('div');
      right.className = 'mg-cell mg-cell-empty';
      right.textContent = t('mg.noLineCell');
      if (allowBlankLinesOn()) right.appendChild(mgInsertRow(MG.lines.length - 1));
    }
    row.append(left, right);
    rowsEl.appendChild(row);
  }

  const bar = $('#mg-status');
  if (bar) {
    // The two counts, and what Done will do about a difference — said up front, not after.
    const a = MG.spans.length, tl = MG.lines.length;
    bar.textContent = a === tl ? t('mg.countsMatch').replace('{n}', a)
      : a > tl ? t('mg.moreAudio').replace('{a}', a).replace('{t}', tl).replace('{n}', a - tl)
      : t('mg.moreText').replace('{a}', a).replace('{t}', tl).replace('{n}', tl - a);
  }
  const done = $('#mg-done');
  if (done) done.disabled = !mgComplete();
  const u = $('#mg-undo'), r = $('#mg-redo');
  if (u) u.disabled = !mgUndoStack.length;
  if (r) r.disabled = !mgRedoStack.length;

  if (rowsEl) rowsEl.scrollTop = keep;
  /* ⚠ ONE HEAL ON A MACROTASK, NOT ONLY ON A FRAME. Every strip here is drawn in the same turn the
   * rows are created, so layout has not run yet and each canvas measures 0 wide — the first paint is
   * always at the default 300×150 and always wrong. The Cut tab lives with that because two things
   * repair it: a ResizeObserver, and its rAF ticker. NEITHER RUNS IN A BACKGROUNDED TAB — both are
   * tied to the rendering lifecycle — so a matcher opened in a tab the user then switched away from
   * (or restored on a phone that backgrounded it) would come back to four flat grey slabs and no
   * event left to fix them. A macrotask always runs, and the browser lays out before it: the same
   * reason segment-strips' own loader yields with setTimeout rather than rAF. */
  setTimeout(() => {
    if (!MG) return;
    box.querySelectorAll('.mg-wave').forEach((w) => healSpanWave(w));
    /* The cut marks on the overview, pushed here as well as from the ticker. Every split and join
     * moves them, and waiting a frame to say so makes the big waveform briefly disagree with the
     * list beneath it — on the one screen whose whole job is that the two agree. The ticker's count
     * check stays as the backstop for a player that reloads underneath us. */
    player?.setBoundaries?.(mgBoundaryTimes());
  }, 0);
  /* ⚠ AUTOSAVE HANGS OFF THE REDRAW, not off each verb. Every change to MG — split, join, map,
   * unmap, guess, insert, undo, redo, and whatever is added next — ends by calling mgDraw, so this
   * is the one place that cannot be forgotten. The debounce means a flurry of clicks is one write. */
  mgSaveDraft();
  // The rows the ticker was writing into no longer exist; it looks them up fresh each frame, so it
  // only has to be running. Restarting is what makes a redraw after the peaks land pick them up.
  mgStartTicker();
}

/* The matcher's own rAF loop — the Cut tab's ticker, minus the parts that belong to cutting.
 *
 * It does four things, all of which the Cut tab already does and none of which survives being
 * skipped here: moves the playhead cursor across the span it is inside, keeps that row's glyph
 * showing ⏸ while it plays, scrolls the row into view when playback moves off screen (`followLine`,
 * with its 4-second stand-off after a user scroll), and honours a "take me to that line" request
 * from a seek on the big player (`takeReveal`). It also heals a strip drawn before its peaks
 * finished decoding, which is the difference between a waveform and a plausible-looking wrong one.
 *
 * ⚠ NO SCISSORS UNDER THE CURSOR, unlike the Cut tab. There, ✂ cuts at the playhead and the row is
 * the only control; here every row already carries its own ✂ in the actions column, and mgSplitSpan
 * cuts at the playhead anyway — a second scissors would be the same action twice, six pixels apart. */
/* KEEP A MATCHED PAIR TOGETHER ON SCREEN (Seth: "when numbers match both text and audio, we want
 * both to scroll and highlight together").
 *
 * Two panes that scroll independently is the right layout — the span you are matching and the line
 * you are matching it to are rarely the same distance down — but once a pair EXISTS the two halves
 * are one thing, and having to find the other half by hand is the cost of that layout. So: whenever
 * one side becomes current, its partner is highlighted and, if it is off screen, brought into view.
 *
 * ⚠ IT FOLLOWS PLAYBACK, not only clicks, which is where it earns its keep: listening down a
 * recording, the text pane keeps pace on its own. The 4-second stand-off after a user scroll is the
 * shared followLine rule — someone who has just scrolled the text pane deliberately is not fighting
 * an auto-scroll for the next few seconds.
 *
 * `null` clears the pairing without moving anything, for when nothing is current. */
let mgLinked = null;
function mgLinkPair(lineId) {
  const body = $('#mg-body');
  if (!body) return;
  if (mgLinked !== lineId) {
    body.querySelectorAll('.mg-linked').forEach((el) => el.classList.remove('mg-linked'));
    mgLinked = lineId;
  }
  if (!lineId) return;
  const rows = body.querySelectorAll(`[data-ln="${CSS.escape(lineId)}"]`);
  rows.forEach((el) => el.classList.add('mg-linked'));
  // Reveal the TEXT side only: the audio side is already where the user (or the playhead) is.
  const line = body.querySelector(`#mg-rows .mg-line[data-ln="${CSS.escape(lineId)}"]`);
  if (line) mgFollowLine = followLine(line, true, mgFollowLine, player);
}
let mgFollowLine = null;

let mgRaf = 0;
let mgFollowRow = null;
function mgStopTicker() { if (mgRaf) cancelAnimationFrame(mgRaf); mgRaf = 0; mgFollowRow = null; }
function mgStartTicker() {
  mgStopTicker();
  const tick = () => {
    try {
      if (!MG) { mgStopTicker(); return; }
      const host = $('#mg-rows');
      if (!host) return;
      const p = player;
      const now = p?.playheadMs?.();
      /* The cut marks live inside wavesurfer's own wrapper, so a player reload takes them with it.
       * One property read per frame; re-pushed only when the counts disagree — same as the Cut tab. */
      if (p && p.boundaryCount && p.durationMs?.()) {
        const want = mgBoundaryTimes();
        if (p.boundaryCount() !== want.length) p.setBoundaries(want);
      }
      host.querySelectorAll('.mg-span').forEach((row) => {
        const sp = MG.spans.find((x) => x.id === row.dataset.sp);
        const wave = row.querySelector('.mg-wave');
        healSpanWave(wave);
        if (!sp || sp.timePending || typeof now !== 'number') { row.querySelector('.seg-cursor')?.remove(); return; }
        // The LAST span includes its own end — otherwise the cursor vanishes for the final instant
        // of the recording, which is exactly where a user is looking. Same rule as the Cut ticker.
        const last = sp === MG.spans[MG.spans.length - 1];
        const inSeg = now >= sp.start && (now < sp.end || (last && now <= sp.end));
        const rolling = !!p?.playing?.() && inSeg;
        const btn = row.querySelector('.mg-play');
        if (btn) { const want = rolling ? '⏸' : '▶'; if (btn.textContent !== want) btn.textContent = want; }
        if (row.classList.contains('seg-on') !== inSeg) row.classList.toggle('seg-on', inSeg);
        let cur = row.querySelector('.seg-cursor');
        if (!inSeg) { if (cur) cur.remove(); return; }
        takeReveal(row);
        mgFollowRow = followLine(row, rolling, mgFollowRow, p);
        // …and bring its matched line along, so listening down a recording keeps the text in step.
        if (rolling) mgLinkPair(row.dataset.ln || null);
        // ⚠ INSIDE THE WAVE WRAPPER now, not the row: the wrapper is the positioned ancestor since
        // the edge handles moved in, so a row-relative left would land in the wrong column.
        const wrapEl = row.querySelector('.mg-wavewrap');
        if (!wrapEl) return;
        if (!cur) { cur = document.createElement('div'); cur.className = 'seg-cursor'; wrapEl.appendChild(cur); }
        const frac = Math.min(1, Math.max(0, (now - sp.start) / Math.max(1, sp.end - sp.start)));
        cur.style.left = (frac * wrapEl.clientWidth) + 'px';
      });
    } finally {
      if (MG) mgRaf = requestAnimationFrame(tick);
    }
  };
  mgRaf = requestAnimationFrame(tick);
}

// The interior cuts, for the big player's own waveform: where one span ends and the next begins.
// The final span's end is the end of the recording, which is not a cut anyone made.
function mgBoundaryTimes() {
  const out = [];
  if (!MG) return out;
  for (let i = 0; i < MG.spans.length - 1; i++) {
    const sp = MG.spans[i];
    if (!sp.timePending) out.push(sp.end);
  }
  return out;
}

/* Load the recording, then the peaks, then redraw — in that order, and each step announced.
 *
 * ⚠ THE PANE IS DRAWN BEFORE ANY OF THIS FINISHES, deliberately: peaks for a 40-minute recording are
 * seconds of work, and the mapping the user came to do needs the TEXT pane, which is ready
 * immediately. So the spans appear at once with flat strips and fill in behind — rather than holding
 * a whole screen hostage to audio the user may not even play.
 *
 * Every await is followed by the same guard, because all of them are long enough for the user to
 * have pressed Back: a late resolve must not load a player, draw peaks, or start a ticker for a
 * document that is no longer open. */
async function mgPrepareAudio(docId) {
  const note = $('#mg-audio-note');
  const prog = segPrep('#mg-audio-note');
  const live = () => MG && MG.docId === docId;
  if (note) note.hidden = false;
  prog('read', null);
  let media = await db.getMedia(docId).catch(() => null);
  media = await segWorkingMedia(docId, media, current && current.title, prog);
  if (!live()) return;
  if (!media || !media.blob) {
    // Reachable: sgRenderList disables Open for a text with no recording, but a text can lose its
    // audio between the list rendering and the row being tapped. Say so rather than showing strips
    // that will never draw.
    if (note) segProgress(note, t('cut.noAudio'), 0);
    return;
  }
  const p = getPlayer();
  playerDocId = docId;
  if (p.loadedFor !== docId) {
    p.loadedFor = docId;
    playerReadyFor = null;
    await p.load(media);
    if (p.loadedFor === docId) playerReadyFor = docId;   // a newer load supersedes silently
  }
  if (!live()) return;
  p.root.hidden = false;
  // ⚠ NO ✕. This app matches audio to text; detaching the recording is not one of its verbs, and the
  // dock's remove button would delete the media out from under the very screen using it.
  if (p.el && p.el.remove) p.el.remove.hidden = true;
  await ensurePeaks(docId, media.blob, (playerReadyFor === docId && p.decodedBuffer) ? p.decodedBuffer() : null, prog);
  if (!live()) return;
  if (note) note.hidden = true;
  /* ⚠ A TEXT THAT HAS NEVER BEEN CUT MUST NOT OPEN INTO AN EMPTY PANE. That is the NORMAL starting
   * state for this app — you arrive with a recording and a text, and no cuts at all — and until now
   * it was a dead end: no spans meant nothing to play, nothing to split, and no way to make the
   * first one, because every editing verb here operates on an existing span. The Cut tab never had
   * this problem; renderCut seeds a whole-file span through reconcile(), and the matcher simply did
   * not inherit that. One span covering the recording makes the ✂ on it the first cut. */
  const dur = peaksDurationMs();
  if (dur > 0 && !MG.resumed) {
    // ⚠ NOT over a resumed draft: its spans are the user's own cutting, and appending a "remainder"
    // to them would invent a span they had deliberately not made.
    // The last piece of AUDIO, not the last row: a trailing "no audio" placeholder ends at 0.
    const lastEnd = Math.max(0, ...MG.spans.filter((s) => !s.timePending).map((s) => s.end));
    if (!MG.spans.length) {
      MG.spans = [{ id: 'sp0', start: 0, end: dur, timePending: false, timeEstimated: false }];
    } else if (dur - lastEnd > 1000) {
      /* ⚠ THE UNCUT REMAINDER MUST BE ON SCREEN, OR IT CANNOT BE CUT. Reopening a partly-matched
       * text showed only what had already been aligned — Seth's file came back as a single
       * 3-second span with the other 61 seconds nowhere, and no way to reach them, because every
       * verb here operates on an existing span. Whatever follows the last span is appended as one
       * more, so the pane always accounts for the whole recording. (Seth: "The remainder of
       * unsegmented audio should show in the final line … on this particular file that should mean
       * the rest of the audio shows in line two.")
       *
       * 1s tolerance, the same as coverTail's: a sliver at the end is rounding, not a missing piece. */
      MG.spans.push({ id: 'tail', start: lastEnd, end: dur,
                      timePending: false, timeEstimated: false });
    }
  }
  // Draggability FIRST, so the marks are built with their grips rather than rebuilt a moment later.
  // (onBoundaryDrag forces a rebuild either way — see it — but the natural order costs nothing.)
  p.onBoundaryDrag?.((i, t, phase) => mgBoundaryDrag(i, t, phase));
  p.setBoundaries?.(mgBoundaryTimes());
  mgDraw();          // redraw with real peaks — attachSpanWave paints from peaksCache
}

/* ✨ GUESS THE LINES — cut the recording at its pauses, the same detector the Cut tab uses, over the
 * same peaks the waveforms are drawn from.
 *
 * ⚠ IT TOUCHES ONLY MG.spans, NEVER THE DOCUMENT. cutGuessSplits() rewrites the doc into N spans and
 * N empty paragraphs, 1:1 — right for the Cut tab, and the exact coupling this app exists to avoid,
 * since here the text already exists and its lines must survive. So the guess is a proposal on the
 * audio side alone: nothing is written until Done, and Back discards it.
 *
 * The three guards are the Cut tab's, for the same reasons: refuse a recording longer than the
 * detector's limit (one press on 40 minutes is hundreds of live canvases on a phone), say so when
 * there are no clear pauses rather than silently doing nothing, and ask first if the user has
 * already cut by hand — that work is exactly what this would throw away. */
async function mgGuess() {
  if (!MG) return;
  const dur = peaksDurationMs();
  if (!dur) { toast(t('cut.no.guessAudio'), 6000); return; }
  if (dur > GUESS_MAX_MS) {
    toast(t('cut.no.guessLong', { max: Math.round(GUESS_MAX_MS / 60000), mins: Math.ceil(dur / 60000) }), 9000);
    return;
  }
  // >1 span means real cutting has happened. One whole-file span is the seed, not work.
  if (MG.spans.length > 1 && !await confirmDialog(t('mg.guessReplace'))) return;
  if (!MG) return;                      // the dialog is async; the user may have left
  const cuts = guessedBoundaries();
  if (!cuts.length) { toast(t('cut.no.guessNone'), 7000); return; }
  mgCapture();                       // replacing every span at once is the edit most worth undoing
  const edges = [0, ...cuts, dur];
  MG.spans = edges.slice(0, -1).map((start, i) => ({
    id: 'g' + i, start, end: edges[i + 1], timePending: false, timeEstimated: false,
  }));
  MG.selSpan = null;
  player?.clearSpan?.();
  toast(t('mg.guessed').replace('{n}', MG.spans.length), 5000);
  mgDraw();
}

// One exit, so the ticker, the player and the open record are always released together. Three
// callers (Back, Done, and a failed open) each releasing two of the three is how a rAF loop outlives
// its screen and keeps scrolling a list nobody is looking at.
function mgClose() {
  mgStopTicker();
  MG = null;
  player?.pause?.();
  player?.clearSpan?.();
  // ⚠ AND HIDE THE DOCK. It is a sibling of the views, not part of one, so `show('segmenter')` does
  // not touch it — the transport for a recording nobody has open stayed on screen above the text
  // list, offering to play audio that belonged to whatever was last matched.
  player?.onBoundaryDrag?.(null);   // the dock is shared; leave it as we found it
  player?.hide?.();
  lastPlayTarget = null;
  show('segmenter');
}

/* Throw the unfinished work away and begin from the committed document. The ONLY path that
 * discards a draft on purpose, and it asks first — this is the button whose whole job is to destroy
 * the thing the autosave exists to protect. */
async function mgStartOver() {
  if (!MG) return;
  if (!await confirmDialog(t('mg.startOverConfirm'))) return;
  const id = MG.docId;
  await mgClearDraft(id);
  mgClose();
  mgOpen(id);
}

async function mgOpen(id) {
  const rec = await db.getDoc(id);
  if (!rec) { toast(t('toast.cantOpen')); return; }
  current = rec;
  /* ⚠ ONE PHRASE PER LINE, AND THE ENGINE ALREADY KNOWS HOW. A FLExText commonly arrives with every
   * phrase inside ONE paragraph — Seth's "Rumah Jatuh di Muara Suhu" is 1 paragraph holding 60
   * phrases, and "Crocodile Woman" is 1 holding 77. mgLoad reads PARAGRAPHS, so such a text became a
   * single matcher line: sixty phrases merged into one wall of words with a scissors in every gap,
   * asking the user to re-cut by hand a segmentation the linguist had already done in FLEx.
   *
   * That is the wrong job. Seth: "the text is segmented (phrases), the audio is not, segment the
   * audio and match it to text segments (phrases), but also have a way to adjust those phrase
   * cuts/joins IF WE NEED TO, but not re-doing the phrase segmentation from scratch."
   *
   * healFlatSegments promotes each phrase to its own paragraph, keeping its words, glosses, free
   * translation and any imported time offsets, and giving the first the paragraph's guid. It exists
   * because the same import shape broke the gloss tab in v322; the matcher just never called it. The
   * ✂ and ⤴ on the text side stay exactly as they were — they are now the ADJUSTMENT Seth describes,
   * applied to real phrase boundaries, rather than the only way to get any boundaries at all. */
  healFlatSegments(rec.doc);
  mgLoad(rec);
  /* Unfinished work wins over the stored document, because it is NEWER by construction — the doc
   * holds the last COMMITTED state and the draft is everything since. Resumed rather than offered:
   * a dialog on open is a decision the user has to make before they can see what they would be
   * deciding about, and the answer is nearly always yes. The notice says what happened and carries
   * the way out. */
  const draft = rec.matchDraft;
  if (draft && Array.isArray(draft.spans) && Array.isArray(draft.lines)) {
    MG.spans = draft.spans;
    MG.lines = draft.lines;
    MG.resumed = draft.at || Date.now();
  }
  mgUndoStack = []; mgRedoStack = [];   // history belongs to the text being matched, not the app
  const view = $('#view-matcher');
  if (view) {
    view.innerHTML = `
      <div class="mg-bar">
        <button id="mg-back" class="link-btn"></button>
        <span id="mg-title" class="mg-title"></span>
        <span id="mg-status" class="mg-status"></span>
        <button id="mg-undo" class="icon-btn2" disabled>&#8630;</button>
        <button id="mg-redo" class="icon-btn2" disabled>&#8631;</button>
        <button id="mg-guess" class="secondary-btn icon-btn2">✨</button>
        <button id="mg-done" class="primary-btn" disabled></button>
      </div>
      <p id="mg-audio-note" class="note seg-loading" hidden role="status" aria-live="polite">
        <span class="seg-loading-text"></span>
        <span class="seg-loading-bar is-indeterminate" aria-hidden="true"><i></i></span>
      </p>
      <div id="mg-body"></div>`;
    $('#mg-back').textContent = t('mg.back');
    $('#mg-back').onclick = () => mgClose();
    $('#mg-title').textContent = rec.title || t('untitled');
    // ✨ not a sentence — same low-literacy rule as the Cut tab's: a glyph, with its words in the
    // tooltip and the aria-label.
    for (const [id, fn2, key] of [['#mg-undo', mgUndoOnce, 'edit.undo'], ['#mg-redo', mgRedoOnce, 'edit.redo']]) {
      const b = $(id);
      b.title = t(key); b.setAttribute('aria-label', t(key));
      b.onclick = () => fn2();
    }
    const g = $('#mg-guess');
    g.title = t('cut.guess');
    g.setAttribute('aria-label', t('cut.guess'));
    g.onclick = () => mgGuess();
    $('#mg-done').textContent = t('mg.done');
    $('#mg-done').onclick = () => mgCommit();
  }
  show('matcher');
  mgDraw();
  mgPrepareAudio(id);   // not awaited — see the comment on it
}

function setupSegmenterMode() {
  renderSegmenterView();
  /* ⚠ DOCUMENT-LEVEL, and gated on the matcher being open. There is no text box to hold focus on
   * this screen — the same reason the Cut tab's keys are document-level — so a handler bound to a
   * row would only work after the user had happened to click one. Guarded by `MG` so it cannot
   * shadow the browser's own undo anywhere else in the app. */
  document.addEventListener('keydown', (e) => {
    if (!MG) return;
    const k = (e.key || '').toLowerCase();
    if (k !== 'z' || !(e.metaKey || e.ctrlKey)) return;
    const el = e.target;
    // Never steal it from a field the user is typing in (the speaker box, a future text input).
    if (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName || ''))) return;
    e.preventDefault();
    if (e.shiftKey) mgRedoOnce(); else mgUndoOnce();
  });
  show('segmenter');
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
  if (!el) { el = document.createElement('div'); el.id = 'crowd-turnstile'; el.className = 'tucked'; document.body.appendChild(el); }
  return el;
}
/* TUCKED, NOT ABSENT (Seth, 2026-08-31). The widget runs at full function but sits at opacity 0:
 * its Verifying/Success animation read as "upload finished" to exactly the visitor this page
 * serves, who then closed the tab mid-upload. The "Protected by Cloudflare" note in the sending
 * view is the disclosure — hover/tap reveals the live widget. ⚠ A REAL interactive challenge
 * force-reveals itself ('before-interactive-callback') and can never be re-tucked while it is
 * waiting — an invisible challenge would strand the visitor with an upload that never starts. */
function crowdTurnstileReveal(force) {
  const host = crowdTurnstileHost();
  host.classList.remove('tucked');
  if (force) host.dataset.forced = '1';
}
function crowdTurnstileTuck() {
  const host = crowdTurnstileHost();
  if (host.dataset.forced) return;   // an interactive challenge is showing — never hide it
  host.classList.add('tucked');
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
  delete host.dataset.forced;
  crowdTurnstileTuck();               // each token starts tucked; see the reveal/tuck pair above
  const settle = () => { delete host.dataset.forced; crowdTurnstileTuck(); };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { settle(); reject(new Error('turnstile timeout')); }, 45000);
    try {
      window.turnstile.render(host, {
        sitekey: turnstileSiteKey(),
        // A challenge that needs the visitor's hand must be SEEN — this is the one path that
        // un-tucks the widget on its own and pins it visible until the token settles.
        'before-interactive-callback': () => crowdTurnstileReveal(true),
        callback: (tok) => { clearTimeout(timer); settle(); resolve(tok); },
        'error-callback': () => { clearTimeout(timer); settle(); reject(new Error('turnstile error')); },
      });
    } catch (e) { clearTimeout(timer); settle(); reject(e); }
  });
}

// -- the crowd screen (rendered into #view-record — the crowd shell's only view) --
function crowdRelabelSend() {
  const sv = $('#record-save');
  if (sv) { sv.removeAttribute('data-i18n'); sv.textContent = t('crowd.send'); }
}
/* Paints upload progress WITHOUT re-rendering the view — a full repaint on every chunk would
 * flicker and throw away the visitor's scroll position. Called from the shared chunk loop, which
 * reports the RESUMED offset first, so a submission continued after a reload opens at where it
 * really is rather than at a stale 0%. */
function crowdSetProgress(sent, total) {
  const wrap = $('#crowd-prog');
  if (!wrap) return;
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((sent / total) * 100))) : 0;
  wrap.hidden = false;
  // Sweep (indeterminate) until a real byte has moved. A determinate bar pinned at 0% for a whole
  // first chunk reads as a hang — the exact bug the chunk policy exists to avoid showing.
  if (sent > 0) wrap.classList.remove('indet');
  wrap.setAttribute('aria-valuenow', String(pct));
  const bar = $('#crowd-prog-bar');
  if (bar) bar.style.width = pct + '%';
  // The text node only — #crowd-status also holds the spinner, which textContent would destroy.
  const st = $('#crowd-status-txt');
  if (st && sent > 0) st.textContent = t('crowd.sendingPct', { pct });
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
  /* The spinner and the bar are visible from the FIRST FRAME of 'sending' — before the Turnstile
   * token, before the session opens, before any byte moves. The bar sweeps (indeterminate) until
   * real bytes flow; crowdSetProgress then makes it a percentage. Nothing here waits on the
   * network, so the visitor is never looking at a screen whose only animation is someone else's
   * checkmark. */
  else if (state === 'sending') body = `<p class="crowd-status" id="crowd-status"><span class="crowd-spin" aria-hidden="true"></span><span id="crowd-status-txt">${esc(t('crowd.sending'))}</span></p>
    <div class="crowd-prog indet" id="crowd-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="crowd-prog-bar"></span></div>
    <button id="crowd-cf-note" class="crowd-cf-note" type="button">${esc(t('crowd.protectedBy'))}</button>`;
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
  /* ⚠ A VERSION LINE, because this is the ONE app in the suite that reports nothing about itself.
   * The crowd page has no version badge and, unlike every other app, no service worker — so there is
   * no fxUpdate() to interrogate either. That combination cost real time on 2026-08-19: a manifest
   * fix appeared not to work, and the only way to tell "the fix is wrong" from "this page is running
   * an older engine" was to open the Cloudflare deployments dashboard. Seth: "I don't know about the
   * staging recorder until we have it showing a version badge."
   *
   * Small and out of the way — a contributor is not the audience, but neither is it a secret. It is
   * the same information the editor puts in its own badge. */
  const verLine = `<p class="crowd-ver">${esc(BUILD_TAG ? ENGINE_VERSION + ' · ' + BUILD_TAG : ENGINE_VERSION)}</p>`;
  v.innerHTML = `<div class="record-screen crowd-screen">
    <p class="record-welcome">${esc(welcome)}</p>
    ${body}
    ${verLine}
  </div>`;
  $('#btn-record-big')?.addEventListener('click', startConsentThenRecord);
  // The disclosure note: hover peeks at the live widget, tap/click toggles it (phones have no
  // hover). Tucking is refused while a forced interactive challenge is up — see crowdTurnstileTuck.
  const cf = $('#crowd-cf-note');
  if (cf) {
    cf.addEventListener('mouseenter', () => crowdTurnstileReveal(false));
    cf.addEventListener('mouseleave', () => crowdTurnstileTuck());
    cf.addEventListener('click', () => {
      if (crowdTurnstileHost().classList.contains('tucked')) crowdTurnstileReveal(false);
      else crowdTurnstileTuck();
    });
  }
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
  // role travels with each entry so the manifest can DECLARE it, exactly as the device's source
  // package does — a tag is a fact, a filename is a guess (see pickSourceFiles in the panel).
  const entries = [{ name: file.name, data: file, role: 'source-audio' }];
  if (assent?.blob) entries.push({ name: assent.name, data: assent.blob, role: 'consent-clip' });
  if (promptAudio?.blob) entries.push({ name: promptAudio.name, data: promptAudio.blob, role: 'consent-prompt' });
  if (receipt) {
    const full = { ...receipt, textTitle: file.name };
    entries.push({ name: 'consent-receipt.json', role: 'consent-receipt', data: new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' }) });
    entries.push({ name: 'consent-receipt.txt', role: 'consent-receipt', data: new Blob([consentReceiptText(full)], { type: 'text/plain' }) });
  }
  /* THE MANIFEST — the same builder the device and the panel use, written by the CLIENT because
   * the crowd page IS this engine (window.__MODE = 'crowd'), so the third origin needs no third
   * writer and no worker-side copy of the contract.
   *
   * It goes in LAST but declares the entries above, so a consumer can name what a partial package
   * is missing exactly as it can for a device text. `source.kind = 'crowd'` with the recorder's own
   * id is what finally makes all three origins distinguishable from Drive alone.
   *
   * ⚠ docId is left empty ON PURPOSE. The doc id of a crowd submission is its submission id, and
   * that is minted SERVER-SIDE (it is what binds the upload ticket and names the text folder), so
   * the client cannot know it here without inventing a second identity that could disagree with the
   * first. A reader takes the id from the folder's flextextDoc tag, which is the authority. */
  const cManifest = buildSourceManifest({
    docId: '', title: file.name || '',
    origin: 'crowd',
    originatedAt: Date.now(),
    engine: ENGINE_VERSION, buildTag: BUILD_TAG,
    // A crowd page collects no writing systems — it is a recorder, not an editor. Left empty
    // rather than guessed from the UI language, which is a different thing entirely.
    audio: { name: file.name, mime: file.type || 'application/octet-stream', bytes: file.size, derived: false },
    /* `files` MEANS "what should end up in the FOLDER" — the builder's contract: it "declares an
     * INTENDED FILE SET that a consumer compares against the folder to derive completeness". For a
     * crowd text that is the individual files, exactly as for a device text, because the worker now
     * UNPACKS the zip on arrival (plan §16.10 "B", v411). The zip is TRANSPORT, not content, and
     * never appears here.
     *
     * ⚠ THIS IS WHERE v396 STARTED, AND v410 WAS WRONG TO CHANGE IT. v410 made this declare the zip,
     * which was correct for a world where the zip stayed — and v411 abolished that world a few hours
     * later. Two fixes in opposite directions, and the second is a revert. Worth leaving on the
     * record: the first version was right about the destination and merely early.
     *
     * ✅ A HAPPY CONSEQUENCE, not a gap: between arrival and unpacking the folder holds the zip and
     * this manifest, so the Files modal reports the individual files as "not arrived yet" — which is
     * TRUE, and is precisely what a manifest written before the bytes is for. */
    files: entries.map((e) => ({ name: e.name, role: e.role || '', mime: (e.data && e.data.type) || '', bytes: (e.data && e.data.size) || 0 })),
    consent: {
      mode: 'crowd',
      prompt: !!(promptAudio && promptAudio.blob),
      response: !!(assent && assent.blob),
      receipt: !!receipt,
    },
    source: { kind: 'crowd', id: CROWD_ID || '' },
  });
  /* FIRST in the zip, not last — same order as the device's upload queue, and here it is
   * load-bearing rather than tidy. The worker unwraps this entry to place it beside the zip in
   * Drive, and on the CHUNKED path it never holds the whole file: it reads only the first slice
   * back. A STORE zip is scanned from offset 0, so an entry at the front is reachable from a small
   * ranged read no matter how many hundreds of megabytes the recording is. */
  return makeZip([{ name: MANIFEST_NAME, data: new Blob([JSON.stringify(cManifest, null, 2)], { type: 'application/json' }) }, ...entries]);
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
  // The typed signature (when that consent mode captured one) rides the pending item so the
  // worker can lead the text title with it — "name + date/time" (Seth, 2026-08-31). Old workers
  // ignore the extra start-body field; nothing else reads this.
  const speaker = String((extras && extras.receipt && extras.receipt.signatureName) || '');
  await crowdPutPending({ id: mkGuid(), created: Date.now(), blob: zip, ...(speaker ? { speaker } : {}) });
  renderCrowdView('sending');
  await crowdFlush(true);
}

// One item → the worker. ok ONLY on confirmed Drive delivery. Throws with e.code
// carrying the worker's error keyword so crowdFlush can pick the right message.
// Small zips are one POST; big ones go CHUNKED (a single request is platform-
// capped ~100 MB — chunks are not), with the session ticket persisted on the
// pending item so a reload resumes mid-file.
/* ⚠ EVERY SUBMISSION IS CHUNKED, whatever its size, and the loop is the SHARED one
 * (`runChunkedUpload`, upload.js) — not a third hand-written copy.
 *
 * What this replaced, and why it mattered more here than anywhere else: the crowd path was the only
 * upload in the suite that never got the v337 chunk-policy fix. It sent fixed 8 MiB slices, retried
 * a failed slice AT THE SAME SIZE, and below 16 MiB sent one plain POST with no feedback at all.
 * researcher.js records both as diagnosed bugs — "progress hung at 0% and then suddenly jumped to
 * finished… indistinguishable from a hang", and "a failing chunk retried at the SAME size. On a weak
 * field connection that is the one thing you must not do." Both sentences described this path, word
 * for word, and the person paying for it is a villager on a phone on the worst connection in the
 * system, while the researcher's own uploads were the adaptive ones.
 *
 * The single-POST case is gone deliberately: it was the only path that could show no progress, and a
 * submission that looks hung is one a visitor gives up on. `/submit/start` accepts anything ≥ 4 KiB,
 * so every real submission can be chunked.
 *
 * ⚠ PERMANENT REFUSALS MUST NOT BE RETRIED — they THROW, and the shared loop deliberately does not
 * catch. `paused`, `budget`, `too_large`, `turnstile_failed` and friends are answers, not failures:
 * crowdFlush reads `e.code` to pick the visitor's message and to drop a permanently unsendable item
 * instead of wedging the queue. Only genuine transport trouble returns `{ fail: true }` and earns a
 * halved retry. */
const CROWD_PERMANENT = ['too_large', 'too_small', 'paused', 'budget', 'not_found',
                         'turnstile_failed', 'rate_limited', 'unavailable'];

// How long an UNDELIVERED take may wait in this browser for a retry — see crowdFlush.
const CROWD_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

async function crowdChunkPut(streamId, range, body) {
  let r;
  try {
    r = await fetch(workerBase() + '/v1/crowd/' + encodeURIComponent(CROWD_ID) + '/submit/chunk', {
      method: 'PUT',
      headers: { 'x-fx-upload': streamId, 'x-fx-range': range,
                 ...(body ? { 'content-type': 'application/octet-stream' } : {}) },
      body,
    });
  } catch { return { fail: true }; }                      // network blip — the loop halves and re-probes
  const out = await r.json().catch(() => ({}));
  if (r.ok && out.done) return { done: true, fileId: out.fileId || '' };
  if (r.ok && out.done === false) return { received: out.received || 0 };
  if (out.error === 'session_gone' || out.error === 'bad_upload') return { gone: true };
  if (CROWD_PERMANENT.includes(out.error)) { const e = new Error(out.error); e.code = out.error; throw e; }
  return { fail: true };
}

// One item → the worker. Resolves ONLY on confirmed Drive delivery. Throws with e.code carrying the
// worker's error keyword so crowdFlush can pick the right message; the session ticket is persisted
// on the pending item, so a reload resumes mid-file rather than re-sending from zero.
async function crowdSubmitOne(item) {
  const total = item.blob.size;
  const r = await runChunkedUpload({
    total,
    slice: (a, b) => item.blob.slice(a, b),
    /* The Firefox failure this heals (2026-08-31): a blob read back from IndexedDB moments after
     * being written can be silently unreadable at fetch time — every chunk PUT then goes out with
     * zero body bytes and the edge 400s it, so the FIRST submission always failed and the visitor's
     * manual retry (a fresh read) always worked. readChunk() in the shared loop detects the empty
     * read; this hook gives it a fresh blob from the store so the SAME attempt completes. */
    refresh: async () => {
      const fresh = (await crowdListPending()).find((x) => x.id === item.id);
      if (fresh && fresh.blob) item.blob = fresh.blob;
    },
    streamId: item.streamId || null,
    put: crowdChunkPut,
    /* ⚠ THIS IS WHERE A TURNSTILE TOKEN IS SPENT — one bot-check per submission. The shared loop
     * caps session restarts at two for exactly this reason: reopening freely would burn the
     * visitor's checks and look like abuse from the server's side. */
    openSession: async () => {
      const headers = { 'content-type': 'application/json' };
      if (CROWD_CFG && CROWD_CFG.turnstile) headers['x-fx-turnstile'] = await crowdTurnstileToken();
      const res = await fetch(workerBase() + '/v1/crowd/' + encodeURIComponent(CROWD_ID) + '/submit/start',
        { method: 'POST', headers, body: JSON.stringify({ size: total, ...(item.speaker ? { name: item.speaker } : {}) }) });
      const out = await res.json().catch(() => ({}));
      if (res.ok && out.ok && out.uploadId) return out.uploadId;
      const e = new Error(out.error || ('HTTP ' + res.status));
      e.code = out.error || '';
      throw e;                                            // budget / paused / bot-check — an answer, not a retry
    },
    onSession: async (id) => {
      if (id) item.streamId = id; else delete item.streamId;
      await crowdPutPending(item);                        // survives a reload → resume mid-file
    },
    onProgress: crowdSetProgress,
  });
  if (r.done) { await crowdDelPending(item.id); return; }
  // Still resumable — the persisted ticket means the next flush continues from Drive's own offset.
  const e = new Error('crowd_upload_stalled');
  e.code = '';
  throw e;
}

// Drain the pending store oldest-first. interactive=true drives the visitor-facing
// states (sending/thanks/failed); the silent boot retry only updates the counter.
async function crowdFlush(interactive) {
  if (crowdFlushing) return;
  crowdFlushing = true;
  try {
    /* ⚠ UNCONFIRMED TAKES EXPIRE AFTER 24 HOURS (Seth, 2026-08-31). A delivered take is deleted
     * the moment the worker confirms it; an UNDELIVERED one used to sit in this browser's
     * IndexedDB forever. This page runs on shared and borrowed phones, and a stranger's voice
     * recording is not something a device should hold indefinitely on the off-chance of a retry —
     * the resume window is a courtesy, not an archive. Within 24h a reopened page still resumes
     * mid-file exactly as before; after that the take is dropped, unsent. */
    const all = await crowdListPending();
    const now = Date.now();
    const items = [];
    for (const item of all) {
      if (now - (item.created || 0) > CROWD_PENDING_TTL_MS) await crowdDelPending(item.id);
      else items.push(item);
    }
    items.sort((a, b) => a.created - b.created);
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

/* ⚠ THE LEGACY ORIGIN NOTICE — rulingants.github.io only, inert everywhere else.
 *
 * The Pages estate still serves a working app, and that is the danger: it keeps working while
 * receiving no updates, so a device can sit there for months looking healthy. Seth: "this device is
 * paired using an old website that is no longer receiving updates."
 *
 * ⚠ THE DIRECTIONS' ORDER IS DATA-SAFETY, NOT TIDINESS. A PWA's identity is its ORIGIN, so moving to
 * the new site gives a DIFFERENT installed app with an empty IndexedDB — the local texts do not
 * follow, and nothing can carry them across (the Drive re-parenting machinery works on folders, not
 * on browser storage). So uploading comes FIRST: after the device is revoked and re-paired on the
 * new origin, anything not uploaded is stranded on the old one and unreachable.
 *
 * Texts do NOT need removing — only uploading. They return by assignment from Drive. */
const LEGACY_ORIGIN_HOST = 'rulingants.github.io';

function legacyDirectionsModal() {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true">
    <h3>${esc(t('legacy.title'))}</h3>
    <p class="note">${esc(t('legacy.why'))}</p>
    <ol class="legacy-steps">
      <li>${esc(t('legacy.step1'))}</li>
      <li>${esc(t('legacy.step2'))}</li>
      <li>${esc(t('legacy.step3'))}</li>
    </ol>
    <p class="note">${esc(t('legacy.keep'))}</p>
    <button class="primary-btn" data-close>${esc(t('legacy.close'))}</button>
  </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('[data-close]').addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey, true); }
  }, true);
}

function setupBanners() {
  if (location.hostname === LEGACY_ORIGIN_HOST) {
    const el = $('#legacy-origin');
    if (el) {
      el.hidden = false;
      const how = $('#legacy-how');
      if (how) how.addEventListener('click', legacyDirectionsModal);
    }
  }

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
  // Native shell: assets are bundled in the APK, so a service worker would add nothing but a
  // stale-cache failure mode. (It also happens to be skipped by the isDev check below, since
  // Capacitor serves from localhost — but rely on the explicit marker, not that coincidence.)
  if (isNativeShell()) return;
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
    // v322: forcedApply is ONE-SHOT. It was never reset, so after one manual force this tab
    // reloaded on ANY later controllerchange (incl. another tab's clients.claim), text open or not.
    const wasForced = forcedApply; forcedApply = false;
    if (reloading) return;
    if (!wasForced && !updateSafeNow()) { reloadPending = true; return; }   // forced (manual shortcut) reloads regardless
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
// Console helper (Seth, 2026-08-04): type fxUpdate() in any tab's console to force the
// service-worker refresh without the close-every-tab dance — same tested flow as the ⌃/⌥+U
// shortcut (flushes saves, refuses only mid-recording-save, skips the waiting worker in, reloads).
// NOTE: it cannot bust a stale CDN copy of sw.js — if the SERVER still serves the old version,
// the "up to date" toast is reporting that truthfully.
if (typeof window !== 'undefined') window.fxUpdate = forceUpdateCheck;


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
/* WHERE ?devreset IS HONOURED — deliberately NOT isDevHost, and deliberately not everywhere.
 *
 * isDevHost covers loopback and private-LAN addresses, and it also gates the service worker, so
 * widening IT to reach staging would change caching behaviour on the preview estate as a side
 * effect. This predicate is devreset's alone.
 *
 * The `.workers.dev` estate is staging and the per-branch previews — test surfaces, never a field
 * device: production is flextext.app (+ its subdomains) and the legacy rulingants.github.io, and
 * those must keep REFUSING. A ?devreset link is a working link: forwarded into a WhatsApp group
 * and tapped by a field worker, an honoured one would destroy a corpus that has not been uploaded
 * yet, silently, with no confirmation step. That is why the gate exists and why production is not
 * on this list. In the app, "Erase all data" is the supported path and it asks first. */
function devResetAllowed(h) {
  // Coerce ONCE, before either check — isDevHost calls h.endsWith and would throw on a missing
  // hostname, and a throw here happens during setup(), i.e. it would take the whole boot with it.
  const host = String(h || '');
  return isDevHost(host) || /\.workers\.dev$/.test(host);
}
// Dev-only hard reset hook: ?devreset runs the same wipe on the hosts above (a no-op elsewhere,
// with a console line saying so — see setup()).
async function devReset() { return eraseAllData(); }

// Standalone "Flextext Researcher" app: wire only what the panel needs and boot straight into it
// (no editor/field UI). The shell (flextext-researcher/index.html) provides #view-researcher +
// #toast + an optional language selector. Exit/lock is handled inside the panel (deps.standalone).
function setupResearcherMode() {
  /* ⚠ The panel supplies its OWN full-bleed header, unlike every other view in main. main's
   * padding-top would therefore show as a bare strip ABOVE that header — which is what it did, and
   * what the editor does not suffer because its #topbar is a body-level flex item OUTSIDE main
   * (Seth: "our editor app already has the correct styling here"). Marking the mode on <body> is the
   * house pattern for exactly this — see `crowd-embed` — and it keeps the fix in CSS, scoped, instead
   * of a :has() selector or a second rule the editor could ever match. */
  document.body.classList.add('rp-standalone');
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
    producedBy: () => producedBy(),
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

/* v322 global playback keys (Seth #4/#8/#11).
 * - Enter must NEVER play: a focused native <button> fires click on Enter by UA default — the
 *   capture handler swallows Enter on play/rewind controls only (joins etc. keep normal button
 *   behaviour). "Only spacebar does that."
 * - Space toggles the LAST-USED player when focus is not in a field or on a button (a focused
 *   button already Space-clicks natively — double-toggling would un-toggle it).
 * - ⏮ rewinds the last-used target to ITS OWN start: a segment to its span start, the dock to 0. */
/* Companion-app links on the Utilities tab. The markup carries the production URLs as a fallback;
 * this swaps in the panel's estate map so a staging editor links the staging apps and the dev rig
 * its own. Satellite shells have no #companion-apps and get a no-op. */
function wireCompanionLinks() {
  for (const a of companionApps()) {
    const el = document.querySelector(`#companion-apps [data-app="${a.key}"]`);
    if (el && a.url) el.href = a.url;
  }
}

function wirePlaybackKeys() {
  const PLAY_BTNS = '.player-play, .player-back, .player-home, .seg-play, .gseg-play';
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest && e.target.closest(PLAY_BTNS)) { e.preventDefault(); return; }
    // Undo/redo (v323): buttons are primary; keys work when focus is not inside a text field
    // (there the browser's native typing-undo owns Ctrl+Z until the next structural re-render).
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
      const inField = e.target.closest && e.target.closest('input, textarea, [contenteditable]');
      const wantRedo = e.key === 'y' || e.key === 'Y' || e.shiftKey;
      if (!inField) {
        e.preventDefault();
        if (wantRedo) doRedo(); else doUndo();
        return;
      }
      /* HYBRID (v326): in a DIRTY field, native undo owns Ctrl+Z (undoing this session's typing).
       * In a CLEAN field -- nothing typed this session, or typed and natively undone back to the
       * start value -- the app takes over and steps prior sessions/operations. */
      if (!wantRedo && fieldUndo && e.target === fieldUndo.el && e.target.value === fieldUndo.startValue) {
        e.preventDefault();
        doUndo();
        return;
      }
    }
    /* ⚠ The gate below is also why clicking a waveform has to BLUR the focused field — see the
     * pointerdown handler right after this listener. Space-to-play deliberately stands down inside a
     * text field (a transcriber typing a space must get a space), and a canvas does not take focus
     * on click, so without that blur the click looks like it selected the audio while the keystroke
     * still went to the gloss box the user had been typing in. */
    if (e.key !== ' ' || e.repeat) return;
    // The Cut tab has its own Space (continuous play/pause) — see the cut-tab key handler. Two
    // handlers would toggle twice and cancel each other out.
    if (activeTab === 'cut' && !$('#view-cut')?.hidden) return;
    /* ⚠ NOT "any button": that blanket exemption is what jammed Space on the Baseline and Gloss
     * tabs, because focus sits on the TAB BUTTON you clicked to get there and the key was spent
     * re-activating it. transportKeysApply draws the line properly — see it for the full rule. */
    if (!transportKeysApply(e.target, e.key)) return;
    if (!player) return;
    e.preventDefault();
    if (player.playing?.()) { player.pause(); return; }
    if (lastPlayTarget && typeof lastPlayTarget.start === 'number') {
      const at = player.playheadMs?.();
      const inside = typeof at === 'number' && at > lastPlayTarget.start && at < lastPlayTarget.end - 150;
      // resume-in-span, like the buttons — but rewinding to the SEGMENT's start when it finishes
      // (v332), so replaying after a mid-segment click starts from the top of the segment.
      player.playSpan(inside ? at : lastPlayTarget.start, lastPlayTarget.end, lastPlayTarget.start);
    } else { player.clearSpan(); player.ws?.playPause?.(); }
  }, true);

  /* CLICKING A WAVEFORM RELEASES THE TEXT FIELD (Seth, 2026-08-13).
   *
   * "if you click on an audio recording waveform, the previously selected text box stays focused and
   * so it types a space instead of playing. If our user clicks on a waveform whichever textbox they
   * have focused should lose its focus. That way they can click and play right away."
   *
   * A <canvas> is not focusable, so a click on one leaves focus wherever it was — and the space
   * handler above deliberately stands down inside a text field. The result reads as a bug in
   * space-to-play when it is really a focus question: the click DID select the span (lastPlayTarget
   * is set), the keystroke just went somewhere else.
   *
   * ⚠ ONE DELEGATED LISTENER, not a blur() call added to each waveform's own pointerdown. There are
   * three waveform surfaces already (the dock player, the baseline strips, the gloss mini-waves) in
   * three different files, and the next one added would silently not get the behaviour. Capture
   * phase so it cannot be skipped by a handler that stops propagation.
   *
   * Blurring #baseline-text also fires its blur → applyBaseline(), which COMMITS the edit — the
   * correct thing to happen when the user turns from typing to listening, and the same thing the
   * existing textarea blur handler does. */
  document.addEventListener('pointerdown', (e) => {
    const el = e.target;
    if (!el || !el.closest || !el.closest('.player-wave, .seg-wave, .gseg-wave')) return;
    const active = document.activeElement;
    if (active && active.blur && active.closest && active.closest('input, textarea, [contenteditable]')) {
      active.blur();
    }
  }, true);

  const dock = $('#audio-player');
  if (dock) {
    // Any dock interaction makes the whole file the target again…
    dock.addEventListener('pointerdown', (e) => { if (!e.target.closest('.player-home')) lastPlayTarget = null; });
    // …except ⏮, which rewinds whatever the CURRENT target is.
    dock.querySelector('.player-home')?.addEventListener('click', () => {
      if (!player) return;
      if (lastPlayTarget && typeof lastPlayTarget.start === 'number') player.playSpan(lastPlayTarget.start, lastPlayTarget.end);
      else { player.clearSpan(); player.seekMs(0); }
    });
  }
  // Focus-session boundaries for text undo (segmentation editor only -- Seth's scoping).
  const UNDO_FIELDS = '.gloss-input, .free-input, .seg-text, #baseline-text';
  document.addEventListener('focusin', (e) => {
    if (!segmentationEnabled() || !current) return;
    const el = e.target.closest && e.target.closest(UNDO_FIELDS);
    if (!el) return;
    commitFieldUndo();                       // a previous session still pending? close it first
    try { fieldUndo = { el, startValue: el.value, snap: docSnap() }; } catch { fieldUndo = null; }
  });
  document.addEventListener('focusout', (e) => {
    if (fieldUndo && e.target === fieldUndo.el) { commitFieldUndo(); updateUndoButtons(); }
  });
}

function setup() {
  wirePlaybackKeys();
  wireCompanionLinks();
  $('#btn-undo')?.addEventListener('click', doUndo);
  $('#btn-redo')?.addEventListener('click', doRedo);
  // Crowd mode boots FIRST — before applyUrlSettings/migrateSettings/SW/sync can
  // touch the shared-origin storage a field worker's apps may be using on this
  // same browser profile. Everything crowd needs is fetched or in-memory.
  if (CROWD_MODE) { setupCrowdMode(); return; }
  if (new URLSearchParams(location.search).has('devreset')) {
    if (devResetAllowed(location.hostname)) { devReset(); return; }
    /* NOT allowed here, and SAYING SO is the fix (Seth, 2026-08-31, asking why ?devreset "kept the
     * pairing session and docs"): it had not kept anything — it had never run. The param was
     * silently dropped on any host outside the dev list, which reads exactly like a wipe that
     * failed. The refusal stays (a ?devreset link forwarded to a field worker must never be able
     * to destroy an un-uploaded corpus); only the silence goes. */
    console.warn('[flextext] ?devreset ignored on this host — dev, staging and preview origins only. Use "Erase all data" in the app.');
  }
  // ----- Paragraph Analysis satellite: boot the grouping app only; skip ALL field/editor wiring.
  // Registers its OWN service worker (sw.js resolves relative to /paragraph-analysis/).
  if (PARAGRAPH_MODE) {
    setupServiceWorker();
    setupBanners();   // install button + WebKit warning; the shell carries both banners
    showAppVersion();
    initParagraphApp();
    return;
  }
  // Editor-origin ?mode=researcher → hand off to the standalone Researcher app (its own install +
  // service worker). Preserve a returning #gauth fragment so an in-flight Google sign-in still
  // completes there. The standalone shell (window.__MODE='researcher') and local dev keep the
  // panel inline (RESEARCHER_MODE), so they never bounce here.
  if (!RESEARCHER_MODE && new URLSearchParams(location.search).get('mode') === 'researcher') {
    /* Hand off to the researcher app OF THIS ESTATE (Seth, 2026-08-05: the Cloudflare apps and the
     * GitHub Pages ones run in parallel). Sending a Cloudflare user to the Pages panel would put
     * their researcher account on a different origin from their editor, with its own database. */
    const cloud = /\.flextext\.app$/.test(location.hostname);
    const base = cloud ? 'https://research.flextext.app/' : 'https://rulingants.github.io/flextext-researcher/';
    location.replace(base + (location.hash || ''));
    return;
  }
  migrateSettings();
  const { settingsChanged, task } = applyUrlSettings();
  settings = loadSettings();
  applyI18n();

  // Local live-sync: when another same-origin window/app changes settings or the doc list, re-render
  // here too — no manual refresh. Registered in every mode; the handlers no-op in researcher mode.
  db.onLive((kind) => { if (kind === 'settings') applyLiveSettings(); else if (kind === 'docs') refreshLiveLists(); });

  showAppVersion();   // subtle corner version badge (all modes)

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
    /* ⚠ BEING UNLINKED IS NEWS, and the device used to swallow it. Sync clears the session on a
     * 410 and told nobody, so from the user's side the upload option simply vanished, a Save option
     * they had never seen appeared (see sendCapabilities' guard), and the queue stopped — with no
     * event on screen tying any of it together. One sentence turns three mysteries into one fact.
     * Shown long, because it changes what the person can do next. */
    onStatus: (kind) => {
      /* Every status the sync engine reports is a possible end of the pairing — 'linked' takes the
       * banner down, 'pending'/'needs-accept' keep it up. Cheap, and it means the banner cannot be
       * left behind by a path nobody thought of. */
      refreshPairBanner();
      refreshDeviceName();     // 'named' arrives when a poll first learns it, and on any rename
      /* ⚠ AND SAY SO WHEN IT FINISHES. Removing the accept-time toast (it was the bug) left the
       * successful end of a pairing with no event at all: the banner simply vanished, which reads as
       * "something went wrong" quite as easily as "you are linked". onStatus('linked') fires once,
       * on the transition, so this is the completion notice and cannot repeat every poll. */
      if (kind === 'linked') toast(t('toast.linked'), 8000);
      if (kind !== 'revoked') return;
      toast(t('sync.revokedNotice'), 10000);
      updateShareButton();     // the Send button's contents just changed — repaint it now
      renderUploadQueue();     // …and the queue is held from this moment, not failing
    },
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
  { if (Sync.pendingConsent()) showInviteConsent(); }
  /* ⚠ AND ON EVERY LOAD, not only when a status arrives. A device left overnight mid-pairing, or one
   * whose user reloaded to "make it work", must come back up still showing its code — that reload is
   * exactly what someone does when they think the app has lost their place. */
  refreshPairBanner();
  refreshDeviceName();   // a paired device knows its name from the stored session, before any poll

  // Language selector — present in both the editor and the recorder.
  const langSel = $('#lang-select');
  if (langSel) {
    langSel.value = getLang();
    langSel.addEventListener('change', () => {
      setLang(langSel.value);
      applyI18n();
      if (RECORD_MODE) { renderRecordView(); renderRecordList(); return; }
      if (CONSENT_MODE) { ccRenderList(); return; }   // a text arriving by assignment joins the list
      if (SEGMENTER_MODE) { sgRenderList(); return; }
      applyHelpResearchVisibility();
      renderDocList();
      // The Settings tab's labels are baked by t() at build time, not by data-i18n attributes, so
      // applyI18n() cannot reach them — rebuild it or it stays in the previous language.
      renderDeviceSetup();
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

  /* The consent collector and the segmenter fork HERE, at the recorder's position, and that
   * placement is the design.
   *
   * Everything above this line has already run for them: settings, i18n, live cross-window sync,
   * Sync.start, the upload retry pump, the shared modals, the service worker. Both apps need all
   * of it — the collector because a retrofitted consent record has to upload through the same
   * Lane A path as a native one, and the segmenter because segmentation results travel the same
   * way. Forking earlier (the crowd/paragraph position) would have meant reimplementing sync and
   * upload inside two more apps, which is exactly what the suite's design principle forbids. */
  if (CONSENT_MODE) {
    setupConsentMode();
    return;
  }
  if (SEGMENTER_MODE) {
    setupSegmenterMode();
    return;
  }

  fillLangPickers();

  // ----- Full editor wiring -----
  $$('#topbar-home .top-tab').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.view === 'research') { renderDeviceSetup(); show('research'); }
    else if (b.dataset.view === 'utilities') { show('utilities'); }   // static markup — nothing to build
    else { renderDocList(); show('texts'); }
  }));
  $$('#topbar-editor .top-tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  $('#btn-back').addEventListener('click', async () => {
    if (activeTab === 'baseline') applyBaseline();
    await persist();
    current = null;
    leaveEditor();   // stops audio AND the tab tickers — see the function for what leaking them cost
    renderDocList();
    show('texts');
  });

  /* ⚠ CUT-TAB KEYS ARE DOCUMENT-LEVEL, and are the ONLY key path — the rows deliberately do NOT
   * own them. This tab has no text box, so there is nothing that must hold focus for the keys to
   * work: Seth's gesture is "place the playhead and press Enter", which must work whether or not
   * the user has ever clicked a row. Two handlers would double-fire; one, keyed off the PLAYHEAD
   * rather than off focus, matches what the tab actually is.
   *
   * ⚠ BACKSPACE IS GATED ON `backspaceJoin` HERE TOO (Seth, 2026-08-13: "joins (with join buttons
   * or backspace if backspace to join is enabled)"). v356 exempted this tab on the reasoning that
   * there is no text box to Backspace inside of, so a join could not be an accident — but the
   * setting is the researcher saying "this key does not join on this device", and a key that keeps
   * joining on one tab is exactly the "rule enforced in one place the other path reaches around"
   * drift the setting itself warns about. The ⤙⤚ buttons are unaffected and remain the reliable
   * route, so nothing about joining is lost when the key is off — and the tab's hint text switches
   * to naming the button, so the screen never promises a key that does nothing. */
  document.addEventListener('keydown', (e) => {
    if (activeTab !== 'cut' || $('#view-cut')?.hidden) return;
    if (!transportKeysApply(e.target, e.key)) return;
    if (e.key === 'Enter') { e.preventDefault(); cutHere(); }
    else if (e.key === 'Backspace') { if (!joinKeysEnabled()) return; e.preventDefault(); cutJoinPrev(); }
    /* SPACE PLAYS AND PAUSES, WHEREVER FOCUS IS ON THIS TAB (Seth, 2026-08-13: "spacebar to
     * play/pause doesn't work. It should"). The global handler stands down on any BUTTON, because a
     * focused button Space-clicks itself natively and double-toggling would undo it — and here focus
     * is almost always on a button: the Cut tab button that got you here, a row's ▶, a ⤙⤚ join.
     *
     * ⚠ preventDefault is what makes owning it safe: it suppresses the native button activation, so
     * there is exactly one toggle — and, more importantly, Space can never re-fire a DESTRUCTIVE
     * button. Focus sits on ✂ or ⤙⤚ the instant after you use one, and a native re-click there
     * would cut or join again with no gesture from the user. wirePlaybackKeys' Space branch defers
     * to this (it runs first, in capture). */
    else if (e.key === ' ' && !e.repeat) { e.preventDefault(); cutTogglePlay(); }
  });
  /* ── ENTER ON THE BASELINE TAB, WITH FOCUS OUTSIDE THE TEXT BOXES ────────────────────────────
   * Seth, 2026-08-14: "if the segment audio is active, pressing enter splits at the playhead and
   * splits the text at the end of the baseline (rather than wherever the cursor was last). If the
   * text box is focused, pressing enter splits wherever the playhead is (on the current segment) as
   * it does now."
   *
   * So this is the OTHER half of a gesture the tab already had. Inside a text box the caret decides
   * where the words divide (that handler is in segment-strips' onKey and is untouched). Outside one
   * — after clicking a line's ▶ to listen — there is no caret to consult, and the honest answer is
   * that none of the words move: the line keeps them all and the new line starts empty. That turns
   * transcribe-then-align into listen-and-chop without ever touching the text.
   *
   * ⚠ transportKeysApply ALREADY STANDS DOWN INSIDE A TEXT FIELD, which is exactly the division of
   * labour this needs: the two Enters can never both fire, and neither can steal Enter from a modal
   * or from Save/Back in the topbar. See it for the whole rule.
   *
   * ⚠ NOT ON THE GLOSS TAB. Its boxes are word glosses and free translations; breaking a LINE there
   * would re-shape the very rows being glossed, which is what the Cut and Baseline tabs are for. */
  document.addEventListener('keydown', (e) => {
    if (activeTab !== 'baseline' || $('#view-baseline')?.hidden) return;
    if (!segmentationEnabled()) return;          // classic textarea mode owns its own Enter
    if (e.key !== 'Enter' || e.repeat) return;
    if (!transportKeysApply(e.target, e.key)) return;   // a focused text box keeps Enter — see onKey
    e.preventDefault();                          // …and a focused ▶ must not ALSO re-fire
    stripSplitAtPlayhead();
  });
  $('#btn-guess-splits')?.addEventListener('click', () => cutGuessSplits());
  /* ℹ folds the Cut tab's instructions away on a phone. The button is display:none above 560px, so
   * this listener is inert there and the hint is simply visible — the CSS decides who needs it, not
   * a width read in JS that would then be wrong after a rotation. `is-open` is likewise harmless on
   * a wide screen, where the hint shows regardless. */
  $('#btn-cut-hint')?.addEventListener('click', (e) => {
    const hint = $('#cut-hint');
    if (!hint) return;
    const open = hint.classList.toggle('is-open');
    e.currentTarget.setAttribute('aria-expanded', open ? 'true' : 'false');
    /* The label follows the state, so a screen reader is not told "how this tab works" by a button
     * whose only remaining job is to put it away again. */
    e.currentTarget.dataset.i18nAria = open ? 'cut.hintHide' : 'cut.hintToggle';
    e.currentTarget.dataset.i18nTitle = open ? 'cut.hintHide' : 'cut.hintToggle';
    e.currentTarget.setAttribute('aria-label', t(e.currentTarget.dataset.i18nAria));
    e.currentTarget.title = t(e.currentTarget.dataset.i18nTitle);
  });
  /* ⚠ A HARD REFRESH: ask the service worker to look for a new engine, THEN reload. A plain reload
   * can serve the same cached version indefinitely — update() is the half that makes it a
   * ctrl+shift+r rather than a soft one. The editor's upload queue is persisted in IndexedDB and
   * resumes after a restart, so unlike the panel there is no transfer to lose here; the button is
   * on the HOME bar only, so there is never an open text either. */
  $('#btn-refresh')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (b) { b.classList.add('rp-spin'); b.disabled = true; }
    /* ⚠ COMMIT WHAT IS ON SCREEN BEFORE RELOADING (Seth, 2026-09-01: "make sure unfocus and save
     * changes fires before reload… if there's a risk of the current edit not getting saved").
     * The home bar is shared by the Settings and Utilities tabs, which have real input fields, so
     * "no text is open" does NOT mean "nothing is unsaved". Blur first — that is what fires the
     * change handlers a field's value depends on — then flush the DEBOUNCED save rather than
     * waiting for its timer, which the reload would otherwise cut off. This is the same loss the
     * auto-update banner is already filed for; there is no reason to reproduce it in a button. */
    try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch { /* noop */ }
    try { clearTimeout(saveTimer); await persist(); } catch { /* nothing open, or save failed — reload anyway */ }
    try { const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update(); }
    catch { /* no worker, or update refused — reload anyway */ }
    finally { location.reload(); }
  });
  $('#btn-help-home').addEventListener('click', openHelp);
  $('#btn-help-editor').addEventListener('click', openHelp);
  $('#btn-help-close').addEventListener('click', closeHelp);

  $('#doc-title').addEventListener('input', schedulePersist);
  $('#btn-new').addEventListener('click', () => newDoc());
  $('#btn-new-audio').addEventListener('click', () => $('#new-audio-file').click());
  $('#btn-new-pair')?.addEventListener('click', () => $('#new-pair-file').click());
  $('#new-pair-file')?.addEventListener('change', (e) => {
    const fs = [...e.target.files];
    e.target.value = '';
    if (fs.length) newDocFromPair(fs).catch((err) => toast(t('toast.importFailed', { msg: err.message }), 6000));
  });
  $('#btn-record').addEventListener('click', startConsentThenRecord);
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
    producedBy: () => producedBy(),
    onSignedUp: () => { const b = $('#btn-researcher'); if (b) b.hidden = !researcherPanelApi.isSignedUp(); },
    /* No onLocalSettingsSaved any more: the panel's "This device" settings modal is gone (Seth,
     * 2026-08-07). A researcher's own device is UNPAIRED, so it already has this app's Settings tab
     * — which does the same job standalone and, unlike the modal, actually worked. */
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
  exportXml() { return serializeFlextext(current.doc, settings, { segTimes: segmentationEnabled(), producedBy: producedBy() }); },
  applyBaseline,
};
// Dev-only queue inspection hooks — never exposed on the production host.
// syncDispatch is exposed here so the device-side command handlers (notably the changeSettings
// REMOTE_FORBIDDEN guard) can be exercised in a real browser: the full E2EE push is untestable on
// the hermetic local rig (no Google, no seeded Kr), and the poll path won't dispatch without a
// delivered Ki, so a dev console is the only way to drive the real handler + its toast + i18n.
// See DEVELOPERS.md → "Console entry points".
if (isDevHost(location.hostname)) {
  Object.assign(window.__app, { uploadView, renderUploadQueue, allowedButtons, uploadDocById, buildBundleFor, syncDispatch });
}
