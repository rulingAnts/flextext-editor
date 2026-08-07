/* The Settings tab's DEVICE SETUP form (app.js SETUP_GROUPS) against the researcher panel's
 * per-device settings form (researcher-panel.js GROUPS).
 *
 * WHY THIS TEST EXISTS: the two forms edit the SAME stored keys on the SAME device, and they are
 * deliberately NOT the same code. researcher-panel.js is also loaded by the standalone Researcher
 * app, so routing an editor screen through it would put every satellite's settings form on the
 * critical path of an editor change; the accepted price is a field list kept in step BY HAND.
 *
 * Hand-kept lists drift SILENTLY. Add a field to the panel and nothing anywhere complains — the
 * editor's Settings tab simply never grows the control, and a standalone researcher has no way to
 * reach a setting that exists, is documented, and works. So the drift is made loud here: the two
 * field lists must match EXACTLY, with one declared, reasoned divergence.
 *
 * ⚠ THE PARITY RULE CHANGED ON 2026-08-07 AND THE REASON MATTERS. The first cut DROPPED the fields
 * that do nothing on a standalone device. Seth opened the tab, found fields missing, and could not
 * tell whether they had been removed, renamed, or were a bug — dropping them cost more than it
 * saved. Every panel field is now present; anything inert is DISABLED WITH A REASON instead.
 *
 * ⚠ AND "DISABLED" ONLY EARNS ITS PLACE BECAUSE IT SPEAKS. Seth's standing rule, from a real field
 * report, is that a control which cannot act must SAY what is missing rather than sit there greyed
 * out looking broken. Greying is acceptable here ONLY as half of a pair: the reason is rendered
 * under every disabled control AND the container answers a click with it. A future tidy-up that
 * drops either half would look like a simplification in the diff and would reintroduce the exact
 * bug — so both halves are asserted, per field, by name.
 *
 * Run: node test/device-setup.test.mjs
 */
import { readFileSync } from 'node:fs';
import { REC_FORMATS } from '../docs/js/record-pcm.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const app = read('../docs/js/app.js');
const panel = read('../docs/js/researcher-panel.js');
const i18n = read('../docs/js/i18n.js');
const html = read('../docs/index.html');
const css = read('../docs/css/app.css');

// Lift both real specs out of the real files — a regex over field names would pass on a spec that
// no longer parses, which is the failure this is meant to catch.
const lift = (src, name, args, vals) => {
  const m = src.match(new RegExp(`^const ${name} = (\\[[\\s\\S]*?^\\]);$`, 'm'));
  if (!m) return null;
  try { return new Function(...args, `return ${m[1]}`)(...vals); } catch { return null; }
};

const REC_KEYS = Object.keys(REC_FORMATS);
const SETUP_GROUPS = lift(app, 'SETUP_GROUPS',
  ['REC_FORMATS', 'SETUP_AGC_OPTS', 'ALL_BUTTONS', 'SETUP_SEND_OPTS', 'SETUP_PAIR_ONLY_SEND'],
  [REC_FORMATS, ['off', 'on', 'auto'], ['new', 'audio', 'record', 'open'], ['share', 'upload', 'save', 'download'], ['upload']]);
const GROUPS = lift(panel, 'GROUPS',
  ['REC_KEYS', 'AGC_OPTS', 'BTN_OPTS', 'SEND_OPTS'],
  [REC_KEYS, ['off', 'on', 'auto'], ['new', 'audio', 'record', 'open'], ['share', 'upload', 'save', 'download']]);

console.log('\nboth specs are findable and parse');
ok(!!SETUP_GROUPS, 'app.js declares SETUP_GROUPS');
ok(!!GROUPS, 'researcher-panel.js declares GROUPS');
if (!SETUP_GROUPS || !GROUPS) { console.log(`\nFAILED (${fail || 1})\n`); process.exit(1); }

const allFields = (gs) => gs.flatMap((g) => g.fields);
const keysOf = (gs) => allFields(gs).map((f) => f.k);
const setupKeys = keysOf(SETUP_GROUPS);
const panelKeys = keysOf(GROUPS);
const fieldOf = (gs, k) => allFields(gs).find((f) => f.k === k);

console.log('\nthe two forms present the same groups, in the same order');
ok(JSON.stringify(SETUP_GROUPS.map((g) => g.id)) === JSON.stringify(GROUPS.map((g) => g.id)),
   `group ids match: ${SETUP_GROUPS.map((g) => g.id).join(' · ')}`);
