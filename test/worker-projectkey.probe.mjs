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

/* ---- A REAL REPORT: verify against the blob AS THE WORKER STORES IT, quotes and all ----
 * The first probe never created an install, so no device ever REPORTED, and every verify arm ran on
 * command-sourced material. That gap is exactly where the second production failure hid: the report
 * route stores JSON.stringify(body.reported) — the token wrapped in quotes — and verify read the raw
 * column. This arm walks the REAL pairing lane (invite -> claim -> approve -> accept -> report) and
 * posts the report the way sync.js does: body.reported = the bare "iv.ct" STRING, which the worker
 * then stringifies into storage. If verify ever stops unwrapping that, this arm goes red. */
{
  const inv = await call('POST', `/v1/instances/${devA}/invite`, {});
  ok(inv.status === 200 && inv.json && inv.json.invite_id, `invite minted for devA (got ${inv.status})`);
  const installId = crypto.randomUUID();
  const installSecret = 'pk-probe-install-' + crypto.randomUUID();
  const claim = await fetch(BASE + `/v1/invites/${inv.json.invite_id}/claim`, {
    method: 'POST',
    headers: { 'x-fx-invite-secret': inv.json.secret, 'content-type': 'application/json' },
    body: JSON.stringify({ install_id: installId, install_secret: installSecret, pubkey: 'FIXTURE-SPKI-BASE64' }),
  });
  ok(claim.status === 200, `claimed (got ${claim.status})`);
  await call('POST', `/v1/instances/${devA}/installs/${installId}/approve`, {});
  const DEVICE = { 'x-fx-install': installId, 'x-fx-secret': installSecret, 'content-type': 'application/json' };
  await fetch(BASE + `/v1/instances/${devA}/installs/${installId}/accept`, { method: 'POST', headers: DEVICE, body: '{}' });
  const kiKeyA2 = await crypto.subtle.importKey('raw', kiA, { name: 'AES-GCM' }, false, ['encrypt']);
  const reported = await encryptJSONStd(kiKeyA2, { device: 'pk-probe', texts: [] });   // the bare token, as sync.js sends it
  const rep = await fetch(BASE + `/v1/instances/${devA}/installs/${installId}/report`, {
    method: 'POST', headers: DEVICE, body: JSON.stringify({ reported, ack_seq: 0 }),
  });
  ok(rep.status === 200, `device reported real Ki-encrypted inventory (got ${rep.status})`);

  const vR = await call('POST', '/v1/researcher/admin/project-key-verify', { project_id: FIXTURE.migratedProjectId });
  const vpR = ((vR.json && vR.json.projects) || []).find((p) => p.project_id === FIXTURE.migratedProjectId) || { instances: [] };
  const vaR = vpR.instances.find((i) => i.instance_id === devA) || {};
  ok(vaR.ok === true && vaR.source === 'report',
     `⚠⚠ verify opens the report AS STORED — JSON-stringified, quotes unwrapped like the panel's safeParse (got ${vaR.ok}/${vaR.source})`);
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

/* ════════════════ PHASE 2 — the server-key lane (delegated approval) ════════════════
 *
 * The inversion the BACKLOG specifies: the approving researcher ASKS, and the WORKER mints the
 * install wrap itself from the instance's true Ki. These arms walk MEMBER-run enrolment end to
 * end — the outsider becomes a real project member, mints the invite, approves the claim, and
 * server-keys the install, with the owner never touching it — and then the refusals that keep the
 * lane honest: capability required, device acceptance required, a missing pubkey refused, and a
 * key contradicted by the instance's own ciphertext NEVER handed to an install. */
console.log('\nproject-key server-key — Phase 2 (worker-minted install wrap; member-run enrolment)');

const mhdr = { 'x-fx-researcher': FIXTURE.outsiderId, 'x-fx-secret': FIXTURE.outsiderSecret, 'content-type': 'application/json' };
async function mcall(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: mhdr, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

/* The device end of the lane, real keypair and all — reused by several arms. */
async function claimInstall(instanceId, viaMember, withPubkey = true) {
  const inv = viaMember
    ? await mcall('POST', `/v1/instances/${instanceId}/invite`, {})
    : await call('POST', `/v1/instances/${instanceId}/invite`, {});
  const pair = withPubkey ? await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['encrypt', 'decrypt']) : null;
  const installId = crypto.randomUUID();
  const installSecret = 'pk2-install-' + crypto.randomUUID();
  const body = { install_id: installId, install_secret: installSecret };
  if (pair) body.pubkey = b64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));
  const claim = await fetch(BASE + `/v1/invites/${inv.json.invite_id}/claim`, {
    method: 'POST',
    headers: { 'x-fx-invite-secret': inv.json.secret, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const DEVICE = { 'x-fx-install': installId, 'x-fx-secret': installSecret, 'content-type': 'application/json' };
  return { inviteOk: inv.status === 200, claimOk: claim.status === 200, installId, DEVICE, priv: pair && pair.privateKey };
}

let devG = null, kiG = null;   // shared with the Phase-2b grant-maintenance arms below
{
  /* devG: a device whose Ki lives only in an owner grant (the member-minted shape) with real
   * command material — then the whole enrolment, member seat only. */
  devG = await mk('pk2-member-enrols');
  kiG = crypto.getRandomValues(new Uint8Array(32));
  {
    const v2 = await call('GET', '/v1/researcher');
    const pub = await crypto.subtle.importKey('spki', Buffer.from(String(v2.json.pubkey).replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
      { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
    const wrappedKi = b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, kiG)));
    const g = await call('POST', '/v1/researcher/keys', { instance_id: devG, grants: [{ researcher_id: FIXTURE.researcherId, wrapped_ki: wrappedKi }] });
    ok(g.status === 200, `devG: Ki exists only as the owner grant, the member-minted shape (got ${g.status})`);
  }
  const kiGKey = await crypto.subtle.importKey('raw', kiG, { name: 'AES-GCM' }, false, ['encrypt']);
  await call('POST', `/v1/instances/${devG}/command`, { command: { type: 'changeSettings', enc: await encryptJSONStd(kiGKey, { vernLang: 'fau' }) } });

  const add = await call('POST', `/v1/projects/${FIXTURE.migratedProjectId}/members`,
    { researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true, createInvites: true } });
  ok(add.status === 200, `the outsider becomes a real member with device rights (got ${add.status})`);

  const d = await claimInstall(devG, true);
  ok(d.inviteOk && d.claimOk, `MEMBER minted the invite; a device with a real keypair claimed it`);

  const early = await mcall('POST', `/v1/instances/${devG}/installs/${d.installId}/server-key`, {});
  ok(early.status === 409 && early.json && early.json.error === 'not_accepted',
     `⚠ property B holds on the new lane: no key before the field user accepts (got ${early.status}/${early.json && early.json.error})`);

  const app = await mcall('POST', `/v1/instances/${devG}/installs/${d.installId}/approve`, {});
  ok(app.status === 200, `MEMBER approved the claim (got ${app.status})`);
  await fetch(BASE + `/v1/instances/${devG}/installs/${d.installId}/accept`, { method: 'POST', headers: d.DEVICE, body: '{}' });

  const sk = await mcall('POST', `/v1/instances/${devG}/installs/${d.installId}/server-key`, {});
  ok(sk.status === 200 && sk.json && sk.json.ok === true,
     `⚠⚠ MEMBER server-keyed the install — the worker minted the wrap; the owner never touched this enrolment (got ${sk.status})`);
  ok(sk.json && sk.json.proven === 'command',
     `...and the Ki it handed out was PROVEN against the instance's real ciphertext (proven=${sk.json && sk.json.proven})`);

  /* The device's own poll — the wrap must arrive, RSA-unwrap with the install's private key, and
   * byte-match the true Ki. This is the exact sequence an installed engine runs. */
  const poll = await fetch(BASE + `/v1/instances/${devG}?since=0`, { headers: d.DEVICE });
  const pj = await poll.json();
  ok(poll.status === 200 && pj && pj.wrapped_key, `the device's poll carries the worker-minted wrap (got ${poll.status})`);
  let kiBack = null;
  try {
    const ct = Buffer.from(String(pj.wrapped_key).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    kiBack = new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, d.priv, ct));
  } catch { /* kiBack stays null */ }
  ok(!!kiBack && kiBack.length === kiG.length && kiBack.every((x, i) => x === kiG[i]),
     `⚠⚠ the device unwrapped the TRUE Ki with its own private key — end-to-end, worker-minted, byte-identical`);

  const again = await mcall('POST', `/v1/instances/${devG}/installs/${d.installId}/server-key`, {});
  ok(again.status === 200, `server-key is idempotent — re-asking re-mints harmlessly (got ${again.status})`);

  /* The lazy heal: devG had no ki_kp (created after any backfill run touched it) — resolving it
   * for the install must have written one, and verify must find it opens reality. */
  const vz = await call('POST', '/v1/researcher/admin/project-key-verify', { project_id: FIXTURE.migratedProjectId });
  const vpz = ((vz.json && vz.json.projects) || []).find((p) => p.project_id === FIXTURE.migratedProjectId) || { instances: [] };
  const vgz = vpz.instances.find((i) => i.instance_id === devG) || {};
  ok(vgz.ok === true, `⚠ ki_kp was lazily written by the server-key lane, and it opens reality (got ${vgz.ok})`);

  /* Capability is load-bearing: drop manageDevices and the lane closes; restore and it reopens. */
  await call('POST', `/v1/projects/${FIXTURE.migratedProjectId}/members`,
    { researcher_id: FIXTURE.outsiderId, caps: { createInvites: true } });
  const noCap = await mcall('POST', `/v1/instances/${devG}/installs/${d.installId}/server-key`, {});
  ok(noCap.status === 404, `⚠ without manageDevices the lane answers 404 like everything else (got ${noCap.status})`);
  await call('POST', `/v1/projects/${FIXTURE.migratedProjectId}/members`,
    { researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true, createInvites: true } });
}

