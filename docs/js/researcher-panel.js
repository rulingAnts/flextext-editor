/* researcher-panel.js — the researcher control panel (a SEPARATE full-screen view).
 *
 * The visual layer over js/researcher.js (the verified E2EE engine). Field workers
 * never see this: it has no entry point on a device that hasn't signed up, and it
 * lives in its own #view-researcher takeover (its own header, both app topbars hidden).
 *
 * Flow: signup (Turnstile) / restore → set/enter passphrase (→ Kr, in memory only) →
 * dashboard (devices, approve+deliver-key, decrypted inventory, invite links, per-device
 * tabbed settings). All crypto + network is in researcher.js; this file is UI only.
 *
 * Decoupled like sync.js: app.js calls initResearcherPanel(deps) with injected helpers
 * (workerBase, toast, loadSettings/saveSettings, parseDriveFolder, openView, goHome, …).
 */

import * as Researcher from './researcher.js';
import { t, getLang, setLang, applyI18n, ENGINE_VERSION } from './i18n.js';
import { REC_FORMATS, DEFAULT_REC_FORMAT } from './record-pcm.js';
import { importPublicKeyB64, publicKeyFingerprint } from './crypto.js';
import { esc, parseFlextext, surveyWritingSystems, remapWritingSystems } from './flextext.js';
import { probeAudioUrl, fetchFileViaUrl } from './audio.js';
import { convertAudio, detectFormat, readWavHeader, validOutputs } from './convert.js';
import WaveSurfer from './vendor/wavesurfer.esm.js';
import * as db from './db.js';
import { observeView, recordEvents, loadHistory, clearHistory, assignedEvent, driveLink, driveIdFrom, recordingSince, HISTORY_KINDS } from './history.js';
import { makeZip } from './zip.js';
import { resolveArtifacts, emptyReason } from './artifacts.js';

// Byte-size formatter for assign-validation verdicts (mirrors app.js sizeFmt; that one is not exported).
const fmtSize = (b) => (b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1) + ' MB');

let deps = null;
let root = null;
let dashPoll = null;   // dashboard auto-refresh interval (runs only while the dashboard shows)
let liveTick = 0;      // counts dashboard polls, to re-fetch the LIVE-version banner periodically (not every tick)
let lastSig = null;    // signature of the last-rendered view, to skip no-op re-renders
let reconnectTimer = null; // auto-retry timer for the "reconnecting" screen (network blip during bootstrap)
let lastData = null;   // last dashboard view, kept so an action (e.g. upload) can re-render instantly w/o a refetch
// Researcher-side upload-request tracking: docId -> { prevFileId, requestedAt, doneAt }. Lets the panel show
// "request sent → uploaded just now" with NO server state: a (re)upload writes a new timestamped Drive file,
// so when the device later reports a DIFFERENT uploadedFileId we know THIS request completed — even a re-send
// of an otherwise-unchanged doc (uploadState stays 'uploaded'). Swept in renderDashboard; resets on reload.
// Where the native (Android/Windows/Mac) builds can be downloaded. EMPTY until they are
// actually published — the notice then says "in preparation" rather than offering a dead link.
const NATIVE_DOWNLOADS_URL = '';

/* PENDING COMMANDS — docId -> { seq, kind:'upload'|'delete', instanceId, prevFileId, at }.
 *
 * ⚠ REPLACES TWO EXPIRING TIMERS, AND THAT IS THE POINT. The old markers faded after 2 and 10
 * minutes, so a request the device simply had not polled for yet became indistinguishable from one
 * that was never made: the strikethrough vanished while the command was still queued server-side,
 * and the text was still there. Seth hit exactly that. A clock was never the right signal —
 * `install.ack_seq` is, because it says whether the device has actually SEEN the command.
 *
 * Persisted, because these are real outstanding requests: closing the panel must not lose track of
 * a delete that is still queued.
 *
 * ⚠ THE STATE IS DERIVED FROM ack_seq, NEVER FROM ELAPSED TIME:
 *   seq >  maxAck  → queued, the device has not seen it → CANCELLABLE
 *   seq <= maxAck  → the device has it → in progress, NOT cancellable
 * The second case must never offer a cancel. Letting a researcher "cancel" a delete that already
 * happened would leave the panel claiming a text the device no longer has — and for an upload, that
 * it was never sent when it was. The Worker refuses it too (409 already_delivered); the UI simply
 * must not ask for something the server will rightly reject.
 */
/* In-flight MOVES — docId -> { from, to, title, at, stage:'assigned'|'removing' }. Persisted like
 * pendingCmds; advanced by the sweep in renderDashboard on every poll:
 *   'assigned'  → destination reports the doc in its inventory → fire the upload-first remove at
 *                 the source (stage 'removing'). AUTOMATIC by Seth's decision.
 *   'removing'  → the doc is gone from the source's inventory → the move is complete.
 * Both signals are the same inventory facts the rest of the panel already trusts. */
const MOVES_KEY = 'flextext-rp-moves:';
let pendingMoves = new Map();
function loadMoves(accountId) {
  try { pendingMoves = new Map(JSON.parse(localStorage.getItem(MOVES_KEY + (accountId || 'anon')) || '[]')); }
  catch { pendingMoves = new Map(); }
}
function saveMoves(accountId) {
  try { localStorage.setItem(MOVES_KEY + (accountId || 'anon'), JSON.stringify([...pendingMoves])); }
  catch { /* degrade to in-memory */ }
}

const PENDING_KEY = 'flextext-rp-pending:';
let pendingCmds = new Map();
function loadPending(accountId) {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_KEY + (accountId || 'anon')) || '[]');
    pendingCmds = new Map(Array.isArray(raw) ? raw : []);
  } catch { pendingCmds = new Map(); }
}
function savePending(accountId) {
  try { localStorage.setItem(PENDING_KEY + (accountId || 'anon'), JSON.stringify([...pendingCmds])); }
  catch { /* quota/private mode — the markers degrade to in-memory only */ }
}

/* COLLAPSED DEVICE CARDS — instanceId -> true (collapsed) | false (expanded). Same per-account
 * localStorage shape as PENDING_KEY above.
 *
 * ⚠ ONLY AN EXPLICIT CHOICE IS STORED. A card the researcher has never touched has no entry and
 * falls back to collapsedByDefault() — one device expands (there is nothing to scan past), several
 * collapse (the dashboard becomes a list again). Writing the default in at first render would
 * freeze whatever the device count happened to be that day.
 */
const COLLAPSE_KEY = 'flextext-rp-collapsed:';
let collapsedCards = new Map();
function loadCollapsed(accountId) {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY + (accountId || 'anon')) || '[]');
    collapsedCards = new Map(Array.isArray(raw) ? raw : []);
  } catch { collapsedCards = new Map(); }
}
function saveCollapsed(accountId) {
  try { localStorage.setItem(COLLAPSE_KEY + (accountId || 'anon'), JSON.stringify([...collapsedCards])); }
  catch { /* quota/private mode — the choice degrades to in-memory only */ }
}
/* Is this card collapsed right now? PURE, and exported for the test: the state is DERIVED on every
 * render (never carried in the DOM), which is what makes it survive the 12s poll — the rebuilt card
 * comes back in the same state it was in, so there is nothing to animate and nothing to flicker. */
export function isCardCollapsed(stored, instanceId, deviceCount) {
  const v = stored instanceof Map ? stored.get(instanceId) : (stored ? stored[instanceId] : undefined);
  return (v === undefined || v === null) ? deviceCount > 1 : !!v;
}

/* ⚠ TWO ESTATES RUN IN PARALLEL (Seth, 2026-08-05): the Cloudflare apps are production for NEW
 * installs, while existing GitHub Pages installs keep working and keep syncing. So an invite link
 * cannot be built from `location.origin` + a Pages sub-path any more.
 *
 * On a Cloudflare-hosted panel that would produce https://research.flextext.app/flextext-editor/ —
 * a path that EXISTS (build.sh copies the engine there as asset storage) but is NOT the editor
 * app. Opening it would install a third, bogus PWA at that scope, on the wrong origin, with its
 * own empty database. Hence an explicit map rather than string concatenation.
 *
 * Both estates stay addressable: a researcher adding a SECOND device for someone already on Pages
 * needs the legacy link, or that person ends up with two installs and half their work in each. */
const ESTATES = {
  cloud: {
    editor: 'https://app.flextext.app/',
    recorder: 'https://record.flextext.app/',
    crowd: 'https://crowd.flextext.app/',
    researcher: 'https://research.flextext.app/',
  },
  pages: {
    editor: 'https://rulingants.github.io/flextext-editor/',
    recorder: 'https://rulingants.github.io/text-recorder/',
    crowd: 'https://rulingants.github.io/crowd-recorder/',
    researcher: 'https://rulingants.github.io/flextext-researcher/',
  },
};

// Which estate is THIS panel part of? On localhost the dev rig serves both apps under the Pages
// sub-paths, so it keeps using same-origin links and never points a developer at production.
export function estateOf(origin = location.origin) {
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) {
    return { editor: origin + '/flextext-editor/', recorder: origin + '/text-recorder/',
             crowd: origin + '/crowd-recorder/', researcher: origin + '/flextext-researcher/', local: true };
  }
  return /\.flextext\.app$/.test(new URL(origin).hostname) ? ESTATES.cloud : ESTATES.pages;
}

const HOME = estateOf();

/* DEPRECATION NOTICE — the legacy GitHub Pages panel only (Seth, 2026-08-05).
 *
 * ⚠ Matched on the EXACT hostname, not on `HOME === ESTATES.pages`. estateOf() returns the pages
 * map for anything that is not *.flextext.app or localhost, which includes the *.workers.dev
 * STAGING previews — and staging is the dev site, not a deprecated address. An estate-based test
 * would have nagged every preview build.
 *
 * Researcher-panel only, deliberately: a researcher's account, coworkers and texts live server-side
 * in D1, so re-installing costs them nothing. The FIELD apps are the opposite — their texts and
 * audio are in per-origin IndexedDB, and telling a field worker to reinstall before they upload
 * would destroy work. Do not copy this banner into the editor or recorder. */
const LEGACY_PANEL_HOST = 'rulingants.github.io';
const onLegacyHost = () => location.hostname === LEGACY_PANEL_HOST;
// Page-load scoped on purpose: no storage, so it returns next launch. A deprecation notice that can
// be dismissed forever stops being a deprecation notice; one that cannot be dismissed at all is a
// permanent tax on every screen of the panel.
let deprecationDismissed = false;
function deprecationBanner() {
  if (!onLegacyHost() || deprecationDismissed) return '';
  return `<div class="warn-banner rp-deprecated">
    <span>${esc(t('panel.deprecated.msg'))}
      <a href="${ESTATES.cloud.researcher}" target="_blank" rel="noopener">${esc(t('panel.deprecated.link'))}</a></span>
    <button class="banner-dismiss" data-act="deprecated-dismiss" aria-label="${esc(t('panel.deprecated.dismiss'))}" title="${esc(t('panel.deprecated.dismiss'))}">&times;</button>
  </div>`;
}

/* ⚠ EVERY LINK COMES FROM THE RECORD'S ESTATE, never from where the panel happens to be running
 * (Seth, 2026-08-05: a legacy crowd recorder shown from the Cloudflare panel produced
 * https://research.flextext.app/crowd-recorder/?c=… — a 404, because the satellites are not copied
 * to that origin. The editor invite was worse: it returned 200 and a working editor, being the
 * engine asset copy, so claiming it would have installed a THIRD PWA on the wrong origin with its
 * own empty database and looked entirely fine).
 *
 * `estate` is stamped on the row by the worker — 'pages' for everything that existed before the
 * migration, 'cloud' for everything created since. So an old coworker keeps their old links for
 * good, and a new one gets Cloudflare, with nothing asked of the researcher.
 *
 * On localhost the dev rig wins regardless: a developer must never be handed production links. */
function basesFor(estate) {
  if (HOME.local) return HOME;
  return estate === 'pages' ? ESTATES.pages : ESTATES.cloud;
}
// A record with no estate at all is pre-migration data seen by a newer client: treat it as legacy,
// which is what it is. Never default an UNKNOWN record to 'cloud' — that invents a migration.
const estateOfRecord = (rec) => (rec && rec.estate) || 'pages';
// Approx capture bytes/sec per format (mono 48 kHz worst-case) — MIRRORS the
// worker's CROWD_BPS: the submit cap is estimate×1.5+overhead, platform-clamped
// at ~95 MB (a public submission is one POST). The live estimate below keeps the
// researcher honest about what their format + max-length choice produces.
const CROWD_BPS = { mp3: 8000, opus: 6000, webmpcm: 187500, wav16: 96000, wav24: 144000, wav32: 192000, flac24: 110000 };
function crowdEstimate(fmt, secs) { return (CROWD_BPS[fmt] || 8000) * secs; }
function fmtDur(secs) { const m = Math.floor(secs / 60), ss = secs % 60; return ss ? `${m} min ${ss} s` : `${m} min`; }

// Crowd recorders live OUTSIDE the 12s poll signature (worker load stays flat): fetched on full
// dashboard renders + after crowd actions only. undefined = not yet fetched, null = fetch failed.
let crowdCache;

const REC_KEYS = Object.keys(REC_FORMATS);
const AGC_OPTS = ['off', 'on', 'auto'];
const CONSENT_MODES = ['off', 'text', 'audio'];
const CONSENT_RESP = ['yesno', 'record', 'signature'];
const BTN_OPTS = ['new', 'audio', 'record', 'open'];
const SEND_OPTS = ['share', 'upload', 'save', 'download'];

/* The 5 settings groups (canonical field ids; local↔device key mapping handled in
 * fillForm/readForm). This is the reusable settings-form component. */
const GROUPS = [
  { id: 'languages', legend: 'panel.legend.languages', helpModal: 'wscodes', fields: [
    // Interface language pushed to THIS device (setting D). deviceOnly → hidden in the researcher's own
    // local-settings modal (where the live #lang-select toggle already covers it).
    { k: 'appLang', type: 'select', opts: ['follow', 'en', 'id'], optPrefix: 'panel.opt.appLang.', deviceOnly: true, outside: true },   // sits ABOVE the codes fieldset
    // Codes ONLY (2026-07-13): the name/font fields are gone — names were display
    // sugar, fonts device cosmetics; neither belongs in the FLEx export. tip =
    // hover tooltip (fieldHtml) warning that FLEx codes are case-sensitive.
    { k: 'vernLang', type: 'text', tip: 'research.wsCase' },
    { k: 'analLang', type: 'text', tip: 'research.wsCase' },
  ] },
  { id: 'recording', helpModal: 'recfmt', notice: 'pwaAudio', fields: [
    { k: 'recordFormat', type: 'select', opts: REC_KEYS, optPrefix: 'panel.opt.fmt.' },  // the permanent recording format
    { k: 'maxRecordSeconds', type: 'range' },   // auto-stop cap (0 = no limit) + live size readout
    { k: 'agc', type: 'select', opts: AGC_OPTS, optPrefix: 'panel.opt.agc.' },
    { k: 'nr', type: 'checkbox' }, { k: 'echo', type: 'checkbox' }, { k: 'norm', type: 'checkbox' },
    // One-tap archive-grade capture: 24-bit WAV with EVERY processing stage off
    // (AGC/NR/echo/normalization are prohibited on preservation masters).
    { k: 'archivalDefaults', type: 'action' },
  ] },
  { id: 'consent', fields: [
    // Consent is multi-select: any combination of prompts + confirmations, all required together.
    { k: 'consentAsk', type: 'multicheck', opts: ['text', 'audio'], optPrefix: 'panel.opt.ask.' },
    { k: 'consentMsg', type: 'textarea' },
    { k: 'consentAudioUrl', type: 'text', note: 'panel.f.consentAudioNote' },
    { k: 'consentConfirm', type: 'multicheck', opts: ['yesno', 'record', 'signature'], optPrefix: 'panel.opt.conf.' },
  ] },
  { id: 'sending', fields: [
    { k: 'sendOptions', type: 'multicheck', opts: SEND_OPTS, optPrefix: 'panel.opt.send.' },
    { k: 'autoDel', type: 'checkbox' },
    // Auto-backup: a text changed since its last upload is auto-uploaded once it's been quiet for
    // autoBackupMins (device engine feature; each backup is a NEW timestamped Drive copy).
    { k: 'autoBackup', type: 'checkbox' },
    { k: 'autoBackupMins', type: 'select', opts: ['5', '15', '30', '60'], optPrefix: 'panel.opt.abm.' },
    { k: 'recordWelcome', type: 'text' },
  ] },
  { id: 'buttons', fields: [
    { k: 'buttons', type: 'multicheck', opts: BTN_OPTS, optPrefix: 'panel.opt.btn.' },
    // Let the coworker fully wipe THIS device (Delete All). Off by default for managed devices; standalone
    // apps always have it. deviceOnly → not shown in the researcher's own local-settings modal.
    { k: 'deleteAllEnabled', type: 'checkbox', deviceOnly: true },
    // Let the coworker delete individual texts. Default ON (absent = allowed) so existing
    // devices keep the delete button until the researcher deliberately turns it off.
    { k: 'allowDelete', type: 'checkbox' },
    // Show the coworker an optional "Done" button on each text; marking done auto-uploads
    // and surfaces a "done" badge to the researcher. Off by default.
    { k: 'doneEnabled', type: 'checkbox' },
    // Audio Segmentation Mode: the Baseline/Gloss tabs become time-aligned waveform strips with
    // per-line playback and Enter-at-playhead line breaks. Default OFF — the classic textarea
    // workflow is untouched unless the researcher deliberately enables it; the note tells them to
    // trial it with one worker first. Turning it off later hides the UI but never deletes segments.
    { k: 'segmentation', type: 'checkbox', note: 'panel.f.segmentationNote' },
    // Which annotation exports ride the bundles (Seth, 2026-08-03): each is researcher-selectable;
    // an UNSET value follows the mode (basic editor → flextext only; segmentation → all three on).
    // toFormValues prefils these with the EFFECTIVE value so the checkboxes never lie about what
    // the device actually exports. All require real time alignment on the text to apply at all.
    { k: 'exportEaf', type: 'checkbox' },
    { k: 'exportSaymore', type: 'checkbox' },
    { k: 'exportPreview', type: 'checkbox' },
    // .fxpa: the Paragraph Analysis app's interchange (JSON + embedded audio inside a
    // proprietary extension). Local saves only — never uploads (bandwidth).
    { k: 'exportJson', type: 'checkbox', note: 'panel.f.exportsNote' },
  ] },
];

export function initResearcherPanel(d) {
  deps = d;
  root = d.root;
  Researcher.init({ workerBase: deps.workerBase });
  // Language selector lives in the panel's OWN header (every screen, both homes).
  // Delegated once: setLang persists (shared LANG_KEY, same as the apps' toggles),
  // applyI18n repaints the shell's static bits, and route() rebuilds the whole
  // panel so every t() string — dashboard, modals opened later, settings forms —
  // is consistently in the chosen language.
  root.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'rp-lang') {
      setLang(e.target.value);
      applyI18n();
      route();
    }
  });
  // Install button (parity with the editor/recorder apps): the top install banner is
  // hidden behind the panel's full-screen takeover, so it lives in the panel header.
  root.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('#rp-install');
    if (b) { b.remove(); if (deps.doInstall) deps.doInstall(); }
  });
  // Delegated: the banner is re-rendered by every screen, so a per-render listener would leak.
  root.addEventListener('click', (e) => {
    const d = e.target.closest && e.target.closest('[data-act="deprecated-dismiss"]');
    if (!d) return;
    deprecationDismissed = true;
    const b = d.closest('.rp-deprecated');
    if (b) b.remove();
  });
  // Returning to a backgrounded tab → refresh the dashboard + the LIVE-version banner right away rather
  // than waiting for the next poll tick (only fires while the dashboard is actively polling).
  document.addEventListener('visibilitychange', () => { if (!document.hidden && dashPoll) { refreshLiveVersions(); pollDashboard(); } });
  // Regained connectivity → recover immediately instead of waiting for the next timer: refresh the
  // dashboard if it's up, otherwise re-attempt sign-in/bootstrap (drives the reconnecting screen).
  window.addEventListener('online', () => { if (!root || root.hidden) return; if (dashPoll) { refreshLiveVersions(); pollDashboard(); } else route(); });
  return { open, close, isSignedUp: () => Researcher.isSignedUp(), onInstallable };
}

// app.js calls this when a deferred install prompt arrives (which may be after the
// header already rendered) — inject the Install button into the current header if
// it isn't already there. header() also renders it up-front when the prompt exists.
function onInstallable() {
  const head = root && root.querySelector('.rp-head');
  if (!head || head.querySelector('#rp-install')) return;
  const btn = document.createElement('button');
  btn.className = 'secondary-btn rp-install';
  btn.id = 'rp-install';
  btn.textContent = t('install.btn');
  head.insertBefore(btn, head.querySelector('#rp-lang') || head.querySelector('.rp-helpbtn') || null);
}

function open() { deps.openView('researcher'); route(); }
function close() { stopDashPoll(); deps.goHome(); }

async function route() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // Returning from Google? Consume #gauth=<id>.<token>, then strip it from the address bar.
  if (Researcher.consumeGauth()) { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* noop */ } }
  if (!Researcher.isSignedUp()) return renderSignIn();
  // Account-switch guard: a DIFFERENT account signed in on a browser that still holds the PREVIOUS
  // account's offline data (docs / enrollment) → block until that data is erased. Offline data is
  // origin-scoped, not account-scoped, so it would otherwise be inherited. Explicit + reversible.
  { const cur = Researcher.currentAccountId(), last = Researcher.lastAccountId();
    if (last && cur && cur !== last && await hasInheritableData()) return renderAccountSwitch(); }
  if (!Researcher.isUnlocked()) {
    renderConnecting();
    try { await Researcher.bootstrap(); }
    catch (e) {
      // 401 = the session is genuinely invalid → sign out. Any OTHER failure (network/timeout/5xx —
      // the field hits these constantly) must NOT sign the researcher out: show "reconnecting" and
      // keep retrying, so a blip never drops them back to the sign-in screen.
      if (e && e.status === 401) { Researcher.purgeLocal(); return renderSignIn(t('panel.signin.expired')); }   // session gone/deleted → wipe researcher-console local data
      return renderReconnecting();
    }
  }
  if (!Researcher.isApprovedSelf()) return renderAwaiting();   // signed in but pending → awaiting-approval screen
  renderDashboard();
}

// Sign-in screen: one "Sign in with Google" button (replaces the email+password + 2FA screens).
function renderSignIn(note) {
  stopDashPoll();
  root.innerHTML = header('panel.title', false) + `
    <div class="rp-body rp-narrow"><div class="rp-card rp-signin">
      <h2>${esc(t('panel.signin.title'))}</h2>
      <p class="note">${esc(t('panel.signin.intro'))}</p>
      ${note ? `<p class="banner warn-banner">${esc(note)}</p>` : ''}
      <button class="primary-btn" data-act="google">${esc(t('panel.signin.btn'))}</button>
      <label class="check-label rp-stay"><input type="checkbox" id="rp-stay"${Researcher.staySignedIn() ? ' checked' : ''}> ${esc(t('panel.account.stay'))}</label>
    </div></div>`;
  const stayBox = root.querySelector('#rp-stay');
  if (stayBox) stayBox.addEventListener('change', () => Researcher.setStaySignedIn(stayBox.checked));
  wireActs({ google: () => { location.href = Researcher.googleSignInUrl(); }, exit: close });
}

function renderConnecting() {
  stopDashPoll();
  root.innerHTML = header('panel.title', false) + `
    <div class="rp-body rp-narrow"><div class="rp-card rp-signin"><p class="note">${esc(t('panel.signin.connecting'))}</p></div></div>`;
  wireActs({ exit: close });
}

