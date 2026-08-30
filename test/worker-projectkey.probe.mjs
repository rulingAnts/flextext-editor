/* PROJECT-KEY BACKFILL — Phase 1, proven END TO END against the real worker + real local D1.
 *
 * What this arms: the operator backfill derives each device's Ki through the SAME escrow chain the
 * production worker would use (kr_server_enc -> Kr -> wrappedKis, and -> wrapped_privkey ->
 * member_key), wraps it under a freshly minted project Kp, self-verifies, and is idempotent — and a
 * device whose Ki is unreachable is SKIPPED, never fatal.
 *
 * ⚠ EVERYTHING IS SEEDED THROUGH PUBLIC APIs, not by writing D1 — the probe does exactly what the
 * real panel does: PUT settings with a wrappedKis entry, POST a pubkey + wrapped_privkey, POST a
 * member_key grant set. If those routes drift, this probe fails the way a real panel would break,
 * which is the point of probing over unit-testing.
 *
 * ⚠ THE PROBE CAN COMPUTE THE FIXTURE'S Kr because the rig seeds a FIXED one: KR = 32 bytes of 0x07
 * (worker-seed.mjs KR_PLAINTEXT — "a stable value keeps a failing run reproducible"). That is rig
 * state, worthless outside it.
 *
 * Run: node test/worker-projectkey.probe.mjs http://127.0.0.1:8787   (normally via test/local-rig.sh)
 */
import { webcrypto as crypto } from 'node:crypto';
import { FIXTURE } from './worker-seed.mjs';

const BASE = process.argv[2] || process.env.FX_PROBE_BASE || 'http://127.0.0.1:8787';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const hdr = { 'x-fx-researcher': FIXTURE.researcherId, 'x-fx-secret': FIXTURE.researcherSecret, 'content-type': 'application/json' };
async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: hdr, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

/* ---- client-compatible crypto — docs/js/crypto.js's EXACT vocabulary: URL-SAFE UNPADDED base64.
 * ⚠ The first version of this probe used STANDARD base64 here, and that single line is why the rig
 * was green while the first production backfill derived zero devices: the fixtures replicated the
 * worker's wrong assumption instead of the client's real encoder. A probe's fixtures must be minted
 * the way the REAL client mints them, or the probe certifies the mock. */
const b64 = (u8) => Buffer.from(u8).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const KR_RAW = new Uint8Array(32).fill(7);                      // worker-seed.mjs KR_PLAINTEXT
const krKey = await crypto.subtle.importKey('raw', KR_RAW, { name: 'AES-GCM' }, false, ['encrypt']);
async function encryptJSONStd(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return b64(iv) + '.' + b64(new Uint8Array(ct));
}

console.log('\nproject-key backfill — Phase 1 (Kp minted, Ki wrapped via BOTH escrow paths, idempotent)');

/* Two fresh devices in the fixture's migrated project — one per derivation path. */
const mk = async (nick) => {
  const r = await call('POST', `/v1/projects/${FIXTURE.migratedProjectId}/instances`, { nickname: nick, type: 'editor' });
  ok(r.status === 200 && r.json && r.json.instance_id, `created device "${nick}" in the migrated project (got ${r.status})`);
  return r.json && r.json.instance_id;
};
const devA = await mk('pk-path-wrappedKis');
const devB = await mk('pk-path-memberKey');
const devC = await mk('pk-underivable');

/* Path A seeding — a wrappedKis entry, exactly as the legacy client stores Ki under Kr. */
const kiA = crypto.getRandomValues(new Uint8Array(32));
{
  const v = await call('GET', '/v1/researcher');
  const settings = (v.json && v.json.settings && JSON.parse(v.json.settings)) || {};
  settings.wrappedKis = settings.wrappedKis || {};
  settings.wrappedKis[devA] = await encryptJSONStd(krKey, { k: b64(kiA) });
  const put = await call('PUT', '/v1/researcher/settings', { settings, settings_rev: v.json.settings_rev });
  ok(put.status === 200, `path A: wrappedKis[devA] stored through the real settings route (got ${put.status})`);
}

/* Path B seeding — researcher keypair (privkey escrowed under Kr) + an owner member_key grant. */
const kiB = crypto.getRandomValues(new Uint8Array(32));
{
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['encrypt', 'decrypt']);
  const pub = b64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));
  const pkcs8 = b64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)));
  const wrappedPriv = await encryptJSONStd(krKey, { pkcs8 });
  const pk = await call('POST', '/v1/researcher/pubkey', { pubkey: pub, wrapped_privkey: wrappedPriv });
  ok(pk.status === 200, `path B: pubkey + Kr-escrowed privkey published (got ${pk.status})`);
  const wrappedKi = b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pair.publicKey, kiB)));
  const grant = await call('POST', '/v1/researcher/keys',
    { instance_id: devB, grants: [{ researcher_id: FIXTURE.researcherId, wrapped_ki: wrappedKi }] });
  ok(grant.status === 200, `path B: owner member_key grant written through the real keys route (got ${grant.status})`);
}
/* devC gets NOTHING — no wrappedKis entry, no grant. The chain must not reach it. */

