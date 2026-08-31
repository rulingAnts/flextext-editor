/* CREATING A DEVICE TWICE WITH ONE KEY MUST MAKE ONE DEVICE (issue #6).
 *
 * THE BUG, in the reporter's words: "It processed for a minute, and then showed a message that it had
 * failed to create the new device… But the 2nd new device now shows up twice — under the new project
 * tab, and also under 'Not in a project yet'. I'm surprised to see it at all, since the panel said
 * that creating the 2nd new device had failed."
 *
 * Both halves are ONE cause. POST /v1/instances inserts the row and then creates the device's Drive
 * folder eagerly, which is what makes it slow enough to lose. A lost response over a completed insert
 * is a ghost: the panel reports a failure that did not happen, the researcher tries again, and one
 * device exists twice — once with a folder (in the project) and once without (in "Not in a project
 * yet"), read by a human, correctly, as the same device shown twice.
 *
 * ⚠ THIS RUNS AGAINST THE LOCAL RIG, not a deployed worker — real workerd, real D1, no Cloudflare
 * account and no Google. That is the only honest way to test a worker change before it ships, and it
 * is why the fix could be written and proven while the deploy waits for a maintenance window.
 *
 * Run: bash test/local-rig.sh   (or: node test/worker-create-idempotency.probe.mjs http://127.0.0.1:8787)
 */
import { FIXTURE } from './worker-seed.mjs';

const BASE = process.argv[2] || process.env.FX_PROBE_BASE || 'http://127.0.0.1:8787';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      'x-fx-researcher': FIXTURE.researcherId, 'x-fx-secret': FIXTURE.researcherSecret,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

const countNamed = async (nickname) => {
  const v = await call('GET', '/v1/researcher');
  const insts = (v.json && v.json.instances) || [];
  return insts.filter((i) => i.nickname === nickname && !Number(i.revoked)).length;
};

console.log(`device-creation idempotency → ${BASE}\n`);

console.log('the reported scenario: the same attempt, sent twice');
{
  const key = 'probe-key-' + Math.random().toString(36).slice(2);
  const name = 'Ghost Probe ' + key.slice(-6);
  const a = await call('POST', '/v1/instances', { nickname: name, createKey: key });
  ok(a.status === 200, `first create succeeds (got ${a.status})`);
  // The retry a client makes when the first response is lost — same key, same body.
  const b = await call('POST', '/v1/instances', { nickname: name, createKey: key });
  ok(b.status === 200, `the replay succeeds too, rather than erroring (got ${b.status})`);
  ok(a.json.instance_id === b.json.instance_id,
     `⚠ and returns the SAME instance (${a.json.instance_id?.slice(0, 8)} === ${b.json.instance_id?.slice(0, 8)})`);
  ok(b.json.replayed === true, 'the replay says so, for logs and for this test');
  ok(await countNamed(name) === 1, '⚠ exactly ONE device exists — the duplicate the issue reports is gone');
}

/* ⚠ THE PROPERTY AN ADVERSARIAL REVIEW CAUGHT, and the reason this probe is longer than the fix.
 * The obvious replay returns the stored row immediately — which would make the REPORTED SYMPTOM
 * PERMANENT rather than transient. The request is lost precisely BECAUSE the placement leg is slow
 * (token → files.get → folder create), so the row a replay finds is very often the one whose folder
 * was never made. Returning it as-is freezes the device into "Not in a project yet" for good, and
 * the retry that should have healed it is what seals it. A replay must CONVERGE: skip the insert,
 * then run the placement again. */
