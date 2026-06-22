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
import { t } from './i18n.js';
import { REC_FORMATS, DEFAULT_REC_FORMAT } from './record-pcm.js';
import { importPublicKeyB64, publicKeyFingerprint } from './crypto.js';
import { esc } from './flextext.js';
import * as db from './db.js';

let deps = null;
let root = null;
let justSignedUp = false;

const EDITOR_BASE = location.origin + location.pathname.replace(/[^/]*$/, '');
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
    { k: 'vernLang', type: 'text' }, { k: 'vernName', type: 'text' }, { k: 'vernFont', type: 'text' },
    { k: 'analLang', type: 'text' }, { k: 'analName', type: 'text' }, { k: 'analFont', type: 'text' },
  ] },
  { id: 'recording', fields: [
    { k: 'recordFormat', type: 'select', opts: REC_KEYS, optPrefix: 'panel.opt.fmt.' },  // the permanent recording format
    { k: 'agc', type: 'select', opts: AGC_OPTS, optPrefix: 'panel.opt.agc.' },
    { k: 'nr', type: 'checkbox' }, { k: 'echo', type: 'checkbox' }, { k: 'norm', type: 'checkbox' },
  ] },
  { id: 'consent', fields: [
    { k: 'consentMode', type: 'select', opts: CONSENT_MODES, optPrefix: 'panel.opt.consent.' },
    { k: 'consentMsg', type: 'textarea' },
    { k: 'consentAudioUrl', type: 'text' },
    { k: 'consentResp', type: 'select', opts: CONSENT_RESP, optPrefix: 'panel.opt.resp.' },
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
  return { open, close, isSignedUp: () => Researcher.isSignedUp() };
}

function open() { deps.openView('researcher'); route(); }
function close() { deps.goHome(); }

function route() {
  if (!Researcher.isSignedUp()) return renderSignup();
  if (!Researcher.isUnlocked()) return renderUnlock();
  renderDashboard();
}

/* ---------------- small DOM helpers ---------------- */

function header(titleKey, withLock) {
  return `<div class="rp-head">
    <button class="icon-btn rp-exit" data-act="exit" title="${esc(t('panel.exit'))}">&#8592;</button>
    <span class="rp-title">${esc(t(titleKey))}</span>
    <span class="rp-spacer"></span>
    ${withLock ? `<button class="secondary-btn rp-lock" data-act="lock">${esc(t('panel.lock'))}</button>` : ''}
  </div>`;
}

function wire(sel, ev, fn) { const el = root.querySelector(sel); if (el) el.addEventListener(ev, fn); }
function wireActs(handlers) {
  root.querySelectorAll('[data-act]').forEach((el) => {
    const fn = handlers[el.dataset.act];
    if (fn) el.addEventListener('click', () => fn(el));
  });
}
async function busy(btn, fn) {
  if (!btn) return fn();
  const old = btn.textContent; btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}
function errToast(e) { deps.toast(t('panel.err', { msg: (e && e.message) || String(e) }), 6000); }

/* a body-level overlay modal: closes on backdrop click or Escape, moves focus in,
 * traps Tab, and restores focus on close. Returns { el, close }. */
function modal(innerHtml, wide) {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<div class="modal-card${wide ? ' help-modal' : ''}" role="dialog" aria-modal="true">${innerHtml}</div>`;
  document.body.appendChild(wrap);
  const prevFocus = document.activeElement;
  const focusables = () => Array.from(wrap.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'));
  const close = () => { document.removeEventListener('keydown', onKey, true); wrap.remove(); try { prevFocus && prevFocus.focus(); } catch { /* noop */ } };
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

/* ---------------- signup / restore ---------------- */

let turnstileLoading = null;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileLoading) return turnstileLoading;
  turnstileLoading = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.defer = true;
    s.onload = () => resolve(window.turnstile || null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return turnstileLoading;
}

function renderSignup() {
  root.innerHTML = header('panel.title', false) + `
    <div class="rp-body rp-narrow">
      <div class="rp-card">
        <h2>${esc(t('panel.signup.title'))}</h2>
        <p class="note">${esc(t('panel.signup.intro'))}</p>
        <div id="rp-turnstile" class="rp-turnstile"></div>
        <button class="primary-btn" data-act="create" disabled>${esc(t('panel.signup.create'))}</button>
        <button class="link-btn" data-act="restore">${esc(t('panel.signup.restore'))}</button>
      </div>
    </div>`;
  let token = null;
  const createBtn = root.querySelector('[data-act="create"]');
  loadTurnstile().then((ts) => {
    if (!ts) { root.querySelector('#rp-turnstile').textContent = t('panel.signup.noWidget'); return; }
    ts.render('#rp-turnstile', {
      sitekey: deps.turnstileSiteKey(),
      callback: (tk) => { token = tk; createBtn.disabled = false; },
      'expired-callback': () => { token = null; createBtn.disabled = true; },
      'error-callback': () => { token = null; createBtn.disabled = true; },
    });
  });
  wireActs({
    create: (btn) => busy(btn, async () => {
      if (!token) return;
      try {
        await Researcher.signup(token);
        justSignedUp = true;
        deps.onSignedUp && deps.onSignedUp();
        renderUnlock();
      } catch (e) { errToast(e); }
    }),
    restore: () => renderRestore(),
    exit: close,
  });
}

function renderRestore() {
  root.innerHTML = header('panel.title', false) + `
    <div class="rp-body rp-narrow">
      <div class="rp-card">
        <h2>${esc(t('panel.restore.title'))}</h2>
        <p class="note">${esc(t('panel.restore.intro'))}</p>
        <label class="rp-field"><span>${esc(t('panel.restore.id'))}</span><input id="rp-rid" spellcheck="false" autocomplete="off"></label>
        <label class="rp-field"><span>${esc(t('panel.restore.secret'))}</span><input id="rp-rsec" spellcheck="false" autocomplete="off"></label>
        <button class="primary-btn" data-act="do">${esc(t('panel.restore.btn'))}</button>
        <button class="link-btn" data-act="back">${esc(t('panel.restore.cancel'))}</button>
      </div>
    </div>`;
  wireActs({
    do: (btn) => busy(btn, async () => {
      const r = Researcher.restoreAccount(root.querySelector('#rp-rid').value, root.querySelector('#rp-rsec').value);
      if (!r.ok) return deps.toast(t('panel.restore.bad'), 5000);
      deps.onSignedUp && deps.onSignedUp();
      renderUnlock();
    }),
    back: () => renderSignup(),
    exit: close,
  });
}

/* ---------------- passphrase: set (first time) / unlock (returning) ---------------- */

function renderUnlock() {
  const firstTime = justSignedUp;
  root.innerHTML = header('panel.title', false) + `
    <div class="rp-body rp-narrow">
      <div class="rp-card">
        <h2>${esc(t(firstTime ? 'panel.setpass.title' : 'panel.unlock.title'))}</h2>
        <p class="note">${esc(t(firstTime ? 'panel.setpass.intro' : 'panel.unlock.intro'))}</p>
        <label class="rp-field"><span>${esc(t('panel.unlock.ph'))}</span><input id="rp-pass" type="password" autocomplete="off"></label>
        ${firstTime ? `<label class="rp-field"><span>${esc(t('panel.setpass.confirm'))}</span><input id="rp-pass2" type="password" autocomplete="off"></label>` : ''}
        <button class="primary-btn" data-act="go">${esc(t(firstTime ? 'panel.setpass.btn' : 'panel.unlock.btn'))}</button>
        ${justSignedUp ? `<p class="warn-banner banner">${esc(t('panel.setpass.warn'))}</p>` : ''}
      </div>
    </div>`;
  const goPass = (btn) => busy(btn, async () => {
    const pass = root.querySelector('#rp-pass').value;
    if (!pass || pass.length < 8) return deps.toast(t('panel.setpass.short'), 5000);
    if (firstTime) {
      const c = root.querySelector('#rp-pass2').value;
      if (pass !== c) return deps.toast(t('panel.setpass.mismatch'), 5000);
    }
    try {
      const r = firstTime ? await Researcher.setupPassphrase(pass) : await Researcher.unlock(pass);
      if (!r.ok) {
        if (r.error === 'not_initialized') { justSignedUp = true; return renderUnlock(); }
        return deps.toast(t('panel.unlock.bad'), 5000);
      }
      justSignedUp = false;
      renderDashboard();
    } catch (e) { errToast(e); }
  });
  wireActs({ go: goPass, exit: close });
  root.querySelectorAll('#rp-pass, #rp-pass2').forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') goPass(root.querySelector('[data-act="go"]')); }));
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

async function renderDashboard() {
  root.innerHTML = header('panel.title', true) + `<div class="rp-body"><p class="note">${esc(t('panel.dash.loading'))}</p></div>`;
  wireActs({ exit: close, lock: () => { Researcher.lock(); renderUnlock(); } });
  let data;
  try { data = await Researcher.listView(); }
  catch (e) { errToast(e); root.querySelector('.rp-body').innerHTML = `<button class="secondary-btn" data-act="retry">${esc(t('panel.dash.retry'))}</button>`; wire('[data-act="retry"]', 'click', renderDashboard); return; }

  const insts = data.instances || [];
  let pending = 0, texts = 0;
  for (const it of insts) for (const ins of it.installs || []) {
    if (ins.status === 'pending') pending++;
    if (ins.inventory && Array.isArray(ins.inventory.items)) texts += ins.inventory.items.length;
  }
  const localDocs = await db.listDocs().catch(() => []);
  const acct = Researcher.accountInfo() || {};

  const cards = await Promise.all(insts.map(renderInstanceCard));
  root.querySelector('.rp-body').innerHTML = `
    <div class="rp-metrics">
      <div class="rp-metric"><div class="rp-metric-l">${esc(t('panel.dash.devices'))}</div><div class="rp-metric-n">${insts.length}</div></div>
      <div class="rp-metric"><div class="rp-metric-l">${esc(t('panel.dash.pending'))}</div><div class="rp-metric-n${pending ? ' rp-warn' : ''}">${pending}</div></div>
      <div class="rp-metric"><div class="rp-metric-l">${esc(t('panel.dash.texts'))}</div><div class="rp-metric-n">${texts}</div></div>
    </div>
    <div class="rp-actions">
      <button class="primary-btn" data-act="new">${esc(t('panel.dash.newDevice'))}</button>
      <button class="secondary-btn" data-act="refresh">${esc(t('panel.dash.refresh'))}</button>
      <span class="rp-spacer"></span>
      <button class="link-btn" data-act="account">${esc(t('panel.dash.account'))}</button>
    </div>
    <div class="rp-card rp-self">
      <div class="rp-inst-top">
        <span class="rp-inst-name">${esc(t('panel.dash.thisDevice'))} <span class="rp-badge rp-badge-you">${esc(t('panel.dash.you'))}</span></span>
        <button class="secondary-btn" data-act="self-settings">${esc(t('panel.inst.settings'))}</button>
      </div>
      <p class="note">${esc(t('panel.dash.thisDeviceNote', { n: localDocs.length }))}</p>
    </div>
    ${insts.length ? cards.join('') : `<p class="note rp-empty">${esc(t('panel.dash.empty'))}</p>`}`;

  wireActs({
    exit: close,
    lock: () => { Researcher.lock(); renderUnlock(); },
    new: () => newDeviceModal(),
    refresh: () => renderDashboard(),
    account: () => accountModal(acct),
    'self-settings': () => openSettingsModal({ kind: 'local' }),
  });
  // per-card actions are delegated:
  root.querySelectorAll('[data-iact]').forEach((el) => el.addEventListener('click', () => instanceAction(el)));
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
      installsHtml += `<div class="rp-install rp-install-pending">
        <div><div>${esc(t('panel.inst.newInstall'))}</div>
          <div class="rp-mono rp-fp">${esc(t('panel.inst.fingerprint'))}: ${esc(fp)}</div>
          <div class="note rp-verify">${esc(t('panel.inst.verifyHint'))}</div></div>
        <button class="primary-btn" data-iact="approve" data-i="${esc(it.instance_id)}" data-id="${esc(ins.install_id)}">${esc(t('panel.inst.approve'))}</button>
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
        // Remote-upload trigger: offer it for anything not already uploaded.
        const up = us !== 'uploaded'
          ? ` <button class="link-btn rp-up" data-iact="upload" data-i="${esc(it.instance_id)}" data-id="${esc(d.id)}">${esc(t('panel.inst.upload'))}</button>`
          : '';
        return `<li>${esc(d.title || d.titleHash || '?')} ${d.hasAudio ? `<span class="rp-tag">${esc(t('panel.inst.audio'))}</span>` : ''}<span class="rp-tag rp-tag-${us}">${esc(t('panel.up.' + us))}</span>${up}</li>`;
      }).join('')
        : `<li class="note">${esc(t('panel.inst.noTexts'))}</li>`;
      installsHtml += `<div class="rp-install">
        <div class="note">${esc(t('panel.inst.lastSeen', { when: lastSeen(ins.last_seen_at) }))} · ${esc(t('panel.inst.texts', { n: inv ? inv.length : 0 }))}</div>
        <ul class="rp-inv">${rows}</ul>
        <button class="link-btn rp-revoke" data-iact="revoke-install" data-i="${esc(it.instance_id)}" data-id="${esc(ins.install_id)}">${esc(t('panel.inst.revokeInstall'))}</button>
      </div>`;
    }
  }

  return `<div class="rp-card rp-inst">
    <div class="rp-inst-top">
      <span class="rp-inst-name">${esc(it.nickname || '?')} <span class="rp-badge rp-badge-type">${esc(it.type)}</span> ${status}</span>
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
      inviteModal(id, type);
    } else if (act === 'assign') {
      assignModal(id);
    } else if (act === 'upload') {
      await busy(el, () => Researcher.triggerUpload(id, el.dataset.id));   // data-id is the doc id here
      deps.toast(t('panel.inst.uploadSent'), 5000);
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
    <label class="rp-field"><span>${esc(t('panel.new.type'))}</span>
      <select id="rp-new-type"><option value="editor">${esc(t('panel.new.editor'))}</option><option value="recorder">${esc(t('panel.new.recorder'))}</option></select></label>
    <label class="rp-field"><span>${esc(t('panel.new.nick'))}</span><input id="rp-new-nick" placeholder="${esc(t('panel.new.nickPh'))}" spellcheck="false"></label>
    <button class="primary-btn" data-m="create">${esc(t('panel.new.create'))}</button>
    <button class="link-btn" data-m="cancel">${esc(t('panel.new.cancel'))}</button>`);
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  m.el.querySelector('[data-m="create"]').onclick = (e) => busy(e.target, async () => {
    const type = m.el.querySelector('#rp-new-type').value;
    const nick = m.el.querySelector('#rp-new-nick').value.trim();
    if (!nick) return deps.toast(t('panel.new.needNick'), 4000);
    try { await Researcher.createInstance(type, nick); m.close(); renderDashboard(); }
    catch (err) { errToast(err); }
  });
}

