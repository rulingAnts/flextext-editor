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
import { t, ENGINE_VERSION } from './i18n.js';
import { REC_FORMATS, DEFAULT_REC_FORMAT } from './record-pcm.js';
import { importPublicKeyB64, publicKeyFingerprint } from './crypto.js';
import { esc, parseFlextext, surveyWritingSystems, remapWritingSystems } from './flextext.js';
import { probeAudioUrl, fetchFileViaUrl } from './audio.js';
import { probeDriveFolder } from './upload.js';
import { convertAudio, detectFormat, readWavHeader, validOutputs } from './convert.js';
import WaveSurfer from './vendor/wavesurfer.esm.js';
import * as db from './db.js';

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
const requestedUploads = new Map();
const UPLOAD_WAIT_MS = 120000;   // no device confirmation after this long → re-offer the button ("awaiting device…")

// Absolute paths (NOT derived from location.pathname): invite links must point at the editor /
// recorder even though this code usually runs inside the researcher app at /flextext-researcher/.
const EDITOR_BASE = location.origin + '/flextext-editor/';
const RECORDER_BASE = location.origin + '/text-recorder/';

const REC_KEYS = Object.keys(REC_FORMATS);
const AGC_OPTS = ['off', 'on', 'auto'];
const CONSENT_MODES = ['off', 'text', 'audio'];
const CONSENT_RESP = ['yesno', 'record', 'signature'];
const BTN_OPTS = ['new', 'audio', 'record', 'open'];
const SEND_OPTS = ['share', 'upload', 'save', 'download'];

/* The 5 settings groups (canonical field ids; local↔device key mapping handled in
 * fillForm/readForm). This is the reusable settings-form component. */
const GROUPS = [
  { id: 'languages', fields: [
    // Interface language pushed to THIS device (setting D). deviceOnly → hidden in the researcher's own
    // local-settings modal (where the live #lang-select toggle already covers it).
    { k: 'appLang', type: 'select', opts: ['follow', 'en', 'id'], optPrefix: 'panel.opt.appLang.', deviceOnly: true },
    { k: 'vernLang', type: 'text' }, { k: 'vernName', type: 'text' }, { k: 'vernFont', type: 'text' },
    { k: 'analLang', type: 'text' }, { k: 'analName', type: 'text' }, { k: 'analFont', type: 'text' },
  ] },
  { id: 'recording', fields: [
    { k: 'recordFormat', type: 'select', opts: REC_KEYS, optPrefix: 'panel.opt.fmt.' },  // the permanent recording format
    { k: 'agc', type: 'select', opts: AGC_OPTS, optPrefix: 'panel.opt.agc.' },
    { k: 'nr', type: 'checkbox' }, { k: 'echo', type: 'checkbox' }, { k: 'norm', type: 'checkbox' },
  ] },
  { id: 'consent', fields: [
    // Consent is multi-select: any combination of prompts + confirmations, all required together.
    { k: 'consentAsk', type: 'multicheck', opts: ['text', 'audio'], optPrefix: 'panel.opt.ask.' },
    { k: 'consentMsg', type: 'textarea' },
    { k: 'consentAudioUrl', type: 'text' },
    { k: 'consentConfirm', type: 'multicheck', opts: ['yesno', 'record', 'signature'], optPrefix: 'panel.opt.conf.' },
  ] },
  { id: 'sending', fields: [
    { k: 'upload', type: 'text' },
    { k: 'sendOptions', type: 'multicheck', opts: SEND_OPTS, optPrefix: 'panel.opt.send.' },
    { k: 'autoDel', type: 'checkbox' },
    { k: 'recordWelcome', type: 'text' },
  ] },
  { id: 'buttons', fields: [
    { k: 'buttons', type: 'multicheck', opts: BTN_OPTS, optPrefix: 'panel.opt.btn.' },
  ] },
];