// Network blip during bootstrap → never sign the researcher out. Show we're retrying, auto-retry on a
// timer (and the `online` listener re-routes the moment connectivity returns). route() recovers to the
// dashboard as soon as bootstrap succeeds; the session is never dropped on a transient failure.
function renderReconnecting() {
  stopDashPoll();
  root.innerHTML = header('panel.title', false) + `
    <div class="rp-body rp-narrow"><div class="rp-card rp-signin">
      <h2>${esc(t('panel.conn.title'))}</h2>
      <p class="banner warn-banner">${esc(t('panel.conn.offline'))}</p>
      <button class="primary-btn" data-act="retry">${esc(t('panel.conn.retry'))}</button>
      <button class="link-btn" data-act="signout">${esc(t('panel.account.signout'))}</button>
    </div></div>`;
  wireActs({ retry: () => route(), signout: () => { Researcher.signOut(); route(); }, exit: close });
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => route(), 8000);
}

// Pending researcher: signed in via Google, but an owner hasn't approved this account yet. They
// can re-check (re-bootstrap) or sign out. No dashboard until approved.
function renderAwaiting() {
  stopDashPoll();
  root.innerHTML = header('panel.title', false) + `
    <div class="rp-body rp-narrow"><div class="rp-card rp-signin">
      <h2>${esc(t('panel.await.title'))}</h2>
      <p class="note">${esc(t('panel.await.intro', { email: Researcher.accountEmail() || '' }))}</p>
      <button class="primary-btn" data-act="recheck">${esc(t('panel.await.recheck'))}</button>
      <button class="link-btn" data-act="signout">${esc(t('panel.account.signout'))}</button>
    </div></div>`;
  wireActs({
    recheck: (btn) => busy(btn, async () => { try { await Researcher.bootstrap(); } catch { /* stay pending */ } route(); }),
    signout: () => { Researcher.signOut(); route(); },
    exit: close,
  });
}

// Cheap probe: does this browser hold offline data a different account would inherit? A field
// enrollment (sync-session) or any locally-authored docs both qualify. A fresh researcher-only
// browser has neither → no gate.
async function hasInheritableData() {
  try { if (localStorage.getItem('flextext-sync-session')) return true; } catch { /* noop */ }
  try { if ((await db.listDocs()).length) return true; } catch { /* noop */ }
  return false;
}

// A different account signed in on a browser that still holds the previous account's data. Block with
// a clear choice: erase this device's data and continue (full local wipe → reload → fresh sign-in), or
// cancel (drop the just-signed-in session; the old data stays intact for whoever owns it). Never silent.
function renderAccountSwitch() {
  stopDashPoll();
  root.innerHTML = header('panel.title', false) + `
    <div class="rp-body rp-narrow"><div class="rp-card rp-signin">
      <h2>${esc(t('panel.acctswitch.title'))}</h2>
      <p class="note">${esc(t('panel.acctswitch.intro', { email: Researcher.accountEmail() || '' }))}</p>
      <p class="banner warn-banner">${esc(t('panel.acctswitch.warn'))}</p>
      <button class="primary-btn rp-danger" data-act="erase">${esc(t('panel.acctswitch.erase'))}</button>
      <button class="link-btn" data-act="cancel">${esc(t('panel.acctswitch.cancel'))}</button>
    </div></div>`;
  wireActs({
    erase: (btn) => busy(btn, async () => { try { await deps.eraseAllData(); } catch (e) { errToast(e); } }),
    cancel: () => { Researcher.signOut(); route(); },   // drop the new session; old data stays for its owner
    exit: close,
  });
}

/* ---------------- small DOM helpers ---------------- */

function header(titleKey, withLock) {
  // Standalone Researcher app: no editor to go "back" to, so drop the exit arrow
  // (the dashboard Lock button is the way out — it signs out → sign-in screen).
  const exitBtn = deps && deps.standalone ? ''
    : `<button class="icon-btn rp-exit" data-act="exit" title="${esc(t('panel.exit'))}">&#8592;</button>`;
  return deprecationBanner() + `<div class="rp-head">
    ${exitBtn}
    <span class="rp-title">${esc(t(titleKey))}</span>
    <span class="rp-spacer"></span>
    ${deps && deps.canInstall && deps.canInstall() ? `<button class="secondary-btn rp-install" id="rp-install">${esc(t('install.btn'))}</button>` : ''}
    <select id="rp-lang" title="${esc(t('research.lang'))}">
      <option value="en"${getLang() === 'en' ? ' selected' : ''}>English</option>
      <option value="id"${getLang() === 'id' ? ' selected' : ''}>Indonesia</option>
    </select>
    <button class="icon-btn rp-helpbtn" data-act="help" title="${esc(t('panel.help.btn'))}" aria-label="${esc(t('panel.help.btn'))}">?</button>
    ${withLock ? `<button class="secondary-btn rp-lock" data-act="lock">${esc(t('panel.lock'))}</button>` : ''}
  </div>`;
}

function wire(sel, ev, fn) { const el = root.querySelector(sel); if (el) el.addEventListener(ev, fn); }
function wireActs(handlers) {
  root.querySelectorAll('[data-act]').forEach((el) => {
    let fn = handlers[el.dataset.act];
    if (!fn && el.dataset.act === 'help') fn = showPanelHelp;   // the header help button is universal
    if (fn) el.addEventListener('click', () => fn(el));
  });
}

// Researcher documentation (incl. the honest Security section) — lives HERE in the panel,
// not in the field app's help. The help.html string is trusted static i18n markup.
function showPanelHelp() {
  const m = modal(`<div class="rp-help">${t('panel.help.html')}</div>
    <button class="primary-btn" data-m="close">${esc(t('panel.help.close'))}</button>`, true);
  m.el.querySelector('[data-m="close"]').onclick = m.close;
}
async function busy(btn, fn) {
  if (!btn) return fn();
  const old = btn.textContent; btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}
function errToast(e) { deps.toast(t('panel.err', { msg: (e && e.message) || String(e) }), 6000); }

/* a body-level overlay modal: closes on backdrop click or Escape, moves focus in,
 * traps Tab, and restores focus on close. Returns { el, close }. */