async function inviteModal(instanceId, type) {
  const m = modal(`<h3>${esc(t('panel.invite.title'))}</h3><p class="note">${esc(t('panel.invite.loading'))}</p>`);
  try {
    const invite = await Researcher.mintInvite(instanceId);
    const base = type === 'recorder' ? RECORDER_BASE : EDITOR_BASE;
    const url = Researcher.inviteUrl(base, invite);
    const exp = invite.expires_at ? new Date(invite.expires_at).toLocaleString() : '';
    m.el.querySelector('.modal-card').innerHTML = `
      <h3>${esc(t('panel.invite.title'))}</h3>
      <p class="note">${esc(t('panel.invite.intro'))}</p>
      <textarea class="rp-linkbox" readonly rows="3">${esc(url)}</textarea>
      ${exp ? `<p class="note">${esc(t('panel.invite.expires', { when: exp }))}</p>` : ''}
      <button class="primary-btn" data-m="copy">${esc(t('panel.invite.copy'))}</button>
      <button class="secondary-btn" data-m="share">${esc(t('panel.invite.share'))}</button>
      <button class="link-btn" data-m="close">${esc(t('panel.invite.close'))}</button>`;
    m.el.querySelector('[data-m="close"]').onclick = m.close;
    m.el.querySelector('[data-m="copy"]').onclick = async () => {
      try { await navigator.clipboard.writeText(url); deps.toast(t('panel.invite.copied'), 3000); }
      catch { m.el.querySelector('.rp-linkbox').select(); }
    };
    m.el.querySelector('[data-m="share"]').onclick = () => {
      if (navigator.share) navigator.share({ url, text: t('panel.invite.shareText') }).catch(() => {});
      else window.open('https://wa.me/?text=' + encodeURIComponent(url), '_blank');
    };
  } catch (e) { m.close(); errToast(e); }
}