{
  /* The keyless-by-design class (the crowd-recorder-shaped instance): approval works, but the
   * worker REFUSES to invent a key — 'key_unavailable' is the permanent, correct answer, and the
   * reasons name why without a byte of key material. */
  const d = await claimInstall(devC, false);
  await call('POST', `/v1/instances/${devC}/installs/${d.installId}/approve`, {});
  await fetch(BASE + `/v1/instances/${devC}/installs/${d.installId}/accept`, { method: 'POST', headers: d.DEVICE, body: '{}' });
  const sk = await call('POST', `/v1/instances/${devC}/installs/${d.installId}/server-key`, {});
  ok(sk.status === 409 && sk.json && sk.json.error === 'key_unavailable',
     `⚠ a keyless-by-design instance fails CLOSED — no key is ever invented for it (got ${sk.status}/${sk.json && sk.json.error})`);
  ok(Array.isArray(sk.json && sk.json.reasons) && sk.json.reasons.length > 0,
     `...with reasons, never key material (${JSON.stringify((sk.json && sk.json.reasons) || [])})`);
}

{
  /* A key contradicted by the instance's own ciphertext is NEVER handed to an install — the
   * fail-closed rule, exercised on the lane that matters. devH's only derivable candidate is
   * kiOld, but its real world speaks kiHidden (a command under a key no store holds). */
  const devH = await mk('pk2-contradicted');
  const kiOld = crypto.getRandomValues(new Uint8Array(32));
  {
    const v = await call('GET', '/v1/researcher');
    const settings = (v.json && v.json.settings && JSON.parse(v.json.settings)) || {};
    settings.wrappedKis = settings.wrappedKis || {};
    settings.wrappedKis[devH] = await encryptJSONStd(krKey, { k: b64(kiOld) });
    await call('PUT', '/v1/researcher/settings', { settings, settings_rev: v.json.settings_rev });
  }
  const kiHidden = crypto.getRandomValues(new Uint8Array(32));
  const kiHiddenKey = await crypto.subtle.importKey('raw', kiHidden, { name: 'AES-GCM' }, false, ['encrypt']);
  await call('POST', `/v1/instances/${devH}/command`, { command: { type: 'changeSettings', enc: await encryptJSONStd(kiHiddenKey, { s: 3 }) } });
  const d = await claimInstall(devH, false);
  await call('POST', `/v1/instances/${devH}/installs/${d.installId}/approve`, {});
  await fetch(BASE + `/v1/instances/${devH}/installs/${d.installId}/accept`, { method: 'POST', headers: d.DEVICE, body: '{}' });
  const sk = await call('POST', `/v1/instances/${devH}/installs/${d.installId}/server-key`, {});
  ok(sk.status === 409 && sk.json && sk.json.error === 'key_unavailable'
     && (sk.json.reasons || []).includes('candidates_fail_reality'),
     `⚠⚠ a candidate the instance's own ciphertext refuses is NEVER handed to an install (got ${sk.status}/${JSON.stringify((sk.json && sk.json.reasons) || [])})`);
}

