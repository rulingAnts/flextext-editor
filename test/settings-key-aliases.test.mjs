/* A FIELD KEY THAT IS NOT A STORAGE KEY REPORTS NOTHING (audit, 2026-09-09).
 *
 * Two settings are DISPLAYED under one key and STORED under another:
 *   autoDel → autoDelUploaded      buttons → toolbarButtons
 * The mapping is deliberate — the URL parameters in existing setup links carry the display names,
 * so renaming the stored keys would break links already in the field. But it is a trap: anyone
 * adding the key they can see in the settings form to the device's report snapshot would add a name
 * nothing ever writes, and the setting would silently report as unset for every device.
 *
 * ⚠ consentAudio / consentAudioUrl is NOT one of these. Both are real stored keys that coexist —
 * the engine falls back between them (app.js `settings.consentAudioUrl || … || settings.consentAudio`).
 * It appears in APPLY_DISPLAY_KEY only so the "what changed" summary can find a label for it, which
 * is why that map cannot be used as the list of aliases. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), PANEL = rd('../docs/js/researcher-panel.js');

/* display key → the key actually stored. Kept here rather than read from APPLY_DISPLAY_KEY on
 * purpose: that map mixes aliases with label lookups, so it is the wrong source of truth. */
const ALIASES = { autoDel: 'autoDelUploaded', buttons: 'toolbarButtons' };

const snapshot = APP.slice(APP.indexOf("for (const k of ['vernLang'"), APP.indexOf("if (settings[k] !== undefined)"));

test('the report snapshot carries the STORED key, never the displayed one', () => {
  for (const [shown, stored] of Object.entries(ALIASES)) {
    assert.ok(snapshot.includes(`'${stored}'`), `${stored} must be in the snapshot`);
    assert.ok(!snapshot.includes(`'${shown}'`),
      `${shown} is a display key — putting it in the snapshot would report nothing`);
  }
});

test('and both really are field keys, so this test still means something', () => {
  for (const shown of Object.keys(ALIASES)) {
    assert.match(APP, new RegExp(`\\{ k: '${shown}'`), `device setup page shows ${shown}`);
    assert.match(PANEL, new RegExp(`\\{ k: '${shown}'`), `researcher panel shows ${shown}`);
  }
});

test('each alias is mapped back for the form, in both surfaces', () => {
  assert.match(APP, /else if \(f\.k === 'autoDel'\) v\.autoDel = !!s\.autoDelUploaded;/);
  assert.match(PANEL, /else if \(f\.k === 'autoDel'\) v\.autoDel = !!s\.autoDelUploaded;/);
  assert.match(PANEL, /f\.k === 'autoDel' \? 'autoDelUploaded' : f\.k === 'buttons' \? 'toolbarButtons' : f\.k/,
    'and back the other way when collecting keys to push');
});

/* ⚠ consentMode/consentResp are deprecated but deliberately still in the snapshot: a device
 * enrolled before consent became multi-select would otherwise lose its consent settings. */
test('the deprecated consent keys stay, and say why', () => {
  assert.ok(snapshot.includes("'consentMode'") && snapshot.includes("'consentResp'"),
    'still carried, so an older device keeps its consent settings');
  assert.match(PANEL, /DEPRECATED, STILL HONOURED/, 'and the migration explains itself');
  assert.match(PANEL, /review after 2027-09-01/, 'with a date to revisit, not an open-ended maybe');
});
