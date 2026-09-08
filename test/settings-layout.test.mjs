/* THE SETTINGS LAYOUT: four macro-tabs, nine collapsible sections, and the SCOPE of each setting
 * across the three surfaces that render it (Seth, 2026-09-09).
 *
 * The request was two things at once. "Do an audit of the device settings layout and organization.
 * We added a lot of settings and switches haphazardly" — answered by the section table itself,
 * pinned in device-setup.test.mjs. And then: "I'd also like this new layout to apply to project
 * default settings and to unpaired device settings (though pay careful attention to which settings
 * are specific to unpaired devices and which settings are only applicable to paired devices)."
 *
 * THE THREE SURFACES:
 *   1. the researcher panel, per device      — openSettingsModal({ instance })
 *   2. the researcher panel, project default — openSettingsModal({ project }), templateMode
 *   3. the unpaired device's own Settings tab — renderDeviceSetup(), app.js SETUP_GROUPS
 * 1 and 2 are the SAME form: one GROUPS table, one modal, one renderer. So the scope that can
 * actually diverge is only ever (a) paired vs unpaired and (b) device vs template — and this file
 * is where both are written down, because the failure mode is silent. A setting that means nothing
 * where it is shown does not throw; it just quietly misleads whoever ticks it.
 *
 * ⚠ WHY NOTHING IS HIDDEN. An inert control is greyed and says why on tap (`off:`), never removed:
 * a setting that vanishes when a device is paired is a setting nobody can find twice, and the
 * researcher reading the panel needs to see the same list the coworker sees. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), PANEL = rd('../docs/js/researcher-panel.js');
const I18N = rd('../docs/js/i18n.js'), CSS = rd('../docs/css/app.css');

// Field entries, lifted textually — the tables reference module constants we do not want to build.
const entries = (src, name) => {
  const m = src.match(new RegExp(`^const ${name} = (\\[[\\s\\S]*?^\\]);$`, 'm'));
  assert.ok(m, `${name} is findable`);
  return [...m[1].matchAll(/\{\s*k: '(\w+)'((?:[^{}]|\{[^{}]*\})*)\}/g)].map((x) => ({ k: x[1], rest: x[2] }));
};
const SETUP = entries(APP, 'SETUP_GROUPS');
const GROUPS = entries(PANEL, 'GROUPS');
const setupField = (k) => SETUP.find((f) => f.k === k);

/* ── scope 1: paired only ──────────────────────────────────────────────────────────────────── */

/* Ten settings mean nothing on a device working alone, for exactly two reasons. Six because the
 * engine gate short-circuits — `!Sync.hasSession() || settings.X === true` reads as "a lone worker
 * always has this", so a switch offering to take it away would be lying. Four because they wait on
 * an upload with no researcher Drive behind it to succeed. */
const PAIRED_ONLY = {
  allowDelete: 'gate short-circuits when unpaired',
  deleteAllEnabled: 'gate short-circuits when unpaired',
  allowAudioRemove: 'gate short-circuits when unpaired',
  allowAudioSwap: 'gate short-circuits when unpaired',
  allowBlankLines: 'gate short-circuits when unpaired',
  allowTextEdit: 'gate short-circuits when unpaired',
  autoDel: 'needs an upload that has succeeded',
  autoBackup: 'needs an upload target',
  autoBackupMins: 'needs an upload target',
  doneEnabled: 'reports to a researcher and auto-uploads',
};

test('every paired-only setting is greyed on the unpaired form, with a reason', () => {
  for (const [k, why] of Object.entries(PAIRED_ONLY)) {
    const f = setupField(k);
    assert.ok(f, `${k} is on the unpaired form at all — shown, not hidden`);
    const off = f.rest.match(/off: '([\w.]+)'/);
    assert.ok(off, `${k} carries an off: reason (${why})`);
    assert.equal((I18N.match(new RegExp(`'${off[1]}':`, 'g')) || []).length, 2,
      `${off[1]} is written in BOTH languages — a reason nobody can read is not a reason`);
  }
});

