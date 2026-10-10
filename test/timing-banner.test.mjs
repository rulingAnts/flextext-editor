/* THE TIMING BANNER (v717 — plans/time-gaps-and-estimates.md P6, D15, BM7, §9).
 *
 * One message per text about its audio times, on the editor tabs, above the player. Run here for real
 * (app.js renderTimingBanner, lifted from the source, over a small fake DOM) against the skeletons:
 *   · a timed text shows nothing; E78 shows "estimates (78 of 78)"; the damaged L29 shows the red
 *     "out of step" with line 3 and the 2.1 s tail; T53's 63 ms over the decoded end says nothing;
 *   · Show goes to the first flagged line, Details lists every signal, Dismiss is remembered on the
 *     record QUIETLY and the banner comes back only when what it would say changes;
 *   · researcher-switchable (timingBanner, the allowBlankLines shape), editor tabs only, and only once
 *     the recording has decoded — with its field on both settings surfaces and every string in EN+ID. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFixture, DURATION, ft } from './lib/timing-fixtures.mjs';
import { liftAll } from './lib/lift.mjs';
import * as SEG from '../docs/js/segments.js';
import { t } from '../docs/js/i18n.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), PANEL = rd('../docs/js/researcher-panel.js'), I18N = rd('../docs/js/i18n.js');
const HTML = rd('../docs/index.html'), CSS = rd('../docs/css/app.css');

/* A DOM just big enough for the banner: elements with children, text, classes, hidden and clicks. */
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.hidden = false; this.className = ''; this.textContent = ''; this.dataset = {}; this.attrs = {}; this.on = {}; }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...cs) { this.children = cs; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(ev, fn) { this.on[ev] = fn; }
  click() { this.on.click && this.on.click(); }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  find(cls) { return this.all().find((c) => c.className.split(' ').includes(cls)); }
}

function rig({ name, view = 'baseline', session = false, setting, audio = true, decoded = true } = {}) {
  const banner = new El('div'); banner.hidden = true;
  const doc = loadFixture(name);
  const rec = { id: 'r1', doc, audioSource: audio ? 'local:recording.wav' : undefined };
  const log = { quiet: 0, stamped: 0, shown: [] };
  const env = {
    rec, banner, view, log, SEG, ft, t,
    settings: setting === undefined ? {} : { timingBanner: setting },
    Sync: { hasSession: () => session },
    D: decoded ? DURATION[name] : 0,
  };
  const api = new Function('env', `
    const { SEG, ft, t, Sync, settings, banner, log } = env;
    const { timingReport, isEstimate, isPlaceholder } = SEG;
    const { getBaselineParagraphs, readLegacyEstimates } = ft;
    let current = env.rec, activeTab = env.view;
    const $ = (sel) => (sel === '#timing-banner' ? banner : null);
    const document = { createElement: (tag) => new env.El(tag) };
    const currentView = () => env.view;
    const isEditorTab = (v) => v === 'cut' || v === 'baseline' || v === 'gloss';
    const segmentationEnabled = () => true;
    const getLang = () => 'en';
    const peaksDurationMs = (id) => (id === current.id ? env.D : 0);
    const docSegments = (d) => d.segments;
    const saveQuiet = () => { log.quiet++; return Promise.resolve(); };
    const schedulePersist = () => { log.stamped++; };
    const landOnLine = (tab, pick) => log.shown.push([tab, pick.i, pick.seek]);
    const rowForLine = () => null;
    const setTimeout = (fn) => fn();
    ${liftAll(APP, ['timingBannerOn', 'timingSecs', 'timingItemText', 'timingHeadline', 'timingShowLine', 'renderTimingBanner', 'showTimingLine'])}
    return { render: renderTimingBanner, setCurrent(r) { current = r; } };
  `)({ ...env, El });
  return { ...api, banner, rec, log, env };
}
const text = (el) => el.find('timing-msg').textContent;
const button = (el, k) => el.find('timing-' + k);