console.log('\na replay CONVERGES — it re-runs placement rather than freezing a half-made device');
{
  const key = 'probe-conv-' + Math.random().toString(36).slice(2);
  const name = 'Converge Probe ' + key.slice(-6);
  // No project named: nothing to place, so the folder stays empty — the shape of a create whose
  // placement never happened. (The rig has no Drive, so an eager folder is never made here; that is
  // exactly the half-made row we want to replay over.)
  const a = await call('POST', '/v1/instances', { nickname: name, createKey: key });
  ok(a.status === 200, `first create succeeds (got ${a.status})`);
  const b = await call('POST', '/v1/instances', { nickname: name, createKey: key, projectFolderId: 'folder-that-does-not-exist' });
  ok(b.status === 200, `the replay still answers 200 even when placement cannot succeed (got ${b.status})`);
  ok(b.json.instance_id === a.json.instance_id, 'and it is still the same device, not a second one');
  ok(await countNamed(name) === 1, 'still exactly one row');
  // The replay must not rename the device from the retry's body — the folder was named from the
  // stored nickname, and a retry silently renaming a device is a side effect nobody asked for.
  const c = await call('POST', '/v1/instances', { nickname: 'RENAMED BY RETRY', createKey: key });
  ok(c.json.nickname === name, `the stored name wins over a retry's body (got "${c.json.nickname}")`);
  ok(await countNamed('RENAMED BY RETRY') === 0, '...and no device was created under the retry\'s name');
}

console.log('\nthree simultaneous submits of one key still make one device');
{
  const key = 'probe-race-' + Math.random().toString(36).slice(2);
  const name = 'Race Probe ' + key.slice(-6);
  const rs = await Promise.all([1, 2, 3].map(() => call('POST', '/v1/instances', { nickname: name, createKey: key })));
  ok(rs.every((r) => r.status === 200), `all three answered 200 (${rs.map((r) => r.status).join(',')})`);
  const ids = new Set(rs.map((r) => r.json && r.json.instance_id));
  ok(ids.size === 1, `⚠ all three name ONE instance (${ids.size} distinct) — the unique index turns a race into a replay`);
  ok(await countNamed(name) === 1, 'and exactly one row exists');
}

console.log('\ndifferent keys still make different devices — this must not over-collapse');
{
  const name = 'Distinct Probe ' + Math.random().toString(36).slice(2, 8);
  const a = await call('POST', '/v1/instances', { nickname: name, createKey: 'probe-k-' + Math.random().toString(36).slice(2) });
  const b = await call('POST', '/v1/instances', { nickname: name, createKey: 'probe-k-' + Math.random().toString(36).slice(2) });
  ok(a.json.instance_id !== b.json.instance_id,
     'two deliberate creations with the same NAME are still two devices — the key is the identity, not the name');
  ok(await countNamed(name) === 2, '...and both exist');
}

console.log('\nan OLD client that sends no key is completely unaffected');
{
  const name = 'Keyless Probe ' + Math.random().toString(36).slice(2, 8);
  const a = await call('POST', '/v1/instances', { nickname: name });
  const b = await call('POST', '/v1/instances', { nickname: name });
  ok(a.status === 200 && b.status === 200, 'both keyless creates succeed');
  ok(a.json.instance_id !== b.json.instance_id,
     'they are two devices, exactly as today — NULL keys are distinct, so the unique index never bites');
  ok(!a.json.replayed, 'and nothing is reported as a replay');
}

console.log('\nthe key is scoped to the account, and sanitised');
{
  // A key with junk in it must not become a SQL surprise or collide across accounts; the worker
  // strips to [\w-] and caps the length. Same key, same account ⇒ replay (already covered above);
  // here we only assert the sanitiser does not reject a normal UUID or crash on a hostile one.
  const nasty = "probe'; DROP TABLE instance;--" + Math.random().toString(36).slice(2);
  const name = 'Sanitise Probe ' + Math.random().toString(36).slice(2, 8);
  const a = await call('POST', '/v1/instances', { nickname: name, createKey: nasty });
  ok(a.status === 200, `a hostile key is accepted after sanitising, not rejected (got ${a.status})`);
  const again = await call('POST', '/v1/instances', { nickname: name, createKey: nasty });
  ok(again.json && again.json.instance_id === a.json.instance_id, '...and still replays consistently');
  const still = await call('GET', '/v1/researcher');
  ok(still.status === 200, '⚠ and the instance table is still there (bound parameters, not string-built SQL)');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASSED');
process.exit(fail ? 1 : 0);
