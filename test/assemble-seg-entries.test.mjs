/* assembleSegEntries — the ONE bundle-entry assembler (assign-by-upload, 2026-08-11).
 *
 * WHY THIS IS WORTH A TEST: the panel's Downloads conversions and the device's buildBundleFor
 * both feed from this function. If they drift apart — an entry renamed, a gate changed, the
 * upload/full split broken — the researcher's download stops matching what devices upload, and
 * nobody notices because each side still "works". This pins: entry coverage per `wants`
 * combination, upload-vs-full parity of the shared entries, and (source-lift) that buildBundleFor
 * actually calls the shared function instead of quietly growing its own copy back.
 *
 * Run: node test/assemble-seg-entries.test.mjs
 */
import { readFileSync } from 'node:fs';
import { assembleSegEntries, blobToBase64 } from '../docs/js/seg-exports.js';
import { makeDoc, reconcileBaseline } from '../docs/js/flextext.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const names = (es) => es.map((e) => e.name);
const text = async (es, name) => {
  const e = es.find((x) => x.name === name);
  return e ? await e.data.text() : null;
};

/* A doc in segmentation shape: aligned spans + glosses (same fixture family as seg-exports.test). */
function segDoc() {
  const doc = makeDoc({ vernLang: 'fau', analLang: 'id' });
  reconcileBaseline(doc, ['satu dua', 'tiga empat'], { flatSegments: true });
  doc.paragraphs[0].segments[0].free = 'one two';
  doc.segments = [{ start: 0, end: 2000 }, { start: 2000, end: 4000 }];
  return doc;
}

/* Minimal valid WAV bytes so wavWithBext has a real RIFF header to splice into. */
function wavBytes() {
  const n = 4, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true);
  v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  return buf;
}

