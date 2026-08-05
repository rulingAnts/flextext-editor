/* Toolbox / SFM interlinear reader — adversarial.
 *
 * The central fixture is the example printed in SIL's *Technical Notes on Interlinear Import*, the
 * spec for how FLEx itself reads these files, so the column-alignment rule is checked against the
 * authority rather than against something I invented.
 *
 * Run: node test/sfm.test.mjs
 */
import { normalizePastedSfm, looksLikeSfm, alignmentRisk, titleFromSfm, parseSfm, markerInventory, detectMapping, tokensWithColumns, alignBlock, parseSfmTime, sfmToTexts } from '../docs/js/sfm.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n        got:  ${JSON.stringify(a)}\n        want: ${JSON.stringify(b)}`}`);

/* The doc's own example, byte for byte. */
const SIL_EXAMPLE = `\\_sh v3.0  520  Text

\\id Frog Meets Fish

\\ref Fish.001
\\tx Todn        lyfch    nyr
\\mb tod  -n     lyfch    nyr
\\ge frog -Nom   lily.pad by
\\ps n1   -case  n        postp
\\tx velgoi.
\\mb vel -goi
\\ge live -DPst
\\ps v   -tns
\\ft Long ago a frog lived by a lily pad.

\\ref Fish.002
\\tx Lyfch    tap   plap joygoi.
\\mb lyfch    tap   plap joy  -goi
\\ge lily.pad on    sit  like -DPst
\\ps n        postp v    v    -tns
\\ft He liked to sit on the lily pad.
`;

console.log('\ntokenizing');
{
  const f = parseSfm(SIL_EXAMPLE);
  eq(f[0].marker, '_sh', 'the Shoebox header line is a field like any other (and is skipped later)');
  eq(f.filter((x) => x.marker === 'ref').length, 2, 'both records found');
  eq(f.find((x) => x.marker === 'id').value, 'Frog Meets Fish', 'header value');
  // A wrapped line continues the field above it.
  const wrapped = parseSfm('\\ft This translation\nspills onto a second line.\n\\tx x');
  eq(wrapped[0].value, 'This translation spills onto a second line.', 'continuation lines join the previous field');
  eq(wrapped.length, 2, 'and do not become fields of their own');
  eq(parseSfm('\\tx\n').length, 1, 'a marker with no value is still a field');
}

console.log('\nmarker inventory + default mapping (a conventional file needs no decisions)');
{
  const f = parseSfm(SIL_EXAMPLE);
  const inv = markerInventory(f);
  ok(!inv.some((e) => e.marker === '_sh'), 'the file header is not offered as a mappable marker');
  eq(inv.find((e) => e.marker === 'tx').count, 3, 'counts are per field, not per record');
  eq(inv.find((e) => e.marker === 'ge').sample, 'frog -Nom   lily.pad by', 'a sample of the real content');
  const m = detectMapping(f);
  eq([m.baseline, m.gloss, m.free, m.title, m.ref], ['tx', 'ge', 'ft', 'id', 'ref'],
     'FLEx\'s conventional markers map themselves');
}

console.log('\nCOLUMN alignment — the rule that makes multi-morpheme words come out right');
{
  eq(tokensWithColumns('ab  cd').map((t) => [t.text, t.col]), [['ab', 0], ['cd', 4]], 'token start columns');
  // The doc's first block: Todn = tod + -n = frog + -Nom
  const w = alignBlock('Todn        lyfch    nyr', 'frog -Nom   lily.pad by');
  eq(w, [{ txt: 'Todn', gls: 'frog-Nom' }, { txt: 'lyfch', gls: 'lily.pad' }, { txt: 'nyr', gls: 'by' }],
     'two gloss tokens under ONE word join into one gloss — positional zipping would give "frog"');
  const w2 = alignBlock('Lyfch    tap   plap joygoi.', 'lily.pad on    sit  like -DPst');
  eq(w2[3], { txt: 'joygoi.', gls: 'like-DPst' }, 'the multi-morpheme word is last: still correct');
  eq(alignBlock('a b', '').map((x) => x.txt), ['a', 'b'], 'no gloss line → words with no glosses');
  eq(alignBlock('word', 'x-  -y'), [{ txt: 'word', gls: 'x--y' }], 'existing hyphens are not doubled');
  // Tabs make column arithmetic meaningless (tab stops are a renderer's choice) → pair positionally.
  eq(alignBlock('a\tbb\tc', 'one\ttwo\tthree', { tabs: true }),
     [{ txt: 'a', gls: 'one' }, { txt: 'bb', gls: 'two' }, { txt: 'c', gls: 'three' }],
     'tab-aligned files fall back to positional pairing instead of bogus columns');
}

