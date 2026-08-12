/* A DELIVERY TOKEN MUST NEVER BECOME A FILENAME.
 *
 * WHY THIS TEST EXISTS: the v336 test drive produced downloads called
 * `bwpX_YzJZRolHdh_.converted-NOT-ARCHIVAL.wav`, `bwpX_YzJZRolHdh_.preview.html` and
 * `bwpX_YzJZRolHdh_.annotations.eaf`. One line of cause: every downloader named its file from the
 * URL's LAST PATH SEGMENT, and an assigned text is delivered privately from `/v1/textfile/<token>`,
 * so the "filename" was the opaque AES-GCM token. Because the STORED media name was then what every
 * export derived its own names from, a single bad name at download time poisoned the derived WAV,
 * the SayMore sidecar and the preview page — and it did so silently, since each of those files is
 * individually well-formed and opens fine. Nothing about the bug is visible until a human reads the
 * folder.
 *
 * Two ends therefore have to hold, and this file pins both:
 *   1. DOWNLOAD — the story title names the stored file; a token URL yields no name at all.
 *   2. EXPORT   — names are derived from the TITLE, never from the stored media name, so a text
 *                 whose audio was stored under a token BEFORE this fix still exports correctly,
 *                 with no migration and no re-download.
 * The second is what makes the fix retroactive; drop it and every already-assigned text in the
 * field stays broken forever while the tests still pass.
 *
 * Also pinned: the EAF's media reference and the WAV entry that ships beside it are computed from
 * the SAME derivation. If only one side were ever "fixed", ELAN would open a bundle whose audio it
 * cannot find — a worse failure than an ugly name, and one this test would catch.
 *
 * Run: node test/media-filenames.test.mjs
 */
import { readFileSync } from 'node:fs';
import {
  sanitizeBase, extOf, nameFromDisposition, nameFromUrl,
  storedMediaName, mediaNameFor, derivedWavName, assembleSegEntries,
} from '../docs/js/seg-exports.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/* The real token shape from the field report — base64url, no extension, nothing about it says
 * "not a filename" except that we know where it came from. */
const TOKEN_URL = 'https://connect.flextext.app/v1/textfile/bwpX_YzJZRolHdh_kQ2vLm9';

console.log('\nnameFromUrl refuses anything that is not plainly a filename');
{
  ok(nameFromUrl(TOKEN_URL) === '', 'the private-delivery route yields NO name (it is a token by construction)');
  ok(nameFromUrl('https://x/v1/textfile/abc.wav') === '',
     'even a token that happens to end in .wav is refused — the ROUTE is the signal, not the shape');
  ok(nameFromUrl('https://example.org/files/Kisah%20Rusa.mp3') === 'Kisah Rusa.mp3',
     'a real URL filename survives, percent-decoded');
  ok(nameFromUrl('https://example.org/files/story.wav?x=1#f') === 'story.wav', 'query and fragment are stripped');
  ok(nameFromUrl('https://example.org/drive?id=1AbC_dEf') === '', 'an extension-less tail is not a filename');
  ok(nameFromUrl('') === '' && nameFromUrl(null) === '', 'empty/null are safe');
  // A malformed escape used to throw out of decodeURIComponent and take the download with it.
  ok(nameFromUrl('https://x/a/b%E0%A4%A.wav') === 'b%E0%A4%A.wav', 'a malformed percent-escape degrades, never throws');
}

console.log('\nnameFromDisposition reads what the server actually stated');
{
  ok(nameFromDisposition('attachment; filename="Kisah Rusa.mp3"') === 'Kisah Rusa.mp3', 'quoted filename');
  ok(nameFromDisposition('attachment; filename=story.wav') === 'story.wav', 'unquoted filename');
  ok(nameFromDisposition("attachment; filename*=UTF-8''Kisah%20Rusa.mp3") === 'Kisah Rusa.mp3',
     'RFC 5987 filename* wins (Drive sends it for non-ASCII names)');
  // A Content-Disposition is REMOTE INPUT. A path in it is how a careless writer escapes its folder.
  ok(nameFromDisposition('attachment; filename="../../etc/passwd"') === 'passwd', 'any path is stripped');
  ok(nameFromDisposition('') === '' && nameFromDisposition(null) === '', 'empty/null are safe');
}

