/* PROJECT DEFAULTS ARE OPTIONAL, AND A DEVICE'S SETTINGS CAN START THEM (#85/#86).
 *
 * Brian Plimley, 2026-09-30: New Project → name → the "Default settings" dialog opened; he cancelled
 * it, and the project (and its Drive folder) turned up in the list anyway (#85). And: make the
 * project's "default device settings" optional — overwhelming when you are just starting, and
 * confusing when no device is being made yet (#86).
 *
 * Seth, 2026-10-02: "the user doesn't have to set defaults for the project, but they DO have to fill
 * in required device settings (which we have set up with validation rules already) for a new device,
 * and maybe it would be good to ask them if they want to make those settings default for other new
 * devices."
 *
 * So two things are pinned here: creation no longer opens the template form (the rewritten block in
 * project-template-apply.test.mjs covers the toast), and the DEVICE form offers — once, while the
 * project has no template, owner-only — to keep what was just pushed as the project's defaults.
 * The offer's dangerous edges are where this file spends its effort: it must never turn a successful
 * push into an error, never replace an existing template, never push to other devices, and never
 * carry the one-shot language command into a template.
 *
 * Mixed on purpose: source assertions for SHAPE (what happens before what, what is absent), and the
 * three small pieces that compute something — the folder resolution, the offer, the save step and
 * the template builder — sliced out of the panel and RUN against stubs, because a regex can confirm
 * an order of statements but not what they evaluate to. */
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
const deviceAt = SAVE.indexOf('} else {', SAVE.indexOf('if (target.project) {'));
const DEVICE = SAVE.slice(deviceAt);   // the device (non-template) branch of the save handler

/* ── creation ─────────────────────────────────────────────────────────────────────────────── */