/* ---- the backfill itself ---- */
const run1 = await call('POST', '/v1/researcher/admin/project-key-backfill', { project_id: FIXTURE.migratedProjectId });
ok(run1.status === 200 && run1.json && run1.json.ok, `backfill runs (got ${run1.status})`);
const proj = ((run1.json && run1.json.projects) || []).find((p) => p.project_id === FIXTURE.migratedProjectId) || { instances: [] };
const st = (id) => (proj.instances.find((i) => i.instance_id === id) || {});
ok(st(devA).status === 'wrapped' && st(devA).path === 'wrappedKis',
   `⚠ devA wrapped via the wrappedKis chain (got ${st(devA).status}/${st(devA).path || '-'})`);
ok(st(devB).status === 'wrapped' && st(devB).path === 'member_key',
   `⚠ devB wrapped via the member_key + escrowed-privkey chain (got ${st(devB).status}/${st(devB).path || '-'})`);
ok(st(devC).status === 'skipped_no_ki',
   `⚠ an unreachable Ki is SKIPPED, never fatal — one lost device must not stop the fleet (got ${st(devC).status})`);
ok(run1.json.totals && run1.json.totals.verify_failed === 0,
   `every stored wrap passed its round-trip self-verification (verify_failed=${run1.json.totals && run1.json.totals.verify_failed})`);

/* ---- idempotency: the second run must rewrite nothing ---- */
const run2 = await call('POST', '/v1/researcher/admin/project-key-backfill', { project_id: FIXTURE.migratedProjectId });
const proj2 = ((run2.json && run2.json.projects) || []).find((p) => p.project_id === FIXTURE.migratedProjectId) || { instances: [] };
const st2 = (id) => (proj2.instances.find((i) => i.instance_id === id) || {});
ok(st2(devA).status === 'already' && st2(devB).status === 'already',
   `⚠ re-run is a no-op for wrapped devices (got ${st2(devA).status}/${st2(devB).status})`);
ok(proj2.minted === false, 'and the second run minted no new Kp — one key per project, ever');

/* ---- VERIFY: ki_kp proven against real ciphertext under the SAME Ki ---- */
{
  /* Before any device-minted material exists, verify must answer 'no_ciphertext' — counted apart
   * from 'verified', so the summary never claims more than it measured. */
  const v1 = await call('POST', '/v1/researcher/admin/project-key-verify', { project_id: FIXTURE.migratedProjectId });
  ok(v1.status === 200 && v1.json && v1.json.ok, `verify runs (got ${v1.status})`);
  const vp = ((v1.json && v1.json.projects) || []).find((p) => p.project_id === FIXTURE.migratedProjectId) || { instances: [] };
  const vst = (id) => (vp.instances.find((i) => i.instance_id === id) || {});
  ok(vst(devA).ok === null && vst(devA).source === 'no_ciphertext',
     `⚠ with nothing to check against, verify says so instead of passing (got ${vst(devA).source})`);

  /* Now mint REAL ciphertext under the same Ki — an encrypted changeSettings command, exactly what
   * the panel sends — and verify must decrypt it with the Kp-unwrapped key. This is the arm that
   * catches a ki_kp holding a wrong-but-well-formed key, which the backfill's round-trip cannot. */
  const kiKeyA = await crypto.subtle.importKey('raw', kiA, { name: 'AES-GCM' }, false, ['encrypt']);
  const kiKeyB = await crypto.subtle.importKey('raw', kiB, { name: 'AES-GCM' }, false, ['encrypt']);
  for (const [dev, key] of [[devA, kiKeyA], [devB, kiKeyB]]) {
    const enc2 = await encryptJSONStd(key, { settings: { probe: true } });
    const c = await call('POST', `/v1/instances/${dev}/command`, { command: { type: 'changeSettings', enc: enc2 } });
    ok(c.status === 200, `enc command queued on ${dev === devA ? 'devA' : 'devB'} (got ${c.status})`);
  }
  const v2 = await call('POST', '/v1/researcher/admin/project-key-verify', { project_id: FIXTURE.migratedProjectId });
  const vp2 = ((v2.json && v2.json.projects) || []).find((p) => p.project_id === FIXTURE.migratedProjectId) || { instances: [] };
  const vst2 = (id) => (vp2.instances.find((i) => i.instance_id === id) || {});
  ok(vst2(devA).ok === true && vst2(devA).source === 'command',
     `⚠⚠ devA's ki_kp decrypts REAL ciphertext minted under the true Ki (got ${vst2(devA).ok}/${vst2(devA).source})`);
  ok(vst2(devB).ok === true,
     `⚠⚠ devB too — the member_key-derived wrap opens the same reality (got ${vst2(devB).ok})`);
  ok(v2.json.totals && v2.json.totals.failed === 0, `verify totals: failed=${v2.json.totals && v2.json.totals.failed}`);
}