{
  /* An install claimed by an engine from before pubkeys existed: nothing to wrap to — say so. */
  const devI = await mk('pk2-no-pubkey');
  const kiI = crypto.getRandomValues(new Uint8Array(32));
  {
    const v = await call('GET', '/v1/researcher');
    const settings = (v.json && v.json.settings && JSON.parse(v.json.settings)) || {};
    settings.wrappedKis = settings.wrappedKis || {};
    settings.wrappedKis[devI] = await encryptJSONStd(krKey, { k: b64(kiI) });
    await call('PUT', '/v1/researcher/settings', { settings, settings_rev: v.json.settings_rev });
  }
  const d = await claimInstall(devI, false, false);   // no pubkey at claim
  await call('POST', `/v1/instances/${devI}/installs/${d.installId}/approve`, {});
  await fetch(BASE + `/v1/instances/${devI}/installs/${d.installId}/accept`, { method: 'POST', headers: d.DEVICE, body: '{}' });
  const sk = await call('POST', `/v1/instances/${devI}/installs/${d.installId}/server-key`, {});
  ok(sk.status === 409 && sk.json && sk.json.error === 'no_pubkey',
     `an install without a pubkey is refused plainly, not wrapped to nothing (got ${sk.status}/${sk.json && sk.json.error})`);
}

