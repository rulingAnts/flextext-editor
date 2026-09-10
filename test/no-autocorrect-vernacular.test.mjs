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
  canMarkWithoutReplacing, canSuggestWithoutReplacing, setTypingPlatform, kindOf, VERN, ANAL,
} from '../docs/js/typing.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APPS = ['../docs/index.html', '../satellites/audio-segmenter/index.html',
  '../satellites/consent-collector/index.html', '../satellites/crowd-recorder/index.html',
  '../satellites/text-recorder/index.html'];

/* Records every write, because "did it write at all?" is the question behind the v653 loop. */
function fakeEl() {
  const attrs = new Map();
  const writes = [];
  return {
    nodeType: 1, dataset: {}, spellcheck: undefined, writes,
    setAttribute: (k, v) => { writes.push(k); attrs.set(k, String(v)); },
    removeAttribute: (k) => { if (attrs.has(k)) writes.push(k); attrs.delete(k); },
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    hasAttribute: (k) => attrs.has(k),
    attrs,
  };
}



/* Sets what the browser reports about its languages, so each test says which case it is about. */
function withBrowserLanguages(primary, langs, fn) {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120', language: primary, languages: langs || [primary] },
    configurable: true,
  });
  try { return fn(); } finally {
    if (real) Object.defineProperty(globalThis, 'navigator', real);
    else delete globalThis.navigator;
  }
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
  setAnalysisLang(() => 'id');
  const r = withBrowserLanguages('en-US', ['en-US', 'en'], () => resolveTyping(ANAL));
  assert.equal(r.correct, false, 'replacement: never, on any platform');
  /* ⚠ MARKING DECLINES TOO, and the reason is measured. v659 enabled it when navigator.languages
   * suggested the browser had the dictionary; Seth tested that in Firefox with Indonesian installed
   * AND listed, and the field was still checked against English. `lang` is a hint the browser may
   * override with the user's own dictionary choice, and no API reports which one it will use. Wrong
   * dictionary = every word flagged, silently, looking like it works. So auto declines. */
  // A browser that lists no Indonesian at all: marking would be done against something else.
  assert.equal(r.spell, false, 'marking: declines when the browser does not list that language');
  assert.equal(r.complete, canSuggestWithoutReplacing(), 'choices: where they are only choices');

  /* ⚠ AND IT DOES WORK WHERE IT IS LISTED — verified by Seth in Firefox: a fresh gloss box with
   * lang="id" is checked in Indonesian. Covers both the researcher who added the language and the
   * field devices, which are configured in the LWC by construction. */
  const listed = withBrowserLanguages('en-US', ['en-US', 'en', 'id'], () => resolveTyping(ANAL));
  assert.equal(listed.spell, canMarkWithoutReplacing(),
    'marking: on when the browser lists the analysis language');
  setAnalysisLang(() => '');
  setTypingPrefs(() => ({}));
});

test('MARK is off for the vernacular — no dictionary means every word underlines', () => {
  const el = applyTyping(fakeEl(), VERN);
  assert.equal(el.spellcheck, false);
  assert.equal(el.getAttribute('lang'), null, 'and it names no language, since none would be right');
});

/* Seth's own examples: "fedahu" for perahu, "tudu" for turun — a Fayu speaker writing Indonesian by
 * ear. Real words, spelled wrong, in a language the device HAS a dictionary for. */
