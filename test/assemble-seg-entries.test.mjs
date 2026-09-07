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
/* ⚠ The record's own `name` is deliberately the OLD media-derived one. v3 names every exported
 * entry from the TITLE base instead, so this stale value must never appear in the output — that is
 * how a text assigned before the fix exports correctly without a migration. See
 * test/media-filenames.test.mjs for the rule itself. */
const derivedWav = { name: 'Kisah.converted-NOT-ARCHIVAL.wav', mimeType: 'audio/wav',
  blob: new Blob([wavBytes()], { type: 'audio/wav' }), derived: true, srcName: 'story.m4a' };
const args = (over = {}) => ({
  doc: segDoc(), title: 'Kisah', base: 'Kisah', media, segMedia: derivedWav,
  wants: { eaf: true, saymore: true, preview: true, fxpa: true }, vern: 'fau', anal: 'id', ...over,
});

console.log('\nfull (local-save) bundle: every selected entry, in bundle order');
{
  const es = await assembleSegEntries(args({ full: true }));
  ok(names(es).join('|') === [
    'Kisah.eaf', 'Kisah.pfsx', 'Kisah.converted-NOT-ARCHIVAL.wav.annotations.eaf',
    'Kisah.converted-NOT-ARCHIVAL.wav', 'Kisah.preview.html', 'HOW-TO-OPEN.txt', 'Kisah.fxpa',
  ].join('|'), `full bundle entry set + order (got: ${names(es).join(', ')})`);
  const wav = es.find((e) => e.name === 'Kisah.converted-NOT-ARCHIVAL.wav');
  const wavTxt = new TextDecoder('latin1').decode(new Uint8Array(await wav.data.arrayBuffer()));
  ok(wavTxt.includes('bext') && wavTxt.includes('NOT an archival master'), 'derived WAV carries the bext provenance chunk');
  ok(wavTxt.includes('A=MP4'), 'CodingHistory names the ORIGINAL (lossy) mime, not the WAV copy');
  const howto = await text(es, 'HOW-TO-OPEN.txt');
  ok(howto.includes('Kisah.preview.html') && howto.includes('Kisah.fxpa'), 'HOW-TO-OPEN documents the full-only entries');
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
  ok(names(es).includes('Kisah.eaf') && names(es).includes('Kisah.converted-NOT-ARCHIVAL.wav.annotations.eaf'),
     'EAFs (small text) still ride uploads');
  // Parity: the entries BOTH bundles carry must be identical — the researcher's Drive copy opens
  // in ELAN exactly like the local save. (The EAF header's DATE is the serialization instant, the
  // one legitimate difference — normalized out.)
  const noDate = (s) => String(s).replace(/DATE="[^"]*"/, 'DATE=""');
  for (const n of ['Kisah.eaf', 'Kisah.pfsx', 'Kisah.converted-NOT-ARCHIVAL.wav.annotations.eaf']) {
    ok(noDate(await text(es, n)) === noDate(await text(esFull, n)), `upload-vs-full parity: ${n}`);
  }
  const howto = await text(es, 'HOW-TO-OPEN.txt');
  ok(!howto.includes('.preview.html') && !howto.includes('.fxpa'), 'HOW-TO-OPEN never documents files not in THIS bundle');
}