/* ---- skip REASONS: the bare 'skipped_no_ki' cost a live investigation; the reason is now data ---- */
{
  const run3 = await call('POST', '/v1/researcher/admin/project-key-backfill', { project_id: FIXTURE.migratedProjectId });
  const p3 = ((run3.json && run3.json.projects) || []).find((p) => p.project_id === FIXTURE.migratedProjectId) || { instances: [] };
  const c3 = p3.instances.find((i) => i.instance_id === devC) || {};
  ok(Array.isArray(c3.reason) && c3.reason.includes('no_wrappedKis_entry') && c3.reason.includes('no_owner_grant'),
     `⚠ a skip carries its reasons (got ${JSON.stringify(c3.reason)}) — a keyless-by-design device is a sentence, not an investigation`);
}

/* ---- DIVERGED STORES: the class behind the 2026-08-30 stale-wrap incident ---- */
{
  /* devD: wrappedKis holds kiOld, the owner grant holds kiNew, and the device's real world speaks
   * kiNew (an enc command under it). The backfill must choose by EVIDENCE, not by which store is
   * cheapest to read — the first production run chose wrappedKis and shipped 10 stale wraps. */
  const devD = await mk('pk-diverged-with-material');
  const kiOld = crypto.getRandomValues(new Uint8Array(32));
  const kiNew = crypto.getRandomValues(new Uint8Array(32));
  {
    const v = await call('GET', '/v1/researcher');
    const settings = (v.json && v.json.settings && JSON.parse(v.json.settings)) || {};
    settings.wrappedKis = settings.wrappedKis || {};
    settings.wrappedKis[devD] = await encryptJSONStd(krKey, { k: b64(kiOld) });
    await call('PUT', '/v1/researcher/settings', { settings, settings_rev: v.json.settings_rev });
  }
  {
    const v2 = await call('GET', '/v1/researcher');   // the pubkey published earlier in this probe
    const pub = await crypto.subtle.importKey('spki', Buffer.from(String(v2.json.pubkey).replace(/-/g,'+').replace(/_/g,'/'), 'base64'),
      { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
    const wrappedKi = b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, kiNew)));
    const g = await call('POST', '/v1/researcher/keys', { instance_id: devD, grants: [{ researcher_id: FIXTURE.researcherId, wrapped_ki: wrappedKi }] });
    ok(g.status === 200, `diverged devD: grant with a DIFFERENT (newer) Ki written (got ${g.status})`);
  }
  const kiNewKey = await crypto.subtle.importKey('raw', kiNew, { name: 'AES-GCM' }, false, ['encrypt']);
  await call('POST', `/v1/instances/${devD}/command`, { command: { type: 'changeSettings', enc: await encryptJSONStd(kiNewKey, { s: 1 }) } });

  const rD = await call('POST', '/v1/researcher/admin/project-key-backfill', { project_id: FIXTURE.migratedProjectId });
  const pD = ((rD.json && rD.json.projects) || []).find((p) => p.project_id === FIXTURE.migratedProjectId) || { instances: [] };
  const dD = pD.instances.find((i) => i.instance_id === devD) || {};
  ok(dD.status === 'wrapped' && dD.path === 'member_key' && dD.proven === 'command',
     `⚠⚠ diverged stores: the key stored is the one REALITY opens, proven against real ciphertext (got ${dD.status}/${dD.path}/${dD.proven})`);
  const vD = await call('POST', '/v1/researcher/admin/project-key-verify', { project_id: FIXTURE.migratedProjectId });
  const vpD = ((vD.json && vD.json.projects) || []).find((p) => p.project_id === FIXTURE.migratedProjectId) || { instances: [] };
  const vdD = vpD.instances.find((i) => i.instance_id === devD) || {};
  ok(vdD.ok === true, `...and verify agrees (got ${vdD.ok})`);
}

