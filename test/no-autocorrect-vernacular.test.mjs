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
  assert.equal(el.spellcheck, canMarkWithoutReplacing(), 'and it settled on the right answer');
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