test('a timed text shows nothing; neither does T53, 63 ms past its decoded end (decoder spread, not a wrong recording)', () => {
  for (const name of ['t53', 'elan40', 't151', 't18']) {
    const r = rig({ name });
    r.render();
    assert.equal(r.banner.hidden, true, name);
  }
  // The 13 Aug L29 export is sound — no red — but 8 of its lines carry ~ estimates, and says so.
  const l29 = rig({ name: 'l29-13aug' });
  l29.render();
  assert.match(l29.banner.className, /\btiming-estimate\b/);
  assert.match(text(l29.banner), /\(8 of 29 lines, dashed\)/);
});

test('E78: every line an estimate — one quiet banner, Show goes to line 1 (R1)', () => {
  const r = rig({ name: 'e78' });
  r.render();
  assert.equal(r.banner.hidden, false);
  assert.match(r.banner.className, /\btiming-estimate\b/);
  assert.equal(text(r.banner), 'This text’s times are estimates (78 of 78 lines, dashed). They are kept, and written back marked as estimates, until you re-cut them.');
  button(r.banner, 'show').click();
  assert.deepEqual(r.log.shown, [['baseline', 0, true]], 'Show lands on the first estimate, playhead in it');
});

test('the damaged L29: red — line 3 dense and the 2.1 s tail, as one message; Details lists each (R2)', () => {
  const r = rig({ name: 'l29-damaged' });
  r.render();
  assert.match(r.banner.className, /\btiming-red\b/);
  assert.equal(text(r.banner), 'Lines and audio look out of step. Line 3 has 5 words in 0.12 s. The recording runs 2.1 s past the last line. '
    + 'Files saved around 14–17 Aug 2026 can have this. Compare with an earlier export before editing.');
  const list = r.banner.find('timing-list');
  assert.equal(list.hidden, true, 'Details starts folded');
  button(r.banner, 'details').click();
  assert.equal(list.hidden, false);
  assert.deepEqual(list.children.map((li) => li.className), ['timing-item timing-red', 'timing-item timing-red', 'timing-item timing-estimate']);
  assert.match(list.children[2].textContent, /\(8 of 28 lines, dashed\)/, 'the lower signal is listed too');
  button(r.banner, 'show').click();
  assert.deepEqual(r.log.shown, [['baseline', 2, true]], 'Show goes to line 3');
});

test('Dismiss is remembered QUIETLY and holds until what the banner would say changes', () => {
  const r = rig({ name: 'e78' });
  r.render();
  const sig = SEG.timingReport(r.rec.doc.segments, ft.getBaselineParagraphs(r.rec.doc), { durationMs: DURATION.e78 }).sig;
  button(r.banner, 'dismiss').click();
  assert.equal(r.banner.hidden, true);
  assert.equal(r.rec.timingAck, sig, 'the report\'s signature, on the record');
  assert.deepEqual([r.log.quiet, r.log.stamped], [1, 0], 'saved without a modified stamp — dismissing is not an edit');
  r.render();
  assert.equal(r.banner.hidden, true, 'stays dismissed across renders (and reloads: it is on the record)');
  // one seam placed by hand: 76 estimates now, so the banner has something new to say
  const before = [{ ...r.rec.doc.segments[0] }, { ...r.rec.doc.segments[1] }];
  SEG.dragSeam(r.rec.doc.segments, before, 0, 2400, 'end');
  r.render();
  assert.equal(r.banner.hidden, false);
  assert.match(text(r.banner), /\(77 of 78 lines, dashed\)/, 'the line before the seam is real now: its start is 0 and its end was just placed');
});

