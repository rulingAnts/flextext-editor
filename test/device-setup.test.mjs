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
 * reach a setting that exists, is documented, and works. So the drift is made loud here: every panel
 * field must be either MIRRORED or listed as a DELIBERATE EXCLUSION with a reason. A new panel field
 * fails this test until somebody decides which it is. That decision is the whole point; the test
 * does not care which way it goes.
 *
 * The other three properties pinned here are the rules the feature exists to satisfy:
 *   • SETUP ONLY — no text-management setting may appear on a standalone device.
 *   • UNPAIRED ONLY — a paired device gets no editable surface, because its researcher owns it.
 *   • ⚠ UPLOAD SAYS WHAT IS MISSING, IT IS NOT GREYED OUT. This is Seth's standing rule, from a real
 *     field report: a control that cannot act must explain itself. A future "tidy-up" that turns the
 *     gated controls back into <input disabled> would look like an improvement in the diff and would
 *     reintroduce the exact bug. That is why the absence of `disabled` is asserted, not assumed.
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

const keysOf = (gs) => gs.flatMap((g) => g.fields.map((f) => f.k));
const setupKeys = keysOf(SETUP_GROUPS);
const panelKeys = keysOf(GROUPS);
const fieldOf = (gs, k) => gs.flatMap((g) => g.fields).find((f) => f.k === k);

console.log('\nthe two forms present the same groups, in the same order');
ok(JSON.stringify(SETUP_GROUPS.map((g) => g.id)) === JSON.stringify(GROUPS.map((g) => g.id)),
   `group ids match: ${SETUP_GROUPS.map((g) => g.id).join(' · ')}`);
// Locked by the connectivity design note: "Languages · Recording/AGC · Consent · Sending · Buttons".
ok(JSON.stringify(SETUP_GROUPS.map((g) => g.id)) === JSON.stringify(['languages', 'recording', 'consent', 'sending', 'buttons']),
   'and are the five the design note names');

console.log('\nevery mirrored field is a REAL panel field (nothing invented on this side)');
for (const k of setupKeys) ok(panelKeys.includes(k), `${k} exists in the panel's GROUPS`);

console.log('\nevery panel field is mirrored OR a documented, deliberate exclusion');
/* ⚠ EDITING THIS LIST IS A DECISION, NOT A FIX. Each entry is excluded because it CANNOT mean
 * anything on a standalone device — not because it was inconvenient. Re-check the reason before
 * adding to it, and mirror the field instead if the reason does not hold. */
const EXCLUDED = {
  appLang: 'the topbar language selector is the live control; a second one is a no-op',
  deleteAllEnabled: 'deleteAllAllowed() is already true on every unpaired device',
  allowDelete: 'allowDeleteOn() is already true on every unpaired device',
  doneEnabled: '"Done" reports to a researcher and auto-uploads; neither exists here',
  recordWelcome: 'it is the RECORDER welcome screen heading, which the editor never renders',
  autoBackupMins: 'it qualifies auto-backup, which is itself not on offer without a researcher',
};
for (const k of panelKeys) {
  if (setupKeys.includes(k)) continue;
  ok(!!EXCLUDED[k], `${k} is excluded on purpose${EXCLUDED[k] ? ` — ${EXCLUDED[k]}` : ' — NEW PANEL FIELD: mirror it, or add it here with a reason'}`);
}
for (const k of Object.keys(EXCLUDED)) {
  ok(panelKeys.includes(k) && !setupKeys.includes(k),
     `${k} is still a panel field and still absent here (a stale exclusion hides a real setting)`);
}

console.log('\nSETUP ONLY — no text-management setting can reach a standalone device');
for (const k of ['uploadFolder', 'assign', 'uploadUrl', 'allowDelete', 'doneEnabled']) {
  ok(!setupKeys.includes(k), `no ${k} control`);
}

console.log('\nUPLOAD IS GATED — and the gate is stated once, in one place');
ok(/const SETUP_PAIR_ONLY_SEND = \['upload'\];/.test(app), 'the gated send option is named once');
ok(JSON.stringify(fieldOf(SETUP_GROUPS, 'sendOptions').gateOpts) === '["upload"]',
   'sendOptions gates exactly the upload option');
ok(fieldOf(SETUP_GROUPS, 'sendOptions').opts.includes('upload'),
   'and upload is still IN the option list — unavailable, not removed');
ok(fieldOf(SETUP_GROUPS, 'autoBackup').needsPair === true,
   'auto-backup is gated too (autoBackupSweep bails without a worker upload target — it IS an upload)');

