/* DEVELOPER MODE (v720) — the console-armed, persistent, visible switch, and the one destructive
 * thing it unlocks: deleting a text WITHOUT backing it up first.
 *
 * Seth, 2026-10-10: testing needs this, because otherwise every trial run uploads junk into a real
 * Drive folder. "I'd like developer specific UI features to be persistent in a browser until turned
 * off (there can be a UI button to turn them off, but enabling them should require a JavaScript
 * Console command)."
 *
 * ⚠ THE SAFETY PROPERTY THESE TESTS EXIST FOR: the DEVICE is the authority. The researcher panel's
 * dev button sends the ORDINARY `delete` command, and the device still refuses it for un-uploaded
 * work unless that device has been armed in its own console. A panel can never destroy a coworker's
 * un-uploaded work from afar. If a future change makes the panel able to force it, the last test
 * here fails. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { liftAll } from './lib/lift.mjs';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const RSCH = readFileSync(new URL('../docs/js/researcher.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');
const WORKER = readFileSync(new URL('../worker/src/v1.js', import.meta.url), 'utf8');

/* The flag and the badge, lifted from app.js and run against a localStorage stand-in. */
function devApp(opts = {}) {
  const env = { store: new Map(Object.entries(opts.store || {})), lists: 0, removed: [], appended: [], events: [] };
  const api = new Function('env', 'opts', `
    const localStorage = {
      getItem: (k) => (env.store.has(k) ? env.store.get(k) : null),
      setItem: (k, v) => { if (opts.throwOnWrite) throw new Error('private mode'); env.store.set(k, String(v)); },
      removeItem: (k) => { env.store.delete(k); },
    };
    const t = (k) => k;
    const allowDeleteOn = () => opts.allowDelete !== false;
    const refreshList = () => { env.lists++; return opts.listRejects ? Promise.reject(new Error('ul is null')) : undefined; };
    const userDeleteDoc = (id, title, o) => { env.called = { id, title, o }; };
    // A DOM small enough to see what the badge does and no smaller.
    const mk = () => ({ id: '', className: '', type: '', textContent: '', title: '', children: [],
                        _attrs: {}, _ev: {},
                        setAttribute(k, v) { this._attrs[k] = v; },
                        addEventListener(k, f) { this._ev[k] = f; },
                        append(...kids) { this.children.push(...kids); },
                        appendChild(k) { this.children.push(k); return k; },
                        insertAdjacentElement(_, k) { env.appended.push(k); return k; },
                        remove() { env.removed.push(this.id || this.className); document._byId.delete(this.id); },
                        querySelector(sel) {
                          const cls = sel.replace('.', '');
                          return this.children.find((c) => String(c.className).split(' ').includes(cls)) || null;
                        } });
    const document = {
      _byId: new Map(),
      createElement: () => mk(),
      getElementById(id) { return this._byId.get(id) || null; },
      body: { appendChild(el) { document._byId.set(el.id, el); return el; } },
    };
    const window = { dispatchEvent: (e) => { env.events.push(e && e.type); return true; } };
    const CustomEvent = function (type, init) { this.type = type; this.detail = init && init.detail; };
    ${liftAll(APP, ['DEV_KEY', 'devMode', 'setDevMode', 'renderDevBadge', 'devModeChanged', 'devDeleteBtn'])}
    return { devMode, setDevMode, renderDevBadge, devModeChanged, devDeleteBtn,
             badge: () => document.getElementById('dev-badge') };
  `)(env, opts);
  return { env, api };
}

/* deleteConfirmedDoc, lifted — the remote `delete` command's one gate. */
function remoteDelete(doc, armed, opts) {
  const env = { tornDown: [], reported: 0, warned: [], tombed: [] };
  return new Function('env', 'doc', 'armed', 'opts', `
    const db = { getDoc: async () => doc };
    const deleteUploadedDoc = async (id) => { env.tornDown.push(id); };
    const Sync = { reportNow: () => { env.reported++; } };
    const devMode = () => armed;
    const addDevTomb = (d) => { env.tombed.push(d.id); return true; };
    const console = { warn: (...a) => env.warned.push(a.join(' ')) };
    ${liftAll(APP, ['deleteConfirmedDoc'])}
    return (opts === undefined ? deleteConfirmedDoc('d1') : deleteConfirmedDoc('d1', opts)).then((r) => ({ r, env }));
  `)(env, doc, armed, opts);
}

test('arming is CONSOLE ONLY — fxDev is the one entry point, and never a keyboard binding', () => {
  assert.match(APP, /window\.fxDev = \(on = true\) =>/, 'the console entry point exists');
  // The repo's standing rule: dev affordances are console functions, never key bindings.
  assert.doesNotMatch(APP, /addEventListener\('keydown'[^)]*fxDev/, 'no key route to arming');
  assert.doesNotMatch(APP, /setDevMode\(true\)/, 'nothing in the app arms it for the user');
  const fx = APP.slice(APP.indexOf('window.fxDev = '), APP.indexOf('window.fxDev = ') + 700);
  assert.match(fx, /setDevMode\(!!on\)/, 'fxDev(false) disarms as well as fxDev() arming');
  assert.match(fx, /devModeChanged\(\)/, 'and everything that follows a flip goes through one place');
});