function modal(innerHtml, wide, onClose) {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<div class="modal-card${wide ? ' help-modal' : ''}" role="dialog" aria-modal="true">${innerHtml}</div>`;
  document.body.appendChild(wrap);
  const prevFocus = document.activeElement;
  const focusables = () => Array.from(wrap.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'));
  // onClose fires on EVERY close path (button, backdrop, Escape) — callers use it to release resources
  // (e.g. destroy WaveSurfer players + revoke object URLs in the converter).
  const close = () => { document.removeEventListener('keydown', onKey, true); wrap.remove(); try { onClose && onClose(); } catch { /* noop */ } try { prevFocus && prevFocus.focus(); } catch { /* noop */ } };
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {                       // simple focus trap
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  setTimeout(() => { const f = focusables()[0]; if (f) { try { f.focus(); } catch { /* noop */ } } }, 0);
  return { el: wrap, close };
}

/* ---------------- dashboard ---------------- */

function fmtFp(hex) { return (hex || '').replace(/(.{4})/g, '$1 ').trim(); }
async function fpOf(pubkeyB64) {
  try { return fmtFp(await publicKeyFingerprint(await importPublicKeyB64(pubkeyB64))); } catch { return '—'; }
}
function lastSeen(ts) {
  if (!ts) return t('panel.inst.never');
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return t('panel.inst.now');
  if (mins < 60) return t('panel.inst.minsAgo', { n: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return t('panel.inst.hrsAgo', { n: hrs });
  return t('panel.inst.daysAgo', { n: Math.round(hrs / 24) });
}

// Auto-refresh: a researcher with no refresh button (and possibly several windows
// open) shouldn't have to reload to see a device claim an invite or report back.
// While the dashboard shows, poll the worker and silently re-render ONLY when the
// meaningful state changed — never while a dialog is open (don't yank the DOM), and
// never on heartbeat-only churn (last_seen excluded from the signature).
function stopDashPoll() { if (dashPoll) { clearInterval(dashPoll); dashPoll = null; } }
function startDashPoll() { if (!dashPoll) dashPoll = setInterval(pollDashboard, 12000); }

// Stable signature of what the tiles actually show — excludes volatile fields
// (last_seen_at / ack_seq / *_rev) so a device heartbeat doesn't force a re-render.
function viewSig(data) {
  try {
    return JSON.stringify([
      (data.instances || []).map((it) => [
        it.instance_id, it.nickname, it.type,
        (it.installs || []).map((ins) => [
          ins.install_id, ins.status, ins.accepted, ins.has_key, ins.wipe_state,   // wipe_state → re-render on wipe pending/confirmed
          ins.inventory && ins.inventory.ua, ins.inventory && JSON.stringify(ins.inventory.cachedApps),  // re-render when the device's browser/app version changes
          ins.inventory && ins.inventory.engineVersion,  // re-render when the true running engine version changes (brick/stale signal)
          ins.inventory && Array.isArray(ins.inventory.items)
            // uploadedFileId IS part of the signature: a re-send of an unchanged doc keeps uploadState
            // 'uploaded' but mints a new file id, and that's our only signal the re-upload landed.
            ? ins.inventory.items.map((d) => [d.id, d.title, d.uploadState, d.hasAudio, d.uploadedFileId, d.done, d.pendingDelete])
            .concat([[ins.inventory.platform || '']])
            : null,
        ]),
      ]),
      (data.pending || []).map((p) => [p.researcher_id, p.email]),   // owner: re-render when a request lands
    ]);
  } catch { return String(Math.random()); } // unserializable → treat as changed
}

async function pollDashboard() {
  if (!root || root.hidden || !Researcher.isUnlocked()) { stopDashPoll(); return; } // left the dashboard
  if (document.hidden || document.querySelector('.modal')) return;                   // backgrounded / dialog open
  if (liveTick++ % 10 === 0) refreshLiveVersions();                                  // refresh the LIVE-version banner ~every 2 min (12s×10), in place
  let data;
  try { data = await Researcher.listView(); } catch { return; }                      // transient; next tick retries
  if (root.hidden || document.querySelector('.modal')) return;                       // re-check after the await
  if (viewSig(data) !== lastSig) renderDashboard(data);
}

// Parse a reported userAgent into a short "Browser NN · OS" for the device tiles. The UA is
// attacker-controllable (a seized field device), but this only pulls a browser name + digits + a fixed OS
// label, and the result is esc()'d at every call site — no raw UA reaches the DOM.
function parseUA(ua) {
  if (!ua || typeof ua !== 'string') return '';
  let b = 'browser', m;
  if ((m = ua.match(/Firefox\/(\d+)/))) b = 'Firefox ' + m[1];
  else if ((m = ua.match(/Edg\/(\d+)/))) b = 'Edge ' + m[1];
  else if ((m = ua.match(/OPR\/(\d+)/))) b = 'Opera ' + m[1];
  else if ((m = ua.match(/Chrome\/(\d+)/))) b = 'Chrome ' + m[1];
  else if (/Safari/.test(ua) && (m = ua.match(/Version\/(\d+)/))) b = 'Safari ' + m[1];
  let os = '';
  if ((m = ua.match(/Android (\d+)/))) os = 'Android ' + m[1];
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod|iOS/.test(ua)) os = 'iOS';
  else if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'Mac';
  else if (/Linux/.test(ua)) os = 'Linux';
  return os ? b + ' · ' + os : b;
}
// One tile's device line + a staleness verdict. The PRIMARY version is the TRUE running engine
// (engineVersion, reported from inside the running code) — NOT the cache name, which a stale-body
// precache can make lie (the Firefox-Utilities bug). cachedApps' recorder/researcher shell versions
// ride along as secondary detail. stale = the running engine is BEHIND the live site, or the client is
// so old it reports no engineVersion at all (both mean "this device needs to update / may be stuck").
// All values are attacker-controllable (a seized device) → esc'd at every call site.
// Each shell is a SEPARATE storage sandbox (own IndexedDB, own enrollment) even when several load
// the same URL — so the same person on a PWA and an APK is legitimately two devices here. Showing
// the platform first is what makes that comprehensible instead of looking like a duplicate.
const PLATFORM_KEY = {
  'web': 'panel.dev.platWeb',
  'android-recorder': 'panel.dev.platAndroidRec',
  'android-editor': 'panel.dev.platAndroidEd',
  'windows': 'panel.dev.platWindows',
};

/* CONFIRMED staleness — do not cry wolf on every release.
 *
 * A device is briefly "behind" after every deploy: service workers update on the next load, so an
 * instant warning would fire for every install after every push and train the researcher to ignore
 * the badge — which is worse than having no badge, because it burns the one signal that a genuinely
 * bricked device would raise.
 *
 * So a mismatch must be confirmed across TWO DISTINCT REPORTS separated by STALE_CONFIRM_MS. The
 * separation is measured on the DEVICE's report timestamps, not on wall clock, or simply leaving the
 * panel open for six hours would "confirm" staleness from a single report.
 *
 * The timer resets if the device's engine version CHANGES while still behind: a device that is
 * moving is lagging, not stuck, and only stuck is worth an alarm.
 *
 * Clears itself the moment a device reports the current version.
 *
 * 6h: propagation is minutes (editor Pages ~30s, satellites ~90s), so this is generous padding,
 * while still surfacing a genuinely stuck device inside a day. Watch state lives in this
 * researcher's own localStorage; losing it only restarts the timer.
 */
const STALE_CONFIRM_MS = 6 * 60 * 60 * 1000;
const STALE_WATCH_KEY = 'flextext-rp-stale-watch';

function staleWatchRead() {
  try { return JSON.parse(localStorage.getItem(STALE_WATCH_KEY) || '{}') || {}; }
  catch { return {}; }
}
function staleWatchWrite(w) {
  try { localStorage.setItem(STALE_WATCH_KEY, JSON.stringify(w)); } catch { /* quota — non-critical */ }
}

/** @returns true only when this install has been behind across two reports >= STALE_CONFIRM_MS apart.
 *  Exported ONLY so the test suite can drive this function itself rather than a copy of its logic —
 *  a copied test passes while the real path is broken. Not part of the panel's public surface. */
export function staleConfirmed(installId, reportedAt, behind, runningVer) {
  const w = staleWatchRead();
  if (!installId) return behind;                 // nothing to track by — fail toward showing it
  if (!behind) {                                 // resolved: drop the record so the badge disappears
    if (w[installId]) { delete w[installId]; staleWatchWrite(w); }
    return false;
  }
  const ts = Date.parse(reportedAt) || Number(reportedAt) || Date.now();
  const e = w[installId];
  if (!e || e.ver !== runningVer) {              // first sighting, or it moved — (re)start the clock
    w[installId] = { first: ts, last: ts, ver: runningVer };
    staleWatchWrite(w);
    return false;
  }
  if (ts > e.last) { e.last = ts; staleWatchWrite(w); }
  return (e.last - e.first) >= STALE_CONFIRM_MS;
}

function deviceInfo(ua, cachedApps, engineVersion, platform, installId, reportedAt) {
  const segs = [];
  const pk = PLATFORM_KEY[platform];
  if (pk) segs.push(t(pk));
  else if (platform) segs.push(platform);          // unknown native shell — show it raw, don't hide it
  const b = parseUA(ua); if (b) segs.push(b);
  const eng = engineVersion || (cachedApps && cachedApps.editor);   // true running engine, or cache-name fallback
  if (eng) segs.push(t('panel.dev.engine', { v: eng }));
  if (cachedApps && typeof cachedApps === 'object') {
    if (cachedApps.recorder) segs.push('recorder ' + cachedApps.recorder);
    if (cachedApps.researcher) segs.push('researcher ' + cachedApps.researcher);
  }
  const live = liveVersions && liveVersions.editor;
  let stale = false;
  if (!engineVersion && !(cachedApps && cachedApps.editor)) stale = true;        // pre-feature client → definitely old
  else if (live && eng && eng !== live) stale = true;                            // running engine behind the live site
  // Confirm across two reports before alarming (see STALE_CONFIRM_MS). A client so old it reports no
  // version at all is NOT put through the timer: that is not a propagation delay, it is a client from
  // before the field existed, and it is already definitively behind.
  const known = !!(engineVersion || (cachedApps && cachedApps.editor));
  const confirmed = known ? staleConfirmed(installId, reportedAt, stale, eng) : stale;
  return { text: segs.join(' · '), stale: confirmed, behindNow: stale, running: eng, live };
}
// This panel's OWN cached apps (same parse as the field client's listCachedApps), for the This-device tile.
async function panelCachedApps() {
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

// LIVE (cache-busted) versions currently deployed on the site — the reference the researcher compares
// devices against (a device reporting an OLDER version, or stale + not reporting, may be stuck/bricked).
// null = the site is unreachable (researcher offline). The ?live= query forces a SW cache miss → network.
let liveVersions = undefined;  // undefined = not yet checked
async function fetchLiveVersion(path) {
  try {
    const r = await fetch(path + '?live=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return null;
    const m = (await r.text()).match(/const VERSION = '([^']+)'/);
    return m ? m[1] : null;
  } catch { return null; }
}
async function refreshLiveVersions() {
  // The panel reports on ITS OWN estate — mixing the two would show a version nobody is running.
  const [editor, recorder, researcher] = await Promise.all([
    fetchLiveVersion(HOME.editor + 'sw.js'),
    fetchLiveVersion(HOME.recorder + 'sw.js'),
    fetchLiveVersion(HOME.researcher + 'sw.js'),
  ]);
  liveVersions = (editor == null && recorder == null && researcher == null) ? null : { editor, recorder, researcher };
  paintLiveVersions();
}
function liveVerText() {
  if (liveVersions === undefined) return t('panel.live.checking');
  if (liveVersions === null) return t('panel.live.offline');
  const p = [];
  if (liveVersions.editor) p.push('editor ' + liveVersions.editor);
  if (liveVersions.recorder) p.push('recorder ' + liveVersions.recorder);
  if (liveVersions.researcher) p.push('researcher ' + liveVersions.researcher);
  return t('panel.live.latest', { v: p.join(' · ') });
}
function paintLiveVersions() {
  const el = root && root.querySelector('#rp-live-ver');
  if (!el) return;
  el.textContent = liveVerText();   // versions come from our OWN site's sw.js (not attacker data); textContent regardless
  el.className = 'rp-live' + (liveVersions === null ? ' rp-live-offline' : '');
}

async function renderDashboard(prefetched) {
  if (!prefetched) {
    root.innerHTML = header('panel.title', true) + `<div class="rp-body"><p class="note">${esc(t('panel.dash.loading'))}</p></div>`;
    wireActs({ exit: close, lock: () => { Researcher.signOut(); route(); } });
  }
  let data = prefetched;
  if (!data) {
    try { data = await Researcher.listView(); }
    catch (e) {
      if (e && e.status === 401) { Researcher.purgeLocal(); return renderSignIn(t('panel.signin.expired')); }   // session gone/deleted → wipe researcher-console local data
      // Transient: keep the poll running (it recovers on the next good tick) and show "reconnecting"
      // instead of a dead error screen — a field network drop must not strand the dashboard.
      startDashPoll();
      root.querySelector('.rp-body').innerHTML = `<p class="banner warn-banner">${esc(t('panel.conn.reconnecting'))}</p><button class="secondary-btn" data-act="retry">${esc(t('panel.dash.retry'))}</button>`;
      wire('[data-act="retry"]', 'click', () => renderDashboard());
      return;
    }
  }

  lastData = data;   // cache for an instant local re-render after an action (no refetch)
  const insts = data.instances || [];
  loadPending(Researcher.currentAccountId());
  loadMoves(Researcher.currentAccountId());
  // Advance in-flight moves on every poll (a stage transition is visible in exactly one report —
  // same reasoning as the History observer): destination reports the doc → fire the upload-first
  // remove at the source (AUTOMATIC, Seth's decision); source no longer reports it → move done.
  {
    let dirty = false;
    for (const [docId, mv] of pendingMoves) {
      if (mv.stage === 'assigned' && findInventoryItem(mv.to, docId)) {
        try {
          const r1 = await Researcher.uploadDelete(mv.from, docId);
          pendingCmds.set(docId, { seq: r1.seq, kind: 'delete', instanceId: mv.from, at: Date.now() });
          savePending(Researcher.currentAccountId());
          mv.stage = 'removing'; dirty = true;
        } catch { /* transient — retried next poll */ }
      } else if (mv.stage === 'removing' && !findInventoryItem(mv.from, docId)) {
        pendingMoves.delete(docId); dirty = true;
        deps.toast(t('panel.move.done', { title: mv.title || '?' }), 6000);
      }
    }
    if (dirty) saveMoves(Researcher.currentAccountId());
  }
  loadCollapsed(Researcher.currentAccountId());
  // Retire pending markers on OUTCOME, never on a clock. A request stays visible for as long as it
  // is genuinely outstanding — which is the whole correction: the old timers made a still-queued
  // delete look forgotten while the command was alive on the server.
  {
    const live = new Map();                                   // docId -> its current inventory item
    for (const it of insts) for (const ins of it.installs || []) {
      const items = ins.inventory && Array.isArray(ins.inventory.items) ? ins.inventory.items : [];
      for (const d of items) if (d && d.id) live.set(d.id, d);
    }
    let changed = false;
    for (const [docId, p] of pendingCmds) {
      const d = live.get(docId);
      // A delete is done when the text is gone from every inventory. An upload is done when the
      // device reports a NEW file id — the same signal the History log uses.
      const done = p.kind === 'delete'
        ? (d === undefined && ackOf(insts, p.instanceId) >= p.seq)
        : !!(d && d.uploadedFileId && d.uploadedFileId !== p.prevFileId);
      if (done) { pendingCmds.delete(docId); changed = true; }
    }
    if (changed) savePending(Researcher.currentAccountId());
  }
  // HISTORY: observe BEFORE rendering, and on every poll — not only on full renders. A text can be
  // assigned, uploaded and deleted between two full renders, and the deletion is only visible as
  // the one report where it goes present→absent. Miss that report and the tombstone is lost for
  // good. observeView never throws and diffs a repeated report to nothing, so calling it on the
  // 12s tick is both safe and necessary.
  observeView(Researcher.currentAccountId(), insts);
  rebuildAssignedCache();   // after observeView, so an assignment made this tick is already in it
  let pending = 0, texts = 0;
  for (const it of insts) for (const ins of it.installs || []) {
    if (ins.status === 'pending') pending++;
    if (ins.inventory && Array.isArray(ins.inventory.items)) texts += ins.inventory.items.length;
  }
  const localDocs = await db.listDocs().catch(() => []);
  const myDevice = deviceInfo(navigator.userAgent, await panelCachedApps(), ENGINE_VERSION);

  // Crowd recorders ride FULL renders only (initial load / manual refresh / post-action), never the
  // 12s poll (worker load stays flat; viewSig excludes them). A fetch failure paints a reconnect
  // note inside the card — the rest of the dashboard must never be taken down by it.
  if (!prefetched && Researcher.isApprovedSelf()) {
    try { crowdCache = (await Researcher.crowdList()).recorders || []; } catch { crowdCache = null; }
  }

  // deviceCount passed explicitly (not taken from map's array arg): it decides the collapse default.
  const cards = await Promise.all(insts.map((it) => renderInstanceCard(it, insts.length)));
  root.querySelector('.rp-body').innerHTML = `
    <div id="rp-live-ver" class="rp-live${liveVersions === null ? ' rp-live-offline' : ''}">${esc(liveVerText())}</div>
    <div class="rp-metrics">
      <div class="rp-metric"><div class="rp-metric-l">${esc(t('panel.dash.devices'))}</div><div class="rp-metric-n">${insts.length}</div></div>
      <div class="rp-metric"><div class="rp-metric-l">${esc(t('panel.dash.pending'))}</div><div class="rp-metric-n${pending ? ' rp-warn' : ''}">${pending}</div></div>
      <div class="rp-metric"><div class="rp-metric-l">${esc(t('panel.dash.texts'))}</div><div class="rp-metric-n">${texts}</div></div>
    </div>
    <div class="rp-actions">
      <button class="primary-btn" data-act="new">${esc(t('panel.dash.newDevice'))}</button>
      <button class="secondary-btn" data-act="refresh">${esc(t('panel.dash.refresh'))}</button>
      <span class="rp-spacer"></span>
      ${data.isOwner ? `<button class="link-btn rp-admin-btn" data-act="admin">${esc(t('panel.admin.btn'))}</button>` : ''}
      <button class="link-btn" data-act="history">${esc(t('panel.hist.btn'))}</button>
      <button class="link-btn" data-act="utilities">${esc(t('panel.util.btn'))}</button>
      <button class="link-btn" data-act="account">${esc(t('panel.dash.account'))}</button>
    </div>
    ${(data.isOwner && (data.pending || []).length) ? `
    <div class="rp-card rp-pending-res">
      <div class="rp-inst-name">${esc(t('panel.pending.title', { n: data.pending.length }))}</div>
      <p class="note">${esc(t('panel.pending.intro'))}</p>
      ${data.pending.map((p) => `<div class="rp-install">
        <div class="invite-who">${p.avatar_url ? `<img class="invite-avatar" src="${esc(p.avatar_url)}" alt="" referrerpolicy="no-referrer" width="40" height="40">` : ''}<div><div class="invite-name">${esc(p.display_name || p.email || '?')}</div>${p.email ? `<div class="note">${esc(p.email)}</div>` : ''}</div></div>
        <div class="rp-inst-actions">
          <button class="primary-btn" data-ract="approve" data-rid="${esc(p.researcher_id)}">${esc(t('panel.pending.approve'))}</button>
          <button class="link-btn rp-revoke" data-ract="decline" data-rid="${esc(p.researcher_id)}">${esc(t('panel.pending.decline'))}</button>
        </div>
      </div>`).join('')}
    </div>` : ''}
    <div class="rp-card rp-self">
      <div class="rp-inst-top">
        <span class="rp-inst-name">${esc(t('panel.dash.thisDevice'))} <span class="rp-badge rp-badge-you">${esc(t('panel.dash.you'))}</span></span>
        <button class="secondary-btn" data-act="self-settings">${esc(t('panel.inst.settings'))}</button>
      </div>
      <p class="note">${esc(t('panel.dash.thisDeviceNote', { n: localDocs.length }))}</p>
      ${myDevice.text ? `<div class="note rp-devinfo${myDevice.stale ? ' rp-devinfo-stale' : ''}">${esc(myDevice.text)}${myDevice.stale ? ` <span class="rp-badge rp-badge-stale">${esc(t('panel.dev.stale'))}</span>` : ''}</div>` : ''}
    </div>
    ${insts.length ? cards.join('') : `<p class="note rp-empty">${esc(t('panel.dash.empty'))}</p>`}
    ${Researcher.isApprovedSelf() ? renderCrowdCard(crowdCache) : ''}`;

  wireActs({
    exit: close,
    lock: () => { Researcher.signOut(); route(); },
    new: () => newDeviceModal(),
    refresh: () => renderDashboard(),
    admin: () => adminModal(),
    history: () => historyModal(),
    utilities: () => utilitiesModal(),
    account: () => accountModal(),
    'self-settings': () => openSettingsModal({ kind: 'local' }),
  });
  // per-card actions are delegated:
  wireDownloadMenus();
  root.querySelectorAll('[data-iact]').forEach((el) => el.addEventListener('click', () => instanceAction(el)));
  root.querySelectorAll('[data-ract]').forEach((el) => el.addEventListener('click', () => researcherAction(el)));
  root.querySelectorAll('[data-cact]').forEach((el) => el.addEventListener('click', () => crowdAction(el)));
  lastSig = viewSig(data);
  startDashPoll();
  // Refresh the LIVE-version tip on a full render (initial load / manual refresh), not on every poll tick.
  if (!prefetched) refreshLiveVersions();
}

// Owner: approve / decline a pending researcher request (request/approve onboarding).
async function researcherAction(el) {
  const id = el.dataset.rid, act = el.dataset.ract;
  try {
    if (act === 'approve') {
      await busy(el, () => Researcher.approveResearcher(id));
      deps.toast(t('panel.pending.approved'), 4000);
      renderDashboard();
    } else if (act === 'decline') {
      if (!confirm(t('panel.pending.confirmDecline'))) return;
      await busy(el, () => Researcher.declineResearcher(id));
      renderDashboard();
    }
  } catch (e) { errToast(e); }
}

/* Downloads dropdown: opens on hover AND on click (Seth asked for both).
 *
 * Hover alone is not enough — it does not exist on the touch devices a researcher may be using, and
 * it is unreachable by keyboard. Click alone loses the quick glance. So: hover opens it on
 * pointers that actually have hover, click toggles it everywhere, Escape and any outside click
 * close it, and only ONE menu is ever open (two overlapping menus would be unreadable).
 *
 * Closing on mouseleave is deliberately DELAYED — a menu that vanishes while the pointer crosses
 * the few pixels between the button and the menu is the classic dropdown failure, and it makes the
 * links effectively unclickable. */
let openDl = null;
let dlCloseTimer = null;
function closeDlMenu() {
  if (dlCloseTimer) { clearTimeout(dlCloseTimer); dlCloseTimer = null; }
  if (!openDl) return;
  openDl.querySelector('.rp-dl-menu').hidden = true;
  openDl.querySelector('.rp-dl-btn').setAttribute('aria-expanded', 'false');
  openDl.classList.remove('is-open');
  openDl = null;
}
function openDlMenu(wrap) {
  if (openDl === wrap) { if (dlCloseTimer) { clearTimeout(dlCloseTimer); dlCloseTimer = null; } return; }
  closeDlMenu();
  wrap.querySelector('.rp-dl-menu').hidden = false;
  wrap.querySelector('.rp-dl-btn').setAttribute('aria-expanded', 'true');
  wrap.classList.add('is-open');
  openDl = wrap;
}
/* The Files ▾ control, renderable ANYWHERE a text appears (device rows, History entries). The menu
 * body is a placeholder that populates from the text's Drive FOLDER on first open — the folder is
 * the source of truth for what artifacts exist, so History entries show the same live menu the
 * device row does instead of a snapshot frozen at event time. */
function filesMenuHtml(instanceId, docId, title, audioUrl, fileId) {
  if (!docId) return '';
  const au = /^https?:\/\//i.test(String(audioUrl || '')) ? audioUrl : '';
  return `<span class="rp-dl" data-fmenu data-i="${esc(instanceId)}" data-id="${esc(docId)}" data-title="${esc(title || '')}" data-audio="${esc(au)}" data-fileid="${esc(fileId || '')}">
    <button class="link-btn rp-dl-btn" aria-haspopup="true" aria-expanded="false">${esc(t('panel.dl.btn'))} <span class="rp-dl-caret" aria-hidden="true">▾</span></button>
    <span class="rp-dl-menu" hidden role="menu"><span class="rp-dl-head">${esc(t('panel.dl.title'))}</span>
      <span class="note rp-dl-loading">${esc(t('panel.dl.loading'))}</span></span></span>`;
}

// Newest file per KIND (classified by extension), so the menu never shows the backup-copy pileup.
// The folder listing arrives newest-first, so "first seen wins" IS "most recent per kind".
const EXT_KIND = [
  [/\.saymore\.eaf$/i, 'eaf-saymore'], [/\.eaf$/i, 'eaf-flex'], [/\.flextext$/i, 'flextext'],
  [/\.zip$/i, 'bundle'], [/derived[^.]*\.wav$/i, 'wav-derived'],
  [/\.(wav|mp3|opus|ogg|webm|flac|m4a|aac)$/i, 'audio'],
];
function latestPerKind(files) {
  const seen = new Set(); const out = [];
  for (const f of files || []) {
    const kind = f.role === 'assigned-audio' ? 'audio-original'
      : (EXT_KIND.find(([re]) => re.test(f.name || '')) || [null, 'other'])[1];
    const key = kind === 'other' ? 'other:' + f.name : kind;   // unknown kinds keep every distinct name
    if (seen.has(key)) continue;
    seen.add(key); out.push({ ...f, kind });
  }
  return out;
}

/* LEGACY IDENTITY BRIDGE. Until v137 the device DISCARDED the assign id and minted its own doc
 * id, so every assigned text has TWO identities: the panel's (history "Assigned" row, audio cache,
 * assign-copy folder) and the device's (inventory, uploads — in a SECOND Drive folder). New
 * assigns share one id, but every existing text stays split forever, so the menu bridges the halves
 * through the history log: events with the SAME TITLE name the sibling ids. Exact-title match is
 * imperfect (a retitled text will not bridge) — acceptable for a display menu, and only legacy
 * texts ever need it. */
function bridgedIds(docId, title) {
  const ids = new Set([docId]);
  const audio = [];
  const fileIds = [];
  try {
    const want = String(title || '').trim();
    for (const e of loadHistory(Researcher.currentAccountId())) {
      const same = e.docId === docId || (want && String(e.title || '').trim() === want);
      if (!same) continue;
      if (e.docId) ids.add(e.docId);
      if (/^https?:\/\//i.test(e.audioUrl || '')) audio.push(e.audioUrl);
      if (e.fileId) fileIds.push({ fileId: e.fileId, at: e.at || 0 });
    }
  } catch { /* the bridge is best-effort; the primary id still renders */ }
  fileIds.sort((a, b) => b.at - a.at);
  return { ids: [...ids], audioUrl: audio[0] || '', latestEventFileId: (fileIds[0] || {}).fileId || '' };
}

/* Build ONE menu from ALL sources, merged by kind — never either/or.
 *
 * ⚠ WHY MERGED (Seth, after two rounds of non-uniform menus): the sources cover DIFFERENT files,
 * not the same files at different freshness. The Drive folder has what was uploaded since v134;
 * the report's uploadedFileId covers pre-folder uploads; the cached/event audio URL covers
 * assignments whose audio was never copied. Treating them as fallbacks meant every menu showed
 * whichever single source happened to be non-empty — audio-only on Assigned history rows,
 * flextext-only on device rows. The rule is: every kind appears once, from the BEST source that
 * has it. Folder files win their kind; the cached audio link fills 'audio-original' only when the
 * folder has no copy (the if-and-only-if rule); report artifacts fill kinds nothing else claimed;
 * a history event's own fileId is the last resort for texts deleted from every inventory. */
/* What cleanup is allowed to remove: every file NOT selected by latestPerKind (i.e. the older
 * backup copies), EXCEPT anything tagged as the original assigned audio — the original is never a
 * "backup copy" however old it is. PURE and lifted by test/text-folder-files.test.mjs. */
function cleanupCandidates(allFiles) {
  const keep = new Set(latestPerKind(allFiles).map((f) => f.id));
  return (allFiles || []).filter((f) => !keep.has(f.id) && f.role !== 'assigned-audio');
}

async function populateFilesMenu(wrap) {
  if (wrap.dataset.loaded) return;
  wrap.dataset.loaded = '1';
  const menu = wrap.querySelector('.rp-dl-menu');
  const iid = wrap.dataset.i, docId = wrap.dataset.id, title = wrap.dataset.title || 'text';
  const bridge = bridgedIds(docId, wrap.dataset.title);
  const assigned = bridge.ids.map(assignedFor).find(Boolean) || assignedFor(docId);
  // Query EVERY bridged identity's folder (legacy texts have two), merge, newest wins per kind.
  // ⚠ Collect per-promise, then flatten. The first version concatenated onto a SHARED variable
  // inside Promise.all — a lost-update race where the last resolver's stale read silently dropped
  // the other folder's files, and WHICH half survived depended on resolution order. Caught by the
  // bridge fixture returning complementary menus per direction.
  const lists = await Promise.all(bridge.ids.map(async (id) => {
    try { return (await Researcher.listTextFiles(iid, id)).files || []; }
    catch { return []; /* one folder failing must not empty the menu */ }
  }));
  const allFiles = lists.flat().sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  wrap._allFiles = allFiles;                 // the entire-folder ZIP wants EVERYTHING, uncollapsed
  const files = latestPerKind(allFiles);

  const claimed = new Set(files.map((f) => f.kind));
  const audioRows = [], fileRows = [], tailRows = [];
  const KIND_LABEL = { 'audio-original': 'panel.dl.audio', 'audio': 'panel.dl.audioUpload',
    'flextext': 'panel.dl.flextext', 'bundle': 'panel.dl.bundle',
    'eaf-flex': 'panel.dl.eafFlex', 'eaf-saymore': 'panel.dl.eafSaymore', 'wav-derived': 'panel.dl.wavDerived' };

  // 1. Folder files — the authoritative source for every kind they cover. The original-audio copy
  //    sorts to the top so the menu always leads with the recording.
  for (const f of files) {
    const label = f.kind === 'other' ? f.name : t(KIND_LABEL[f.kind]);
    const row = `<a class="rp-dl-item" role="menuitem" data-drivefile="${esc(f.id)}" data-fname="${esc(f.name)}" href="#">
      <span class="rp-dl-name">${esc(label)}</span><span class="rp-dl-sub">${esc(f.name)}${f.size ? ' · ' + esc(fmtSize(f.size)) : ''}</span></a>`;
    (f.kind === 'audio-original' ? audioRows : fileRows).push(row);
  }

  // 2. The cached audio link — if and only if the folder holds no copy. Sources in order: this
  //    row's own event (data-audio; a history entry recorded before the assigned-events cache
  //    existed still knows its audio), then the cache.
  if (!claimed.has('audio-original')) {
    const cached = wrap.dataset.audio || (assigned && assigned.audioUrl) || bridge.audioUrl || '';
    if (/^https?:\/\//i.test(cached)) {
      claimed.add('audio-original');
      const gid = driveIdFrom(cached);
      audioRows.push(`<a class="rp-dl-item" role="menuitem" href="${esc(gid ? driveLink(gid) : cached)}" target="_blank" rel="noopener noreferrer">
        <span class="rp-dl-name">${esc(t('panel.dl.audio'))}</span><span class="rp-dl-sub">${esc(t('panel.dl.audioSub'))}</span></a>`);
    }
  }

  // 3. Report artifacts (uploadedFileId et al) fill any kind nothing above claimed — this is what
  //    keeps pre-folder uploads visible next to folder-era files instead of instead of them.
  //    resolveArtifacts' 'audio' kind IS the cached assigned link, already handled above — skip it.
  const item = bridge.ids.map((id) => findInventoryItem(iid, id)).find(Boolean);
  for (const f of resolveArtifacts(item, null)) {
    if (f.kind === 'audio' || claimed.has(f.kind)) continue;
    claimed.add(f.kind);
    fileRows.push(`<a class="rp-dl-item" role="menuitem" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">
      <span class="rp-dl-name">${esc(t(f.labelKey))}</span><span class="rp-dl-sub">${esc(t(f.labelKey + 'Sub'))}</span></a>`);
  }

  // 4. A history event's own fileId — the last resort for a text deleted from every inventory,
  //    where findInventoryItem has nothing. Generic label, because the event does not record which
  //    kind the upload was.
  const lastFileId = wrap.dataset.fileid || bridge.latestEventFileId;
  if (lastFileId && !claimed.has('flextext') && !claimed.has('bundle')) {
    const gid = driveLink(lastFileId);
    if (gid) fileRows.push(`<a class="rp-dl-item" role="menuitem" href="${esc(gid)}" target="_blank" rel="noopener noreferrer">
      <span class="rp-dl-name">${esc(t('panel.hist.uploadLink'))}</span><span class="rp-dl-sub">${esc(t('panel.dl.lastUploadSub'))}</span></a>`);
  }

  if (allFiles.length) {
    // ONE zip control (Seth): it takes the ENTIRE folder — every file across every bridged
    // identity, backups included. The list above stays newest-per-kind; the zip does not.
    tailRows.push(`<button class="rp-dl-item rp-dl-all" data-zipall data-i="${esc(iid)}" data-id="${esc(docId)}" data-title="${esc(title)}">
      <span class="rp-dl-name">${esc(t('panel.dl.all'))}</span><span class="rp-dl-sub">${esc(t('panel.dl.allSub', { n: allFiles.length }))}</span></button>`);
    // Cleanup: only the older backup copies (never the newest of any kind, never the original
    // audio), always to TRASH — recoverable for 30 days. The menu computes the exact set so the
    // confirm can honestly say how many.
    const dead = cleanupCandidates(allFiles);
    if (dead.length) {
      wrap._cleanupIds = dead.map((f) => f.id);
      tailRows.push(`<button class="rp-dl-item rp-dl-all rp-dl-clean" data-cleanup data-n="${dead.length}">
        <span class="rp-dl-name">${esc(t('panel.dl.cleanup'))}</span><span class="rp-dl-sub">${esc(t('panel.dl.cleanupSub', { n: dead.length }))}</span></button>`);
    }
  }
  const rows = [...audioRows, ...fileRows, ...tailRows];
  menu.innerHTML = `<span class="rp-dl-head">${esc(t('panel.dl.title'))}</span>`
    + (rows.length ? rows.join('') : `<span class="note rp-dl-loading">${esc(t('panel.dl.noneYet'))}</span>`);
}

// The current inventory item for a doc, for the static fallback path.
function findInventoryItem(instanceId, docId) {
  for (const it of (lastData && lastData.instances) || []) {
    if (it.instance_id !== instanceId) continue;
    for (const ins of it.installs || []) {
      const items = ins.inventory && Array.isArray(ins.inventory.items) ? ins.inventory.items : [];
      const d = items.find((x) => x && x.id === docId);
      if (d) return d;
    }
  }
  return null;
}

/* Download-everything-as-one-ZIP: every byte routes through the Worker with the RESEARCHER'S own
 * token and connection — this control must never exist on a field device. Built client-side because
 * Drive has no "folder as zip" URL. */
async function downloadAllZip(btn) {
  const iid = btn.dataset.i, docId = btn.dataset.id;
  const title = (btn.dataset.title || 'text').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
  const nameEl = btn.querySelector('.rp-dl-name');
  const orig = nameEl.textContent;
  try {
    btn.disabled = true; nameEl.textContent = t('panel.dl.zipBuilding');
    // Re-list across every bridged identity (legacy texts have two folders — see bridgedIds).
    const bridge = bridgedIds(docId, btn.dataset.title);
    const lists = await Promise.all(bridge.ids.map(async (id) => {
      try { return (await Researcher.listTextFiles(iid, id)).files || []; } catch { return []; /* partial is fine */ }
    }));
    const all = lists.flat().sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
    const wanted = all;   // the ENTIRE folder — every bridged identity, backups included
    const entries = [];
    const used = new Set();
    for (const f of wanted) {
      // Backup copies share names across time; a zip needs unique entry names.
      let name = f.name || 'file'; let n = 1;
      while (used.has(name)) name = (f.name || 'file').replace(/(\.[^.]*)?$/, ` (${++n})$1`);
      used.add(name);
      entries.push({ name, data: await Researcher.fetchDriveFile(f.id) });
    }
    if (!entries.length) throw new Error('empty');
    const blob = await makeZip(entries);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = title + '.zip';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    nameEl.textContent = orig;
  } catch { nameEl.textContent = t('panel.dl.zipFailed'); }
  finally { btn.disabled = false; }
}

function wireDownloadMenus(scope) {
  const hoverable = window.matchMedia && window.matchMedia('(hover: hover)').matches;
  (scope || root).querySelectorAll('.rp-dl').forEach((wrap) => {
    wrap.querySelector('.rp-dl-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (openDl === wrap) closeDlMenu(); else { openDlMenu(wrap); populateFilesMenu(wrap); }
    });
    if (hoverable) {
      wrap.addEventListener('mouseenter', () => { openDlMenu(wrap); populateFilesMenu(wrap); });
      wrap.addEventListener('mouseleave', () => {
        if (dlCloseTimer) clearTimeout(dlCloseTimer);
        dlCloseTimer = setTimeout(closeDlMenu, 350);   // survive the gap between button and menu
      });
    }
  });
  if (!wireDownloadMenus.global) {   // document listeners attach ONCE, not per render
    wireDownloadMenus.global = true;
    document.addEventListener('click', (e) => {
      const z = e.target.closest && e.target.closest('[data-zipall]');
      if (z) { e.preventDefault(); e.stopPropagation(); downloadAllZip(z); return; }
      const cl = e.target.closest && e.target.closest('[data-cleanup]');
      if (cl) {
        e.preventDefault(); e.stopPropagation();
        const wrap2 = cl.closest('.rp-dl');
        const ids = (wrap2 && wrap2._cleanupIds) || [];
        if (!ids.length) return;
        if (!confirm(t('panel.dl.cleanupConfirm', { n: ids.length }))) return;
        Researcher.trashFiles(ids, 'backup cleanup').then((r) => {
          deps.toast(t('panel.dl.cleanupDone', { n: r.trashed }), 6000);
          if (wrap2) { wrap2.dataset.loaded = ''; populateFilesMenu(wrap2); }   // menu refreshes to the post-cleanup truth
        }).catch(() => deps.toast(t('panel.dl.zipFailed'), 5000));
        return;
      }
      const hc = e.target.closest && e.target.closest('[data-histclean]');
      if (hc) {
        e.preventDefault(); e.stopPropagation();
        (async () => {
          // Find every folder the bridged identities own, then confirm with the ADVISORY (Seth):
          // download first, and the removal follows the folder ID wherever it now lives — if the
          // folder was MOVED elsewhere in Drive, THAT folder is what goes to trash. Copy or
          // download; never move.
          const bridge = bridgedIds(hc.dataset.id, hc.dataset.title);
          const folderIds = [];
          for (const id of bridge.ids) {
            try { const r = await Researcher.listTextFiles(hc.dataset.i, id); if (r.folderId) folderIds.push(r.folderId); }
            catch { /* a missing folder is simply not removable */ }
          }
          if (!folderIds.length) { deps.toast(t('panel.hist.noFolder'), 5000); return; }
          if (!confirm(t('panel.hist.removeFolderConfirm', { title: hc.dataset.title || '?' }))) return;
          try {
            const r = await Researcher.trashFiles(folderIds, 'deleted-text folder removal');
            deps.toast(t('panel.hist.folderRemoved', { n: r.trashed }), 6000);
          } catch { deps.toast(t('panel.dl.zipFailed'), 5000); }
        })();
        return;
      }
      const df = e.target.closest && e.target.closest('[data-drivefile]');
      if (df) {
        e.preventDefault(); e.stopPropagation();
        // Single-file download through the Worker (same auth as the ZIP; a plain drive URL would
        // work for the owner, but this behaves identically signed in or not, and never leaves a
        // preview page).
        Researcher.fetchDriveFile(df.dataset.drivefile).then((blob) => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = df.dataset.fname || 'file';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        }).catch(() => deps.toast(t('panel.dl.zipFailed'), 5000));
        return;
      }
      closeDlMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDlMenu(); }, true);
  }
}

/* The highest command seq ANY live install of an instance has processed.
 *
 * This is the single source of truth for "has the device seen it yet". ack_seq is monotonic
 * server-side (Math.max on every report), so a command with seq > this has demonstrably not been
 * acted on — and one with seq <= this has. MAX across installs, not per-install: an instance can
 * run the editor and the recorder side by side and either may hold the text, so the conservative
 * reading is the only one that cannot race. */
function ackOf(instances, instanceId) {
  let max = 0;
  for (const it of instances || []) {
    if (it.instance_id !== instanceId) continue;
    for (const ins of it.installs || []) max = Math.max(max, parseInt(ins.ack_seq, 10) || 0);
  }
  return max;
}

/* Assigned-audio lookup for the downloads dropdown. The History log is the ONLY place the assigned
 * Drive URL is retained — a device reports what it UPLOADED, never what it was given. Built once
 * per dashboard render: re-reading localStorage per text row would be O(rows x log). */
let assignedCache = null;
function rebuildAssignedCache() {
  assignedCache = new Map();
  try {
    for (const e of loadHistory(Researcher.currentAccountId())) {
      if (e.kind === 'assigned' && e.docId) assignedCache.set(e.docId, { audioUrl: e.audioUrl, flextextUrl: e.flextextUrl });
    }
  } catch { /* a broken log must not take down the dashboard */ }
}
// null = never assigned through this panel; an object = assigned (possibly with no retained URL,
// which is the pre-v126 case emptyReason() explains rather than hiding).
function assignedFor(docId) { return (assignedCache && assignedCache.get(docId)) || null; }

async function renderInstanceCard(it, deviceCount) {
  const installs = it.installs || [];
  const anyPending = installs.some((i) => i.status === 'pending');
  // Collected while the installs render, then shown in the COLLAPSED header too. A collapse that
  // hides a pending install, a remote wipe or a stuck engine would conceal exactly the states that
  // need attention — so these three ride the summary line and are visible either way.
  let anyStale = false, anyWipe = false, textCount = 0;
  const linked = installs.some((i) => i.status === 'approved' && i.has_key);
  const status = anyPending
    ? `<span class="rp-badge rp-badge-warn">${esc(t('panel.inst.pending'))}</span>`
    : linked ? `<span class="rp-badge rp-badge-ok">${esc(t('panel.inst.linked'))}</span>`
    : `<span class="rp-badge">${esc(t('panel.inst.noKey'))}</span>`;

  let installsHtml = '';
  for (const ins of installs) {
    if (ins.status === 'pending') {
      const fp = ins.pubkey ? await fpOf(ins.pubkey) : '—';
      // B: no key can be delivered until the field user accepts on their device — so until then
      // show "waiting for the user" instead of Approve (the worker would 409 the key anyway).
      const action = ins.accepted
        ? `<button class="primary-btn" data-iact="approve" data-i="${esc(it.instance_id)}" data-id="${esc(ins.install_id)}">${esc(t('panel.inst.approve'))}</button>`
        : `<div class="note rp-waiting">${esc(t('panel.inst.waitingAccept'))}</div>`;
      installsHtml += `<div class="rp-install rp-install-pending">
        <div><div>${esc(t('panel.inst.newInstall'))}</div>
          <div class="rp-mono rp-fp">${esc(t('panel.inst.fingerprint'))}: ${esc(fp)}</div>
          <div class="note rp-verify">${esc(t('panel.inst.verifyHint'))}</div></div>
        ${action}
      </div>`;
    } else {
      const inv = ins.inventory && Array.isArray(ins.inventory.items) ? ins.inventory.items : null;
      if (inv) textCount += inv.length;
      if (ins.wipe_state) anyWipe = true;
      // uploadDelete gate: only engine v94+ understands the upload-first delete command — an older
      // (or non-reporting) install gets a disabled button with a "must update first" tooltip instead
      // of a command it would drop on the floor. Devices auto-update, so this resolves itself.
      const engNum = parseInt(String((ins.inventory && ins.inventory.engineVersion) || '').replace(/[^0-9]/g, ''), 10);
      const canDelText = engNum >= 94;
      // Only surface finished/not-finished status when THIS device actually has the Done
      // feature on — else every text on other devices would carry a meaningless "not done".
      const doneOn = !!(ins.inventory && ins.inventory.settings && ins.inventory.settings.doneEnabled);
      // The inventory is decrypted from the field install's OWN report, so every value is
      // attacker-controllable if a device is seized (hostile-gov threat model). Titles go
      // through esc(); uploadState lands in a class attribute, so ALLOW-LIST it to the three
      // known states — never interpolate it raw (would permit an attribute-breakout XSS into
      // this privileged panel where Kr + the account secret live).
      // Computed once per card: the highest seq any install of THIS instance has processed.
      const maxAck = ackOf(lastData ? lastData.instances : [], it.instance_id);
      const rows = inv && inv.length ? inv.map((d) => {
        const us = (d.uploadState === 'uploaded' || d.uploadState === 'changed') ? d.uploadState : 'local';
        // ⚠ STATE FROM ack_seq, NOT FROM A CLOCK. `queued` = the device has not polled for it yet,
        // so it can still be withdrawn. `taken` = the device has it and is acting; offering a
        // cancel there would let the panel claim a text the device has already deleted, or claim an
        // upload never happened when it did. The Worker refuses it too — this just never asks.
        const p = pendingCmds.get(d.id);
        const queued = !!p && p.seq > maxAck;
        const taken  = !!p && p.seq <= maxAck;
        let disp = us;
        if (p && p.kind === 'upload') disp = queued ? 'requested' : 'slow';
        // SECURITY: disp must stay within this fixed literal set — it lands in a class attribute in this
        // privileged panel; never let an attacker-controlled report value reach it (see note above).
        const DISP = ['local', 'uploaded', 'changed', 'requested', 'slow', 'justUploaded'].includes(disp) ? disp : 'local';
        // Action label by state — Upload (never sent) / Upload changes (edited since) / Re-upload (re-send).
        const label = { changed: 'panel.inst.uploadChanges', uploaded: 'panel.inst.reupload',
                        justUploaded: 'panel.inst.reupload', slow: 'panel.inst.resend' }[DISP] || 'panel.inst.upload';
        // A queued request TOGGLES: click again to withdraw it. Once taken, the button goes inert
        // and says so, rather than pretending an option exists that cannot be honoured.
        const cancelBtn = (kind) => ` <button class="link-btn rp-cancel" data-iact="cancel-cmd" data-i="${esc(it.instance_id)}" data-id="${esc(d.id)}">${esc(t('panel.inst.cancel' + kind))}</button>`;
        const takenTag = ` <span class="rp-tag rp-tag-taken" title="${esc(t('panel.inst.takenWhy'))}">${esc(t('panel.inst.taken'))}</span>`;

        const up = (p && p.kind === 'upload')
          ? (queued ? cancelBtn('Upload') : takenTag)
          : ` <button class="link-btn rp-up" data-iact="upload" data-i="${esc(it.instance_id)}" data-id="${esc(d.id)}" data-fileid="${esc(d.uploadedFileId || '')}">${esc(t(label))}</button>`;
        // Upload-first remote delete (v94+): the device uploads a fresh timestamped copy, THEN deletes.
        const mv = pendingMoves.get(d.id);
        const moveChip = mv ? ` <span class="rp-tag rp-tag-moving">${esc(t(mv.stage === 'assigned' ? 'panel.move.waitingDest' : 'panel.move.removingSrc'))}</span>` : '';
        const moveBtn = (!d.id || mv || (p && p.kind === 'delete')) ? ''
          : ` <button class="link-btn" data-iact="move-text" data-i="${esc(it.instance_id)}" data-id="${esc(d.id)}" data-title="${esc(d.title || '')}">${esc(t('panel.move.btn'))}</button>`;
        const del = !d.id ? ''
          : (p && p.kind === 'delete')
            ? (queued ? cancelBtn('Delete') : takenTag)
            : canDelText
              ? ` <button class="link-btn rp-revoke" data-iact="del-text" data-i="${esc(it.instance_id)}" data-id="${esc(d.id)}" data-title="${esc(d.title || '')}">${esc(t('panel.inst.delText'))}</button>`
              : ` <button class="link-btn rp-revoke" disabled title="${esc(t('panel.inst.delNeedsUpdate'))}">${esc(t('panel.inst.delText'))}</button>`;
        // The done tag is a TOGGLE when the engine understands the setDone COMMAND — the dispatch
        // case shipped in v138. Gating on setDocDone's age (v100) was wrong: an older device ACKS
        // the unknown command and silently does nothing, which reads as "the toggle is broken".
        const canSetDone = engNum >= 138;
        const doneTag = d.done
          ? (canSetDone ? `<button class="rp-tag rp-tag-done rp-tag-btn" data-iact="toggle-done" data-i="${esc(it.instance_id)}" data-id="${esc(d.id)}" data-done="1" title="${esc(t('panel.inst.toggleDoneTip'))}">${esc(t('panel.inst.doneTag'))}</button>`
                        : `<span class="rp-tag rp-tag-done">${esc(t('panel.inst.doneTag'))}</span>`)
          : (doneOn ? (canSetDone ? `<button class="rp-tag rp-tag-notdone rp-tag-btn" data-iact="toggle-done" data-i="${esc(it.instance_id)}" data-id="${esc(d.id)}" data-done="" title="${esc(t('panel.inst.toggleDoneTip'))}">${esc(t('panel.inst.notDoneTag'))}</button>`
                                  : `<span class="rp-tag rp-tag-notdone">${esc(t('panel.inst.notDoneTag'))}</span>`) : '');
        // Delete triggered (by device flag OR this researcher's just-clicked request) but not yet
        // confirmed → strike through + fade the whole row, and add a small "deleting…" tag.
        const deleting = !!d.pendingDelete || !!(p && p.kind === 'delete');
        const delTag = deleting ? `<span class="rp-tag rp-tag-deleting">${esc(t('panel.inst.deletingTag'))}</span>` : '';
        // Downloads: labelled by PURPOSE (ELAN / SayMore / FLExText / FlexText Editor), never by
        // filename — two .eaf exports are near-impossible to tell apart by name. The assigned-audio
        // URL comes from the History log, the only place it is retained (the device reports what it
        // UPLOADED, never what it was given).
        // Files ▾ renders for EVERY text; the menu populates lazily from the text's Drive folder
        // when opened (filesMenuHtml), falling back to the static artifacts when there is no
        // folder yet. Rendering it unconditionally is the point of the per-text folder: the menu
        // is now the one place all of a text's artifacts live.
        const dl = filesMenuHtml(it.instance_id, d.id, d.title || '');
        // (5) The row reads in two lines: title + state chip, then muted metadata; actions sit on
        // the right. The tags stopped fighting the title for attention — that was Seth's "plain
        // line of text with plain hyperlinks is getting busy and ugly".
        return `<li class="rp-text-row ${deleting ? 'rp-pending-del' : ''}">
          <div class="rp-text-main">
            <div class="rp-text-title">${esc(d.title || d.titleHash || '?')} <span class="rp-tag rp-tag-${DISP}">${esc(t('panel.up.' + DISP))}</span>${delTag}</div>
            <div class="note rp-text-meta">${d.hasAudio ? esc(t('panel.inst.audio')) : ''}${doneTag ? (d.hasAudio ? ' · ' : '') + doneTag : ''}</div>
          </div>
          <div class="rp-text-actions">${dl}${up}${moveBtn}${del}</div>
        </li>`;
      }).join('')
        : `<li class="note">${esc(t('panel.inst.noTexts'))}</li>`;
      installsHtml += `<div class="rp-install">
        <div class="note">${esc(t('panel.inst.lastSeen', { when: lastSeen(ins.last_seen_at) }))} · ${esc(t('panel.inst.texts', { n: inv ? inv.length : 0 }))}</div>
        ${(() => {
          const di = deviceInfo(ins.inventory && ins.inventory.ua, ins.inventory && ins.inventory.cachedApps,
                                ins.inventory && ins.inventory.engineVersion, ins.inventory && ins.inventory.platform,
                                ins.id, ins.last_seen_at);
          const txt = di.text || t('panel.inst.verUnknown');
          // The badge is RESEARCHER/DEVELOPER-facing only — it never renders in the coworker's app.
          // A confirmed mismatch means the release process itself misfired, so give a way to report
          // it rather than leaving the researcher to describe a version mismatch from memory.
          let badge = '';
          if (di.stale) {
            anyStale = true;   // surfaced in the collapsed header too — see the note at the top of this function
            const detail = t('panel.dev.staleWhy', { running: di.running || '?', live: di.live || '?' });
            const body = encodeURIComponent(
              'A device is stuck on an old engine after a release.\n\n'
              + 'Running engine: ' + (di.running || 'unknown') + '\n'
              + 'Live engine: ' + (di.live || 'unknown') + '\n'
              + 'Platform: ' + ((ins.inventory && ins.inventory.platform) || 'unknown') + '\n\n'
              + 'Confirmed across two reports at least 6h apart, so this is not propagation delay.');
            const url = 'https://github.com/rulingAnts/flextext-editor/issues/new?title='
              + encodeURIComponent('Stale engine on a field device') + '&body=' + body;
            badge = ` <span class="rp-badge rp-badge-stale" title="${esc(detail)}">${esc(t('panel.dev.stale'))}</span>`
                  + ` <a class="rp-report" href="${url}" target="_blank" rel="noopener">${esc(t('panel.dev.staleReport'))}</a>`;
          }
          return `<div class="note rp-devinfo${di.text ? '' : ' rp-devinfo-old'}${di.stale ? ' rp-devinfo-stale' : ''}">${esc(txt)}${badge}</div>`;
        })()}
        <ul class="rp-inv">${rows}</ul>
        ${(() => {
          const I = esc(it.instance_id), D = esc(ins.install_id);
          if (ins.wipe_state === 'confirmed') return `<div class="note rp-wipe-done">${esc(t('panel.wipe.confirmed'))}</div>
            <button class="link-btn rp-revoke" data-iact="force-remove" data-i="${I}" data-id="${D}">${esc(t('panel.wipe.removeBtn'))}</button>`;
          if (ins.wipe_state === 'requested') return `<div class="note rp-wipe-pending">${esc(t('panel.wipe.pending', { when: lastSeen(ins.wipe_at) }))}</div>
            <button class="link-btn rp-revoke" data-iact="force-remove" data-i="${I}" data-id="${D}">${esc(t('panel.wipe.forceRemoveBtn'))}</button>`;
          return `<button class="link-btn rp-revoke" data-iact="revoke-install" data-i="${I}" data-id="${D}">${esc(t('panel.inst.revokeInstall'))}</button>
            <button class="link-btn rp-danger" data-iact="wipe-install" data-i="${I}" data-id="${D}" data-name="${esc(it.nickname || '')}">${esc(t('panel.wipe.btn'))}</button>`;
        })()}
      </div>`;
    }
  }

  // Show the app(s) the device actually RUNS (from each install's reported inventory.type), not a
  // creation-time type — a unified device may run the editor, the recorder, or both.
  const apps = [...new Set((it.installs || []).map((i) => i.inventory && i.inventory.type).filter(Boolean))];
  const runs = apps.length ? apps.join(' + ') : (it.type || '');
  // Collapsed by default once there is more than one device; an explicit choice always wins.
  const collapsed = isCardCollapsed(collapsedCards, it.instance_id, deviceCount || 1);
  const bodyId = 'rp-inst-body-' + it.instance_id;
  // Warning badges that must NOT be hidden behind the collapse.
  const warnBadges = `${anyWipe ? ` <span class="rp-badge rp-badge-warn">${esc(t('panel.inst.wipeBadge'))}</span>` : ''}`
                   + `${anyStale ? ` <span class="rp-badge rp-badge-stale">${esc(t('panel.dev.stale'))}</span>` : ''}`;
  return `<div class="rp-card rp-inst${collapsed ? ' rp-inst-collapsed' : ''}">
    <div class="rp-inst-top">
      <button class="rp-inst-toggle" data-iact="collapse" data-i="${esc(it.instance_id)}"
              aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="${esc(bodyId)}"
              title="${esc(t(collapsed ? 'panel.inst.expand' : 'panel.inst.collapse'))}">
        <span class="rp-caret" aria-hidden="true">▾</span>
        <span class="rp-inst-name">${esc(it.nickname || '?')} ${runs ? `<span class="rp-badge rp-badge-type">${esc(runs)}</span>` : ''} ${status}${warnBadges}</span>
        <span class="rp-inst-count">${esc(t('panel.inst.texts', { n: textCount }))}</span>
      </button>
    </div>
    <div class="rp-inst-body" id="${esc(bodyId)}"${collapsed ? ' hidden' : ''}>
      ${installsHtml || `<p class="note">${esc(t('panel.inst.noInstall'))}</p>`}
      <div class="rp-inst-actions">
        <button class="secondary-btn" data-iact="settings" data-i="${esc(it.instance_id)}" data-type="${esc(it.type)}">${esc(t('panel.inst.settings'))}</button>
        <button class="secondary-btn" data-iact="invite" data-i="${esc(it.instance_id)}" data-type="${esc(it.type)}">${esc(t('panel.inst.invite'))}</button>
        <button class="secondary-btn" data-iact="assign" data-i="${esc(it.instance_id)}">${esc(t('panel.inst.assign'))}</button>
        <button class="link-btn rp-revoke" data-iact="revoke" data-i="${esc(it.instance_id)}" data-name="${esc(it.nickname || '')}">${esc(t('panel.inst.revoke'))}</button>
      </div>
    </div>
  </div>`;
}

let lastView = null;

async function instanceAction(el) {
  const id = el.dataset.i, installId = el.dataset.id, type = el.dataset.type;
  const act = el.dataset.iact;
  try {
    if (act === 'collapse') {
      // ⚠ A DOM FLIP, DELIBERATELY NOT A RE-RENDER. renderDashboard() would refetch and rebuild
      // every card just to hide one; the state is re-derived on the next 12s poll anyway, so the
      // card comes back exactly as left. Nothing animates, so there is nothing to flicker.
      const card = el.closest('.rp-inst');
      const body = card && card.querySelector('.rp-inst-body');
      if (!card || !body) return;
      const nowCollapsed = !body.hidden;
      body.hidden = nowCollapsed;
      card.classList.toggle('rp-inst-collapsed', nowCollapsed);
      el.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
      el.title = t(nowCollapsed ? 'panel.inst.expand' : 'panel.inst.collapse');
      collapsedCards.set(id, nowCollapsed);
      saveCollapsed(Researcher.currentAccountId());   // persist BEFORE the next render reads it back
      return;
    }
    if (act === 'approve') {
      lastView = await Researcher.listView();
      const inst = lastView.instances.find((x) => x.instance_id === id);
      const ins = inst && inst.installs.find((x) => x.install_id === installId);
      await busy(el, () => Researcher.approveInstall(id, installId, ins && ins.pubkey));
      deps.toast(t('panel.inst.approved'), 4000);
      renderDashboard();
    } else if (act === 'revoke') {
      if (!confirm(t('panel.inst.confirmRevoke', { name: el.dataset.name || '' }))) return;
      await busy(el, () => Researcher.revokeInstance(id));
      renderDashboard();
    } else if (act === 'revoke-install') {
      if (!confirm(t('panel.inst.confirmRevokeInstall'))) return;   // UNLINK — warns local data stays on the device
      await busy(el, () => Researcher.revokeInstall(id, installId));
      renderDashboard();
    } else if (act === 'wipe-install') {
      wipeConfirmModal(id, installId, el.dataset.name || '');       // REMOTE WIPE — typed confirm (+ TOTP step-up)
    } else if (act === 'force-remove') {
      if (!confirm(t('panel.wipe.confirmForceRemove'))) return;
      await busy(el, () => Researcher.forceRemoveInstall(id, installId));
      renderDashboard();
    } else if (act === 'invite') {
      // Gate: don't mint an invite for a device that lacks minimal usable settings, or the field
      // worker ends up with a broken device. Validate the researcher-side snapshot, falling back to
      // whatever the device last reported — so a device configured before this feature (or via the
      // device itself) isn't forced through a redundant re-save.
      const snap = await Researcher.getInstanceSettings(id).catch(() => null);
      lastView = await Researcher.listView();
      const inst = lastView.instances.find((x) => x.instance_id === id);
      const effective = snap || (inst && firstInventorySettings(inst));
      const probs = effective ? validateDeviceSettings(settingsToRaw(effective)) : null;
      if (!effective || (probs && probs.length)) {
        deps.toast(t(effective ? 'panel.invite.fixSettings' : 'panel.invite.needSettings'), 6000);
        if (inst) await openSettingsModal({ kind: 'instance', instance: inst }, { flagOnOpen: true });
        return;
      }
      inviteModal(id);
    } else if (act === 'assign') {
      assignModal(id);
    } else if (act === 'upload') {
      const docId = el.dataset.id;                                         // data-id is the doc id here
      const prevFileId = el.dataset.fileid || '';                          // snapshot: a DIFFERENT id later = this upload landed
      // Keep the seq the Worker assigned — it is what makes the request withdrawable, and what
      // ack_seq is later compared against to know whether it still can be.
      const r1 = await busy(el, () => Researcher.triggerUpload(id, docId)); // throws on failure → caught below → no marker set
      pendingCmds.set(docId, { seq: r1.seq, kind: 'upload', instanceId: id, prevFileId, at: Date.now() });
      savePending(Researcher.currentAccountId());
      deps.toast(t('panel.inst.uploadSent'), 5000);
      renderDashboard(lastData || undefined);                             // instant feedback: row flips to "request sent…"
    } else if (act === 'del-text') {
      // Upload-first delete: the confirm spells out the safety order (fresh Drive copy FIRST, delete
      // only after it's confirmed).
      if (!confirm(t('panel.inst.confirmDelText', { title: el.dataset.title || '?' }))) return;
      const r2 = await busy(el, () => Researcher.uploadDelete(id, el.dataset.id));  // data-id is the doc id here
      pendingCmds.set(el.dataset.id, { seq: r2.seq, kind: 'delete', instanceId: id, at: Date.now() });
      savePending(Researcher.currentAccountId());
      deps.toast(t('panel.inst.delSent'), 5000);
      renderDashboard(lastData || undefined);
    } else if (act === 'cancel-cmd') {
      // Withdraw a request the device has not picked up. The Worker re-checks ack_seq and refuses
      // with 409 already_delivered if it is too late — that refusal is SHOWN, never swallowed,
      // because a cancel the researcher believes worked but did not is the dangerous outcome: the
      // panel would claim a text the device has already deleted.
      const p = pendingCmds.get(el.dataset.id);
      if (!p) { renderDashboard(lastData || undefined); return; }
      try {
        await busy(el, () => Researcher.cancelCommand(id, p.seq));
        pendingCmds.delete(el.dataset.id);
        savePending(Researcher.currentAccountId());
        deps.toast(t('panel.inst.cancelled'), 4000);
      } catch (e) {
        // Too late: leave the marker in place so the row correctly shows "in progress".
        deps.toast(t(/already_delivered|409/.test(String(e && e.message)) ? 'panel.inst.cancelTooLate' : 'panel.inst.cancelFailed'), 7000);
      }
      renderDashboard();   // refetch: ack_seq has moved, so the row must re-derive its true state
    } else if (act === 'move-text') {
      moveTextModal(id, el.dataset.id, el.dataset.title || '');
    } else if (act === 'toggle-done') {
      const want = !el.dataset.done;
      await busy(el, () => Researcher.setDone(id, el.dataset.id, want));
      deps.toast(t(want ? 'panel.move.doneSent' : 'panel.move.notDoneSent'), 4000);
    } else if (act === 'settings') {
      lastView = await Researcher.listView();
      const inst = lastView.instances.find((x) => x.instance_id === id);
      openSettingsModal({ kind: 'instance', instance: inst });
    }
  } catch (e) { errToast(e); }
}

/* ---------------- modals: new device / invite / assign / account ---------------- */

function newDeviceModal() {
  const m = modal(`
    <h3>${esc(t('panel.new.title'))}</h3>
    <label class="rp-field"><span>${esc(t('panel.new.nick'))}</span><input id="rp-new-nick" placeholder="${esc(t('panel.new.nickPh'))}" spellcheck="false"></label>
    <p class="note">${esc(t('panel.new.unifiedNote'))}</p>
    <button class="primary-btn" data-m="create">${esc(t('panel.new.create'))}</button>
    <button class="link-btn" data-m="cancel">${esc(t('panel.new.cancel'))}</button>`);
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  m.el.querySelector('[data-m="create"]').onclick = (e) => busy(e.target, async () => {
    const nick = m.el.querySelector('#rp-new-nick').value.trim();
    if (!nick) return deps.toast(t('panel.new.needNick'), 4000);
    try {
      const inst = await Researcher.createInstance(nick);
      m.close(); renderDashboard();
      // A new device has no settings yet — open them straight away so it gets configured. Invite-link
      // creation stays blocked until the required fields are filled in, so this isn't skippable.
      deps.toast(t('panel.new.configure'), 5000);
      await openSettingsModal({ kind: 'instance', instance: { instance_id: inst.instance_id, nickname: inst.nickname, installs: [] } });
    }
    catch (err) { errToast(err); }
  });
}

async function inviteModal(instanceId) {
  const m = modal(`<h3>${esc(t('panel.invite.title'))}</h3><p class="note">${esc(t('panel.invite.loading'))}</p>`);
  try {
    // ONE invite, rendered as BOTH app URLs. The coworker opens whichever app(s) they use; same-origin
    // editor + recorder share one identity, so opening either binds the SAME device — one claim, one
    // consent, one approval, even if both links are sent.
    const invite = await Researcher.mintInvite(instanceId);
    /* THIS instance's estate, from the MINT RESPONSE — server truth. The cached dashboard is not
     * good enough: a brand-new device is not in it yet, the lookup missed, and estateOfRecord(undefined)
     * fell back to 'pages' — which sent every new coworker to the legacy apps even though the row
     * said 'cloud' (Seth, 2026-08-05; confirmed against D1). The cache is only a fallback now, and
     * an unknown instance is an ERROR rather than a guess: guessing legacy is exactly the bug. */
    const cached = ((lastData && lastData.instances) || []).find((x) => x.instance_id === instanceId);
    const estate = invite.estate || (cached && cached.estate);
    if (!estate) throw new Error('Could not determine which app this device should install — reload the panel and try again.');
    const B = basesFor(estate);
    const urls = { editor: Researcher.inviteUrl(B.editor, invite), recorder: Researcher.inviteUrl(B.recorder, invite) };
    const exp = invite.expires_at ? new Date(invite.expires_at).toLocaleString() : '';
    const row = (label, key) => `
      <div class="rp-field"><span>${esc(label)}</span>
        <textarea class="rp-linkbox" readonly rows="2" data-url="${key}">${esc(urls[key])}</textarea>
        <div class="rp-inst-actions"><button class="secondary-btn" data-copy="${key}">${esc(t('panel.invite.copy'))}</button>
        <button class="link-btn" data-share="${key}">${esc(t('panel.invite.share'))}</button></div></div>`;
    m.el.querySelector('.modal-card').innerHTML = `
      <h3>${esc(t('panel.invite.title'))}</h3>
      <p class="note">${esc(t('panel.invite.introUnified'))}</p>
      ${row(t('panel.invite.editorLink'), 'editor')}
      ${row(t('panel.invite.recorderLink'), 'recorder')}
      ${exp ? `<p class="note">${esc(t('panel.invite.expires', { when: exp }))}</p>` : ''}
      <button class="link-btn" data-m="close">${esc(t('panel.invite.close'))}</button>`;
    m.el.querySelector('[data-m="close"]').onclick = m.close;
    m.el.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = async () => {
      const u = urls[b.dataset.copy];
      try { await navigator.clipboard.writeText(u); deps.toast(t('panel.invite.copied'), 3000); }
      catch { const ta = m.el.querySelector(`[data-url="${b.dataset.copy}"]`); if (ta) ta.select(); }
    }; });
    m.el.querySelectorAll('[data-share]').forEach((b) => { b.onclick = () => {
      const u = urls[b.dataset.share];
      if (navigator.share) navigator.share({ url: u, text: t('panel.invite.shareText') }).catch(() => {});
      else window.open('https://wa.me/?text=' + encodeURIComponent(u), '_blank');
    }; });
  } catch (e) { m.close(); errToast(e); }
}

function assignModal(instanceId) {
  const m = modal(`
    <h3>${esc(t('panel.assign.title'))}</h3>
    <p class="note">${esc(t('panel.assign.intro'))}</p>
    <label class="rp-field"><span>${esc(t('panel.assign.titleField'))}</span><input id="rp-as-title" spellcheck="false"></label>
    <label class="rp-field"><span>${esc(t('panel.assign.audio'))}</span><input id="rp-as-audio" spellcheck="false" placeholder="${esc(t('panel.assign.urlPh'))}"></label>
    <label class="rp-field"><span>${esc(t('panel.assign.flextext'))}</span><input id="rp-as-ft" spellcheck="false" placeholder="${esc(t('panel.assign.urlPh'))}"></label>
    <div class="rp-notice rp-notice-sm" id="rp-as-ft-warn" hidden><b>${esc(t('panel.assign.roundTripTitle'))}</b>${t('panel.assign.roundTripBody')}</div>
    <p class="rp-as-status" id="rp-as-status" role="status" hidden></p>
    <button class="primary-btn" data-m="send">${esc(t('panel.assign.send'))}</button>
    <button class="link-btn" data-m="cancel">${esc(t('panel.assign.cancel'))}</button>`);
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  // The FLEx round-trip warning is only relevant once they're actually attaching a flextext
  // file — showing it on an audio-only assignment is noise that trains people to ignore it.
  const ftInput = m.el.querySelector('#rp-as-ft');
  const ftWarn = m.el.querySelector('#rp-as-ft-warn');
  const syncFtWarn = () => { ftWarn.hidden = !ftInput.value.trim(); };
  ftInput.addEventListener('input', syncFtWarn);
  syncFtWarn();
  const say = (msg, kind) => {
    const s = m.el.querySelector('#rp-as-status');
    s.hidden = false; s.textContent = msg;
    s.className = 'rp-as-status' + (kind ? ' rp-as-' + kind : '');
  };
  const resolve = (u) => (deps.resolveAudioInput ? deps.resolveAudioInput(u) : u);
  m.el.querySelector('[data-m="send"]').onclick = (e) => busy(e.target, async () => {
    const title = m.el.querySelector('#rp-as-title').value.trim();
    const audioUrl = m.el.querySelector('#rp-as-audio').value.trim();
    const flextextUrl = m.el.querySelector('#rp-as-ft').value.trim();
    // The field only materializes an assign that carries an audio or flextext resource;
    // a title alone bumps the rev but creates nothing — so require at least one URL.
    if (!audioUrl && !flextextUrl) return deps.toast(t('panel.assign.needUrl'), 5000);

    // Validate BEFORE sending — the researcher (not the barely-literate field coworker) finds
    // out about a folder link / AIFF / oversize / unshared file. Reuses the editor link-builder's
    // probe + the same field-tested task.* messages. A hard failure NEVER reaches Researcher.assign.
    if (audioUrl) {
      const resolved = resolve(audioUrl);
      if (!resolved) { say('⚠ ' + t('task.badAudio'), 'err'); return; }
      say(t('panel.assign.checkingAudio'));
      try {
        const info = await probeAudioUrl(resolved);
        say('✓ ' + t('task.checkOk', { name: info.name || '?', size: info.size ? fmtSize(info.size) : '?' }), 'ok');
      } catch (err) {
        // A Drive link is proxied through the SAME-ORIGIN worker/relay, so a failure there is real.
        // Only a direct NON-Drive host can be cross-origin-blocked (opaque) — there we can't tell a
        // real outage from a CORS block, so offer "send anyway" rather than a false hard block.
        const soft = !/script\.google|\/drive/.test(resolved)
          && (err.name === 'TypeError' || /failed to fetch|networkerror/i.test(err.message || ''));
        if (soft) {
          if (!confirm(t('panel.assign.couldNotVerify'))) { say('⚠ ' + t('panel.assign.blockedNoSend'), 'err'); return; }
        } else {
          const msg = err.code === 'cantPlay' ? t('task.cantPlay')
            : err.code === 'big' ? t('task.tooBig', { mb: err.mb })
            : err.code === 'notAudio' ? t('task.notAudio', { mime: err.mime || '?' })
            : t('task.checkFailed', { msg: err.message });
          say('⚠ ' + msg, 'err'); return;
        }
      }
    }

    // Validate the flextext link too: reachable + a SINGLE interlinear text (only the first is
    // delivered). Writing-system-code match is deferred (this modal doesn't carry the device's codes).
    if (flextextUrl) {
      const resolved2 = resolve(flextextUrl);
      if (!resolved2) { say('⚠ ' + t('task.badFlextext'), 'err'); return; }
      say(t('panel.assign.checkingFlextext'));
      let xml;
      try { xml = await (await fetchFileViaUrl(resolved2)).blob.text(); }
      catch (err) {
        // Same soft-CORS escape as the audio path: a direct (non-Drive) host that blocks the cross-origin
        // check can't be told apart from a real outage, so offer "send anyway" instead of a false block.
        const soft = !/script\.google|\/drive/.test(resolved2)
          && (err.name === 'TypeError' || /failed to fetch|networkerror/i.test(err.message || ''));
        if (soft) {
          if (!confirm(t('panel.assign.couldNotVerify'))) { say('⚠ ' + t('panel.assign.blockedNoSend'), 'err'); return; }
          // confirmed → proceed without parsing (xml stays undefined)
        } else { say('⚠ ' + t('task.ftFetchFailed', { msg: err.message }), 'err'); return; }
      }
      if (xml !== undefined) {
        const parsed = parseFlextext(xml);
        if (parsed.error || !parsed.texts.length) { say('⚠ ' + t('task.ftParseFailed', { msg: parsed.error || t('task.ftNone') }), 'err'); return; }
        if (parsed.texts.length > 1) { say('⚠ ' + t('task.ftMultiText', { n: parsed.texts.length }), 'err'); return; }
      }
    }

    const fields = { title };
    if (audioUrl) fields.audioUrl = audioUrl;     // send the RAW url; the device re-resolves it
    if (flextextUrl) fields.flextextUrl = flextextUrl;
    // The docId is minted HERE, so this is the only place that knows which assignment produced
    // which text. Record it now: the device's later reports carry the id but never the audio URL,
    // so if this event is not written the "audio that was assigned" link is unrecoverable.
    const docId = crypto.randomUUID();
    try {
      await Researcher.assign(instanceId, docId, fields);
      // Logged only AFTER the assign succeeds — a failed send did not assign anything.
      const inst = (lastData && (lastData.instances || []).find((x) => x.instance_id === instanceId)) || null;
      recordEvents(Researcher.currentAccountId(), [assignedEvent({
        instanceId, device: (inst && inst.nickname) || '', docId, title, audioUrl, flextextUrl,
      })]);
      // Best-effort SERVER-side copy of the assigned audio into the text's new Drive folder —
      // fire-and-forget by design: the assignment has already succeeded, the Worker streams the
      // public file with the researcher's own token (zero coworker bandwidth), and a failure costs
      // only the convenience copy. Deliberately NOT awaited: a big recording can take a while and
      // the modal must not hang on it.
      if (audioUrl && driveIdFrom(audioUrl)) {
        Researcher.assignCopy(instanceId, docId, title, audioUrl)
          .catch(() => console.warn('assign-copy failed (assignment itself succeeded)'));
      }
      m.close(); deps.toast(t('panel.assign.sent'), 4000);
    }
    catch (err) { errToast(err); }
  });
}

/* ---------------- crowd recorders (public crowd-source recording pages) ----------------
 * A crowd recorder is a PUBLIC page (CROWD_BASE?c=<id>) anyone with the link can use: welcome →
 * consent → record → the worker relays the zip to the researcher's Drive folder. No login, no local
 * corpus, no E2EE — the keyless public page must read its own config, so everything in it (except
 * nothing: even the folder id) is server-readable. The edit modal warns accordingly. */

// Bytes → human size up to GB (the crowd budgets are GB-scale; fmtSize stops at MB).
function fmtBytes(b) {
  b = Number(b) || 0;
  if (b >= 1073741824) { const g = b / 1073741824; return (g >= 10 ? Math.round(g) : g.toFixed(1)) + ' GB'; }
  if (b >= 1048576) { const mo = b / 1048576; return (mo >= 10 ? Math.round(mo) : mo.toFixed(1)) + ' MB'; }
  return Math.max(0, Math.round(b / 1024)) + ' KB';
}

const CROWD_DEFAULT_CONFIG = { welcome: '', consentAsk: ['text'], consentConfirm: ['yesno'], consentMsg: '', consentAudioUrl: '', lang: 'id', maxSeconds: 600, recordFormat: 'wav24', turnstile: true };

function renderCrowdCard(recs) {
  let body;
  if (recs == null) body = `<p class="banner warn-banner">${esc(t('panel.crowd.fetchFail'))}</p>
    <button class="secondary-btn" data-cact="reload">${esc(t('panel.dash.retry'))}</button>`;
  else if (!recs.length) body = `<p class="note">${esc(t('panel.crowd.empty'))}</p>`;
  else body = recs.map(renderCrowdRow).join('');
  return `<div class="rp-card rp-crowd">
    <div class="rp-inst-top"><span class="rp-inst-name">${esc(t('panel.crowd.title'))}</span></div>
    <p class="note">${esc(t('panel.crowd.intro'))}</p>
    ${body}
    <div class="rp-inst-actions"><button class="primary-btn" data-cact="new">${esc(t('panel.crowd.new'))}</button></div>
  </div>`;
}

function renderCrowdRow(r) {
  const id = esc(r.crowd_id);
  const live = Number(r.enabled) === 1;
  // Budget-reached = auto-paused by the worker until the day/budget resets or the researcher raises it.
  const overDay = Number(r.max_per_day) > 0 && Number(r.day_count) >= Number(r.max_per_day);
  const overBytes = Number(r.max_bytes_total) > 0 && Number(r.bytes_total) >= Number(r.max_bytes_total);
  const pill = live
    ? `<span class="rp-badge rp-badge-ok">${esc(t('panel.crowd.live'))}</span>`
    : `<span class="rp-badge">${esc(t('panel.crowd.paused'))}</span>`;
  const counts = t('panel.crowd.counts', {
    total: Number(r.submit_count) || 0,
    today: Number(r.day_count) || 0, max: Number(r.max_per_day) || 0,
    bytes: fmtBytes(r.bytes_total), budget: fmtBytes(r.max_bytes_total),
  });
  return `<div class="rp-install">
    <div><div class="rp-inst-name">${esc(r.label || '?')} ${pill}</div>
      <div class="note">${esc(counts)}</div>
      ${(overDay || overBytes) ? `<div class="note rp-crowd-budget">${esc(t('panel.crowd.budget'))}</div>` : ''}</div>
    <div class="rp-inst-actions">
      <button class="secondary-btn" data-cact="edit" data-c="${id}">${esc(t('panel.crowd.edit'))}</button>
      <button class="secondary-btn" data-cact="share" data-c="${id}">${esc(t('panel.crowd.share'))}</button>
      <button class="secondary-btn" data-cact="toggle" data-c="${id}" data-on="${live ? '1' : '0'}">${esc(t(live ? 'panel.crowd.pause' : 'panel.crowd.resume'))}</button>
      <button class="link-btn" data-cact="subs" data-c="${id}">${esc(t('panel.crowd.subs'))}</button>
      <button class="link-btn rp-revoke" data-cact="delete" data-c="${id}">${esc(t('panel.crowd.delete'))}</button>
    </div>
  </div>`;
}

// Refetch + repaint ONLY the crowd card (post-action feedback without a full dashboard refetch).
async function refreshCrowd() {
  try { crowdCache = (await Researcher.crowdList()).recorders || []; } catch { crowdCache = null; }
  const holder = root && root.querySelector('.rp-crowd');
  if (!holder) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderCrowdCard(crowdCache);
  holder.replaceWith(tmp.firstElementChild);
  root.querySelectorAll('.rp-crowd [data-cact]').forEach((el) => el.addEventListener('click', () => crowdAction(el)));
}

async function crowdAction(el) {
  const id = el.dataset.c, act = el.dataset.cact;
  const rec = (Array.isArray(crowdCache) ? crowdCache : []).find((r) => r.crowd_id === id) || null;
  try {
    if (act === 'new') newCrowdModal();
    else if (act === 'reload') await busy(el, refreshCrowd);
    else if (act === 'edit') { if (rec) crowdEditModal(rec); }
    else if (act === 'share') { if (rec) crowdShareModal(rec); }
    else if (act === 'subs') { if (rec) crowdSubsModal(rec); }
    else if (act === 'delete') { if (rec) crowdDeleteModal(rec); }
    else if (act === 'toggle') {
      // Pause/Resume is safe + instantly reversible → no confirm on either direction.
      const on = el.dataset.on === '1';
      await busy(el, () => Researcher.crowdUpdate(id, { enabled: on ? 0 : 1 }));
      deps.toast(t(on ? 'panel.crowd.pausedToast' : 'panel.crowd.resumedToast'), 4000);
      await refreshCrowd();
    }
  } catch (e) { errToast(e); }
}

// Create flow mirrors newDeviceModal: ask only for a label, create with safe defaults, then drop
// straight into the edit modal so the recorder gets its Drive folder before anyone shares the link.
function newCrowdModal() {
  const m = modal(`
    <h3>${esc(t('panel.crowd.newTitle'))}</h3>
    <p class="note">${esc(t('panel.crowd.newIntro'))}</p>
    <label class="rp-field"><span>${esc(t('panel.crowd.label'))}</span><input id="rp-cr-label" spellcheck="false" placeholder="${esc(t('panel.crowd.labelPh'))}"></label>
    <button class="primary-btn" data-m="create">${esc(t('panel.crowd.create'))}</button>
    <button class="link-btn" data-m="cancel">${esc(t('panel.set.cancel'))}</button>`);
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  m.el.querySelector('[data-m="create"]').onclick = (e) => busy(e.target, async () => {
    const label = m.el.querySelector('#rp-cr-label').value.trim();
    if (!label) return deps.toast(t('panel.crowd.needLabel'), 4000);
    try {
      const r = await Researcher.crowdCreate(label, '', Object.assign({}, CROWD_DEFAULT_CONFIG));
      m.close();
      await refreshCrowd();   // also pulls the server-defaulted budgets for the edit modal below
      deps.toast(t('panel.crowd.created'), 4000);
      const rec = (Array.isArray(crowdCache) ? crowdCache : []).find((x) => x.crowd_id === r.crowd_id)
        || { crowd_id: r.crowd_id, label, enabled: 1, config: Object.assign({}, CROWD_DEFAULT_CONFIG), max_per_day: 200, max_bytes_total: 1073741824 };
      crowdEditModal(rec);
    } catch (err) { errToast(err); }
  });
}

function crowdEditModal(rec) {
  const cfg = (rec.config && typeof rec.config === 'object') ? rec.config : {};
  const m = modal(`
    <h3>${esc(t('panel.crowd.editTitle', { label: rec.label || '' }))}</h3>
    <p class="banner warn-banner">${esc(t('panel.crowd.publicWarn'))}</p>
    <label class="rp-field"><span>${esc(t('panel.crowd.label'))}</span><input id="cr-label" spellcheck="false"></label>
    <label class="rp-field"><span>${esc(t('panel.crowd.welcome'))}</span><textarea id="cr-welcome" rows="2"></textarea></label>
    <div class="rp-field"><span>${esc(t('panel.f.consentAsk'))}</span><div class="rp-multi">${['text', 'audio'].map((o) =>
      `<label class="check-label rp-inline"><input type="checkbox" data-ask="${o}"> ${esc(t('panel.opt.ask.' + o))}</label>`).join('')}</div></div>
    <label class="rp-field"><span>${esc(t('panel.f.consentMsg'))}</span><textarea id="cr-cmsg" rows="2"></textarea></label>
    <label class="rp-field"><span>${esc(t('panel.f.consentAudioUrl'))}</span><input id="cr-caudio" spellcheck="false"></label>
    <div class="rp-field"><span>${esc(t('panel.f.consentConfirm'))}</span><div class="rp-multi">${['yesno', 'record', 'signature'].map((o) =>
      `<label class="check-label rp-inline"><input type="checkbox" data-conf="${o}"> ${esc(t('panel.opt.conf.' + o))}</label>`).join('')}</div></div>
    <label class="rp-field"><span>${esc(t('panel.f.recordFormat'))}</span>
      <select id="cr-fmt">${REC_KEYS.map((k) => `<option value="${k}">${esc(t('panel.opt.fmt.' + k))}</option>`).join('')}</select></label>
    <label class="rp-field"><span>${esc(t('panel.crowd.lang'))}</span>
      <select id="cr-lang"><option value="en">${esc(t('panel.opt.appLang.en'))}</option><option value="id">${esc(t('panel.opt.appLang.id'))}</option></select></label>
    <label class="rp-field"><span>${esc(t('panel.crowd.maxSec'))} — <span id="cr-maxsec-lbl"></span></span>
      <input type="range" id="cr-maxsec" min="10" max="3600" step="10"></label>
    <p class="note" id="cr-estimate"></p>
    <label class="check-label"><input type="checkbox" id="cr-turnstile"> ${esc(t('panel.crowd.turnstile'))}</label>
    <p class="note">${esc(t('panel.crowd.turnstileNote'))}</p>
    <label class="rp-field"><span>${esc(t('panel.crowd.maxDay'))}</span><input id="cr-maxday" type="number" min="1" inputmode="numeric"></label>
    <label class="rp-field"><span>${esc(t('panel.crowd.maxMb'))}</span><input id="cr-maxmb" type="number" min="1" inputmode="numeric"></label>
    <button class="primary-btn" data-m="save">${esc(t('panel.crowd.save'))}</button>
    <button class="link-btn" data-m="cancel">${esc(t('panel.set.cancel'))}</button>`, true);
  const $$ = (s) => m.el.querySelector(s);
  // Prefill programmatically (same pattern as fillForm) — no untrusted values in attribute position.
  $$('#cr-label').value = rec.label || '';
  $$('#cr-welcome').value = cfg.welcome || '';
  $$('#cr-cmsg').value = cfg.consentMsg || '';
  $$('#cr-caudio').value = cfg.consentAudioUrl || '';
  $$('#cr-fmt').value = REC_KEYS.includes(cfg.recordFormat) ? cfg.recordFormat : 'wav24';
  $$('#cr-lang').value = cfg.lang === 'en' ? 'en' : 'id';
  $$('#cr-maxsec').value = String(Math.min(3600, Math.max(10, Number(cfg.maxSeconds) || 300)));
  // Live size heads-up: re-computed on every slider move and format change.
  const paintEstimate = () => {
    const secsNow = parseInt($$('#cr-maxsec').value, 10) || 300;
    const fmt = $$('#cr-fmt').value;
    $$('#cr-maxsec-lbl').textContent = fmtDur(secsNow);
    const est = crowdEstimate(fmt, secsNow);
    const mb = est / 1048576;
    const el = $$('#cr-estimate');
    el.textContent = t('panel.crowd.estimate', { mb: mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1) });
  };
  $$('#cr-maxsec').addEventListener('input', paintEstimate);
  $$('#cr-fmt').addEventListener('change', paintEstimate);
  paintEstimate();
  $$('#cr-turnstile').checked = cfg.turnstile !== false;   // default ON
  $$('#cr-maxday').value = String(Number(rec.max_per_day) || 200);
  $$('#cr-maxmb').value = String(Math.max(1, Math.round((Number(rec.max_bytes_total) || 1073741824) / 1048576)));
  const ask = Array.isArray(cfg.consentAsk) ? cfg.consentAsk : [];
  const conf = Array.isArray(cfg.consentConfirm) ? cfg.consentConfirm : [];
  m.el.querySelectorAll('[data-ask]').forEach((c) => { c.checked = ask.includes(c.dataset.ask); });
  m.el.querySelectorAll('[data-conf]').forEach((c) => { c.checked = conf.includes(c.dataset.conf); });
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;

  m.el.querySelector('[data-m="save"]').onclick = (e) => busy(e.target, async () => {
    const label = $$('#cr-label').value.trim();
    if (!label) return deps.toast(t('panel.crowd.needLabel'), 4000);
    // No folder field: submissions stream into the researcher's own Drive at
    // "FlexText Uploads / Crowd — <name>" automatically (relay leg retired).
    const config = {
      welcome: $$('#cr-welcome').value.trim(),
      consentAsk: Array.from(m.el.querySelectorAll('[data-ask]')).filter((c) => c.checked).map((c) => c.dataset.ask),
      consentConfirm: Array.from(m.el.querySelectorAll('[data-conf]')).filter((c) => c.checked).map((c) => c.dataset.conf),
      consentMsg: $$('#cr-cmsg').value.trim(),
      consentAudioUrl: $$('#cr-caudio').value.trim(),
      recordFormat: $$('#cr-fmt').value,
      lang: $$('#cr-lang').value === 'en' ? 'en' : 'id',
      maxSeconds: parseInt($$('#cr-maxsec').value, 10) || 300,
      turnstile: $$('#cr-turnstile').checked,
    };
    const maxDay = parseInt($$('#cr-maxday').value, 10);
    const maxMb = parseInt($$('#cr-maxmb').value, 10);
    try {
      await Researcher.crowdUpdate(rec.crowd_id, {
        label, config,
        max_per_day: maxDay > 0 ? maxDay : 200,                       // NaN/0 → the documented defaults
        max_bytes_total: maxMb > 0 ? maxMb * 1048576 : 1073741824,    // researcher-facing unit is MB
      });
      m.close(); deps.toast(t('panel.crowd.saved'), 4000);
      refreshCrowd();
    } catch (err) { errToast(err); }
  });
}

// Share & Embed — patterned on inviteModal (readonly boxes + Copy). Three integration tiers, most
// robust first; the notes are the field-tested embedding pitfalls (allow="microphone", CMS stripping).
function crowdShareModal(rec) {
  /* THIS recorder's estate. Its public link may already be embedded on somebody's website, so it
   * must keep the address it was created with for the rest of its life — showing a second URL for
   * one recorder is how a researcher ends up handing out two. */
  const CB = basesFor(estateOfRecord(rec)).crowd;
  const link = CB + '?c=' + encodeURIComponent(rec.crowd_id);
  const snips = {
    link,
    iframe: `<iframe src="${link}&embed=1" allow="microphone; autoplay" style="width:100%;max-width:480px;height:640px;border:0;border-radius:12px" title="Voice recorder" loading="lazy"></iframe>`,
    script: `<script async src="${CB}embed.js" data-recorder="${rec.crowd_id}"><\/script>`,
  };
  const block = (key, titleKey, noteKey, rows, share) => `
    <div class="rp-field"><span>${esc(t(titleKey))}</span>
      <textarea class="rp-linkbox" readonly rows="${rows}" data-url="${key}">${esc(snips[key])}</textarea>
      <p class="note">${esc(t(noteKey))}</p>
      <div class="rp-inst-actions"><button class="secondary-btn" data-copy="${key}">${esc(t(share ? 'panel.invite.copy' : 'panel.crowd.copyCode'))}</button>
      ${share ? `<button class="link-btn" data-share="${key}">${esc(t('panel.invite.share'))}</button>` : ''}</div></div>`;
  const m = modal(`
    <h3>${esc(t('panel.crowd.shareTitle', { label: rec.label || '' }))}</h3>
    <p class="banner warn-banner">${esc(t('panel.crowd.shareWarn'))}</p>
    ${block('link', 'panel.crowd.shareLink', 'panel.crowd.shareLinkNote', 2, true)}
    ${block('script', 'panel.crowd.shareScript', 'panel.crowd.shareScriptNote', 3, false)}
    ${block('iframe', 'panel.crowd.shareIframe', 'panel.crowd.shareIframeNote', 4, false)}
    <p class="note">${esc(t('panel.crowd.wildfireNote'))}</p>
    <button class="link-btn" data-m="close">${esc(t('panel.invite.close'))}</button>`, true);
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  m.el.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = async () => {
    const u = snips[b.dataset.copy];
    try { await navigator.clipboard.writeText(u); deps.toast(t('panel.invite.copied'), 3000); }
    catch { const ta = m.el.querySelector(`[data-url="${b.dataset.copy}"]`); if (ta) ta.select(); }
  }; });
  m.el.querySelectorAll('[data-share]').forEach((b) => { b.onclick = () => {
    const u = snips[b.dataset.share];
    if (navigator.share) navigator.share({ url: u, text: t('panel.crowd.shareText') }).catch(() => {});
    else window.open('https://wa.me/?text=' + encodeURIComponent(u), '_blank');
  }; });
}

// Last 50 submissions (worker keeps a rolling log; already-uploaded Drive files are the real archive).
async function crowdSubsModal(rec) {
  const m = modal(`<h3>${esc(t('panel.crowd.subsTitle', { label: rec.label || '' }))}</h3>
    <p class="note">${esc(t('panel.crowd.subsLoading'))}</p>`, true);
  try {
    const r = await Researcher.crowdSubmissions(rec.crowd_id);
    const subs = r.submissions || [];
    const rows = subs.length ? subs.map((s) => `<tr>
      <td>${esc(s.created_at ? new Date(s.created_at).toLocaleString() : '?')}</td>
      <td>${esc(fmtBytes(s.bytes))}</td>
      <td>${esc(s.country || '—')}</td>
      <td>${esc(s.file_name || '—')}</td>
      <td>${esc(s.status || '—')}</td></tr>`).join('')
      : `<tr><td colspan="5" class="note">${esc(t('panel.crowd.subsNone'))}</td></tr>`;
    m.el.querySelector('.modal-card').innerHTML = `
      <h3>${esc(t('panel.crowd.subsTitle', { label: rec.label || '' }))}</h3>
      <p class="note">${esc(t('panel.crowd.subsIntro'))}</p>
      <div class="rp-subs-scroll"><table class="ws-table"><thead><tr>
        <th>${esc(t('panel.crowd.subDate'))}</th><th>${esc(t('panel.crowd.subSize'))}</th><th>${esc(t('panel.crowd.subCountry'))}</th><th>${esc(t('panel.crowd.subFile'))}</th><th>${esc(t('panel.crowd.subStatus'))}</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      <button class="primary-btn" data-m="close">${esc(t('panel.invite.close'))}</button>`;
    m.el.querySelector('[data-m="close"]').onclick = m.close;
  } catch (e) { m.close(); errToast(e); }
}

// Typed-confirmation delete (patterned on wipeConfirmModal): kills the PUBLIC link immediately +
// deletes the submission log; already-uploaded Drive files are NOT touched. Cannot be undone.
function crowdDeleteModal(rec) {
  const m = modal(`
    <h3>${esc(t('panel.crowd.delTitle'))}</h3>
    <p class="note">${esc(t('panel.crowd.delWhat'))}</p>
    <p class="banner warn-banner">${esc(t('panel.crowd.delWarn'))}</p>
    <label class="rp-field"><span>${esc(t('panel.crowd.delTypeLabel', { label: rec.label || 'DELETE' }))}</span>
      <input id="crowd-del-confirm" spellcheck="false" autocomplete="off"></label>
    <button class="primary-btn rp-danger" data-m="go" disabled>${esc(t('panel.crowd.delBtn'))}</button>
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true);
  const input = m.el.querySelector('#crowd-del-confirm');
  const go = m.el.querySelector('[data-m="go"]');
  const want = (rec.label || 'DELETE').trim().toLowerCase();
  input.addEventListener('input', () => { go.disabled = input.value.trim().toLowerCase() !== want; });
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  go.onclick = async () => {
    go.disabled = true; go.textContent = t('panel.crowd.delWorking');
    try {
      await Researcher.crowdDelete(rec.crowd_id);
      m.close(); deps.toast(t('panel.crowd.deleted'), 5000);
      refreshCrowd();
    } catch (e) { errToast(e); go.disabled = false; go.textContent = t('panel.crowd.delBtn'); }
  };
}

