/* "STOP THE COWORKER CHANGING THE CUTS" — the intent, the switch it was mistaken for, and the three
 * things that now keep them apart.
 *
 * WHAT HAPPENED (2026-10-07): a researcher wanted his coworker to transcribe against his cuts without
 * reshaping them. The panel's lock for that is five switches under "What the coworker may change"
 * plus hiding the Cut tab; what he found was "Enable Audio Segmentation Mode" on the Tasks tab, and
 * unticking it gave the coworker a plain text box with no line playback and no visible cuts.
 *
 *   1. ONE BUTTON DOES THE LOCK, in both forms, setting the SAME six keys. The device's own Settings
 *      tab and the panel's per-device form are deliberately separate code (test/device-setup); a
 *      lock that set five keys on one surface and six on the other would be the drift this suite
 *      keeps finding. The six are listed here once and matched against both handlers.
 *   2. THE MODE SWITCH SAYS WHAT OFF COSTS, and names the lock — in both languages.
 *   3. THE PANEL ASKS before a push turns the mode off on a device holding cut texts, only on the
 *      transition, and "Keep it on" re-reads the form rather than patching the patch.
 *
 * Run: node test/lock-cuts.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = read('../docs/js/app.js');
const PANEL = read('../docs/js/researcher-panel.js');
const I18N = read('../docs/js/i18n.js');
const block = (code) => {
  const at = I18N.indexOf(`\n${code}: {`);
  const rest = I18N.slice(at + 1);
  const nxt = rest.search(/\n[a-z]{2,3}: \{/);
  return nxt < 0 ? I18N.slice(at) : I18N.slice(at, at + 1 + nxt);
};
const EN = block('en'), ID = block('id');
const inBoth = (k) => {
  const re = new RegExp(`^\\s*,?'${k.replace(/\./g, '\\.')}':`, 'm');
  return re.test(EN) && re.test(ID);
};
const val = (blk, k) => (blk.match(new RegExp(`^\\s*,?'${k.replace(/\./g, '\\.')}': '((?:[^'\\\\]|\\\\.)*)'`, 'm')) || [])[1] || '';

/* The lock, as data: what every "Lock the cuts" press must set. */
const LOCK = { segmentation: true, cutTab: false, joinSplitBaseline: false, joinSplitGloss: false, adjustBoundaries: false, backspaceJoin: false, cutJoinTexted: false };
const OFF_FIVE = ['joinSplitBaseline', 'joinSplitGloss', 'adjustBoundaries', 'backspaceJoin', 'cutJoinTexted'];

function handlerBody(src, startRe) {
  const at = src.search(startRe);
  assert.ok(at >= 0, `handler found: ${startRe}`);
  return src.slice(at, at + 1200);
}

