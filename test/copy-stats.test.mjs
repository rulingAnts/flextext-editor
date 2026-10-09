/* WHAT A STORED COPY HOLDS, AND WHETHER IT IS WHOLE — flextextStats / checkFlextextBytes.
 *
 * WHY THIS TEST EXISTS (plans/move-upload-guards.md §1.1): every step that picked one of a text's
 * Drive copies picked the NEWEST, and Drive's modifiedTime is upload time. An empty placeholder or a
 * queued copy damaged on the device (489 bytes, all NUL, sent after six days in the queue) sorted as
 * newest and was what a move delivered and what cleanup kept. These two functions are the facts the
 * guards use instead, so they are pinned against the shapes that actually occurred.
 *
 * ⚠ THE DEVICE CHECK MUST NEVER REFUSE A REAL TEXT. checkFlextextBytes is what a device runs before
 * it sends its own copy, and the serializer writes a pasted control character raw (esc() escapes
 * only & < > "). A strict parse would refuse such a text for ever — its only backup, every 30
 * minutes, on battery. So the check is structural and this file proves a control character passes.
 *
 * Run: node --test test/copy-stats.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { flextextStats, checkFlextextBytes, serializeFlextext, makeDoc, reconcileBaseline, makeSegment } = await import('../docs/js/flextext.js');

const doc = (lines, mutate) => {
  const d = makeDoc({ vernLang: 'qaa', analLang: 'id' }, 'Cerita');
  reconcileBaseline(d, lines);
  if (mutate) mutate(d);
  return d;
};
const xmlOf = (d, opts = {}) => serializeFlextext(d, { vernLang: 'qaa', analLang: 'id' }, opts);

test('our own serializer output passes the device check and counts what it holds', () => {
  const d = doc(['satu dua tiga', 'empat lima', ''], (x) => { x.paragraphs[2].segments = [makeSegment('', [])]; });
  d.paragraphs[0].segments[0].words[0].gls = 'one';
  d.paragraphs[1].segments[0].free = 'four five';
  const x = xmlOf(d);
  assert.deepEqual(checkFlextextBytes(x), { ok: true, reason: '' });
  const s = flextextStats(x);
  assert.equal(s.ok, true);
  assert.equal(s.guid, d.textAttrs.guid, 'the <interlinear-text guid> is the join key');
  assert.equal(s.phrases, 3);
  assert.equal(s.textLines, 2, 'a blank line is a phrase, not a line with text');
  assert.equal(s.words, 5);
  assert.equal(s.glossed, 1);
  assert.equal(s.freeLines, 1);
  assert.equal(s.chars, 'satudua tiga'.replace(/\s/g, '').length + 'empatlima'.length);
  assert.equal(s.freeChars, 'fourfive'.length);
});

test('the damaged shapes that occurred are each named, and none is a parse question', () => {
  const nul = '\u0000'.repeat(489);
  assert.equal(checkFlextextBytes(nul).reason, 'nul', 'the 489-byte all-NUL file from the queue');
  assert.equal(checkFlextextBytes('').reason, 'empty');
  assert.equal(checkFlextextBytes('   \n').reason, 'empty');
  assert.equal(checkFlextextBytes('<?xml version="1.0"?>\n<html></html>').reason, 'root');
  assert.equal(checkFlextextBytes('<?xml version="1.0"?>\n<document version="2"></document>').reason, 'noText');
  const whole = xmlOf(doc(['satu dua']));
  assert.equal(checkFlextextBytes(whole.slice(0, whole.length - 40)).reason, 'truncated', 'a copy cut off mid-file');
  for (const bad of [nul, '', whole.slice(0, 200)]) {
    const s = flextextStats(bad);
    assert.equal(s.ok, false);
    assert.equal(s.damaged, true, 'damaged = holds nothing usable — the only verdict that may ever trash or refuse a copy');
  }
});

test('no size floor: a genuinely empty text is whole, however small', () => {
  const empty = xmlOf(doc(['']));
  assert.ok(empty.length < 800, `an empty text serializes small (${empty.length} bytes)`);
  assert.equal(checkFlextextBytes(empty).ok, true, 'and it is still a whole file');
  const s = flextextStats(empty);
  assert.equal(s.ok, true);
  assert.equal(s.words + s.textLines + s.freeLines + s.chars, 0, 'which holds no content');
});

test('a BOM and a comment before the root are fine; a control character is never a refusal', () => {
  const x = xmlOf(doc(['satu dua']));
  assert.equal(checkFlextextBytes('﻿' + x).ok, true, 'a byte-order mark');
  assert.equal(checkFlextextBytes(x.replace('<document', '<!-- exported -->\n<document')).ok, true, 'a leading comment');
  const vt = xmlOf(doc(['satu\u000Bdua']));
  assert.ok(vt.includes('\u000B'), 'the serializer really does write a pasted vertical tab raw');
  assert.equal(checkFlextextBytes(vt).ok, true, '⚠ the device check passes it — the only backup is never refused');
  const s = flextextStats(vt);
  assert.equal(s.ok, true, 'and the panel still counts it: forbidden characters are blanked before parsing');
  assert.ok(s.words >= 1);
});

test('an unparsable-but-whole copy is UNKNOWN, never damaged', () => {
  const x = xmlOf(doc(['satu dua'])).replace('<phrases>', '<phrases><broken');
  const s = flextextStats(x);
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'parse');
  assert.equal(s.damaged, false, '"could not read it" must keep a copy, not trash it');
});

test('estimated spans are seeds, not cuts: `timed` counts only spans a person made', () => {
  const d = doc(['satu', 'dua', 'tiga']);
  d.segments = [{ start: 0, end: 1000 }, { start: 1000, end: 2000, timeEstimated: true }, { start: 2000, end: 3000, timeEstimated: true }];
  const s = flextextStats(xmlOf(d, { segTimes: true }));
  assert.equal(s.phrases, 3);
  assert.equal(s.timed, 1, 'two of the three carry the "~" an estimate is written with');
});

test('a join keeps the content measures and changes only the structure ones', () => {
  const before = doc(['satu dua', 'tiga'], (d) => {
    d.paragraphs[0].segments[0].free = 'one two';
    d.paragraphs[1].segments[0].free = 'three';
  });
  const after = doc(['satu dua tiga'], (d) => { d.paragraphs[0].segments[0].free = 'one two three'; });
  after.textAttrs.guid = before.textAttrs.guid;
  const a = flextextStats(xmlOf(before)), b = flextextStats(xmlOf(after));
  for (const k of ['words', 'glossed', 'chars', 'freeChars']) assert.equal(a[k], b[k], `${k} survives a join`);
  assert.ok(a.phrases > b.phrases && a.freeLines > b.freeLines, 'phrases and freeLines drop — structure, not content');
});