export function initResearcherPanel(d) {
  deps = d;
  root = d.root;
  Researcher.init({ workerBase: deps.workerBase });
  // Returning to a backgrounded tab → refresh the dashboard + the LIVE-version banner right away rather
  // than waiting for the next poll tick (only fires while the dashboard is actively polling).
  document.addEventListener('visibilitychange', () => { if (!document.hidden && dashPoll) { refreshLiveVersions(); pollDashboard(); } });
  // Regained connectivity → recover immediately instead of waiting for the next timer: refresh the
  // dashboard if it's up, otherwise re-attempt sign-in/bootstrap (drives the reconnecting screen).
  window.addEventListener('online', () => { if (!root || root.hidden) return; if (dashPoll) { refreshLiveVersions(); pollDashboard(); } else route(); });
  return { open, close, isSignedUp: () => Researcher.isSignedUp() };
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
  return `<div class="rp-head">
    ${exitBtn}
    <span class="rp-title">${esc(t(titleKey))}</span>
    <span class="rp-spacer"></span>
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
          ins.install_id, ins.status, ins.accepted, ins.has_key,
          ins.inventory && ins.inventory.ua, ins.inventory && JSON.stringify(ins.inventory.cachedApps),  // re-render when the device's browser/app version changes
          ins.inventory && ins.inventory.engineVersion,  // re-render when the true running engine version changes (brick/stale signal)
          ins.inventory && Array.isArray(ins.inventory.items)
            // uploadedFileId IS part of the signature: a re-send of an unchanged doc keeps uploadState
            // 'uploaded' but mints a new file id, and that's our only signal the re-upload landed.
            ? ins.inventory.items.map((d) => [d.id, d.title, d.uploadState, d.hasAudio, d.uploadedFileId])
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
function deviceInfo(ua, cachedApps, engineVersion) {
  const segs = [];
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
  return { text: segs.join(' · '), stale };
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
  const o = location.origin;
  const [editor, recorder, researcher] = await Promise.all([
    fetchLiveVersion(o + '/flextext-editor/sw.js'),
    fetchLiveVersion(o + '/text-recorder/sw.js'),
    fetchLiveVersion(o + '/flextext-researcher/sw.js'),
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
  // Sweep upload-request markers: drop a completed one after it has lingered (~60s of "uploaded just
  // now"), and give up on one the device never confirmed (~10min, likely offline) so the row reverts
  // to its real reported state and the action button comes back.
  const nowTs = Date.now();
  for (const [k, r] of requestedUploads) {
    if (r.doneAt ? (nowTs - r.doneAt > 60000) : (nowTs - r.requestedAt > 600000)) requestedUploads.delete(k);
  }
  const insts = data.instances || [];
  let pending = 0, texts = 0;
  for (const it of insts) for (const ins of it.installs || []) {
    if (ins.status === 'pending') pending++;
    if (ins.inventory && Array.isArray(ins.inventory.items)) texts += ins.inventory.items.length;
  }
  const localDocs = await db.listDocs().catch(() => []);
  const myDevice = deviceInfo(navigator.userAgent, await panelCachedApps(), ENGINE_VERSION);

  const cards = await Promise.all(insts.map(renderInstanceCard));
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
    ${insts.length ? cards.join('') : `<p class="note rp-empty">${esc(t('panel.dash.empty'))}</p>`}`;

  wireActs({
    exit: close,
    lock: () => { Researcher.signOut(); route(); },
    new: () => newDeviceModal(),
    refresh: () => renderDashboard(),
    utilities: () => utilitiesModal(),
    account: () => accountModal(),
    'self-settings': () => openSettingsModal({ kind: 'local' }),
  });
  // per-card actions are delegated:
  root.querySelectorAll('[data-iact]').forEach((el) => el.addEventListener('click', () => instanceAction(el)));
  root.querySelectorAll('[data-ract]').forEach((el) => el.addEventListener('click', () => researcherAction(el)));
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

async function renderInstanceCard(it) {
  const installs = it.installs || [];
  const anyPending = installs.some((i) => i.status === 'pending');
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
      // The inventory is decrypted from the field install's OWN report, so every value is
      // attacker-controllable if a device is seized (hostile-gov threat model). Titles go
      // through esc(); uploadState lands in a class attribute, so ALLOW-LIST it to the three
      // known states — never interpolate it raw (would permit an attribute-breakout XSS into
      // this privileged panel where Kr + the account secret live).
      const rows = inv && inv.length ? inv.map((d) => {
        const us = (d.uploadState === 'uploaded' || d.uploadState === 'changed') ? d.uploadState : 'local';
        // Mark a pending request done the first render the device reports a NEW file id (see requestedUploads).
        const req = requestedUploads.get(d.id);
        if (req && !req.doneAt && d.uploadedFileId && d.uploadedFileId !== req.prevFileId) req.doneAt = Date.now();
        let disp = us, pending = false;
        if (req) {
          if (req.doneAt) disp = 'justUploaded';                              // ✓ confirmed by the device
          else if (Date.now() - req.requestedAt < UPLOAD_WAIT_MS) { disp = 'requested'; pending = true; }
          else disp = 'slow';                                                 // no confirmation yet → re-offer button
        }
        // SECURITY: disp must stay within this fixed literal set — it lands in a class attribute in this
        // privileged panel; never let an attacker-controlled report value reach it (see note above).
        const DISP = ['local', 'uploaded', 'changed', 'requested', 'slow', 'justUploaded'].includes(disp) ? disp : 'local';
        // Action label by state — Upload (never sent) / Upload changes (edited since) / Re-upload (re-send).
        const label = { changed: 'panel.inst.uploadChanges', uploaded: 'panel.inst.reupload',
                        justUploaded: 'panel.inst.reupload', slow: 'panel.inst.resend' }[DISP] || 'panel.inst.upload';
        const up = pending ? ''   // request in flight: hide the button so it isn't double-fired
          : ` <button class="link-btn rp-up" data-iact="upload" data-i="${esc(it.instance_id)}" data-id="${esc(d.id)}" data-fileid="${esc(d.uploadedFileId || '')}">${esc(t(label))}</button>`;
        return `<li>${esc(d.title || d.titleHash || '?')} ${d.hasAudio ? `<span class="rp-tag">${esc(t('panel.inst.audio'))}</span>` : ''}<span class="rp-tag rp-tag-${DISP}">${esc(t('panel.up.' + DISP))}</span>${up}</li>`;
      }).join('')
        : `<li class="note">${esc(t('panel.inst.noTexts'))}</li>`;
      installsHtml += `<div class="rp-install">
        <div class="note">${esc(t('panel.inst.lastSeen', { when: lastSeen(ins.last_seen_at) }))} · ${esc(t('panel.inst.texts', { n: inv ? inv.length : 0 }))}</div>
        ${(() => { const di = deviceInfo(ins.inventory && ins.inventory.ua, ins.inventory && ins.inventory.cachedApps, ins.inventory && ins.inventory.engineVersion); const txt = di.text || t('panel.inst.verUnknown'); return `<div class="note rp-devinfo${di.text ? '' : ' rp-devinfo-old'}${di.stale ? ' rp-devinfo-stale' : ''}">${esc(txt)}${di.stale ? ` <span class="rp-badge rp-badge-stale">${esc(t('panel.dev.stale'))}</span>` : ''}</div>`; })()}
        <ul class="rp-inv">${rows}</ul>
        <button class="link-btn rp-revoke" data-iact="revoke-install" data-i="${esc(it.instance_id)}" data-id="${esc(ins.install_id)}">${esc(t('panel.inst.revokeInstall'))}</button>
      </div>`;
    }
  }

  // Show the app(s) the device actually RUNS (from each install's reported inventory.type), not a
  // creation-time type — a unified device may run the editor, the recorder, or both.
  const apps = [...new Set((it.installs || []).map((i) => i.inventory && i.inventory.type).filter(Boolean))];
  const runs = apps.length ? apps.join(' + ') : (it.type || '');
  return `<div class="rp-card rp-inst">
    <div class="rp-inst-top">
      <span class="rp-inst-name">${esc(it.nickname || '?')} ${runs ? `<span class="rp-badge rp-badge-type">${esc(runs)}</span>` : ''} ${status}</span>
    </div>
    ${installsHtml || `<p class="note">${esc(t('panel.inst.noInstall'))}</p>`}
    <div class="rp-inst-actions">
      <button class="secondary-btn" data-iact="settings" data-i="${esc(it.instance_id)}" data-type="${esc(it.type)}">${esc(t('panel.inst.settings'))}</button>
      <button class="secondary-btn" data-iact="invite" data-i="${esc(it.instance_id)}" data-type="${esc(it.type)}">${esc(t('panel.inst.invite'))}</button>
      <button class="secondary-btn" data-iact="assign" data-i="${esc(it.instance_id)}">${esc(t('panel.inst.assign'))}</button>
      <button class="link-btn rp-revoke" data-iact="revoke" data-i="${esc(it.instance_id)}" data-name="${esc(it.nickname || '')}">${esc(t('panel.inst.revoke'))}</button>
    </div>
  </div>`;
}

