/* A NEW DEVICE IS NEVER LEFT WITHOUT SETTINGS (Seth, 2026-10-04, testing #85/#86 on staging).
 *
 * "if I create a new device and then cancel the settings, it's possible to have no settings, which we
 * don't want. That results in writing systems settings left blank, etc. … The user should not be able
 * to create a new device without the minimum required/validated settings. If they cancel the
 * first-time settings box AND there are no default settings, then the device should undo creation
 * rather than have a blank device with no settings. They need to EITHER have defaults OR set the
 * minimum settings for new devices."
 *
 * So the first-time settings box newDeviceModal opens ends in exactly one of three states: the push
 * (as before); a close without a push while the project has VALID defaults, which pushes those; or a
 * close without a push and no such defaults, which removes the device again. Pinned here: that only
 * the create flow asks for this, that every close path routes through modal()'s onClose, that a
 * successful push never counts as a dismissal, what the dismiss handler actually does when RUN against
 * stubs, which templates count as defaults when RUN through the real validator, and that the words
 * exist in both languages.
 *
 * Same mix as project-defaults-optional.test.mjs: source assertions for shape and order, and the
 * computing pieces sliced out of the panel and executed, because a regex cannot tell what a branch
 * evaluates to. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const PANEL = rd('../docs/js/researcher-panel.js');
const I18N = rd('../docs/js/i18n.js');

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const between = (src, from, to, fromAt = 0) => {
  const a = src.indexOf(from, fromAt);
  assert.ok(a >= 0, `findable: ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `findable after it: ${to}`);
  return src.slice(a, b);
};

const modalAt = PANEL.indexOf('async function openSettingsModal');
const MODAL = PANEL.slice(modalAt, PANEL.indexOf('\nfunction ', modalAt + 10));
const saveAt = MODAL.indexOf(`box.querySelector('[data-m="save"]').onclick`);
const SAVE = MODAL.slice(saveAt);
const newAt = PANEL.indexOf('function newDeviceModal()');
const NEW = PANEL.slice(newAt, PANEL.indexOf('\nasync function ', newAt + 10));

/* ── who asks for it ──────────────────────────────────────────────────────────────────────── */