/* ════════════════ PHASE 2b — worker-maintained member_key grants ════════════════
 *
 * "When a device is created or a coworker added, the WORKER writes the member_key rows." These arms
 * prove the maintenance end to end from the MEMBER's side: the add response carries the summary,
 * the member's own key list fills in, the wrapped_ki actually decrypts to the TRUE Ki, the
 * keyless-by-design class is reported as its own category (never a failure, never a retry), and
 * re-sweeps are quiet. */
console.log('\nproject-key grant maintenance — Phase 2b (worker-written member_key rows)');

{
  /* The member publishes a pubkey (kept private-side here), like a real panel's first sign-in. */
  const mPair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['encrypt', 'decrypt']);
  const mPub = b64(new Uint8Array(await crypto.subtle.exportKey('spki', mPair.publicKey)));
  const pk = await fetch(BASE + '/v1/researcher/pubkey', {
    method: 'POST', headers: mhdr, body: JSON.stringify({ pubkey: mPub, wrapped_privkey: 'held-client-side-not-escrowed' }),
  });
  ok(pk.status === 200, `the member published a pubkey (got ${pk.status})`);

  /* Re-adding the member (an upsert) runs maintenance inline — the response says what happened. */
  const add = await call('POST', `/v1/projects/${FIXTURE.migratedProjectId}/members`,
    { researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true, createInvites: true } });
  const g = add.json && add.json.grants;
  ok(add.status === 200 && g && typeof g.granted === 'number',
     `⚠⚠ the add response carries the WORKER's grant summary (granted=${g && g.granted}, instances=${g && g.instances})`);
  ok(g && g.granted > 0, `...and the worker actually minted grants for the member (${g && g.granted})`);
  const keylessIds = ((g && g.keyless) || []).map((k) => k.instance_id);
  ok(keylessIds.includes(devC), `⚠ the keyless-by-design instance is its own CATEGORY, not a failure (keyless includes devC)`);

  /* The member's own key list — server truth — now covers the derivable devices... */
  const keys = await mcall('GET', '/v1/researcher/keys');
  const mine = new Set(((keys.json && keys.json.keys) || []).map((r) => r.instance_id));
  ok(mine.has(devA) && mine.has(devB), `the member now holds grants for the owner's devices (devA, devB)`);
  ok(!mine.has(devC), `...and none was invented for the keyless instance`);

  /* ...and the ciphertext is REAL: the devG grant decrypts to the byte-identical true Ki. */
  const rowG = ((keys.json && keys.json.keys) || []).find((r) => r.instance_id === devG);
  let kiBack = null;
  try {
    const ct = Buffer.from(String(rowG && rowG.wrapped_ki).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    kiBack = new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, mPair.privateKey, ct));
  } catch { /* kiBack stays null */ }
  ok(!!kiBack && kiBack.length === kiG.length && kiBack.every((x, i) => x === kiG[i]),
     `⚠⚠ the member's worker-minted grant decrypts to the TRUE Ki — byte-identical, end to end`);

  /* The owner's own grant is maintained too: devA was wrappedKis-only (no grant row existed), and
   * the wrap-to-owner invariant is now held by the worker itself. */
  const okeys = await call('GET', '/v1/researcher/keys');
  const oset = new Set(((okeys.json && okeys.json.keys) || []).map((r) => r.instance_id));
  ok(oset.has(devA), `⚠ the OWNER's own grant for a wrappedKis-only device was materialised (wrap-to-owner, worker-held)`);

  /* Re-sweeps are quiet: nothing granted twice, the keyless class never churns into retries. */
  const sw = await mcall('POST', `/v1/projects/${FIXTURE.migratedProjectId}/grant-sweep`, {});
  ok(sw.status === 200 && sw.json && sw.json.granted === 0 && sw.json.already > 0,
     `⚠ a re-sweep is idempotent — granted=0, already=${sw.json && sw.json.already}, keyless=${(sw.json && sw.json.keyless || []).length} (a sentence, not a retry loop)`);

  /* The sweep needs device rights like every other maintenance act. */
  await call('POST', `/v1/projects/${FIXTURE.migratedProjectId}/members`,
    { researcher_id: FIXTURE.outsiderId, caps: { createInvites: true } });
  const noCap = await mcall('POST', `/v1/projects/${FIXTURE.migratedProjectId}/grant-sweep`, {});
  ok(noCap.status === 404, `without manageDevices the sweep answers 404 (got ${noCap.status})`);
  await call('POST', `/v1/projects/${FIXTURE.migratedProjectId}/members`,
    { researcher_id: FIXTURE.outsiderId, caps: { manageDevices: true, createInvites: true } });
}

