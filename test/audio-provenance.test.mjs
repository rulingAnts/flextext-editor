/* Provenance written INTO the audio: the WAV bext chunk and the FLAC STREAMINFO MD5.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS: these files outlive the app. A recording made in a village
 * is deposited in an archive years later by someone who never used this software, and by then the
 * only thing that can answer "how was this made?" is the file itself. Everything here was ALREADY
 * known at record time — the native shells report the microphone, the routing and whether the OS
 * processors were off; the browser path knows its own DSP settings — and it was already shown on
 * screen. None of it reached the bytes, so all of it died with the app.
 *
 * ⚠ THE RULE THE WHOLE FEATURE RESTS ON: NEVER CLAIM WHAT THE PLATFORM CANNOT DELIVER. Web Audio is
 * 32-bit float BY SPECIFICATION (notes/audiotoolsandsettingsplan §0b) — there is no integer capture
 * path in it at all — so a browser-recorded "24-bit WAV" is a float capture WRITTEN to 24-bit and
 * must say exactly that. Only a native shell reporting depthVerified may state a captured depth as
 * fact. A confident wrong provenance is worse than none: it gets believed.
 *
 * Run: node test/audio-provenance.test.mjs
 */
import { readFileSync } from 'node:fs';
import { captureBext } from '../docs/js/seg-exports.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const app = read('../docs/js/app.js');
const pcm = read('../docs/js/record-pcm.js');
const flac = read('../docs/js/flac.js');

console.log('\nthe BROWSER path never claims a capture depth the web cannot give');
{
  const h = captureBext({ mode: 'browser', sampleRate: 48000, channels: 1, bits: 24,
                          agc: false, app: 'FlexText Editor', appVersion: 'v292' }).codingHistory;
  ok(/W=32.*32-bit float by specification/.test(h), 'the CAPTURE line is 32-bit float, and says why');
  ok(/W=24.*float-to-24-bit reduction \(faithful\)/.test(h), 'the WRITE line is 24-bit, and calls it faithful');
  ok(!/captured.*24-bit/.test(h), '⚠ and nowhere claims a 24-bit CAPTURE');
}
console.log('\n...and it is equally plain when the settings were not archival');
{
  const h = captureBext({ mode: 'browser', bits: 16, agc: true, nr: true, echo: true, normalized: true }).codingHistory;
  ok(/AGC ON - auto-gain alters dynamics/.test(h), 'AGC on is named as altering dynamics');
  ok(/noise reduction ON/.test(h) && /echo cancellation ON/.test(h), 'the other processors are named');
  ok(/peak-normalised after capture - an edit/.test(h), 'normalisation is called an edit');
  ok(/requantised from float to 16-bit \(irreversible\)/.test(h), '16-bit is irreversible, not "faithful"');
}
/* ⚠ AGC ARRIVES IN TWO SHAPES, and getting one backwards is the worst single error this file can
 * make. `settings.agc` is the TRISTATE STRING 'off' | 'on' | 'auto'; effectiveAgc() resolves it to
 * a boolean before recordingProvenance() passes it in. A bare `p.agc ? …` reads the string 'off' as
 * TRUE — so a caller who wires the setting straight through (the obvious thing, and what anything
 * outside app.js would naturally write) stamps "AGC ON - auto-gain alters dynamics" onto the take
 * whose entire point was that auto-gain was OFF.
 * A researcher who turned AGC off FOR archival quality would get a master permanently claiming the
 * opposite, and no later listener could tell. Both shapes are pinned, in both directions. */
console.log('\nAGC reads correctly whether it arrives resolved or as the raw setting');
for (const v of [false, 'off', undefined, null]) {
  const h = captureBext({ mode: 'browser', bits: 24, agc: v }).codingHistory;
  ok(/AGC off/.test(h) && !/AGC ON/.test(h), `agc=${JSON.stringify(v)} → "AGC off", never ON`);
}
for (const v of [true, 'on']) {
  const h = captureBext({ mode: 'browser', bits: 24, agc: v }).codingHistory;
  ok(/AGC ON - auto-gain alters dynamics/.test(h), `agc=${JSON.stringify(v)} → "AGC ON"`);
}
{
  // 'auto' is browser-conditional and unresolved here. Say that, rather than pick a side of it.
  const h = captureBext({ mode: 'browser', bits: 24, agc: 'auto' }).codingHistory;
  ok(/AGC left to the browser default - not recorded for this take/.test(h),
     'agc="auto" is reported as unknown, not silently as on or off');
  ok(!/AGC ON|AGC off/.test(h), 'and never as either of the two it is not');
}

console.log('\n...and does not invent an edit that did not happen');
{
  const h = captureBext({ mode: 'browser', bits: 32, agc: false }).codingHistory;
  ok(/the captured float, unconverted/.test(h), '32-bit out of a float capture is a no-op, and says so');
  ok(!/irreversible|faithful/.test(h), 'with no reduction language at all');
}

