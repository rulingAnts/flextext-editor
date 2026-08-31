/* UPLOADING A TEXT TO A PROJECT, NOT TO A DEVICE (issue #4) — the routes, and their boundaries.
 *
 * The ask: "I see that you can un-assign a text from a device so that it is associated with the
 * project but no device. I would like to be able to upload a text to that place… At a later time, I
 * can move/assign it to the device of my choice."
 *
 * ⚠ WHAT THIS RIG CAN AND CANNOT PROVE. There is no Google here — the fixture researcher has no
 * usable Drive token — so every route that reaches Drive answers 502 rather than 200, and the bytes
 * are tested by the deploy, not here. What IS provable hermetically is the half that decides whether
 * this is SAFE to deploy at all: routing, project resolution, authorization, and the input gates,
 * all of which run BEFORE the first Drive call. A 502 from these routes is therefore a PASS signal —
 * it means the request was accepted and got as far as Drive — while 401/403/404/400 are the
 * refusals whose exact placement matters.
 *
 * Run: bash test/local-rig.sh
 */
import { FIXTURE } from './worker-seed.mjs';

const BASE = process.argv[2] || process.env.FX_PROBE_BASE || 'http://127.0.0.1:8787';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

async function call(method, path, body, auth = true) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(auth ? { 'x-fx-researcher': FIXTURE.researcherId, 'x-fx-secret': FIXTURE.researcherSecret } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

console.log(`project-scoped text upload → ${BASE}\n`);

/* The seeded MIGRATED project — one that has a Drive folder id, which is what this lane routes on.
 * Taken from the fixture rather than from the estate: the estate is a Drive SEARCH and there is no
 * Google in the rig, so the API cannot hand one back. */
const projectFolder = 'rig-drive-folder-migrated';
const unmigratedProject = null;   // the fixture's other project has NULL drive_folder_id by design
console.log(`(project drive folder: ${projectFolder})`);

console.log('\nthe routes exist and are reached only through a REAL project folder');
{
  const bogus = await call('POST', '/v1/projects/not-a-real-folder/texts/doc-probe-1/begin', { title: 'x' });
  ok(bogus.status === 404, `an unknown project folder is 404, never a create (got ${bogus.status})`);
  const noAuth = await call('POST', `/v1/projects/${projectFolder}/texts/doc-probe-1/begin`, { title: 'x' }, false);
  ok(noAuth.status === 401, `an unauthenticated caller is 401 (got ${noAuth.status})`);
  /* ⚠ NO ENUMERATION ORACLE. Caught by this probe on the first run: the project lookup ran BEFORE
   * authentication, so a stranger got 404 for an unknown folder id and 401 for a real one — which
   * is a free "does this project exist?" test against someone else's Drive. Identity is checked
   * first now, so both answers are identical to anyone not signed in. */
  const strangerUnknown = await call('POST', '/v1/projects/definitely-not-a-folder/texts/doc-probe-1/begin', { title: 'x' }, false);
  ok(strangerUnknown.status === noAuth.status,
     `a stranger cannot tell a real project from a fake one (${strangerUnknown.status} === ${noAuth.status})`);
}

console.log('\ninput gates run BEFORE any Drive work');
{
  {
    const badKind = await call('POST', `/v1/projects/${projectFolder}/texts/doc-probe-2/upload/start`,
      { name: 'a.wav', mime: 'audio/wav', size: 1000, kind: 'nonsense' });
    ok(badKind.status === 400 && badKind.json.error === 'bad_kind',
       `an unknown kind is refused up front (got ${badKind.status} ${badKind.json && badKind.json.error})`);
    const badSize = await call('POST', `/v1/projects/${projectFolder}/texts/doc-probe-2/upload/start`,
      { name: 'a.wav', mime: 'audio/wav', size: 0, kind: 'audio' });
    ok(badSize.status === 400 && badSize.json.error === 'bad_size',
       `a zero size is refused up front (got ${badSize.status} ${badSize.json && badSize.json.error})`);
    /* ⚠ 'consent-prompt' MUST NOT BE ACCEPTED HERE. A prompt is per-DEVICE and this lane has no
     * device; accepting it on the device lane's role table would have written a prompt into a
     * project with nothing to play it. */
    const prompt = await call('POST', `/v1/projects/${projectFolder}/texts/doc-probe-2/upload/start`,
      { name: 'p.mp3', mime: 'audio/mpeg', size: 1000, kind: 'consent-prompt' });
    ok(prompt.status === 400 && prompt.json.error === 'bad_kind',
       `⚠ consent-prompt is NOT a project kind (got ${prompt.status} ${prompt.json && prompt.json.error})`);
  }
}

console.log('\na chunk cannot be relayed with someone else\'s (or a forged) session');
{
  {
    const res = await fetch(`${BASE}/v1/projects/${projectFolder}/texts/doc-probe-3/upload/chunk`, {
      method: 'PUT',
      headers: {
        'x-fx-researcher': FIXTURE.researcherId, 'x-fx-secret': FIXTURE.researcherSecret,
        'x-fx-upload': 'not-a-real-encrypted-session', 'x-fx-range': 'bytes */10',
      },
    });
    ok(res.status === 403, `a forged upload session is 403 bad_upload (got ${res.status})`);
  }
}

console.log('\nthe Drive leg is REACHED (502 here means routing + auth + gates all passed)');
{
  {
    const begun = await call('POST', `/v1/projects/${projectFolder}/texts/doc-probe-4/begin`, { title: 'Probe Text' });
    ok(begun.status === 502 || begun.status === 200,
       `begin got past authorization to Drive (got ${begun.status}${begun.status === 502 ? ' — expected without Google in the rig' : ''})`);
    ok(begun.status !== 401 && begun.status !== 403 && begun.status !== 404,
       '...and was NOT refused — the project lane authorizes the owner for a brand-new doc');
    const started = await call('POST', `/v1/projects/${projectFolder}/texts/doc-probe-4/upload/start`,
      { name: 'a.wav', mime: 'audio/wav', size: 4096, kind: 'audio' });
    ok(started.status === 502 || started.status === 200,
       `upload/start likewise reached Drive (got ${started.status})`);
  }
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASSED');
process.exit(fail ? 1 : 0);
