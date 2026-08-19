/* THE CROWD SUBMIT PATH MUST CHUNK LIKE EVERY OTHER UPLOAD IN THIS SUITE.
 *
 * WHY THIS TEST EXISTS. `assign-chunk-policy.test.mjs` pins the same two defects for the PANEL's
 * upload, fixed in v337 after Seth's test drive. The crowd submit path never got that fix, and was
 * the last copy of the loop still carrying both:
 *
 *   1. Fixed 8 MiB slices, and below 16 MiB a single plain POST with NO progress at all. A
 *      submission that reports nothing is indistinguishable from a hang — and it is the one screen
 *      in the whole system shown to someone who cannot ask anybody what is happening.
 *   2. A failing chunk retried AT THE SAME SIZE. On a weak connection that is the one thing you
 *      must not do: the retry is as likely to fail as the attempt was, and each failure costs the
 *      whole slice again.
 *
 * ⚠ AND THE PERSON PAYING FOR IT was a crowd contributor on a phone on the worst connection anyone
 * in this system has, while the researcher's own uploads — laptop, wifi — were the adaptive ones.
 *
 * The fix was not new code: the loop now lives ONCE, in upload.js, and the crowd path is its third
 * caller. So this file tests the SHARED loop's behaviour for real (a fake transport, no network)
 * plus the crowd-specific wiring that the loop deliberately knows nothing about.
 *
 * ⚠ THE CONSTRAINT THAT MAKES THIS EASY TO GET WRONG: Drive's resumable protocol requires every
 * chunk but the last to be a multiple of 256 KiB. A "just make it smaller" fix that ignored that
 * would 400 on the SECOND chunk — invisible to any test that only counts calls.
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runChunkedUpload } from '../docs/js/upload.js';

const UNIT = 262144;
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const parseRange = (range) => {
  const probe = /^bytes \*\/(\d+)$/.exec(range);
  if (probe) return { probe: true, total: +probe[1] };
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
  return m ? { from: +m[1], to: +m[2], total: +m[3] } : null;
};

/* A fake Drive: tracks its own received count, and lets a test script dictate what each PUT does. */
function fakeTransport(script = []) {
  const calls = [];
  let received = 0;
  let sessions = 0;
  const io = {
    calls,
    sessionCount: () => sessions,
    openSession: async () => { sessions++; return 'S' + sessions; },
    put: async (id, range, body) => {
      const r = parseRange(range);
      calls.push({ id, ...r, bytes: r && r.probe ? 0 : (r.to - r.from + 1) });
      if (r.probe) return received >= r.total ? { done: true, fileId: 'F' } : { received };
      const verdict = script.shift() || 'ok';
      if (verdict === 'fail') return { fail: true };
      if (verdict === 'gone') return { gone: true };
      received = r.to + 1;
      return received >= r.total ? { done: true, fileId: 'F' } : { received };
    },
  };
  return io;
}

const run = (total, io, extra = {}) => runChunkedUpload({
  total,
  slice: (a, b) => ({ size: b - a }),
  openSession: io.openSession,
  put: io.put,
  ...extra,
});

