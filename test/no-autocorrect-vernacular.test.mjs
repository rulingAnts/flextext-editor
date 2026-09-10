/* AUTOCORRECT MUST NEVER TOUCH LANGUAGE DATA — engine-wide, all seven apps.
 *
 * Seth, 2026-09-10: "no autocorrect, no spellcheck, and no autocomplete for anything vernacular
 * (baseline, baseline words, etc). And this should apply to ALL our apps." / "This is an engine wide
 * change we're implementing."
 *
 * ⚠ THIS IS DATA CORRUPTION, NOT AN ANNOYANCE. The rewrite is silent, it lands in a language the
 * typist may not read, and the wrong word is what gets archived. There is no Fayu dictionary and
 * never will be, so on a vernacular field every correction a device offers is wrong by construction.
 *
 * These tests drive the REAL module against a fake element rather than grepping source: three times
 * this session a source-matching test passed on a word that only appeared in a comment. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyTyping, enforceTyping, setAnalysisLang, setTypingPrefs, resolveTyping,
  canMarkWithoutReplacing, canSuggestWithoutReplacing, setTypingPlatform, VERN, ANAL,
} from '../docs/js/typing.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APPS = ['../docs/index.html', '../satellites/audio-segmenter/index.html',
  '../satellites/consent-collector/index.html', '../satellites/crowd-recorder/index.html',
  '../satellites/text-recorder/index.html'];

function fakeEl() {
  const attrs = new Map();
  return {
    dataset: {}, spellcheck: undefined,
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    attrs,
  };
}

/* The three behaviours the platform bundles together and this module keeps apart:
 * REPLACE (silent swap) — never, anywhere. SUGGEST (a strip of choices) — never on the web layer.
 * MARK (a squiggle, nothing rewritten) — the analysis language only. */
test('REPLACE is off on every field class by default, and auto never turns it on', () => {
  setTypingPrefs(() => ({}));                    // nothing configured — the upgrade case
  for (const kind of [VERN, ANAL]) {
    const el = applyTyping(fakeEl(), kind);
    assert.equal(el.getAttribute('autocorrect'), 'off', `${kind}: autocorrect`);
    assert.equal(el.getAttribute('autocapitalize'), 'none', `${kind}: no invented capitals`);
    assert.equal(el.getAttribute('data-gramm'), 'false', `${kind}: Grammarly is an extension`);
  }
  // ⚠ `auto` must never mean "replace", on any platform. An existing device that has never seen
  // these settings cannot start rewriting glosses on upgrade.
  for (const v of [undefined, 'auto', 'off', 'nonsense']) {
    setTypingPrefs(() => ({ correct: v }));
    assert.equal(resolveTyping(ANAL).correct, false, `correct=${v} does not replace`);
  }
  setTypingPrefs(() => ({}));
});

/* The vernacular is not a setting and must never become one. Seth, 2026-09-10: "For baseline, we
 * don't even want autocomplete suggestions even, we don't want spellcheck, and we DEFINITELY don't
 * want autocorrect ever." */
test('no researcher setting can switch anything on for the vernacular', () => {
  setTypingPrefs(() => ({ correct: 'on', complete: 'on', spell: 'on' }));
  try {
    assert.deepEqual(resolveTyping(VERN), { correct: false, complete: false, spell: false });
    const el = applyTyping(fakeEl(), VERN);
    assert.equal(el.spellcheck, false);
    assert.equal(el.getAttribute('autocorrect'), 'off');
    assert.equal(el.getAttribute('autocomplete'), 'off');
    assert.equal(el.getAttribute('writingsuggestions'), 'false');
  } finally { setTypingPrefs(() => ({})); }
});

test('each dial is honoured independently where the platform separates them', () => {
  setTypingPrefs(() => ({ spell: 'on', complete: 'off', correct: 'off' }));
  const el = applyTyping(fakeEl(), ANAL);
  assert.equal(el.spellcheck, true, 'marking on');
  assert.equal(el.getAttribute('autocomplete'), 'off', 'without completion');
  assert.equal(el.getAttribute('autocorrect'), 'off', 'and without replacement');
  setTypingPrefs(() => ({}));
});