test('only the create flow opens the settings box as first-time', () => {
  assert.ok(newAt > 0);
  assert.match(NEW, /await openSettingsModal\(\{ kind: 'instance', instance: \{ instance_id: inst\.instance_id[^\n]*\}, \{ projectFolderId: intoProject, firstTime: true \}\);/,
    'newDeviceModal passes firstTime: true beside the folder it already passed');
  assert.equal((PANEL.match(/firstTime: true/g) || []).length, 1, 'and nobody else does — Settings on an existing device keeps its plain cancel');
  const flat = NEW.replace(/\s*\n\s*\*\s*/g, ' ');
  assert.ok(flat.includes('Seth, 2026-10-04'), 'the comment says who asked, and when');
  assert.ok(flat.includes('They need to EITHER have defaults OR set the minimum settings for new devices'), 'and quotes the rule');
});

test('the flag only arms for a DEVICE form', () => {
  assert.match(MODAL, /let firstTimeArmed = !!\(opts\.firstTime && target\.instance && !target\.project\);/,
    'a template form could never be first-time, whatever a caller passes');
});

/* ── one place for every close path ───────────────────────────────────────────────────────── */

test('every close path (Cancel, backdrop, Escape) reaches the dismiss through modal()\'s onClose', () => {
  assert.match(MODAL, /`, true,\s*\n\s*\(\) => \{ modalOpen = false; if \(firstTimeArmed && firstTimeDismiss\) firstTimeDismiss\(\); \}\);/,
    'the onClose argument of modal() is the single router: it runs on button, backdrop and Escape alike');
  // modal() itself promises that contract — pin the promise so a refactor of modal() cannot quietly break it.
  const modalFn = between(PANEL, 'function modal(innerHtml, wide, onClose) {', '\n}\n');
  assert.match(modalFn, /onClose fires on EVERY close path \(button, backdrop, Escape\)/);
  assert.match(modalFn, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); close\(\); return; \}/);
  assert.match(modalFn, /wrap\.addEventListener\('click', \(e\) => \{ if \(e\.target === wrap\) close\(\); \}\);/);
  assert.match(modalFn, /try \{ onClose && onClose\(\); \}/);
  assert.equal((MODAL.match(/firstTimeDismiss\(\)/g) || []).length, 1, 'the dismiss is CALLED from onClose and nowhere else');
  assert.equal((MODAL.match(/firstTimeDismiss = async/g) || []).length, 1, 'and assigned exactly once');
});

/* ── a successful push is not a dismissal ─────────────────────────────────────────────────── */

test('the save handler disarms BEFORE the push and re-arms only on failure', () => {
  const disarmAt = SAVE.indexOf('firstTimeArmed = false;');
  const pushAt = SAVE.indexOf('await Researcher.changeSettings(target.instance.instance_id, patch);');
  const closeAt = SAVE.indexOf('m.close();', pushAt);
  const catchAt = SAVE.indexOf('} catch (err) {\n      errToast(err);');
  assert.ok(disarmAt > 0 && pushAt > disarmAt && closeAt > pushAt && catchAt > closeAt,
    'validate → disarm → push → close → (catch): an Escape mid-flight can no longer push defaults over, or revoke, a device whose settings are landing');
  assert.ok(disarmAt > SAVE.indexOf('const patch = readForm(box);'), 'disarmed only once the form has passed validation — a refused save leaves Cancel meaningful');
  assert.match(SAVE, /const wasArmed = firstTimeArmed;\s*\n\s*firstTimeArmed = false;/);
  assert.match(SAVE.slice(catchAt), /if \(wasArmed\) \{\s*\n\s*firstTimeArmed = true;\s*\n\s*if \(!modalOpen\) deps\.toast\(t\('panel\.new\.createdNotConfigured'\), 9000\);/,
    'a failed push re-arms (the box is still open, Cancel still acts); a failed push after the box was already closed says the device exists unconfigured');
  assert.equal((SAVE.match(/firstTimeArmed = true;/g) || []).length, 1, 'nothing else re-arms');
});

/* ── which defaults count ─────────────────────────────────────────────────────────────────── */

test('the defaults decision, RUN through the real validator: valid for a DEVICE, appLang dropped', () => {
  const t = (k) => `<${k}>`;
  const deps = { parseDriveFolder: () => null };
  const validateSrc = between(PANEL, 'function validateDeviceSettings(raw, opts = {}) {', '\n}\n') + '\n}';
  const toRawSrc = between(PANEL, 'function settingsToRaw(s) {', '\n}\n') + '\n}';
  // The dismiss handler sits inside the same `if (firstTimeArmed) {`, so the slice stops before it and closes the block itself.
  const decideSrc = between(MODAL, 'let firstTimeDefaults = null;', '/* Runs from onClose') + '\n}';
  const decide = new Function('firstTimeArmed', 'ownedFolder', 'projectDefaults', 'deps', 't',
    `const NEVER_A_PROJECT_DEFAULT = ['appLang'];\n${validateSrc}\n${toRawSrc}\n${decideSrc}\nreturn firstTimeDefaults;`);
  const good = { vernLang: 'iau', analLang: 'id', sendOptions: ['save'], appLang: 'id', glossBreak: 'period' };
  const pd = (tpls) => (f) => (f && tpls[f]) || null;
  assert.deepEqual(decide(true, 'P1', pd({ P1: good }), deps, t), { vernLang: 'iau', analLang: 'id', sendOptions: ['save'], glossBreak: 'period' },
    'valid defaults are pushed as the seeded form would have pushed them: appLang (a one-shot command) left out');
  assert.equal(good.appLang, 'id', 'the stored template is not mutated');
  assert.equal(decide(true, 'P1', pd({ P1: { ...good, analLang: '' } }), deps, t), null, 'a template missing a required code is no default — the device would be unusable');
  assert.equal(decide(true, 'P1', pd({ P1: { ...good, sendOptions: ['share'] } }), deps, t), null, 'nor one with no way to get work out');
  assert.equal(decide(true, 'P1', pd({ P1: { ...good, consentAsk: ['audio'] } }), deps, t), null,
    'nor audio consent without a prompt: a fine TEMPLATE (templateMode relaxes it) but an unusable device — the push rule applies');
  assert.equal(decide(true, 'P1', pd({ P1: {} }), deps, t), null, 'an empty template counts as none');
  assert.equal(decide(true, '', pd({ P1: good }), deps, t), null, 'a member\'s device in a shared project resolves no owned folder → no defaults → undo');
  assert.equal(decide(false, 'P1', pd({ P1: good }), deps, t), null, 'not first-time: nothing is decided at all');
  assert.doesNotMatch(decideSrc, /templateMode/, 'never validated as a template');
});

/* ── what the dismiss does ────────────────────────────────────────────────────────────────── */

test('the dismiss handler, RUN: pushes the defaults when there are some, removes the device when not, and never lies', async () => {
  const src = between(MODAL, 'firstTimeDismiss = async () => {', '\n    };') + '\n    };';
  const build = new Function('target', 'firstTimeDefaults', 'Researcher', 'deps', 't', 'renderDashboard', 'console',
    `let firstTimeDismiss = null;\n${src}\nreturn firstTimeDismiss;`);
  const quiet = { warn() {} };
  const run = async (defaults, { pushThrows = false, revokeThrows = false } = {}) => {
    const calls = [], toasts = [];
    let repainted = 0;
    const Researcher = {
      async changeSettings(id, s) { calls.push(['changeSettings', id, s]); if (pushThrows) throw new Error('offline'); },
      async revokeInstance(id) { calls.push(['revokeInstance', id]); if (revokeThrows) throw new Error('502'); },
    };
    const fn = build({ instance: { instance_id: 'i-new', nickname: 'Barnabas’ phone' } }, defaults, Researcher,
      { toast: (msg, ms) => toasts.push([msg, ms]) }, (k, v) => `${k}${v ? ':' + v.name : ''}`, () => { repainted++; }, quiet);
    await fn();
    return { calls, toasts, repainted };
  };
  const tpl = { vernLang: 'iau', analLang: 'id', sendOptions: ['save'] };

  const b = await run(tpl);
  assert.deepEqual(b.calls, [['changeSettings', 'i-new', tpl]], 'state (b): the defaults go to the device through the ordinary push');
  assert.deepEqual(b.toasts, [['panel.set.firstDefaultsSent:Barnabas’ phone', 8000]]);
  assert.equal(b.repainted, 1);

  const bFail = await run(tpl, { pushThrows: true });
  assert.deepEqual(bFail.toasts, [['panel.new.createdNotConfigured', 9000]], 'a failed defaults push says the device exists unconfigured — the existing honest string');
  assert.ok(!bFail.calls.some((c) => c[0] === 'revokeInstance'), 'and never falls through to removing it');

  const c = await run(null);
  assert.deepEqual(c.calls, [['revokeInstance', 'i-new']], 'state (c): no defaults → the creation is undone through the same revoke the card\'s Delete uses');
  assert.deepEqual(c.toasts, [['panel.set.firstUndone:Barnabas’ phone', 9000]]);
  assert.equal(c.repainted, 1, 'the card disappears now, not at the next poll');

  const cFail = await run(null, { revokeThrows: true });
  assert.deepEqual(cFail.toasts, [['panel.set.firstUndoFailed:Barnabas’ phone', 10000]], 'a failed removal is reported as a device that exists without settings, never as removed');
  assert.equal(cFail.repainted, 1);
});

test('the revoke the dismiss uses is the one the device card already uses', () => {
  assert.match(PANEL, /else if \(act === 'revoke'\) \{[\s\S]{0,400}Researcher\.revokeInstance\(id\)/);
  assert.match(MODAL, /await Researcher\.revokeInstance\(target\.instance\.instance_id\);/);
});

/* ── the note says what Cancel will do ────────────────────────────────────────────────────── */

test('the first-time box appends what Cancel does to its intro note — chosen by the same decision', () => {
  const noteAt = MODAL.indexOf("const cancelKey = firstTimeArmed ? (firstTimeDefaults ? 'panel.set.firstCancelDefaults' : 'panel.set.firstCancelUndo') : '';");
  assert.ok(noteAt > MODAL.indexOf('let firstTimeDefaults = null;'), 'decided after the defaults are known');
  assert.ok(noteAt < MODAL.indexOf('fillForm(box, toFormValues(source));'), 'and before the form is filled, like the other notes');
  assert.match(MODAL, /const text = \[noteKey && t\(noteKey\), cancelKey && t\(cancelKey\)\]\.filter\(Boolean\)\.join\(' '\);/,
    'appended to the unconfigured / fromTemplate note when present, standing alone otherwise');
  assert.equal((MODAL.match(/if \(h\) h\.insertAdjacentHTML\('afterend', `<p class="note">/g) || []).length, 1, 'still one note under the title');
});

