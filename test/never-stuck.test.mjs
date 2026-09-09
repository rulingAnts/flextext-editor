/* NOTHING IS EVER STUCK WAITING FOR A PERSON.
 *
 * Seth, 2026-09-09: "I don't ever want texts or updates to just be stuck until a manual refresh or
 * retry is triggered by the user. There should be a button to do that, but it should never be up to
 * them to remember to do that when the connection does come back… To remember or know how."
 *
 * And the shape the retries must take: "after an honest effort of a few times, start increasing the
 * cooldown time in between. So that it never stops retrying (if there's a connection at all)… And
 * every time it successfully gets more bytes, it should reset the cooldown to default retries. What
 * I don't want is for it to get a download partially, then have three failed retries because the
 * connection is out, and then just fail period."
 *
 * Sized against the real link: "My apartment connection, even though it's starlink (but shared among
 * probably 30+ users) often drops a connection for 2 minutes or more before coming back." Every
 * ceiling below must therefore outlast two minutes, or it gives up inside the very event it exists
 * to survive. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js');
const AUDIO = rd('../docs/js/audio.js');
const UPLOAD = rd('../docs/js/upload.js');

const SWS = ['../docs/sw.js', '../paragraph-analysis/sw.js', '../satellites/audio-segmenter/sw.js',
             '../satellites/consent-collector/sw.js', '../satellites/text-recorder/sw.js'];

const TWO_MINUTES = 120000;

/* ── the three things that can be interrupted, and how each comes back on its own ─────────────── */

test('a failed TEXT/AUDIO download is retried without anyone pressing anything', () => {
  const sweep = APP.slice(APP.indexOf('async function retryPendingAudio'), APP.indexOf("/* ---------------- Task links"));
  assert.match(sweep, /if \(rec\?\.pendingAudio\) await tryDownloadAudio\(rec\)/,
    'the sweep re-attempts any doc still marked pending — an error state does not exclude it');
  const one = APP.slice(APP.indexOf('async function tryDownloadAudio'), APP.indexOf('async function retryPendingAudio'));
  assert.match(one, /delete rec\.audioError; \/\/ fresh attempt, fresh verdict/,
    'and a previous failure is cleared rather than treated as final');
  // Driven by both a returning connection and a plain timer, because `online` is not reliable on a
  // link whose wifi stays up while the uplink drops.
  assert.match(APP, /window\.addEventListener\('online', \(\) => \{ retryPendingAudio\(\)/);
  assert.match(APP, /setInterval\(\(\) => \{[\s\S]{0,400}retryPendingAudio\(\);[\s\S]{0,400}\}, RETRY_EVERY_MS\)/);
});

test('a failed UPLOAD is retried without anyone pressing anything', () => {
  const sweep = APP.slice(APP.indexOf('async function retryPendingUploads'), APP.indexOf('function setUploadBarHeightVar'));
  assert.match(sweep, /v\.status === 'error' && paired\) uploadView\.set\(docId, \{ \.\.\.v, status: 'waiting' \}\)/,
    'error → waiting IS the retry');
  assert.match(sweep, /if \(paired\) pumpUploads\(\)/, 'and the pump is started again');
});

test('a missed APP UPDATE is retried without anyone pressing anything', () => {
  const reg = APP.slice(APP.indexOf("register('sw.js'"), APP.indexOf('// ---- Auto-update'));
  for (const trigger of [/check\(\);\n/, /visibilitychange/, /'online'/, /setInterval/]) {
    assert.match(reg, trigger, 'update checks are event- and timer-driven, not user-driven');
  }
});

/* ── the taper, and the rule that progress resets it ──────────────────────────────────────────── */

test('downloads taper, survive a >2 minute outage, and reset on any byte of progress', () => {
  assert.match(AUDIO, /const RETRIES = 10;/);
  const cap = Number(AUDIO.match(/const RETRY_MAX_MS = (\d+);/)[1]);
  assert.ok(cap > TWO_MINUTES, `cooldown cap (${cap}ms) outlasts a 2-minute drop`);
  assert.match(AUDIO, /setTimeout\(r, Math\.min\(RETRY_MAX_MS, 2000 \* 2 \*\* attempt\)\)/, 'exponential, then capped');
  // ⚠ The rule Seth asked for by name.
  assert.match(AUDIO, /if \(this\.received > beforeBytes\) attempt = 0; else attempt\+\+;/,
    'bytes arriving prove the link is alive, so the patience starts over');
  assert.match(AUDIO, /const beforeBytes = this\.received;/, 'measured per attempt');
  // Giving up must keep the partial, so the next sweep resumes rather than restarting.
  assert.match(AUDIO, /this\.status = 'error';\s*\/\/ keep partial/);
});

test('uploads taper and survive a >2 minute outage, and already reset on progress', () => {
  assert.match(UPLOAD, /const UP_STRIKES = 8;/);
  const cap = Number(UPLOAD.match(/const UP_WAIT_MAX_MS = (\d+);/)[1]);
  assert.ok(cap > TWO_MINUTES, `cooldown cap (${cap}ms) outlasts a 2-minute drop`);
  assert.equal((UPLOAD.match(/while \(strikes < UP_STRIKES\)/g) || []).length, 2, 'both chunk loops');
  assert.match(UPLOAD, /strikes = 0; waitMs = 2000;/, 'a delivered chunk resets the taper');
  assert.doesNotMatch(UPLOAD, /waitMs \* 2, 60000/, 'the old 60s ceiling is gone');
});

test('the update precache tapers and survives a >2 minute outage, in every app', () => {
  for (const p of SWS) {
    const sw = rd(p);
    assert.match(sw, /const PRECACHE_TRIES = 7;/, `${p} retries more than three times`);
    const cap = Number(sw.match(/const PRECACHE_WAIT_MAX_MS = (\d+);/)[1]);
    assert.ok(cap > TWO_MINUTES, `${p} cooldown cap (${cap}ms) outlasts a 2-minute drop`);
    assert.match(sw, /for \(let attempt = 0; attempt < PRECACHE_TRIES && !cached; attempt\+\+\)/, p);
    // Being offline is not flakiness — bail rather than grind every file through the full taper.
    assert.match(sw, /if \(self\.navigator && self\.navigator\.onLine === false\) throw err;/, p);
    // ⚠ And none of this weakens atomicity: a file that truly cannot be fetched still throws.
    assert.match(sw, /if \(!cached\) throw lastErr/, `${p} still fails the install rather than caching a partial version`);
  }
});

/* The ONE deliberate exception, and it is not a forgotten retry: a download paused because the
 * DEVICE IS FULL stays paused, because no amount of retrying makes space. It is visible, it says
 * why, and resuming is the user's decision. */
test('the only thing that waits for a person is a device that is out of space', () => {
  assert.match(AUDIO, /e\.storageFull \|\| e\.name === 'QuotaExceededError'/);
  assert.match(AUDIO, /this\.status = 'paused';\s*\n\s*this\.storageIssue = true;/);
  assert.match(APP, /if \(getDownload\(rec\.id\)\?\.status === 'paused'\) return false; \/\/ user's pause stands/);
});