test('and the six gates really are the short-circuiting kind', () => {
  for (const k of ['allowDelete', 'allowAudioRemove', 'allowAudioSwap', 'allowBlankLines', 'allowTextEdit']) {
    assert.match(APP, new RegExp(`!Sync\\.hasSession\\(\\) \\|\\| settings\\.${k} === true`),
      `${k}'s gate is unpaired-means-on`);
  }
  assert.match(APP, /!Sync\.hasSession\(\) \|\| loadSettings\(\)\.deleteAllEnabled === true/,
    'and Delete All the same, reading through loadSettings');
});

/* ⚠ THE SWITCH THIS AUDIT FOUND MISSING. allowAudioSwapOn() has gated the Segmenter's "swap the
 * recording" button since it was written, but the setting had NO FIELD on either surface — so on a
 * managed device it read `settings.allowAudioSwap === true` against a value nothing could ever set,
 * and the button was unreachable on every paired device in the field. A gate with no switch is a
 * feature that only works by accident, alone. */
test('allowAudioSwap now has a switch, on both surfaces', () => {
  assert.ok(setupField('allowAudioSwap'), 'unpaired form');
  assert.ok(GROUPS.find((f) => f.k === 'allowAudioSwap'), 'researcher panel');
  assert.match(APP, /'allowAudioSwap'.*'allowBlankLines'/, 'and the Segmenter shows it (SEGMENTER_SETUP_KEYS)');
  assert.equal((I18N.match(/'panel\.f\.allowAudioSwap':/g) || []).length, 2, 'EN + ID label');
});

test('the split/join permissions are NOT marked paired-only — they work alone', () => {
  for (const k of ['joinSplitBaseline', 'joinSplitGloss', 'cutJoinTexted', 'adjustBoundaries', 'backspaceJoin']) {
    assert.doesNotMatch(setupField(k).rest, /off:/,
      `${k} reads settings directly (absent means on), so it is live on a standalone app`);
  }
});

/* ── scope 2: unpaired only, and the one field each surface has alone ───────────────────────── */

test('exactly one field diverges in each direction', () => {
  const only = (a, b) => a.map((f) => f.k).filter((k) => !b.some((f) => f.k === k));
  assert.deepEqual(only(SETUP, GROUPS), ['consentAudioFile'],
    'the unpaired form picks a FILE where the panel pushes a Drive URL');
  assert.deepEqual(only(GROUPS, SETUP), ['consentAudioUrl'], 'and that URL is the panel-only one');
  assert.match(setupField('consentAudioFile').rest, /standalone: true/,
    'declared in the spec rather than in a comment somebody has to find');
});

test('appLang is live in the panel and inert on the device, for a UI reason not a pairing one', () => {
  assert.match(setupField('appLang').rest, /off: 'setup\.off\.appLang'/);
  assert.doesNotMatch(GROUPS.find((f) => f.k === 'appLang').rest, /off:/,
    'the researcher pushes a language; the device has its own toolbar selector already');
});

/* ── scope 3: device vs project template ───────────────────────────────────────────────────── */

/* A template is the settings a NEW device is born with, so nearly everything is meaningful in one.
 * The single exception is the consent prompt's audio, which is uploaded into ONE device's own Drive
 * folder and mints a URL for that device — so the button is dropped and the rule that would demand
 * a URL is dropped with it, or ticking audio consent in a template failed validation naming a field
 * the form could not fill: a loop with no way out. */
