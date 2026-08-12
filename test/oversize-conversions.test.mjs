/* OVERSIZED RECORDINGS DEGRADE PER OUTPUT — they do not refuse wholesale.
 *
 * WHY THIS TEST EXISTS (Seth, v346 test drive): a 217 MB text refused every generated export with
 * "This recording is too large to convert in the browser". The source was `Two women EXTRA
 * EXTENDED.wav` — a WAV, which `prepareConversionSources` never decodes (`if (isWav) segMedia =
 * media` skips convertAudio entirely). So a decode ceiling refused a file that is never decoded,
 * and the menu rows it refused described themselves as "EAF + tier order + WAV — built here": the
 * menu said it would put the WAV in a zip, then refused because it thought it had to decode it.
 *
 * ⚠ WHAT MAKES THIS WORTH PINNING is that the old behaviour was not a crash or a wrong file — it
 * was a plausible-sounding refusal. Nothing looked broken; the researcher simply believed the app
 * could not do a thing it could do easily, and had no way to tell the difference. A regression here
 * would be equally quiet, which is exactly why it needs a test rather than a test drive.
 *
 * The rules being pinned (Seth, 2026-08-12):
 *   1. ELAN/SayMore NEVER refuse on size — above the ceiling they ship the ORIGINAL audio.
 *   2. .fxpa NEVER refuses — above the ceiling it is built WITHOUT audio and says so.
 *   3. .preview.html DOES refuse. "The whole value of that is the embedded sound and the
 *      following/auto-scrolling/segmented players" — an audio-less one is a worse .flextext.
 *   4. A WAV is never judged by a decode estimate, at any size.
 *   5. A lossy original shipped unconverted must SAY that its timings drift (~44 ms AAC priming).
 *   6. makeZip refuses past ZIP_HARD_MAX rather than silently writing a corrupt ZIP32 archive.
 *
 * Run: node test/oversize-conversions.test.mjs
 */
import { readFileSync } from 'node:fs';
import { conversionCaps, CONV_DECODED_MAX, howToOpenText } from '../docs/js/seg-exports.js';
import { makeZip, ZIP_HARD_MAX } from '../docs/js/zip.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const MB = 1024 * 1024;

console.log('\nthe real case from the test drive: a 217 MB WAV');
{
  // Seth's file, to the byte-ish: 217.3 MB, .wav, 17 MB over the 200 MB decode ceiling.
  const c = conversionCaps({ bytes: 217.3 * MB, isWav: true });
  ok(c.over === true, 'it IS over the ceiling — this is not a test that moved the goalposts');
  ok(c.elan === true && c.saymore === true, 'ELAN and SayMore are still offered — the zip only needs the bytes');
  ok(c.fxpa === true, '.fxpa is still offered');
  ok(c.fxpaAudio === false, '...but without its embedded audio');
  ok(c.preview === false, 'the listening page is refused — its whole value is the embedded sound');
  ok(c.lossyUnconverted === false, 'and nothing warns about drift: a WAV IS the timeline');
}

console.log('\na WAV is never judged by a decode estimate, at any size');
{
  // THE ORIGINAL BUG. `est` for a WAV must be its own size, not size*10 — a 30 MB WAV that
  // estimated 300 MB would refuse everything for a file that decodes to nothing at all.
  ok(conversionCaps({ bytes: 30 * MB, isWav: true }).est === 30 * MB, 'a WAV estimates as itself');
  ok(conversionCaps({ bytes: 30 * MB, isWav: false }).est === 300 * MB, 'a lossy source estimates at 10x');
  const big = conversionCaps({ bytes: 3000 * MB, isWav: true });
  ok(big.elan && big.saymore && big.fxpa, 'even a 3 GB WAV keeps its zip and .fxpa outputs');
  ok(big.convert === false && big.lossyUnconverted === false,
     '...and is never marked lossy-unconverted, however large — there is nothing to convert');
}

console.log('\na LOSSY source above the ceiling ships unconverted, and says so');
{
  const c = conversionCaps({ bytes: 90 * MB, isWav: false });   // 900 MB decoded
  ok(c.over === true && c.convert === false, 'too big to decode');
  ok(c.elan === true && c.saymore === true, 'still shipped — with the original audio, not nothing');
  ok(c.lossyUnconverted === true, 'and FLAGGED, because the EAF times will not quite match playback');
  ok(c.preview === false && c.fxpaAudio === false, 'the embedded-audio outputs still stand down');
}