/* ---------------- Admin: OWNER-only settings ----------------------------------------------
 * Link sits LEFT of History and renders only for owners (env ALLOWED_RESEARCHERS). ⚠ The hidden
 * link is CONVENIENCE, NOT THE BOUNDARY — every endpoint behind it re-checks isOwner() server-side,
 * because anything enforced only by not drawing a button is enforced by nothing.
 *
 * Replaces the paste-into-console helper in worker/docs/approved-domains.md. That existed because
 * the domain hashes can only be derived inside the Worker; this puts the same four endpoints behind
 * a UI so managing the list never means opening a developer console. */

// Client-side mirror of the Worker's PUBLIC_EMAIL_DOMAINS. Duplicated ON PURPOSE: the server is the
// real gate (it refuses these with a 400), but catching it here turns a round-trip and a raw error
// code into an immediate, plain-language explanation of WHY it is refused.
const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.id', 'ymail.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com', 'yandex.com',
  'qq.com', '163.com', '126.com', 'naver.com', 'web.de', 'mail.ru',
]);

// Normalize what the user typed: accept a full address, a leading @, stray case/dots.
function normDomainInput(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/^[@.\s]+/, '').replace(/[.\s]+$/, '');
  return s.includes('@') ? s.split('@').pop() : s;
}
// Returns an i18n key when the input is unusable, else null.
function domainInputError(d) {
  if (!d) return 'panel.admin.errEmpty';
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(d)) return 'panel.admin.errShape';
  if (PUBLIC_MAIL_DOMAINS.has(d)) return 'panel.admin.errPublic';
  return null;
}