test('creating a project ends at the toast — no settings dialog whose Cancel creates nothing (#85)', () => {
  const at = PANEL.indexOf('async function projectNewModal');
  const body = PANEL.slice(at, PANEL.indexOf('\nasync function ', at + 10));
  assert.ok(at > 0);
  assert.doesNotMatch(body, /openSettingsModal\(/, 'no Default settings dialog after the commit point');
  const toastAt = body.indexOf("deps.toast(t('panel.proj.created'");
  assert.ok(toastAt > body.indexOf('Researcher.projectCreate(name)'), 'the toast follows the create');
  assert.match(body, /required[\s\S]{0,400}2026-08-31[\s\S]{0,2000}Reversed on 2026-10-02/,
    'the comment keeps the history honest: required on 2026-08-31, reversed on 2026-10-02');
  const flat = body.replace(/\s*\n\s*\*\s*/g, ' ');   // comment text with its line breaks folded
  assert.ok(flat.includes('#85/#86, Brian Plimley, 2026-09-30; Seth, 2026-10-02'), 'and cites who asked, and when');
});

/* ── where the offer may appear ───────────────────────────────────────────────────────────── */

test('the device\'s owned folder is resolved once, in device mode only, before the seed reads it', () => {
  const resAt = MODAL.indexOf("let ownedFolder = '';");
  const seedAt = MODAL.indexOf('let seededFromTemplate = false;');
  const offerAt = MODAL.indexOf('const offerAsDefault');
  assert.ok(resAt > 0 && seedAt > resAt && offerAt > seedAt, 'resolve → seed → offer');
  assert.match(MODAL, /let ownedFolder = '';\s*\n\s*if \(target\.instance && !target\.project\) \{\s*\n\s*ownedFolder = opts\.projectFolderId \|\| '';/,
    'template mode never resolves one');
  const loadAt = MODAL.indexOf('if (ownedFolder) await loadProjectDefaults();');
  assert.ok(loadAt > resAt && loadAt < seedAt && loadAt < offerAt,
    'defaults are loaded before EITHER synchronous reader (the projDefCache rule)');
  assert.equal((MODAL.match(/let folder = /g) || []).length, 0, 'no second, divergent resolution left behind');
});

test('the resolution resolves exactly what it did before — run against an estate', () => {
  const src = between(MODAL, "let ownedFolder = '';", '/* ⚠ loadProjectDefaults() BEFORE either reader');
  const resolve = new Function('target', 'opts', 'estateCache', `${src}\nreturn ownedFolder;`);
  const estate = { devices: [
    { folderId: 'F-dev1', instanceId: 'i1', projectId: 'P-mine' },
    { folderId: 'F-dev2', projectId: 'P-other' },           // older worker: no instanceId stamp
    { folderId: 'F-stray', instanceId: 'i3', projectId: '' }, // not in a project yet
  ] };
  const dev = (id, folder) => ({ kind: 'instance', instance: { instance_id: id, oauth_folder_id: folder } });
  assert.equal(resolve(dev('new', ''), { projectFolderId: 'P-new' }, null), 'P-new',
    'the create flow\'s folder wins (the estate cannot know a device made seconds ago)');
  assert.equal(resolve(dev('i1', 'zzz'), {}, estate), 'P-mine', 'by the worker\'s instanceId stamp');
  assert.equal(resolve(dev('i2', 'F-dev2'), {}, estate), 'P-other', 'by folder id, the fallback');
  assert.equal(resolve(dev('i3', 'F-stray'), {}, estate), '', 'a device in no project resolves nothing');
  assert.equal(resolve(dev('member-dev', 'F-owners'), {}, estate), '',
    'a device in SOMEONE ELSE\'S project is not in this caller\'s own estate → nothing → no offer');
  assert.equal(resolve({ kind: 'project', project: { folderId: 'P-mine' } }, {}, estate), '',
    'template mode resolves nothing');
  assert.equal(resolve(dev('i1', ''), {}, null), '', 'a cold estate cache is not an error');
});

test('the offer appears only with an owned folder AND no template yet — run against stubs', () => {
  const src = between(MODAL, 'const ownedTpl = ', 'if (offerAsDefault) {');
  const offer = new Function('ownedFolder', 'projectDefaults', 'estateCache', 't',
    `${src}\nreturn { offerAsDefault, ownedName };`);
  const tpls = { 'P-has': { vernLang: 'iau' }, 'P-emptyobj': {} };
  const pd = (f) => (f && tpls[f]) || null;
  const estate = { projects: [{ folderId: 'P-new', name: 'Fayu corpus' }, { folderId: 'P-has', name: 'Dani' }] };
  const t = (k) => `<${k}>`;
  assert.deepEqual(offer('P-new', pd, estate, t), { offerAsDefault: true, ownedName: '\u201cFayu corpus\u201d' },
    'a known project is named, in quotes the NAME carries (the strings print {name} bare)');
  assert.equal(offer('P-has', pd, estate, t).offerAsDefault, false,
    'a project WITH defaults is changed on the Projects card, never overwritten from here');
  assert.equal(offer('P-emptyobj', pd, estate, t).offerAsDefault, true, 'an empty template counts as none');
  assert.equal(offer('', pd, estate, t).offerAsDefault, false, 'no owned folder (member device, stray, template) → no offer');
  assert.equal(offer('P-unknown', pd, null, t).ownedName, '<panel.set.thisProject>',
    'a project the cache has not caught up with is "this project" — never "Default Project", a REAL project\'s name');
  assert.doesNotMatch(between(MODAL, 'const ownedTpl = ', 'if (offerAsDefault) {'), /panel\.proj\.defaultName/);
});

test('the checkbox is rendered only inside the offer, unticked, and is not a setting', () => {
  const blockAt = MODAL.indexOf('if (offerAsDefault) {');
  const block = MODAL.slice(blockAt, MODAL.indexOf('\n  }', blockAt));
  assert.match(block, /id="rp-set-asdefault"/, 'the checkbox lives in the offer block');
  assert.equal((MODAL.match(/id="rp-set-asdefault"/g) || []).length, 1, '...and nowhere else in the modal');
  assert.doesNotMatch(block, /checked/, 'UNTICKED by default — an offer, not a decision made for them');
  assert.doesNotMatch(block, /data-f/, 'no data-f: collectRaw would otherwise read it as a setting');
  assert.match(block, /'panel\.set\.asProjectDefault', \{ name: ownedName \}/, 'it names the project');
  assert.match(block, /'panel\.set\.asProjectDefaultNote'/, 'with its one-line note');
  assert.match(block, /insertAdjacentHTML\('beforebegin'/, 'placed just above the Push button\'s encryption note');
});

/* ⚠ THE DEFAULT SETTINGS BUTTON LOADS BEFORE IT OPENS (#85/#86 review). openSettingsModal prefills a
 * template form SYNCHRONOUSLY from projectDefaults(); opened on a cold cache it shows an empty form,
 * and a save from that form would wipe the template the owner came to edit. */
test("the Projects card's Default settings button awaits loadProjectDefaults() before opening the form", () => {
  const at = PANEL.indexOf("if (act === 'defaults') {");
  assert.ok(at > 0, 'the button\'s action is findable');
  const blk = PANEL.slice(at, PANEL.indexOf('return;', at));
  assert.match(blk,
    /busy\(el, async \(\) => \{\s*await loadProjectDefaults\(\);\s*openSettingsModal\(\{ kind: 'project', project: \{ folderId: el\.dataset\.folder, name: el\.dataset\.name \|\| '' \} \}\);/,
    'load, awaited, then open — inside busy() so a second tap during the load does nothing');
  assert.equal((PANEL.match(/openSettingsModal\(\{ kind: 'project'/g) || []).length, 1,
    'and that is the only way into the template form, so no other path can skip the load');
});

/* ── what the save does with it ───────────────────────────────────────────────────────────── */

test('the template is saved only AFTER the push succeeds, only when ticked, in its own try', () => {
  const pushAt = DEVICE.indexOf('await Researcher.changeSettings(target.instance.instance_id, patch);');
  const saveCallAt = DEVICE.indexOf('await saveProjectDefaults(ownedFolder, deviceSettingsAsTemplate(patch));');
  assert.ok(pushAt > 0 && saveCallAt > pushAt, 'push first; the template is a second, separate fact');
  assert.match(DEVICE, /const asDefault = !!\(asDefaultBox && asDefaultBox\.checked\);/, 'the box decides');
  assert.match(DEVICE, /const asDefaultBox = offerAsDefault \? box\.querySelector\('#rp-set-asdefault'\) : null;/,
    '...and only where it was offered');
  assert.match(DEVICE, /if \(asDefault\) \{\s*\n\s*try \{\s*\n\s*await loadProjectDefaults\(\{ strict: true \}\);/,
    'gated on the box, inside its OWN try, re-reading strictly before writing');
  const tryAt = DEVICE.indexOf('if (asDefault) {');
  const catchAt = DEVICE.indexOf('} catch (err) {', tryAt);
  assert.ok(tryAt < saveCallAt && saveCallAt < catchAt, 'the save sits inside that try');
  assert.ok(DEVICE.indexOf("doneKey = 'panel.set.asDefaultFailed'", catchAt) > catchAt,
    'and its failure becomes a toast, never the outer errToast');
});

test('the device branch never pushes to other devices or touches the pending-apply list', () => {
  const branch = DEVICE.slice(0, DEVICE.indexOf('} catch (err) { errToast(err); }'));
  // Calls only: the branch's comment names applyTemplateModal to say why it is NOT used.
  assert.doesNotMatch(branch, /applyTemplateModal\(/, 'no apply-to-devices chooser from a device save');
  assert.doesNotMatch(branch, /savePendingApply\(|projPendCache|'projectDefaultsPending'/, 'no pending-apply bookkeeping');
});

test('the save step, RUN: every outcome is one toast and none of them is an error', async () => {
  const src = between(DEVICE, "let doneKey = 'panel.set.pushed';", '\n        m.close();');
  const step = new AsyncFunction('asDefault', 'ownedFolder', 'patch', 'loadProjectDefaults', 'projectDefaults',
    'saveProjectDefaults', 'deviceSettingsAsTemplate', 'console', `${src}\nreturn doneKey;`);
  const quiet = { warn() {} };
  const asTpl = (p) => { const c = { ...p }; delete c.appLang; return c; };
  const patch = { vernLang: 'iau', analLang: 'id', appLang: 'id' };
  const run = async (asDefault, { tpl = null, loadThrows = false, saveThrows = false } = {}) => {
    const saved = [];
    const key = await step(asDefault, 'P1', patch,
      async (o) => { if (loadThrows && o && o.strict) throw new Error('offline'); },
      () => tpl,
      async (f, s) => { if (saveThrows) throw new Error('409'); saved.push([f, s]); },
      asTpl, quiet);
    return { key, saved };
  };
  assert.deepEqual(await run(false), { key: 'panel.set.pushed', saved: [] }, 'unticked: nothing stored');
  const ok = await run(true);
  assert.equal(ok.key, 'panel.set.pushedAsDefault');
  assert.deepEqual(ok.saved, [['P1', { vernLang: 'iau', analLang: 'id' }]], 'stored for THIS project, appLang removed');
  assert.deepEqual(patch, { vernLang: 'iau', analLang: 'id', appLang: 'id' }, 'the pushed patch is not mutated');
  assert.deepEqual(await run(true, { saveThrows: true }), { key: 'panel.set.asDefaultFailed', saved: [] },
    'a failed save is reported as exactly that — the push still counts');
  assert.deepEqual(await run(true, { loadThrows: true }), { key: 'panel.set.asDefaultFailed', saved: [] },
    'an unreadable prefs map is never written over');
  assert.deepEqual(await run(true, { tpl: { vernLang: 'dnw' } }), { key: 'panel.set.asDefaultExists', saved: [] },
    'a template that appeared while the form was open is KEPT');
});

/* ── the template builder ─────────────────────────────────────────────────────────────────── */

test('deviceSettingsAsTemplate, RUN: drops the one-shot language command and nothing else', () => {
  const src = between(PANEL, 'const NEVER_A_PROJECT_DEFAULT', '\n}\n') + '\n}';
  const build = new Function(`${src}\nreturn { NEVER_A_PROJECT_DEFAULT, deviceSettingsAsTemplate };`)();
  assert.deepEqual(build.NEVER_A_PROJECT_DEFAULT, ['appLang']);
  const pushed = {
    vernLang: 'iau', analLang: 'id', appLang: 'en', sendOptions: ['save', 'upload'],
    toolbarButtons: ['play'], autoDelUploaded: true, autoBackupMins: 15, maxRecordSeconds: 0,
    consentAsk: ['audio'], consentAudioUrl: 'https://x/p', consentAudio: 'https://x/p', glossBreak: 'period',
  };
  const tpl = build.deviceSettingsAsTemplate(pushed);
  assert.equal('appLang' in tpl, false, 'appLang never becomes a project default');
  const { appLang, ...rest } = pushed;
  assert.deepEqual(tpl, rest, 'everything the template form also shows is kept — consent prompt included');
  assert.equal(pushed.appLang, 'en', 'a copy, not the caller\'s object');
  assert.deepEqual(build.deviceSettingsAsTemplate(null), {});
  assert.deepEqual(build.deviceSettingsAsTemplate({ vernLang: 'x' }), { vernLang: 'x' }, 'no appLang, nothing to drop');
});

test('the device form and the template form are one form, so appLang is the only exclusion needed', () => {
  // Both modes render SET_TABS and read back through readForm; the only device-only control is the
  // nickname, which never enters the patch (renameInstance carries it).
  assert.match(MODAL, /\$\{SET_TABS\.map\(tabPanelHtml\)\.join\(''\)\}/);
  assert.match(MODAL, /const patch = readForm\(box\);/);
  assert.doesNotMatch(PANEL.slice(PANEL.indexOf('function readForm'), PANEL.indexOf('\n}', PANEL.indexOf('function readForm'))),
    /nick/, 'readForm never reads the device name');
  assert.match(PANEL, /if \(patch\.appLang === 'follow' \|\| !patch\.appLang\) delete patch\.appLang;/,
    'appLang is already a one-shot command in readForm — the template exclusion follows the same rule');
});

test('loadProjectDefaults keeps its forgiving default and gains a strict mode for writers', () => {
  const fn = between(PANEL, 'async function loadProjectDefaults', '\n}\n');
  assert.match(fn, /\{ strict = false \} = \{\}/, 'forgiving by default — every existing caller unchanged');
  assert.match(fn, /projDefCache = \{\}; projPendCache = \{\};\s*\n\s*if \(strict\) throw err;/,
    'strict resets the same way, then rethrows');
});

/* ── strings ──────────────────────────────────────────────────────────────────────────────── */

test('every new string exists in English first and Indonesian second', () => {
  const idAt = I18N.indexOf('\nid: {');
  for (const k of ['panel.set.asProjectDefault', 'panel.set.asProjectDefaultNote', 'panel.set.pushedAsDefault',
    'panel.set.asDefaultFailed', 'panel.set.asDefaultExists', 'panel.set.thisProject']) {
    const re = new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'gm');
    const at = [...I18N.matchAll(re)].map((m) => m.index);
    assert.equal(at.length, 2, `${k}: once per language`);
    assert.ok(at[0] < idAt && at[1] > idAt, `${k}: en block, then id block`);
    assert.ok(PANEL.includes(`'${k}'`), `${k}: actually used by the panel`);
  }
  const en = (k) => (I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '([^']*)'`)) || [])[1] || '';
  assert.match(en('panel.set.asProjectDefault'), /^Also use these settings as the defaults for new devices in \{name\}$/);
  for (const k of ['panel.set.asProjectDefault', 'panel.set.pushedAsDefault', 'panel.set.asDefaultFailed', 'panel.set.asDefaultExists']) {
    assert.doesNotMatch(en(k), /(\\u201c|\u201c)\{name\}(\\u201d|\u201d)/,
      `${k}: {name} is printed bare — the quotes belong to a real name, and the neutral fallback has none`);
  }
  assert.equal(en('panel.set.thisProject'), 'this project');
  for (const k of ['panel.set.pushedAsDefault', 'panel.set.asDefaultFailed', 'panel.set.asDefaultExists']) {
    assert.match(en(k), /^Settings sent to the device/, `${k}: leads with the push, which DID happen`);
  }
  assert.doesNotMatch(I18N, /'panel\.proj\.nowDefaults':/, 'the retired key is gone from both blocks');
});