function assignModal(instanceId) {
  const m = modal(`
    <h3>${esc(t('panel.assign.title'))}</h3>
    <p class="note">${esc(t('panel.assign.intro'))}</p>
    <label class="rp-field"><span>${esc(t('panel.assign.titleField'))}</span><input id="rp-as-title" spellcheck="false"></label>
    <label class="rp-field"><span>${esc(t('panel.assign.audio'))}</span><input id="rp-as-audio" spellcheck="false" placeholder="${esc(t('panel.assign.urlPh'))}"></label>
    <label class="rp-field"><span>${esc(t('panel.assign.flextext'))}</span><input id="rp-as-ft" spellcheck="false" placeholder="${esc(t('panel.assign.urlPh'))}"></label>
    <button class="primary-btn" data-m="send">${esc(t('panel.assign.send'))}</button>
    <button class="link-btn" data-m="cancel">${esc(t('panel.assign.cancel'))}</button>`);
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  m.el.querySelector('[data-m="send"]').onclick = (e) => busy(e.target, async () => {
    const title = m.el.querySelector('#rp-as-title').value.trim();
    const audioUrl = m.el.querySelector('#rp-as-audio').value.trim();
    const flextextUrl = m.el.querySelector('#rp-as-ft').value.trim();
    // The field only materializes an assign that carries an audio or flextext resource;
    // a title alone bumps the rev but creates nothing — so require at least one URL.
    if (!audioUrl && !flextextUrl) return deps.toast(t('panel.assign.needUrl'), 5000);
    const fields = { title };
    if (audioUrl) fields.audioUrl = audioUrl;
    if (flextextUrl) fields.flextextUrl = flextextUrl;
    try { await Researcher.assign(instanceId, crypto.randomUUID(), fields); m.close(); deps.toast(t('panel.assign.sent'), 4000); }
    catch (err) { errToast(err); }
  });
}