console.log('\n...while a lossy source UNDER the ceiling still converts, exactly as before');
{
  const c = conversionCaps({ bytes: 15 * MB, isWav: false });   // 150 MB decoded
  ok(c.over === false && c.convert === true, 'converts');
  ok(c.preview === true && c.fxpaAudio === true, 'every output available');
  ok(c.lossyUnconverted === false, 'and no drift warning — the derived WAV gives exact alignment');
}

console.log('\nunknown size is permissive, not blocking');
{
  // A manifest that predates the size field, or a file Drive did not report a size for, must not
  // silently disable every conversion — that would be the original bug wearing a different hat.
  const c = conversionCaps({ bytes: 0, isWav: false });
  ok(c.over === false && c.preview === true && c.fxpaAudio === true, 'zero bytes blocks nothing');
  ok(conversionCaps().preview === true, 'and neither does calling it with no arguments at all');
  ok(c.lossyUnconverted === false, 'an unknown size never claims the audio is unconverted');
}

console.log('\nthe ceiling is the documented one, and is a real boundary');
{
  ok(CONV_DECODED_MAX === 200 * MB, 'CONV_DECODED_MAX is 200 MB');
  ok(conversionCaps({ bytes: 200 * MB, isWav: true }).over === false, 'exactly at the ceiling is allowed');
  ok(conversionCaps({ bytes: 200 * MB + 1, isWav: true }).over === true, 'one byte past it is not');
}

console.log('\nthe timing caveat travels WITH the files, in HOW-TO-OPEN.txt');
{
  /* A toast is gone in eight seconds; the person who opens this zip in ELAN next month is the one
   * who needs to know. seg-exports already emits this file on the principle that the instructions
   * travel with the files, so the warning belongs in it. */
  const txt = howToOpenText({ base: 'Story', segMediaName: 'Story.m4a', derived: false,
    eaf: true, saymore: true, preview: false, previewName: '', json: false, lossyUnconverted: true });
  ok(/TIMING/i.test(txt), 'the zip explains the timing caveat');
  ok(/0\.04|hundredths/i.test(txt), '...with a magnitude, not just a vague warning');
  ok(/ELAN|convert/i.test(txt), '...and what to do about it');

  const clean = howToOpenText({ base: 'Story', segMediaName: 'Story.wav', derived: false,
    eaf: true, saymore: true, preview: false, previewName: '', json: false, lossyUnconverted: false });
  ok(!/TIMING/i.test(clean), 'and a normal bundle is NOT given a warning it does not deserve');

  // The two ABOUT blocks describe opposite situations and must not both fire.
  const derived = howToOpenText({ base: 'Story', segMediaName: 'Story.converted-NOT-ARCHIVAL.wav',
    derived: true, eaf: true, saymore: false, preview: false, previewName: '', json: false });
  ok(/archival master/i.test(derived) && !/TIMING/i.test(derived),
     'a CONVERTED copy gets the archival note and no timing warning — it is exactly aligned');
}