// Locked by the connectivity design note: "Languages · Recording/AGC · Consent · Sending · Buttons".
ok(JSON.stringify(SETUP_GROUPS.map((g) => g.id)) === JSON.stringify(['languages', 'segmentation', 'recording', 'consent', 'sending', 'other']),
   'and Audio Segmentation has its own tab between Languages and Recording, with Buttons renamed Other (Seth, 2026-08-07)');
// The mode and the exports it governs travel together — the exports' own note says they follow it.
for (const k of ['segmentation', 'exportEaf', 'exportSaymore', 'exportPreview', 'exportJson']) {
  ok(SETUP_GROUPS.find((g) => g.id === 'segmentation').fields.some((f) => f.k === k),
     `${k} sits on the Audio Segmentation tab, not under a heading about buttons`);
  ok(GROUPS.find((g) => g.id === 'segmentation').fields.some((f) => f.k === k),
     `  ...and the panel agrees`);
}

console.log('\nFULL PARITY — every panel field is present here');
/* The ONE divergence, and it is declared in the spec itself (`standalone: true`) rather than in a
 * list this test keeps privately. A paired device is handed a Drive URL by its researcher; a
 * standalone app has no researcher and no reason to route a local file through Drive, so it gets a
 * file picker in that field's place. Anything else appearing on one side only is drift. */
const DIVERGENCE = { panelOnly: 'consentAudioUrl', setupOnly: 'consentAudioFile' };
for (const k of panelKeys) {
  if (k === DIVERGENCE.panelOnly) continue;
  ok(setupKeys.includes(k), `panel field ${k} is mirrored (a missing one hides a real setting)`);
}
for (const k of setupKeys) {
  if (k === DIVERGENCE.setupOnly) continue;
  ok(panelKeys.includes(k), `${k} is a REAL panel field, not invented on this side`);
}
ok(!setupKeys.includes(DIVERGENCE.panelOnly), 'the panel\'s Drive-URL box is NOT offered on a standalone app');
ok(fieldOf(SETUP_GROUPS, DIVERGENCE.setupOnly)?.standalone === true,
   'and the file picker that replaces it declares itself standalone-only, in the spec');
ok(fieldOf(SETUP_GROUPS, DIVERGENCE.setupOnly)?.type === 'file', 'it is a real file input');