console.log('\n⚠ IT SAYS WHAT IS MISSING. IT IS NOT A DISABLED CONTROL.');
const fieldFn = app.match(/function setupFieldHtml\(f\) \{[\s\S]*?\n\}/);
ok(!!fieldFn, 'setupFieldHtml is findable');
const fieldSrc = fieldFn ? fieldFn[0] : '';
ok(!/disabled/.test(fieldSrc),
   'the renderer never emits `disabled` — a greyed-out control reads as broken, not as unavailable');
ok(/<span class="check-label rp-inline setup-optgate">/.test(fieldSrc),
   'a gated option renders as a <span>, so there is no input to disable in the first place');
ok(/setupPairMarkHtml\(\)/.test(fieldSrc), 'each gated control carries its own short marker');
ok(/function setupGroupGated/.test(app) && /setupGroupGated\(g\) \? setupPairWhyHtml\(\)/.test(app),
   'and the full explanation is emitted ONCE per group, not repeated beside every control');
ok(/data-sact="pair"/.test(app) && /if \(which === 'pair'\) \{ showInvitePasteModal\(\); return; \}/.test(app),
   'the explanation carries the action that would supply what is missing');

console.log('\nUNPAIRED ONLY — a paired device gets no editable surface');
const render = app.match(/function renderDeviceSetup\(\) \{[\s\S]*?\n\}/);
ok(!!render && /if \(Sync\.hasSession\(\)\) \{[\s\S]*?setup\.managed/.test(render[0]),
   'renderDeviceSetup refuses to build the form while paired, and says why');
ok(/const hidden = isResearchHidden\(\) \|\| Sync\.hasSession\(\);/.test(app),
   'and the tab itself stays hidden while paired (the older, outer guard is still there)');

console.log('\nan un-offered control must never REWRITE what it could not show');
ok(/for \(const o of SETUP_PAIR_ONLY_SEND\) if \(before\.has\(o\) && !patch\.sendOptions\.includes\(o\)\) patch\.sendOptions\.push\(o\);/.test(app),
   'a stored upload option survives a save made on a form that never offered it');
ok(/const before = new Set\(settings\.sendOptions\?\.length \? settings\.sendOptions : SETUP_SEND_OPTS\);/.test(app),
   'and "absent means all four" is read the same way allowedSend() reads it');
ok(/\|\| !has\(f\.k\)\) continue;/.test(app),
   'a field this form drops is not written at all (no default over a value nobody was shown)');

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
ok(/id="btn-hide-research"/.test(html) && /id="convert-form"/.test(html) && /id="wscheck-file"/.test(html),
   'the hide-tab button and the two TOOLS (converter, WS checker) are kept');
ok(!/fillWsForm|applyResearchFormToSettings/.test(app), 'and no dead reference to the removed forms remains');

console.log('\nthe form selects on data-sf, never the panel\'s data-f');
ok(!/data-f=/.test(fieldSrc), 'setupFieldHtml emits data-sf only, so the two forms cannot select into each other');
ok(/id="ds-tab-\$\{g\.id\}"/.test(app) && /id="ds-grp-\$\{g\.id\}"/.test(app),
   'and its tab/panel ids are ds-* — the panel modal may be in the DOM at the same time');

console.log('\nevery new string is translated');
for (const key of ['setup.h1', 'setup.intro', 'setup.localNote', 'setup.managed',
                   'setup.needsPair', 'setup.needsPairShort', 'setup.needsPairAction']) {
  const n = (i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;
  ok(n === 2, `${key} is defined in BOTH en and id (found ${n})`);
}
// Rule 4 again, from the copy side: the explanation must name what is missing, not refuse.
const needsPairEn = (i18n.match(/'setup\.needsPair': '([^']*)'/) || [])[1] || '';
ok(/not linked to a researcher/.test(needsPairEn), 'the English explanation names the missing thing');
ok(!/cannot|not allowed|unavailable/i.test(needsPairEn), 'and does not merely refuse');

console.log('\nthe gated styling exists and is not a disabled style');
ok(/\.setup-optgate \{/.test(css) && /\.setup-gate-mark \{/.test(css) && /\.setup-gate-why \{/.test(css),
   'the three gate classes are styled');
ok(!/\.setup-optgate[^{]*\{[^}]*opacity/.test(css), 'the unavailable option is not dimmed like a disabled control');

console.log(fail ? `\nFAILED (${fail})\n` : `\nPASSED\n`);
process.exit(fail ? 1 : 0);
