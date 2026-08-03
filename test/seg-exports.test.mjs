/* Segmentation export formats: EAF (both profiles), flextext timestamps, preview page, bext.
 * Pure-module tests — seg-exports.js and flextext.js must run under plain node (the format-module
 * rule); any DOM dependency creeping in fails here first. */
import { serializeEaf, buildSegPreviewHtml, wavWithBext, fmtClock } from '../docs/js/seg-exports.js';
import { serializeFlextext, reconcileBaseline, makeDoc } from '../docs/js/flextext.js';

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
  const eaf = serializeEaf(segDoc(), { profile: 'flex', vern: 'fau', anal: 'id', mediaName: 'story.wav' });
  ok(!/segnum/i.test(eaf), 'NO segnum anywhere in the EAF (Seth, 2026-08-03)');
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

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nPASS: segmentation export formats behave.');