test('MARK on the analysis language is opt-in, and then it carries a language', () => {
  setTypingPrefs(() => ({ spell: 'on' }));
  setAnalysisLang(() => 'id');
  try {
    const el = applyTyping(fakeEl(), ANAL);
    assert.equal(el.spellcheck, true, 'an explicit on is honoured');
    assert.equal(el.getAttribute('lang'), 'id', 'and the language is named, as a hint');
    /* ⚠ A HINT, NOT A CHOICE. Firefox overrode lang="id" with the user's own dictionary selection —
     * measured, not assumed. Naming the language is still worth doing (Chrome honours it more
     * often, and it drives font and screen-reader behaviour), but the tooltip must not promise it. */
  } finally { setTypingPrefs(() => ({})); setAnalysisLang(() => ''); }
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

/* ⚠ THE FIELDS THE ENGINE DRAWS ARE COVERED BY SELECTOR, NOT BY A CALL AT EVERY RENDER — which is
 * the whole performance fix. This test pins the coupling that replaces those calls: if a render path
 * renames a class, the selector in typing.js has to move with it or the field silently loses its
 * policy. That is the one fragility this design introduces, so it gets its own test. */
test('every field the engine draws still matches a selector typing.js knows', () => {
  const typing = rd('../docs/js/typing.js');
  const sel = typing.slice(typing.indexOf('const SEL_ANAL'), typing.indexOf('const SEL_ANY'));
  const app = rd('../docs/js/app.js'), seg = rd('../docs/js/segment-strips.js');

  for (const [cls, where, src] of [
    ['free-input', 'the free translation', app],
    ['gloss-input', 'the word gloss', app],
    ['mg-g', 'the mini-gloss gloss', app],
    ['mg-ft', 'the mini-gloss free translation', app],
    ['word-txt', 'the editable baseline word', app],
    ['mg-w', 'the mini-gloss word', app],
    ['seg-text', 'the segmenter row', seg],
  ]) {
    assert.ok(src.includes(`'${cls}'`) || src.includes(`"${cls}"`) || src.includes(`.${cls}`),
      `${where} (.${cls}) still exists in the engine`);
    assert.ok(sel.includes(`.${cls}`), `${where} (.${cls}) is missing from typing.js's selectors`);
  }
  assert.ok(sel.includes('#baseline-text'), 'and the baseline box');
  assert.ok(sel.includes('.pa-pastebox'), "and PAT's paste box");
  assert.ok(sel.includes('#consent-name'), 'and the consent name');
});

/* ─── ENFORCEMENT IS STATIC FIRST, THEN ONE FIELD AT A TIME ──────────────────
 * Seth, 2026-09-10, after three separate performance regressions from live enforcement: "Seems like
 * though it shouldn't be necessary for us to be live-monitoring and changing fields as we go. Seems
 * like we should be able to make that almost static to the browser." */

test('every app carries the vernacular policy in its MARKUP, where it costs nothing', () => {
  /* ⚠ THESE FOUR ATTRIBUTES INHERIT — verified in-browser, three levels deep, on both <input> and
   * contenteditable. That is what makes one <body> attribute replace writes on 1200+ fields, and it
   * is in force from parse time: before any script runs, before an IME can attach. */
  for (const p of ['../docs/index.html', '../paragraph-analysis/index.html',
                   '../satellites/audio-segmenter/index.html', '../satellites/consent-collector/index.html',
                   '../satellites/crowd-recorder/index.html', '../satellites/text-recorder/index.html',
                   '../satellites/flextext-researcher/index.html']) {
    const body = rd(p).match(/<body[^>]*>/)[0];
    for (const a of ['spellcheck="false"', 'autocapitalize="none"',
                     'autocorrect="off"', 'writingsuggestions="false"']) {
      assert.ok(body.includes(a), `${p} <body> is missing ${a}`);
    }
  }
});

/* ⚠ NOTHING MAY GO BACK TO TOUCHING EVERY FIELD ON EVERY RENDER. Measured on an M3: 88ms per 602
 * fields of attribute writes, ~12ms per querySelectorAll, and these apps run on Android tablets
 * several times slower. Three separate regressions came out of live enforcement — an infinite
 * observer loop (v653), a synchronous sweep inside every insertion (v654), and a rAF queue that
 * does not run in a hidden tab and burst on tab-switch (v655). */
test('no live monitoring survives anywhere in the typing path', () => {
  const src = rd('../docs/js/typing.js').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  assert.doesNotMatch(src, /MutationObserver/, 'no observer');
  assert.doesNotMatch(src, /requestAnimationFrame/, 'no deferred queue — rAF is dead in a hidden tab');
  assert.doesNotMatch(src, /querySelectorAll/, 'no document sweeps');
  assert.doesNotMatch(src, /setInterval/, 'and nothing periodic');

  // And no render path calls it per field any more.
  for (const f of ['../docs/js/app.js', '../docs/js/segment-strips.js']) {
    const body = rd(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    assert.doesNotMatch(body, /applyTyping\(/, `${f} must not harden fields at render time`);
  }
});

test('a field names its own language through what the DOM already carries', () => {
  const el = (cls, id) => ({ nodeType: 1, dataset: {}, matches: (sel) =>
    sel.split(',').map((x) => x.trim()).some((x) => x === '.' + cls || x === '#' + id) });
  for (const c of ['free-input', 'gloss-input', 'mg-g', 'mg-ft']) {
    assert.equal(kindOf(el(c)), ANAL, `.${c} is the analysis language`);
  }
  for (const c of ['word-txt', 'seg-text', 'mg-w', 'pa-pastebox']) {
    assert.equal(kindOf(el(c)), VERN, `.${c} is vernacular`);
  }
  assert.equal(kindOf(el(null, 'baseline-text')), VERN, 'and so is the baseline box');
  assert.equal(kindOf(el(null, 'consent-name')), VERN, 'and a personal name');
  assert.equal(kindOf(el('some-button')), null, 'anything else is left alone entirely');

  // An explicit data-typing still wins, for fields marked in HTML.
  const marked = { nodeType: 1, dataset: { typing: 'vern' }, matches: () => false };
  assert.equal(kindOf(marked), VERN);
});

test('the focused field is hardened on pointerdown AND focusin, delegated once', () => {
  const src = rd('../docs/js/typing.js');
  const fn = src.slice(src.indexOf('export function enforceTyping'));
  /* pointerdown fires BEFORE focus — that is the touch path, which is the Android path. focusin
   * catches Tab and the gloss "move to next" walk, which focuses programmatically. */
  assert.match(fn, /addEventListener\('pointerdown', on, true\)/, 'before focus, for touch');
  assert.match(fn, /addEventListener\('focusin', on, true\)/, 'and for keyboard/programmatic focus');
  assert.match(fn, /closest\(SEL_ANY\)/, 'a tap inside a field still finds the field');
  // The stamp is a JS property, never an attribute: no DOM write, no reflow, unobservable.
  assert.match(fn, /el\.__typing = sig;/);
  assert.doesNotMatch(fn, /setAttribute\('data-typed/, 'the stamp is not written into the DOM');
});

/* A settings push must still take effect without any invalidation plumbing. */
test('the stamp is keyed to the policy, so a changed setting re-applies on the next touch', () => {
  const src = rd('../docs/js/typing.js');
  const fn = src.slice(src.indexOf('function policySig'), src.indexOf('export function enforceTyping'));
  assert.match(fn, /resolveTyping\(kind\)/, 'the signature is derived from the resolved policy');
  assert.match(fn, /r\.spell/, 'so changing a dial changes the signature');
  assert.match(fn, /analLangTag\(\)/, 'and so does changing the analysis language');
});

/* ⚠ THE TEST THAT WOULD HAVE CAUGHT IT. The old fake observer was fed one batch of records by hand
 * and never saw its own writes, so a self-feeding loop was invisible to it. This one records every
 * attribute write applyTyping makes and feeds them back exactly as a real MutationObserver would. */
test('applying the policy generates no further work — the loop must converge', () => {
  const el = fakeEl();
  el.dataset.typing = ANAL;

  applyTyping(el, ANAL);
  assert.ok(el.writes.length > 0, 'the first pass does real work');

  /* A real observer would now fire with those records. Every subsequent pass must write NOTHING, or
   * the observer feeds itself forever — which is precisely what v653 shipped. */
  for (let round = 0; round < 5; round++) {
    el.writes.length = 0;
    applyTyping(el, ANAL);
    assert.deepEqual(el.writes, [], `pass ${round + 2} rewrote attributes — this is the v653 loop`);
  }
  assert.equal(el.spellcheck, false, 'and it settled — no dictionary here, so no marking');
});

test('and it converges for the vernacular too, which is on far more fields', () => {
  const el = fakeEl();
  applyTyping(el, VERN);
  el.writes.length = 0;
  applyTyping(el, VERN);
  assert.deepEqual(el.writes, [], 'a settled vernacular field is left completely alone');
  assert.equal(el.spellcheck, false);
});

/* The idempotence test above proves nothing if a value legitimately CHANGES — a settings push must
 * still take effect on the next render. */
test('but a changed setting still writes, or a settings push would do nothing', () => {
  const el = fakeEl();
  setTypingPrefs(() => ({ spell: 'off' }));
  applyTyping(el, ANAL);
  assert.equal(el.spellcheck, false);
  el.writes.length = 0;
  setTypingPrefs(() => ({ spell: 'on' }));       // the researcher just changed it
  applyTyping(el, ANAL);
  assert.equal(el.spellcheck, true, 'the new value lands');
  setTypingPrefs(() => ({}));
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
  const dot = app.slice(app.indexOf('function infoDotHtml'), app.indexOf('function warnDotHtml'));
  assert.match(dot, /<button type="button" class="info-dot"/, 'a button, so a tap works');
  assert.match(dot, /aria-expanded=/, 'and it reports its state');
  assert.match(dot, /aria-controls=/, 'and names what it opens');
  assert.doesNotMatch(dot, /title=/, 'not a hover-only tooltip');

  // Toggled at MODULE SCOPE — setup() is dead in five of the seven apps, and the Settings tab is
  // rebuilt every time it opens, so a bound handler would be stale.
  // Matches the ⚠ triangle as well as the ⓘ — one delegated handler opens both notes.
  assert.match(app, /^document\.addEventListener\('click', \(e\) => \{\n  const dot = e\.target\.closest\?\.\('\.info-dot, \.warn-dot'\);/m,
    'the toggle is delegated on document at module scope, for both note kinds');
  // hidden, not style.display — [hidden] is what the CSS keys on.
  const at = app.indexOf("const dot = e.target.closest?.('.info-dot, .warn-dot')");
  assert.ok(at > 0, 'the delegated handler exists');
  const h = app.slice(at, at + 700);
  assert.match(h, /note\.hidden = !open;/);
  assert.match(h, /e\.stopPropagation\(\);/, 'a label-wrapped dot must not toggle its own control');
});

test('the note is styled and collapsed, and opens ONLY by click or tap', () => {
  const css = rd('../docs/css/app.css');
  assert.match(css, /\.info-dot \{/, 'the dot is styled');
  assert.match(css, /\.info-note \{/, 'so is the note');
  assert.match(css, /\.warn-dot \{/, 'and the ⚠ variant');
  /* ⚠ NO HOVER REVEAL. There was a :has(.info-dot:hover) rule that opened a note on mouseover.
   * Seth, 2026-09-10: "It's a little glitchy and we don't actually need it." Notes appearing and
   * vanishing as the pointer crosses the form made the panel feel unstable, and click/tap already
   * works everywhere — including the touch screens these apps actually run on. */
  assert.doesNotMatch(css, /info-dot:hover\) \+ \.info-note/, 'no hover-reveal rule');
});

/* ⚠ THE ANDROID COUPLING HAS TO BE VISIBLE, not buried in a tooltip nobody opens. Seth, 2026-09-10:
 * "if one of them is 'on', then the other two have a small exclamation point icon tip warning the
 * researcher that this cannot be turned off on Android." */
test('the ⚠ shows on the other two dials whenever one is on, on both surfaces', () => {
  const typing = rd('../docs/js/typing.js');
  const fn = typing.slice(typing.indexOf('export function syncTypingWarnings'));
  assert.match(fn, /const anyOn = vals\.some\(\(v\) => v === ON\)/, 'any dial on triggers it');
  assert.match(fn, /anyOn && vals\[i\] !== ON/, 'and it marks the ones that are NOT on');
  assert.match(fn, /dot\.hidden = !show/, 'hidden, not styled away');

  /* ⚠ NOT GATED ON THE CURRENT DEVICE. A researcher configures a tablet from a laptop, so asking
   * canMarkWithoutReplacing() here would hide the warning exactly where it is needed. Devices do
   * report their UA, but a device being set up for the first time has not reported yet — and that
   * is precisely when settings are chosen. The warning names Android in its text instead. */
  assert.doesNotMatch(fn, /canMarkWithoutReplacing|isAndroid/,
    'the warning must not depend on what the researcher happens to be using');

  for (const [f, attr] of [['../docs/js/app.js', 'data-sf'], ['../docs/js/researcher-panel.js', 'data-f']]) {
    const src = rd(f);
    assert.match(src, /warnDotHtml\(f\)/, `${f} renders the ⚠`);
    assert.match(src, /warnNoteHtml\(f\)/, `${f} renders what it opens`);
    assert.ok(src.includes(`syncTypingWarnings(box, '${attr}')`)
           || src.includes(`syncTypingWarnings(t.closest`), `${f} keeps it in step`);
  }
  // All three dials are flagged as bundled, or the ⚠ never renders for them.
  for (const f of ['../docs/js/app.js', '../docs/js/researcher-panel.js']) {
    assert.equal((rd(f).match(/bundled: true/g) || []).length, 3, `${f}: all three dials flagged`);
  }
  // And the warning text exists in both languages.
  const i18n = rd('../docs/js/i18n.js');
  for (const k of ['panel.f.typingBundledWarn', 'setup.whyNotOff']) {
    assert.equal((i18n.match(new RegExp(`'${k}':`, 'g')) || []).length, 2, `${k} needs EN and ID`);
  }
  const en = i18n.match(/'panel\.f\.typingBundledWarn': '([^']*)'/)[1];
  assert.match(en, /Android/, 'the text names the platform it is about');
  assert.match(en, /computer/, 'and says where they do work separately');
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
    setAnalysisLang(() => 'id');
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) Chrome/120', languages: ['id'] },
      configurable: true,
    });
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

/* ⚠ THE BLANKET ON <body> REACHES FIELDS THAT ARE NOT LANGUAGE DATA, and one of them is prose. The
 * consent message is a paragraph a researcher writes to be read aloud to a speaker, usually in
 * Indonesian; before the blanket it had the browser's defaults. Losing spellcheck and sentence
 * capitals there was an accident of protecting the vernacular, not a decision — this pins the
 * exemption so a later tidy-up cannot quietly take them away again. */
test('prose a researcher writes opts back out of the blanket', () => {
  for (const [f, tag] of [['../docs/js/researcher-panel.js', 'data-f'],
                          ['../docs/js/app.js', 'data-sf']]) {
    const src = rd(f);
    const ta = src.slice(src.indexOf(`<textarea ${tag}=`), src.indexOf(`<textarea ${tag}=`) + 160);
    assert.match(ta, /spellcheck="true"/, `${f}: the textarea keeps spellcheck`);
    assert.match(ta, /autocapitalize="sentences"/, `${f}: and sentence capitals`);
    /* But only the non-destructive pair: a consent message names people and places no dictionary
     * knows, so a silent rewrite there is the same bug as anywhere else in this suite. */
    assert.doesNotMatch(ta, /autocorrect="on"/, `${f}: and still never autocorrects`);
    assert.doesNotMatch(ta, /writingsuggestions="true"/, `${f}: nor invents text`);
  }
});

/* The other side of the same coin: the code fields must NOT get prose treatment. A writing-system
 * code is not a sentence and must never be capitalised or corrected — Seth's own note on those
 * fields is that they are case-sensitive and must match FLEx exactly. */
test('and the writing-system code fields do not', () => {
  /* ⚠ ANCHOR ON THE GENERIC TEXT BRANCH, not the first `<input data-f=` in the file — that one is
   * consentAudioUrl's HIDDEN value carrier, which needs none of this and made this test fail for a
   * reason that had nothing to do with what it was checking. */
  const panel = rd('../docs/js/researcher-panel.js');
  const generic = panel.slice(panel.indexOf('  const input = `<label class="rp-field"'));
  assert.match(generic.slice(0, 200), /spellcheck="false"/, 'panel code fields stay unchecked');
  assert.doesNotMatch(generic.slice(0, 200), /autocapitalize="sentences"/, 'and uncapitalised');

  const app = rd('../docs/js/app.js');
  const setupText = app.slice(app.indexOf('  return offWrap(`<label class="rp-field"${tip}><span>${label}'));
  assert.match(setupText.slice(0, 260), /spellcheck="false"/, 'Settings-tab code fields too');
  assert.doesNotMatch(setupText.slice(0, 260), /autocapitalize="sentences"/, 'and uncapitalised');
});

/* ⚠ NO HEURISTIC MAY DECIDE THIS AGAIN. A navigator.languages proxy was tried in v659 and was
 * wrong on the exact case it was written for: Indonesian installed, Indonesian listed, field still
 * checked against English. Anything that looks like it can infer dictionary availability is a
 * repeat of that mistake. */
/* ⚠ THIS RULE WAS CHANGED TWICE ON BAD EVIDENCE AND CHANGED BACK. One field of Seth's showed
 * ENGLISH with lang="id" and looked like proof that browsers ignore `lang`; it was a REMEMBERED
 * per-field dictionary override from a manual context-menu choice, which Firefox keeps for that
 * field forever. Fresh fields honour `lang` correctly. A stale override on one field is not a
 * platform limit — the test below is what stops that conclusion being drawn a third time. */
test('auto marks when the browser lists the analysis language, and not otherwise', () => {
  const src = rd('../docs/js/typing.js').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  assert.match(src, /browserListsLanguage\(analLangTag\(\)\)/, 'auto consults the browser list');

  // Region variants must not defeat the match: an id-ID browser satisfies an `id` analysis language.
  setTypingPrefs(() => ({ spell: 'auto' }));
  setAnalysisLang(() => 'id');
  try {
    // Region variants must not defeat the match: an id-ID entry satisfies an `id` analysis language.
    assert.equal(withBrowserLanguages('id-ID', ['id-ID'], () => resolveTyping(ANAL)).spell,
      canMarkWithoutReplacing(), 'id-ID counts as id');
    assert.equal(withBrowserLanguages('en-GB', ['en-GB'], () => resolveTyping(ANAL)).spell, false,
      'and a browser listing no Indonesian does not');
  } finally { setTypingPrefs(() => ({})); setAnalysisLang(() => ''); }
});

/* The removed fallback, pinned: app.js used to hand navigator.language to the spellchecker when the
 * analysis code was not a usable tag, which checked Indonesian glosses against the researcher's
 * laptop language. */
test('no analysis code means no language, not the browser language', () => {
  const fn = rd('../docs/js/app.js');
  const block = fn.slice(fn.indexOf('setAnalysisLang(() => {'), fn.indexOf('setAnalysisLang(() => {') + 900);
  assert.doesNotMatch(block.replace(/\/\*[\s\S]*?\*\//g, ''), /navigator\.language/,
    'the browser-language fallback must stay gone');
  assert.match(block, /return '';/, 'an unusable code yields no tag at all');
});

/* ─── OFF BY DEFAULT, AND BOTH WARNINGS ──────────────────────────────────────
 * Seth, 2026-09-10: "let's have all spellchecking for all devices off by default. Automatic still
 * behaves the way we set it up, but is off by default." */
test('an unconfigured device types in complete silence', () => {
  setTypingPrefs(() => ({}));                 // nothing stored anywhere
  setAnalysisLang(() => 'id');
  try {
    const r = resolveTyping(ANAL);
    assert.deepEqual(r, { correct: false, complete: false, spell: false },
      'absent must mean off, not auto — an unconfigured device surprises nobody');
    const el = applyTyping(fakeEl(), ANAL);
    assert.equal(el.spellcheck, false);
    assert.equal(el.getAttribute('autocomplete'), 'off');
    assert.equal(el.getAttribute('autocorrect'), 'off');
  } finally { setAnalysisLang(() => ''); }
});

test('only the literal "auto" gets the automatic answer', () => {
  setAnalysisLang(() => 'id');
  const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120', languages: ['id'] }, configurable: true,
  });
  try {
    // Anything unrecognised is off, so a value written by a future version cannot enable marking.
    for (const v of [undefined, '', 'off', 'On', 'AUTO', 'yes', 'true', null]) {
      setTypingPrefs(() => ({ spell: v }));
      assert.equal(resolveTyping(ANAL).spell, false, `spell=${JSON.stringify(v)} must be off`);
    }
    setTypingPrefs(() => ({ spell: 'auto' }));
    assert.equal(resolveTyping(ANAL).spell, true, "but 'auto' still does what it says");
  } finally {
    setTypingPrefs(() => ({})); setAnalysisLang(() => '');
    if (real) Object.defineProperty(globalThis, 'navigator', real); else delete globalThis.navigator;
  }
});

/* ⚠ AND THE FORM MUST SHOW WHAT THE ENGINE DOES. A form displaying 'Automatic' while the engine
 * treated absence as off would misreport the device's state. */
test('the form shows off when nothing is stored, matching the engine', () => {
  const app = rd('../docs/js/app.js');
  assert.match(app, /TYPING_DIALS\.includes\(f\.k\)\) v\[f\.k\] = TRI\.includes\(s\[f\.k\]\) \? s\[f\.k\] : 'off';/,
    'the read loop defaults to off');
});

/* Two warnings, two different transitions, and neither fires on a value going back off. */
test('picking Automatic warns that it depends on the device, separately from the Android warning', () => {
  const app = rd('../docs/js/app.js');
  const h = app.slice(app.indexOf("const k = t.dataset.sf || t.dataset.f;"));
  assert.match(h, /const firstOn = t\.value === 'on' && !others\.includes\('on'\)/, 'on → bundling');
  assert.match(h, /const firstAuto = t\.value === 'auto' && !others\.includes\('auto'\)/, 'auto → dictionary');
  assert.match(h, /if \(firstOn\) noticeDialog\(t\('panel\.f\.typingBundledWarn'\)\)/);
  assert.match(h, /else if \(firstAuto\) noticeDialog\(t\('panel\.f\.typingAutoWarn'\)\)/,
    'else-if, so one change never raises two dialogs');

  const i18n = rd('../docs/js/i18n.js');
  assert.equal((i18n.match(/'panel\.f\.typingAutoWarn':/g) || []).length, 2, 'EN and ID');
  const en = i18n.match(/'panel\.f\.typingAutoWarn': '([^']*(?:\\'[^']*)*)'/)[1];
  /* ⚠ It must say the app CANNOT install a dictionary. There is no web API for it — Firefox's are
   * user-installed add-ons, Chrome fetches them from its own language settings — so a researcher
   * seeing nothing underlined needs to know that is expected, not a bug to chase. */
  assert.match(en, /cannot install/i, 'it says we cannot install a dictionary');
  assert.match(en, /set up in the analysis language/i, 'and what would make it work');
});

/* ⚠ BOTH SETTINGS SURFACES MUST AGREE WITH THE ENGINE ABOUT AN UNSET DIAL. They did not: app.js's
 * form was fixed to show 'off' while the panel's generic select fallback still took opts[0], which
 * is 'auto'. So the panel reported "Automatic" for a device the engine was treating as silent.
 * Found by opening the real panel and reading the values back — no test had covered it. */
test('an unset dial reads as off on BOTH surfaces, matching the engine', () => {
  const app = rd('../docs/js/app.js'), panel = rd('../docs/js/researcher-panel.js');
  assert.match(app, /TYPING_DIALS\.includes\(f\.k\)\) v\[f\.k\] = TRI\.includes\(s\[f\.k\]\) \? s\[f\.k\] : 'off';/,
    "the device's own Settings tab defaults to off");
  assert.match(panel, /TYPING_DIALS\.includes\(f\.k\)\) v\[f\.k\] = \['auto', 'on', 'off'\]\.includes\(s\[f\.k\]\) \? s\[f\.k\] : 'off';/,
    'and so does the researcher panel');
  /* ⚠ AND THE PANEL'S BRANCH MUST COME BEFORE THE GENERIC ONE, or opts[0] wins again. */
  assert.ok(panel.indexOf("TYPING_DIALS.includes(f.k)) v[f.k]")
          < panel.indexOf("else if (f.type === 'select') v[f.k] = s[f.k] ||"),
    'the specific branch precedes the generic select fallback');
});

/* ⚠ EVERY RESEARCHER-AUTHORED PROSE FIELD, not just the one in GROUPS. The <body> blanket reaches
 * all 16 text fields in the suite; 13 of those are codes, names or vernacular and are correctly
 * silent. Three are prose a researcher writes and reads: consentMsg in the settings form, and the
 * crowd editor's welcome and consent message, which are hand-written outside GROUPS and were missed
 * when consentMsg was fixed. Enumerated by script rather than by memory, and pinned here. */
test('all three researcher-prose fields keep spellcheck and sentence capitals', () => {
  const panel = rd('../docs/js/researcher-panel.js');
  for (const id of ['cr-welcome', 'cr-cmsg']) {
    const tag = panel.match(new RegExp(`<textarea id="${id}"[^>]*>`))[0];
    assert.match(tag, /spellcheck="true"/, `#${id} keeps spellcheck`);
    assert.match(tag, /autocapitalize="sentences"/, `#${id} keeps sentence capitals`);
    assert.doesNotMatch(tag, /autocorrect="on"/, `#${id} still never autocorrects`);
  }
});
