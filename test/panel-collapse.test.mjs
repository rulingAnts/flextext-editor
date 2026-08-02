/* Collapsible device cards on the researcher dashboard.
 *
 * TWO PROPERTIES ARE WORTH PINNING, and neither is obvious from reading the card:
 *
 * 1. A COLLAPSE MUST NOT HIDE A WARNING. A pending install, a remote wipe and a stale engine are
 *    the three states that need the researcher's attention; if the collapse buries them, it hides
 *    precisely what it should surface, and the dashboard looks calm while a device is stuck.
 *
 * 2. THE STATE IS DERIVED ON EVERY RENDER, NOT CARRIED IN THE DOM. The dashboard rebuilds itself on
 *    a 12-second poll, so a card that read its state from the DOM (or animated its way open) would
 *    flicker or snap shut every twelve seconds while someone was reading it.
 *
 * isCardCollapsed() is pure, but researcher-panel.js cannot be imported under plain node (it reads
 * `location` at module scope, by design — invite links must be absolute). So the function is
 * lifted out of the real source and evaluated: a rename or a rewrite fails this test rather than
 * silently testing a stale copy.
 *
 * Run: node test/panel-collapse.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const panel = read('../docs/js/researcher-panel.js');
const css = read('../docs/css/app.css');
const i18n = read('../docs/js/i18n.js');

// Lift the real implementation out of the real file.
const src = panel.match(/export function isCardCollapsed\(([^)]*)\)\s*\{\n([\s\S]*?)\n\}/);
ok(!!src, 'isCardCollapsed() is present and exported from researcher-panel.js');
if (!src) { console.log('\nFAILED (1)\n'); process.exit(1); }
const isCardCollapsed = new Function(src[1], src[2]);

console.log('\nthe DEFAULT depends on how many devices there are');
{
  const none = new Map();
  ok(isCardCollapsed(none, 'i1', 1) === false, 'one device -> expanded (nothing to scan past)');
  ok(isCardCollapsed(none, 'i1', 2) === true,  'two devices -> collapsed (the dashboard is a list again)');
  ok(isCardCollapsed(none, 'i1', 9) === true,  'nine devices -> collapsed');
  ok(isCardCollapsed(none, 'i1', 0) === false, 'a zero count cannot collapse anything');
}

console.log('\nan EXPLICIT choice always beats the default, in both directions');
{
  ok(isCardCollapsed(new Map([['i1', false]]), 'i1', 5) === false,
     'expanded-by-choice stays expanded even with five devices');
  ok(isCardCollapsed(new Map([['i1', true]]), 'i1', 1) === true,
     'collapsed-by-choice stays collapsed even as the only device');
  ok(isCardCollapsed(new Map([['other', true]]), 'i1', 1) === false,
     'another card\'s choice does not leak across instances');
}

console.log('\nthe stored shape survives a localStorage round trip');
{
  // Persisted as JSON.stringify([...map]) — the same shape as PENDING_KEY. A round trip must not
  // turn an explicit `false` into "no entry", which would silently re-apply the default.
  const stored = new Map([['i1', false], ['i2', true]]);
  const revived = new Map(JSON.parse(JSON.stringify([...stored])));
  ok(isCardCollapsed(revived, 'i1', 4) === false, 'an explicit false survives JSON and still wins');
  ok(isCardCollapsed(revived, 'i2', 1) === true,  'an explicit true survives JSON and still wins');
  ok(isCardCollapsed(revived, 'i3', 4) === true,  'an untouched card still falls back to the default');
  ok(isCardCollapsed(null, 'i1', 2) === true,     'a missing/corrupt store degrades to the default, never throws');
}

console.log('\nthe collapsed header still carries everything worth seeing');
{
  const card = panel.match(/return `<div class="rp-card rp-inst\$\{[\s\S]*?<\/div>`;/);
  ok(!!card, 'the instance card template is findable');
  const html = card ? card[0] : '';
  ok(/rp-inst-name.*it\.nickname/.test(html), 'nickname is in the header');
  ok(/rp-badge-type.*esc\(runs\)/.test(html), 'the app-type badge is in the header');
  ok(/\$\{status\}/.test(html), 'the status badge (incl. "pending approval") is in the header');
  ok(/rp-inst-count.*panel\.inst\.texts/.test(html), 'the text count is in the header');
  ok(/\$\{warnBadges\}/.test(html), 'warning badges ride the header, not the collapsed body');
  ok(/anyWipe \? .*panel\.inst\.wipeBadge/.test(panel), 'a remote wipe raises a header badge');
  ok(/anyStale \? .*panel\.dev\.stale/.test(panel), 'a stale engine raises a header badge');
  ok(/anyStale = true;/.test(panel), 'staleness is captured while the installs render');
  ok(/if \(ins\.wipe_state\) anyWipe = true;/.test(panel), 'any install in a wipe lifecycle sets the flag');
}

console.log('\nit is a real button, and it is labelled');
{
  ok(/<button class="rp-inst-toggle"/.test(panel), 'the toggle is a <button> — keyboard operable for free');
  ok(/aria-expanded="\$\{collapsed \? 'false' : 'true'\}"/.test(panel), 'aria-expanded reflects the state at render time');
  ok(/aria-controls="\$\{esc\(bodyId\)\}"/.test(panel), 'aria-controls points at the region it hides');
  ok(/el\.setAttribute\('aria-expanded'/.test(panel), 'and the toggle updates aria-expanded when clicked');
  for (const key of ['panel.inst.expand', 'panel.inst.collapse', 'panel.inst.wipeBadge']) {
    const n = (i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;
    ok(n === 2, `${key} is defined in BOTH en and id (found ${n})`);
  }
}

console.log('\nno flicker on the 12s poll');
{
  ok(/data-iact="collapse"/.test(panel), 'the toggle is dispatched through the existing delegated handler');
  const branch = panel.match(/if \(act === 'collapse'\) \{[\s\S]*?\n    \}/);
  ok(!!branch, 'the collapse branch exists');
  // Comments in that branch NAME renderDashboard to explain why it is not called — strip them
  // first, or the test fails on its own documentation.
  const code = branch ? branch[0].split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n') : '';
  ok(branch && !/renderDashboard\(/.test(code),
     'toggling flips the DOM in place and never triggers a re-render/refetch');
  ok(branch && /saveCollapsed\(Researcher\.currentAccountId\(\)\)/.test(branch[0]),
     'the choice is persisted per researcher account before the next render reads it');
  ok(/loadCollapsed\(Researcher\.currentAccountId\(\)\)/.test(panel),
     'renderDashboard re-reads the choice on every render (so a reload keeps it)');
  ok(!/\.rp-inst-body\s*\{[^}]*transition/.test(css),
     'the body has NO transition — an animation would replay on every poll tick');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASS: collapse state is derived, persisted, and never hides a warning.\n');
process.exit(fail ? 1 : 0);
