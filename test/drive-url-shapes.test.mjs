/* Drive URL-shape recognition — the class of bug behind the "0 sentences" field report.
 *
 * ⚠ WHY THIS SUITE EXISTS (v327): the panel deliberately sends the RAW pasted Drive URL and each
 * device resolves it through the worker relay with ITS OWN token at fetch time. Any URL shape
 * driveFileId fails to recognize therefore gets fetched DIRECTLY — and Google's Drive hosts send
 * no CORS headers, so the fetch rejects, classifies as transient, and the assignment retries
 * forever while looking like a network problem (two field texts lost to this before diagnosis).
 * The flextext pipeline additionally skipped the resolve entirely until v327.
 *
 * audio.js is DOM-adjacent, so driveFileId is extracted verbatim (awk function-range) and executed —
 * the same technique the verification harness used; if extraction breaks, the test fails loudly. */
import { readFileSync } from 'node:fs';

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok    ' : '  FAIL  ') + msg); if (!cond) failures++; };

const src = readFileSync(new URL('../docs/js/audio.js', import.meta.url), 'utf8');
const m = src.match(/export function driveFileId\(text\) \{[\s\S]*?\n\}/);
ok(!!m, 'driveFileId extracted from audio.js');
const driveFileId = new Function('text', m[0].replace('export function driveFileId(text) {', '').replace(/\n\}$/, ''));

const ID = '1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvW';   // realistic 33-char Drive id

console.log('\nevery shape a researcher actually pastes must yield the id');
ok(driveFileId(`https://drive.google.com/file/d/${ID}/view?usp=sharing`) === ID, 'share link (file/d/)');
ok(driveFileId(`https://drive.google.com/open?id=${ID}`) === ID, 'open?id link');
ok(driveFileId(`https://drive.google.com/uc?export=download&id=${ID}`) === ID, 'uc?export link');
// ⚠ THE v327 GAP: the download host driveLink() itself builds does not contain the substring
// "drive.google.com", so this shape extracted NO id, skipped the relay, and dead-fetched raw.
ok(driveFileId(`https://drive.usercontent.google.com/download?id=${ID}&export=download&confirm=t`) === ID,
   'drive.USERCONTENT.google.com download link (the v327 gap)');
ok(driveFileId(ID) === ID, 'bare file id');

console.log('\n...and NON-Drive inputs must yield null, so they fetch directly, unresolved');
ok(driveFileId('https://example.org/texts/story.flextext') === null, 'a plain https URL is not a Drive file');
ok(driveFileId('https://docs.google.com/document/d/' + ID) === null, 'a Docs link is not a Drive file download');
ok(driveFileId('FILEID123') === null, 'a too-short token is not mistaken for a bare id');

console.log('\nthe flextext fetch resolves BEFORE fetching — the v327 one-line fix, pinned');
const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
ok(/const file = await fetchFileViaUrl\(resolveAudioInput\(url\) \|\| url\);/.test(app),
   'buildDocFromFlextextUrl routes through resolveAudioInput, degrading to the raw URL');
ok(/drive\(\?:\\\.usercontent\)\?\\\.google\\\.com/.test(app),
   'resolveAudioInput\'s isDrive accepts the usercontent host');

console.log(failures ? `\nFAILED (${failures})\n` : '\nPASSED\n');
process.exit(failures ? 1 : 0);