/* ── strings ──────────────────────────────────────────────────────────────────────────────── */

test('every new string exists in English first and Indonesian second, and is used', () => {
  const idAt = I18N.indexOf('\nid: {');
  for (const k of ['panel.set.firstCancelDefaults', 'panel.set.firstCancelUndo', 'panel.set.firstDefaultsSent',
    'panel.set.firstUndone', 'panel.set.firstUndoFailed']) {
    const re = new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'gm');
    const at = [...I18N.matchAll(re)].map((m) => m.index);
    assert.equal(at.length, 2, `${k}: once per language`);
    assert.ok(at[0] < idAt && at[1] > idAt, `${k}: en block, then id block`);
    assert.ok(PANEL.includes(`'${k}'`), `${k}: actually used by the panel`);
  }
  const en = (k) => (I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '([^']*)'`)) || [])[1] || '';
  assert.match(en('panel.set.firstCancelDefaults'), /^If you cancel instead, /);
  assert.match(en('panel.set.firstCancelUndo'), /^If you cancel instead, /);
  assert.match(en('panel.set.firstDefaultsSent'), /\{name\}[\s\S]*Settings/, 'names the device and points at Settings');
  assert.match(en('panel.set.firstUndone'), /^(\\u201c|“)\{name\}(\\u201d|”) was not created: /);
  assert.match(en('panel.set.firstUndoFailed'), /could not be removed/, 'the failure toast never claims removal');
  assert.doesNotMatch(en('panel.set.firstUndoFailed'), /was not created|removed again/);
});
