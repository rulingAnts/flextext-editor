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
  for (const k of ['joinBaseline', 'splitBaseline', 'joinGloss', 'splitGloss', 'cutJoinTexted', 'adjustBoundaries', 'backspaceJoin']) {
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
  assert.match(PANEL, /if \(target\.project\) \{[\s\S]{0,400}data-gact="consentUpload"[\s\S]{0,300}promptProject/,
    'and the button KEEPS working there, with a note saying the recording is saved for the project');
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

/* ── where the dialog leaves you (#87, Brian Plimley, 2026-10-01) ──────────────────────────────
 * Brian: opening a section after scrolling to the bottom of another left him in the middle of the
 * new one, and a new tab opened at the old tab's scroll offset. Wanted: the opened section's TOP in
 * view, and every tab starting at the top. PANEL ONLY — Seth: the Editor's own tabs keep their
 * place for low-skilled users, and its Settings form scrolls with the page, so app.js is pinned
 * below as NOT doing this. The scroll box is the dialog's `.rp-groups`. */
const fnSrc = (src, header) => {
  const i = src.indexOf(header);
  assert.ok(i >= 0, `found ${header}`);
  const rest = src.slice(i);
  return rest.slice(0, rest.indexOf('\n}\n') + 3);
};
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('#87: a new settings tab starts at the top of the scroll box, not the card', () => {
  const body = noComments(fnSrc(PANEL, 'function showSettingsTab(box, tabId) {'));
  assert.match(body, /if \(first\) first\.open = true;\s*const sc = box\.querySelector\("\.rp-groups"\);\s*if \(sc\) sc\.scrollTop = 0;\s*\}\s*$/,
    'the reset is the last thing showSettingsTab does, after the panels are shown/hidden');
  assert.doesNotMatch(body, /modal-card|\.parentNode\.scrollTop|box\.scrollTop/,
    'only `.rp-groups` — the tab bar and the device name live in the card, outside the scroll box');
});

test('#87: opening a section reveals its top — after the siblings close, and never on a close', () => {
  const body = noComments(fnSrc(PANEL, 'function wireSettingsTabs(box) {'));
  assert.match(body,
    /if \(!d\.open \|\| !d\.parentNode\) return;\s*d\.parentNode\.querySelectorAll\("\.rp-sec\[open\]"\)\.forEach\(\(o\) => \{ if \(o !== d\) o\.open = false; \}\);\s*revealSectionTop\(d\);\s*\}\)\);/,
    'a closing section returns early; the reveal is the LAST statement, once the sibling above has collapsed');
  assert.equal((body.match(/revealSectionTop\(/g) || []).length, 1, 'and called from that one place only');
});