/* ⚠ `auto` differs per dial, and that asymmetry is the design, not an oversight. */
test('auto means the most the device can do safely, dial by dial', () => {
  setTypingPrefs(() => ({ spell: 'auto', complete: 'auto', correct: 'auto' }));
  const r = resolveTyping(ANAL);
  assert.equal(r.correct, false, 'replacement: never, on any platform');
  assert.equal(r.spell, canMarkWithoutReplacing(), 'marking: where it costs nothing');
  assert.equal(r.complete, canSuggestWithoutReplacing(), 'choices: where they are only choices');
  setTypingPrefs(() => ({}));
});

test('MARK is off for the vernacular — no dictionary means every word underlines', () => {
  const el = applyTyping(fakeEl(), VERN);
  assert.equal(el.spellcheck, false);
  assert.equal(el.getAttribute('lang'), null, 'and it names no language, since none would be right');
});

/* Seth's own examples: "fedahu" for perahu, "tudu" for turun — a Fayu speaker writing Indonesian by
 * ear. Real words, spelled wrong, in a language the device HAS a dictionary for. */
test('MARK is on for the analysis language, where a squiggle means something', () => {
  setAnalysisLang(() => 'id');
  const el = applyTyping(fakeEl(), ANAL);
  assert.equal(el.spellcheck, canMarkWithoutReplacing());
  if (canMarkWithoutReplacing()) assert.equal(el.getAttribute('lang'), 'id');
  setAnalysisLang(() => '');
});

/* ⚠ THE FACT THAT DECIDES THE ANDROID DEFAULT: `spellcheck` is the only lever there, and true hands
 * Gboard mark AND suggest AND replace as one bundle. There is no "mark but never replace" on the
 * web, so Android gets the honest answer instead of the nice one. */
test('on Android, auto collapses to silence rather than dragging REPLACE in with it', () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) Chrome/120' }, configurable: true,
  });
  try {
    assert.equal(canMarkWithoutReplacing(), false, 'Android cannot mark without replacing');
    assert.equal(canSuggestWithoutReplacing(), false, 'nor offer without taking');
    setTypingPrefs(() => ({ spell: 'auto', complete: 'auto', correct: 'auto' }));
    const el = applyTyping(fakeEl(), ANAL);
    assert.equal(el.spellcheck, false, 'so auto asks for none of it');
    assert.equal(el.getAttribute('autocomplete'), 'off');

    /* ⚠ AND WHEN THE RESEARCHER OVERRIDES, THE BUNDLING IS HONEST. spellcheck is the only lever
     * Android gives a web page, so an explicit `on` has to raise it — which hands Gboard all three.
     * The tooltip says exactly that before anyone turns one on; the alternative is a setting that
     * silently does nothing, which is worse. */
    setTypingPrefs(() => ({ spell: 'on' }));
    assert.equal(applyTyping(fakeEl(), ANAL).spellcheck, true, 'an explicit on is not ignored');

    // The vernacular stays out of it even on Android, even with everything switched on.
    setTypingPrefs(() => ({ spell: 'on', complete: 'on', correct: 'on' }));
    assert.equal(applyTyping(fakeEl(), VERN).spellcheck, false);
  } finally {
    setTypingPrefs(() => ({}));
    if (real) Object.defineProperty(globalThis, 'navigator', real);
    else delete globalThis.navigator;
  }
});

test('applying twice is the same as applying once — it runs on every render', () => {
  const el = fakeEl();
  applyTyping(el, VERN); const first = new Map(el.attrs);
  applyTyping(el, VERN);
  assert.deepEqual([...el.attrs], [...first]);
});

/* ⚠ A FLEx WRITING-SYSTEM CODE IS NOT A BCP-47 TAG. `fau-x-iyarike` is a valid writing system and
 * means nothing to a spellchecker; aiming a dictionary at the wrong language is worse than aiming it
 * at none. */