console.log('\ntimes as ELAN writes them');
{
  eq(parseSfmTime('12.345'), 12345, 'seconds with decimals → ms');
  eq(parseSfmTime('00:00:12.345'), 12345, 'clock format → ms');
  eq(parseSfmTime('00:01:00'), 60000, 'minutes');
  eq(parseSfmTime(''), null, 'empty → null, never 0');
  eq(parseSfmTime('rubbish'), null, 'unparseable → null');
}

console.log('\nthe whole conversion');
{
  const f = parseSfm(SIL_EXAMPLE);
  const { texts } = sfmToTexts(f, detectMapping(f));
  eq(texts.length, 1, 'one text');
  eq(texts[0].title, 'Frog Meets Fish', 'title from \\id');
  eq(texts[0].lines.length, 2, 'one line per \\ref record');
  eq(texts[0].lines[0].baseline, 'Todn lyfch nyr velgoi.',
     'BOTH \\tx blocks in the record join into one line (the \\ft covers the whole record)');
  eq(texts[0].lines[0].words.map((w) => w.gls),
     ['frog-Nom', 'lily.pad', 'by', 'live-DPst'],
     'words from both blocks, each with its own gloss');
  eq(texts[0].lines[0].free, 'Long ago a frog lived by a lily pad.', 'free translation');
  eq(texts[0].lines[1].words.length, 4, 'second record');
  ok(texts[0].lines[0].start === undefined, 'a plain Toolbox file carries no times, and none are invented');
}

console.log('\nELAN-exported Toolbox: times AND speakers really are in there');
{
  const src = `\\_sh v3.0  520  Text
\\id Conversation
\\ref rec.001
\\ELANBegin 0.000
\\ELANEnd 1.500
\\ELANParticipant Barnabas
\\tx ana bete
\\ge 3SG go
\\ft He went.
\\ref rec.002
\\ELANBegin 1.500
\\ELANEnd 3.250
\\ELANParticipant Tim
\\tx u sa
\\ge 1SG go
\\ft I went.
`;
  const f = parseSfm(src);
  const m = detectMapping(f);
  eq([m.start, m.end, m.speaker], ['ELANBegin', 'ELANEnd', 'ELANParticipant'],
     "ELAN's own markers are detected, with the file's capitalisation");
  const { texts } = sfmToTexts(f, m);
  eq(texts[0].lines.map((l) => [l.start, l.end]), [[0, 1500], [1500, 3250]], 'real time alignment from an SFM file');
  eq(texts[0].lines.map((l) => l.speaker), ['Barnabas', 'Tim'], 'speakers too — the v180 model takes these as-is');
}

console.log('\nONE FILE, MANY TEXTS (a corpus) — both ways a new text can start');
{
  // (a) implicitly: a header block after body content
  const implicit = `\\id First story
\\ref a.001
\\tx one
\\ft One.
\\id Second story
\\ref b.001
\\tx two
\\ft Two.
`;
  const fi = parseSfm(implicit);
  const ti = sfmToTexts(fi, detectMapping(fi)).texts;
  eq(ti.map((t) => t.title), ['First story', 'Second story'], 'a title after body content starts a new text');
  eq(ti.map((t) => t.lines.length), [1, 1], 'and the lines go to the right text');

  // (b) explicitly: the new-text marker
  const explicit = `\\name Alpha
\\ref a.001
\\tx one
\\name Beta
\\ref b.001
\\tx two
`;
  const fe = parseSfm(explicit);
  const te = sfmToTexts(fe, detectMapping(fe)).texts;
  eq(te.map((t) => t.title), ['Alpha', 'Beta'], 'an explicit new-text marker also splits');
}

console.log('\nan EXPLICIT role beats the implicit morpheme line (caught in the browser, not by me)');
{
  const src = '\\ref r\n\\tx Todn  lyfch\n\\mb tod -n  lyfch\n';
  const f = parseSfm(src);
  // The user points "gloss" at \\mb — the same marker auto-detected as the morpheme line. The
  // morpheme role must NOT swallow it, or the glosses vanish with no message at all.
  const t = sfmToTexts(f, { baseline: 'tx', gloss: 'mb', ref: 'ref' }).texts;
  eq(t[0].lines[0].words, [{ txt: 'Todn', gls: 'tod-n' }, { txt: 'lyfch', gls: 'lily.pad' }].slice(0, 1).concat([{ txt: 'lyfch', gls: 'lyfch' }]),
     'mapping the morpheme marker AS the gloss works instead of silently producing nothing');
}

