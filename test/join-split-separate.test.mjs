/* JOIN AND SPLIT ARE SEPARATE PERMISSIONS, PER TAB — and every pairing of panel and editor versions
 * agrees about what a settings blob means (v707, Seth 2026-10-07: "have joining and splitting be
 * separate (individually set-able) permissions/privileges … each with its own device setting option";
 * "the cut tab always allows splitting and joining"; "make it backward-compatible … so that different
 * versions of researcher panel or editor don't collide and break each other or corrupt data").
 *
 * The pure half (linePermissions / legacyJoinSplit in typing.js) is MEASURED here against the states a
 * mixed-version fleet can produce, because a push MERGES onto the device: a v707 panel may leave four
 * new keys on a device that a v705 panel then writes the old combined key onto. The wiring is pinned
 * as source: both forms show the four switches, both read them through the one resolver, both write
 * the old key as join AND split, every engine site reads the half it is about, and the Cut tab reads
 * none of it.
 *
 * Run: node --test test/join-split-separate.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { linePermissions, legacyJoinSplit } from '../docs/js/typing.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), STRIPS = rd('../docs/js/segment-strips.js'), PANEL = rd('../docs/js/researcher-panel.js'), I18N = rd('../docs/js/i18n.js');
const fn = (src, name) => { const m = src.match(new RegExp(`\\n(?:export )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)); return m ? m[0] : ''; };
const B = (join, split) => ({ join, split });

test('defaults: nothing stored means both allowed, on both tabs', () => {
  assert.deepEqual(linePermissions({}, 'baseline'), B(true, true));
  assert.deepEqual(linePermissions({}, 'gloss'), B(true, true));
  assert.deepEqual(linePermissions(null, 'gloss'), B(true, true));
});

test('an old-only blob (≤ v706, or an old panel\'s push onto a fresh device): the combined key answers for both', () => {
  assert.deepEqual(linePermissions({ joinSplitGloss: false }, 'gloss'), B(false, false));
  assert.deepEqual(linePermissions({ joinSplitGloss: true }, 'gloss'), B(true, true));
  assert.deepEqual(linePermissions({ joinSplitBaseline: false }, 'baseline'), B(false, false));
  // and the tabs never leak into each other
  assert.deepEqual(linePermissions({ joinSplitBaseline: false }, 'gloss'), B(true, true));
});

test('a v707 blob: the four keys answer, each half on its own', () => {
  const s = { joinBaseline: true, splitBaseline: false, joinGloss: false, splitGloss: true, joinSplitBaseline: false, joinSplitGloss: false };
  assert.deepEqual(linePermissions(s, 'baseline'), B(true, false));
  assert.deepEqual(linePermissions(s, 'gloss'), B(false, true));
  // a v707 writer always stores the old key as join AND split — consistent by construction
  assert.equal(legacyJoinSplit(true, false), false);
  assert.equal(legacyJoinSplit(true, true), true);
  assert.equal(legacyJoinSplit(undefined, undefined), true, 'absent means allowed, like every other gate');
});

test('collision: an OLD panel pushes the combined key onto a device holding the four new keys', () => {
  // v707 panel had allowed both; a v705 panel then turns the tab off. The device merges, so all five keys
  // are present and the old one disagrees with join&&split — only an older writer produces that, and it
  // meant BOTH off. Nothing is lost; the next v707 save makes the blob consistent again.
  const after = { joinGloss: true, splitGloss: true, joinSplitGloss: false };
  assert.deepEqual(linePermissions(after, 'gloss'), B(false, false), 'the old panel\'s OFF wins for both halves');
  // v707 panel had allowed join only (old key stored false); the v705 panel turns the tab ON → it meant both on.
  const on = { joinGloss: true, splitGloss: false, joinSplitGloss: true };
  assert.deepEqual(linePermissions(on, 'gloss'), B(true, true), 'the old panel\'s ON wins for both halves');
  // Consistent blobs are left to the new keys.
  assert.deepEqual(linePermissions({ joinGloss: true, splitGloss: true, joinSplitGloss: true }, 'gloss'), B(true, true));
  assert.deepEqual(linePermissions({ joinGloss: false, splitGloss: false, joinSplitGloss: false }, 'gloss'), B(false, false));
  // The one ambiguous state (mixed new keys, old key false) is what a v707 writer stores too: new keys answer.
  assert.deepEqual(linePermissions({ joinGloss: true, splitGloss: false, joinSplitGloss: false }, 'gloss'), B(true, false));
});

test('a NEW panel\'s push onto an OLD device: the old key it writes is the stricter of the two halves', () => {
  // What a v705 engine reads from a v707 panel's patch is joinSplitX; the panel writes it as join && split.
  const read = fn(PANEL, 'readForm');
  assert.match(read, /patch\.joinSplitBaseline = legacyJoinSplit\(raw\.joinBaseline, raw\.splitBaseline\);/);
  assert.match(read, /patch\.joinSplitGloss = legacyJoinSplit\(raw\.joinGloss, raw\.splitGloss\);/);
  // and the editor's own Settings tab, where the four switches are in the form
  assert.match(APP, /if \(has\('joinBaseline'\) && has\('splitBaseline'\)\) patch\.joinSplitBaseline = legacyJoinSplit\(raw\.joinBaseline, raw\.splitBaseline\);/);
  assert.match(APP, /if \(has\('joinGloss'\) && has\('splitGloss'\)\) patch\.joinSplitGloss = legacyJoinSplit\(raw\.joinGloss, raw\.splitGloss\);/);
});

test('both surfaces show the four switches and read them through the one resolver', () => {
  for (const src of [APP, PANEL]) {
    for (const k of ['joinBaseline', 'splitBaseline', 'joinGloss', 'splitGloss']) {
      assert.match(src, new RegExp(`\\{ k: '${k}', type: 'checkbox', note: 'panel\\.f\\.${k}Note' \\}`), `${k} field`);
    }
    assert.doesNotMatch(src, /\{ k: 'joinSplit(Baseline|Gloss)'/, 'the old combined switches are gone from the forms');
    assert.match(src, /v\.joinBaseline = linePermissions\(s, 'baseline'\)\.join;/);
    assert.match(src, /v\.splitBaseline = linePermissions\(s, 'baseline'\)\.split;/);
    assert.match(src, /v\.joinGloss = linePermissions\(s, 'gloss'\)\.join;/);
    assert.match(src, /v\.splitGloss = linePermissions\(s, 'gloss'\)\.split;/);
    assert.match(src, /import \{[^}]*linePermissions, legacyJoinSplit \} from '\.\/typing\.js';/, 'imported from the shared module (already in every SHELL)');
  }
  assert.match(APP, /'joinSplitBaseline', 'joinSplitGloss', 'joinBaseline', 'splitBaseline', 'joinGloss', 'splitGloss', 'enterAtEnd',/, 'all six travel with a setup link');
  for (const k of ['joinBaseline', 'joinBaselineNote', 'splitBaseline', 'splitBaselineNote', 'joinGloss', 'joinGlossNote', 'splitGloss', 'splitGlossNote', 'rel.new.joinSplitSeparate']) {
    assert.equal((I18N.match(new RegExp(`'panel\\.(?:f\\.)?${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `panel.f.${k} in EN and ID`);
  }
  assert.doesNotMatch(I18N, /'panel\.f\.joinSplit(Baseline|Gloss)(Note)?'/, 'the old labels left both dictionaries');
});

test('the engine reads the half each control is about', () => {
  assert.match(APP, /function joinLinesAllowed\(tab\) \{ return !segmentationEnabled\(\) \|\| linePermissions\(settings, tab\)\.join; \}/);
  assert.match(APP, /function splitLinesAllowed\(tab\) \{ return !segmentationEnabled\(\) \|\| linePermissions\(settings, tab\)\.split; \}/);
  assert.doesNotMatch(APP + STRIPS, /joinSplitAllowed|joinSplitOk|deps\.joinSplit\b/, 'the combined gate is gone');
  // JOIN sites
  const dec = fn(APP, 'decorateGlossSegments');
  assert.match(dec, /const joinAllowed = joinLinesAllowed\('gloss'\);/, 'the Gloss 🔗 row');
  assert.match(fn(APP, 'glossJoinLines'), /if \(!current \|\| !joinLinesAllowed\('gloss'\)\) return;/, 'the Gloss join backstop');
  assert.match(APP, /if \(!joinLinesAllowed\('gloss'\)\) return;   \/\/ researcher removed joining on this tab/, 'Backspace in a gloss box');
  assert.match(APP, /e\.key === 'Backspace' && atStart && i > 0 && joinLinesAllowed\('gloss'\) && joinKeysEnabled\(\)/, 'Backspace in a translation');
  assert.match(STRIPS, /if \(next >= 0 && next < paras\.length && joinOk\(\) && !stripsLocked\(i\) && !stripsLocked\(next\)\) \{/, 'the Baseline 🔗');
  assert.equal((fn(STRIPS, 'onKey').match(/if \(!joinOk\(\)\) return;/g) || []).length, 2, 'Backspace and Delete joins on the Baseline');
  // SPLIT sites
  assert.match(dec, /if \(splitLinesAllowed\('gloss'\)\) \{\s*\n\s*const arm = document\.createElement\('button'\);/, 'the Gloss gutter ✂');
  assert.match(fn(APP, 'glossPlace'), /if \(!current \|\| !splitLinesAllowed\('gloss'\)\) return 'ignored';/, 'placing any tier of a Gloss split');
  assert.match(fn(APP, 'glossCaretWant'), /!splitLinesAllowed\('gloss'\)/, 'the caret ✂ in a translation');
  assert.match(APP, /splitOnBaseline: \(\) => baselineTabEnabled\(\) && splitLinesAllowed\('baseline'\),/);
  assert.match(APP, /splitOnGloss: \(\) => glossTabEnabled\(\) && splitLinesAllowed\('gloss'\),/);
  assert.match(APP, /joinLines: \(\) => joinLinesAllowed\('baseline'\),[^\n]*\n\s*splitLines: \(\) => splitLinesAllowed\('baseline'\),/, 'the strips get both deps');
  assert.match(STRIPS, /function joinOk\(\) \{ return !\(deps\.joinLines && !deps\.joinLines\(\)\); \}\nfunction splitOk\(\) \{ return !\(deps\.splitLines && !deps\.splitLines\(\)\); \}/);
  assert.match(STRIPS, /if \(splitOk\(\) && !stripsLocked\(i\)\) \{/, 'the Baseline ✂ arm');
  assert.match(fn(STRIPS, 'stripsPlace'), /if \(!splitOk\(\)\) return 'ignored';/);
  assert.match(fn(STRIPS, 'stripSplitAtPlayhead'), /!splitOk\(\)/);
  assert.match(fn(STRIPS, 'stripsCaretWant'), /if \(!splitOk\(\) \|\| stripsLocked\(i\)\) return false;/);
  assert.equal((fn(STRIPS, 'onKey').match(/if \(!splitOk\(\)\) return;/g) || []).length, 1, 'Enter split on the Baseline');
  // a live push that flips EITHER half re-enters the visible tab (#100's mechanism, widened)
  assert.match(fn(APP, 'applyLiveSettings'), /const gateSig = \(tab\) => `\$\{joinLinesAllowed\(tab\)\}\/\$\{splitLinesAllowed\(tab\)\}`;/);
});

test('the Cut tab reads none of it — it always joins and splits', () => {
  for (const name of ['cutGuessSplits', 'cutGuessPiece', 'cutJoinPrev', 'cutHere', 'renderCut']) {
    const body = fn(STRIPS, name);
    if (!body) continue;
    assert.doesNotMatch(body, /joinOk\(\)|splitOk\(\)|joinLines|splitLines/, `${name} is not gated by the Baseline/Gloss permissions`);
  }
});