/* ---- THE HEAL: a stored-stale wrap is REWRAPPED on the next run — the production incident, replayed ---- */
{
  /* devF starts wrappedKis-only (kiOld) with NO material: the backfill legitimately stores kiOld.
   * Then the world moves: a grant with kiNew appears and the device's lane speaks kiNew. The stored
   * wrap now contradicts reality, and the next backfill must REPLACE it — this is exactly how the
   * 10 stale production wraps healed. */
  const devF = await mk('pk-stale-then-heal');
  const kiOld = crypto.getRandomValues(new Uint8Array(32));
  const kiNew = crypto.getRandomValues(new Uint8Array(32));
  {
    const v = await call('GET', '/v1/researcher');
    const settings = (v.json && v.json.settings && JSON.parse(v.json.settings)) || {};
    settings.wrappedKis = settings.wrappedKis || {};
    settings.wrappedKis[devF] = await encryptJSONStd(krKey, { k: b64(kiOld) });
    await call('PUT', '/v1/researcher/settings', { settings, settings_rev: v.json.settings_rev });
  }
  const r1 = await call('POST', '/v1/researcher/admin/project-key-backfill', { project_id: FIXTURE.migratedProjectId });
  const p1 = ((r1.json && r1.json.projects) || []).find((p) => p.project_id === FIXTURE.migratedProjectId) || { instances: [] };
  const f1 = p1.instances.find((i) => i.instance_id === devF) || {};
  ok(f1.status === 'wrapped' && f1.proven === 'none',
     `devF: with nothing to test against, the wrap is stored by precedence and SAYS it is unproven (got ${f1.status}/${f1.proven})`);

  {
    const v2 = await call('GET', '/v1/researcher');
    const pub = await crypto.subtle.importKey('spki', Buffer.from(String(v2.json.pubkey).replace(/-/g,'+').replace(/_/g,'/'), 'base64'),
      { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
    const wrappedKi = b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, kiNew)));
    await call('POST', '/v1/researcher/keys', { instance_id: devF, grants: [{ researcher_id: FIXTURE.researcherId, wrapped_ki: wrappedKi }] });
  }
  const kiNewKey = await crypto.subtle.importKey('raw', kiNew, { name: 'AES-GCM' }, false, ['encrypt']);
  await call('POST', `/v1/instances/${devF}/command`, { command: { type: 'changeSettings', enc: await encryptJSONStd(kiNewKey, { s: 2 }) } });

  const r2 = await call('POST', '/v1/researcher/admin/project-key-backfill', { project_id: FIXTURE.migratedProjectId });
  const p2 = ((r2.json && r2.json.projects) || []).find((p) => p.project_id === FIXTURE.migratedProjectId) || { instances: [] };
  const f2 = p2.instances.find((i) => i.instance_id === devF) || {};
  ok(f2.status === 'rewrapped' && f2.path === 'member_key' && f2.proven === 'command',
     `⚠⚠ THE HEAL: a stored wrap contradicted by reality is REPLACED with the proven key (got ${f2.status}/${f2.path}/${f2.proven})`);
  ok(r2.json.totals && typeof r2.json.totals.rewrapped === 'number' && r2.json.totals.rewrapped >= 1,
     `...and the run reports it as rewrapped (totals.rewrapped=${r2.json.totals && r2.json.totals.rewrapped})`);
  const v3 = await call('POST', '/v1/researcher/admin/project-key-verify', { project_id: FIXTURE.migratedProjectId });
  const vp3 = ((v3.json && v3.json.projects) || []).find((p) => p.project_id === FIXTURE.migratedProjectId) || { instances: [] };
  const vf3 = vp3.instances.find((i) => i.instance_id === devF) || {};
  ok(vf3.ok === true, `...and verify confirms the healed wrap opens reality (got ${vf3.ok})`);
}

/* ---- authorization: the outsider (non-operator) is refused ---- */
{
  const r = await fetch(BASE + '/v1/researcher/admin/project-key-backfill', {
    method: 'POST',
    headers: { 'x-fx-researcher': FIXTURE.outsiderId, 'x-fx-secret': FIXTURE.outsiderSecret, 'content-type': 'application/json' },
    body: '{}',
  });
  ok(r.status === 403, `⚠ a non-operator cannot run the backfill (got ${r.status})`);
  const rv = await fetch(BASE + '/v1/researcher/admin/project-key-verify', {
    method: 'POST',
    headers: { 'x-fx-researcher': FIXTURE.outsiderId, 'x-fx-secret': FIXTURE.outsiderSecret, 'content-type': 'application/json' },
    body: '{}',
  });
  ok(rv.status === 403, `⚠ ...nor the verify (got ${rv.status})`);
}

/* ---- and the route is genuinely INERT for everyone else: nothing new leaked into the poll ---- */
{
  const v = await call('GET', '/v1/researcher');
  const raw = JSON.stringify(v.json || {});
  ok(!/ki_kp|kp_enc|project_key/.test(raw),
     '⚠ Phase 1 is inert — no Kp material or column name appears in the researcher poll');
}

console.log(fail ? `\n${fail} FAILED` : '\nPASS');
process.exit(fail ? 1 : 0);
