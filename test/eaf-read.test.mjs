/* The ELAN EAF reader — adversarial, plus a ROUND TRIP against our own EAF writer.
 *
 * The round trip is the strongest check available: serializeEaf() is already schema-verified and
 * shipping, so writing a known doc and reading it back proves the reader against a real file of
 * the exact kind researchers will hand it — without a fixture that can drift.
 *
 * Run: node test/eaf-read.test.mjs
 */
import { serializeEaf } from '../docs/js/seg-exports.js';
import { parseXml, decodeEntities, readEaf, detectMapping, eafToLines, orderedRefChildren, tierById } from '../docs/js/eaf-read.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n        got: ${JSON.stringify(a)}\n        want: ${JSON.stringify(b)}`}`);

/* ---------------- the XML scanner ---------------- */

console.log('\nthe XML scanner survives what real files contain');
{
  const r = parseXml(`<?xml version="1.0"?><!-- c --><a x="1" y='2'><b/><c k="a &gt; b">t &amp; u</c></a>`);
  const a = r.children[0];
  ok(a.name === 'a' && a.attrs.x === '1' && a.attrs.y === '2', 'attributes in both quote styles');
  ok(a.children[0].name === 'b' && a.children[0].children.length === 0, 'self-closing element');
  ok(a.children[1].attrs.k === 'a > b', "an attribute containing '>' is not truncated");
  ok(a.children[1].text === 't & u', 'entities decoded in text');
  ok(parseXml('<a>x</a>').children[0].text === 'x', 'plain text');
  eq(decodeEntities('&#65;&#x42;&amp;&nope;'), 'AB&&nope;', 'numeric + named entities, unknown left alone');
  ok(parseXml('<a><![CDATA[<not a tag>]]></a>').children[0].text === '<not a tag>', 'CDATA is text');
  // Tolerance: malformed input must terminate, not hang or throw.
  ok(!!parseXml('<a x="unclosed><b>'), 'unterminated attribute does not hang');
  ok(!!parseXml('<a></b></a>'), 'mismatched close tag does not throw');
}

/* ---------------- round trip: our writer → our reader ---------------- */

const doc = {
  title: 'Frog Meets Fish',
  paragraphs: [
    { segments: [{ baseline: 'Todn lyfch nyr', free: 'Long ago a frog lived by a lily pad.',
                   words: [{ txt: 'Todn', gls: 'frog-Nom' }, { txt: 'lyfch', gls: 'lily.pad' }, { txt: 'nyr', gls: 'by' }], attrs: {} }] },
    { segments: [{ baseline: 'Lyfch tap plap joygoi.', free: 'He liked to sit on the lily pad.',
                   words: [{ txt: 'Lyfch', gls: 'lily.pad' }, { txt: 'tap', gls: 'on' }, { txt: 'plap', gls: 'sit' },
                           { txt: 'joygoi', gls: 'like-DPst' }, { txt: '.', punct: true }], attrs: {} }] },
    { segments: [{ baseline: '', free: '', words: [], attrs: {} }] },                   // timed silence
  ],
  segments: [{ start: 0, end: 2000 }, { start: 2000, end: 4500 }, { start: 4500, end: 5000 }],
};

console.log('\nround trip through the FLEx profile');
{
  const xml = serializeEaf(doc, { profile: 'flex', vern: 'fau', anal: 'en', mediaName: 'frog.wav', date: '2026-01-01' });
  const eaf = readEaf(xml);
  eq(eaf.media.map((m) => m.name), ['frog.wav'], 'media descriptor basename recovered');

  const map = detectMapping(eaf);
  ok(/phrase-txt/.test(map.baseline), `baseline tier detected (${map.baseline})`);
  ok(/word-txt/.test(map.words), `word tier detected (${map.words})`);
  ok(/word-gls/.test(map.glosses), `gloss tier detected (${map.glosses})`);
  ok(/phrase-gls/.test(map.free), `free-translation tier detected (${map.free})`);
  eq(map.title, 'Frog Meets Fish', 'title read from the interlinear-text tier');

  const out = eafToLines(eaf, map);
  eq(out.lines.length, 3, 'every line survives, including the empty timed one');
  eq(out.lines.map((l) => l.baseline), ['Todn lyfch nyr', 'Lyfch tap plap joygoi.', ''], 'baselines');
  eq(out.lines.map((l) => [l.start, l.end]), [[0, 2000], [2000, 4500], [4500, 5000]], 'times');
  eq(out.lines[0].words, [{ txt: 'Todn', gls: 'frog-Nom' }, { txt: 'lyfch', gls: 'lily.pad' }, { txt: 'nyr', gls: 'by' }],
     'words with their glosses, in order');
  eq(out.lines[1].words[4], { txt: '.' }, 'punctuation word kept, and it has no gloss');
  eq(out.lines.map((l) => l.free || ''), ['Long ago a frog lived by a lily pad.', 'He liked to sit on the lily pad.', ''],
     'free translations attach to the right lines');
}