console.log('\nhostile / sloppy input degrades instead of throwing');
{
  eq(sfmToTexts(parseSfm(''), {}).texts, [], 'empty file → no texts');
  eq(sfmToTexts(parseSfm('just some prose\nwith no markers'), {}).texts, [], 'no markers at all → no texts');
  const noRef = parseSfm('\\tx one\n\\ge 1\n\\tx two\n\\ge 2\n');
  const t = sfmToTexts(noRef, { baseline: 'tx', gloss: 'ge' }).texts;
  eq(t[0].lines.length, 2, 'with NO reference marker, each baseline field starts its own line');
  const unmapped = sfmToTexts(parseSfm('\\ref r\n\\tx a\n\\zz junk\n'), { baseline: 'tx', ref: 'ref' }).texts;
  eq(unmapped[0].lines[0].words.map((w) => w.txt), ['a'], 'unmapped markers are ignored, not crashed on');
}

/* SFM NOW ARRIVES PASTED, NOT AS A FILE (Seth's executive decision, 2026-08-05). What pasting
 * costs is whitespace fidelity — and this module pairs glosses to words by COLUMN POSITION — so
 * the job of these helpers is to NOTICE a paste that cannot be trusted rather than silently
 * mis-pairing every gloss. */
console.log('\npasted SFM — normalization, detection, and whether the columns can be trusted');
{
  // Word processors mangle line endings and spaces. Normalize those, and NOTHING else: runs of
  // spaces ARE the alignment, so touching them would destroy the very thing we read.
  eq(normalizePastedSfm('\\tx a\r\n\\gl b\r\n'), '\\tx a\n\\gl b\n', 'CRLF becomes LF');
  eq(normalizePastedSfm('\\tx a\r\\gl b'), '\\tx a\n\\gl b', 'bare CR becomes LF');
  eq(normalizePastedSfm('\uFEFF\\tx a'), '\\tx a', 'a BOM is dropped');
  eq(normalizePastedSfm('\\tx a\u00A0b'), '\\tx a b', 'a non-breaking space becomes an ordinary one');
  eq(normalizePastedSfm('\\tx a   b'), '\\tx a   b', 'runs of spaces are LEFT ALONE — they are the alignment');

  ok(looksLikeSfm('\\ref 1.1\n\\tx ana bete'), 'a backslash marker is what makes it SFM');
  ok(!looksLikeSfm('text,translation\nana,he went'), 'a CSV is not SFM');
  ok(!looksLikeSfm(''), 'empty is not SFM');

  // Properly column-aligned: no complaint.
  const good = parseSfm('\\tx ana   bete   kabo\n\\gl 3SG   go     out\n');
  eq(alignmentRisk(good, { baseline: 'tx', gloss: 'gl' }), null, 'aligned columns raise no risk');

  // Single-spaced: there is no geometry to read, so the pairing is a guess.
  const flat = parseSfm('\\tx ana bete kabo\n\\gl 3SG go out\n');
  const r1 = alignmentRisk(flat, { baseline: 'tx', gloss: 'gl' });
  ok(r1 && r1.reason === 'single-spaced', 'a single-spaced gloss line is reported as untrustworthy');

  // Tabs are geometry too.
  const tabbed = parseSfm('\\tx ana\tbete\tkabo\n\\gl 3SG\tgo\tout\n');
  eq(alignmentRisk(tabbed, { baseline: 'tx', gloss: 'gl' }), null, 'tab-separated columns are fine');

  // No glosses mapped: nothing can be mis-paired.
  eq(alignmentRisk(good, { baseline: 'tx' }), null, 'no gloss mapping, no risk');

  // A title for a text that has no filename to fall back on.
  eq(titleFromSfm(parseSfm('\\id GEN Genesis\n\\tx a')), 'GEN Genesis', 'the \\id line names the text');
  eq(titleFromSfm(parseSfm('\\ref 1\n\\tx a'), {}), '', 'nothing to go on returns empty, so the app can ask');
  eq(titleFromSfm(parseSfm('\\id GEN\n\\ti The Real Title\n\\tx a'), { title: 'ti' }), 'The Real Title',
     'an explicitly mapped title marker beats the \\id convention');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASS: the SFM reader holds.\n');
process.exit(fail ? 1 : 0);