console.log('\n⚠ EVERY INERT FIELD IS DISABLED **AND SAYS WHY** — both halves, or it is the old bug');
const offFields = allFields(SETUP_GROUPS).filter((f) => f.off);
ok(offFields.length > 0, `${offFields.length} fields are declared inert`);
// The ones that MUST be inert, each for a reason that is checkable in the code it refers to.
const MUST_BE_OFF = {
  appLang: 'the toolbar language selector is the live control',
  autoDel: 'deleteAfterUpload() is only ever consulted after an upload succeeds',
  autoBackup: 'autoBackupSweep() bails on !Sync.workerUploadTarget()',
  autoBackupMins: 'it qualifies auto-backup, which is itself inert',
  deleteAllEnabled: 'deleteAllAllowed() short-circuits on !Sync.hasSession()',
  allowDelete: 'allowDeleteOn() short-circuits on !Sync.hasSession()',
  doneEnabled: '"Done" reports to a researcher and auto-uploads; neither exists here',
};
for (const [k, why] of Object.entries(MUST_BE_OFF)) {
  ok(!!fieldOf(SETUP_GROUPS, k)?.off, `${k} is disabled — ${why}`);
}
// ...and the claims above are true of the real code, not just of this test's comments.
ok(/function deleteAllAllowed\(\) \{\s*return !Sync\.hasSession\(\)/.test(app.replace(/\n/g, ' ')) ||
   /return !Sync\.hasSession\(\) \|\| loadSettings\(\)\.deleteAllEnabled === true;/.test(app),
   'deleteAllAllowed() really does short-circuit on !hasSession (so the control really would be a lie)');
ok(/function allowDeleteOn\(\) \{ return !Sync\.hasSession\(\) \|\| settings\.allowDelete === true; \}/.test(app),
   'allowDeleteOn() really does too');
ok(/if \(settings\.autoBackup !== true \|\| !Sync\.workerUploadTarget\(\)/.test(app),
   'autoBackupSweep() really does bail without an upload target');
// recordWelcome is deliberately LEFT ENABLED (Seth, 2026-08-07) — ?mode=record on this same origin
// does paint it, so it is not inert, merely invisible in the editor. Over-disabling is the worse error.
ok(!fieldOf(SETUP_GROUPS, 'recordWelcome')?.off,
   'recordWelcome stays ENABLED — ?mode=record on this origin paints it, so it is not inert');

const fieldFn = app.match(/function setupFieldHtml\(f\) \{[\s\S]*?\n\}/);
ok(!!fieldFn, 'setupFieldHtml is findable');
const fieldSrc = fieldFn ? fieldFn[0] : '';
ok(/const off = f\.off \? ' disabled' : '';/.test(fieldSrc), 'an inert field renders its real control, disabled');
ok(/setupOffHtml\(f\.off\)/.test(fieldSrc), 'AND the reason is rendered with it — never a bare disabled');
ok(/data-off="\$\{esc\(f\.off\)\}"/.test(fieldSrc), 'the reason key rides the container for the click handler');
ok(/function setupOffHtml\(why\) \{[\s\S]*?setup-off-why[\s\S]*?esc\(t\(why\)\)/.test(app),
   'setupOffHtml prints the reason as visible text, not a title attribute nobody hovers on a phone');
// The click half. A disabled <input> dispatches nothing, so the listener must be on the CONTAINER
// and the inputs must not swallow the click — remove either and the control refuses in silence.
ok(/const off = e\.target\.closest\('\.setup-off'\);\s*\n\s*if \(off && off\.dataset\.off\) \{ toast\(t\(off\.dataset\.off\)/.test(app),
   'clicking an inert control toasts its reason');
ok(/\.setup-off input, \.setup-off select, \.setup-off textarea \{ pointer-events: none; \}/.test(css),
   'and pointer-events:none lets the click reach that container (a disabled input fires nothing)');

console.log('\nan inert control DISPLAYS the stored value but never WRITES it');
ok(/if \(f\.type === 'action' \|\| f\.type === 'file'\) continue;/.test(app),
   'deviceSetupValues fills inert fields too — greyed must not mean blank');
ok(/if \(f\.type === 'action' \|\| f\.type === 'file' \|\| f\.off \|\| SPECIAL\.includes\(f\.k\) \|\| !has\(f\.k\)\) continue;/.test(app),
   'readDeviceSetup skips every `off` field, so this surface cannot re-assert what it says it does not control');

console.log('\nUPLOAD is gated as an OPTION, and named once');
ok(/const SETUP_PAIR_ONLY_SEND = \['upload'\];/.test(app), 'the gated send option is named once');
ok(JSON.stringify(fieldOf(SETUP_GROUPS, 'sendOptions').offOpts) === '["upload"]',
   'sendOptions disables exactly the upload option');
ok(fieldOf(SETUP_GROUPS, 'sendOptions').opts.includes('upload'),
   'and upload is still IN the option list — unavailable, not removed');
ok(/dis \? ' disabled' : ''/.test(fieldSrc), 'the gated option is a real disabled checkbox, not decorative text');

console.log('\nan un-offered control must never REWRITE what it could not show');
ok(/for \(const o of SETUP_PAIR_ONLY_SEND\) if \(before\.has\(o\) && !patch\.sendOptions\.includes\(o\)\) patch\.sendOptions\.push\(o\);/.test(app),
   'a stored upload option survives a save made on a form that could not offer it');
ok(/const before = new Set\(settings\.sendOptions\?\.length \? settings\.sendOptions : SETUP_SEND_OPTS\);/.test(app),
   'and "absent means all four" is read the same way allowedSend() reads it');

console.log('\nCONSENT: the fields are always visible, and the audio is a local file');
ok(!/setRow\('consentMsg'/.test(app) && !/setRow\('consentAudioUrl'/.test(app),
   'the consent rows are NOT hidden until their box is ticked (that read as "the tab has no fields")');
for (const k of ['consentAsk', 'consentMsg', 'consentAudioFile', 'consentConfirm']) {
  ok(setupKeys.includes(k), `${k} is present on the consent tab`);
}
/* ⚠ The whole point of the file route: it adds NO new path through the consent flow. The prompt is
 * written to the SAME media key requestConsentThen already falls back to, so playback, the IRB
 * freeze of the exact prompt played, and the bundled copy all keep working untouched. */
ok(/await ensureAsset\('asset:consent-prompt', settings\.consentAudio, consentAudioIdentity\(\)\)\s*\n?\s*\|\| await getAsset\('asset:consent-prompt'\)/.test(app),
   'requestConsentThen still falls back to the stored asset (the seam the file route rides on)');
ok(/db\.putMedia\('asset:consent-prompt', \{/.test(app), 'a picked file is written to that same key');
ok(/if \(!url\) return null;/.test(read('../docs/js/audio.js')),
   'ensureAsset returns null with no URL, which is what lets the fallback fire');
// URL beats file, always — ensureAsset would overwrite the picked blob, so they cannot both be live.
ok(/function consentLocalAudio\(\) \{\s*\n\s*return \(!settings\.consentAudio && settings\.consentAudioFile\)/.test(app),
   'a researcher-pushed Drive URL silently outranks a local file (no migration step needed on pairing)');
ok(/'consentAudio', 'consentAudioUrl', 'consentAudioFile'\]\) delete s\[k\];/.test(app),
   'and a revoke drops the local-file record too — its bytes were overwritten while managed');
// Picked in memory, committed on Save: opening the file dialog must not replace a live prompt.
ok(/let pendingConsentFile = null;/.test(app), 'the pick is held in memory');
ok(/pendingConsentFile = null;\s*\/\/ a rebuild discards an unsaved pick/.test(app),
   'and a rebuild discards it, so a half-edited form changes nothing');
ok(/this surface only ever sets a LOCAL FILE/.test(app),
   'readDeviceSetup does not touch consentAudioUrl/consentAudio — the researcher route stays intact');
ok(!setupKeys.includes('consentAudioUrl'), 'and there is no URL box here to write one from');

console.log('\nUNPAIRED ONLY — a paired device gets no editable surface');
const render = app.match(/function renderDeviceSetup\(\) \{[\s\S]*?\n\}/);
ok(!!render && /if \(Sync\.hasSession\(\)\) \{[\s\S]*?setup\.managed/.test(render[0]),
   'renderDeviceSetup refuses to build the form while paired, and says why');
ok(/const hidden = isResearchHidden\(\) \|\| Sync\.hasSession\(\);/.test(app),
   'and the tab itself stays hidden while paired (the older, outer guard is still there)');

console.log('\nexports keep FOLLOWING Audio Segmentation Mode after a save');
ok(/const SETUP_EXPORT_KEYS = \['exportEaf', 'exportSaymore', 'exportPreview', 'exportJson'\];/.test(app),
   'the followers are named once');
ok(/for \(const k of SETUP_EXPORT_KEYS\) if \(has\(k\)\) patch\[k\] = \(!!raw\[k\] === segOn\) \? undefined : !!raw\[k\];/.test(app),
   'only an OVERRIDE is stored — agreeing with the mode stores nothing, so it keeps following');
ok(/for \(const k of Object\.keys\(patch\)\) if \(patch\[k\] === undefined\) delete settings\[k\];/.test(app),
   'and "back to following" really deletes the key (present-but-undefined is not the same to ??)');
ok(/function syncSetupExports/.test(app) && /dataset\.sf === 'segmentation'\) syncSetupExports/.test(app),
   'toggling the mode moves the followers live, and ONLY when the mode itself moves');

console.log('\nthe shell hosts it, and the old hand-rolled forms are gone');
ok(/<div id="device-setup" class="device-setup"><\/div>/.test(html), 'index.html carries the container');
ok(!/id="ws-form"/.test(html) && !/id="recformat-form"/.test(html),
   'the superseded ws-form / recformat-form markup is removed, not left as a second surface');
ok(/id="btn-hide-research"/.test(html), 'the hide-tab button stays with Settings');
/* The two TOOLS moved to their own top-level tab: you RUN them on a file, they do not configure
 * this device. They shared the Settings screen only because it used to be the one admin surface. */
ok(/<section id="view-utilities"/.test(html), 'there is a Utilities view');
ok(/data-view="utilities"/.test(html), 'and a top-level tab that reaches it');
// The converter's own ids are uc-* since it was rebuilt to match the panel (see audio-converter.test).
ok(/id="uc-file"/.test(html) && /id="wscheck-file"/.test(html), 'both tools survived the move');
const utilSection = (html.match(/<section id="view-utilities"[\s\S]*?<\/section>/) || [''])[0];
ok(/id="uc-fmt"/.test(utilSection) && /id="wscheck-rows"/.test(utilSection),
   'and they are INSIDE Utilities, not left behind in Settings');
const setupSection = (html.match(/<section id="view-research"[\s\S]*?<\/section>/) || [''])[0];
ok(!/id="uc-fmt"/.test(setupSection) && !/id="wscheck-rows"/.test(setupSection),
   'Settings no longer carries them');
ok(/const VIEWS = \[[^\]]*'utilities'/.test(app), 'show() knows the view (else the tab would blank the screen)');
ok(/'tabs\.utilities':/.test(i18n), 'the tab is labelled');
ok(!/fillWsForm|applyResearchFormToSettings/.test(app), 'and no dead reference to the removed forms remains');

console.log('\nthe form selects on data-sf, never the panel\'s data-f');
ok(!/data-f=/.test(fieldSrc), 'setupFieldHtml emits data-sf only, so the two forms cannot select into each other');
ok(/data-sfile="\$\{f\.k\}"/.test(fieldSrc),
   'the file input uses data-sfile — a file input\'s .value is a fake path and must stay out of collect/fill');
ok(/id="ds-tab-\$\{g\.id\}"/.test(app) && /id="ds-grp-\$\{g\.id\}"/.test(app),
   'and its tab/panel ids are ds-* — the panel modal may be in the DOM at the same time');

console.log('\nevery string is translated, and every `off` reason exists');
const KEYS = ['setup.h1', 'setup.intro', 'setup.localNote', 'setup.managed', 'setup.offMark',
              'setup.consentFileNote', 'setup.consentFilePending', 'setup.consentFileCurrent',
              'setup.consentFileFromResearcher', 'setup.consentFileNone', 'setup.consentFileNotAudio',
              'setup.consentFileFailed', 'setup.val.consentFile', 'panel.f.consentAudioFile',
              ...new Set(allFields(SETUP_GROUPS).map((f) => f.off).filter(Boolean)),
              ...SETUP_GROUPS.map((g) => g.detailsOff).filter(Boolean)];
for (const key of KEYS) {
  const n = (i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;
  ok(n === 2, `${key} is defined in BOTH en and id (found ${n})`);
}
// Every field label the form prints must exist too, or a row renders as its raw key.
for (const k of setupKeys) {
  const n = (i18n.match(new RegExp(`'panel\\.f\\.${k}':`, 'g')) || []).length;
  ok(n === 2, `panel.f.${k} (the label) is defined in BOTH en and id (found ${n})`);
}
/* ⚠ EVERY OPTION LABEL, EXPANDED. The form builds these by concatenation — t(f.optPrefix + o) —
 * so a missing one is invisible to any check that only looks at literal t('x') calls: the control
 * renders its raw key ("panel.opt.abm.30") instead of a label. That fails silently, and it fails in
 * Indonesian first, because that is the side nobody reads while developing. */
for (const f of allFields(SETUP_GROUPS)) {
  if (!f.optPrefix || !f.opts) continue;
  for (const o of f.opts) {
    const key = f.optPrefix + o;
    const n = (i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;
    ok(n === 2, `${key} (option label for ${f.k}) is in BOTH en and id (found ${n})`);
  }
}
// Group headings are built the same way.
for (const g of SETUP_GROUPS) {
  for (const key of [`panel.grp.${g.id}`, g.legend, g.note].filter(Boolean)) {
    const n = (i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;
    ok(n === 2, `${key} is in BOTH en and id (found ${n})`);
  }
}

// The copy side of the rule: a reason EXPLAINS what is missing; it never merely refuses.
const upload = (i18n.match(/'setup\.off\.upload': '([^']*)'/) || [])[1] || '';
ok(/not linked to a researcher/.test(upload), 'the upload reason names the missing thing');
ok(/Everything else on this page works/.test(upload), 'and says what still works, so it does not read as a dead end');

console.log('\nthe inert styling greys, and the reason is what makes that honest');
ok(/\.setup-off input:disabled, \.setup-off select:disabled \{[^}]*opacity/.test(css),
   'a disabled control is visibly greyed');
ok(/\.setup-off-why \{/.test(css) && /\.setup-off-mark \{/.test(css),
   'and both the reason line and the inline marker are styled');

console.log(fail ? `\nFAILED (${fail})\n` : `\nPASSED\n`);
process.exit(fail ? 1 : 0);