console.log('\nround trip through the SayMore profile (transcription + free translation only)');
{
  const xml = serializeEaf(doc, { profile: 'saymore', vern: 'fau', anal: 'en', mediaName: 'frog.wav', date: '2026-01-01' });
  const eaf = readEaf(xml);
  const map = detectMapping(eaf);
  eq(map.baseline, 'Transcription', 'SayMore transcription tier detected by name');
  eq(map.free, 'Free Translation', 'SayMore free-translation tier detected by name');
  const out = eafToLines(eaf, map);
  eq(out.lines.map((l) => l.baseline), ['Todn lyfch nyr', 'Lyfch tap plap joygoi.', ''], 'baselines');
  eq(out.lines[0].words.map((w) => w.txt), ['Todn', 'lyfch', 'nyr'],
     'no word tier → the baseline is split into words rather than dropping them');
  eq(out.lines[0].words[0].gls, undefined, 'and those words carry no invented glosses');
}

/* ---------------- a FOREIGN eaf: the cases our own writer never produces ---------------- */

const foreign = `<?xml version="1.0" encoding="UTF-8"?>
<ANNOTATION_DOCUMENT AUTHOR="somebody" FORMAT="3.0">
  <HEADER TIME_UNITS="milliseconds">
    <MEDIA_DESCRIPTOR MEDIA_URL="file:///C:/Users/x/My%20Data/rec 01.wav" MIME_TYPE="audio/x-wav"/>
  </HEADER>
  <TIME_ORDER>
    <TIME_SLOT TIME_SLOT_ID="ts1" TIME_VALUE="1000"/>
    <TIME_SLOT TIME_SLOT_ID="ts2" TIME_VALUE="2000"/>
    <TIME_SLOT TIME_SLOT_ID="ts3"/>
    <TIME_SLOT TIME_SLOT_ID="ts4"/>
  </TIME_ORDER>
  <TIER TIER_ID="utterance" LINGUISTIC_TYPE_REF="default">
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="a1" TIME_SLOT_REF1="ts1" TIME_SLOT_REF2="ts2"><ANNOTATION_VALUE>ana bete</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="a2" TIME_SLOT_REF1="ts3" TIME_SLOT_REF2="ts4"><ANNOTATION_VALUE>kabo</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
  </TIER>
  <TIER TIER_ID="wd" PARENT_REF="utterance" LINGUISTIC_TYPE_REF="sub">
    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="w2" ANNOTATION_REF="a1" PREVIOUS_ANNOTATION="w1"><ANNOTATION_VALUE>bete</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>
    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="w1" ANNOTATION_REF="a1"><ANNOTATION_VALUE>ana</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>
    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="w3" ANNOTATION_REF="a2"><ANNOTATION_VALUE>kabo</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>
  </TIER>
  <TIER TIER_ID="gl" PARENT_REF="wd" LINGUISTIC_TYPE_REF="assoc">
    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="g1" ANNOTATION_REF="w1"><ANNOTATION_VALUE>3SG</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>
    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="g2" ANNOTATION_REF="w2"><ANNOTATION_VALUE>go</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>
  </TIER>
  <TIER TIER_ID="translation" PARENT_REF="utterance" LINGUISTIC_TYPE_REF="assoc">
    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="f1" ANNOTATION_REF="a1"><ANNOTATION_VALUE>He went.</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>
  </TIER>
  <LINGUISTIC_TYPE LINGUISTIC_TYPE_ID="default" TIME_ALIGNABLE="true"/>
  <LINGUISTIC_TYPE CONSTRAINTS="Symbolic_Subdivision" LINGUISTIC_TYPE_ID="sub" TIME_ALIGNABLE="false"/>
  <LINGUISTIC_TYPE CONSTRAINTS="Symbolic_Association" LINGUISTIC_TYPE_ID="assoc" TIME_ALIGNABLE="false"/>
</ANNOTATION_DOCUMENT>`;

console.log('\na foreign EAF with unknown tier names maps by STRUCTURE');
{
  const eaf = readEaf(foreign);
  const map = detectMapping(eaf);
  eq(map.baseline, 'utterance', 'the timed tier with real text becomes the baseline');
  eq(map.words, 'wd', 'the 1:many ref child becomes the word tier');
  eq(map.glosses, 'gl', 'the 1:1 child of the words becomes the gloss tier');
  eq(map.free, 'translation', 'the 1:1 child of the baseline becomes the free translation');

  const out = eafToLines(eaf, map);
  eq(out.lines[0].words, [{ txt: 'ana', gls: '3SG' }, { txt: 'bete', gls: 'go' }],
     'PREVIOUS_ANNOTATION order wins over document order (the file lists bete FIRST)');
  eq(out.lines[0].start, 1000, 'aligned line keeps its time');
  ok(out.lines[1].start === undefined && out.lines[1].end === undefined,
     'a line on value-less TIME_SLOTs gets NO invented time');
  eq(out.lines[0].free, 'He went.', 'free translation attached');
  ok(out.lines[1].free === undefined, 'a line with no translation annotation gets none');
  eq(eaf.media[0].name, 'rec 01.wav', 'percent-encoded media path decodes to a plain basename');
}