test('template mode drops the per-device consent upload, and only that', () => {
  assert.match(PANEL, /templateMode: !!target\.project/, 'the flag comes from the target');
  assert.match(PANEL, /if \(!templateMode && ask\.includes\('audio'\) && blank\(raw\.consentAudioUrl\)\)/,
    'the URL rule is the only one templateMode relaxes');
  assert.match(PANEL, /if \(target\.project\) \{[\s\S]{0,400}data-gact="consentUpload"[\s\S]{0,300}promptPerDevice/,
    'and the dead button is replaced by the reason, never left sitting there');
});

test('the project template renders the same nine sections as a device', () => {
  // One GROUPS table, one modal: the surfaces cannot drift because there is nothing to drift from.
  assert.match(PANEL, /\$\{SET_TABS\.map\(tabPanelHtml\)\.join\(''\)\}/, 'the modal builds from SET_TABS either way');
  assert.match(PANEL, /openSettingsModal\(\{ kind: 'project', project:/, 'and project defaults open that same modal');
});

/* ── the accordion ─────────────────────────────────────────────────────────────────────────── */

test('one section open at a time, on both surfaces', () => {
  for (const [src, where] of [[PANEL, 'panel'], [APP, 'unpaired form']]) {
    assert.match(src, /querySelectorAll\("\.rp-sec"\)\.forEach\(\(d\) => d\.addEventListener\("toggle"/,
      `${where}: the listener is on each <details> — ⚠ toggle does not bubble`);
    assert.match(src, /querySelectorAll\("\.rp-sec\[open\]"\)\.forEach\(\(o\) => \{ if \(o !== d\) o\.open = false; \}\)/,
      `${where}: opening one closes its siblings (Seth: "If another is expanded, then others collapse")`);
  }
});

test('a tab whose sections were all closed comes back with one open', () => {
  for (const [src, where] of [[PANEL, 'panel'], [APP, 'unpaired form']]) {
    assert.match(src, /!panel\.querySelector\("\.rp-sec\[open\]"\) && panel\.querySelector\("\.rp-sec"\)/,
      `${where}: else the tab reads as empty rather than collapsed`);
  }
});

test('showGroup takes a SECTION id and finds the tab holding it', () => {
  assert.match(PANEL, /const TAB_OF_SEC = new Map\(SET_TABS\.flatMap/);
  assert.match(APP, /const SETUP_TAB_OF_SEC = new Map\(SETUP_TABS\.flatMap/);
  // The validation banner's jump buttons are the reason this indirection exists: they carry the
  // section a problem is in, and must still land on it after the sections are dealt out to tabs.
  assert.match(PANEL, /TAB_OF_SEC\.get\(p\.group\)/, 'panel: the error dot marks the macro-tab');
  assert.match(APP, /SETUP_TAB_OF_SEC\.get\(p\.group\)/, 'unpaired form: same');
});

test('every validation problem names a section that exists', () => {
  const SECTIONS = ['languages', 'appearance', 'tasks', 'permissions', 'typing', 'recording', 'consent', 'leaving', 'bundle'];
  for (const src of [PANEL, APP]) {
    for (const m of src.matchAll(/out\.push\(\{ group: '(\w+)'/g)) {
      assert.ok(SECTIONS.includes(m[1]), `${m[1]} is a real section — else the banner's jump goes nowhere`);
    }
  }
});

test('a closed section shows its name AND a blurb of what is inside', () => {
  for (const src of [PANEL, APP]) {
    assert.match(src, /class="rp-sec-name">\$\{esc\(t\("panel\.grp\." \+ g\.id\)\)\}/);
    assert.match(src, /class="rp-sec-note">\$\{esc\(t\("panel\.grpNote\." \+ g\.id\)\)\}/);
  }
  assert.match(CSS, /\.rp-sec > summary::-webkit-details-marker \{ display: none; \}/,
    'Safari draws its own triangle beside the custom caret unless told not to');
  assert.match(CSS, /\.rp-sec\[open\] > summary::before \{ transform: rotate\(90deg\); \}/, 'the caret turns');
});

test('a section with no legend of its own does not repeat its name inside itself', () => {
  for (const src of [PANEL, APP]) {
    assert.match(src, /const legend = g\.legend \? `<legend>\$\{esc\(t\(g\.legend\)\)\}<\/legend>` : ""/);
    assert.match(src, /aria-labelledby="(rp|ds)-sum-\$\{g\.id\}"/, 'it borrows the summary as its accessible name instead');
  }
  assert.match(CSS, /\.rp-fieldset\.rp-fs-plain \{ border: none; padding: 0; \}/,
    'and drops the inner border — the <details> card is already the grouping');
});