function adminModal() {
  const m = modal(`
    <h3>${esc(t('panel.admin.title'))}</h3>
    <p class="note">${esc(t('panel.admin.intro'))}</p>
    <hr class="rp-sep">
    <div class="rp-adm-sec">
      <div class="rp-adm-h">${esc(t('panel.admin.domTitle'))}</div>
      <p class="note">${esc(t('panel.admin.domIntro'))}</p>
      <div id="rp-adm-list" class="rp-adm-list"><p class="note">…</p></div>
      <p class="note rp-adm-privacy">${esc(t('panel.admin.domPrivacy'))}</p>
      <label class="rp-field"><span>${esc(t('panel.admin.addDomain'))}</span>
        <input id="rp-adm-dom" spellcheck="false" autocapitalize="off" placeholder="${esc(t('panel.admin.addDomainPh'))}"></label>
      <label class="rp-field"><span>${esc(t('panel.admin.addNote'))}</span>
        <input id="rp-adm-note" spellcheck="false" placeholder="${esc(t('panel.admin.addNotePh'))}"></label>
      <button class="primary-btn" id="rp-adm-add">${esc(t('panel.admin.addBtn'))}</button>
      <div id="rp-adm-say" class="rp-adm-say" hidden></div>
    </div>
    <hr class="rp-sep">
    <div class="rp-adm-sec">
      <div class="rp-adm-h">${esc(t('panel.admin.testTitle'))}</div>
      <label class="rp-field"><span>&nbsp;</span>
        <input id="rp-adm-test" spellcheck="false" autocapitalize="off" placeholder="${esc(t('panel.admin.testPh'))}"></label>
      <button class="secondary-btn" id="rp-adm-testbtn">${esc(t('panel.admin.testBtn'))}</button>
      <div id="rp-adm-testsay" class="rp-adm-say" hidden></div>
    </div>
    <hr class="rp-sep">
    <div class="rp-adm-sec">
      <div class="rp-adm-h">${esc(t('panel.admin.logTitle'))}</div>
      <p class="note">${esc(t('panel.admin.logIntro'))}</p>
      <div id="rp-adm-log" class="rp-adm-log"><p class="note">…</p></div>
    </div>
    <hr class="rp-sep">
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true);
  m.el.querySelector('[data-m="close"]').onclick = m.close;

  // The access-control history. Server-side and append-only, so unlike the texts History it
  // survives switching machines — and it is the only record of a DECLINED account, whose row is
  // deleted outright.
  async function refreshLog() {
    const box = m.el.querySelector('#rp-adm-log');
    let rows = [], unavailable = false;
    try { const r = await Researcher.listApprovals(200); rows = r.approvals || []; unavailable = !!r.unavailable; }
    catch (e) { box.innerHTML = `<p class="note rp-adm-err">${esc(String(e.message || e))}</p>`; return; }
    if (!rows.length) { box.innerHTML = `<p class="note">${esc(t(unavailable ? 'panel.admin.logUnavailable' : 'panel.admin.logEmpty'))}</p>`; return; }
    const KINDS = ['account_signup', 'account_auto_approved', 'account_approved', 'account_declined',
                   'domain_added', 'domain_removed', 'files_trashed', 'text_moved'];
    box.innerHTML = `<ul class="rp-adm-ul rp-adm-logul">${rows.map((r) => {
      // SECURITY: kind lands in a class attribute; allow-list it. subject/detail/actor are esc()'d.
      const k = KINDS.includes(r.kind) ? r.kind : 'account_signup';
      return `<li class="rp-log-${k}">
        <span class="rp-tag rp-log-k rp-log-k-${k}">${esc(t('panel.admin.kind.' + k))}</span>
        <span class="rp-adm-note">${esc(r.subject || '—')}</span>
        <span class="note rp-adm-meta">${esc(histWhen(r.at))}${r.detail ? ' · ' + esc(r.detail) : ''}${r.actor && r.actor !== 'system' ? ' · ' + esc(t('panel.admin.byActor', { a: r.actor })) : ''}</span>
      </li>`;
    }).join('')}</ul>`;
  }

  const say = (el, msg, kind) => {
    el.hidden = false; el.textContent = msg;
    el.className = 'rp-adm-say' + (kind ? ' rp-adm-' + kind : '');
  };

  async function refreshList() {
    const box = m.el.querySelector('#rp-adm-list');
    let rows = [];
    try { rows = (await Researcher.listDomains()).domains || []; }
    catch (e) { box.innerHTML = `<p class="note rp-adm-err">${esc(String(e.message || e))}</p>`; return; }
    if (!rows.length) { box.innerHTML = `<p class="note">${esc(t('panel.admin.listEmpty'))}</p>`; return; }
    box.innerHTML = `<ul class="rp-adm-ul">${rows.map((r) => `<li>
      <span class="rp-adm-note">${esc(r.note || '—')}</span>
      <span class="note rp-adm-meta">${esc(t('panel.admin.added_at', { when: lastSeen(r.created_at) }))} · <span class="rp-mono">${esc(r.hash_prefix)}</span></span>
      <button class="link-btn rp-revoke" data-rm="${esc(r.hash_prefix)}" data-note="${esc(r.note || '')}">${esc(t('panel.admin.removeBtn'))}</button>
    </li>`).join('')}</ul>`;
    box.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => removeRow(b.dataset.rm, b.dataset.note, b)));
  }

  // Removal has to name the domain again — the table holds hashes, not names. Rather than trust the
  // typed value, we ask the Worker to hash it and compare against THIS row's prefix, so a typo
  // removes nothing instead of silently deleting a different entry.
  async function removeRow(prefix, note, btn) {
    const typed = prompt(t('panel.admin.removePrompt', { n: note || prefix }));
    if (typed === null) return;
    const d = normDomainInput(typed);
    const err = domainInputError(d);
    const box = m.el.querySelector('#rp-adm-say');
    if (err) return say(box, t(err), 'err');
    try {
      const probe = await busy(btn, () => Researcher.testDomain(d));
      if (probe.hash_prefix !== prefix) return say(box, t('panel.admin.removeMismatch'), 'err');
      await Researcher.removeDomain(d);
      say(box, t('panel.admin.removed', { d }), 'ok');
      refreshList(); refreshLog();
    } catch (e) { say(box, String(e.message || e), 'err'); }
  }

  m.el.querySelector('#rp-adm-add').addEventListener('click', async (e) => {
    const box = m.el.querySelector('#rp-adm-say');
    const d = normDomainInput(m.el.querySelector('#rp-adm-dom').value);
    const err = domainInputError(d);
    if (err) return say(box, t(err), 'err');
    const note = m.el.querySelector('#rp-adm-note').value.trim();
    try {
      await busy(e.target, () => Researcher.addDomain(d, note));
      // VERIFY, don't assume: a 200 proves the row was written, not that the rule works.
      const probe = await Researcher.testDomain('someone@' + d);
      say(box, t(probe.auto_approves ? 'panel.admin.added' : 'panel.admin.addedUnverified', { d }),
          probe.auto_approves ? 'ok' : 'err');
      m.el.querySelector('#rp-adm-dom').value = '';
      m.el.querySelector('#rp-adm-note').value = '';
      refreshList(); refreshLog();
    } catch (e2) { say(box, String(e2.message || e2), 'err'); }
  });

  m.el.querySelector('#rp-adm-testbtn').addEventListener('click', async (e) => {
    const box = m.el.querySelector('#rp-adm-testsay');
    const d = normDomainInput(m.el.querySelector('#rp-adm-test').value);
    if (!d) return say(box, t('panel.admin.errEmpty'), 'err');
    try {
      const r = await busy(e.target, () => Researcher.testDomain(d));
      // Localize from the STRUCTURED result, not the Worker's English `why` string.
      const key = r.public_provider ? 'panel.admin.testPublic'
                : r.auto_approves ? 'panel.admin.testAuto' : 'panel.admin.testManual';
      say(box, t(key, { d: r.domain }), r.public_provider ? 'err' : r.auto_approves ? 'ok' : '');
    } catch (e2) { say(box, String(e2.message || e2), 'err'); }
  });

  refreshList();
  refreshLog();
}

/* Move a text to another device. The Worker re-homes the Drive folder and mints authed streaming
 * URLs; we assign to the destination with the SAME docId (v137 identity — the folder tag already
 * follows), then the render sweep completes the handoff automatically once the destination reports
 * the doc. Upload-first remove at the source means the final copy is in the text's folder before
 * anything is deleted — the same safety order as remote delete. */
function moveTextModal(fromId, docId, title) {
  // ⚠ Only devices on v138+ can RECEIVE a move: older engines ignore the assign's docId and mint
  // their own, so the arrival is invisible to the sweep and the move waits forever (fail-safe —
  // the source is never removed — but wedged). Devices auto-update, so this resolves itself.
  const engOf = (x) => Math.max(0, ...((x.installs || []).map((i) => parseInt(String((i.inventory && i.inventory.engineVersion) || '').replace(/[^0-9]/g, ''), 10) || 0)));
  const insts = ((lastData && lastData.instances) || []).filter((x) => x.instance_id !== fromId);
  if (!insts.length) { deps.toast(t('panel.move.noOther'), 5000); return; }
  for (const x of insts) x._canReceive = engOf(x) >= 138;
  if (!insts.some((x) => x._canReceive)) { deps.toast(t('panel.move.allTooOld'), 7000); return; }
  const m = modal(`
    <h3>${esc(t('panel.move.title', { title }))}</h3>
    <p class="note">${esc(t('panel.move.intro'))}</p>
    ${insts.map((x) => `<label class="rp-field rp-move-opt"><input type="radio" name="rp-move-to" value="${esc(x.instance_id)}" ${x._canReceive ? '' : 'disabled'} ${x === insts.find((y) => y._canReceive) ? 'checked' : ''}> <span>${esc(x.nickname || '?')}${x._canReceive ? '' : ' — ' + esc(t('panel.move.tooOld'))}</span></label>`).join('')}
    <button class="primary-btn" data-m="go">${esc(t('panel.move.go'))}</button>
    <button class="link-btn" data-m="cancel">${esc(t('panel.assign.cancel'))}</button>
    <div class="rp-adm-say" id="rp-move-say" hidden></div>`);
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  m.el.querySelector('[data-m="go"]').addEventListener('click', async (e) => {
    const to = (m.el.querySelector('input[name="rp-move-to"]:checked') || {}).value;
    if (!to) return;
    const say = m.el.querySelector('#rp-move-say');
    try {
      e.target.disabled = true;
      // What content can the destination be given? Newest bare flextext wins; else the newest
      // bundle zip (the Worker extracts the .flextext from our STORE-only zips); audio is the
      // original copy if the folder has one, else the newest recording.
      const bridge = bridgedIds(docId, title);
      let all = [];
      for (const id of bridge.ids) {
        try { all = all.concat((await Researcher.listTextFiles(fromId, id)).files || []); } catch { /* partial */ }
      }
      all.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
      const latest = latestPerKind(all);
      const pick = (k) => (latest.find((f) => f.kind === k) || {}).id || null;
      const fields = { to, flextextFileId: pick('flextext'), extractFromZipId: pick('bundle'),
                       audioFileId: pick('audio-original') || pick('audio') };
      const r = await Researcher.moveText(fromId, docId, fields);
      const assignFields = { title };
      if (r.audioUrl) assignFields.audioUrl = r.audioUrl;
      if (r.flextextUrl) assignFields.flextextUrl = r.flextextUrl;
      if (!assignFields.audioUrl && !assignFields.flextextUrl) {
        // The device only materializes an assignment that carries a resource — with nothing to
        // stream, the move cannot deliver content and must say so instead of half-happening.
        say.hidden = false; say.className = 'rp-adm-say rp-adm-err'; say.textContent = t('panel.move.nothingToMove');
        e.target.disabled = false; return;
      }
      await Researcher.assign(to, docId, assignFields);
      const toName = (insts.find((x) => x.instance_id === to) || {}).nickname || '?';
      recordEvents(Researcher.currentAccountId(), [assignedEvent({ instanceId: to, device: toName, docId, title,
        audioUrl: assignFields.audioUrl || '', flextextUrl: assignFields.flextextUrl || '' })]);
      pendingMoves.set(docId, { from: fromId, to, title, at: Date.now(), stage: 'assigned' });
      saveMoves(Researcher.currentAccountId());
      m.close();
      deps.toast(t('panel.move.sent', { device: toName }), 6000);
      renderDashboard();
    } catch (err) { say.hidden = false; say.className = 'rp-adm-say rp-adm-err'; say.textContent = String(err.message || err); e.target.disabled = false; }
  });
}

/* ---------------- History: the back-log of texts that USED to be on a device ----------------
 * Deliberately a modal rather than a section of the dashboard: the dashboard answers "what is on
 * my devices right now", and mixing in a growing list of things that are gone would bury it. See
 * js/history.js for how the events are observed (and why deletion is the hard one). */

function histWhen(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return '?';
  // Explicit date AND time: "which device, when" is the whole point, and a relative
  // "3 days ago" stops being useful for exactly the old entries this log exists to hold.
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function historyModal() {
  const all = loadHistory(Researcher.currentAccountId());
  let filter = 'all';

  const rowsHtml = () => {
    const list = all.filter((e) => filter === 'all' || e.kind === filter).slice().reverse();   // newest first
    if (!list.length) {
      return `<p class="note rp-hist-empty">${esc(t(all.length ? 'panel.hist.emptyFilter' : 'panel.hist.empty'))}</p>`;
    }
    return `<ul class="rp-hist">${list.map((e) => {
      // SECURITY: kind lands in a class attribute and every other value comes from a field
      // device's own report — allow-list the kind, esc() the rest, and build links only from a
      // Drive-shaped id (history.js/driveLink). Same reasoning as the uploadState allow-list.
      const kind = HISTORY_KINDS.includes(e.kind) ? e.kind : 'assigned';
      const audio = /^https?:\/\//.test(e.audioUrl || '') ? e.audioUrl : '';
      const up = driveLink(e.fileId);
      const by = kind === 'deleted' && e.by === 'researcher' ? ' ' + t('panel.hist.byResearcher')
               : kind === 'deleted' ? ' ' + t('panel.hist.byDevice') : '';
      return `<li class="rp-hist-row rp-hist-${kind}">
        <div class="rp-hist-head">
          <span class="rp-tag rp-hist-k rp-hist-k-${kind}">${esc(t('panel.hist.kind.' + kind))}</span>
          <span class="rp-hist-title">${esc(e.title || t('panel.hist.untitled'))}</span>
        </div>
        <div class="note rp-hist-meta">${esc(histWhen(e.at))}${e.device ? ' · ' + esc(e.device) : ''}${esc(by)}</div>
        <div class="rp-hist-links">
          ${e.instanceId && e.docId ? filesMenuHtml(e.instanceId, e.docId, e.title || '', e.audioUrl, e.fileId) : ''}
          ${kind === 'deleted' && e.instanceId && e.docId ? `<button class="link-btn rp-revoke rp-histclean" data-histclean data-i="${esc(e.instanceId)}" data-id="${esc(e.docId)}" data-title="${esc(e.title || '')}">${esc(t('panel.hist.removeFolder'))}</button>` : ''}
          ${audio && !(e.instanceId && e.docId) ? `<a href="${esc(audio)}" target="_blank" rel="noopener noreferrer">${esc(t('panel.hist.audioLink'))}</a>` : ''}
          ${up && !(e.instanceId && e.docId) ? `<a href="${esc(up)}" target="_blank" rel="noopener noreferrer">${esc(t('panel.hist.uploadLink'))}</a>` : ''}
        </div>
      </li>`;
    }).join('')}</ul>`;
  };

  // ⚠ Say plainly WHEN observation began. Anything deleted before that is unrecordable — the text
  // was already gone, so there was nothing to notice disappearing. Without this line the log just
  // looks broken, which is exactly how it looked after a delete that happened while the browser was
  // still serving a pre-v126 engine.
  const since = recordingSince(Researcher.currentAccountId());
  const sinceLine = since
    ? `<p class="note rp-hist-since">${esc(t('panel.hist.since', { when: histWhen(since) }))}</p>`
    : `<p class="note rp-hist-since">${esc(t('panel.hist.sinceNone'))}</p>`;

  const m = modal(`
    <h3>${esc(t('panel.hist.title'))}</h3>
    <p class="note">${esc(t('panel.hist.intro'))}</p>
    ${sinceLine}
    <div class="rp-hist-filters">
      <button class="link-btn rp-hist-f is-on" data-f="all">${esc(t('panel.hist.all'))}</button>
      ${HISTORY_KINDS.map((k) => `<button class="link-btn rp-hist-f" data-f="${k}">${esc(t('panel.hist.kind.' + k))}</button>`).join('')}
    </div>
    <div id="rp-hist-list">${rowsHtml()}</div>
    <hr class="rp-sep">
    <button class="link-btn rp-danger" data-m="clear">${esc(t('panel.hist.clear'))}</button>
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true);

  const repaint = () => { m.el.querySelector('#rp-hist-list').innerHTML = rowsHtml(); wireDownloadMenus(m.el); };
  wireDownloadMenus(m.el);
  m.el.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.f;
    m.el.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('is-on', x === b));
    repaint();
  }));
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  m.el.querySelector('[data-m="clear"]').onclick = () => {
    // Typed-confirm-free but still explicit: this is the researcher's own local log, not field
    // data, and it is re-derivable for nothing that is still on a device — but the tombstones
    // ARE unrecoverable, so say that in the prompt rather than a generic "are you sure".
    if (!confirm(t('panel.hist.confirmClear'))) return;
    clearHistory(Researcher.currentAccountId());
    all.length = 0;
    repaint();
  };
}