/* The other ordinary ELAN shape: nothing is a symbolic child. The translation sits on its OWN
 * independent time-aligned tier, and the words are Time_Subdivision (their own times). A reader
 * that only follows ANNOTATION_REF drops every translation and every word here — silently. */
const timeLinked = `<?xml version="1.0" encoding="UTF-8"?>
<ANNOTATION_DOCUMENT FORMAT="3.0">
  <TIME_ORDER>
    <TIME_SLOT TIME_SLOT_ID="t0" TIME_VALUE="0"/><TIME_SLOT TIME_SLOT_ID="t1" TIME_VALUE="500"/>
    <TIME_SLOT TIME_SLOT_ID="t2" TIME_VALUE="1000"/><TIME_SLOT TIME_SLOT_ID="t3" TIME_VALUE="1500"/>
    <TIME_SLOT TIME_SLOT_ID="t4" TIME_VALUE="2000"/>
  </TIME_ORDER>
  <TIER TIER_ID="Sentence" LINGUISTIC_TYPE_REF="default">
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="s1" TIME_SLOT_REF1="t0" TIME_SLOT_REF2="t2"><ANNOTATION_VALUE>u sa</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="s2" TIME_SLOT_REF1="t2" TIME_SLOT_REF2="t4"><ANNOTATION_VALUE>doba kwei</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
  </TIER>
  <TIER TIER_ID="Words" PARENT_REF="Sentence" LINGUISTIC_TYPE_REF="timesub">
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="w1" TIME_SLOT_REF1="t0" TIME_SLOT_REF2="t1"><ANNOTATION_VALUE>u</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="w2" TIME_SLOT_REF1="t1" TIME_SLOT_REF2="t2"><ANNOTATION_VALUE>sa</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="w3" TIME_SLOT_REF1="t2" TIME_SLOT_REF2="t3"><ANNOTATION_VALUE>doba</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="w4" TIME_SLOT_REF1="t3" TIME_SLOT_REF2="t4"><ANNOTATION_VALUE>kwei</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
  </TIER>
  <TIER TIER_ID="English" LINGUISTIC_TYPE_REF="default">
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="e1" TIME_SLOT_REF1="t0" TIME_SLOT_REF2="t2"><ANNOTATION_VALUE>I went</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="e2" TIME_SLOT_REF1="t2" TIME_SLOT_REF2="t4"><ANNOTATION_VALUE>to the village and returned</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
  </TIER>
  <LINGUISTIC_TYPE LINGUISTIC_TYPE_ID="default" TIME_ALIGNABLE="true"/>
  <LINGUISTIC_TYPE CONSTRAINTS="Time_Subdivision" LINGUISTIC_TYPE_ID="timesub" TIME_ALIGNABLE="true"/>
</ANNOTATION_DOCUMENT>`;

console.log('\nan EAF linked by TIME rather than by ANNOTATION_REF (the ordinary ELAN shape)');
{
  const eaf = readEaf(timeLinked);
  const map = detectMapping(eaf);
  eq(map.baseline, 'Sentence', 'baseline detected');
  eq(map.words, 'Words', 'Time_Subdivision words detected as the word tier');
  eq(map.free, 'English', 'the INDEPENDENT time-aligned tier is proposed as the free translation');
  const out = eafToLines(eaf, map);
  eq(out.lines.map((l) => l.baseline), ['u sa', 'doba kwei'], 'lines');
  eq(out.lines.map((l) => l.words.map((w) => w.txt)), [['u', 'sa'], ['doba', 'kwei']],
     'timed words land on the right line, in time order');
  eq(out.lines.map((l) => l.free), ['I went', 'to the village and returned'],
     'time-overlapped translations attach — these would be DROPPED by a ref-only reader');
}

console.log('\nordering helper handles a broken chain without losing annotations');
{
  const tier = { annotations: [
    { id: 'x', ref: 'p', prev: 'ghost', value: 'A' },     // prev points outside the group
    { id: 'y', ref: 'p', prev: 'x', value: 'B' },
    { id: 'z', ref: 'p', prev: 'nowhere', value: 'C' },   // orphan
  ] };
  eq(orderedRefChildren(tier, 'p').map((a) => a.value), ['A', 'B', 'C'], 'orphans are kept, never dropped');
  const cyc = { annotations: [{ id: 'a', ref: 'p', prev: 'b', value: '1' }, { id: 'b', ref: 'p', prev: 'a', value: '2' }] };
  eq(orderedRefChildren(cyc, 'p').length, 2, 'a cyclic chain terminates and keeps both');
}

console.log('\nempty / hostile input degrades instead of throwing');
{
  eq(eafToLines(readEaf('<ANNOTATION_DOCUMENT/>'), detectMapping(readEaf('<ANNOTATION_DOCUMENT/>'))).lines, [], 'empty document → no lines');
  eq(readEaf('not xml at all').tiers, [], 'garbage input → no tiers, no throw');
  ok(tierById(readEaf(foreign), 'nope') === null, 'unknown tier id → null');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASS: the EAF reader holds.\n');
process.exit(fail ? 1 : 0);