function accountModal(acct) {
  const m = modal(`
    <h3>${esc(t('panel.account.title'))}</h3>
    <p class="note">${esc(t('panel.account.intro'))}</p>
    <label class="rp-field"><span>${esc(t('panel.restore.id'))}</span><input readonly value="${esc(acct.researcher_id || '')}"></label>
    <label class="rp-field"><span>${esc(t('panel.restore.secret'))}</span><input readonly value="${esc(acct.secret || '')}"></label>
    <button class="primary-btn" data-m="copy">${esc(t('panel.account.copy'))}</button>
    <button class="link-btn" data-m="signout">${esc(t('panel.account.signout'))}</button>
    <button class="link-btn" data-m="close">${esc(t('panel.invite.close'))}</button>`, true);
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  m.el.querySelector('[data-m="copy"]').onclick = async () => {
    try { await navigator.clipboard.writeText(`${acct.researcher_id || ''}\n${acct.secret || ''}`); deps.toast(t('panel.account.copied'), 3000); } catch {}
  };
  m.el.querySelector('[data-m="signout"]').onclick = () => {
    if (!confirm(t('panel.account.confirmSignout'))) return;
    Researcher.signOut(); m.close(); deps.onSignedUp && deps.onSignedUp(); renderSignup();
  };
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
  return `<label class="rp-field"><span>${label}</span><input data-f="${f.k}" spellcheck="false"></label>`;
}

