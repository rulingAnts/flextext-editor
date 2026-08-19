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
/* v395 MOVED THE BUILDER into seg-exports.js — the same fix MANIFEST_NAME got, and for the same
 * reason: the panel had grown a hand-copied literal of this shape, so the contract every consumer
 * checks completeness against had two authors. The assertions below are unchanged in substance;
 * only where they read from moved. (test/manifest-provenance.test.mjs pins the single-writer rule
 * itself, plus the schema-2 provenance fields.) */
const body = (() => {
  // Not a regex: the signature is itself a destructured object literal, so any non-greedy match
  // for the closing brace stops inside the PARAMETERS rather than at the end of the function.
  const i = segex.indexOf('export function buildSourceManifest(');
  if (i < 0) return '';
  const r = segex.indexOf('return {', i);
  const end = segex.indexOf('\n}', r);
  return r < 0 || end < 0 ? '' : segex.slice(i, end);
})();

console.log('\nthe manifest carries what a consumer needs without opening a single audio file');
{
  ok(!!body, 'buildSourceManifest present');
  for (const k of ['schema', 'docId', 'title', 'origin', 'writtenAt', 'engine', 'writingSystems', 'audio', 'files', 'consent']) {
    // `audio,` / `origin,` are ES shorthand for the destructured params — both forms count.
    ok(new RegExp('(^|\\s)' + k + '[,:]').test(body), `declares ${k}`);
  }
  ok(/schema: 2/.test(body), 'schema is versioned, so readers can branch on it later');
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
  /* The booleans are now built at the CALL SITE (the builder takes `consent` as a parameter), so
   * this reads the device's call rather than the builder body. The rule is what matters and it is
   * unchanged: the manifest records THAT consent exists, never a word of what it says. */
  const q2 = app.match(/async function queueMediaUpload\(docId\) \{([\s\S]*?)\n\}/)[1];
  ok(/prompt: !!rec\.consentPromptClip/.test(q2) && /response: !!rec\.consentClip/.test(q2) && /receipt: !!rec\.consentReceipt/.test(q2),
     'consent fields are booleans, not content');
  ok(!/consentReceiptText|receipt\.name|receipt\.signature/.test(body), 'no receipt content is copied into the manifest');
  // ...and the same must hold for the crowd page, which writes the third origin's manifest.
  const cz = app.match(/async function crowdBuildZip\([\s\S]*?\n\}/)[0];
  ok(/prompt: !!\(promptAudio && promptAudio\.blob\)/.test(cz) && /receipt: !!receipt/.test(cz),
     '...including the crowd submission, which records existence and not content');
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