test('a line inserted through the text box shows as "no audio time yet", amber, and Show goes to it', () => {
  const r = rig({ name: 'elan40' });
  const lines = ft.getBaselineParagraphs(r.rec.doc);
  lines.splice(6, 0, 'a new line');
  const origins = ft.reconcileBaselineWithOrigins(r.rec.doc, lines, { flatSegments: true });
  r.rec.doc.segments = SEG.segmentsFollowLines(r.rec.doc.segments, origins);
  r.render();
  assert.match(r.banner.className, /\btiming-amber\b/);
  assert.equal(text(r.banner), 'Some lines have no audio time yet (1 of 41). Each one is shown in the gap between its timed neighbours, marked “needs timing”, until you set it.');
  button(r.banner, 'show').click();
  assert.deepEqual(r.log.shown, [['baseline', 6, true]]);
  // v718: drawn in its gap (what every tab does before the banner reads the spans), it says the same.
  r.rec.doc.segments = SEG.spreadUntimed(r.rec.doc.segments, DURATION.elan40);
  assert.ok(SEG.isPlaceholder(r.rec.doc.segments[6]), 'the new line sits in the 1.2 s pause it was typed into');
  r.banner.dataset.key = '';
  r.render();
  assert.match(text(r.banner), /^Some lines have no audio time yet \(1 of 41\)\./, 'a placeholder is still a line with no time');
});

test('Dismiss is bound to the text on screen: two texts that say the same thing do not share a banner', () => {
  const r = rig({ name: 'e78' });
  r.render();
  const other = { id: 'r2', doc: loadFixture('e78'), audioSource: 'local:recording.wav' };
  r.setCurrent(other);
  r.render();   // the next text opened says exactly the same thing…
  button(r.banner, 'dismiss').click();
  assert.ok(other.timingAck, '…and Dismiss lands on the text on screen');
  assert.equal(r.rec.timingAck, undefined, 'not on the one opened before it');
});

test('a positional fallback (timeSync) is red and says what happened', () => {
  const r = rig({ name: 't53' });
  r.rec.timeSync = true;
  r.render();
  assert.match(r.banner.className, /\btiming-red\b/);
  assert.match(text(r.banner), /paired by position/);
  assert.equal(button(r.banner, 'show'), undefined, 'no single line to show');
});

test('gating: researcher-switchable, editor tabs only, audio attached and decoded', () => {
  const show = (o) => { const r = rig({ name: 'e78', ...o }); r.render(); return !r.banner.hidden; };
  assert.equal(show({}), true, 'working alone: on');
  assert.equal(show({ session: true }), false, 'a managed device: off until the researcher switches it on');
  assert.equal(show({ session: true, setting: true }), true, '…and on when they do');
  assert.equal(show({ session: true, setting: false }), false);
  assert.equal(show({ setting: false }), true, 'a lone worker always has it — the switch is the researcher\'s');
  for (const v of ['cut', 'gloss']) assert.equal(show({ view: v }), true, `the ${v} tab`);
  for (const v of ['texts', 'research', 'help', 'utilities']) assert.equal(show({ view: v }), false, `not on ${v}`);
  assert.equal(show({ audio: false }), false, 'no recording, no banner');
  assert.equal(show({ decoded: false }), false, 'not before the recording has decoded (two signals measure against it)');
  assert.match(APP, /function timingBannerOn\(\) \{ return !Sync\.hasSession\(\) \|\| settings\.timingBanner === true; \}/, 'D15: the allowBlankLines shape');
});

test('wired where it must be: the element, every render path, the live-settings push, the language toggle', () => {
  const at = HTML.indexOf('<div id="timing-banner" class="banner timing-banner" role="status" hidden></div>');
  assert.ok(at > 0 && at < HTML.indexOf('<div id="audio-player"'), 'above the dock, so it scrolls away and never sticks');
  assert.match(liftAll(APP, ['show']), /renderTimingBanner\(\);/, 'show() — so leaving the editor hides it');
  assert.match(liftAll(APP, ['schedulePersist']), /renderTimingBanner\(\);/, 'every edit');
  assert.match(liftAll(APP, ['applyLiveSettings']), /renderTimingBanner\(\);/, 'a pushed switch lands live');
  assert.equal((APP.match(/onRendered: \(\) => renderTimingBanner\(\),/g) || []).length, 2, 'the Baseline strips and the Cut tab, once drawn');
  assert.match(APP, /decorateGlossSegments\(\);\s*\n\s*renderTimingBanner\(\);/, 'the Gloss tab, once its peaks exist');
  const render = liftAll(APP, ['renderTimingBanner']);
  assert.match(render, /saveQuiet\(rec\);/, 'Dismiss saves quietly');
  assert.doesNotMatch(render, /schedulePersist|persist\(\)/, 'and never as an edit');
});

