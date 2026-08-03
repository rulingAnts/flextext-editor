/* Segmentation export formats: EAF (both profiles), flextext timestamps, preview page, bext.
 * Pure-module tests — seg-exports.js and flextext.js must run under plain node (the format-module
 * rule); any DOM dependency creeping in fails here first. */
import { serializeEaf, buildSegPreviewHtml, wavWithBext, fmtClock } from '../docs/js/seg-exports.js';
import { serializeFlextext, reconcileBaseline, makeDoc, segmentsFromOffsets } from '../docs/js/flextext.js';

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok    ' : '  FAIL  ') + msg); if (!cond) failures++; };

/* A doc in segmentation shape: 3 lines, middle one BLANK (a timed silence), plus glosses and
 * free translations. Segments: aligned, aligned, ESTIMATED, plus we test pending separately. */
function segDoc() {
  const doc = makeDoc({ vernLang: 'fau', analLang: 'id' });
  reconcileBaseline(doc, ['satu dua', '', 'tiga <empat>'], { flatSegments: true });
  const [p1, , p3] = doc.paragraphs;
  p1.segments[0].words.forEach((w, i) => { if (!w.punct) w.gls = 'G' + i; });
  p1.segments[0].free = 'one two';
  p3.segments[0].free = 'three & four';
  doc.segments = [
    { start: 0, end: 2000 },
    { start: 2000, end: 4000 },
    { start: 4000, end: 6000, timeEstimated: true },
  ];
  return doc;
}

console.log('EAF — FLEx profile');
{
  const doc = segDoc();
  doc.title = 'Kisah Kasuari';
  const eaf = serializeEaf(doc, { profile: 'flex', vern: 'fau', anal: 'id', mediaName: 'story.wav' });
  ok(!/segnum/i.test(eaf), 'NO segnum anywhere in the EAF (Seth, 2026-08-03)');
  // Structural hierarchy (Seth, 2026-08-03): interlinear-text > paragraph > phrase, with the
  // paragraph tier mirroring the phrase tier exactly — mergeable in ELAN, never needs splitting.
  ok(eaf.includes('TIER_ID="A_interlinear-text-title-id"'), 'interlinear-text tier present');
  const itextTier = eaf.slice(eaf.indexOf('TIER_ID="A_interlinear-text-title-id"'), eaf.indexOf('TIER_ID="A_paragraph"'));
  ok(itextTier.includes('<ANNOTATION_VALUE>Kisah Kasuari</ANNOTATION_VALUE>'), 'interlinear-text annotation carries the title');
  ok((itextTier.match(/<ALIGNABLE_ANNOTATION /g) || []).length === 1, 'exactly one interlinear-text annotation spanning the text');
  const paraTier = eaf.slice(eaf.indexOf('TIER_ID="A_paragraph"'), eaf.indexOf('TIER_ID="A_phrase-txt-fau"'));
  ok((paraTier.match(/<ALIGNABLE_ANNOTATION /g) || []).length === 3, 'paragraph tier mirrors the phrase tier 1:1 (3 annotations)');
  const phraseTs = [...eaf.slice(eaf.indexOf('TIER_ID="A_phrase-txt-fau"')).matchAll(/TIME_SLOT_REF1="(ts\d+)" TIME_SLOT_REF2="(ts\d+)"/g)].slice(0, 3).map((m) => m[1] + '/' + m[2]);
  const paraTs = [...paraTier.matchAll(/TIME_SLOT_REF1="(ts\d+)" TIME_SLOT_REF2="(ts\d+)"/g)].map((m) => m[1] + '/' + m[2]);
  ok(JSON.stringify(paraTs) === JSON.stringify(phraseTs), 'paragraph annotations SHARE the phrase time slots');
  ok(eaf.includes('PARENT_REF="A_interlinear-text-title-id" TIER_ID="A_paragraph"'), 'paragraph is a child of interlinear-text');
  ok(eaf.includes('PARENT_REF="A_paragraph" TIER_ID="A_phrase-txt-fau"'), 'phrase is a child of paragraph');
  ok(eaf.includes('LINGUISTIC_TYPE_ID="paragraph" TIME_ALIGNABLE="true"') && eaf.includes('CONSTRAINTS="Included_In"'), 'structural types are Included_In (gaps + pending tolerated)');
  ok(eaf.includes('TIER_ID="A_phrase-txt-fau"'), 'baseline tier named A_phrase-txt-<vern>');
  ok(eaf.includes('TIER_ID="A_phrase-gls-id"'), 'free-translation tier named A_phrase-gls-<anal>');
  ok(eaf.includes('TIER_ID="A_word-txt-fau"') && eaf.includes('TIER_ID="A_word-gls-id"'), 'word + word-gloss tiers present');
  ok(eaf.includes('RELATIVE_MEDIA_URL="./story.wav"'), 'RELATIVE_MEDIA_URL beside the media (no relinking dialog)');
  // Contiguous segments share the joint TIME_SLOT: boundaries 0,2000,4000,6000 → exactly 4 slots.
  const slots = [...eaf.matchAll(/<TIME_SLOT /g)].length;
  ok(slots === 4, `contiguous boundaries share slots (4 slots for 3 segments, got ${slots})`);
  ok(eaf.includes('<ANNOTATION_VALUE></ANNOTATION_VALUE>'), 'blank line exports as an EMPTY aligned annotation');
  ok(eaf.includes('&lt;empat&gt;') && eaf.includes('three &amp; four'), 'XML escaping in values');
  ok(eaf.includes('PREVIOUS_ANNOTATION='), 'word subdivision children are chained in order');
  ok(eaf.includes('STEREOTYPE="Symbolic_Subdivision"') && eaf.includes('STEREOTYPE="Symbolic_Association"'),
     'standard CONSTRAINT declarations present (ELAN recognises stereotypes BY NAME)');
}

