/* Assign-modal verdicts: the local audio check + the WS-mismatch comparison (assign-by-upload).
 *
 * WHY THIS IS WORTH A TEST: these two functions are what stands between the researcher and a
 * broken assignment now that the URL probe ladder is gone. The audio verdict must block exactly
 * what the device cannot use (AIFF, oversize, non-audio) and pass everything else; the WS check
 * must name BOTH sides on a mismatch and stay SILENT when there is nothing to compare — a false
 * alarm here trains researchers to click through the one dialog that matters.
 *
 * researcher-panel.js cannot be imported under node (DOM at module scope, by design) — the
 * functions are lifted from the real source, the text-folder-files technique: a rename or rewrite
 * fails here rather than silently testing a copy.
 *
 * Run: node test/assign-modal-verdicts.test.mjs
 */
import { readFileSync } from 'node:fs';
import { detectFormat } from '../docs/js/convert.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const maxSrc = panel.match(/const ASSIGN_AUDIO_MAX = ([^;]+);/);
const avSrc = panel.match(/function assignAudioVerdict\(\{ buf, name, size \}\) \{([\s\S]*?)\n\}/);
const wsSrc = panel.match(/function wsAssignMismatch\(analysis, instanceCodes\) \{([\s\S]*?)\n\}/);
ok(!!maxSrc && !!avSrc && !!wsSrc, 'both verdict functions (and the size cap) are present in researcher-panel.js');
if (!maxSrc || !avSrc || !wsSrc) { console.log(`\nFAILED (${fail})`); process.exit(1); }
const MAX = new Function('return ' + maxSrc[1])();
// The signature destructured its params — rebuild the lifted body as a function taking them flat.
const av = (o) => new Function('detectFormat', 'ASSIGN_AUDIO_MAX', 'buf', 'name', 'size', avSrc[1])
  .call(null, detectFormat, MAX, o.buf, o.name, o.size);
const wsAssignMismatch = (analysis, codes) => new Function('analysis', 'instanceCodes', wsSrc[1])
  .call(null, analysis, codes);

const bytes = (s) => { const b = new Uint8Array(64); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };
const WAV = bytes('RIFF????WAVE');
const AIFF = bytes('FORM????AIFF');
const MP3 = bytes('ID3?????????');
const TEXT = bytes('hello, plain text');

console.log('\naudio verdict: blocks exactly what the device cannot use');
ok(av({ buf: AIFF, name: 'take.aiff', size: 1000 }).code === 'aiff', 'AIFF is blocked (browsers cannot play it)');
ok(av({ buf: WAV, name: 'take.wav', size: MAX + 1 }).code === 'big', 'oversize is blocked');
ok(av({ buf: WAV, name: 'take.wav', size: MAX + 1 }).mb === Math.round((MAX + 1) / 1048576), 'and reports the size in MB');
ok(av({ buf: TEXT, name: 'notes.txt', size: 1000 }).code === 'notAudio', 'obvious non-audio is blocked');

console.log('\naudio verdict: passes what the device can use');
ok(av({ buf: WAV, name: 'take.wav', size: 1000 }).ok === true, 'WAV passes');
ok(av({ buf: MP3, name: 'take.mp3', size: 1000 }).ok === true, 'MP3 passes');
ok(av({ buf: TEXT, name: 'voicememo.m4a', size: 1000 }).ok === true,
   'unrecognised bytes with an audio extension pass (detectFormat does not know every container)');
ok(av({ buf: WAV, name: 'take.wav', size: MAX }).ok === true, 'exactly at the cap passes');

console.log('\nWS mismatch: names both sides, and only speaks when it can compare');
{
  const analysis = { error: null, vernCodes: ['fau'], analCodes: ['id'] };
  ok(wsAssignMismatch(analysis, { vernLang: 'fau', analLang: 'id' }) === null, 'matching codes -> null (no dialog)');
  const mm = wsAssignMismatch(analysis, { vernLang: 'xyz', analLang: 'en' });
  ok(!!mm, 'mismatched codes -> a verdict');
  ok(mm && mm.fileVern === 'fau' && mm.fileAnal === 'id', 'the FILE side is named');
  ok(mm && mm.setupVern === 'xyz' && mm.setupAnal === 'en', 'the SETUP side is named');
  const partial = wsAssignMismatch(analysis, { vernLang: 'fau', analLang: 'en' });
  ok(!!partial, 'one mismatched side is enough');
  ok(wsAssignMismatch(analysis, null) === null, 'missing settings snapshot -> SILENT skip');
  ok(wsAssignMismatch(analysis, {}) === null, 'snapshot without codes -> silent skip');
  ok(wsAssignMismatch({ error: 'XML parse error' }, { vernLang: 'fau' }) === null, 'unreadable file -> silent skip');
  ok(wsAssignMismatch(null, { vernLang: 'fau' }) === null, 'no analysis at all -> silent skip');
  ok(wsAssignMismatch({ error: null, vernCodes: [], analCodes: [] }, { vernLang: 'fau', analLang: 'id' }) === null,
     'a file with NO surveyed codes cannot mismatch (nothing to compare)');
}

console.log('\nthe modal really uses these (not a leftover probe path)');
ok(!/probeAudioUrl/.test(panel), 'probeAudioUrl is gone from the panel');
ok(!/assignCopy\(/.test(panel), 'the assignCopy call is gone (the upload IS the copy)');
ok(/assignAudioVerdict\(\{ buf: head/.test(panel), 'the send handler calls assignAudioVerdict');
ok(/wsAssignMismatch\(analyzeFlextextWs\(ftText\), codes\)/.test(panel), 'and wsAssignMismatch on the parsed file');

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
