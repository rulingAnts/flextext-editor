/* THE TIMING FIXTURES CARRY TIMING AND NOTHING ELSE (plans/time-gaps-and-estimates.md D16).
 *
 * This repository is public, and the files these skeletons were made from hold a community's language
 * and the names of the people who spoke it. The skeletons keep what the timing tests need — offsets,
 * our "audio" notes, guids, the number of words on each line — and replace everything else: every
 * word, gloss and translation is "w" (punctuation "."), every title the text's neutral label, every
 * speaker empty, every recording "recording.wav". This test is the gate that keeps it so: a fixture
 * added later with a single real word in it fails here, before it can be pushed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureNames, fixtureXml } from './lib/timing-fixtures.mjs';

const LABELS = new Set(['ELAN40', 'E19', 'T151', 'L29', 'E78', 'T53', 'T18', 'U60']);
const TEXT_OK = [
  /^(?:[w.])(?: [w.])*$/,                                   // words, baselines, glosses, translations
  /^audio ~?\d+:\d\d\.\d{3}–\d+:\d\d\.\d{3}$/,              // our own timing note
  /^\d+(?:\.\d+)?$/,                                        // segnum
];
const ATTR_OK = {
  guid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'media-file': /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'begin-time-offset': /^\d+$/, 'end-time-offset': /^\d+$/,
  lang: /^[a-z]{2,3}$/, type: /^[a-z-]+$/, version: /^[\d.]+$/, encoding: /^utf-8$/i,
  vernacular: /^true$/, 'offset-type': /^(milliseconds)?$/, font: /^$/, speaker: /^$/, location: /^recording\.wav$/,
};

test('every fixture is a timing skeleton: no word, name, place or link from the source file', () => {
  const names = fixtureNames();
  assert.ok(names.length >= 9, 'the nine skeletons are present (v718 added U60, an all-untimed FLEx export)');
  for (const name of names) {
    assert.match(name, /^(elan|[a-z])\d+(-[a-z0-9]+)*$/, `${name}: a neutral file name`);
    const xml = fixtureXml(name);
    assert.doesNotMatch(xml, /<!--/, `${name}: no comments`);
    assert.equal((xml.match(/<\?/g) || []).length, 1, `${name}: the XML prolog is the only processing instruction`);
    assert.doesNotMatch(xml, /https?:|www\.|drive|google|connect\.flextext|[?&]t=/i, `${name}: no links or tokens`);
    for (const m of xml.matchAll(/>([^<]+)</g)) {
      const t = m[1].trim();
      if (!t) continue;
      assert.ok(LABELS.has(t) || TEXT_OK.some((re) => re.test(t)), `${name}: unexpected text ${JSON.stringify(t.slice(0, 12))}…`);
    }
    for (const m of xml.matchAll(/\s([\w:-]+)="([^"]*)"/g)) {
      const [, k, v] = m;
      assert.ok(ATTR_OK[k], `${name}: unexpected attribute ${k}`);
      assert.match(v, ATTR_OK[k], `${name}: ${k} holds only what a skeleton may`);
    }
    for (const m of xml.matchAll(/<item type="title"[^>]*>([^<]*)</g)) assert.ok(LABELS.has(m[1]), `${name}: the title is a neutral label`);
  }
});