console.log('EAF — SayMore profile + pending segments');
{
  const doc = segDoc();
  doc.segments[2] = { timePending: true };   // last line loses its time
  const eaf = serializeEaf(doc, { profile: 'saymore', vern: 'fau', anal: 'id', mediaName: 'story.wav' });
  ok(eaf.includes('TIER_ID="Transcription"'), 'SayMore requires the literal Transcription tier name');
  ok(eaf.includes('TIER_ID="Free Translation"'), 'SayMore requires the literal Free Translation tier name');
  ok(!eaf.includes('A_phrase-txt'), 'FLEx phrase tier name absent from the SayMore profile');
  // SIL's SayMore docs: extra tiers are ignored and adding any is advised against — so the
  // SayMore file carries ONLY its two documented tiers (Seth, 2026-08-03).
  ok(!eaf.includes('A_word-txt') && !eaf.includes('A_word-gls'), 'word/gloss tiers deliberately absent from SayMore profile');
  ok(!eaf.includes('A_paragraph') && !eaf.includes('A_interlinear-text'), 'structural tiers absent from SayMore profile');
  ok((eaf.match(/<TIER /g) || []).length === 2, 'SayMore file has exactly two tiers');
  const bare = [...eaf.matchAll(/<TIME_SLOT TIME_SLOT_ID="[^"]+"\/>/g)].length;
  ok(bare === 2, `pending segment gets value-less TIME_SLOTs (ELAN's unaligned mechanism), got ${bare}`);
}

console.log('flextext — timestamps in notes + native offsets, never the baseline');
{
  const doc = segDoc();
  const xml = serializeFlextext(doc, { vernLang: 'fau', analLang: 'id' }, { mediaName: 'story.wav' });
  ok(xml.includes('begin-time-offset="0" end-time-offset="2000"'), 'native phrase offsets emitted (ms)');
  ok(xml.includes('<item type="note" lang="id">audio 0:00.000–0:02.000</item>'), 'note item carries the timestamps');
  ok(xml.includes('audio ~0:04.000–0:06.000'), "estimated boundary marked with '~' in the note");
  ok(xml.includes('<media-files') && /media guid="[^"]+" location="story\.wav"/.test(xml), 'media-files block references the audio');
  const baselineLine = xml.split('\n').find((l) => l.includes('type="txt"') && l.includes('satu'));
  ok(baselineLine && !/audio \d/.test(baselineLine), 'timestamps NEVER touch the baseline text');
  // Round-trip dedupe: a doc whose phrases already carry offsets + our note must not double them.
  const doc2 = segDoc();
  doc2.paragraphs[0].segments[0].attrs = { 'begin-time-offset': '999', 'end-time-offset': '1999' };
  doc2.paragraphs[0].segments[0].postItemsXML = ['<item type="note" lang="id">audio 0:00.999–0:01.999</item>'];
  const xml2 = serializeFlextext(doc2, { vernLang: 'fau', analLang: 'id' }, { mediaName: 'story.wav' });
  const firstPhrase = xml2.slice(xml2.indexOf('<phrase'), xml2.indexOf('</phrase>'));
  ok((firstPhrase.match(/begin-time-offset=/g) || []).length === 1, 'stale imported offsets are replaced, not duplicated');
  ok((firstPhrase.match(/type="note"[^>]*>audio /g) || []).length === 1, 'stale imported timestamp note is replaced, not duplicated');
  // Pending: no offsets, no note.
  const doc3 = segDoc();
  doc3.segments = [{ timePending: true }, { timePending: true }, { timePending: true }];
  const xml3 = serializeFlextext(doc3, { vernLang: 'fau', analLang: 'id' });
  ok(!xml3.includes('begin-time-offset') && !xml3.includes('>audio '), 'all-pending doc emits no offsets and no notes');
}

console.log('flextext IMPORT — segmentsFromOffsets (flextext as THE segmentation format, no sidecar)');
{
  const doc = segDoc();
  delete doc.segments;   // simulate an import: offsets in phrase attrs, no app spans yet
  doc.paragraphs[0].segments[0].attrs = { guid: 'g1', 'begin-time-offset': '0', 'end-time-offset': '2500' };
  doc.paragraphs[1].segments[0].attrs = { guid: 'g2', 'begin-time-offset': '2500', 'end-time-offset': '4000' };
  const spans = segmentsFromOffsets(doc);   // paragraph 3 has no offsets
  ok(spans && spans.length === 3, 'one span per paragraph');
  ok(spans[0].start === 0 && spans[0].end === 2500 && spans[1].start === 2500, 'spans read from the native attributes');
  ok(spans[2].timePending === true, 'offset-less paragraph comes back timePending');
  const d2 = segDoc();
  const ph = d2.paragraphs[0].segments[0];
  d2.paragraphs[0].segments = [
    { ...ph, attrs: { 'begin-time-offset': '100', 'end-time-offset': '900' } },
    { ...ph, attrs: { 'begin-time-offset': '900', 'end-time-offset': '1800' } },
  ];
  const s2 = segmentsFromOffsets(d2);
  ok(s2[0].start === 100 && s2[0].end === 1800, 'multi-phrase paragraph (merged in ELAN) takes the envelope');
  ok(segmentsFromOffsets(segDoc()) === null, 'doc without offsets → null (no invented times)');
  // The full circle: our own export re-imports to the same spans.
  const d4 = segDoc();
  const xml = serializeFlextext(d4, { vernLang: 'fau', analLang: 'id' });
  const beginVals = [...xml.matchAll(/begin-time-offset="(\d+)"/g)].map((m) => +m[1]);
  ok(JSON.stringify(beginVals) === JSON.stringify([0, 2000, 4000]), 'exported offsets carry the exact span starts back');
}

console.log('preview page');
{
  const html = buildSegPreviewHtml(segDoc(), { title: 'Kisah <A&B>', audioB64: 'QUJD', audioMime: 'audio/wav', mediaName: 'story.wav' });
  ok(html.includes('Kisah &lt;A&amp;B&gt;'), 'title escaped');
  ok(html.includes('"QUJD"'), 'audio base64 embedded');
  ok((html.match(/data-s="/g) || []).length === 3, 'every aligned segment row is playable');
  ok(html.includes('(blank line)'), 'blank line keeps its placeholder row');
  ok(html.includes('~' + fmtClock(4000)), 'estimated time marked with ~');
  ok(!/https?:\/\//.test(html.replace(/xmlns[^"]*"[^"]*"/g, '')), 'fully self-contained (no external URLs)');
}

console.log('bext (derived-WAV provenance in the bytes)');
{
  // Minimal WAV: RIFF + fmt + data with 4 samples.
  const n = 4, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true);
  v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, 1000 * i, true);
  const out = wavWithBext(buf, { description: 'DERIVED - NOT an archival master', codingHistory: 'A=M4A,T=original lossy source x.m4a\nA=PCM,W=16,T=DERIVED' });
  const bytes = new Uint8Array(out), txt = new TextDecoder('latin1').decode(bytes);
  ok(txt.includes('bext'), 'bext chunk present');
  ok(txt.includes('NOT an archival master'), 'description text survives in the bytes');
  ok(txt.includes('A=M4A') && txt.includes('A=PCM'), 'CodingHistory names the lossy origin AND the derivation');
  ok(new DataView(out).getUint32(4, true) === out.byteLength - 8, 'RIFF size updated');
  const dataAt = txt.indexOf('data');
  ok(dataAt > 44 && new DataView(out).getUint32(dataAt + 4, true) === n * 2, 'data chunk intact after the splice');
  ok(new DataView(out).getInt16(dataAt + 8 + 2, true) === 1000, 'sample bytes unchanged');
}

console.log('adversarial audit regressions (2026-08-03)');
{
  // F1: the preview's base64 was spliced in with .replace(marker) — first occurrence wins, so a
  // title containing the literal marker text hijacked the audio slot.
  const doc = segDoc();
  const html = buildSegPreviewHtml(doc, { title: 'weird __AUDIO_B64__ title', audioB64: 'QUJD', audioMime: 'audio/wav' });
  ok(html.includes('var b64 = "QUJD"'), 'F1: marker text in a title cannot hijack the embedded audio');

  // F2: re-exporting an IMPORTED doc must keep its phrases' media-file references (we only filter
  // that attr when minting our own guid).
  const d2 = makeDoc({ vernLang: 'fau', analLang: 'id' });
  reconcileBaseline(d2, ['satu'], { flatSegments: true });
  d2.appAuthored = false;
  d2.mediaXML = ['<media-files><media guid="MG" location="x.wav"/></media-files>'];
  d2.paragraphs[0].segments[0].attrs = { guid: 'g', 'begin-time-offset': '5', 'end-time-offset': '900', 'media-file': 'MG' };
  d2.segments = [{ start: 5, end: 900 }];
  const x2 = serializeFlextext(d2, { vernLang: 'fau', analLang: 'id' });
  ok(/media-file="MG"/.test(x2), 'F2: imported media-file reference survives re-export');
  ok((x2.match(/begin-time-offset=/g) || []).length === 1, 'F2: offsets still not duplicated');

  // F3: malformed/overlapping imported offsets must not smuggle crossing spans into the model
  // (ELAN requires ordered, non-overlapping aligned annotations — a crossed EAF is invalid).
  const d3 = makeDoc({ vernLang: 'fau', analLang: 'id' });
  reconcileBaseline(d3, ['a', 'b'], { flatSegments: true });
  d3.paragraphs[0].segments[0].attrs = { 'begin-time-offset': '0', 'end-time-offset': '3000' };
  d3.paragraphs[1].segments[0].attrs = { 'begin-time-offset': '1000', 'end-time-offset': '2000' };
  const s3 = segmentsFromOffsets(d3);
  ok(s3[1].timePending === true, 'F3: unsalvageable overlapping span demotes to pending, never crosses');

  // F6: a multi-phrase paragraph (merged in ELAN) exports each phrase's OWN offsets, not pending.
  const d6 = makeDoc({ vernLang: 'fau', analLang: 'id' });
  reconcileBaseline(d6, ['satu dua'], { flatSegments: true });
  const ph6 = d6.paragraphs[0].segments[0];
  d6.paragraphs[0].segments = [
    { ...ph6, attrs: { 'begin-time-offset': '0', 'end-time-offset': '400' } },
    { ...ph6, attrs: { 'begin-time-offset': '400', 'end-time-offset': '900' } },
  ];
  d6.segments = [{ start: 0, end: 900 }];
  const e6 = serializeEaf(d6, { profile: 'flex', vern: 'fau', anal: 'id', mediaName: 'x.wav' });
  ok((e6.match(/<TIME_SLOT TIME_SLOT_ID="[^"]+"\/>/g) || []).length === 0,
     'F6: per-phrase offsets export as real times in a multi-phrase paragraph');
}

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nPASS: segmentation export formats behave.');