const media = { name: 'story.m4a', mimeType: 'audio/mp4', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' }) };
const derivedWav = { name: 'story.converted-NOT-ARCHIVAL.wav', mimeType: 'audio/wav',
  blob: new Blob([wavBytes()], { type: 'audio/wav' }), derived: true, srcName: 'story.m4a' };
const args = (over = {}) => ({
  doc: segDoc(), title: 'Kisah', base: 'Kisah', media, segMedia: derivedWav,
  wants: { eaf: true, saymore: true, preview: true, fxpa: true }, vern: 'fau', anal: 'id', ...over,
});

console.log('\nfull (local-save) bundle: every selected entry, in bundle order');
{
  const es = await assembleSegEntries(args({ full: true }));
  ok(names(es).join('|') === [
    'Kisah.eaf', 'Kisah.pfsx', 'story.converted-NOT-ARCHIVAL.wav.annotations.eaf',
    'story.converted-NOT-ARCHIVAL.wav', 'story.preview.html', 'HOW-TO-OPEN.txt', 'Kisah.fxpa',
  ].join('|'), `full bundle entry set + order (got: ${names(es).join(', ')})`);
  const wav = es.find((e) => e.name === 'story.converted-NOT-ARCHIVAL.wav');
  const wavTxt = new TextDecoder('latin1').decode(new Uint8Array(await wav.data.arrayBuffer()));
  ok(wavTxt.includes('bext') && wavTxt.includes('NOT an archival master'), 'derived WAV carries the bext provenance chunk');
  ok(wavTxt.includes('A=MP4'), 'CodingHistory names the ORIGINAL (lossy) mime, not the WAV copy');
  const howto = await text(es, 'HOW-TO-OPEN.txt');
  ok(howto.includes('story.preview.html') && howto.includes('Kisah.fxpa'), 'HOW-TO-OPEN documents the full-only entries');
  const fxpa = JSON.parse(await text(es, 'Kisah.fxpa'));
  ok(fxpa.audio && fxpa.audio.b64 === await blobToBase64(derivedWav.blob), 'fxpa embeds the working audio');
  ok(fxpa.vernLang === 'fau' && fxpa.analLang === 'id', 'fxpa carries the passed language codes');
}

console.log('\nupload bundle (full:false): preview + fxpa NEVER ride — bandwidth rule');
{
  const esFull = await assembleSegEntries(args({ full: true }));
  const es = await assembleSegEntries(args({ full: false }));
  ok(!names(es).some((n) => n.endsWith('.preview.html')), 'no preview page in an upload');
  ok(!names(es).some((n) => n.endsWith('.fxpa')), 'no fxpa in an upload');
  ok(names(es).includes('Kisah.eaf') && names(es).includes('story.converted-NOT-ARCHIVAL.wav.annotations.eaf'),
     'EAFs (small text) still ride uploads');
  // Parity: the entries BOTH bundles carry must be identical — the researcher's Drive copy opens
  // in ELAN exactly like the local save. (The EAF header's DATE is the serialization instant, the
  // one legitimate difference — normalized out.)
  const noDate = (s) => String(s).replace(/DATE="[^"]*"/, 'DATE=""');
  for (const n of ['Kisah.eaf', 'Kisah.pfsx', 'story.converted-NOT-ARCHIVAL.wav.annotations.eaf']) {
    ok(noDate(await text(es, n)) === noDate(await text(esFull, n)), `upload-vs-full parity: ${n}`);
  }
  const howto = await text(es, 'HOW-TO-OPEN.txt');
  ok(!howto.includes('.preview.html') && !howto.includes('.fxpa'), 'HOW-TO-OPEN never documents files not in THIS bundle');
}

console.log('\nwants combinations gate the entries');
{
  const eafOnly = await assembleSegEntries(args({ full: true, wants: { eaf: true } }));
  ok(names(eafOnly).join('|') === 'Kisah.eaf|Kisah.pfsx|story.converted-NOT-ARCHIVAL.wav|HOW-TO-OPEN.txt',
     'eaf alone: eaf + pfsx sidecar + derived WAV + instructions');
  const smOnly = await assembleSegEntries(args({ full: true, wants: { saymore: true } }));
  ok(names(smOnly).join('|') === 'story.converted-NOT-ARCHIVAL.wav.annotations.eaf|story.converted-NOT-ARCHIVAL.wav|HOW-TO-OPEN.txt',
     'saymore alone: annotations.eaf + derived WAV + instructions');
  const none = await assembleSegEntries(args({ full: true, wants: {} }));
  ok(none.length === 0, 'nothing selected -> no entries');
  const nonDerived = await assembleSegEntries(args({ full: true, wants: { eaf: true }, segMedia: { ...derivedWav, derived: false } }));
  ok(!names(nonDerived).includes('story.converted-NOT-ARCHIVAL.wav'), 'a non-derived working copy is never bundled (the original rides separately)');
}

console.log('\nno alignment (segMedia null): text-only fxpa is first-class, annotations are not');
{
  const es = await assembleSegEntries(args({ full: true, segMedia: null }));
  ok(names(es).join('|') === 'Kisah.fxpa', 'only the fxpa survives without an aligned timeline');
  const fxpa = JSON.parse(await text(es, 'Kisah.fxpa'));
  ok(!fxpa.audio, 'and it embeds no audio');
  const up = await assembleSegEntries(args({ full: false, segMedia: null }));
  ok(up.length === 0, 'an upload with no alignment carries no seg entries at all');
}

console.log('\nsource-lift: buildBundleFor really calls the shared assembler');
{
  const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  const fn = app.match(/async function buildBundleFor\(([\s\S]*?)\n\}/);
  ok(!!fn, 'buildBundleFor present in app.js');
  ok(!!fn && /await assembleSegEntries\(\{/.test(fn[0]), 'buildBundleFor awaits assembleSegEntries');
  ok(!!fn && !/serializeEaf\(/.test(fn[0]), 'buildBundleFor no longer serializes EAFs itself');
  ok(/import \{[^}]*assembleSegEntries[^}]*\} from '\.\/seg-exports\.js'/.test(app), 'imported from seg-exports.js');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
