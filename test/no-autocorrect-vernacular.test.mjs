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
  applyTyping, enforceTyping, setAnalysisLang, canMarkWithoutReplacing, VERN, ANAL,
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
test('REPLACE is off on every field class, with no way to turn it on', () => {
  for (const kind of [VERN, ANAL]) {
    const el = applyTyping(fakeEl(), kind);
    assert.equal(el.getAttribute('autocorrect'), 'off', `${kind}: autocorrect`);
    assert.equal(el.getAttribute('autocomplete'), 'off', `${kind}: autocomplete`);
    assert.equal(el.getAttribute('writingsuggestions'), 'false', `${kind}: writingsuggestions`);
    assert.equal(el.getAttribute('autocapitalize'), 'none', `${kind}: no invented capitals`);
    assert.equal(el.getAttribute('data-gramm'), 'false', `${kind}: Grammarly is an extension`);
  }
  // No code path anywhere may hand a field back to the rewriter.
  const src = rd('../docs/js/typing.js').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  assert.doesNotMatch(src, /autocorrect'\s*,\s*'on'/, 'nothing sets autocorrect on');
  assert.doesNotMatch(src, /autocomplete'\s*,\s*'on'/, 'nothing sets autocomplete on');
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
test('on Android, marking collapses to silence rather than dragging REPLACE in with it', () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) Chrome/120' }, configurable: true,
  });
  try {
    assert.equal(canMarkWithoutReplacing(), false, 'Android cannot mark without replacing');
    assert.equal(applyTyping(fakeEl(), ANAL).spellcheck, false, 'so it does not ask to');
  } finally {
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