console.log('\nstoredMediaName: the STORY TITLE names the file');
{
  ok(storedMediaName({ title: 'Kisah Rusa', url: TOKEN_URL, mime: 'audio/mpeg' }) === 'Kisah Rusa.mp3',
     'THE BUG: a token URL + a title gives "Kisah Rusa.mp3", never the token');
  ok(!storedMediaName({ title: 'Kisah Rusa', url: TOKEN_URL, mime: 'audio/mpeg' }).includes('bwpX'),
     'the token appears nowhere in the result');
  ok(storedMediaName({ title: 'Kisah Rusa', name: 'server-said.flac', url: TOKEN_URL }) === 'Kisah Rusa.flac',
     'the title wins the BASE while a stated filename supplies the EXTENSION');
  ok(storedMediaName({ name: 'server-said.flac', url: TOKEN_URL }) === 'server-said.flac',
     'no title -> the stated filename');
  ok(storedMediaName({ disposition: 'attachment; filename="cd.ogg"', url: TOKEN_URL }) === 'cd.ogg',
     'no title, no stated name -> Content-Disposition');
  ok(storedMediaName({ url: 'https://x/real/story.wav' }) === 'story.wav', 'then, and only then, the URL tail');
  ok(storedMediaName({ url: TOKEN_URL }) === 'audio', 'nothing at all -> "audio", still never the token');
  ok(storedMediaName({ title: 'a/b:c*d?e"f<g>h|i' }) === 'a_b_c_d_e_f_g_h_i', 'the title is sanitised for the filesystem');
  ok(storedMediaName({ title: 'x'.repeat(200), mime: 'audio/wav' }) === 'x'.repeat(120) + '.wav',
     'and capped at 120 — the same cap as the worker Drive folder, so file and folder agree');
  ok(storedMediaName() === 'audio', 'no arguments at all is safe');
}

console.log('\nextOf / sanitizeBase');
{
  ok(extOf('a.MP3', '') === '.mp3', 'an existing extension is lowercased');
  ok(extOf('', 'audio/x-wav') === '.wav' && extOf('', 'audio/mp4') === '.m4a', 'mime fallback');
  ok(extOf('', 'audio/wav; codecs=1') === '.wav', 'mime parameters are ignored');
  ok(extOf('no-extension-here', 'application/octet-stream') === '',
     'unknown mime + no extension -> no extension (better than a wrong one)');
  ok(sanitizeBase('  spaced  ') === 'spaced', 'trimmed');
  ok(sanitizeBase(null) === '', 'null -> empty, so callers can apply their own fallback');
}

console.log('\nexport names derive from the TITLE — which is what makes the fix RETROACTIVE');
{
  // The pre-fix stored state: the media name IS the token. This is what is sitting in IndexedDB on
  // every device that was assigned a text before v3, and it must not reach a single exported name.
  const poisoned = { name: 'bwpX_YzJZRolHdh_kQ2vLm9', mimeType: 'audio/mpeg' };
  ok(mediaNameFor('Kisah Rusa', poisoned) === 'Kisah Rusa.mp3',
     'a token-named original still exports as "Kisah Rusa.mp3"');
  ok(derivedWavName('Kisah Rusa') === 'Kisah Rusa.converted-NOT-ARCHIVAL.wav',
     'the derived copy is title-named AND still says it is converted (Seth\'s honesty rule)');
  ok(mediaNameFor('', poisoned) === 'audio.mp3', 'no title -> a safe generic, still never the token');
}