console.log('\nmakeZip refuses past the ZIP32 wall instead of corrupting');
{
  ok(ZIP_HARD_MAX < 4 * 1024 * 1024 * 1024,
     'the ceiling is below 4 GiB, where le32 sizes/offsets wrap');
  // A fake oversized entry: makeZip must pre-flight on .size and never try to read it.
  let read = false;
  const huge = { size: ZIP_HARD_MAX + 1, arrayBuffer: () => { read = true; return Promise.resolve(new ArrayBuffer(0)); } };
  let err = null;
  try { await makeZip([{ name: 'big.wav', data: huge }]); } catch (e) { err = e; }
  ok(err && err.code === 'ZIP_TOO_LARGE', 'it throws a NAMED error the caller can recognise');
  ok(read === false, '...before reading a single byte — a refusal must not cost the allocation first');

  // And the ordinary path still works, byte-for-byte.
  const zip = await makeZip([{ name: 'a.txt', data: new TextEncoder().encode('hello') }]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  ok(bytes[0] === 0x50 && bytes[1] === 0x4b, 'a normal zip is still a zip (PK header)');
}

console.log('\nthe panel consults ONE policy, so a greyed row cannot lie about the click');
{
  const panel = read('../docs/js/researcher-panel.js');
  ok(/import \{[^}]*conversionCaps[^}]*\} from '\.\/seg-exports\.js'/.test(panel),
     'the panel imports the shared policy');
  /* ⚠ THE POINT OF THIS ASSERTION: two thresholds drift, and the drift is invisible until a
   * researcher clicks a row the menu said was fine. The old hand-rolled `est` computation in the
   * menu renderer and the one in prepareConversionSources were exactly that shape. */
  ok(!/CONV_DECODED_MAX = /.test(panel), 'and no longer declares a ceiling of its own');
  const hand = (panel.match(/aBytes \* 10|\(af\.size \|\| 0\) \* 10/g) || []).length;
  ok(hand === 0, 'nor a second hand-rolled decode estimate');
  const uses = (panel.match(/conversionCaps\(/g) || []).length;
  ok(uses >= 2, `both the renderer and the conversion call it (${uses} call sites)`);

  ok(/if \(kind === 'preview' && !src\.caps\.preview\)/.test(panel),
     'preview is the only kind that refuses on size');
  ok(/if \(isWav \|\| !caps\.convert\) segMedia = media;/.test(panel),
     'above the ceiling the ORIGINAL becomes the seg media — the already-WAV path, reused');
  /* ⚠ Scope this to the CONVERSION flag. A bare /tooBig/ also matches `task.tooBig`, an unrelated
   * pre-existing string about an oversized task attachment — a test that fails on innocent code is
   * a trap, and the next person would "fix" it by renaming something that was never involved. */
  ok(!/src\.tooBig|tooBig:|tooBigConvert/.test(panel),
     'the old blanket conversion refusal is gone from the panel entirely');
  ok(/const dropAudio = kind === 'fxpa' && !src\.caps\.fxpaAudio/.test(panel),
     'an oversized .fxpa drops its audio rather than refusing');
  /* Fetching 217 MB in order to throw it away is not merely wasteful on a field connection — it is
   * the difference between an instant export and a long silent wait that looks like a hang. */
  ok(/opts\.kind === 'fxpa' && !caps\.fxpaAudio\) return/.test(panel),
     '...and does not download the audio it is not going to use');
}

console.log('\nDownload-all applies the same ladder, and reports per output');
{
  const panel = read('../docs/js/researcher-panel.js');
  const at = panel.indexOf('async function downloadAllZip');
  const block = panel.slice(at, panel.indexOf('\nasync function ', at + 10));
  ok(!/tooBigConvert/.test(block), 'no blanket "conversions skipped" any more');
  ok(/preview: !!src\.segMedia && src\.caps\.preview/.test(block), 'the preview drops out on its own');
  ok(/fxpa: src\.caps\.fxpaAudio/.test(block), 'and the audio-bearing .fxpa likewise');
  /* ⚠ The subtle one: ONE assembleSegEntries call takes ONE segMedia, so making the .fxpa text-only
   * by dropping segMedia would take the EAFs and their audio with it. Two passes, each with the
   * media it should have. Getting this wrong yields a zip with no ELAN files and no error. */
  ok(/if \(!src\.caps\.fxpaAudio\) \{[\s\S]{0,400}?wants: \{ fxpa: true \}/.test(block),
     'the text-only .fxpa is built in its OWN pass, so the EAFs keep their audio');
  ok(/notes\.push\(t\('panel\.dl\.previewTooBig'/.test(block) &&
     /notes\.push\(t\('panel\.dl\.lossyTiming'\)\)/.test(block),
     'and each omission is named individually rather than as one vague message');
}

console.log('\nevery new string is in BOTH languages');
{
  const i18n = read('../docs/js/i18n.js');
  const block = (lang) => {
    const at = i18n.indexOf(`\n${lang}: {`);
    const rest = i18n.slice(at + 1);
    const nxt = rest.search(/\n[a-z]{2,3}: \{/);
    return nxt < 0 ? i18n.slice(at) : i18n.slice(at, at + 1 + nxt);
  };
  for (const k of ['panel.dl.previewTooBig', 'panel.dl.fxpaNoAudio', 'panel.dl.fxpaNoAudioSub',
                   'panel.dl.lossyTiming', 'panel.dl.zipTooLarge']) {
    const re = new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'm');
    ok(re.test(block('en')) && re.test(block('id')), `${k} is in en AND id`);
  }
  ok(!/'panel\.dl\.tooBigConvert':/.test(i18n),
     'the retired blanket string is gone — it would now be a lie on a row that works');
  /* The refusal has to say what the researcher CAN still have, or it reads as "this text is
   * broken" rather than "one of four outputs is unavailable". */
  const why = (i18n.match(/'panel\.dl\.previewTooBig': '([^']*)'/) || [])[1] || '';
  ok(/ELAN/i.test(why) && /SayMore/i.test(why), 'the preview refusal names what still works');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