test('crowd chunk policy', async () => {
  console.log('\na failing chunk is retried SMALLER, never at the same size');
  {
    const io = fakeTransport(['fail']);
    const r = await run(40 * UNIT, io);
    const sends = io.calls.filter((c) => !c.probe);
    ok(r.done === true, 'it still completes');
    ok(sends.length >= 2, 'the failed slice is re-sent');
    ok(sends[1].bytes < sends[0].bytes,
       `the retry is SMALLER (${sends[0].bytes} -> ${sends[1].bytes}) — the whole point of the fix`);
    ok(sends[1].bytes === Math.max(2 * UNIT, Math.floor(sends[0].bytes / 2 / UNIT) * UNIT),
       '...and it is halved, floored to 256 KiB, never below the 512 KiB minimum');
  }

  console.log('\nprogress is reported BEFORE the end — the "hung at 0%" bug');
  {
    /* A 1 MiB submission is well under the old 16 MiB single-POST threshold, so on the old path it
     * reported nothing whatsoever until it was already finished. */
    const io = fakeTransport();
    const seen = [];
    const r = await run(4 * UNIT, io, { onProgress: (sent, total) => seen.push(sent / total) });
    ok(r.done === true, 'a small submission still completes');
    const beforeEnd = seen.filter((f) => f > 0 && f < 1);
    ok(beforeEnd.length > 0, 'it reports real movement before it is done, not one jump at the end');
    ok(seen[seen.length - 1] === 1, '...and finishes at 100%');
  }

  console.log('\nevery chunk but the last is a multiple of 256 KiB (Drive refuses otherwise)');
  {
    const io = fakeTransport(['fail', 'fail']);
    await run(37 * UNIT + 991, io);          // deliberately NOT unit-aligned
    const sends = io.calls.filter((c) => !c.probe);
    const bad = sends.slice(0, -1).filter((c) => c.bytes % UNIT !== 0);
    ok(bad.length === 0, `all ${sends.length - 1} non-final chunks are unit-aligned`);
  }

  console.log('\nthe resume starts from the SERVER\'s byte count, not from zero');
  {
    const io = fakeTransport();
    const seen = [];
    // Pretend Drive already holds the first half.
    let firstProbe = true;
    const put = async (id, range, body) => {
      const r = parseRange(range);
      if (r.probe && firstProbe) { firstProbe = false; return { received: 20 * UNIT }; }
      return io.put(id, range, body);
    };
    const r = await runChunkedUpload({
      total: 40 * UNIT, slice: (a, b) => ({ size: b - a }),
      openSession: io.openSession, put,
      onProgress: (sent, total) => seen.push(sent / total),
    });
    ok(r.done === true, 'it completes from the resumed position');
    ok(seen[0] === 0.5, 'the FIRST thing painted is where it really is, not a stale 0%');
    const sends = io.calls.filter((c) => !c.probe);
    ok(sends.every((c) => c.from >= 20 * UNIT), 'and no already-delivered byte is sent again');
  }

  /* ⚠ THE TURNSTILE CAP. Opening a crowd session spends a bot-check — one per submission. A loop
   * that reopened freely would burn the visitor's checks and read as abuse from the server side. */
  console.log('\nsession restarts are BOUNDED — each one costs the visitor a bot-check');
  {
    const io = fakeTransport(Array(20).fill('gone'));
    const r = await run(40 * UNIT, io);
    ok(r.done !== true, 'a permanently dead session gives up rather than spinning');
    ok(r.stalled === true, '...as STALLED, so the caller keeps the item and retries later');
    ok(io.sessionCount() <= 2, `at most two sessions were opened (${io.sessionCount()})`);
  }

  /* ⚠ A REFUSAL IS AN ANSWER, NOT A FAILURE. paused / budget / too_large / turnstile_failed must
   * reach the visitor as their own message, and must not be retried five times first. */
  console.log('\na permanent refusal propagates instead of being retried');
  {
    const io = fakeTransport();
    io.openSession = async () => { const e = new Error('budget'); e.code = 'budget'; throw e; };
    let caught = null;
    try { await run(40 * UNIT, io); } catch (e) { caught = e; }
    ok(caught && caught.code === 'budget', 'the worker\'s error keyword survives, uncaught by the loop');
  }

  console.log('\nthe crowd path is wired to the SHARED loop, and keeps what only it knows');
  {
    const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
    const upload = readFileSync(new URL('../docs/js/upload.js', import.meta.url), 'utf8');

    ok(/runChunkedUpload/.test(app) && /from '\.\/upload\.js'/.test(app),
       'app.js imports the loop from upload.js');
    /* ⚠ upload.js was ALREADY a top-level import of app.js, so this added no new SHELL entry. A new
     * module would have had to be added to all four sw.js files in the same commit — the v108
     * outage. Pinned here because "put the shared thing in a new file" is the obvious wrong move. */
    ok(!/from '\.\/chunk[^']*\.js'/.test(app), 'and NOT from a new module, which would be a new SHELL entry');

    ok(!/CROWD_CHUNK_SINGLE_MAX/.test(app), 'the 16 MiB single-POST path is gone — it could show no progress');
    ok(!/const CROWD_CHUNK = /.test(app), 'and so is the fixed 8 MiB chunk size');
    ok(/crowdSetProgress/.test(app) && /onProgress: crowdSetProgress/.test(app),
       'the visitor sees per-chunk progress');

    // Permanent refusals are the one thing the shared loop cannot know about.
    ok(/const CROWD_PERMANENT = \[/.test(app), 'the crowd path names its permanent refusals');
    for (const code of ['too_large', 'paused', 'budget', 'turnstile_failed']) {
      ok(new RegExp(`'${code}'`).test(app.slice(app.indexOf('CROWD_PERMANENT'), app.indexOf('CROWD_PERMANENT') + 400)),
         `  ...including ${code}`);
    }
    ok(/if \(CROWD_PERMANENT\.includes\(out\.error\)\) \{ const e = new Error\(out\.error\); e\.code = out\.error; throw e; \}/.test(app),
       'and throws them rather than returning { fail: true } for a pointless halved retry');

    // The loop must not swallow what the caller has to see.
    const loop = upload.slice(upload.indexOf('export async function runChunkedUpload'));
    ok(!/try \{[\s\S]{0,400}io\.openSession\(\)/.test(loop),
       'the loop never catches openSession — a refusal is the caller\'s to interpret');
  }

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  /* ⚠ EXPLICIT EXIT. This file IMPORTS upload.js rather than only reading it as text — that is the
   * point, since the loop is tested by running it — and something in that module graph keeps node's
   * event loop alive, so the runner would otherwise hang after the last assertion. */
  process.exit(fail ? 1 : 0);
});