/* ---------------- Utilities: audio converter + FLEx writing-systems checker ----------------
 * Surfaced in the panel as modals; both reuse the SAME engine the editor's Settings tab uses
 * (convertAudio / surveyWritingSystems / remapWritingSystems). All runs locally in the browser. */

function utilitiesModal() {
  const m = modal(`
    <h3>${esc(t('panel.util.title'))}</h3>
    <p class="note">${esc(t('panel.util.intro'))}</p>
    <button class="primary-btn" data-m="audio">${esc(t('panel.util.audio'))}</button>
    <button class="primary-btn" data-m="ws">${esc(t('panel.util.ws'))}</button>
    <hr class="rp-sep">
    <button class="link-btn rp-danger" data-m="erase">${esc(t('panel.erase.btn'))}</button>
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`);
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  m.el.querySelector('[data-m="audio"]').onclick = () => { m.close(); audioConverterModal(); };
  m.el.querySelector('[data-m="ws"]').onclick = () => { m.close(); wsCheckModal(); };
  m.el.querySelector('[data-m="erase"]').onclick = () => { m.close(); eraseDataModal(); };
}

// Complete local wipe of THIS browser → a blank, no-PWA-installed slate (testing + privacy). Behind a
// typed confirm so a reflex tap can't trigger it. Local only — does NOT touch the server (that's the
// separate "delete account" action). Reuses the engine's eraseAllData (injected via deps).
function eraseDataModal(after) {
  const m = modal(`
    <h3>${esc(t('panel.erase.title'))}</h3>
    <p class="note">${esc(t('panel.erase.what'))}</p>
    <p class="banner warn-banner">${esc(t('panel.erase.scope'))}</p>
    <label class="rp-field"><span>${esc(t('panel.erase.typeLabel', { word: t('panel.erase.word') }))}</span>
      <input id="erase-confirm" spellcheck="false" autocomplete="off" autocapitalize="characters"></label>
    <button class="primary-btn rp-danger" data-m="go" disabled>${esc(t('panel.erase.btn'))}</button>
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true);
  const input = m.el.querySelector('#erase-confirm');
  const go = m.el.querySelector('[data-m="go"]');
  const word = t('panel.erase.word');
  input.addEventListener('input', () => { go.disabled = input.value.trim().toUpperCase() !== word.toUpperCase(); });
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  go.onclick = async () => {
    go.disabled = true; go.textContent = t('panel.erase.working');
    try { if (typeof after === 'function') await after(); } catch (e) { errToast(e); go.disabled = false; go.textContent = t('panel.erase.btn'); return; }
    // eraseAllData wipes everything then reloads to a blank slate — if control returns, surface the error.
    try { await deps.eraseAllData(); } catch (e) { errToast(e); go.disabled = false; go.textContent = t('panel.erase.btn'); }
  };
}

// SEPARATE, server-side account deletion (reached from the erase-offline flow). Permanently deletes the
// researcher account + ALL its instances/installs/invites from the server, THEN erases this device. Behind
// its own type-DELETE confirm (distinct from the local ERASE word). ORDER is load-bearing: the SERVER
// delete runs FIRST while still authed, because the local wipe destroys the session token it needs.
function deleteAccountModal() {
  const m = modal(`
    <h3>${esc(t('panel.delacct.title'))}</h3>
    <p class="note">${esc(t('panel.delacct.what'))}</p>
    <p class="banner warn-banner">${esc(t('panel.delacct.warn'))}</p>
    <label class="rp-field"><span>${esc(t('panel.delacct.typeLabel', { word: t('panel.delacct.word') }))}</span>
      <input id="delacct-confirm" spellcheck="false" autocomplete="off" autocapitalize="characters"></label>
    <button class="primary-btn rp-danger" data-m="go" disabled>${esc(t('panel.delacct.btn'))}</button>
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true);
  const input = m.el.querySelector('#delacct-confirm');
  const go = m.el.querySelector('[data-m="go"]');
  const word = t('panel.delacct.word');
  input.addEventListener('input', () => { go.disabled = input.value.trim().toUpperCase() !== word.toUpperCase(); });
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  go.onclick = async () => {
    go.disabled = true; go.textContent = t('panel.delacct.working');
    // 1) delete the SERVER account while still authed.
    try { await Researcher.deleteAccount(); }
    catch (e) {
      // 401/404 = the row is ALREADY gone (a prior attempt committed but its response was lost in transit)
      // → treat as deleted and fall through to the wipe, so a manual retry can't get stuck insisting it
      // "failed" on a dead session. Any other error (offline / 5xx — account still there) → surface + retry.
      if (!(e && (e.status === 401 || e.status === 404))) { errToast(e); go.disabled = false; go.textContent = t('panel.delacct.btn'); return; }
    }
    deps.toast(t('panel.delacct.done'), 6000);
    // 2) Completely wipe THIS device back to a blank slate (the warning copy makes the full scope explicit
    // + this is behind a type-DELETE gate). eraseAllData reloads itself; force a reload too in case it
    // returns, so the user is never left on a frozen modal. (OTHER researcher devices wipe only their
    // console data on their next 401 via purgeLocal — safe, since a 401 isn't always an account delete.
    // Linked FIELD devices keep their texts and just unlink via the 410 path on their next poll.)
    try { await deps.eraseAllData(); } catch { /* noop */ }
    try { location.replace(location.pathname); } catch { /* noop */ }
  };
}