console.log('\nassembleSegEntries: every emitted name is clean, and the EAF can find its audio');
{
  const doc = {
    title: 'Kisah Rusa', vernLang: 'fau', analLang: 'id',
    segments: [{ start: 0, end: 2 }],
    paragraphs: [{ segments: [{ words: [{ text: 'ani', gloss: 'dog' }], free: 'a dog' }] }],
  };
  // A REAL minimal RIFF/WAVE — wavWithBext only stamps a buffer that actually starts 'RIFF',
  // so a bag of zero bytes would silently skip the provenance assertion below.
  const wav = new Blob([(() => {
    const n = 4, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
    const w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true);
    v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    return new Uint8Array(b);
  })()], { type: 'audio/wav' });
  // Both records carry the POISONED pre-fix name — the whole point is that it never gets out.
  const media = { name: 'bwpX_YzJZRolHdh_kQ2vLm9', mimeType: 'audio/mpeg', blob: wav };
  const segMedia = { name: 'bwpX_YzJZRolHdh_kQ2vLm9.converted-NOT-ARCHIVAL.wav', mimeType: 'audio/wav',
                     blob: wav, derived: true, srcName: 'bwpX_YzJZRolHdh_kQ2vLm9' };

  const entries = await assembleSegEntries({
    doc, title: 'Kisah Rusa', base: 'Kisah Rusa', media, segMedia,
    wants: { eaf: true, saymore: true, preview: true, fxpa: true }, vern: 'fau', anal: 'id', full: true,
  });
  const names = entries.map((e) => e.name);
  ok(!names.some((n) => n.includes('bwpX')), 'NO exported entry carries the token: ' + names.join(', '));
  ok(names.includes('Kisah Rusa.converted-NOT-ARCHIVAL.wav'), 'the derived WAV is title-named');
  ok(names.includes('Kisah Rusa.converted-NOT-ARCHIVAL.wav.annotations.eaf'), 'the SayMore sidecar follows the WAV name');
  ok(names.includes('Kisah Rusa.preview.html'), 'the preview page is title-named (it was the loudest symptom)');
  ok(names.includes('Kisah Rusa.eaf') && names.includes('Kisah Rusa.pfsx'), 'ELAN pair unchanged');

  /* THE CONSISTENCY THAT MATTERS MORE THAN THE NAME: the EAF points at the media by name, so the
   * reference and the entry beside it must be the same string. Fixing one side only would give a
   * tidy-looking bundle that ELAN cannot open. */
  const eaf = await entries.find((e) => e.name === 'Kisah Rusa.eaf').data.text();
  const ref = /MEDIA_URL="([^"]*)"|RELATIVE_MEDIA_URL="([^"]*)"/.exec(eaf);
  const referenced = (ref && (ref[1] || ref[2]) || '').split('/').pop();
  ok(referenced === 'Kisah Rusa.converted-NOT-ARCHIVAL.wav',
     `the EAF references the WAV that actually ships (${referenced})`);
  ok(names.includes(referenced), 'and that exact name is an entry in the bundle');

  // The bext chunk must still name the REAL source file — the honesty rule is about provenance,
  // and renaming for tidiness must not launder where the bytes came from.
  const stamped = new Uint8Array(await entries.find((e) => e.name.endsWith('.converted-NOT-ARCHIVAL.wav')).data.arrayBuffer());
  ok(new TextDecoder('latin1').decode(stamped).includes('bwpX_YzJZRolHdh_kQ2vLm9'),
     'the bext provenance still names the actual source file, token name and all');
}

console.log('\nthe wiring is in place at BOTH ends (source assertions — these need a browser to run)');
{
  const audio = read('../docs/js/audio.js');
  const app = read('../docs/js/app.js');
  const panel = read('../docs/js/researcher-panel.js');

  // The exact expressions the bug was made of. Their reappearance is the regression.
  ok(!/split\('\/'\)\.pop\(\)/.test(audio),
     "audio.js no longer names ANY file from the URL's last path segment");
  ok(/_complete\(blob, observedName, mimeType\)/.test(audio) && /storedMediaName\(\{ title: this\.title/.test(audio),
     'every download completion routes through the one naming chokepoint');
  ok(/new AudioDownload\(rec\.id, url, onState, rec\.title/.test(audio),
     'downloadAudioForDoc passes the story title in — without it the chokepoint has nothing to prefer');
  ok(/nameFromDisposition\(resp\.headers\.get\('content-disposition'\)/.test(audio),
     'Content-Disposition is read as the second-choice source');

  ok(!/function sanitizeBase\(title\) \{/.test(app) && /sanitizeBase/.test(app),
     'app.js uses the shared sanitizeBase rather than a second copy of it');
  ok(/segMediaName = segMedia\.derived \? derivedWavName\(base\) : mediaNameFor\(base, segMedia\)/.test(app),
     'buildBundleFor derives the media name from the title base, not from media.name');
  ok(/entries\.push\(\{ name: mediaNameFor\(base, media\), data: media\.blob \}\)/.test(app),
     'the audio zip entry uses the SAME derivation as the EAF reference');
  ok(/derivedWavName\(sanitizeBase\(title\)/.test(app),
     'the segwav working copy is title-named at creation too, so stored state is clean as well');

  ok(/segMedia = \{ name: derivedWavName\(base\)/.test(panel),
     "the panel's own conversion names the derived WAV from the title");
  ok(/media = \{ name: mediaNameFor\(base, \{ name: af\.name/.test(panel),
     'and names the original from the title, so panel downloads match device bundles');
  ok(/srcName: af\.name/.test(panel), 'while srcName still records the real source file for the bext chunk');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