function groupHtml(g) {
  return `<div class="rp-group" id="rp-grp-${g.id}" role="tabpanel" aria-labelledby="rp-tab-${g.id}" data-group="${g.id}" hidden><fieldset class="rp-fieldset"><legend>${esc(t('panel.grp.' + g.id))}</legend>${g.fields.map(fieldHtml).join('')}</fieldset></div>`;
}

// Map stored settings → canonical form values (mode-aware on the divergent fields).
function toFormValues(s, mode) {
  s = s || {};
  const v = {};
  for (const g of GROUPS) for (const f of g.fields) {
    if (f.k === 'upload') v.upload = mode === 'local' ? (s.uploadUrl || '') : (s.uploadFolder || '');
    else if (f.k === 'sendOptions') v.sendOptions = (mode === 'local' ? s.linkSendOptions : s.sendOptions) || [];
    else if (f.k === 'buttons') v.buttons = (mode === 'local' ? s.linkButtons : s.toolbarButtons) || [];
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

// Read the form → a settings patch (mode-aware on divergent keys).
function readForm(box, mode) {
  const raw = {};
  box.querySelectorAll('[data-f]').forEach((el) => {
    const k = el.dataset.f;
    if (el.type === 'checkbox' && el.dataset.v) { (raw[k] = raw[k] || []); if (el.checked) raw[k].push(el.dataset.v); }
    else if (el.type === 'checkbox') raw[k] = el.checked;
    else raw[k] = (el.value || '').trim();
  });
  const patch = {};
  const SPECIAL = ['upload', 'sendOptions', 'buttons', 'autoDel', 'consentAudioUrl'];
  for (const g of GROUPS) for (const f of g.fields) {
    if (SPECIAL.includes(f.k)) continue;
    patch[f.k] = raw[f.k];
  }
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

function openSettingsModal(target) {
  const mode = target.kind;
  const titleKey = mode === 'local' ? 'panel.set.titleLocal' : 'panel.set.title';
  const m = modal(`
    <div class="rp-set-head"><h3>${esc(mode === 'local' ? t('panel.set.titleLocal') : t('panel.set.title', { name: (target.instance && target.instance.nickname) || '' }))}</h3></div>
    <div class="rp-tabs" role="tablist">${GROUPS.map((g, i) => `<button class="rp-tab${i === 0 ? ' on' : ''}" role="tab" id="rp-tab-${g.id}" aria-controls="rp-grp-${g.id}" aria-selected="${i === 0}" data-tab="${g.id}">${esc(t('panel.grp.' + g.id))}</button>`).join('')}</div>
    <div class="rp-groups">${GROUPS.map(groupHtml).join('')}</div>
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

  // prefill
  let source = {};
  if (mode === 'local') source = deps.loadSettings();
  else source = (target.instance && firstInventorySettings(target.instance)) || {};
  fillForm(box, toFormValues(source, mode));

  box.querySelector('[data-m="cancel"]').onclick = m.close;
  box.querySelector('[data-m="save"]').onclick = (e) => busy(e.target, async () => {
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
