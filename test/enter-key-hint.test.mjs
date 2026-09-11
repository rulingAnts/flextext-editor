/* The phone keyboard's Enter label on the two full-line boxes (the #74 follow-up, 2026-09-11).
 * v666 turned the baseline rows and the free translation into <textarea>, which gets Gboard's NEWLINE
 * key by default — a key that promises a line break to a box that refuses line breaks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyEnterKeyHint } from '../docs/js/segment-strips.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), STRIPS = rd('../docs/js/segment-strips.js');

function fakeInput() {
  const attrs = new Map(); let writes = 0;
  return {
    setAttribute: (k, v) => { attrs.set(k, String(v)); writes++; },
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    get writes() { return writes; },
  };
}

test('the label follows what Enter does: "next" when it walks on, "enter" when it splits', () => {
  const a = fakeInput(); applyEnterKeyHint(a, true);
  assert.equal(a.getAttribute('enterkeyhint'), 'next', 'enterAtEnd advance — Enter at the end walks to the next line');
  const b = fakeInput(); applyEnterKeyHint(b, false);
  assert.equal(b.getAttribute('enterkeyhint'), 'enter', 'enterAtEnd split — Enter divides the line');
  // refreshed on every focus, so an unchanged label must not be rewritten each time
  applyEnterKeyHint(a, true); applyEnterKeyHint(a, true);
  assert.equal(a.writes, 1, 'no write when the label is already right');
  // a setting pushed while the page is open is picked up on the next focus
  applyEnterKeyHint(a, false);
  assert.equal(a.getAttribute('enterkeyhint'), 'enter');
  assert.doesNotThrow(() => applyEnterKeyHint(null, true));
});

test('both full-line boxes set it before the first focus and refresh it on each focus', () => {
  // baseline rows (segmentation mode)
  assert.match(STRIPS, /const enterHint = \(\) => applyEnterKeyHint\(input, !!\(deps\.enterAdvances && deps\.enterAdvances\(\)\)\);\s*\n\s*enterHint\(\);/);
  assert.match(STRIPS, /input\.addEventListener\('focus', \(\) => \{ growArea\(input\); enterHint\(\); \}\);/);
  // free translation. #78: "Next" only where the phone's own page order lands where Enter's walk does.
  assert.match(APP, /applyEnterKeyHint\(input, freeEnterShowsNext\(\)\);\s*\n\s*input\.addEventListener\('focus', \(\) => \{ growArea\(input\); applyEnterKeyHint\(input, freeEnterShowsNext\(\)\); \}\);/);
});

test('the legacy multi-line baseline keeps its newline key, and word glosses are untouched', () => {
  // there Enter starts a paragraph, so the newline key is the truth
  const legacy = APP.slice(APP.indexOf("$('#baseline-text').addEventListener('blur'"), APP.indexOf("$('#baseline-text').addEventListener('blur'") + 1500);
  assert.doesNotMatch(legacy, /applyEnterKeyHint/);
  assert.equal((APP.match(/applyEnterKeyHint\(input, freeEnterShowsNext\(\)\)/g) || []).length, 2,
    'only the free translation in app.js — created once, refreshed on focus');
  assert.equal((APP.match(/applyEnterKeyHint\(/g) || []).length, 2, 'no other box in app.js was given a label');
});
