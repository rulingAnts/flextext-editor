// Seth, 2026-09-07: "Could not build the download: allocation size overflow" (Audio Segmenter,
// .fxpa) and "Download failed" (researcher panel, listening page) — the same engine path, on real
// recordings. Both files embed the recording as base64, and the old assembly held it as ONE string
// and JSON.stringify'd it. MEASURED in headless Firefox 155 on the rig: 120 MB of audio stringified,
// 135 MB threw — Firefox refuses to quote a string past ~179M characters, well under the 200 MB
// size gate. The fix is structural: stringify around a placeholder, lay the base64 in as Blob
// chunks. These tests keep the bytes identical and the export path clear of any whole-string step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fxpaBlob, previewBlob, spliceB64, b64PartsOf, blobToBase64, blobToBase64Parts, buildFxpa,
         buildSegPreviewHtml, hasAudioBytes, B64_MARK, ENGINE_STRING_MAX, FIREFOX_STRINGIFY_SEEN_OK,
         FIREFOX_STRINGIFY_SEEN_FAIL, CONV_DECODED_MAX } from '../docs/js/seg-exports.js';

const SEGX = readFileSync(new URL('../docs/js/seg-exports.js', import.meta.url), 'utf8');
const doc = {
  title: 'T', segments: [{ start: 0, end: 1000 }],
  paragraphs: [{ segments: [{ baseline: 'aa bb', free: 'x', words: [{ txt: 'aa', gls: 'one' }] }] }],
};
const bytes = (n) => new Blob([new Uint8Array(n).map((_, i) => (i * 7) % 251)]);
const meta = { mime: 'audio/wav', name: 'a.wav' };
const fx = { title: 'T', vernLang: 'und', analLang: 'en' };