// REMOTE WIPE of a seized/hostile-held device. Typed device-name confirm (strong "are you sure?"). If the
// researcher has 2FA, the worker answers the first attempt with 401 totp_required → we reveal a code field
// and retry (step-up auth on this destructive, remote, irreversible action). The wipe is delivered to the
// device on its NEXT connection, so the copy says so honestly.
function wipeConfirmModal(instanceId, installId, name) {
  let totpShown = false;
  const m = modal(`
    <h3>${esc(t('panel.wipe.title'))}</h3>
    <p class="note">${esc(t('panel.wipe.what'))}</p>
    <p class="banner warn-banner">${esc(t('panel.wipe.warn'))}</p>
    <label class="rp-field"><span>${esc(t('panel.wipe.typeLabel', { name: name || 'WIPE' }))}</span>
      <input id="wipe-confirm" spellcheck="false" autocomplete="off"></label>
    <div id="wipe-totp" hidden><label class="rp-field"><span>${esc(t('panel.wipe.totpLabel'))}</span>
      <input id="wipe-totp-code" inputmode="numeric" autocomplete="off" spellcheck="false"></label></div>
    <button class="primary-btn rp-danger" data-m="go" disabled>${esc(t('panel.wipe.btn'))}</button>
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true);
  const input = m.el.querySelector('#wipe-confirm');
  const go = m.el.querySelector('[data-m="go"]');
  const want = (name || 'WIPE').trim().toLowerCase();
  input.addEventListener('input', () => { go.disabled = input.value.trim().toLowerCase() !== want; });
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  go.onclick = async () => {
    const code = totpShown ? m.el.querySelector('#wipe-totp-code').value.trim() : undefined;
    go.disabled = true; go.textContent = t('panel.wipe.working');
    try {
      await Researcher.wipeInstall(instanceId, installId, code);
      m.close(); deps.toast(t('panel.wipe.sent'), 6000); renderDashboard();
    } catch (e) {
      if (e && e.status === 401 && e.data && e.data.error === 'totp_required' && !totpShown) {
        totpShown = true; m.el.querySelector('#wipe-totp').hidden = false;
        deps.toast(t('panel.wipe.needTotp'), 6000);
        go.textContent = t('panel.wipe.btn'); go.disabled = false; return;   // name already matched → re-enable for the code
      }
      errToast(e); go.disabled = false; go.textContent = t('panel.wipe.btn');
    }
  };
}

// Recording-format help — reuses the editor's trusted recfmt.* i18n HTML (incl. the archive-acceptance table).
function recfmtHelpModal() {
  const ps = ['recfmt.helpKeep', 'recfmt.helpRaw', 'recfmt.helpProcessing', 'recfmt.helpBits', 'recfmt.helpWavFlac',
    'recfmt.helpMono', 'recfmt.helpRate', 'recfmt.helpMp3', 'recfmt.helpWebm', 'recfmt.helpArchives'];
  const body = ps.map((k) => `<p>${t(k)}</p>`).join('') + `<div>${t('recfmt.helpTable')}</div><p>${t('recfmt.helpTech')}</p><p class="note">${t('recfmt.helpCourse')}</p>`;
  const m = modal(`<h3>${esc(t('recfmt.helpTitle'))}</h3><div class="help-body">${body}</div>
    <button class="primary-btn" data-m="close">${esc(t('recfmt.helpClose'))}</button>`, true);
  m.el.querySelector('[data-m="close"]').onclick = m.close;
}

// Map a label to a validOutputs() option value (en/id come from i18n; fall back to the raw value).
function cvFmtLabel(v) { const s = t('convert.fmt.' + v); return s === 'convert.fmt.' + v ? v : s; }

// A small WaveSurfer player (matches the baseline tab's look): a play/pause button + a waveform.
// split:true stacks one waveform PER CHANNEL, so a stereo file shows both — the user can see which
// channel carries the voice before choosing a mono mode. normalize is OFF when split so a near-silent
// channel reads as flat (honest) instead of being boosted to look like signal.
function cvMakePlayer(host, url, split) {
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

function audioConverterModal() {
  let srcBuf = null, srcInfo = null, srcName = '', srcSize = 0;
  let srcWs = null, outWs = null, srcUrl = null, outUrl = null;
  const destroyPlayers = () => {
    for (const w of [srcWs, outWs]) { try { w && w.destroy(); } catch { /* noop */ } }
    for (const u of [srcUrl, outUrl]) { try { u && URL.revokeObjectURL(u); } catch { /* noop */ } }
    srcWs = outWs = srcUrl = outUrl = null;
  };
  const m = modal(`
    <h3>${esc(t('convert.h'))} <button class="rp-help-inline" data-m="help" aria-label="${esc(t('recfmt.helpLink'))}" title="${esc(t('recfmt.helpLink'))}">?</button></h3>
    <p class="note">${esc(t('convert.note2'))}</p>
    <button class="primary-btn" data-m="pick">${esc(t('convert.pick'))}</button>
    <input type="file" id="cv-file" accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac,.ogg" hidden>
    <div id="cv-form" hidden>
      <p class="note rp-cv-src" id="cv-src"></p>
      <p class="note cv-cap" id="cv-before-cap" hidden>${esc(t('convert.before'))}</p>
      <div id="cv-src-player" class="cv-player" hidden></div>
      <p class="note cv-cap" id="cv-chan-hint" hidden>${esc(t('convert.chanHint'))}</p>
      <label class="rp-field"><span>${esc(t('convert.outFmt'))}</span><select id="cv-fmt"></select></label>
      <label class="rp-field" id="cv-mono-row"><span>${esc(t('convert.monoMode'))}</span>
        <select id="cv-mono">
          <option value="keep">${esc(t('convert.mono.keep'))}</option>
          <option value="auto" selected>${esc(t('convert.mono.auto'))}</option>
          <option value="mix">${esc(t('convert.mono.mix'))}</option>
          <option value="left">${esc(t('convert.mono.left'))}</option>
          <option value="right">${esc(t('convert.mono.right'))}</option>
        </select></label>
      <div id="cv-mp3opts">
        <label class="rp-field"><span>${esc(t('convert.kbps'))}</span>
          <select id="cv-kbps"><option value="32">32</option><option value="48">48</option><option value="64" selected>64</option><option value="96">96</option><option value="128">128</option></select></label>
        <label class="rp-field"><span>${esc(t('convert.rate'))}</span>
          <select id="cv-rate"><option value="16000">16000</option><option value="22050" selected>22050</option><option value="44100">44100</option></select></label>
      </div>
      <button class="primary-btn" data-m="go">${esc(t('convert.go'))}</button>
    </div>
    <p class="note" id="cv-status" hidden></p>
    <div id="cv-out-wrap" hidden>
      <p class="note cv-cap">${esc(t('convert.after'))}</p>
      <div id="cv-out-player" class="cv-player"></div>
    </div>
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true, destroyPlayers);
  const $$ = (s) => m.el.querySelector(s);
  const status = $$('#cv-status'), form = $$('#cv-form'), fmtSel = $$('#cv-fmt'), monoRow = $$('#cv-mono-row'), mp3opts = $$('#cv-mp3opts');
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  m.el.querySelector('[data-m="help"]').onclick = recfmtHelpModal;
  m.el.querySelector('[data-m="pick"]').onclick = () => $$('#cv-file').click();

  const syncMp3Vis = () => {
    const o = (srcInfo && srcInfo.outs.find((x) => x.value === fmtSel.value)) || {};
    mp3opts.hidden = o.format !== 'mp3';
  };
  fmtSel.addEventListener('change', syncMp3Vis);

  const setStereoUi = (stereo) => { monoRow.hidden = !stereo; $$('#cv-chan-hint').hidden = !stereo; };

  $$('#cv-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    destroyPlayers();                                           // tear down any previous file's players
    $$('#cv-out-wrap').hidden = true; status.hidden = true;
    srcName = file.name; srcSize = file.size;
    try { srcBuf = await file.arrayBuffer(); } catch (err) { status.hidden = false; status.textContent = t('convert.failed', { msg: err.message }); return; }
    const fmt = detectFormat(srcBuf);
    let bits = null, chans = null, rate = null;
    if (fmt === 'wav') { const h = readWavHeader(srcBuf); if (h) { bits = h.bitsPerSample; chans = h.channels; rate = h.sampleRate; } }
    const outs = validOutputs(fmt, bits);
    srcInfo = { fmt, bits, chans, outs };
    // Source summary line (what we cheaply know). esc'd — file metadata is untrusted.
    const parts = [fmt ? fmt.toUpperCase() : t('convert.fmtUnknown')];
    if (bits) parts.push(t('convert.bit', { n: bits }));
    if (chans) parts.push(chans >= 2 ? t('convert.stereo') : t('convert.monoSrc'));
    if (rate) parts.push(rate + ' Hz');
    parts.push(fmtSize(srcSize));
    $$('#cv-src').textContent = t('convert.src', { name: srcName, detail: parts.join(' · ') });
    fmtSel.innerHTML = outs.map((o) => `<option value="${esc(o.value)}">${esc(cvFmtLabel(o.value))}</option>`).join('');
    setStereoUi(chans == null || chans >= 2);   // assume stereo until the decoded channel count says otherwise
    $$('#cv-before-cap').hidden = false;
    form.hidden = false; syncMp3Vis();
    // "Before" player: per-channel waveforms + playback. The decoded channel count is the authority
    // (covers non-WAV sources we can't header-sniff) — refine the mono controls once it's ready.
    srcUrl = URL.createObjectURL(file);
    srcWs = cvMakePlayer($$('#cv-src-player'), srcUrl, true);
    srcWs.on('ready', () => {
      let nch = chans || 1; try { const d = srcWs.getDecodedData(); if (d) nch = d.numberOfChannels; } catch { /* noop */ }
      setStereoUi(nch >= 2);
    });
  });

  m.el.querySelector('[data-m="go"]').onclick = async () => {
    if (!srcBuf || !srcInfo) return;
    const o = srcInfo.outs.find((x) => x.value === fmtSel.value); if (!o) return;
    const opts = { format: o.format, mono: monoRow.hidden ? 'keep' : $$('#cv-mono').value };
    if (o.format === 'wav') opts.wavBits = o.wavBits;
    if (o.format === 'flac') opts.flacBits = o.flacBits;
    if (o.format === 'mp3') { opts.kbps = parseInt($$('#cv-kbps').value, 10); opts.sampleRate = parseInt($$('#cv-rate').value, 10); }
    status.hidden = false; status.textContent = t('convert.working', { pct: 0 });
    try {
      const res = await convertAudio(srcBuf, opts, (f) => { status.textContent = t('convert.working', { pct: Math.round(f * 100) }); });
      const outName = srcName.replace(/\.[^.]+$/, '') + '.' + res.ext;
      const dlUrl = URL.createObjectURL(res.blob);
      const a = document.createElement('a'); a.href = dlUrl; a.download = outName; a.click();
      setTimeout(() => URL.revokeObjectURL(dlUrl), 30000);
      status.textContent = t('convert.done', { name: outName, out: fmtSize(res.blob.size), in: fmtSize(srcSize) });
      // "After" player on the converted result (its own object URL, released on re-convert / close).
      try { if (outWs) outWs.destroy(); } catch { /* noop */ }
      try { if (outUrl) URL.revokeObjectURL(outUrl); } catch { /* noop */ }
      outUrl = URL.createObjectURL(res.blob);
      $$('#cv-out-wrap').hidden = false;
      outWs = cvMakePlayer($$('#cv-out-player'), outUrl, false);
    } catch (err) { status.textContent = t('convert.failed', { msg: err.message }); }
  };
}

// FLEx writing-system-codes help — adapted from Seth's writing-system-codes doc (trusted i18n HTML) + the
// vern_writ_sys.png screenshot precached in the SW shell so it works offline.
function wsCodesHelpModal() {
  const m = modal(`<div class="rp-help wsc-help">${t('panel.wscodes.html')}</div>
    <button class="primary-btn" data-m="close">${esc(t('panel.help.close'))}</button>`, true);
  m.el.querySelector('[data-m="close"]').onclick = m.close;
}

