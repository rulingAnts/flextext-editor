/* THE AUDIO SEGMENTER'S SETTINGS — an unpaired tab like the editor's, the same keys in the panel,
 * and nothing duplicated (Seth, 2026-09-04).
 *
 * "add to settings for this satellite app (both unpaired settings tab and paired researcher
 * settings, without duplicating what already exists) our standard language/writing system settings,
 * and the yes/no setting for exporting audio segment timing as notes and not just attributes … For
 * whatever of those settings are relevant to this app. Audio segmenting should ALWAYS be enabled,
 * because that's the whole purpose of this app, but export formats checked and unchecked, etc."
 *
 * Run: node test/segmenter-settings.test.mjs
 */
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { serializeFlextext, makeDoc, makeSegment, makeWord } = await import('../docs/js/flextext.js');

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const app = read('docs/js/app.js');
const panel = read('docs/js/researcher-panel.js');
const i18n = read('docs/js/i18n.js');
const shell = read('satellites/audio-segmenter/index.html');
const editorShell = read('docs/index.html');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const fn = (src, name) => (src.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)) || [''])[0];
const both = (k) => (i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}': `, 'g')) || []).length === 2;

console.log('\nthe timing NOTE is a setting; the attributes never were');
{
  const doc = makeDoc({ vernLang: 'fau', analLang: 'en' }, 'T');
  doc.paragraphs = [{ guid: 'p1', segments: [makeSegment('a b', [makeWord('a'), makeWord('b')])] }];
  doc.segments = [{ start: 1000, end: 2500 }];
  const on = serializeFlextext(doc, {}, { segTimes: true });
  const off = serializeFlextext(doc, {}, { segTimes: true, timeNotes: false });
  ok(/begin-time-offset="1000" end-time-offset="2500"/.test(on) && /begin-time-offset="1000" end-time-offset="2500"/.test(off),
     'the begin/end attributes are written either way');
  ok(/<item type="note" lang="en">audio 0:01\.000–0:02\.500<\/item>/.test(on), 'the note rides by default (every export so far)');
  ok(!/type="note"/.test(off), 'and is left out with timeNotes:false — attributes only');
  ok((app.match(/timeNotes: settings\.segTimeNotes !== false/g) || []).length === 3,
     'all three of the app\'s serializeFlextext call sites read the device setting');
}

console.log('\nthe setting exists once, in three places that share one key');
ok(/\{ k: 'segTimeNotes', type: 'checkbox', note: 'panel\.f\.segTimeNotesNote' \}/.test(app), 'the device form (SETUP_GROUPS, segmentation group)');
ok(/\{ k: 'segTimeNotes', type: 'checkbox' \}/.test(panel), 'the panel\'s segmentation section');
ok(/v\.segTimeNotes = s\.segTimeNotes !== false/.test(app) && /v\.segTimeNotes = s\.segTimeNotes !== false/.test(panel),
   'both prefill an UNSET one as ticked, so the box never lies about the default');
for (const k of ['panel.f.segTimeNotes', 'panel.f.segTimeNotesNote']) ok(both(k), `${k} in both languages`);

console.log('\nthe segmenter\'s Settings tab is the editor\'s form, filtered — not a second form');
ok(/<button class="top-tab" data-view="segmenter" data-i18n="tabs\.texts"/.test(shell) && /<button class="top-tab" data-view="research" data-i18n="tabs\.research"/.test(shell),
   'the shell has the two home tabs');
ok(/<section id="view-research" class="view" hidden>[\s\S]*?<div id="device-setup" class="device-setup"><\/div>[\s\S]*?id="btn-hide-research"/.test(shell),
   'and the editor\'s Settings section, with the same ids');
ok(!/<section id="view-research"[\s\S]*?<section id="view-research"/.test(shell), 'once');
const keys = app.match(/const SEGMENTER_SETUP_KEYS = new Set\(\[([\s\S]*?)\]\);/);
ok(!!keys, 'SEGMENTER_SETUP_KEYS names what this app shows');
const keySet = keys ? keys[1] : '';
for (const k of ['vernLang', 'analLang', 'segTimeNotes', 'SETUP_EXPORT_KEYS', 'allowBlankLines', 'allowTextEdit']) ok(keySet.includes(k), `  …${k}`);
for (const k of ['segmentation', 'cutTab', 'recordFormat', 'consentAsk', 'sendOptions', 'buttons']) ok(!keySet.includes(`'${k}'`), `  …but not ${k}`);
ok(/const segOn = SEGMENTER_MODE \? true : !!raw\.segmentation;/.test(app), 'segmentation is always ON here — the exports "follow the mode" against true');
ok(/const setupGroups = setupGroupsFor\(\);/.test(fn(app, 'renderDeviceSetup')) && /setupGroups\.map\(setupGroupHtml\)/.test(fn(app, 'renderDeviceSetup')),
   'renderDeviceSetup builds from the filtered groups');
ok(/only: 'segmenter'/.test(app) && /\(!f\.only \|\| f\.only === mode\)/.test(fn(app, 'setupGroupsFor')),
   'and the two segmenter-only fields stay out of the editor\'s form');
for (const k of ['setup.off.allowBlankLines', 'setup.off.allowTextEdit']) ok(both(k), `${k} in both languages`);

console.log('\nthe tab behaves like the editor\'s');
{
  const boot = fn(app, 'setupSegmenterMode');
  ok(/if \(b\.dataset\.view === 'research'\) \{ renderDeviceSetup\(\); show\('research'\); \}/.test(boot), 'Settings builds the form on entry');
  ok(/localStorage\.setItem\(RESEARCH_HIDDEN_KEY, '1'\)/.test(boot), 'the in-person hide switch is wired');
  ok(/e\.ctrlKey && e\.altKey[^\n]*toggleResearchHidden\(\)/.test(boot), 'Ctrl+Alt+R brings it back');
  ok(/applyResearchVisibility\(\);/.test(boot), 'and a claimed invite hides it at boot');
  const vis = fn(app, 'applyResearchVisibility');
  ok(/const rv = \$\('#view-research'\);\s*\n\s*if \(hidden && rv && !rv\.hidden\)/.test(vis), 'applyResearchVisibility tolerates a shell without the tab');
  ok(/show\(SEGMENTER_MODE \? 'segmenter' : CONSENT_MODE \? 'consent' : 'texts'\)/.test(vis), 'and leaves to THIS app\'s home');
  ok(/else if \(CONSENT_MODE \|\| SEGMENTER_MODE\) \{ applyResearchVisibility\(\); fillDeviceSetup\(\); refreshList\(\); \}/.test(fn(app, 'applyLiveSettings')),
     'a pushed setting refills the form and re-checks the tab');
}

console.log('\nthe editor\'s own Settings tab is untouched in shape');
ok(/data-view="research" data-i18n="tabs\.research"/.test(editorShell), 'still there');
ok(!/segmenter/.test(fn(app, 'readDeviceSetup').replace(/SEGMENTER_MODE \? true : /, '')), 'readDeviceSetup has no other segmenter branch');

console.log(fail ? `\n${fail} FAILED\n` : '\nall ok\n');
process.exit(fail ? 1 : 0);