test('a flip repaints safely, and never through a bare refreshList() (the v720 crash)', () => {
  /* refreshList() is synchronous but hands off to an ASYNC renderer without awaiting it, so a throw
   * inside escapes as an unhandled promise rejection that a try/catch around the call cannot see.
   * fxDev() in the researcher panel was the first caller to hit it: `ul is null` at app.js:453. */
  const dmc = liftAll(APP, ['devModeChanged']);
  assert.match(dmc, /Promise\.resolve\(refreshList\(\)\)\.catch\(/,
    'the async rejection is caught, not just the synchronous throw');
  assert.match(dmc, /dispatchEvent\(new CustomEvent\('fx-dev-mode'/,
    'and the panel is told, since it reads the flag while BUILDING each row');

  // The real fix is in the renderer: it must tolerate a shell that has no list at all.
  const rdl = liftAll(APP, ['renderDocList']);
  assert.match(rdl, /const ul = \$\('#doc-list'\);\s*\n\s*const empty = \$\('#doc-list-empty'\);\s*\n\s*if \(!ul\) return;/,
    'renderDocList bails when its host is absent instead of throwing on null');
  assert.match(rdl, /if \(empty\) empty\.hidden = docs\.length > 0;/, 'and the empty-state node is guarded too');

  // refreshList still falls through to renderDocList in RESEARCHER_MODE — which is now harmless.
  const rl = liftAll(APP, ['refreshList']);
  assert.match(rl, /return renderDocList\(\);/, 'the fall-through is unchanged; the renderer is what got safe');
});

test('a flip in a shell with no texts list is a no-op, not an unhandled rejection', async () => {
  // listRejects makes refreshList behave as it really does in the panel: it returns a promise that
  // rejects. Before the fix this escaped every try/catch and printed a console error with no stack
  // into the code responsible.
  const a = devApp({ listRejects: true });
  const seen = [];
  const onRej = (e) => { seen.push(e); };
  process.on('unhandledRejection', onRej);
  try {
    assert.doesNotThrow(() => a.api.devModeChanged(), 'the flip itself does not throw');
    await new Promise((r) => setImmediate(r));   // give an unhandled rejection a tick to surface
    await new Promise((r) => setImmediate(r));
  } finally { process.off('unhandledRejection', onRej); }
  assert.deepEqual(seen, [], 'and nothing escapes as an unhandled rejection');
  assert.ok(a.env.lists > 0, 'it did still try to repaint');
  assert.deepEqual(a.env.events, ['fx-dev-mode'], 'and the panel was told either way');
});

test('the panel repaints on the flip, through the event and not a cross-module call', () => {
  const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  const l = PANEL.slice(PANEL.indexOf("window.addEventListener('fx-dev-mode'"), PANEL.indexOf("window.addEventListener('fx-dev-mode'") + 700);
  assert.match(l, /try \{ renderDashboard\(lastData \|\| undefined\); \}/, 'the panel listens and re-renders');
  // ⚠ ...a DASHBOARD. Fired on the sign-in screen it replaced it with a dashboard that could not load
  // (v722 review). `.rp-metrics` is renderDashboard's own "a dashboard is showing" marker.
  assert.ok(l.indexOf("if (!root.querySelector('.rp-metrics')) return;") > 0
    && l.indexOf("if (!root.querySelector('.rp-metrics')) return;") < l.indexOf('renderDashboard('),
    'guarded on a dashboard being up, before the repaint');
  assert.doesNotMatch(PANEL, /import \{[^}]*devModeChanged/, 'app.js internals stay app.js internals');
});

test('it persists until turned off, and survives a private-mode write failure', () => {
  const a = devApp();
  assert.equal(a.api.devMode(), false, 'off by default');
  a.api.setDevMode(true);
  assert.equal(a.api.devMode(), true);
  assert.equal(a.env.store.get('flextext-dev-mode'), '1', 'in localStorage, so a reload keeps it');

  // A fresh app on the same device reads it back — this is the "persistent" half of Seth's rule.
  const again = devApp({ store: { 'flextext-dev-mode': '1' } });
  assert.equal(again.api.devMode(), true, 'still armed after a reload');

  a.api.setDevMode(false);
  assert.equal(a.api.devMode(), false, 'and the UI button can turn it off');
  assert.equal(a.env.store.has('flextext-dev-mode'), false, 'leaving nothing behind');

  // Private mode: the write throws, and that must not break the app.
  const priv = devApp({ throwOnWrite: true });
  assert.doesNotThrow(() => priv.api.setDevMode(true));
  assert.equal(priv.api.devMode(), false, 'it simply does not arm');
});

test('the badge is drawn on BOOT, in every shell — applyLiveSettings never runs at boot (v722 review)', () => {
  const su = APP.slice(APP.indexOf('\nfunction setup() {'), APP.indexOf('\nfunction setup() {') + 1500);
  const iBadge = su.indexOf('renderDevBadge()');
  assert.ok(iBadge > 0, 'setup() draws it');
  assert.ok(iBadge < su.indexOf('if (CROWD_MODE)'), 'above the first per-mode return, so the panel, PAT and the recorder get it too');
  // The on-change redraw is still there for language changes.
  const als = APP.slice(APP.indexOf('\nfunction applyLiveSettings() {'), APP.indexOf('\nfunction applyLiveSettings() {') + 600);
  assert.match(als, /renderDevBadge\(\)/);
});

test('?devreset clears it with everything else — no separate bookkeeping to forget', () => {
  const erase = APP.slice(APP.indexOf('async function eraseAllData'), APP.indexOf('async function eraseAllData') + 1400);
  assert.match(erase, /localStorage\.clear\(\)/, 'the whole origin goes, dev flag included');
});

test('the badge appears only while armed, and carries its own off switch', () => {
  const off = devApp();
  off.api.renderDevBadge();
  assert.equal(off.api.badge(), null, 'nothing on screen when disarmed');

  const on = devApp({ store: { 'flextext-dev-mode': '1' } });
  on.api.renderDevBadge();
  const b = on.api.badge();
  assert.ok(b, 'armed: the badge is there');
  assert.equal(b.querySelector('.dev-badge-text').textContent, 'dev.badge');
  const btn = b.querySelector('.dev-badge-off');
  assert.ok(btn && typeof btn._ev.click === 'function', 'with a button to turn it off');

  // Pressing it disarms, removes the badge and repaints the list.
  btn._ev.click();
  assert.equal(on.api.devMode(), false, 'the UI button disarms');
  assert.ok(on.env.removed.length, 'and the badge removes itself');
  assert.ok(on.env.lists > 0, 'and the list repaints, so the ☠ buttons go with it');
});

test('the badge is re-drawn on every boot, because the flag outlives the page', () => {
  const live = liftAll(APP, ['applyLiveSettings']);
  assert.match(live, /renderDevBadge\(\)/, 'applyLiveSettings draws it');
  assert.ok(live.indexOf('renderDevBadge()') < live.indexOf('if (RESEARCHER_MODE) return;'),
    'before the researcher-mode return — an armed device says so in every shell');
});

test('the ☠ button exists only while armed, and is not a second 🗑', () => {
  const off = devApp();
  assert.equal(off.api.devDeleteBtn({ id: 'd1', title: 'T' }), null, 'disarmed: nothing in the DOM to find');

  const noDel = devApp({ store: { 'flextext-dev-mode': '1' }, allowDelete: false });
  assert.equal(noDel.api.devDeleteBtn({ id: 'd1', title: 'T' }), null,
    'and it still obeys the researcher\'s allowDelete switch');

  const on = devApp({ store: { 'flextext-dev-mode': '1' } });
  const b = on.api.devDeleteBtn({ id: 'd1', title: 'T' });
  assert.ok(b, 'armed: there it is');
  assert.equal(b.textContent, '☠', '☠ — so it cannot be confused with the safe 🗑');
  assert.notEqual(b.textContent, '🗑');
  assert.ok(String(b.className).includes('dev-del'));
  assert.equal(b.title, 'dev.deleteTitle');
  assert.equal(b._attrs['aria-label'], 'dev.deleteTitle', 'and it is named for a screen reader');

  b._ev.click({ stopPropagation() {} });
  assert.deepEqual(on.env.called, { id: 'd1', title: 'T', o: { force: true } }, 'it asks for the forced delete');
});

test('all three texts lists carry it beside the safe delete', () => {
  // Three renderers call userDeleteDoc; each must offer the dev control too, or the app you happen
  // to be testing in is the one without it.
  assert.equal((APP.match(/userDeleteDoc\(d\.id, d\.title\);/g) || []).length, 3, 'three safe buttons');
  assert.equal((APP.match(/devDeleteBtn\(d, 'icon-btn2?'\)/g) || []).length, 3, 'and three dev buttons');
});

test('a remote delete of un-uploaded work is refused on an UNARMED device', async () => {
  const notBackedUp = { id: 'd1', modified: 200, uploadedFileId: 'f1', uploadedModified: 100 };
  const { r, env } = await remoteDelete(notBackedUp, false);
  assert.equal(r, false, 'refused');
  assert.deepEqual(env.tornDown, [], 'nothing was deleted');
  assert.match(env.warned.join(' '), /refusing remote delete/);

  const never = { id: 'd1', modified: 200 };
  const n = await remoteDelete(never, false);
  assert.equal(n.r, false, 'and a text never uploaded at all is refused too');
});

test('...and honoured on a device armed in ITS OWN console — the device is the authority', async () => {
  const notBackedUp = { id: 'd1', modified: 200, uploadedFileId: 'f1', uploadedModified: 100 };
  const { r, env } = await remoteDelete(notBackedUp, true, { force: true });
  assert.equal(r, true, 'armed, and the delete command asked: the device honours it');
  assert.deepEqual(env.tornDown, ['d1'], 'through the same teardown as any other delete');
  assert.equal(env.reported, 1, 'and reports so the panel stops showing it');
  assert.match(env.warned.join(' '), /NOT safely on Drive/, 'saying so in the console');
  assert.deepEqual(env.tombed, ['d1'], 'and leaves the SAME tombstone a local ☠ does — the folder is for the trash, not Unassigned');

  // The panel cannot force an unarmed device, whatever it asks for.
  const u = await remoteDelete(notBackedUp, false, { force: true });
  assert.equal(u.r, false, 'force without arming is refused');
  assert.deepEqual(u.env.tornDown, []);

  // Already safely on Drive: unchanged by any of this.
  const safe = { id: 'd1', modified: 100, uploadedFileId: 'f1', uploadedModified: 100 };
  for (const armed of [false, true]) {
    const s = await remoteDelete(safe, armed);
    assert.equal(s.r, true, `backed-up text deletes either way (armed=${armed})`);
  }
});

test('⚠ ARMED OR NOT, A CALLER THAT DID NOT ASK IS REFUSED — the ordinary paths are unchanged (v722 review)', async () => {
  /* deleteConfirmedDoc is the proof-of-backup gate for SIX callers, and only the panel's `delete`
   * command passes `force`. The upload-completion hook is the caller that made this a data-loss bug:
   * it fires when a QUEUED upload lands, with no sig check in front of it, so with the exception
   * keyed on devMode() alone the ordinary 🗑 on an armed device deleted post-queue edits when the
   * stale snapshot landed. The bare call below IS that hook's call. */
  const editedSinceQueue = { id: 'd1', modified: 300, uploadedFileId: 'f1', uploadedModified: 200 };
  const hook = await remoteDelete(editedSinceQueue, true);            // armed, no force: the hook, 🗑, sweep, uploadDelete, setDone
  assert.equal(hook.r, false, 'refused on an armed device when nobody asked to force it');
  assert.deepEqual(hook.env.tornDown, [], 'the post-queue work is still there');
  assert.match(hook.env.warned.join(' '), /refusing remote delete/);
  assert.deepEqual(hook.env.tombed, [], 'and no tombstone — nothing was removed');

  const calls = APP.match(/deleteConfirmedDoc\([^)]*\)/g).filter((c) => !/opts = \{\}/.test(c));   // the definition aside
  const forced = calls.filter((c) => /force: true/.test(c));
  assert.equal(calls.length, 6, `six callers (${calls.join(' | ')})`);
  assert.equal(forced.length, 1, 'exactly ONE passes force');
  const site = APP.slice(APP.indexOf(forced[0]) - 260, APP.indexOf(forced[0]));
  assert.match(site, /case 'delete':/, "and it is the panel's `delete` command");
  assert.match(APP, /const forced = !!opts\.force && devMode\(\);/, 'both halves, re-checked inside');
});

test('the panel needs NO new worker command — `delete` already exists end to end', () => {
  assert.match(RSCH, /export function deleteDoc\(instanceId, docId\)\s+\{ return pushCommand\(instanceId, 'delete', \{ docId \}\); \}/,
    'the panel sends the ORDINARY delete command, through the sender that already existed');
  assert.doesNotMatch(RSCH, /export function deleteNow\(/,
    'v722 review: the first draft added a second, identical sender; one is enough');
  // Which is why this is additive and client-only: the worker already allows that type.
  assert.match(WORKER, /TEXT_COMMANDS = \['assign', 'delete', 'uploadDelete', 'setDone'\]/,
    'delete is already in TEXT_COMMANDS');
  assert.match(WORKER, /\['assign', 'delete', 'changeSettings', 'triggerUpload', 'uploadDelete', 'setDone'\]\.includes\(cmd\.type\)/,
    'and already in the worker\'s accepted-command allow-list');
  // ⚠ And it must stay a plain command: a panel-side force would break the whole safety property.
  assert.doesNotMatch(RSCH, /pushCommand\([^)]*'forceDelete'/, 'no panel-side force command');
});

test('the panel offers it too, and only while THIS browser is armed', () => {
  const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  // The panel reads the same per-browser flag app.js owns — same origin, so arming once covers both.
  assert.match(PANEL, /function devMode\(\) \{ try \{ return localStorage\.getItem\('flextext-dev-mode'\) === '1'; \}/,
    'the panel reads the flag');
  assert.doesNotMatch(PANEL, /localStorage\.setItem\('flextext-dev-mode'/,
    '⚠ and NEVER writes it — the panel must not be able to arm anything');
  assert.match(PANEL, /devMode\(\) \? ` <button class="link-btn rp-devdel" data-iact="del-text-now"/,
    'the button is rendered only when armed');
  assert.match(PANEL, /Researcher\.deleteDoc\(id, el\.dataset\.id\)/, 'and sends the ordinary delete command through the sender that already existed');
  assert.match(PANEL, /confirmModal\(t\('panel\.dev\.confirmDelNow'/, 'behind its own confirm');
  // It must sit beside the safe one, not replace it.
  assert.match(PANEL, /data-iact="del-text"/, 'the upload-first Remove is still there');
  for (const k of ['panel.dev.delNow', 'panel.dev.confirmDelNow', 'panel.dev.delNowSent',
                   'panel.dev.tombTrash', 'panel.dev.tombTip', 'panel.dev.confirmTombTrash',
                   'panel.dev.tombTrashed', 'panel.dev.tombFailed']) {
    assert.equal((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length, 2, `${k} in en and id`);
  }
  assert.match(I18N, /panel\.dev\.confirmDelNow': 'Tell the device to delete .{0,12}\{title\}.{0,12} WITHOUT uploading it first\?/);
  assert.match(I18N, /un-uploaded work is removed only if developer mode is also on there — otherwise the device refuses and the text stays/,
    'and the confirm says the device can still refuse — which is the safety property, stated to the user — without claiming a backed-up text is spared');
  // The tombstone confirm must name the outcome Seth cares about, in both directions.
  // The source has a backslash-escaped apostrophe inside the single-quoted string: Drive\'s
  assert.match(I18N, /The folder goes to Drive\\'s trash — not to Unassigned — where Drive keeps it for about 30 days/,
    'the English confirm says trash, NOT Unassigned — and that the trash is recoverable (v722 review: "no copy left anywhere" overstated it)');
  assert.match(I18N, /Folder masuk ke tempat sampah Drive — bukan ke Belum Ditugaskan — dan Drive menyimpannya sekitar 30 hari/,
    'and the Indonesian says the same');
  assert.doesNotMatch(I18N, /no copy left anywhere/, 'the overstatement is gone');
  // "Remove, no backup" said the device would ONLY obey if armed; a backed-up text deletes regardless.
  assert.match(I18N, /A text already safely on Drive is removed either way; un-uploaded work is removed only if developer mode is also on there/);
  assert.match(I18N, /Teks yang sudah aman di Drive dihapus bagaimanapun juga/);
  // The ☠ confirm names the Drive consequence, since a panel will now trash the folder by itself.
  assert.match(I18N, /a researcher panel in developer mode will send that folder to Drive\\'s trash/);
  assert.match(I18N, /panel peneliti dalam mode pengembang akan mengirim folder itu ke tempat sampah Drive/);
  // fxDev's own message no longer promises ?devreset where it is refused (production and beta hosts).
  assert.match(APP, /so does \?devreset, on the hosts that honour it/);
});

/* ── the tombstone: ☠ removals must never become Unassigned rows ─────────────────────────────── */

function tombApp(opts = {}) {
  const env = { store: new Map(Object.entries(opts.store || {})) };
  const api = new Function('env', 'opts', `
    const localStorage = {
      getItem: (k) => (env.store.has(k) ? env.store.get(k) : null),
      setItem: (k, v) => { if (opts.throwOnWrite) throw new Error('private mode'); env.store.set(k, String(v)); },
      removeItem: (k) => { env.store.delete(k); },
    };
    const Date_now = ${opts.now || 'Date.now()'};
    ${liftAll(APP, ['DEV_TOMB_KEY', 'DEV_TOMB_TTL_MS', 'DEV_TOMB_STOP_MS', 'devTombs', 'setDevTombs', 'addDevTomb', 'markTombsReported'])}
    return { devTombs, setDevTombs, addDevTomb, markTombsReported, TTL: DEV_TOMB_TTL_MS, STOP: DEV_TOMB_STOP_MS, KEY: DEV_TOMB_KEY };
  `)(env, opts);
  return { env, api };
}

test('a ☠ removal is flagged with the FOLDER ID, captured before the doc is gone', () => {
  const { api, env } = tombApp();
  // A text that reached Drive: its folder must be named, because nothing can resolve it afterwards.
  assert.equal(api.addDevTomb({ id: 'd1', title: 'Test one', driveFolderId: 'F1' }), true);
  const list = api.devTombs();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'd1');
  assert.equal(list[0].folderId, 'F1', 'the folder the panel will trash');
  assert.equal(list[0].title, 'Test one');
  assert.ok(list[0].at > 0, 'stamped, so it can expire on its own');
  assert.ok(env.store.has('flextext-dev-removed'), 'persisted — it has to outlive the page');

  // A text that never reached Drive has nothing to clean, so it gets NO tombstone. The common case.
  const fresh = tombApp();
  assert.equal(fresh.api.addDevTomb({ id: 'd9', title: 'Never uploaded' }), false);
  assert.deepEqual(fresh.api.devTombs(), [], 'nothing on Drive, nothing to flag');

  // Re-deleting the same id replaces rather than duplicates.
  api.addDevTomb({ id: 'd1', title: 'Test one again', driveFolderId: 'F1b' });
  const again = api.devTombs();
  assert.equal(again.length, 1, 'one entry per doc id');
  assert.equal(again[0].folderId, 'F1b', 'the newest folder wins');
});

test('the forced delete writes the tombstone BEFORE db.deleteDoc, or the folder id is lost', () => {
  const ud = APP.slice(APP.indexOf('async function userDeleteDoc'), APP.indexOf('async function userDeleteDoc') + 3200);
  const iTomb = ud.indexOf('addDevTomb(d)');
  const iDel = ud.indexOf('await db.deleteDoc(docId)');
  assert.ok(iTomb > 0 && iDel > 0, 'both steps are in there');
  assert.ok(iTomb < iDel, '⚠ the flag is written while the doc still has its driveFolderId');
});

test('tombstones expire on their own and are pruned on read — 30 days after the PANEL COULD SEE THEM', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  /* ⚠ The clock is the first ACCEPTED report, not the ☠ (v722 review): a device that ☠'d and then sat
   * offline for a month would otherwise forget before any panel was told, and the folder drifts into
   * Unassigned after all. An unreported tombstone survives the 30 days; a reported one does not. */
  const t = tombApp({ store: { 'flextext-dev-removed': JSON.stringify([
    { id: 'seen', title: 'reported a month ago', folderId: 'F0', at: now - 40 * DAY, reportedAt: now - 31 * DAY },
    { id: 'unseen', title: 'never reported', folderId: 'F1', at: now - 31 * DAY },
    { id: 'fresh', title: 'reported today', folderId: 'F2', at: now - 31 * DAY, reportedAt: now },
    { id: 'dead', title: 'never paired again', folderId: 'F3', at: now - 370 * DAY },
  ]) } });
  const live = t.api.devTombs();
  assert.deepEqual(live.map((x) => x.id).sort(), ['fresh', 'unseen'], 'the reported-and-old one and the year-old orphan are gone; the unreported one waits');
  assert.equal(JSON.parse(t.env.store.get('flextext-dev-removed')).length, 2, 'and pruned from storage, not just filtered');
  assert.equal(t.api.TTL, 30 * DAY, '30 days');
  assert.equal(t.api.STOP, 12 * t.api.TTL, 'a never-reported tombstone still stops after a year — a device never paired again reaches no panel');

  // The stamp: once, by the report that carried it, and only for the ids it carried.
  const m = tombApp({ store: { 'flextext-dev-removed': JSON.stringify([
    { id: 'a', folderId: 'FA', at: now - DAY },
    { id: 'b', folderId: 'FB', at: now - DAY, reportedAt: now - 5 * DAY },
    { id: 'c', folderId: 'FC', at: now - DAY },
  ]) } });
  m.api.markTombsReported({ devRemoved: [{ id: 'a', folderId: 'FA' }, { id: 'b', folderId: 'FB' }] });
  const after = Object.fromEntries(m.api.devTombs().map((x) => [x.id, x.reportedAt || 0]));
  assert.ok(after.a >= now, 'a: stamped now');
  assert.equal(after.b, now - 5 * DAY, 'b: an earlier stamp is never moved');
  assert.equal(after.c, 0, 'c: not in the report, not stamped');
  m.api.markTombsReported({});                       // a report with none: a no-op
  m.api.markTombsReported(undefined);
  assert.match(APP, /onReported: markTombsReported,/, 'wired into Sync.start');
  const SYNC = readFileSync(new URL('../docs/js/sync.js', import.meta.url), 'utf8');
  const rpt = SYNC.slice(SYNC.indexOf('async function maybeReport'), SYNC.indexOf('async function maybeReport') + 1600);
  assert.ok(rpt.indexOf('lastReportHash = hash;') < rpt.indexOf('iface.onReported(inv)'), 'fired after the POST succeeded');
  assert.match(rpt, /catch \{ return;/, 'and a failed POST returns before it — a tombstone nobody received is not stamped');

  // Over the cap, the OLDEST go — a cap that dropped the newest lost the tombstone just written.
  const many = tombApp();
  many.api.setDevTombs(Array.from({ length: 205 }, (_, i) => ({ id: 'd' + i, folderId: 'F' + i, at: now })));
  const kept = many.api.devTombs().map((x) => x.id);
  assert.equal(kept.length, 200);
  assert.equal(kept[0], 'd5', 'the first five (oldest) went');
  assert.equal(kept[199], 'd204', 'the newest stayed');

  // Malformed entries never reach the report.
  const bad = tombApp({ store: { 'flextext-dev-removed': JSON.stringify([{ id: 'x' }, { folderId: 'y' }, null, 7]) } });
  assert.deepEqual(bad.api.devTombs(), [], 'an entry without both an id and a folder is dropped');
  const junk = tombApp({ store: { 'flextext-dev-removed': 'not json' } });
  assert.deepEqual(junk.api.devTombs(), [], 'and unparseable storage is simply empty');
});

test('the report carries them, and is byte-identical when there are none', () => {
  const inv = APP.slice(APP.indexOf('async function syncGatherInventory'), APP.indexOf('async function syncGatherInventory') + 9000);
  assert.match(inv, /const liveIds = new Set\(items\.map\(\(x\) => x\.id\)\);/);
  assert.match(inv, /const tombs = allTombs\.filter\(\(x\) => !liveIds\.has\(x\.id\)\);/,
    '⚠ a tombstone for an id that is LIVE AGAIN on this device is dropped (assign/adopt reuse ids), before the panel ever sees it');
  assert.match(inv, /if \(tombs\.length !== allTombs\.length\) setDevTombs\(tombs\);/, 'and pruned from storage');
  assert.match(inv, /devRemoved: tombs\.length \? tombs : undefined,/,
    'undefined when empty, so JSON drops the key and the change-gate hash does not move');
  // ⚠ The report is E2EE and opaque to the worker, which is what makes this additive.
  const SYNC = readFileSync(new URL('../docs/js/sync.js', import.meta.url), 'utf8');
  assert.match(SYNC, /reported = await encryptJSON\(instanceKey, inv\)/, 'encrypted client-side');
  assert.match(SYNC, /body: \{ reported, ack_seq: s\.ackSeq \}/, 'and posted as one opaque blob');
  assert.doesNotMatch(WORKER, /devRemoved/, 'the worker never names the field — no backend change');
});

test('the panel renders them through the SAME row renderer, struck through', () => {
  const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  assert.match(PANEL, /const tombs = \(ins\.inventory && Array\.isArray\(ins\.inventory\.devRemoved\)\)/);
  assert.match(PANEL, /pendingDelete: true, __devRemoved: true, __folderId: x\.folderId/,
    'pendingDelete is what strikes it through — the convention already means "gone from the device"');
  assert.match(PANEL, /const listed = \[\.\.\.ghosts, \.\.\.tombRows, \.\.\.\(inv \|\| \[\]\)\.slice\(\)\.sort\(textOrder\)\]/,
    'one renderer, like the assign ghosts above it');
  assert.match(PANEL, /!invIds\.has\(x\.id\)/,
    'a text the device still reports is NOT a tombstone row, whatever a stale flag says');
});

/* The panel's tombstone logic, lifted: the claim set, the open set, and the auto-trash. */
const PANEL_SRC = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
function tombPanel(opts = {}) {
  const env = { trashed: [], toasts: [], renders: 0, saved: 0 };
  const api = new Function('env', 'opts', `
    let lastData = opts.lastData || null;
    let estateCache = opts.estate === undefined ? null : opts.estate;
    const devMode = () => !!opts.armed;
    const Researcher = {
      trashFiles: async (ids) => { env.trashed.push(ids); return opts.trashResult ? opts.trashResult(ids) : { results: ids.map((id) => ({ id, ok: true })), trashed: ids.length, remaining: 0 }; },
      currentAccountId: () => 'acct',
    };
    const deps = { toast: (m) => env.toasts.push(m) };
    const t = (k, v) => k + (v ? ' ' + JSON.stringify(v) : '');
    const saveTombDone = () => { env.saved++; };
    const renderDashboard = () => { env.renders++; };
    ${liftAll(PANEL_SRC, ['tombKey', 'devTombDone', 'autoTrashBusy', 'inventoryDocIds', 'openTombs', 'assignedDocIds', 'tombFolderVerified', 'autoTrashTombs'])}
    return { tombKey, openTombs, assignedDocIds, inventoryDocIds, autoTrashTombs, done: devTombDone, busy: () => autoTrashBusy };
  `)(env, opts);
  return { env, api };
}
const inst = (id, items, devRemoved) => ({ instance_id: id, installs: [{ inventory: { items, devRemoved } }] });

test('⚠ A TOMBSTONE IS A CLAIM: between ☠ and trash the folder is NOT unassigned (v722 review)', () => {
  /* The Unassigned card, the sweep and the storage modal all ask assignedDocIds(). With tombstones
   * outside it, the folder was listed under Unassigned — and re-parented there by the sweep — on the
   * very render that first showed its "Remove, no unassign" row. */
  const { api } = tombPanel({ lastData: { instances: [inst('A', [{ id: 'live1' }], [{ id: 'gone1', title: 'T', folderId: 'F1' }])] } });
  assert.deepEqual([...api.inventoryDocIds()], ['live1'], 'the inventories literally report one text');
  assert.deepEqual([...api.assignedDocIds()].sort(), ['gone1', 'live1'], 'but TWO are claimed — the tombstone holds its folder');
  assert.deepEqual(api.openTombs().map((x) => x.id), ['gone1']);
  // Source: the three predicates that used to be the trap all go through assignedDocIds.
  for (const fn of ['function unassignedTexts(estate)', 'function sweepUnassigned(estate)', 'function storageModal()']) {
    const body = PANEL_SRC.slice(PANEL_SRC.indexOf(fn), PANEL_SRC.indexOf(fn) + 3200);
    assert.match(body, /assignedDocIds\(\)/, fn + ' asks the claim set');
  }
  assert.match(PANEL_SRC, /function assignedDocIds\(\) \{\s*\n\s*const ids = inventoryDocIds\(\);\s*\n\s*for \(const x of openTombs\(\)\) ids\.add\(x\.id\);/);
});

test('a tombstone for a text LIVE ON ANOTHER DEVICE is not open — docIds are reused by assign (v722 review)', () => {
  // Device A ☠'d d1 → it was assigned to device B under the SAME id, into the SAME folder. A's
  // tombstone must not offer B's live folder for the trash; the cross-check alone would pass it.
  const { api } = tombPanel({ lastData: { instances: [
    inst('A', [], [{ id: 'd1', title: 'T', folderId: 'F1' }]),
    inst('B', [{ id: 'd1' }], []),
  ] } });
  assert.deepEqual(api.openTombs(), [], 'not open anywhere');
  assert.deepEqual([...api.assignedDocIds()], ['d1'], 'claimed by B, as a live text');
});

test('the done-set is keyed by FOLDER too, and a 200 with ok:false is NOT done (v722 review)', () => {
  const { api } = tombPanel({ lastData: { instances: [inst('A', [], [{ id: 'd1', title: 'T', folderId: 'F2' }])] } });
  api.done.add(api.tombKey('A', 'd1', 'F1'));        // an EARLIER folder for the same id was handled
  assert.deepEqual(api.openTombs().map((x) => x.folderId), ['F2'], 'the new folder is new work');
  api.done.add(api.tombKey('A', 'd1', 'F2'));
  assert.deepEqual(api.openTombs(), []);
  assert.match(PANEL_SRC, /const tombKey = \(instanceId, docId, folderId\) =>/);
  // The button handler: the route answers 200 with per-id results, and a failed PATCH is one of them.
  const h = PANEL_SRC.slice(PANEL_SRC.indexOf("act === 'tomb-trash'"), PANEL_SRC.indexOf("act === 'tomb-trash'") + 3000);
  const iCheck = h.indexOf("if (!hit || !hit.ok) { deps.toast(t('panel.dev.tombFailed'), 6000); return; }");
  assert.ok(iCheck > 0 && iCheck < h.indexOf('devTombDone.add'), 'checked before it is remembered');
  assert.match(h, /devTombDone\.add\(tombKey\(el\.dataset\.i, el\.dataset\.id, folder\)\)/, 'remembered with the folder');
});

test('auto-trash on load: developer mode finishes ☠ removals by itself, verified, and only when armed HERE', async () => {
  const data = { instances: [inst('A', [], [
    { id: 'd1', title: 'one', folderId: 'F1' },
    { id: 'd2', title: 'two', folderId: 'F2' },
    { id: 'd3', title: 'mismatch', folderId: 'F3' },
  ])] };
  const estate = { texts: [{ docId: 'd1', folderId: 'F1' }, { docId: 'd2', folderId: 'F2' }, { docId: 'd3', folderId: 'F9' }] };

  // Not armed in this panel: nothing happens behind the researcher's back.
  const cold = tombPanel({ lastData: data, estate, armed: false });
  await cold.api.autoTrashTombs(estate);
  assert.deepEqual(cold.env.trashed, [], 'unarmed panel: no trash');
  assert.equal(cold.api.openTombs().length, 3, 'rows stay');

  // Armed: the verified ones go, in ONE call; the mismatch is left alone and still shown.
  const hot = tombPanel({ lastData: data, estate, armed: true });
  await hot.api.autoTrashTombs(estate);
  assert.deepEqual(hot.env.trashed, [['F1', 'F2']], 'one request, only the folders Drive tags as those texts');
  assert.deepEqual(hot.api.openTombs().map((x) => x.id), ['d3'], 'the mismatch is still open — never trashed on the device\'s word');
  assert.equal(hot.env.saved, 1, 'remembered per account');
  assert.equal(hot.env.renders, 1, 'and the rows repainted');
  assert.match(hot.env.toasts[0], /panel\.dev\.tombAuto.*"n":2/, 'told how many');
  assert.equal(hot.api.busy(), false, 'the in-flight flag is released');

  // No estate: cannot verify, so nothing is trashed (the button refuses the same way).
  const blind = tombPanel({ lastData: data, estate: null, armed: true });
  await blind.api.autoTrashTombs(null);
  assert.deepEqual(blind.env.trashed, []);

  // A per-id failure is NOT remembered as done — it comes round again on the next full render.
  const half = tombPanel({ lastData: data, estate, armed: true,
    trashResult: (ids) => ({ results: ids.map((id) => ({ id, ok: id === 'F1' })), trashed: 1, remaining: 0 }) });
  await half.api.autoTrashTombs(estate);
  assert.deepEqual(half.api.openTombs().map((x) => x.id).sort(), ['d2', 'd3'], 'F2 failed, so d2 stays open');
  assert.match(half.env.toasts[0], /"n":1/);

  // Wiring: full renders only, after the sweep has run with the tombstones counted as claims.
  const rd = PANEL_SRC.slice(PANEL_SRC.indexOf('try { estateCache = await Researcher.driveEstate(); }'), PANEL_SRC.indexOf('try { estateCache = await Researcher.driveEstate(); }') + 500);
  assert.ok(rd.indexOf('sweepUnassigned(estateCache);') < rd.indexOf('autoTrashTombs(estateCache);'), 'sweep first, then trash');
  assert.match(PANEL_SRC, /async function autoTrashTombs\(estate\) \{\s*\n\s*if \(!devMode\(\) \|\| autoTrashBusy/, 'gated on THIS panel\'s arming first');
  assert.match(PANEL_SRC, /openTombs\(\)\.filter\(\(x\) => tombFolderVerified\(x\) === true\)/, 'through the same cross-check as the button');
  for (const k of ['panel.dev.tombAuto', 'panel.dev.tombTag', 'panel.dev.tombTagTip']) {
    assert.equal((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, k + ' in both languages');
  }
});

test('a dev-removed row shows no live controls: no Done toggle, no state chip, no Files, and the trash button only when armed (v722 review)', () => {
  const row = PANEL_SRC.slice(PANEL_SRC.indexOf('const tombRows = tombs'), PANEL_SRC.indexOf('const tombRows = tombs') + 22000);   // the row renderer is long; the last anchor (the title chip) sits ~19k in
  assert.match(row, /const canSetDone = engNum >= 138 && !wiped && mAssign && !d\.__devRemoved;/, 'no Done toggle');
  assert.match(row, /const doneTag = d\.__devRemoved \? ''/, 'no done chip either');
  assert.match(row, /\|\| d\.__devRemoved \? ''\s+\/\/ a dev-removed row's folder is for the trash/, 'no Files menu / preview');
  assert.match(row, /\$\{d\.__devRemoved \? '' : `<span class="rp-tag rp-tag-\$\{DISP\}">/, 'no "local" state chip');
  assert.match(row, /const delTag = d\.__devRemoved\s*\n\s*\? `<span class="rp-tag rp-tag-deleting" title="\$\{esc\(t\('panel\.dev\.tombTagTip'\)\)\}">\$\{esc\(t\('panel\.dev\.tombTag'\)\)\}<\/span>`/, 'its own tag instead of "deleting…"');
  assert.match(row, /\? \(\(mAssign && devMode\(\)\)/, 'the trash button needs this panel armed, like "Remove, no backup"');
  assert.match(row, /open\.has\(x\.id \+ '\|' \+ x\.folderId\)/, 'rows come from the ONE open-set derivation');
});

test('a dev-removed row offers ONLY the trash, never a command to a device that lost the text', () => {
  const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  const chain = PANEL.slice(PANEL.indexOf('const del = (!d.id || d.__assigning || wiped)'), PANEL.indexOf('const del = (!d.id || d.__assigning || wiped)') + 2200);
  const iTomb = chain.indexOf('d.__devRemoved');
  const iNormal = chain.indexOf("p.kind === 'delete'");
  assert.ok(iTomb > 0 && iTomb < iNormal, 'tested BEFORE the ordinary delete states, so none of them apply');
  assert.match(chain, /data-iact="tomb-trash"/);
  assert.match(chain, /data-folder="\$\{esc\(d\.__folderId\)\}"/, 'the folder rides on the button');
});

test('trashing is remembered locally, because nothing syncs back (option 1)', () => {
  const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  assert.match(PANEL, /Researcher\.trashFiles\(\[folder\], 'dev-removed text folder'\)/, 'the existing route, no new one');
  // 3000, not 1400: the v722 review put the folder cross-check at the top of this handler and the
  // per-id result check in its middle, which grew it.
  const h = PANEL.slice(PANEL.indexOf("act === 'tomb-trash'"), PANEL.indexOf("act === 'tomb-trash'") + 3000);
  assert.ok(h.indexOf('devTombDone.add') > 0 && h.indexOf('devTombDone.add') < h.indexOf('renderDashboard'),
    'remembered before the repaint, so the row goes now and not on the next poll');
  assert.match(h, /saveTombDone\(Researcher\.currentAccountId\(\)\)/, 'and persisted per account');
  assert.match(PANEL, /loadTombDone\(Researcher\.currentAccountId\(\)\);/, 'loaded with the other per-account state');
  // No new command type was invented — that would have meant a worker allow-list change.
  assert.doesNotMatch(PANEL, /pushCommand\([^)]*'clearTombstone'/);
  assert.match(WORKER, /TEXT_COMMANDS = \['assign', 'delete', 'uploadDelete', 'setDone'\]/, 'command set unchanged');
});

test('⚠ THE GUARANTEE: a trashed folder cannot reappear in Unassigned', () => {
  /* This is the load-bearing fact behind the whole design, and it is a property of the WORKER's
   * queries rather than of anything in the client: every Drive query is scoped to untrashed files,
   * so once the folder is in the trash the estate cannot see it — and the unassigned computation is
   * part of the estate. If a future query drops that scope, this test is the thing that notices. */
  const scoped = (WORKER.match(/trashed=false/g) || []).length;
  assert.ok(scoped >= 19, `every Drive query stays scoped to untrashed files (found ${scoped})`);
  // The only reads that deliberately ask for trashed files are the trash-inspection views.
  const trashedTrue = (WORKER.match(/driveListAll\(access, true\)/g) || []).length;
  assert.ok(trashedTrue > 0 && trashedTrue <= 4,
    'and the handful of deliberate trash listings are the only exceptions');
  assert.match(WORKER, /roleOf\(f\) === 'unassigned'/, 'unassigned is derived from Drive, which is why trashing settles it');
});

test('fxTombs() lists and clears them, and is the only way to drop one early', () => {
  assert.match(APP, /window\.fxTombs = \(verb\) =>/, 'console only, like fxDev');
  const fx = APP.slice(APP.indexOf('window.fxTombs = '), APP.indexOf('window.fxTombs = ') + 900);
  assert.match(fx, /if \(verb === 'clear'\) \{ setDevTombs\(\[\]\); Sync\.reportNow\(\);/,
    'clearing reports at once, so the panel stops being offered them');
  assert.match(fx, /no dev-removed texts are flagged on this device/, 'and says so when there are none');
});

test('⚠ a folder is trashed only when Drive\'s own tag says it belongs to that text (v722 review)', () => {
  /* The worker's /trash route verifies nothing beyond the drive.file scope — it PATCHes trashed:true
   * on any app-created id, and every text folder in the estate is app-created. So the DEVICE's word
   * (the tombstone's folderId) is not enough: a stale or mis-reported id would trash another text's
   * folder with nothing in between to notice. The estate already pairs each folder with the docId
   * Drive tags it with; the panel must refuse unless they agree. */
  const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  assert.match(PANEL, /function tombFolderVerified\(tomb\) \{/, 'the check exists');
  assert.match(PANEL, /x\.docId === tomb\.id && x\.folderId === tomb\.folderId/, 'and it demands BOTH agree, from estateCache.texts');
  assert.match(PANEL, /if \(!texts\) return null;/, 'estate not loaded is "cannot say", not "fine"');
  const h = PANEL.slice(PANEL.indexOf("act === 'tomb-trash'"), PANEL.indexOf("act === 'tomb-trash'") + 2000);
  const iVerify = h.indexOf('tombFolderVerified(');
  const iConfirm = h.indexOf("confirmModal(t('panel.dev.confirmTombTrash'");
  const iTrash = h.indexOf('Researcher.trashFiles(');
  assert.ok(iVerify > 0 && iVerify < iConfirm, 'verified BEFORE the confirm — a yes to the text is not a yes to whatever folder the id was');
  assert.ok(iConfirm < iTrash, 'and the trash comes last');
  assert.match(h, /if \(verified !== true\) \{/, 'null and false are both refusals');
  for (const k of ['panel.dev.tombNoEstate', 'panel.dev.tombMismatch']) {
    assert.equal((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length, 2, `${k} in en and id`);
  }
  assert.match(I18N, /Nothing was trashed — check the text in Drive/, 'the mismatch message says nothing happened');
  // Arming has a consequence beyond the ☠, and the person arming must be told it at the moment they arm.
  assert.match(APP, /this device will also obey a researcher panel\\'s "Remove, no backup" for any un-uploaded text on it/,
    'fxDev() names the remote consequence of arming');
});

test('the strings exist in both languages, and the confirm says what it does', () => {
  for (const k of ['dev.badge', 'dev.badgeOff', 'dev.deleteTitle', 'dev.confirmDeleteNoBackup']) {
    assert.equal((I18N.match(new RegExp(`'${k.replace('.', '\\.')}':`, 'g')) || []).length, 2, `${k} in en and id`);
  }
  assert.match(I18N, /'dev\.confirmDeleteNoBackup': 'Delete .{0,12}\{title\}.{0,12} WITHOUT backing it up\?/,
    'the English confirm names the text and says WITHOUT, in capitals');
  assert.match(I18N, /cannot be undone/, 'and that it cannot be undone');
  assert.match(I18N, /'dev\.confirmDeleteNoBackup': 'Hapus/, 'with an Indonesian wording of its own');
});

test('the badge is styled to be noticed and to stay out of the dock\'s way', () => {
  assert.match(CSS, /#dev-badge \{[^}]*position: fixed/, 'fixed, so it is visible wherever you are');
  assert.match(CSS, /#dev-badge \{[^}]*left: 8px; bottom: 8px/, 'bottom-LEFT — the dock owns centre and right');
  assert.match(CSS, /\.dev-badge-off \{[^}]*min-width: 32px; min-height: 28px/, 'its off switch is big enough to hit');
  assert.match(CSS, /\.dev-del \{ color: #b91c1c; \}/, 'and the ☠ reads as dangerous');
});