test('the setting: both settings surfaces, reported back, EN + ID', () => {
  assert.ok(PANEL.includes("{ k: 'timingBanner', type: 'checkbox', note: 'panel.f.timingBannerNote' },"), 'researcher panel');
  assert.ok(APP.includes("{ k: 'timingBanner', type: 'checkbox', note: 'panel.f.timingBannerNote', off: 'setup.off.timingBanner' },"),
    'the unpaired Settings tab — greyed with its reason, as every short-circuiting gate is');
  const order = (src) => src.indexOf("k: 'timingBanner'") > src.indexOf("k: 'adjustBoundaries'") && src.indexOf("k: 'timingBanner'") < src.indexOf("k: 'backspaceJoin'");
  assert.ok(order(PANEL) && order(APP), 'the same section, the same position, on both');
  assert.match(APP, /'exportJson', 'glossIcon', 'timingBanner',/, 'reported to the panel, so it reads back what the device has');
  for (const k of ['panel.f.timingBanner', 'panel.f.timingBannerNote', 'setup.off.timingBanner']) {
    assert.equal((I18N.match(new RegExp(`\n  '${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
});

test('every new string in EN and ID; the "no time" tip says what can actually be done (case 20)', () => {
  const keys = ['seg.checkTip', ...['note', 'marker', 'pattern', 'edit', 'legacy'].map((s) => 'seg.estTip.' + s),
    ...['noTimes', 'estimated', 'partly', 'check', 'checkDense', 'checkTail', 'checkAdvice', 'pastEnd', 'timeSync', 'details', 'show', 'dismiss'].map((s) => 'timing.' + s)];
  for (const k of keys) assert.equal((I18N.match(new RegExp(`\n  '${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  assert.equal(t('seg.pendingTip'), 'No time yet. Join it with the line before, then split it again with the playhead at the right moment.');
  assert.doesNotMatch(I18N, /scrub to the right spot and press Enter again/, 'the old advice, which no ⋯ line could follow, is gone');
});

test('the banner\'s look: four severities, light and dark, and it wraps at phone width', () => {
  for (const lv of ['info', 'estimate', 'amber', 'red']) assert.equal((CSS.match(new RegExp(`\\.timing-banner\\.timing-${lv} \\{`, 'g')) || []).length, 2, `${lv}: light and dark`);
  assert.match(CSS, /\.timing-banner \{ display: flex; flex-wrap: wrap;/);
  assert.match(CSS, /\.timing-banner \.timing-msg \{ flex: 1 1 18em; min-width: 0;[^}]*overflow-wrap: anywhere; \}/, 'a long message wraps rather than widening the page');
});

test('v718 / R6: an untimed text drawn evenly says so ONCE, quietly — and a cramped gap is amber', () => {
  const r = rig({ name: 'u60' });
  r.rec.doc.segments = SEG.spreadUntimed(Array.from({ length: 60 }, () => ({ timePending: true })), DURATION.u60);
  r.render();
  assert.equal(r.banner.hidden, false);
  assert.match(r.banner.className, /\btiming-info\b/, 'info, not amber: every FLEx export with no times looks like this');
  assert.equal(text(r.banner), 'No audio times yet — lines are spread evenly as a placeholder.');
  assert.equal(button(r.banner, 'show'), undefined, 'no one line to show');
  // a partly timed text with no room in a gap: amber, both said
  const p = rig({ name: 't18' });
  const segs = p.rec.doc.segments;
  segs[5] = { timePending: true };
  segs[6] = { timePending: true };
  segs[4] = { ...segs[4], end: segs[7].start - 300 };          // the gap left for two lines: 300 ms
  p.rec.doc.segments = SEG.spreadUntimed(segs, DURATION.t18);
  p.render();
  assert.match(p.banner.className, /\btiming-amber\b/);
  button(p.banner, 'details').click();
  const items = p.banner.find('timing-list').children.map((li) => li.textContent);
  assert.ok(items.includes('2 of them have no room in their gap, shown with ⋯.'), JSON.stringify(items));
});