function wsCheckModal() {
  let wsState = null;
  const m = modal(`
    <h3>${esc(t('panel.util.ws'))} <button class="rp-help-inline" data-m="help" aria-label="?" title="?">?</button></h3>
    <p class="note">${esc(t('panel.util.wsIntro'))}</p>
    <button class="primary-btn" data-m="pick">${esc(t('research.checkBtn'))}</button>
    <input type="file" id="wsc-file" accept=".flextext,.xml,.txt,text/plain,text/xml,application/xml" hidden>
    <div id="wsc-result" hidden>
      <p id="wsc-name" class="note"></p>
      <table class="ws-table"><thead><tr><th>${esc(t('ws.line'))}</th><th>${esc(t('ws.code'))}</th><th>${esc(t('ws.count'))}</th><th>${esc(t('ws.changeTo'))}</th></tr></thead><tbody id="wsc-rows"></tbody></table>
      <button class="primary-btn" data-m="apply">${esc(t('research.downloadCorrected'))}</button>
    </div>
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true);
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  m.el.querySelector('[data-m="help"]').onclick = wsCodesHelpModal;
  m.el.querySelector('[data-m="pick"]').onclick = () => m.el.querySelector('#wsc-file').click();
  m.el.querySelector('#wsc-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    let res;
    try { res = surveyWritingSystems(await file.text()); } catch (err) { deps.toast(t('toast.importFailed', { msg: err.message }), 6000); return; }
    if (res.error) { deps.toast(t('toast.importFailed', { msg: res.error }), 6000); return; }
    wsState = { dom: res.dom, filename: file.name };
    m.el.querySelector('#wsc-name').textContent = t('research.declared', { name: file.name, list: res.declared.length ? res.declared.map((l) => `${l.lang}${l.vernacular ? ' ★' : ''}`).join(', ') : t('research.noneDeclared') });
    const tbody = m.el.querySelector('#wsc-rows'); tbody.innerHTML = '';
    for (const r of res.rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td><code></code></td><td></td><td><input class="ws-newcode" spellcheck="false"></td>';
      tr.children[0].textContent = t(r.label);
      tr.children[1].firstChild.textContent = r.lang;   // textContent: lang codes from the file are attacker-controllable
      tr.children[2].textContent = r.count;
      const inp = tr.querySelector('input'); inp.placeholder = t('ws.keepPh'); inp.dataset.selector = r.selector; inp.dataset.fromLang = r.lang;
      tbody.appendChild(tr);
    }
    m.el.querySelector('#wsc-result').hidden = false;
  });
  m.el.querySelector('[data-m="apply"]').onclick = () => {
    if (!wsState) return;
    const mappings = Array.from(m.el.querySelectorAll('#wsc-rows .ws-newcode')).filter((i) => i.value.trim())
      .map((i) => ({ selector: i.dataset.selector, fromLang: i.dataset.fromLang, toLang: i.value.trim() }));
    const xml = '<?xml version="1.0" encoding="utf-8"?>\n' + remapWritingSystems(wsState.dom, mappings).replace(/^<\?xml[^>]*\?>\s*/i, '');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
    a.download = wsState.filename.replace(/(\.flextext|\.xml)?$/i, (mm) => mm || '.flextext'); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    deps.toast(mappings.length ? t('toast.corrected') : t('toast.noChanges'));
  };
}

function accountModal() {
  const m = modal(`
    <h3>${esc(t('panel.account.title'))}</h3>
    <div class="rp-field"><span>${esc(t('panel.account.signedInAs'))}</span><div class="rp-readonly">${esc(Researcher.accountEmail() || '')}</div></div>
    <label class="check-label"><input type="checkbox" data-m="stay"${Researcher.staySignedIn() ? ' checked' : ''}> ${esc(t('panel.account.stay'))}</label>
    <p class="note">${esc(t('panel.account.stayNote'))}</p>
    <button class="link-btn" data-m="signout">${esc(t('panel.account.signout'))}</button>
    <hr class="rp-sep">
    <div class="rp-field"><span>${esc(t('panel.drive.title'))}</span>
      <div id="rp-drive-body"><p class="note">${esc(t('panel.drive.loading'))}</p></div></div>
    <hr class="rp-sep">
    <p class="note">${esc(t('panel.delacct.intro'))}</p>
    <button class="link-btn rp-danger" data-m="delacct">${esc(t('panel.delacct.link'))}</button>
    <button class="link-btn" data-m="close">${esc(t('panel.invite.close'))}</button>`, true);

  m.el.querySelector('[data-m="close"]').onclick = m.close;
  m.el.querySelector('[data-m="stay"]').onchange = (e) => Researcher.setStaySignedIn(e.target.checked);
  m.el.querySelector('[data-m="signout"]').onclick = () => {
    if (!confirm(t('panel.account.confirmSignout'))) return;
    Researcher.signOut(); m.close(); deps.onSignedUp && deps.onSignedUp(); route();
  };
  m.el.querySelector('[data-m="delacct"]').onclick = () => { m.close(); deleteAccountModal(); };   // permanent server-side account delete
  driveSection(m.el.querySelector('#rp-drive-body'));
}

/* Drive-delivery section (inside the account modal). There is NO mode and NO switch:
 * crowd uploads always try the researcher's OWN Drive first (streaming, via the token
 * their Google sign-in stores) and fall back to the shared relay automatically. This
 * section just shows the connection state, surfaces any background delivery failure
 * loudly, and offers a live test. Error codes are translated into plain-language fix
 * steps — the idiot-proof rule applies to researchers too. */
function driveSection(body) {
  // Worker error codes → plain language. Codes come from OUR worker (not attacker data), but esc()'d anyway.
  const explain = (e) => {
    const code = (e && e.message) || '';
    if (code === 'reconnect_needed') return t('panel.drive.reconnectNeeded');
    if (code === 'drive_api_disabled') return t('panel.drive.apiDisabled');
    if (code === 'oauth_unconfigured') return t('panel.drive.oauthUnconfigured');
    return t('panel.err', { msg: code || String(e) });
  };
  const load = async () => {
    body.innerHTML = `<p class="note">${esc(t('panel.drive.loading'))}</p>`;
    let st;
    try { st = await Researcher.driveStatus(); }
    catch {
      // Tolerate a fetch failure with an inline retry — never a dead section in the account modal.
      body.innerHTML = `<p class="note">${esc(t('panel.drive.loadFail'))} <button type="button" class="link-btn" data-d="retry">${esc(t('panel.drive.retry'))}</button></p>`;
      body.querySelector('[data-d="retry"]').onclick = load;
      return;
    }
    body.innerHTML = `
      ${st.error ? `<p class="banner warn-banner">${esc(t('panel.drive.errBanner', { msg: (st.error && st.error.msg) || '' }))} ${esc(t('panel.drive.reconnectNeeded'))}</p>` : ''}
      <p class="note">${esc(st.connected ? t('panel.drive.how', { email: st.email || '?' }) : t('panel.drive.notConnected'))}</p>
      <div class="rp-inst-actions">
        <button type="button" class="secondary-btn" data-d="test">${esc(t('panel.drive.test'))}</button>
      </div>
      <div class="rp-probe-result" role="status" hidden></div>`;
    const out = body.querySelector('.rp-probe-result');
    const paint = (msg, kind) => { out.hidden = false; out.textContent = msg; out.className = 'rp-probe-result' + (kind ? ' rp-as-' + kind : ''); };
    body.querySelector('[data-d="test"]').addEventListener('click', (e) => busy(e.target, async () => {
      paint(t('panel.drive.testing'));
      try { const r = await Researcher.driveTest(); paint(t('panel.drive.testOk') + ((r && r.note) ? ' — ' + r.note : ''), 'ok'); }
      catch (err) { paint(explain(err), 'err'); }
    }));
  };
  load();
}

/* ---------------- the reusable tabbed settings modal ---------------- */

function fieldHtml(f) {
  const label = esc(t('panel.f.' + f.k));
  // f.tip → hover tooltip on the label + input (e.g. the WS-code case warning).
  const tip = f.tip ? ` title="${esc(t(f.tip))}"` : '';
  if (f.type === 'checkbox') {
    const cb = `<label class="check-label"><input type="checkbox" data-f="${f.k}"> ${label}</label>`;
    // Auto-backup needs its "what actually happens" note (new timestamped copy per backup; the
    // quiet-time wait stops a copy per keystroke) — without it researchers expect an overwrite.
    if (f.k === 'autoBackup') return cb + `<p class="note">${esc(t('panel.f.autoBackupNote'))}</p>`;
    if (f.note) return cb + `<p class="note">${esc(t(f.note))}</p>`;
    return cb;
  }
  if (f.type === 'multicheck') {
    const boxes = f.opts.map((o) => `<label class="check-label rp-inline"><input type="checkbox" data-f="${f.k}" data-v="${o}"> ${esc(t((f.optPrefix || '') + o))}</label>`).join('');
    return `<div class="rp-field"><span>${label}</span><div class="rp-multi">${boxes}</div></div>`;
  }
  if (f.type === 'action') {
    const note = f.k === 'archivalDefaults' ? `<p class="note">${esc(t('panel.f.archivalNote'))}</p>` : '';
    return `<div class="rp-field"><button type="button" class="secondary-btn" data-gact="${f.k}">${label}</button></div>${note}`;
  }
  if (f.type === 'range') {
    // Max-duration slider (0 = no limit) with a live duration label + size readout
    // that tracks the recording-format select (mirrors the crowd editor's estimate).
    return `<label class="rp-field"><span>${label} — <span id="rp-maxrec-lbl"></span></span><input type="range" data-f="${f.k}" min="0" max="3600" step="10"></label><p class="note" id="rp-maxrec-est"></p>`;
  }
  if (f.type === 'select') {
    const opts = f.opts.map((o) => `<option value="${o}">${esc(f.optPrefix ? t(f.optPrefix + o) : o)}</option>`).join('');
    // The recording format is the one setting whose consequences are invisible here: it decides how
    // long a cheap phone can record before the app has to stop it, and whether the result can be
    // called an archival master at all. Neither is guessable from a format name in a dropdown.
    const help = f.k === 'recordFormat'
      ? `<p class="note"><a href="/flextext-editor/help/recording-limits.html" target="_blank" rel="noopener">${esc(t('panel.f.recordFormatHelp'))}</a></p>`
      : '';
    return `<label class="rp-field"><span>${label}</span><select data-f="${f.k}">${opts}</select></label>${help}`;
  }
  if (f.type === 'textarea') return `<label class="rp-field"><span>${label}</span><textarea data-f="${f.k}" rows="2"></textarea></label>`;
  // f.note → an explanatory line under the input. Generic on purpose: several fields have
  // meanings that are NOT obvious from a short label (e.g. consent audio is the prompt PLAYED to
  // the speaker, not their recorded answer).
  const note = f.note ? `<p class="note">${t(f.note)}</p>` : '';
  const input = `<label class="rp-field"${tip}><span>${label}</span><input data-f="${f.k}" spellcheck="false"${tip}></label>${note}`;
  return input;
}

// Hide deviceOnly fields (e.g. appLang) in the researcher's OWN local-settings modal — there the live
// #lang-select toggle already covers the UI language, so a duplicate control would be a confusing no-op.
function groupFields(g, mode) { return g.fields.filter((f) => !(f.deviceOnly && mode === 'local')); }
// A prominent, plain-language warning box at the top of a settings group. Used to tell a
// researcher that a website-installed (PWA) device cannot make archive-quality recordings —
// the single most consequential thing they can get wrong without ever being told.
function noticeHtml(kind) {
  if (kind !== 'pwaAudio') return '';
  const link = NATIVE_DOWNLOADS_URL
    ? `<p><a href="${esc(NATIVE_DOWNLOADS_URL)}" target="_blank" rel="noopener noreferrer">${esc(t('panel.notice.audioGet'))}</a></p>`
    : `<p class="note">${esc(t('panel.notice.audioSoon'))}</p>`;
  return `<div class="rp-notice"><b>${esc(t('panel.notice.audioTitle'))}</b>${t('panel.notice.audioBody')}${link}</div>`;
}

function groupHtml(g, mode) {
  // The TAB label (panel.grp.<id>) and the fieldset heading may differ (g.legend):
  // e.g. the Languages tab's fieldset is headed "FLEx Writing System Codes".
  // g.helpModal renders an inline "more info…" that opens the in-panel help modal —
  // NOT a new-tab link: the editor SW's navigate fallback serves the app shell for
  // any non-precached in-scope URL, so same-scope help pages can't be linked from
  // inside the PWA. The modal also works offline and follows the panel language.
  const help = g.helpModal ? `<button type="button" class="link-btn rp-legend-help" data-ghelp="${g.helpModal}">${esc(t('panel.grp.moreInfo'))}</button>` : '';
  const fields = groupFields(g, mode);
  const outside = fields.filter((f) => f.outside).map(fieldHtml).join('');   // e.g. appLang sits above the codes fieldset
  const inside = fields.filter((f) => !f.outside).map(fieldHtml).join('');
  const notice = g.notice ? noticeHtml(g.notice) : '';
  return `<div class="rp-group" id="rp-grp-${g.id}" role="tabpanel" aria-labelledby="rp-tab-${g.id}" data-group="${g.id}" hidden>${notice}${outside}<fieldset class="rp-fieldset"><legend>${esc(t(g.legend || 'panel.grp.' + g.id))}</legend>${help}${inside}</fieldset></div>`;
}

// Map stored settings → canonical form values (mode-aware on the divergent fields).
function toFormValues(s, mode) {
  s = s || {};
  const v = {};
  for (const g of GROUPS) for (const f of groupFields(g, mode)) {
    if (f.type === 'action') continue;
    if (f.k === 'sendOptions') v.sendOptions = (mode === 'local' ? s.linkSendOptions : s.sendOptions) || [];
    else if (f.k === 'buttons') v.buttons = (mode === 'local' ? s.linkButtons : s.toolbarButtons) || [];
    // Consent multi-select: prefer the new arrays; else migrate the old single consentMode/consentResp.
    else if (f.k === 'consentAsk') v.consentAsk = Array.isArray(s.consentAsk) ? s.consentAsk
      : (s.consentMode && s.consentMode !== 'off' ? [s.consentMode] : []);
    else if (f.k === 'consentConfirm') v.consentConfirm = Array.isArray(s.consentConfirm) ? s.consentConfirm
      : (s.consentMode && s.consentMode !== 'off' ? [s.consentResp || 'yesno'] : []);
    // appLang is a one-shot "set the device language" command, NOT a persistent setting to display:
    // always open at 'follow' so it's re-sent ONLY when the researcher deliberately re-picks a language
    // (else every later push would re-clobber a field worker who toggled their own language back).
    else if (f.k === 'appLang') v.appLang = 'follow';
    else if (f.k === 'autoDel') v.autoDel = !!s.autoDelUploaded;                                   // stored as autoDelUploaded
    // Export toggles: unset follows Audio Segmentation Mode — show the EFFECTIVE value, so the
    // researcher sees what the device will actually do, not a misleading unchecked box.
    else if (f.k === 'exportEaf' || f.k === 'exportSaymore' || f.k === 'exportPreview' || f.k === 'exportJson') v[f.k] = s[f.k] ?? !!s.segmentation;
    else if (f.k === 'autoBackupMins') v.autoBackupMins = String(s.autoBackupMins || 15);          // stored as a number; default 15
    else if (f.type === 'checkbox') v[f.k] = !!s[f.k];
    else if (f.type === 'select') v[f.k] = s[f.k] || (f.k === 'recordFormat' ? DEFAULT_REC_FORMAT : f.opts[0]);
    else if (f.type === 'range') v[f.k] = parseInt(s[f.k], 10) || 0;
    else v[f.k] = s[f.k] || '';
  }
  return v;
}

function fillForm(box, v) {
  box.querySelectorAll('[data-f]').forEach((el) => {
    const k = el.dataset.f;
    if (el.type === 'checkbox') {
      if (el.dataset.v) el.checked = Array.isArray(v[k]) && v[k].includes(el.dataset.v);
      else el.checked = !!v[k];
    } else { el.value = v[k] != null ? v[k] : ''; }
  });
}

// Collect the form's raw values keyed by canonical field id (vernLang, upload, sendOptions, …).
// Shared by readForm (→ settings patch) and validateDeviceSettings (→ required-field check).
function collectRaw(box) {
  const raw = {};
  box.querySelectorAll('[data-f]').forEach((el) => {
    const k = el.dataset.f;
    if (el.type === 'checkbox' && el.dataset.v) { (raw[k] = raw[k] || []); if (el.checked) raw[k].push(el.dataset.v); }
    else if (el.type === 'checkbox') raw[k] = el.checked;
    else raw[k] = (el.value || '').trim();
  });
  return raw;
}

// Read the form → a settings patch (mode-aware on divergent keys).
function readForm(box, mode) {
  const raw = collectRaw(box);
  const patch = {};
  const SPECIAL = ['sendOptions', 'buttons', 'autoDel', 'consentAudioUrl', 'autoBackupMins', 'maxRecordSeconds'];
  for (const g of GROUPS) for (const f of groupFields(g, mode)) {
    if (SPECIAL.includes(f.k) || f.type === 'action') continue;
    patch[f.k] = raw[f.k];
  }
  // appLang 'follow' (or unset) = "don't change this device's language" → never push it (it would
  // clobber a field worker's own toggle choice). Only an explicit en/id is sent (set-with-override).
  if (patch.appLang === 'follow' || !patch.appLang) delete patch.appLang;
  // autoDel checkbox is stored as autoDelUploaded (the key the field client reads).
  patch.autoDelUploaded = !!raw.autoDel;
  // autoBackup rides the generic path (boolean); the minutes select is a string → the device wants a number.
  patch.autoBackupMins = parseInt(raw.autoBackupMins, 10) || 15;
  patch.maxRecordSeconds = parseInt(raw.maxRecordSeconds, 10) || 0;   // 0 = no limit
  // Consent audio: store the raw link AND the resolved URL the device actually plays.
  patch.consentAudioUrl = raw.consentAudioUrl || '';
  patch.consentAudio = (raw.consentAudioUrl && deps.resolveAudioInput) ? deps.resolveAudioInput(raw.consentAudioUrl) : '';
  if (mode === 'local') {
    patch.linkSendOptions = raw.sendOptions || [];
    patch.linkButtons = raw.buttons || [];
  } else {
    patch.sendOptions = raw.sendOptions || [];
    patch.toolbarButtons = raw.buttons || [];
  }
  return patch;
}

/* ---------------- required-settings validation ----------------
 * Minimal-usable check: flag anything blank that would BREAK a device in the field, so a researcher
 * can neither push broken settings nor mint an invite for a misconfigured device. Required:
 *   • vernacular + analysis language CODES — no codes → no writing system (app.js builds the WS only
 *     when vernLang is set; analLang silently falls back to 'en', i.e. wrong for non-English work);
 *   • a Google Drive folder IF "Upload" is an enabled send button — else the upload button silently
 *     never appears (app.js shows it only when uploadFolder is set);
 *   • the consent AUDIO link IF consent mode is Audio (else the audio consent step has nothing to play);
 *   • the consent MESSAGE IF consent mode is Text (else the text consent screen is blank).
 * Everything else has a safe default/fallback. Returns [{ group, field, msg }] (empty = OK). */
function validateDeviceSettings(raw, opts = {}) {
  const { parseFolder, uploadIsUrl } = opts;
  const blank = (v) => !v || !String(v).trim();
  const out = [];
  if (blank(raw.vernLang)) out.push({ group: 'languages', field: 'vernLang', msg: t('panel.val.vernLang') });
  if (blank(raw.analLang)) out.push({ group: 'languages', field: 'analLang', msg: t('panel.val.analLang') });
  // No upload-folder requirement any more: linked devices stream into the
  // researcher's own Drive automatically (the relay leg is retired).
  const ask = Array.isArray(raw.consentAsk) ? raw.consentAsk : [];
  if (ask.includes('audio') && blank(raw.consentAudioUrl)) out.push({ group: 'consent', field: 'consentAudioUrl', msg: t('panel.val.consentAudio') });
  if (ask.includes('text') && blank(raw.consentMsg)) out.push({ group: 'consent', field: 'consentMsg', msg: t('panel.val.consentMsg') });
  return out;
}

// Map a stored settings snapshot (device keys) → the canonical shape validateDeviceSettings reads.
function settingsToRaw(s) {
  s = s || {};
  return {
    vernLang: s.vernLang, analLang: s.analLang,
    sendOptions: s.sendOptions || [],
    consentAsk: Array.isArray(s.consentAsk) ? s.consentAsk : (s.consentMode && s.consentMode !== 'off' ? [s.consentMode] : []),
    consentConfirm: Array.isArray(s.consentConfirm) ? s.consentConfirm : (s.consentMode && s.consentMode !== 'off' ? [s.consentResp || 'yesno'] : []),
    consentAudioUrl: s.consentAudioUrl, consentMsg: s.consentMsg,
  };
}

// Paint validation errors VERY explicitly so the researcher can't miss what's blocking the save:
//   1. a persistent banner above the tabs listing each blocked field WITH its tab name (each entry
//      clicks through to that field) — survives tab switches so multi-tab errors are all visible;
//   2. a red marker dot on every offending tab;
//   3. a red ring + inline "why" message on each field;
//   4. jump to + focus the first offending field;
//   5. a toast naming the first blocker (field + tab).
// All of it is cleared and recomputed on every save attempt.
function flagProblems(box, problems, showGroup) {
  box.querySelectorAll('.rp-invalid').forEach((el) => el.classList.remove('rp-invalid'));
  box.querySelectorAll('.rp-fielderr').forEach((el) => el.remove());
  box.querySelectorAll('.rp-tab.rp-tab-err').forEach((el) => el.classList.remove('rp-tab-err'));
  const oldBanner = box.querySelector('.rp-valbanner'); if (oldBanner) oldBanner.remove();

  const labelFor = (p) => t('panel.val.fieldAtTab', { field: t('panel.f.' + p.field), tab: t('panel.grp.' + p.group) });

  for (const p of problems) {
    const el = box.querySelector(`[data-f="${p.field}"]`);
    if (el) {
      const wrap = el.closest('.rp-field, .check-label') || el;
      wrap.classList.add('rp-invalid');
      const err = document.createElement('div');
      err.className = 'rp-fielderr';
      err.textContent = p.msg;
      wrap.appendChild(err);
    }
    const tab = box.querySelector(`.rp-tab[data-tab="${p.group}"]`);
    if (tab) tab.classList.add('rp-tab-err');   // mark the tab so errors on other tabs are visible too
  }

  // Persistent "what's blocking + which tab" banner, above the tabs; each item jumps to its field.
  const banner = document.createElement('div');
  banner.className = 'rp-valbanner';
  banner.innerHTML = `<strong>${esc(t('panel.val.bannerTitle'))}</strong><ul>${problems.map((p) =>
    `<li><button type="button" class="rp-valjump" data-grp="${esc(p.group)}" data-fld="${esc(p.field)}">${esc(labelFor(p))}</button></li>`).join('')}</ul>`;
  const tabs = box.querySelector('.rp-tabs');
  if (tabs && tabs.parentNode) tabs.parentNode.insertBefore(banner, tabs);
  else box.appendChild(banner);
  banner.querySelectorAll('.rp-valjump').forEach((btn) => btn.addEventListener('click', () => {
    showGroup(btn.dataset.grp);
    const f = box.querySelector(`[data-f="${btn.dataset.fld}"]`);
    if (f) { try { f.focus(); } catch { /* noop */ } }
  }));

  if (showGroup && problems[0]) showGroup(problems[0].group);
  const first = problems[0] && box.querySelector(`[data-f="${problems[0].field}"]`);
  if (first) { try { first.focus(); } catch { /* noop */ } }

  const firstLabel = labelFor(problems[0]);
  deps.toast(problems.length === 1
    ? t('panel.val.summaryOne', { field: firstLabel })
    : t('panel.val.summaryMany', { field: firstLabel, more: problems.length - 1 }), 6000);
}

async function openSettingsModal(target, opts = {}) {
  const mode = target.kind;
  const titleKey = mode === 'local' ? 'panel.set.titleLocal' : 'panel.set.title';
  const m = modal(`
    <div class="rp-set-head"><h3>${esc(mode === 'local' ? t('panel.set.titleLocal') : t('panel.set.title', { name: (target.instance && target.instance.nickname) || '' }))}</h3></div>
    <div class="rp-tabs" role="tablist">${GROUPS.map((g, i) => `<button class="rp-tab${i === 0 ? ' on' : ''}" role="tab" id="rp-tab-${g.id}" aria-controls="rp-grp-${g.id}" aria-selected="${i === 0}" data-tab="${g.id}">${esc(t('panel.grp.' + g.id))}</button>`).join('')}</div>
    <div class="rp-groups">${GROUPS.map((g) => groupHtml(g, mode)).join('')}</div>
    <p class="note rp-enc">${esc(t(mode === 'local' ? 'panel.set.localNote' : 'panel.set.encNote'))}</p>
    <button class="primary-btn" data-m="save">${esc(t(mode === 'local' ? 'panel.set.save' : 'panel.set.push'))}</button>
    <button class="link-btn" data-m="cancel">${esc(t('panel.set.cancel'))}</button>`, true);

  const box = m.el;
  const groups = box.querySelectorAll('.rp-group');
  const showGroup = (id) => {
    groups.forEach((g) => { g.hidden = g.dataset.group !== id; });
    box.querySelectorAll('.rp-tab').forEach((b) => {
      const on = b.dataset.tab === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
  };
  box.querySelectorAll('.rp-tab').forEach((b) => b.addEventListener('click', () => showGroup(b.dataset.tab)));
  showGroup(GROUPS[0].id);

  // prefill — for a device, prefer the researcher's own last-pushed snapshot (available even before
  // the device has reported back); fall back to whatever the device last reported.
  let source = {};
  if (mode === 'local') source = deps.loadSettings();
  else source = (target.instance && await Researcher.getInstanceSettings(target.instance.instance_id).catch(() => null))
    || (target.instance && firstInventorySettings(target.instance)) || {};
  fillForm(box, toFormValues(source, mode));
  // Group help buttons → the matching in-panel help modal (stacks over settings,
  // same pattern as the WS utility's "?" button).
  box.querySelectorAll('[data-ghelp]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.ghelp === 'wscodes') wsCodesHelpModal();
    if (b.dataset.ghelp === 'recfmt') recfmtHelpModal();
  }));
  // Archive-grade one-tap: 24-bit WAV + AGC/NR/echo/normalization OFF (the widely
  // accepted preservation-master baseline). Sets the form; Save/push as usual.
  box.querySelectorAll('[data-gact="archivalDefaults"]').forEach((b) => b.addEventListener('click', () => {
    const fmt = box.querySelector('[data-f="recordFormat"]');
    if (fmt) { fmt.value = 'wav24'; fmt.dispatchEvent(new Event('change')); }   // change → live size readout follows
    const agc = box.querySelector('[data-f="agc"]');
    if (agc) agc.value = 'off';
    for (const k of ['nr', 'echo', 'norm']) {
      const el = box.querySelector(`[data-f="${k}"]`);
      if (el) el.checked = false;
    }
    deps.toast(t('panel.f.archivalSet'), 4000);
  }));
  // Live max-duration label + size readout (crowd-editor twin). mbTxt keeps 1dp under 10 MB.
  const mrSlider = box.querySelector('[data-f="maxRecordSeconds"]');
  if (mrSlider) {
    const fmtSel = box.querySelector('[data-f="recordFormat"]');
    const mbTxt = (bytes) => { const mb = bytes / 1048576; return mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1); };
    const paintMr = () => {
      const secs = parseInt(mrSlider.value, 10) || 0;
      const fmt = fmtSel ? fmtSel.value : 'wav24';
      box.querySelector('#rp-maxrec-lbl').textContent = secs ? fmtDur(secs) : t('panel.f.maxRecUnlimited');
      box.querySelector('#rp-maxrec-est').textContent = secs
        ? t('panel.crowd.estimate', { mb: mbTxt(crowdEstimate(fmt, secs)) })
        : t('panel.f.perMinEstimate', { mb: mbTxt(crowdEstimate(fmt, 60)) });
    };
    mrSlider.addEventListener('input', paintMr);
    if (fmtSel) fmtSel.addEventListener('change', paintMr);
    paintMr();
  }

  // If opened because validation already blocked the researcher (e.g. the invite gate), show
  // exactly what's missing right away rather than waiting for them to hit Save.
  if (opts.flagOnOpen) {
    const probs = validateDeviceSettings(collectRaw(box), { parseFolder: deps.parseDriveFolder, uploadIsUrl: true });
    if (probs.length) flagProblems(box, probs, showGroup);
  }

  box.querySelector('[data-m="cancel"]').onclick = m.close;
  box.querySelector('[data-m="save"]').onclick = (e) => busy(e.target, async () => {
    // Block save/push until minimal usable settings are present (offending fields flagged inline).
    const problems = validateDeviceSettings(collectRaw(box), { parseFolder: deps.parseDriveFolder, uploadIsUrl: true });
    if (problems.length) { flagProblems(box, problems, showGroup); return; }
    const patch = readForm(box, mode);
    try {
      if (mode === 'local') {
        const s = deps.loadSettings(); Object.assign(s, patch); deps.saveSettings(s);
        deps.onLocalSettingsSaved && deps.onLocalSettingsSaved();
        m.close(); deps.toast(t('panel.set.saved'), 4000);
      } else {
        await Researcher.changeSettings(target.instance.instance_id, patch);
        m.close(); deps.toast(t('panel.set.pushed'), 4000);
      }
    } catch (err) { errToast(err); }
  });

}

// Pull a device's last-reported settings snapshot (if any) to prefill its editor.
function firstInventorySettings(inst) {
  for (const ins of inst.installs || []) {
    if (ins.inventory && ins.inventory.settings) return ins.inventory.settings;
  }
  return null;
}