test('the placeholder survives JSON.stringify and a template literal unchanged, exactly once', () => {
  const json = JSON.stringify(buildFxpa(doc, { ...fx, audio: { ...meta, b64: B64_MARK } }));
  assert.equal(json.split(B64_MARK).length, 2, 'a placeholder that got escaped would send every build down the fallback');
  const html = buildSegPreviewHtml(doc, { title: 'T', audioB64: B64_MARK, audioMime: 'audio/wav', mediaName: 'a.wav' });
  assert.equal(html.split(B64_MARK).length, 2);
  assert.doesNotMatch(B64_MARK, /[A-Za-z0-9+/=]{20,}|["\\]/, 'no quote, no backslash, and not itself base64');
});

test('.fxpa: the chunked file is byte-for-byte what the old assembly produced', async () => {
  const audio = bytes(9001);
  const old = JSON.stringify(buildFxpa(doc, { ...fx, audio: { ...meta, b64: await blobToBase64(audio) } }));
  const now = await (await fxpaBlob(doc, { ...fx, audio: meta, audioBlob: audio })).text();
  assert.equal(now, old, 'a different file would be a silent corruption, not an optimisation');
  assert.equal(JSON.parse(now).audio.b64, await blobToBase64(audio));
  // and from a string that is already base64 (the paragraph tool's case)
  const fromStr = await (await fxpaBlob(doc, { ...fx, audio: meta, audioB64: await blobToBase64(audio) })).text();
  assert.equal(fromStr, old);
});

test('listening page: the audio is an ARRAY of chunk literals, each decodable, rejoining to the whole', async () => {
  const audio = bytes(9001);
  const html = await (await previewBlob(doc, { title: 'T', audioMime: 'audio/wav', mediaName: 'a.wav', audioBlob: audio })).text();
  const m = html.match(/var b64 = \[(.*?)\];/s);
  assert.ok(m, 'the page declares var b64 = [ ... ]');
  const arr = JSON.parse('[' + m[1] + ']');
  assert.equal(arr.join(''), await blobToBase64(audio));
  for (const p of arr) assert.doesNotThrow(() => Buffer.from(p, 'base64'));
  assert.match(html, /for \(var k = 0; k < b64\.length; k\+\+\)/, 'and decodes chunk by chunk');
  assert.match(html, /new Blob\(\[u8\], \{ type: "audio\/wav" \}\)/);
  // ⚠ v614 regression (Seth, "Birds vs Snakes"): the waveform decoder was left holding the LAST chunk
  // only, so the overview and line waves stayed blank while the audio played. The decoder must get
  // the whole recording, assembled from the parts, header first.
  assert.match(html, /var u8 = new Uint8Array\(total\), off = 0;\s*\n\s*for \(k = 0; k < parts\.length; k\+\+\) \{ u8\.set\(parts\[k\], off\); off \+= parts\[k\]\.length; \}/);
  assert.match(html, /decodeAudioData\(u8\.buffer\.slice\(0\)\)/, 'and the waveform is decoded from that whole array');
  // many parts when the chunk is small: the joins are correct
  const many = await (await previewBlob(doc, { title: 'T', audioMime: 'audio/wav', mediaName: 'a.wav',
    audioB64: (await b64PartsOf(await blobToBase64(audio), 300)).join('') })).text();
  assert.equal(JSON.parse('[' + many.match(/var b64 = \[(.*?)\];/s)[1] + ']').join(''), await blobToBase64(audio));
});

test('a chunk boundary can never corrupt the base64 — bytes in multiples of 3, strings in multiples of 4', async () => {
  for (const n of [1, 2, 3, 4, 5, 3001, 8192]) {
    const b = bytes(n), whole = await blobToBase64(b);
    for (const chunk of [3, 300, 1024, 4096]) assert.equal((await blobToBase64Parts(b, chunk)).join(''), whole, `${n} bytes in ${chunk}-byte chunks`);
    for (const chunk of [1, 2, 5, 100, 1000]) assert.equal((await blobToBase64Parts(b, chunk)).join(''), whole, `asked ${chunk}, rounded down to a multiple of 3`);
    const parts = await b64PartsOf(whole, 300);
    assert.equal(parts.join(''), whole);
    for (const p of parts.slice(0, -1)) assert.equal(p.length % 4, 0, 'every string part but the last is a whole number of quanta');
    for (const p of parts) assert.doesNotThrow(() => Buffer.from(p, 'base64'), 'so each decodes on its own');
  }
  assert.deepEqual(await b64PartsOf('', 300), [''], 'an empty string is one empty part, never zero parts');
});

test('spliceB64 refuses a document where the placeholder is not exactly once', () => {
  assert.equal(spliceB64('x' + B64_MARK + 'y' + B64_MARK, ['a']), null, 'twice → null, never a wrong splice');
  assert.equal(spliceB64('no marker here', ['a']), null);
  assert.ok(spliceB64('[' + B64_MARK + ']', ['a', 'b'], { join: '","' }) instanceof Blob);
});

test('no recording still writes both files — the text-only forms', async () => {
  const out = JSON.parse(await (await fxpaBlob(doc, fx)).text());
  assert.equal(out.audio, undefined); assert.equal(out.lines.length, 1);
  const html = await (await previewBlob(doc, { title: 'T' })).text();
  assert.doesNotMatch(html, /var b64 = /, 'no audio script at all');
});

/* ⚠ AN EMPTY RECORDING IS NO RECORDING (the v615 review, 2026-09-07). These builders decided "has
 * audio" from `audioBlob || audioB64` — an object test, and a 0-byte Blob is truthy — so previewBlob(doc,
 * { audioBlob: new Blob([]) }) returned a page titled "— segments" with a player on it, a play
 * button that did nothing, a transport reading 0:00.0 / 0:00.0 and a footer promising "Audio is
 * embedded in this file". v602 asked the ENCODED string and fell through to the text-only flavour;
 * every shape the audio can now arrive in has to answer the same way, or the page and the .fxpa
 * disagree about what the user handed in. */
test('an empty recording gets the TEXT-ONLY forms, whatever shape it arrives in', async () => {
  const shapes = [
    ['a 0-byte Blob', { audioBlob: new Blob([]) }],
    ['no parts at all', { audioParts: [] }],
    ['one empty part', { audioParts: [''] }],
    ['an empty base64 string', { audioB64: '' }],
    ['parts encoded FROM an empty Blob', { audioParts: await blobToBase64Parts(new Blob([])) }],
    ["b64PartsOf('') — which is [''], not []", { audioParts: await b64PartsOf('') }],
  ];
  for (const [label, opts] of shapes) {
    const html = await (await previewBlob(doc, { title: 'T', audioMime: 'audio/wav', mediaName: 'a.wav', ...opts })).text();
    assert.match(html, /— interlinear<\/title>/, `${label}: the page names itself interlinear, not segments`);
    assert.doesNotMatch(html, /var b64 = /, `${label}: no audio array`);
    assert.doesNotMatch(html, /id="ov"|<script>/, `${label}: no player and nothing to run`);
    assert.doesNotMatch(html, /embedded in this file/i, `${label}: and no footer claiming sound that is not there`);
    const fx2 = JSON.parse(await (await fxpaBlob(doc, { ...fx, audio: meta, ...opts })).text());
    assert.equal(fx2.audio, undefined, `${label}: the .fxpa carries no audio block, not an empty one`);
    assert.equal(fx2.lines.length, 1, `${label}: and is still a complete text-only .fxpa`);
  }
  // …while a real recording is untouched by the guard.
  const real = await (await previewBlob(doc, { title: 'T', audioMime: 'audio/wav', mediaName: 'a.wav', audioBlob: bytes(9001) })).text();
  assert.match(real, /— segments<\/title>/);
  assert.match(real, /var b64 = \["/);
  assert.ok(JSON.parse(await (await fxpaBlob(doc, { ...fx, audio: meta, audioBlob: bytes(9001) })).text()).audio.b64.length > 0);
});

test('hasAudioBytes is the one answer, and an unknown size stays permissive', () => {
  for (const empty of [null, undefined, '', [], [''], ['', ''], new Blob([]), false])
    assert.equal(hasAudioBytes(empty), false, `${JSON.stringify(empty)} is not a recording`);
  for (const real of ['QUJD', ['QUJD'], ['', 'QUJD'], bytes(1)])
    assert.equal(hasAudioBytes(real), true);
  // A blob-like with only arrayBuffer() (the stand-ins tests hand in) has no size to judge, and an
  // unknown size is permissive here exactly as it is in conversionCaps — never a silent drop.
  assert.equal(hasAudioBytes({ arrayBuffer: async () => new ArrayBuffer(8) }), true);
});

test('the bundle builder goes through the chunked assembly, and the measurement is written down', () => {
  assert.match(SEGX, /entries\.push\(\{ name: base \+ '\.fxpa',\s*\n\s*data: await fxpaBlob\(doc, \{/);
  assert.match(SEGX, /data: await previewBlob\(doc, \{\s*\n\s*title: title \|\| base, audioMime/);
  const body = SEGX.slice(SEGX.indexOf('export async function assembleSegEntries'));
  assert.doesNotMatch(body, /b64Once|blobToBase64\(segMedia/, 'no whole-recording base64 anywhere in the assembler');
  assert.match(SEGX, /allocation size overflow/, 'the failure that caused this is named where the fix lives');
  assert.match(SEGX, /multiple of three/i, 'and the rule that makes chunking safe');
});

/* ⚠ AND THE NOTE MUST NOT OVERSELL IT. It used to end "the peak is one chunk", which is false:
 * b64PartsOf returns the COMPLETE array of parts and spliceB64 runs only once every part exists, so
 * the whole base64 (~1.33× the recording) is live at once, merely split across ~4 MiB strings. The
 * danger is not the sentence, it is what a future maintainer does with it — read as licence, it
 * says CONV_DECODED_MAX is only about the reader and could be raised. */
test('the memory note says what is TRUE, so nobody raises the ceiling on the strength of it', async () => {
  assert.doesNotMatch(SEGX, /the peak is one chunk/, 'the false claim is gone');
  assert.match(SEGX, /the heap holds the WHOLE base64 at once/, 'and the true one is written down');
  assert.match(SEGX, /33,554,432 characters/, 'with the measurement behind it (24 MB → 8 parts)');
  assert.match(SEGX, /raising CONV_DECODED_MAX/, 'naming the mistake the old wording invited');
  // …and the claim is the code's actual behaviour: every part exists before anything is spliced.
  const b = bytes(3 * 1024 * 1024 * 2 + 5);
  const parts = await blobToBase64Parts(b);
  assert.ok(parts.length > 1, 'a real recording is many parts');
  assert.ok(parts.every((p) => typeof p === 'string'), 'the whole array is in hand, not a stream');
  assert.equal(parts.reduce((n, p) => n + p.length, 0), Math.ceil(b.size / 3) * 4,
    'so the live characters are the WHOLE encoding — 1.333x the recording, not one chunk');
});

test('the size gate sits under every engine ceiling, with the room the reader needs', () => {
  const b64chars = (bytesN) => Math.ceil(bytesN / 3) * 4;
  // a .fxpa is JSON.parse'd by the tool: its base64 must fit one string in the strictest engine
  assert.ok(b64chars(CONV_DECODED_MAX) * 1.9 <= ENGINE_STRING_MAX.v8, '1.9× headroom under V8 (Chrome, Android): 279.6M chars against 536.9M');
  assert.ok(ENGINE_STRING_MAX.v8 < ENGINE_STRING_MAX.spidermonkey && ENGINE_STRING_MAX.spidermonkey < ENGINE_STRING_MAX.jsc);
  // the measured Firefox refusal is BELOW the gate: the only safe export is one that never stringifies
  assert.ok(FIREFOX_STRINGIFY_SEEN_FAIL < b64chars(CONV_DECODED_MAX), 'a gated-through recording could still be one Firefox would not quote');
  assert.ok(FIREFOX_STRINGIFY_SEEN_OK < FIREFOX_STRINGIFY_SEEN_FAIL);
  // a chunk is nowhere near any of it
  assert.ok(4 * 1024 * 1024 < FIREFOX_STRINGIFY_SEEN_OK / 30);
});