test('a writing-system code with a private-use subtag never becomes a spellcheck language', () => {
  const app = rd('../docs/js/app.js');
  const re = app.match(/if \(\/\^\[a-z\]\{2,3\}\(-\[A-Za-z\]\{2,4\}\)\?\$\/\.test\(raw\)\) return raw;/);
  assert.ok(re, 'app.js screens the analysis code before passing it to a dictionary');
  const ok = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
  assert.equal(ok.test('fau-x-iyarike'), false, 'the private-use tag is rejected');
  assert.equal(ok.test('id'), true, 'a real one is not');
});

/* ⚠ MODULE SCOPE, NOT setup(). setup() returns early for CROWD, PARAGRAPH, RESEARCHER, RECORD and
 * CONSENT — five of the seven apps — so a call placed inside it is dead where it is needed most.
 * This trap already caught the refresh button and the offsite links; column 0 is the tell. */
test('the sweep is wired where all seven apps reach it', () => {
  assert.match(rd('../docs/js/app.js'), /^enforceTyping\(document\);$/m,
    'enforceTyping runs at module scope, unindented');
  assert.equal(typeof enforceTyping, 'function');
});

test('every app ships its vernacular fields already marked, in the HTML', () => {
  for (const p of APPS) {
    const html = rd(p);
    const fields = [...html.matchAll(/<(?:textarea|input)[^>]*\bid="(baseline-text|consent-name)"[^>]*>/g)];
    assert.ok(fields.length, `${p} has a language field to protect`);
    for (const [tag, id] of fields) {
      assert.match(tag, /data-typing="vern"/, `${p} #${id} is marked`);
      // ⚠ in the markup, not patched on after: the IME reads a field's attributes when it attaches,
      // so a field hardened after first focus has already offered a round of suggestions.
      assert.match(tag, /autocomplete="off"/, `${p} #${id} is hardened before any script runs`);
      assert.match(tag, /spellcheck="false"/, `${p} #${id} starts silent`);
    }
  }
});

