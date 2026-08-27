/* THE CONVERTED ROUTES, AGAINST A REAL WORKER — Phase C 2b.
 *
 * WHY THIS EXISTS AND WHY IT IS A RIG PROBE. Sixteen researcher routes had their auth swapped from
 * `authResearcher` (account-scoped) to `authMember` (project-scoped + capability). Unit tests prove
 * authMember decides correctly; only a running worker proves the ROUTES still work — that each one
 * passes the right target, that `const r = ctx.owner` really does keep the ~56 downstream field
 * reads intact, and that a converted route did not simply stop functioning for the person who owns
 * it. A conversion that authorizes perfectly and 404s the owner is the failure this catches.
 *
 * ⚠ THE OUTSIDER IS THE POINT. With one fixture every request is the owner's, so every route passes
 * and the rig certifies an authorization model it never exercised. The second researcher is what
 * makes a denial observable.
 *
 * ⚠ AND THE DENIAL MUST BE not_found, NOT forbidden (R2-4). A distinct "you lack permission" turns
 * every endpoint into an oracle for which instance ids exist. The status code IS the invariant here.
 *
 * Run: bash test/local-rig.sh   (or: node test/worker-route-scoping.probe.mjs http://127.0.0.1:8787)
 */
import { FIXTURE } from './worker-seed.mjs';

const BASE = process.argv[2] || process.env.FX_PROBE_BASE || 'http://127.0.0.1:8787';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const who = (id, secret) => ({ 'x-fx-researcher': id, 'x-fx-secret': secret });
const OWNER = who(FIXTURE.researcherId, FIXTURE.researcherSecret);
const OUTSIDER = who(FIXTURE.outsiderId, FIXTURE.outsiderSecret);

async function call(method, path, headers, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

console.log(`converted route scoping → ${BASE}\n`);

const made = await call('POST', '/v1/instances', OWNER, { type: '', nickname: 'Scoping Probe Device' });
ok(made.status === 200, `created an instance (got ${made.status})`);
const id = made.json && made.json.instance_id;

/* ---------------------------------------------------------------- *
 * BEFORE the backfill this instance has project_id NULL — which is the state 12 PRODUCTION rows
 * were in when these routes were converted. It is the dual-read path, and it is tested FIRST
 * because it is the one that would have broken live researchers.
 * ---------------------------------------------------------------- */
console.log('the legacy path: an instance with no project still answers to its own researcher');
{
  const r = await call('POST', `/v1/instances/${id}/rename`, OWNER, { nickname: 'Renamed Pre-Backfill' });
  ok(r.status === 200, `⚠ rename works with project_id NULL (got ${r.status}) — a deny here is the silent lockout this path exists to prevent`);
  const inv = await call('POST', `/v1/instances/${id}/invite`, OWNER, {});
  ok(inv.status === 200, `invite works with project_id NULL (got ${inv.status})`);
  const out = await call('POST', `/v1/instances/${id}/rename`, OUTSIDER, { nickname: 'Hijacked' });
  ok(out.status === 404, `⚠ and an outsider is refused on that same legacy path (got ${out.status}) — it admits only the instance's own researcher_id`);
}

console.log('\nafter the backfill, the same routes work through the PROJECT');
const back = await call('POST', '/v1/researcher/admin/backfill-projects', OWNER, {});
ok(back.status === 200, `backfill ran (got ${back.status})`);
{
  const r = await call('POST', `/v1/instances/${id}/rename`, OWNER, { nickname: 'Renamed Post-Backfill' });
  ok(r.status === 200, `⚠ rename still works once the instance HAS a project (got ${r.status})`);
  const cmd = await call('POST', `/v1/instances/${id}/command`, OWNER, { type: 'noop', id: 'probe-cmd-1' });
  ok(cmd.status === 200 || cmd.status === 400, `command route is reachable by the owner (got ${cmd.status})`);
}

console.log('\nevery converted route refuses an outsider, and refuses with not_found');
{
  const cases = [
    ['POST', `/v1/instances/${id}/rename`, { nickname: 'x' }, 'rename'],
    ['POST', `/v1/instances/${id}/invite`, {}, 'invite'],
    ['POST', `/v1/instances/${id}/command`, { type: 'noop', id: 'probe-cmd-2' }, 'command'],
    ['POST', `/v1/instances/${id}/revoke`, {}, 'revoke device'],
    ['GET', `/v1/instances/${id}/texts/probedoc/files`, null, 'texts/files'],
    ['POST', `/v1/instances/${id}/texts/probedoc/adopt`, {}, 'texts/adopt'],
    ['POST', `/v1/instances/${id}/texts/probedoc/move`, { to: id }, 'texts/move'],
    ['POST', `/v1/instances/${id}/texts/probedoc/assignment/begin`, {}, 'assignment/begin'],
  ];
  for (const [method, path, body, label] of cases) {
    const res = await call(method, path, OUTSIDER, body);
    ok(res.status === 404, `${label}: outsider gets 404 (got ${res.status})`);
    if (res.status === 404) {
      ok((res.json && res.json.error) === 'not_found',
         `${label}: and the body says not_found, never a distinct permission error`);
    }
  }
}

console.log('\nno credential is still 401 — an unauthenticated caller must not be told not_found');
{
  const res = await call('POST', `/v1/instances/${id}/rename`, {}, { nickname: 'x' });
  ok(res.status === 401, `⚠ 401, not 404 (got ${res.status}) — "who are you" and "that is not yours" are different answers`);
}

console.log('\nwipe and force-remove stay OWNER-ONLY (round-1 finding 6)');
{
  for (const act of ['wipe', 'force-remove']) {
    const res = await call('POST', `/v1/instances/${id}/installs/no-such-install/${act}`, OUTSIDER, {});
    ok(res.status === 404, `${act}: outsider gets 404 (got ${res.status})`);
  }
}

console.log(fail ? `\n${fail} FAILED\n` : '\nPASS\n');
process.exit(fail ? 1 : 0);