test('#87: revealSectionTop guards hidden tabs and a focused field, and scrolls the box, never the page', () => {
  const body = fnSrc(PANEL, 'function revealSectionTop(d) {');
  const code = noComments(body);
  assert.match(code, /const sc = d\.closest\("\.rp-groups"\);\s*if \(!sc \|\| d\.closest\("\[hidden\]"\)\) return;/,
    'a section in a hidden tab panel has no layout — every rect reads 0');
  assert.match(code, /const a = document\.activeElement;[\s\S]*if \(a && a !== d && d\.contains\(a\) && !\(sum && sum\.contains\(a\)\)\) return;/,
    'a validation jump focused a field inside it: that field owns the view (but focus on its OWN summary does not count)');
  assert.match(code, /sc\.scrollTop \+= top;/, 'moves the scroll box itself');
  assert.doesNotMatch(code, /scrollIntoView|scrollTo\(|smooth/,
    'scrollIntoView would also scroll the page behind the fixed modal; instant, not smooth');
});

// A minimal fake DOM — just the selectors these four functions use — so the real code can run here.
class FakeEl {
  constructor(cls, dataset = {}, kids = []) {
    Object.assign(this, { cls, dataset, kids, hidden: false, top: 0, parentNode: null });
    this.classList = { toggle() {} };
    for (const k of kids) k.parentNode = this;
  }
  setAttribute() {}
  addEventListener(type, fn) { this.on = fn; }
  all() { return this.kids.flatMap((k) => [k, ...k.all()]); }
  matches(sel) {
    const m = sel.match(/^\.([\w-]+)(?:\[(open|data-(\w+)="([^"]*)")\])?$/);
    assert.ok(m, `fake DOM understands ${sel}`);
    if (this.cls !== m[1]) return false;
    if (m[2] === 'open') return !!this._open;
    return m[3] ? this.dataset[m[3]] === m[4] : true;
  }
  querySelectorAll(sel) { return this.all().filter((e) => e.matches(sel)); }
  querySelector(sel) { return sel === ':scope > summary' ? this.summary || null : this.querySelectorAll(sel)[0] || null; }
  closest(sel) {
    for (let e = this; e; e = e.parentNode) if (sel === '[hidden]' ? e.hidden : e.matches(sel)) return e;
    return null;
  }
  contains(x) { return x === this || this.all().includes(x); }
  getBoundingClientRect() { return { top: this.top }; }
}
/* A <details>: setting .open QUEUES a toggle (it does not fire it), and a second change before
 * the queue drains replaces the pending one at the back of the queue — as browsers do. */
const queue = [];
class FakeSec extends FakeEl {
  constructor(id, open) {
    const field = new FakeEl('rp-field'), summary = new FakeEl('summary');
    super('rp-sec', { group: id }, [summary, field]);
    Object.assign(this, { summary, field, _open: open });
  }
  get open() { return this._open; }
  set open(v) {
    if (v === this._open) return;
    this._open = v;
    const i = queue.indexOf(this); if (i >= 0) queue.splice(i, 1);
    queue.push(this);
  }
}
const drain = () => { while (queue.length) { const d = queue.shift(); if (d.on) d.on(); } };
const loadAccordion = (doc, tabOf) => {
  const a = PANEL.indexOf('function wireSettingsTabs(box) {');
  const b = PANEL.indexOf('\n}\n', PANEL.indexOf('function showSettingsSection(box, secId, tabOf) {'));
  assert.ok(a > 0 && b > a, 'the accordion functions are findable, in order');
  return new Function('document', 'TAB_OF_SEC', PANEL.slice(a, b + 3)
    + '\nreturn { wireSettingsTabs, showSettingsTab, showSettingsSection, revealSectionTop };')(doc, tabOf);
};

test('#87: revealSectionTop moves only when the opened section\'s top is out of view', () => {
  const doc = { activeElement: null };
  const { revealSectionTop } = loadAccordion(doc, new Map());
  const d = new FakeSec('permissions', true), panel = new FakeEl('rp-tabpanel', { tab: 'work' }, [d]);
  const sc = new FakeEl('rp-groups', {}, [panel]);
  Object.assign(sc, { top: 100, clientHeight: 342 });
  const at = (rel, scrollTop = 500) => { sc.scrollTop = scrollTop; d.top = sc.top + rel; revealSectionTop(d); return sc.scrollTop; };
  assert.equal(at(-1085, 1137), 52, 'above the box (Brian\'s case): its top lands at the top of the box');
  assert.equal(at(350), 850, 'below the box: brought up to the top');
  /* 60px, not 48: on a phone the summary wraps to two lines (name over note, ≈60px with padding),
   * so a header that fits in the last 48px could still have NOTHING of its body in view. */
  assert.equal(at(300), 800, 'a summary in the last 60px, its body out of sight, counts as out of view');
  assert.equal(at(290), 790, 'in view by a one-line (48px) threshold, but a two-line phone header there shows no body: revealed');
  assert.equal(at(282), 500, 'exactly at the 60px line: in view, left alone');
  assert.equal(at(0), 500, 'already at the top: left alone');
  assert.equal(at(120), 500, 'anywhere in view: left alone — no needless jump');
  panel.hidden = true;
  assert.equal(at(-1085, 1137), 1137, 'inside a hidden tab panel: no layout, no move');
  panel.hidden = false;
  doc.activeElement = d.field;
  assert.equal(at(350), 500, 'a field inside it has focus (a validation jump): the field owns the view');
  doc.activeElement = d.summary;
  assert.equal(at(350), 850, 'focus on its OWN summary is just the click that opened it: still revealed');
  const loose = new FakeSec('loose', true);
  assert.doesNotThrow(() => revealSectionTop(loose), 'outside any `.rp-groups`: nothing to scroll, no throw');
});

test('#87: a validation jump keeps its section open even when the tab re-opens its first one', () => {
  // The latent race: every section of the target tab closed, then a jump to the THIRD one.
  // showSettingsTab re-opens the first (queued toggle), the jump opens the target (queued toggle);
  // the first one's toggle used to run first and close the target again.
  const doc = { activeElement: null };
  const TABS = [['device', ['languages', 'appearance']], ['work', ['tasks', 'permissions', 'typing']]];
  const tabOf = new Map(TABS.flatMap(([tab, secs]) => secs.map((s) => [s, tab])));
  const S = {};
  const panels = TABS.map(([tab, secs], i) => {
    const p = new FakeEl('rp-tabpanel', { tab }, secs.map((id, j) => (S[id] = new FakeSec(id, j === 0))));
    p.hidden = i > 0;
    return p;
  });
  const sc = new FakeEl('rp-groups', {}, panels);
  Object.assign(sc, { clientHeight: 342, scrollTop: 900 });
  const box = new FakeEl('modal', {}, [new FakeEl('rp-tabs', {}, TABS.map(([tab]) => new FakeEl('rp-tab', { tab }))), sc]);
  const { wireSettingsTabs, showSettingsSection } = loadAccordion(doc, tabOf);
  wireSettingsTabs(box);
  S.tasks.open = false; drain();
  assert.equal(box.querySelectorAll('.rp-sec[open]').length, 1, 'setup: the work tab has every section closed');

  const sec = showSettingsSection(box, 'typing');
  doc.activeElement = sec.field;                          // flagProblems focuses the bad field…
  drain();                                                // …and only then do the queued toggles run
  assert.equal(S.typing.open, true, 'the section the jump asked for is open');
  assert.equal(S.tasks.open, false, 'and the first section the tab re-opened is shut again');
  assert.equal(panels[1].hidden, false, 'on the tab that holds it');
  assert.equal(sc.scrollTop, 0, 'the tab started at the top; focusing the field is what scrolls it into view');

  // And in the source: the siblings close in the same block that opens the section, not later.
  const body = noComments(fnSrc(PANEL, 'function showSettingsSection(box, secId, tabOf) {'));
  assert.match(body,
    /if \(sec && !sec\.open\) \{\s*sec\.open = true;\s*if \(sec\.parentNode\) sec\.parentNode\.querySelectorAll\("\.rp-sec\[open\]"\)\.forEach\(\(o\) => \{ if \(o !== sec\) o\.open = false; \}\);\s*\}/,
    'synchronously — leaving it to the queued toggle is the race');
  assert.doesNotMatch(body, /setTimeout|requestAnimationFrame|\.then\(/, 'no deferral of any kind');
});

test('#87 scope: the Editor\'s own settings form does NOT reset or reveal — it keeps its place', () => {
  for (const header of ['function wireSetupTabs(form) {', 'function showSetupTab(form, tabId) {']) {
    assert.doesNotMatch(noComments(fnSrc(APP, header)), /scrollTop|scrollIntoView|revealSectionTop/,
      `${header.slice(9, header.indexOf('('))}: the panel's #87 handling is deliberately not mirrored here`);
  }
  assert.doesNotMatch(APP, /function revealSectionTop/, 'and the helper lives in the panel alone');
});

/* ⚠ THE "KEPT IN STEP" COMMENTS MUST BE TRUE (#87 review). The two surfaces share the one-open rule
 * and the tab strip, and differ in two things: the scrolling (deliberate) and the synchronous
 * sibling-close in showSettingsSection, which the Editor's showGroup does not have yet. Both
 * comments name both, and this test keeps them honest in either direction: fix the Editor's race
 * and the comments (and the assertion below) must change with it. */
test('#87: both accordion comments name the Editor\'s showGroup race as a known follow-up — and it is still there', () => {
  const panelNote = PANEL.slice(PANEL.indexOf('/* THE ACCORDION, AND THE TAB STRIP ABOVE IT.'), PANEL.indexOf('function wireSettingsTabs(box) {'));
  const appNote = APP.slice(APP.lastIndexOf('/*', APP.indexOf('const SETUP_TAB_OF_SEC = new Map(')), APP.indexOf('const SETUP_TAB_OF_SEC = new Map('));
  for (const [note, where] of [[panelNote, 'panel'], [appNote, 'Editor']]) {
    assert.match(note, /in step/, `${where}: the comment still talks about keeping the two in step`);
    assert.match(note, /NOT (YET )?the (panel's )?(scrolling|showSettingsSection)|NOT THE SCROLLING|NOT YET/i, `${where}: and names what is not`);
    assert.match(note, /known follow-up/, `${where}: the showGroup race is called a follow-up, not a fact of life`);
    assert.match(note, /showGroup/, `${where}: by name`);
  }
  // The claim is true today: the Editor's showGroup opens the section and leaves the siblings to the toggle.
  const setupAt = APP.indexOf('const showGroup = (id) => {', APP.indexOf('function renderDeviceSetup'));
  assert.ok(setupAt > 0, 'the Editor\'s showGroup is findable');
  const showGroup = APP.slice(setupAt, APP.indexOf('\n  };', setupAt));
  assert.match(showGroup, /if \(sec && !sec\.open\) sec\.open = true;/);
  assert.doesNotMatch(showGroup, /querySelectorAll\("\.rp-sec\[open\]"\)/,
    'no synchronous sibling-close yet — when this is added, update both comments and this test');
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