let lastView = null;

async function instanceAction(el) {
  const id = el.dataset.i, installId = el.dataset.id, type = el.dataset.type;
  const act = el.dataset.iact;
  try {
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
      if (!confirm(t('panel.inst.confirmRevokeInstall'))) return;
      await busy(el, () => Researcher.revokeInstall(id, installId));
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
      await busy(el, () => Researcher.triggerUpload(id, docId));           // throws on failure → caught below → no marker set
      requestedUploads.set(docId, { prevFileId, requestedAt: Date.now(), doneAt: 0 });
      deps.toast(t('panel.inst.uploadSent'), 5000);
      renderDashboard(lastData || undefined);                             // instant feedback: row flips to "request sent…"
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
    const urls = { editor: Researcher.inviteUrl(EDITOR_BASE, invite), recorder: Researcher.inviteUrl(RECORDER_BASE, invite) };
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
    <p class="rp-as-status" id="rp-as-status" role="status" hidden></p>
    <button class="primary-btn" data-m="send">${esc(t('panel.assign.send'))}</button>
    <button class="link-btn" data-m="cancel">${esc(t('panel.assign.cancel'))}</button>`);
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
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
    try { await Researcher.assign(instanceId, crypto.randomUUID(), fields); m.close(); deps.toast(t('panel.assign.sent'), 4000); }
    catch (err) { errToast(err); }
  });
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
}

/* ---------------- the reusable tabbed settings modal ---------------- */

function fieldHtml(f) {
  const label = esc(t('panel.f.' + f.k));
  if (f.type === 'checkbox') {
    return `<label class="check-label"><input type="checkbox" data-f="${f.k}"> ${label}</label>`;
  }
  if (f.type === 'multicheck') {
    const boxes = f.opts.map((o) => `<label class="check-label rp-inline"><input type="checkbox" data-f="${f.k}" data-v="${o}"> ${esc(t((f.optPrefix || '') + o))}</label>`).join('');
    return `<div class="rp-field"><span>${label}</span><div class="rp-multi">${boxes}</div></div>`;
  }
  if (f.type === 'select') {
    const opts = f.opts.map((o) => `<option value="${o}">${esc(f.optPrefix ? t(f.optPrefix + o) : o)}</option>`).join('');
    return `<label class="rp-field"><span>${label}</span><select data-f="${f.k}">${opts}</select></label>`;
  }
  if (f.type === 'textarea') return `<label class="rp-field"><span>${label}</span><textarea data-f="${f.k}" rows="2"></textarea></label>`;
  const input = `<label class="rp-field"><span>${label}</span><input data-f="${f.k}" spellcheck="false"></label>`;
  // #4b: under the Drive upload-folder field, a "send a test file" write-probe + a sharing-help link.
  if (f.k === 'upload') {
    return input
      + `<div class="rp-probe-row">`
      + `<button type="button" class="link-btn rp-probe-btn" data-act="probe-upload">${esc(t('panel.f.probeBtn'))}</button>`
      + `<a class="rp-doclink" href="https://support.google.com/drive/answer/2494822" target="_blank" rel="noopener" title="${esc(t('panel.f.probeHelp'))}">?</a>`
      + `<div class="rp-probe-result" role="status" hidden></div></div>`;
  }
  return input;
}

// Hide deviceOnly fields (e.g. appLang) in the researcher's OWN local-settings modal — there the live
// #lang-select toggle already covers the UI language, so a duplicate control would be a confusing no-op.
function groupFields(g, mode) { return g.fields.filter((f) => !(f.deviceOnly && mode === 'local')); }
function groupHtml(g, mode) {
  return `<div class="rp-group" id="rp-grp-${g.id}" role="tabpanel" aria-labelledby="rp-tab-${g.id}" data-group="${g.id}" hidden><fieldset class="rp-fieldset"><legend>${esc(t('panel.grp.' + g.id))}</legend>${groupFields(g, mode).map(fieldHtml).join('')}</fieldset></div>`;
}

// Map stored settings → canonical form values (mode-aware on the divergent fields).
function toFormValues(s, mode) {
  s = s || {};
  const v = {};
  for (const g of GROUPS) for (const f of groupFields(g, mode)) {
    if (f.k === 'upload') v.upload = mode === 'local' ? (s.uploadUrl || '') : (s.uploadFolder || '');
    else if (f.k === 'sendOptions') v.sendOptions = (mode === 'local' ? s.linkSendOptions : s.sendOptions) || [];
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
    else if (f.type === 'checkbox') v[f.k] = !!s[f.k];
    else if (f.type === 'select') v[f.k] = s[f.k] || (f.k === 'recordFormat' ? DEFAULT_REC_FORMAT : f.opts[0]);
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
  const SPECIAL = ['upload', 'sendOptions', 'buttons', 'autoDel', 'consentAudioUrl'];
  for (const g of GROUPS) for (const f of groupFields(g, mode)) {
    if (SPECIAL.includes(f.k)) continue;
    patch[f.k] = raw[f.k];
  }
  // appLang 'follow' (or unset) = "don't change this device's language" → never push it (it would
  // clobber a field worker's own toggle choice). Only an explicit en/id is sent (set-with-override).
  if (patch.appLang === 'follow' || !patch.appLang) delete patch.appLang;
  // autoDel checkbox is stored as autoDelUploaded (the key the field client reads).
  patch.autoDelUploaded = !!raw.autoDel;
  // Consent audio: store the raw link AND the resolved URL the device actually plays.
  patch.consentAudioUrl = raw.consentAudioUrl || '';
  patch.consentAudio = (raw.consentAudioUrl && deps.resolveAudioInput) ? deps.resolveAudioInput(raw.consentAudioUrl) : '';
  const folder = deps.parseDriveFolder ? (deps.parseDriveFolder(raw.upload) || '') : '';
  if (mode === 'local') {
    patch.uploadUrl = raw.upload;
    patch.uploadFolder = raw.upload ? folder : '';
    patch.linkSendOptions = raw.sendOptions || [];
    patch.linkButtons = raw.buttons || [];
  } else {
    patch.uploadFolder = raw.upload ? (folder || raw.upload) : '';
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
  const sends = Array.isArray(raw.sendOptions) ? raw.sendOptions : [];
  // A Drive upload folder is required if "Upload" is an enabled send button OR if consent assent is
  // RECORDED (the recorded "yes" has to be uploaded somewhere, or it's stranded on the device).
  const needForSend = sends.includes('upload');
  const ask = Array.isArray(raw.consentAsk) ? raw.consentAsk : [];
  const confirm = Array.isArray(raw.consentConfirm) ? raw.consentConfirm : [];
  const needForAssent = confirm.includes('record');
  if (needForSend || needForAssent) {
    if (blank(raw.upload)) out.push({ group: 'sending', field: 'upload', msg: (needForAssent && !needForSend) ? t('panel.val.assentUpload') : t('panel.val.uploadMissing') });
    else if (uploadIsUrl && parseFolder && !parseFolder(raw.upload)) out.push({ group: 'sending', field: 'upload', msg: t('panel.val.uploadBad') });
  }
  if (ask.includes('audio') && blank(raw.consentAudioUrl)) out.push({ group: 'consent', field: 'consentAudioUrl', msg: t('panel.val.consentAudio') });
  if (ask.includes('text') && blank(raw.consentMsg)) out.push({ group: 'consent', field: 'consentMsg', msg: t('panel.val.consentMsg') });
  return out;
}

// Map a stored settings snapshot (device keys) → the canonical shape validateDeviceSettings reads.
function settingsToRaw(s) {
  s = s || {};
  return {
    vernLang: s.vernLang, analLang: s.analLang,
    upload: s.uploadFolder,                       // device mode persists the already-parsed folder
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

  // #4b: live write-probe — drop a real test file into the folder typed in the box via the SAME relay
  // the field device uses, so a green result PROVES uploads will land (no Drive token needed).
  const probeBtn = box.querySelector('[data-act="probe-upload"]');
  if (probeBtn) probeBtn.addEventListener('click', () => busy(probeBtn, async () => {
    const out = box.querySelector('.rp-probe-result');
    const paint = (msg, kind) => { out.hidden = false; out.textContent = msg; out.className = 'rp-probe-result' + (kind ? ' rp-as-' + kind : ''); };
    const raw = (box.querySelector('[data-f="upload"]').value || '').trim();
    const fid = deps.parseDriveFolder ? deps.parseDriveFolder(raw) : raw;
    if (!fid) { paint(t('panel.probe.needFolder'), 'err'); return; }
    paint(t('panel.probe.testing'));
    try {
      const r = await probeDriveFolder(deps.driveRelay, fid);
      if (r && r.ok) paint(t('panel.probe.ok', { name: r.name }), 'ok');
      else paint(t('panel.probe.timeout'), 'err');
    } catch (err) {
      paint(t('panel.probe.failPrefix') + ' ' + (err.message || ''), 'err');
    }
  }));
}

// Pull a device's last-reported settings snapshot (if any) to prefill its editor.
function firstInventorySettings(inst) {
  for (const ins of inst.installs || []) {
    if (ins.inventory && ins.inventory.settings) return ins.inventory.settings;
  }
  return null;
}