/* ════════════════ THE FOUR-WAY MATRIX (Seth, 2026-08-31) ════════════════
 *
 * "We want to make sure it works all four ways: minted by owner/member × approved by owner/member."
 * The lanes never consult who minted the invite — but implied is not verified, so each combination
 * is walked for real: invite → claim (real keypair) → accept → approve → server-key → the device
 * poll carries a wrap that RSA-unwraps. Member/Member and Owner/Owner are already covered above;
 * these two arms pin the cross cases. */
console.log('\nproject-key 4-way matrix (minted-by × approved-by)');

async function fullEnrol(instanceId, ki, mintCall, approveCall, label) {
  const kiKey = await crypto.subtle.importKey('raw', ki, { name: 'AES-GCM' }, false, ['encrypt']);
  await call('POST', `/v1/instances/${instanceId}/command`, { command: { type: 'changeSettings', enc: await encryptJSONStd(kiKey, { m: label }) } });
  const d = await claimInstall(instanceId, mintCall === 'member');
  ok(d.inviteOk && d.claimOk, `${label}: invite minted by ${mintCall}, device claimed`);
  const doCall = approveCall === 'member' ? mcall : call;
  await fetch(BASE + `/v1/instances/${instanceId}/installs/${d.installId}/accept`, { method: 'POST', headers: d.DEVICE, body: '{}' });
  const app = await doCall('POST', `/v1/instances/${instanceId}/installs/${d.installId}/approve`, {});
  const sk = await doCall('POST', `/v1/instances/${instanceId}/installs/${d.installId}/server-key`, {});
  ok(app.status === 200 && sk.status === 200,
     `${label}: approved AND keyed by the ${approveCall} (approve ${app.status}, server-key ${sk.status})`);
  const poll = await fetch(BASE + `/v1/instances/${instanceId}?since=0`, { headers: d.DEVICE });
  const pj = await poll.json().catch(() => null);
  let back = null;
  try {
    const ct = Buffer.from(String(pj && pj.wrapped_key).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    back = new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, d.priv, ct));
  } catch { /* back stays null */ }
  ok(!!back && back.length === ki.length && back.every((x, i) => x === ki[i]),
     `${label}: the device unwrapped the TRUE Ki — byte-identical`);
}

{
  /* Member-minted, OWNER-approved — the field case where a coworker prepares the enrolment and the
   * owner happens to be the one at a panel when the device comes online. */
  const devMO = await mk('pk4-mint-member-approve-owner');
  const kiMO = crypto.getRandomValues(new Uint8Array(32));
  {
    const v2 = await call('GET', '/v1/researcher');
    const pub = await crypto.subtle.importKey('spki', Buffer.from(String(v2.json.pubkey).replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
      { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
    await call('POST', '/v1/researcher/keys', { instance_id: devMO,
      grants: [{ researcher_id: FIXTURE.researcherId, wrapped_ki: b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, kiMO))) }] });
  }
  await fullEnrol(devMO, kiMO, 'member', 'owner', 'mint=member approve=owner');

  /* Owner-minted, MEMBER-approved — the owner prepares the invite, the member finishes enrolment. */
  const devOM = await mk('pk4-mint-owner-approve-member');
  const kiOM = crypto.getRandomValues(new Uint8Array(32));
  {
    const v2 = await call('GET', '/v1/researcher');
    const pub = await crypto.subtle.importKey('spki', Buffer.from(String(v2.json.pubkey).replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
      { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
    await call('POST', '/v1/researcher/keys', { instance_id: devOM,
      grants: [{ researcher_id: FIXTURE.researcherId, wrapped_ki: b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, kiOM))) }] });
  }
  await fullEnrol(devOM, kiOM, 'owner', 'member', 'mint=owner approve=member');
}

console.log(fail ? `\n${fail} FAILED` : '\nPASS');
process.exit(fail ? 1 : 0);