test('the fields the engine draws go through the policy, not their own attributes', () => {
  const app = rd('../docs/js/app.js');
  for (const [what, near] of [
    ['free translation', "input.className = 'free-input'"],
    ['word gloss', "g.className = 'gloss-input'"],
  ]) {
    const i = app.indexOf(near);
    assert.ok(i > 0, `${what} still exists`);
    assert.match(app.slice(i, i + 700), /applyAnalysisTyping\(|applyTyping\(/, `${what} is covered`);
  }
  // The baseline WORD — Seth named it: "baseline, baseline words".
  const w = app.indexOf("t2.className = 'word-txt';");
  assert.match(app.slice(w, w + 900), /applyTyping\(t2, VERN\)/, 'the editable baseline word');
  // Both halves of the mini-gloss editor, each in its own language.
  assert.match(app, /applyTyping\(el, field === 'txt' \? VERN : ANAL\)/, 'mini-gloss word vs gloss');
  // The segmenter row.
  const seg = rd('../docs/js/segment-strips.js');
  const s = seg.indexOf("input.className = 'seg-text'");
  assert.match(seg.slice(s, s + 600), /applyTyping\(input, VERN\)/, 'the segmenter row input');
});

/* ⚠ THE SWEEP IS THE PART THAT HAS TO HOLD. Fields are drawn by six apps across a dozen render
 * paths, several of which rebuild rows as the user scrolls; a policy applied only at the call sites
 * is one new createElement() away from a hole, and one missed field is a corrupted text. Same shape
 * that closed the offsite-link hole: sweep what is here, observe what arrives. */
function fakeDom(fields) {
  const body = {
    nodeType: 1, dataset: {},
    querySelectorAll: () => fields.filter((f) => f.dataset.typing),
  };
  return { documentElement: body, body, _fields: fields };
}

test('the sweep hardens fields that are already on the page', () => {
  const f = Object.assign(fakeEl(), { nodeType: 1 });
  f.dataset.typing = VERN;
  f.spellcheck = true;                       // a hostile starting state
  const real = globalThis.MutationObserver;
  globalThis.MutationObserver = function () { return { observe() {}, disconnect() {} }; };
  try {
    enforceTyping(fakeDom([f]));
    assert.equal(f.spellcheck, false, 'the stray true is corrected');
    assert.equal(f.getAttribute('autocorrect'), 'off');
  } finally { globalThis.MutationObserver = real; }
});

test('and it watches for fields that arrive later, and for a stray spellcheck', () => {
  let opts = null, cb = null;
  const real = globalThis.MutationObserver;
  globalThis.MutationObserver = function (fn) {
    cb = fn;
    return { observe: (_t, o) => { opts = o; }, disconnect() {} };
  };
  try {
    const stop = enforceTyping(fakeDom([]));
    assert.ok(opts, 'it observes');
    assert.equal(opts.childList, true, 'new fields');
    assert.equal(opts.subtree, true, 'however deep they are nested');
    assert.deepEqual(opts.attributeFilter, ['data-typing', 'spellcheck'],
      'and a stray el.spellcheck = true anywhere in the suite loses, rather than quietly winning');

    // A row rebuilt mid-scroll: the field arrives unhardened and must not stay that way.
    const born = Object.assign(fakeEl(), { nodeType: 1 });
    born.dataset.typing = VERN;
    born.spellcheck = true;
    cb([{ type: 'childList', addedNodes: [born] }]);
    assert.equal(born.spellcheck, false, 'the late field is swept');
    assert.equal(born.getAttribute('writingsuggestions'), 'false');

    assert.equal(typeof stop, 'function', 'and it can be torn down');
  } finally { globalThis.MutationObserver = real; }
});

/* ─── THE THREE DIALS ON THE SETTINGS SURFACES ────────────────────────────────
 * Seth, 2026-09-10: "an 'on/off/auto' (where auto makes the best choice for the above constraints
 * based on the UA/platform) for spellcheck/autocorrect/autocomplete. Also probably an information
 * tooltip next to each (mouseover or click/touch) that explains what that setting can and cannot do
 * by platform." */
const DIALS = ['analSpellcheck', 'analAutocomplete', 'analAutocorrect'];

test('all three dials exist on both settings tables, tri-state, in both languages', () => {
  const app = rd('../docs/js/app.js'), panel = rd('../docs/js/researcher-panel.js');
  const i18n = rd('../docs/js/i18n.js');
  for (const k of DIALS) {
    for (const [where, src] of [['unpaired Settings (SETUP_GROUPS)', app],
                                ['researcher panel + project defaults (GROUPS)', panel]]) {
      const i = src.indexOf(`k: '${k}'`);
      assert.ok(i > 0, `${k} is missing from ${where}`);
      const decl = src.slice(i, i + 260);
      assert.match(decl, /opts: \['auto', 'on', 'off'\]/, `${k} in ${where} is on/off/auto`);
      assert.match(decl, /info: 'panel\.f\./, `${k} in ${where} has an ⓘ`);
    }
    // EN and ID, label and tooltip. Two hits each = both language blocks.
    for (const key of [`panel.f.${k}`, `panel.f.${k}Info`]) {
      const hits = (i18n.match(new RegExp(`'${key}':`, 'g')) || []).length;
      assert.equal(hits, 2, `${key} needs EN and ID (found ${hits})`);
    }
  }
  for (const o of ['auto', 'on', 'off']) {
    assert.equal((i18n.match(new RegExp(`'panel\\.opt\\.typing\\.${o}':`, 'g')) || []).length, 2,
      `panel.opt.typing.${o} needs EN and ID`);
  }
});

/* ⚠ `title=` IS MOUSE-ONLY, and these devices have no mouse. An explanation nobody can open is not
 * an explanation — which is why f.tip was not good enough here and f.info exists. */
test('the ⓘ is a real button, reachable by touch, not a title attribute', () => {
  const app = rd('../docs/js/app.js');
  /* ⚠ ASSERT IT IS CALLED, NOT MERELY DEFINED. The first version of this test checked the helper's
   * source and passed while app.js never invoked it — so the unpaired Settings tab rendered three
   * settings with no ⓘ at all, and only a real click in a real browser found it. */
  for (const [f, renderer] of [['../docs/js/app.js', 'setupFieldHtml'],
                               ['../docs/js/researcher-panel.js', 'fieldHtml']]) {
    const src = rd(f);
    const fn = src.slice(src.indexOf(`function ${renderer}(f) {`));
    const sel = fn.slice(fn.indexOf("f.type === 'select'"), fn.indexOf("f.type === 'select'") + 1600);
    assert.match(sel, /\$\{infoDotHtml\(f\)\}/, `${renderer} renders the ⓘ button`);
    assert.match(sel, /infoNoteHtml\(f\)/, `${renderer} renders the note it opens`);
  }
  const dot = app.slice(app.indexOf('function infoDotHtml'), app.indexOf('function infoNoteHtml'));
  assert.match(dot, /<button type="button" class="info-dot"/, 'a button, so a tap works');
  assert.match(dot, /aria-expanded=/, 'and it reports its state');
  assert.match(dot, /aria-controls=/, 'and names what it opens');
  assert.doesNotMatch(dot, /title=/, 'not a hover-only tooltip');

  // Toggled at MODULE SCOPE — setup() is dead in five of the seven apps, and the Settings tab is
  // rebuilt every time it opens, so a bound handler would be stale.
  assert.match(app, /^document\.addEventListener\('click', \(e\) => \{\n  const dot = e\.target\.closest\?\.\('\.info-dot'\);/m,
    'the toggle is delegated on document at module scope');
  // hidden, not style.display — [hidden] is what the CSS keys on.
  const h = app.slice(app.indexOf("const dot = e.target.closest?.('.info-dot')"), app.indexOf("const dot = e.target.closest?.('.info-dot')") + 700);
  assert.match(h, /note\.hidden = !open;/);
  assert.match(h, /e\.stopPropagation\(\);/, 'a label-wrapped dot must not toggle its own control');
});

test('and the note is styled, collapsed by default, with hover only as a bonus', () => {
  const css = rd('../docs/css/app.css');
  assert.match(css, /\.info-dot \{/, 'the dot is styled');
  assert.match(css, /\.info-note \{/, 'so is the note');
  assert.match(css, /:has\(\.info-dot:hover\) \+ \.info-note/, 'hover is an enhancement on top');
});

/* Every tooltip has to say what the dial cannot do, per platform — that is the whole point of
 * having them. A tooltip that only restates the label would be worse than none. */
test('every tooltip names the platform it behaves differently on', () => {
  const i18n = rd('../docs/js/i18n.js');
  for (const k of DIALS) {
    const en = i18n.match(new RegExp(`'panel\\.f\\.${k}Info': '([^']*(?:\\\\'[^']*)*)'`));
    assert.ok(en, `${k}Info has English text`);
    const text = en[1];
    assert.ok(text.length > 180, `${k}Info actually explains something (${text.length} chars)`);
    assert.match(text, /Android/, `${k}Info says what happens on Android`);
    assert.match(text, /Automatic/, `${k}Info says what Automatic decides`);
  }
});

test('the vernacular lock is stated on the surface, not just in the code', () => {
  const i18n = rd('../docs/js/i18n.js');
  const note = i18n.match(/'panel\.f\.analTypingNote': '([^']*(?:\\'[^']*)*)'/);
  assert.ok(note, 'there is a note on the group');
  assert.match(note[1], /glosses and free translations only/i, 'it says what the dials reach');
  assert.match(note[1], /[Vv]ernacular text is never/, 'and what they cannot reach');
});

/* ─── THE PLATFORM SEAM ───────────────────────────────────────────────────────
 * General design principle, Seth, 2026-09-10: "areas where native and pure-PWA code have to diverge
 * have some kind of intermediate function/library/module layer that handles the detection and
 * translation so that the rest of the engine code doesn't have to deal directly with
 * native/non-native decisions, but rather just use the API for things that might or might not
 * interact with a native shell." / "This is so that in general we don't have to update the native
 * shell often."
 *
 * The engine auto-updates; the APK and the desktop installer do not (#61: both bundled engines sat
 * ~500 releases stale). So policy lives in JS and the shell declares capabilities — the same rule
 * check-native-containment.sh already enforces for the audio bridge. */
import { readdirSync } from 'node:fs';

/* ⚠ THE SEAM IS FOR THE NATIVE/NON-NATIVE DECISION, NOT FOR PLATFORM DETECTION IN GENERAL. Seth,
 * 2026-09-10: "a UA sniff for things that a browser can handle, I think is fine. The capability
 * seam we want mainly for things that depend on whether or not there's a native shell." So the
 * engine may freely ask whether it is on a phone (spacePlays does, correctly). What it may not do is
 * decide typing behaviour from whether a native shell is present — that answer belongs to one
 * module, so improving the policy never means shipping a new APK. */
test('no module outside the seam conditions typing on whether a shell is present', () => {
  const dir = new URL('../docs/js/', import.meta.url);
  const offenders = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js') || f === 'typing.js' || f === 'native-audio.js') continue;
    const src = readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    for (const m of src.matchAll(/isNativeShell\(\)|nativePlatform\(\)|__flextextNative/g)) {
      // Is a typing attribute decided within a few lines of the native question?
      const near = src.slice(Math.max(0, m.index - 300), m.index + 300);
      if (/spellcheck|autocorrect|writingsuggestions|autocomplete/.test(near)) offenders.push(`${f}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [],
    'typing behaviour must come from typing.js asking the platform, not from callers testing for native');
});

/* The platform question for typing is asked in exactly ONE place. */
test('typing.js is the only module that consults the platform about typing', () => {
  const dir = new URL('../docs/js/', import.meta.url);
  const importers = readdirSync(dir).filter((f) => f.endsWith('.js')
    && /import \{[^}]*\bisAndroid\b[^}]*\} from '\.\/external-link\.js'/.test(
      readFileSync(new URL(f, dir), 'utf8')));
  assert.deepEqual(importers, ['typing.js']);
});

test('callers name a field class and nothing else — no platform argument reaches them', () => {
  for (const f of ['../docs/js/app.js', '../docs/js/segment-strips.js']) {
    const src = rd(f);
    for (const m of src.matchAll(/applyTyping\(([^)]*)\)/g)) {
      const args = m[1].split(',').map((a) => a.trim());
      assert.ok(args.length === 2, `applyTyping takes (el, kind): ${m[0]} in ${f}`);
      assert.match(args[1], /^(VERN|ANAL|field === 'txt' \? VERN : ANAL|node\.dataset\.typing|el\.dataset\.typing|kind)$/,
        `the second argument is a field class, not a platform test: ${m[0]}`);
    }
  }
});

/* ⚠ THE SHELL DECLARES, THE ENGINE DECIDES. A native shell that can separate the three dials says
 * so once; every policy change after that ships with the engine and needs no new APK. */
test('a native shell can declare better capabilities without any caller changing', () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) Chrome/120' }, configurable: true,
  });
  try {
    setTypingPrefs(() => ({ spell: 'auto', complete: 'auto', correct: 'auto' }));
    assert.equal(applyTyping(fakeEl(), ANAL).spellcheck, false, 'web on Android: silent');

    // What #62 buys, expressed as a declaration rather than a code change.
    setTypingPlatform({ markWithoutReplacing: true, suggestWithoutReplacing: true, dialsAreIndependent: true });
    const el = applyTyping(fakeEl(), ANAL);
    assert.equal(el.spellcheck, true, 'native on Android: marks');
    assert.equal(el.getAttribute('autocomplete'), 'on', 'and offers choices');
    assert.equal(el.getAttribute('autocorrect'), 'off', 'and still never replaces');

    // And the vernacular is still untouchable, native or not.
    assert.equal(applyTyping(fakeEl(), VERN).spellcheck, false);
  } finally {
    setTypingPlatform(null);
    setTypingPrefs(() => ({}));
    if (real) Object.defineProperty(globalThis, 'navigator', real);
    else delete globalThis.navigator;
  }
});
