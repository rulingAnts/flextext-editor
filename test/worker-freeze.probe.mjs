/* THE MAINTENANCE FREEZE, END TO END (Seth, 2026-08-26): two independent ops flags — `maintenance`
 * is a banner and nothing else; `freeze` is a banner PLUS a write lock on the RESEARCHER lane, for
 * deploys that are extra risky, only testable in production, and may need rolling back — where a
 * researcher moving texts mid-rollout adds exactly the entropy a rollback would then have to
 * distinguish from the change under test.
 *
 * What it pins, in the order it matters:
 *   · a frozen researcher mutation answers 423 maintenance_freeze (NOT 5xx — the client api()
 *     retries 5xx through its whole backoff ladder before telling the human anything);
 *   · reads stay open, and the freeze value rides the researcher poll so the panel can banner it;
 *   · the OPERATOR is exempt — the flag exists FOR their production test;
 *   · a headerless (device/install-lane) request never meets the gate — a field translator
 *     uploading hours of work must not know the freeze exists;
 *   · signout stays open — nobody is locked INTO a session;
 *   · clearing the flag restores everything, and both raise and clear are operator-logged.
 *
 * ⚠ RUNS LAST in local-rig.sh, deliberately: it freezes the worker mid-probe, and although it
 * clears the flag on every path, a crash between raise and clear must not poison earlier suites.
 *
 * Run: bash test/local-rig.sh   (or: node test/worker-freeze.probe.mjs http://127.0.0.1:8787)
 */
import { FIXTURE } from './worker-seed.mjs';

const BASE = process.argv[2] || process.env.FX_PROBE_BASE || 'http://127.0.0.1:8787';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const OWNER = { 'x-fx-researcher': FIXTURE.researcherId, 'x-fx-secret': FIXTURE.researcherSecret };
const GUEST = { 'x-fx-researcher': FIXTURE.outsiderId, 'x-fx-secret': FIXTURE.outsiderSecret };

async function call(method, path, headers, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

const setFlag = (key, value) => call('POST', '/v1/researcher/admin/ops-flag', OWNER, { key, value });

console.log(`maintenance freeze → ${BASE}\n`);

try {
  console.log('baseline: an ordinary researcher can mutate while nothing is raised');
  {
    const r = await call('POST', '/v1/instances', GUEST, { type: '', nickname: 'Pre-Freeze Device' });
    ok(r.status === 200, `guest device create is 200 before the freeze (got ${r.status})`);
  }

  console.log('\nthe flag route itself is OPERATOR-ONLY and allow-listed');
  {
    const g = await call('POST', '/v1/researcher/admin/ops-flag', GUEST, { key: 'freeze', value: 'nope' });
    ok(g.status === 403, `a non-operator cannot raise a flag (got ${g.status})`);
    const badkey = await call('POST', '/v1/researcher/admin/ops-flag', OWNER, { key: 'settings_blob', value: 'x' });
    ok(badkey.status === 400, `an un-allow-listed key is refused — this is not a generic k/v write (got ${badkey.status})`);
  }

  console.log('\nRAISED: researcher writes lock, reads and the banner stay open');
  {
    const up = await setFlag('freeze', 'Testing a risky change — back soon.');
    ok(up.status === 200, `the operator raises the freeze (got ${up.status})`);

    const w = await call('POST', '/v1/instances', GUEST, { type: '', nickname: 'Frozen Device' });
    ok(w.status === 423, `⚠ a guest mutation is 423 Locked (got ${w.status}) — not 5xx, which the client would retry blindly`);
    ok(w.json && w.json.error === 'maintenance_freeze' && /risky change/.test(w.json.message || ''),
       'and the refusal carries the operator\'s own message');

    const g = await call('GET', '/v1/researcher', GUEST);
    ok(g.status === 200, `reads stay open while frozen (got ${g.status})`);
    ok(g.json && g.json.freeze === 'Testing a risky change — back soon.',
       '⚠ and the freeze value rides the poll — the panel banners it before anyone loses a click');

    const cmd = await call('POST', `/v1/instances/${FIXTURE.movedDeviceId}/command`, GUEST, { command: { type: 'x', enc: 'x' } });
    ok(cmd.status === 423, `the command lane is frozen too (got ${cmd.status})`);

    const own = await call('POST', '/v1/instances', OWNER, { type: '', nickname: 'Operator During Freeze' });
    ok(own.status === 200, `⚠ the OPERATOR still mutates — the flag exists for their test (got ${own.status})`);

    /* No x-fx-researcher header ⇒ the gate never fires: the request falls through to ordinary
     * auth and dies its ordinary 401 — proof the DEVICE lanes cannot meet the freeze. */
    const device = await call('POST', `/v1/instances/${FIXTURE.movedDeviceId}/command`, null, { command: { type: 'x' } });
    ok(device.status === 401, `⚠ a headerless (device-lane) request is untouched by the gate — ordinary 401, never 423 (got ${device.status})`);

    const out = await call('POST', '/v1/researcher/signout', GUEST, {});
    ok(out.status !== 423, `signout is exempt — nobody is locked INTO a session (got ${out.status})`);
  }

  console.log('\nCLEARED: everything returns, and the acts are on the record');
  {
    const down = await setFlag('freeze', '');
    ok(down.status === 200, `the operator clears the freeze (got ${down.status})`);
    const w = await call('POST', '/v1/instances', GUEST, { type: '', nickname: 'Post-Freeze Device' });
    ok(w.status === 200, `guest mutation works again (got ${w.status})`);
    const logs = await call('GET', '/v1/researcher/approvals?limit=20', OWNER);
    const kinds = ((logs.json && logs.json.approvals) || []).map((x) => x.kind);
    ok(kinds.includes('ops_flag_raised') && kinds.includes('ops_flag_cleared'),
       'raise and clear are both operator-logged (the freeze is itself an auditable act)');
  }
} finally {
  // ⚠ Whatever happened above, never leave the rig frozen for a later suite or a --keep session.
  await setFlag('freeze', '').catch(() => {});
}

console.log(fail ? `\n${fail} FAILED\n` : '\nPASS\n');
process.exit(fail ? 1 : 0);
