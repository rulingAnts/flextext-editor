/* The source manifest: metadata + the completeness contract for "<Storyname>/originals/".
 *
 * WHY (Seth, 2026-08-12): "assigned texts should also generate a manifest file with metadata… a
 * place to specify HOW the text was originated in case our suite or some app needs to know" — and
 * "the manifest file also helps us with the download menu", which reads it instead of guessing from
 * filenames.
 *
 * The two properties that must not drift:
 *   1. It is written FIRST and declares the INTENDED file list, so completeness is DERIVED by
 *      comparing that list against the folder. There is deliberately NO stored `complete` flag: a
 *      flag written last goes stale the moment a later write fails, and would then assert the
 *      opposite of the truth.
 *   2. It is ADDITIVE and versioned — readers ignore unknown keys, so a future `origin` value or
 *      field cannot break an old reader.
 *
 * Run: node test/source-manifest.test.mjs
 */
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const segex = readFileSync(new URL('../docs/js/seg-exports.js', import.meta.url), 'utf8');
const body = (app.match(/function buildSourceManifest\(rec, \{ origin, files, audio \}\) \{([\s\S]*?)\n\}/) || [])[1] || '';

console.log('\nthe manifest carries what a consumer needs without opening a single audio file');
{
  ok(!!body, 'buildSourceManifest present');
  for (const k of ['schema', 'docId', 'title', 'origin', 'writtenAt', 'engine', 'writingSystems', 'audio', 'files', 'consent']) {
    // `audio,` / `origin,` are ES shorthand for the destructured params — both forms count.
    ok(new RegExp('(^|\\s)' + k + '[,:]').test(body), `declares ${k}`);
  }
  ok(/schema: 1/.test(body), 'schema is versioned, so readers can branch on it later');
}

console.log('\ncompleteness is DERIVED from the declared file list, never a stored flag');
{
  ok(!/complete\s*:/.test(body), 'no `complete:` field — a stale flag would assert the opposite of the truth');
  ok(/files: \[\{ name: MANIFEST_NAME/.test(body), 'the manifest lists ITSELF, so the declared set is the whole folder');
}

console.log('\nprovenance: how the text came to exist, recorded rather than inferred');
{
  const q = app.match(/async function queueMediaUpload\(docId\) \{([\s\S]*?)\n\}/)[1];
  ok(/origin: isAudioLocked\(rec\) \? 'assigned' : 'recorded'/.test(q),
     "origin distinguishes an assigned text from one recorded on the device");
}

console.log('\nprivacy: the manifest records THAT consent exists, never what it says');
{
  ok(/prompt: !!rec\.consentPromptClip/.test(body) && /response: !!rec\.consentClip/.test(body) && /receipt: !!rec\.consentReceipt/.test(body),
     'consent fields are booleans, not content');
  ok(!/consentReceiptText|receipt\.name|receipt\.signature/.test(body), 'no receipt content is copied into the manifest');
}

console.log('\nthe audio name is derived from the STORY TITLE, sanitised like the folder');
{
  // v3 moved sanitizeBase/extOf into seg-exports.js so the device, the panel and the DOWNLOADER
  // share one rule (see test/media-filenames.test.mjs). This test still owns the assertion that
  // the source package's audio name follows it — only the address changed.
  ok(/from '\.\/seg-exports\.js'/.test(app) && /sanitizeBase/.test(app.split('\n').slice(0, 40).join('\n')),
     'app.js imports the shared rule instead of carrying its own copy');
  const san = (segex.match(/export function sanitizeBase\(title\) \{([\s\S]*?)\n\}/) || [])[1] || '';
  ok(san.includes("replace(") && san.includes("'_'"), 'strips the same characters the worker strips from folder names');
  ok(/slice\(0, 120\)/.test(san), 'and caps at the same 120 characters, so file and folder cannot disagree');
  const ext = (segex.match(/export function extOf\(name, mime\) \{([\s\S]*?)\n\}/) || [])[1] || '';
  ok(/audio\/wav/.test(ext) && /audio\/mpeg/.test(ext), 'extension falls back to the mime type when the name has none');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
