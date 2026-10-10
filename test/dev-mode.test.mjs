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
function remoteDelete(doc, armed) {
  const env = { tornDown: [], reported: 0, warned: [] };
  return new Function('env', 'doc', 'armed', `
    const db = { getDoc: async () => doc };
    const deleteUploadedDoc = async (id) => { env.tornDown.push(id); };
    const Sync = { reportNow: () => { env.reported++; } };
    const devMode = () => armed;
    const console = { warn: (...a) => env.warned.push(a.join(' ')) };
    ${liftAll(APP, ['deleteConfirmedDoc'])}
    return deleteConfirmedDoc('d1').then((r) => ({ r, env }));
  `)(env, doc, armed);
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
  assert.match(PANEL, /window\.addEventListener\('fx-dev-mode', \(\) => \{\s*\n\s*try \{ renderDashboard\(lastData \|\| undefined\); \}/,
    'the panel listens and re-renders');
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
  const { r, env } = await remoteDelete(notBackedUp, true);
  assert.equal(r, true, 'armed: the device honours it');
  assert.deepEqual(env.tornDown, ['d1'], 'through the same teardown as any other delete');
  assert.equal(env.reported, 1, 'and reports so the panel stops showing it');
  assert.match(env.warned.join(' '), /NOT safely on Drive/, 'saying so in the console');

  // Already safely on Drive: unchanged by any of this.
  const safe = { id: 'd1', modified: 100, uploadedFileId: 'f1', uploadedModified: 100 };
  for (const armed of [false, true]) {
    const s = await remoteDelete(safe, armed);
    assert.equal(s.r, true, `backed-up text deletes either way (armed=${armed})`);
  }
});

test('the panel needs NO new worker command — `delete` already exists end to end', () => {
  assert.match(RSCH, /export function deleteNow\(instanceId, docId\)\s+\{ return pushCommand\(instanceId, 'delete', \{ docId \}\); \}/,
    'the panel sends the ORDINARY delete command');
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
  assert.match(PANEL, /Researcher\.deleteNow\(id, el\.dataset\.id\)/, 'and sends the ordinary delete command');
  assert.match(PANEL, /confirmModal\(t\('panel\.dev\.confirmDelNow'/, 'behind its own confirm');
  // It must sit beside the safe one, not replace it.
  assert.match(PANEL, /data-iact="del-text"/, 'the upload-first Remove is still there');
  for (const k of ['panel.dev.delNow', 'panel.dev.confirmDelNow', 'panel.dev.delNowSent',
                   'panel.dev.tombTrash', 'panel.dev.tombTip', 'panel.dev.confirmTombTrash',
                   'panel.dev.tombTrashed', 'panel.dev.tombFailed']) {
    assert.equal((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length, 2, `${k} in en and id`);
  }
  assert.match(I18N, /panel\.dev\.confirmDelNow': 'Tell the device to delete .{0,12}\{title\}.{0,12} WITHOUT uploading it first\?/);
  assert.match(I18N, /only obey if developer mode is also on there/,
    'and the confirm says the device can still refuse — which is the safety property, stated to the user');
  // The tombstone confirm must name the outcome Seth cares about, in both directions.
  // The source has a backslash-escaped apostrophe inside the single-quoted string: Drive\'s
  assert.match(I18N, /It goes to Drive\\'s trash — not to Unassigned\./,
    'the English confirm says trash, NOT Unassigned');
  assert.match(I18N, /Folder masuk ke tempat sampah Drive — bukan ke Belum Ditugaskan\./,
    'and the Indonesian says the same');
  assert.match(I18N, /after this there is no copy left anywhere/,
    'and that nothing survives it, since that is the one thing a researcher must know first');
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
    ${liftAll(APP, ['DEV_TOMB_KEY', 'DEV_TOMB_TTL_MS', 'devTombs', 'setDevTombs', 'addDevTomb'])}
    return { devTombs, setDevTombs, addDevTomb, TTL: DEV_TOMB_TTL_MS, KEY: DEV_TOMB_KEY };
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

test('tombstones expire on their own and are pruned on read', () => {
  const old = Date.now() - (31 * 24 * 60 * 60 * 1000);
  const t = tombApp({ store: { 'flextext-dev-removed': JSON.stringify([
    { id: 'old', title: 'stale', folderId: 'F0', at: old },
    { id: 'new', title: 'fresh', folderId: 'F1', at: Date.now() },
  ]) } });
  const live = t.api.devTombs();
  assert.deepEqual(live.map((x) => x.id), ['new'], 'the stale one is gone');
  assert.equal(JSON.parse(t.env.store.get('flextext-dev-removed')).length, 1, 'and pruned from storage, not just filtered');
  assert.equal(t.api.TTL, 30 * 24 * 60 * 60 * 1000, '30 days');

  // Malformed entries never reach the report.
  const bad = tombApp({ store: { 'flextext-dev-removed': JSON.stringify([{ id: 'x' }, { folderId: 'y' }, null, 7]) } });
  assert.deepEqual(bad.api.devTombs(), [], 'an entry without both an id and a folder is dropped');
  const junk = tombApp({ store: { 'flextext-dev-removed': 'not json' } });
  assert.deepEqual(junk.api.devTombs(), [], 'and unparseable storage is simply empty');
});

test('the report carries them, and is byte-identical when there are none', () => {
  const inv = APP.slice(APP.indexOf('async function syncGatherInventory'), APP.indexOf('async function syncGatherInventory') + 9000);
  assert.match(inv, /const tombs = devTombs\(\);/);
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
  const h = PANEL.slice(PANEL.indexOf("act === 'tomb-trash'"), PANEL.indexOf("act === 'tomb-trash'") + 1400);
  assert.ok(h.indexOf('devTombDone.add') < h.indexOf('renderDashboard'),
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