console.log('\nwants combinations gate the entries');
{
  const eafOnly = await assembleSegEntries(args({ full: true, wants: { eaf: true } }));
  ok(names(eafOnly).join('|') === 'Kisah.eaf|Kisah.pfsx|Kisah.converted-NOT-ARCHIVAL.wav|HOW-TO-OPEN.txt',
     'eaf alone: eaf + pfsx sidecar + derived WAV + instructions');
  const smOnly = await assembleSegEntries(args({ full: true, wants: { saymore: true } }));
  ok(names(smOnly).join('|') === 'Kisah.converted-NOT-ARCHIVAL.wav.annotations.eaf|Kisah.converted-NOT-ARCHIVAL.wav|HOW-TO-OPEN.txt',
     'saymore alone: annotations.eaf + derived WAV + instructions');
  const none = await assembleSegEntries(args({ full: true, wants: {} }));
  ok(none.length === 0, 'nothing selected -> no entries');
  const nonDerived = await assembleSegEntries(args({ full: true, wants: { eaf: true }, segMedia: { ...derivedWav, derived: false } }));
  ok(!names(nonDerived).includes('Kisah.converted-NOT-ARCHIVAL.wav'), 'a non-derived working copy is never bundled (the original rides separately)');
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

/* ⚠ THE LADDER, IN ONE PASS. conversionCaps answers `fxpa` and `fxpaAudio` separately because they
 * degrade differently — ".fxpa never refuses — above the ceiling it is built WITHOUT audio, and says
 * so". A caller can always get that by nulling segMedia (the panel's mechanism for its one-output
 * menu rows), but a bundle that ALSO wants the EAFs cannot: they need the recording, which is why
 * the panel's Download-all runs a second pass. `wants.fxpaAudio: false` is that split in one call.
 * The device's buildBundleFor gated the whole FILE on the audio flag instead, so the segmenter's
 * ".fxpa only" on an oversized recording produced nothing while the panel's row on the same
 * document handed over a text-only .fxpa (v615 review, 2026-09-07). */
console.log('\nwants.fxpaAudio:false — the .fxpa loses its audio, the EAFs keep theirs');
{
  const es = await assembleSegEntries(args({ full: true, wants: { eaf: true, saymore: true, fxpa: true, fxpaAudio: false } }));
  ok(names(es).includes('Kisah.fxpa'), 'the .fxpa is still built — the ladder never refuses it');
  const fxpa = JSON.parse(await text(es, 'Kisah.fxpa'));
  ok(!fxpa.audio, 'and it carries no audio block (not an empty one)');
  ok(fxpa.lines.length === 2 && fxpa.vernLang === 'fau', 'the text, times and languages are all there');
  ok(names(es).includes('Kisah.eaf') && names(es).includes('Kisah.converted-NOT-ARCHIVAL.wav'),
     'the EAFs and their WAV are untouched — one segMedia, two different needs');
  ok(/RELATIVE_MEDIA_URL="\.\/Kisah\.converted-NOT-ARCHIVAL\.wav"/.test(await text(es, 'Kisah.eaf')),
     'the EAF still points at the recording it was timed against');
  // …and the instructions in the same zip must not promise a recording that is not in the file.
  const howto = await text(es, 'HOW-TO-OPEN.txt');
  ok(!howto.includes('Text and audio are inside the file') && /TEXT\n\s+and its timings only/.test(howto),
     'HOW-TO-OPEN says the .fxpa is text-only, and where the recording is instead');
  const on = await assembleSegEntries(args({ full: true, wants: { fxpa: true } }));
  ok(!!JSON.parse(await text(on, 'Kisah.fxpa')).audio, 'unset ⇒ embed: every existing caller is unchanged');
  const explicit = await assembleSegEntries(args({ full: true, wants: { fxpa: true, fxpaAudio: true } }));
  ok(!!JSON.parse(await text(explicit, 'Kisah.fxpa')).audio, 'and true means true');
  // A 0-byte working copy is not audio either — the same question previewBlob/fxpaBlob now ask.
  const emptyWav = await assembleSegEntries(args({ full: true, wants: { fxpa: true },
    segMedia: { ...derivedWav, blob: new Blob([]) } }));
  ok(!JSON.parse(await text(emptyWav, 'Kisah.fxpa')).audio, 'an EMPTY recording embeds nothing, rather than b64: ""');
}

console.log('\nsource-lift: buildBundleFor really calls the shared assembler');
{
  const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  const fn = app.match(/async function buildBundleFor\(([\s\S]*?)\n\}/);
  ok(!!fn, 'buildBundleFor present in app.js');
  ok(!!fn && /await assembleSegEntries\(\{/.test(fn[0]), 'buildBundleFor awaits assembleSegEntries');
  ok(!!fn && !/serializeEaf\(/.test(fn[0]), 'buildBundleFor no longer serializes EAFs itself');
  ok(/import \{[^}]*assembleSegEntries[^}]*\} from '\.\/seg-exports\.js'/.test(app), 'imported from seg-exports.js');
  const body = fn ? fn[0] : '';

  /* The device side of the ladder above: the FILE is wanted or not, the AUDIO is capped. Gating the
   * file on caps.fxpaAudio is what made the segmenter and the panel disagree. */
  ok(!/wantJson = \([^\n]*\) && caps\.fxpaAudio/.test(body), 'the .fxpa is not size-gated as a whole');
  ok(/const wantJson = w\.fxpa \?\? settings\.exportJson \?\? expDefault;/.test(body), 'the want is just the want');
  ok(/fxpa: wantJson, fxpaAudio: caps\.fxpaAudio/.test(body), 'and the cap rides as the degrade switch');
  ok(/trimmed\.push\('fxpaAudio'\)/.test(body) && !/trimmed\.push\('fxpa'\)/.test(body),
     "what was trimmed is the AUDIO, and `trimmed` says so — the file is in the bundle either way");
  const ex = app.slice(app.indexOf('async function satExport(id)'), app.indexOf('function satImportBar('));
  ok(/sat\.exportFxpaNoAudio/.test(ex), 'and the segmenter SAYS it, the way the panel says panel.dl.fxpaNoAudio');
  const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  ok(/const dropAudio = kind === 'fxpa' && !src\.caps\.fxpaAudio;/.test(panel),
     'the panel still degrades the same document the same way (the two surfaces must agree)');

  /* ⚠ NO ARCHIVE NOBODY READS (the v615 review, 2026-09-07). buildBundleFor awaited makeZip on
   * every full
   * bundle, including the four satExport choices that keep ONE entry and drop the rest. Measured
   * under node — a 100 MB WAV, "Listening page only": the 133.4 MB page the user asked for at RSS
   * 627 MB, then a 233.4 MB archive thrown away unread, RSS 1078 MB. makeZip materialises every
   * entry (`new Uint8Array(await entry.data.arrayBuffer())`) and CRC32s it byte by byte in JS. */
  ok(!/const blob = await makeZip\(entries\)/.test(body), 'the full path no longer packs eagerly');
  ok(/const zip = \(\) => \(packed \?\?= makeZip\(entries\)\);/.test(body),
     'it hands back a memoised zip() instead — asked for once, built once');
  ok(/return \{ zip, filename: `\$\{base\}\$\{stamp\}\.zip`/.test(body), 'and the entries beside it');
  const single = ex.slice(ex.indexOf('let blob = null'), ex.indexOf('} else {'));
  ok(!/bundle\.zip\(/.test(single), 'none of the single-file choices asks for an archive');
  ok((ex.match(/await bundle\.zip\(\)/g) || []).length === 1 && /"Everything"/.test(ex),
     'exactly one does: "Everything", which IS the zip');
  const share = app.slice(app.indexOf('async function openShareMenu()'), app.indexOf("$('#share-cancel').onclick"));
  ok(/const bundleBlob = async \(\) => \(bundle\.zipped \? await bundle\.zip\(\) : bundle\.blob\);/.test(share)
     && (share.match(/await bundleBlob\(\)/g) || []).length === 2,
     'and the share menu builds it where it WRITES the file, not on the way in');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
