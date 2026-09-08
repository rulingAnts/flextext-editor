/* THE PLAYER DOCK'S ✕ IS A PERMISSION NOW (Seth, 2026-09-08: "We don't want or need this… Let's
 * have it be something the researcher can enable (and enabled by default on unpaired devices) but
 * that's disabled by default on all paired devices starting now… On all tabs that should be one
 * setting").
 *
 * ⚠ NO GRANDFATHERING HERE, unlike enterAtEnd. The default is computed from the pairing every time
 * rather than seeded once into a device's settings, which is what makes "starting now" true of
 * devices that were ALREADY paired — they lose the button as soon as they update. The setting is
 * the researcher's to switch back on. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), PANEL = rd('../docs/js/researcher-panel.js'), I18N = rd('../docs/js/i18n.js');

test('the gate has the same shape as its siblings', () => {
  assert.match(APP, /function allowAudioRemoveOn\(\) \{ return !Sync\.hasSession\(\) \|\| settings\.allowAudioRemove === true; \}/,
    'unpaired ⇒ on; paired ⇒ only when the researcher says so');
  // the siblings it must stay consistent with
  assert.match(APP, /function allowDeleteOn\(\) \{ return !Sync\.hasSession\(\)/);
  assert.match(APP, /function allowAudioSwapOn\(\) \{ return !Sync\.hasSession\(\)/);
});

test('the default is computed, never seeded — so already-paired devices are covered', () => {
  assert.doesNotMatch(APP, /allowAudioRemove: (true|false)/,
    'no seeded value: seeding it would grandfather the very devices "starting now" was about');
  assert.doesNotMatch(APP, /seedNewDeviceDefaults[\s\S]{0,400}allowAudioRemove/,
    'and it is not in the new-device seed either');
});

test('one switch, and the button is hidden by it', () => {
  assert.match(APP, /p\.el\.remove\.hidden = isAudioLocked\(current\) \|\| !allowAudioRemoveOn\(\);/,
    'the single place the dock decides — one dock, so one setting covers every tab');
  assert.match(APP, /if \(!current \|\| isAudioLocked\(current\) \|\| !allowAudioRemoveOn\(\)\) return;/,
    '⚠ and the handler re-checks: a researcher push can land while the button is already on screen');
});

test('the researcher can reach it, on the panel and on the device setup page', () => {
  assert.match(PANEL, /\{ k: 'allowAudioRemove', type: 'checkbox' \}/, 'researcher panel');
  assert.match(APP, /\{ k: 'allowAudioRemove', type: 'checkbox', off: 'setup\.off\.allowAudioRemove' \}/,
    'device setup page, with the standalone caveat');
  assert.doesNotMatch(APP, /\{ k: 'allowAudioRemove'[^}]*only: 'segmenter'/,
    'NOT segmenter-only — the dock is in the editor too');
});

test('it travels with a setup link, and reaches the Segmenter', () => {
  assert.match(APP, /'allowDelete', 'allowAudioRemove', 'doneEnabled'/, 'in the pushed-settings allowlist');
  assert.match(APP, /'allowDelete', 'allowAudioRemove', 'allowAudioSwap', 'allowBlankLines'/, 'and in SEGMENTER_SETUP_KEYS, beside the swap switch this audit added');
});

test('both languages carry the strings', () => {
  assert.equal((I18N.match(/'panel\.f\.allowAudioRemove':/g) || []).length, 2, 'EN + ID label');
  assert.equal((I18N.match(/'setup\.off\.allowAudioRemove':/g) || []).length, 2, 'EN + ID standalone note');
});
