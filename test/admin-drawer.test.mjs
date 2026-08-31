/* THE BACK-DOOR FOR A STUCK DEVICE — and the three ways it could quietly stop being one.
 *
 * Seth, 2026-08-20: "We need a back-door for researchers to be able to unpair stuck editor clients
 * without data loss or clearing browser storage. Used to be clicking the help menu seven times
 * exposed settings normally hidden. I think now what we should do is have that enable or disable
 * the pair/unpair and erase all buttons at the bottom of the help menu, even if the researcher
 * disabled them in the researcher panel."
 *
 * ⚠ WHY IT NEEDS PINNING RATHER THAN JUST WRITING. Every assertion here is about a property that is
 * invisible on screen and easy to lose to a tidy-up:
 *   1. UNPAIR MUST NOT DELETE. It reads one line away from eraseAllData(), and the two buttons sit
 *      next to each other. If unpair ever grows a wipe, the app still looks correct and a
 *      researcher recovering someone's only copy of a recording destroys it.
 *   2. THE OVERRIDE MUST STAY AN OVERRIDE. deleteAllAllowed() is off by default for managed
 *      devices; the back-door exists precisely to beat that. "Simplifying" the gate back to the
 *      researcher setting re-locks the door and nothing fails.
 *   3. THE PANEL ROUTE MUST STILL EXIST. The gesture used to open the researcher panel outright on
 *      a managed install, and that was the ONLY way in on a coworker's phone. It moved into the
 *      drawer; deleting the button would strand it.
 *
 * Run: node test/admin-drawer.test.mjs
 */
import { readFileSync } from 'node:fs';
const read = (r) => readFileSync(new URL(r, import.meta.url), 'utf8');
const app = read('../docs/js/app.js');
const html = read('../docs/index.html');
const css = read('../docs/css/app.css');
const i18n = read('../docs/js/i18n.js');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const fn = (src, name) => {
  const m = src.match(new RegExp('(?:async )?function ' + name + '\\('));
  if (!m) return '';
  const at = src.indexOf(m[0]);
  const end = src.indexOf('\n}', at);
  return src.slice(at, end < 0 ? src.length : end + 2);
};
const i18nBlock = (code) => {
  const at = i18n.indexOf(`\n${code}: {`);
  if (at < 0) return '';
  const rest = i18n.slice(at + 1);
  const nxt = rest.search(/\n[a-z]{2,3}: \{/);
  return nxt < 0 ? i18n.slice(at) : i18n.slice(at, at + 1 + nxt);
};
const inEnAndId = (k) => {
  const re = new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'm');
  return (re.test(i18nBlock('en')) ? 1 : 0) + (re.test(i18nBlock('id')) ? 1 : 0);
};

console.log('\nthe seven-tap gesture still exists, and now drives the drawer too');
const setup = fn(app, 'setupResearchToggle');
ok(/taps >= 7/.test(setup), 'seven taps, not some other number a field instruction sheet would now be wrong about');
ok(/\$\$\('\.help-btn'\)/.test(setup),
   '...on the small ? button — a wet screen or a stray hand must not reach an override of the researcher');
ok(/toggleAdminUnlock\(\)/.test(setup), 'and it toggles the admin drawer');
ok(/toggleResearchHidden\(\); toggleAdminUnlock\(\)/.test(setup),
   '⚠ BOTH jobs, not a replacement — the old Settings-tab behaviour is documented in the field');
ok(/ctrlKey && e\.altKey/.test(setup) && (setup.match(/fire\(\)/g) || []).length >= 2,
   'the desktop shortcut and the taps go through ONE path, so they cannot drift apart');

console.log('\nunpairing keeps the work — this is the whole point of the feature');
const unpair = fn(app, 'runAdminUnpair');
ok(!!unpair, 'there is an unpair action');
ok(/Sync\.clearSession\(\)/.test(unpair), 'it drops the binding');
ok(!/eraseAllData|db\.delete|indexedDB|caches\.delete|localStorage\.clear/.test(unpair),
   '⚠ and DELETES NOTHING — no wipe, no IndexedDB, no storage clear. This is the assertion that matters most.');
ok(/uploadFolder[\s\S]{0,120}?delete st\[k\]/.test(unpair),
   'it scrubs the researcher\'s Drive links, which this device can no longer reach');
// v540 replaced the engine's native confirm() with the in-app confirmDialog (see
// test/no-native-dialogs.test.mjs). The claim here is unchanged — it still asks first.
ok(/await confirmDialog\(t\('admin\.unpairConfirm'\)\)/.test(unpair), 'and asks first');
ok(/admin\.unpairNone/.test(unpair), '...and says so rather than pretending, when there is no pairing to end');

console.log('\nthe override really overrides the researcher\'s setting');
const gate = fn(app, 'deleteAllAllowed');
ok(/adminUnlocked\(\)/.test(gate),
   '⚠ deleteAllAllowed yields to the back-door — otherwise the door is locked exactly when it is needed');
ok(/deleteAllEnabled === true \|\| adminUnlocked\(\)/.test(gate),
   '...as an OR, so the researcher\'s own "on" still works unchanged');
ok(/applyDeleteAllButton\(\)/.test(fn(app, 'toggleAdminUnlock')),
   'and the button is re-evaluated the moment the gesture fires, not on the next reload');

console.log('\nthe researcher-panel route survived being moved');
ok(/if \(Sync\.hasSession\(\)\) return;/.test(fn(app, 'toggleResearchHidden')),
   'the gesture no longer navigates a managed device away to the panel');
ok(/btn-admin-panel/.test(fn(app, 'applyAdminDrawer')) && /researcherPanelApi\.open\(\)/.test(fn(app, 'applyAdminDrawer')),
   '⚠ ...because the route is a button in the drawer now — on a coworker\'s phone it is the only way in');

console.log('\nthe drawer is in Help, current, and set apart');
ok(/applyAdminDrawer\(\)/.test(fn(app, 'openHelp')), 'opening Help rebuilds it, so it is never stale');
ok(/view\.appendChild\(box\)/.test(fn(app, 'applyAdminDrawer')), 'it lives at the bottom of the Help view');
ok(/const del = \$\('#btn-delete-all'\)[\s\S]{0,120}?appendChild\(del\)/.test(fn(app, 'applyAdminDrawer')),
   '⚠ and the destructive button is re-appended BELOW it — recoverable controls first');
ok(/\.admin-drawer \{/.test(css) && /border: 1px solid var\(--border\)/.test(css),
   'it looks like a panel someone opened, not like more help text');
ok(!/id="admin-drawer"/.test(html),
   'built in JS like the other gated Help controls, so there is one convention rather than two');

console.log('\nevery string it shows is translated');
for (const k of ['admin.unlocked', 'admin.locked', 'admin.title', 'admin.note', 'admin.unpair',
                 'admin.unpairConfirm', 'admin.unpairDone', 'admin.unpairNone', 'admin.panel'])
  ok(inEnAndId(k) === 2, `${k} in BOTH languages`);
ok(/keeps every text and recording/.test(i18nBlock('en')),
   '⚠ and the note says WHICH button keeps the work — the two sit together and one is destructive');

console.log(fail ? `\nFAILED (${fail})` : '\nPASSED');
process.exit(fail ? 1 : 0);