console.log('\na NATIVE shell may say more, because it genuinely knows more');
{
  const h = captureBext({ mode: 'native', platform: 'android', appVersion: 'v292',
    native: { device: 'USB-C Mic', deviceType: 'usb', encoding: 'PCM_24BIT_PACKED', sampleRate: 48000,
              channels: 1, unprocessed: true, depthVerified: true } }).codingHistory;
  ok(/captured by USB-C Mic \/ usb via the android shell/.test(h), 'the real device is named');
  ok(/depth verified by the device/.test(h), 'a verified depth is stated as fact');
  ok(/OS audio processing was off/.test(h), 'and the processor state');
  ok(!/32-bit float by specification/.test(h), 'the web caveat is absent — it does not apply here');
}
console.log('\n...and is just as plain when the news is bad');
{
  const h = captureBext({ mode: 'native', native: { device: 'Bluetooth HS', encoding: 'PCM_16BIT',
    unprocessed: false, depthVerified: false, wireless: true, substituted: true,
    substitutionReason: '24-bit unsupported' } }).codingHistory;
  ok(/DEPTH NOT VERIFIED - requested, not confirmed/.test(h), 'an unverified depth says so loudly');
  ok(/OS AUDIO PROCESSING WAS ON - not an unmodified transfer/.test(h), 'processing left on is called out');
  ok(/WIRELESS microphone - the link itself may compress/.test(h), 'a wireless link is called out');
  ok(/substituted a different format \(24-bit unsupported\)/.test(h), 'a substitution is recorded with its reason');
}

console.log('\nit is written at the ONE chokepoint every app records through');
ok(/export async function encodeRecording\(channels, sampleRate, format, onProgress, provenance\)/.test(pcm),
   'encodeRecording takes provenance — editor, recorder and crowd all encode here');
ok(/if \(provenance\) \{[\s\S]*?wavWithBext\(await blob\.arrayBuffer\(\), meta\)/.test(pcm), 'and stamps the WAV with it');
ok(/catch \{ \/\* fall through to the unstamped take \*\/ \}/.test(pcm),
   '⚠ a stamping failure keeps the recording — honesty must never cost someone their take');
ok(/return \{ blob, ext: f\.ext, mime: f\.mime \};/.test(pcm), 'and a caller passing none still works (backward compatible)');
ok(/function recordingProvenance\(r\)/.test(app), 'app.js collects it');
ok(/encodeRecording\(chans, rec\.sampleRate, rec\.fmt,\s*\n?\s*\(f\) => recordUI\('saving', \{ pct: Math\.round\(f \* 100\) \}\), recordingProvenance\(rec\)\)/.test(app),
   'and passes it on the browser save path');
ok(/wavWithBext\(await rec\.blob\.arrayBuffer\(\), captureBext\(recordingProvenance\(rec\)\)\)/.test(app),
   'the NATIVE master is stamped too — it has the richest provenance of any take');
ok(/micLabel = pcmRec\.stream\?\.getAudioTracks\?\.\(\)\[0\]\?\.label/.test(app),
   'the mic name is captured from the live track, before the stream is stopped');
/* The native contract boundary. describeCapture already normalises "field absent" to "not
 * reported"; reading through it is what lets the APK and the engine keep shipping separately. */
ok(/describeCapture\(r\.nativeMeta\)/.test(app), 'native facts are read through describeCapture only');

console.log('\nFLAC: the format\'s OWN tamper-evidence is written (it was all zeros)');
/* A FLAC carries an MD5 of the unencoded audio in STREAMINFO — `flac -t` and ffmpeg decode and
 * check it, so alteration or bit-rot is detectable years later. libFLAC writes STREAMINFO FIRST,
 * before it has seen any audio, and normally SEEKS BACK to fill it in; there is no seek callback
 * when assembling a Blob, so every FLAC this app produced had a zeroed MD5 and could not be
 * verified by anything. Nothing errored — the integrity data was simply absent. */
ok(/const metaCb = \(info, block\) => \{/.test(flac), 'the metadata callback is no longer discarded');
ok(/if \(info && typeof info\.md5sum === 'string'\) finalInfo = info;/.test(flac),
   "libFLAC's OWN md5sum is taken — deliberately not a hand-rolled MD5 that could disagree with it");
ok(/function patchStreamInfo\(out, info\)/.test(flac), 'and spliced into the finished buffer');
ok(/if \(!\/\^\[0-9a-f\]\{32\}\$\/i\.test\(info\.md5sum\)\)|\/\^\[0-9a-f\]\{32\}\$\/i\.test\(info\.md5sum\)/.test(flac),
   'the value is validated before use');
for (const guard of ['out\\.length < 42', 'out\\[0\\] !== 0x66', '\\(out\\[4\\] & 0x7f\\) !== 0', '!== 34']) {
  ok(new RegExp(guard).test(flac), `precondition checked before writing: /${guard}/`);
}
ok(/return false;[\s\S]{0,400}for \(let i = 0; i < 16; i\+\+\)/.test(flac),
   '⚠ every precondition bails BEFORE any byte is written — a bad splice would corrupt an archival master');

console.log('\nno new precached file was needed');
/* ⚠ The RESEARCHER satellite is deliberately absent since 2026-08-31: its worker caches nothing
 * (the panel is an online console — see satellites/flextext-researcher/sw.js), so it has no SHELL. */
for (const sw of ['../docs/sw.js', '../satellites/text-recorder/sw.js',
                  '../paragraph-analysis/sw.js']) {
  const src = read(sw);
  ok(/js\/seg-exports\.js/.test(src) && /js\/record-pcm\.js/.test(src),
     `${sw.split('/').slice(-2).join('/')} already precaches both modules`);
}

console.log(fail ? `\nFAILED (${fail})\n` : `\nPASSED\n`);
process.exit(fail ? 1 : 0);