test('1. one button, both forms, the same six keys', () => {
  // The field exists, first under permissions, as an action, on both surfaces.
  for (const [name, src] of [['app.js SETUP_GROUPS', APP], ['researcher-panel.js GROUPS', PANEL]]) {
    const perms = src.slice(src.indexOf("{ id: 'permissions', fields: ["), src.indexOf("{ id: 'typing'"));
    assert.match(perms, /\{ k: 'lockCuts', type: 'action', note: 'panel\.f\.lockCutsNote' \}/, `${name}: the lock is an action with its note`);
    assert.ok(perms.indexOf("k: 'lockCuts'") < perms.indexOf("k: 'joinSplitBaseline'"), `${name}: …and sits above the switches it drives`);
  }
  const device = handlerBody(APP, /if \(which === 'lockCuts'\) \{/);
  const panel = handlerBody(PANEL, /\[data-gact="lockCuts"\]/);
  for (const [name, body] of [['device', device], ['panel', panel]]) {
    assert.match(body, /tick\('segmentation', true\)/, `${name}: the mode goes ON — a lock with the mode off is the original mistake`);
    assert.match(body, /tick\('cutTab', false\)/, `${name}: the Cut tab is hidden`);
    const five = (body.match(/for \(const k of \[([^\]]+)\]\) tick\(k, false\)/) || [])[1] || '';
    assert.deepEqual(five.match(/'([a-zA-Z]+)'/g).map((s) => s.slice(1, -1)).sort(), OFF_FIVE.slice().sort(), `${name}: exactly the five cut-changing switches go OFF`);
    assert.match(body, /lockCutsSet/, `${name}: says what it did`);
  }
  // The device button saves itself (script-set boxes fire no change); the panel's leaves Save to the researcher.
  assert.match(device, /saveDeviceSetupLive\(form, showGroup, \{ immediate: true \}\)/, 'device: persisted at once, like archivalDefaults');
  assert.match(panel, /el\.dispatchEvent\(new Event\('change'\)\)/, 'panel: change events, so the export toggles follow the mode');
  assert.doesNotMatch(panel, /changeSettings\(/, 'panel: nothing is pushed behind the researcher\'s back');
  // The data above is what both handlers encode — keep the two in one place if either changes.
  assert.equal(Object.keys(LOCK).length, 7);
  // Both action renderers carry the action's own note (archivalDefaults keeps its legacy key).
  assert.match(APP, /t\(f\.note \|\| 'panel\.f\.archivalNote'\)/, 'device renderer: the note comes from the field');
  assert.match(PANEL, /const noteKey = f\.note \|\| \(f\.k === 'archivalDefaults' \? 'panel\.f\.archivalNote' : ''\)/, 'panel renderer: the note comes from the field');
  for (const k of ['panel.f.lockCuts', 'panel.f.lockCutsNote', 'panel.f.lockCutsSet']) assert.ok(inBoth(k), `${k} in BOTH languages`);
  for (const [blk, name] of [[EN, 'en'], [ID, 'id']]) {
    const note = val(blk, 'panel.f.lockCutsNote');
    assert.ok(note.length > 80, `${name}: the note explains which switches`);
  }
});

test('2. the mode switch says what off costs the coworker, and names the lock', () => {
  for (const [blk, name, lockWord, offWord] of [[EN, 'en', 'Lock the cuts', 'not a lock'], [ID, 'id', 'Kunci potongan', 'bukan berarti terkunci']]) {
    const label = val(blk, 'panel.f.segmentation');
    const note = val(blk, 'panel.f.segmentationNote');
    assert.doesNotMatch(label, /^Enable|^Aktifkan/, `${name}: the label no longer reads as a permission`);
    assert.ok(note.includes(lockWord), `${name}: the note names the lock button ("${lockWord}")`);
    assert.ok(note.includes(offWord), `${name}: …and says off is not a lock`);
    assert.ok(note.includes(name === 'en' ? 'plain text box' : 'kotak teks biasa'), `${name}: …and what the coworker gets instead`);
  }
});

test('3. the panel asks before a push turns the mode off on a device holding cut texts', () => {
  const fn = PANEL.slice(PANEL.indexOf('function segOffWarning('), PANEL.indexOf('function settingsToRaw('));
  assert.match(fn, /d\.spans > 0/, 'reads the span count the device reports (v703+)');
  assert.match(fn, /d\.hasAudio/, '…and falls back to "has a recording" for an older engine');
  assert.match(fn, /if \(!cut && !withAudio\) return Promise\.resolve\('off'\)/, 'nothing to lose → no question');
  assert.match(fn, /data-m="keep"/, 'a labelled "Keep it on"');
  assert.match(fn, /data-m="off"/, '…and a labelled "Turn it off anyway" — never a bare OK');
  assert.match(fn, /\(\) => done\(null\)/, 'dismissing the box answers null, so nothing is pushed');
  const save = PANEL.slice(PANEL.indexOf("box.querySelector('[data-m=\"save\"]').onclick"), PANEL.indexOf('const wasArmed = firstTimeArmed;'));
  assert.match(save, /if \(target\.instance && segWasOn && collectRaw\(box\)\.segmentation === false\)/, 'devices only, and only on the transition to off');
  assert.match(save, /if \(verdict === null\) return;/, 'dismissed: no push');
  assert.match(save, /el\.dispatchEvent\(new Event\('change'\)\);[^\n]*\n\s*\}\s*\n\s*\}\s*\n\s*const patch = readForm\(box\);/, '"Keep it on" re-ticks through the form, and the patch is read AFTER the question');
  assert.ok(PANEL.indexOf('const segWasOn = ') > PANEL.indexOf('fillForm(box, toFormValues(source));'), 'segWasOn is read after the form is filled');
  assert.ok(save.indexOf('segOffWarning(') < save.length && PANEL.indexOf('firstTimeArmed = false;', PANEL.indexOf('segOffWarning(target')) > PANEL.indexOf('segOffWarning(target'),
    'the question comes BEFORE the first-time disarm');
  // The device reports the count the question reads.
  const inv = APP.slice(APP.indexOf('async function syncGatherInventory()'), APP.indexOf('const snap = {};', APP.indexOf('async function syncGatherInventory()')));
  assert.match(inv, /spans: Array\.isArray\(d\.doc && d\.doc\.segments\)/, 'the inventory carries `spans`');
  assert.match(inv, /!s\.timePending && Number\.isFinite\(s\.start\) && Number\.isFinite\(s\.end\) && s\.end > s\.start/, '…counting only real cuts, not pending placeholders');
  for (const k of ['panel.set.segOffTitle', 'panel.set.segOffCuts', 'panel.set.segOffAudio', 'panel.set.segOffBody', 'panel.set.segOffAnyway', 'panel.set.segOffKeep', 'panel.rel.new.lockCuts'])
    assert.ok(inBoth(k), `${k} in BOTH languages`);
});
