/* PROJECT KEY (Kp) — Phase 1 of the project-key rework.
 *
 * DESIGN: plans/BACKLOG.md, "DECIDED DIRECTION: instances belong to PROJECTS, and the project holds
 * the key" (Seth, 2026-08-28) and "the reconciliation" beneath it. Read those before extending this;
 * in particular, the 5-design review's fatal verdicts on every worker-blind delegation scheme, and
 * the decision that member_key stays materialised FOREVER.
 *
 * WHAT THIS MODULE IS IN PHASE 1: the Kp store and the operator-run backfill, and nothing else.
 * Nothing outside the admin backfill route reads project_key or instance.ki_kp yet. Phase 2 (the
 * worker maintaining member_key rows and minting install wraps itself — which is what actually
 * delivers delegated device approval) builds on this but is a SEPARATE, later deploy.
 *
 * ⚠ THE HONEST SECURITY STATEMENT, because older comments in v1.js overclaimed and were corrected in
 * the same commit that added this file: the worker has ALWAYS been able to derive every device Ki —
 *     serverAesKey(env) -> decAtRest(kr_server_enc) = Kr
 *       -> settings_blob.wrappedKis[instanceId]  (AES-GCM under Kr)      = Ki      [path A]
 *       -> wrapped_privkey (under Kr) -> RSA-OAEP -> member_key.wrapped_ki = Ki    [path B]
 * This module does not widen that reach; it exercises it deliberately, per project, and writes the
 * result down (instance.ki_kp) so Phase 2 never has to walk the chain again. The property that holds
 * before and after: a D1 dump alone, WITHOUT the worker secret, yields nothing.
 *
 * ⚠ CIPHERTEXT FORMATS: the client alphabet is URL-SAFE UNPADDED base64 — see the block comment on
 * b64ToBytes below, which records how getting this wrong cost the first production backfill run.
 * ki_kp is written in the client "iv.ct" url-safe shape with a {k} payload, matching wrapKey()'s
 * vocabulary, so a future phase can hand one to a client without translation.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ⚠⚠ THE CLIENT ALPHABET IS URL-SAFE UNPADDED BASE64, AND ASSUMING OTHERWISE COST A PRODUCTION RUN.
 * docs/js/crypto.js bytesToB64 is btoa(...).replace(+ -> -, / -> _, strip =) — every client-minted
 * token (wrappedKis values, wrapped_privkey, member_key.wrapped_ki, pubkey) uses it. The first
 * version of this module decoded with bare atob(), which throws InvalidCharacterError on '-'/'_' —
 * so the very first production backfill (2026-08-30) derived ZERO of 16 devices, every one
 * 'skipped_no_ki', while the rig was green because the PROBE had minted its fixtures in standard
 * base64, faithfully replicating the assumption instead of the client. Found by replaying the
 * worker's exact steps in a browser against a live token: sample 'dclPrkDNW_S6825v.…' — the '_' is
 * the whole story.
 *
 * The decoder therefore NORMALIZES — it accepts both alphabets, because not everything here is
 * client-minted: kr_server_enc plaintext (the Kr string) was minted by the WORKER with bare btoa()
 * and is standard base64, possibly padded. One decoder for both is the fix that cannot regress into
 * a second alphabet split. The encoder emits CLIENT-style url-safe unpadded, so anything a later
 * phase hands to a client is already in its vocabulary. The probe now mints its fixtures with the
 * client's exact encoder shape, which is what makes this a tested property rather than a comment. */
export function b64ToBytes(s) {
  const norm = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importAesRaw(rawBytes) {
  return crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/* decryptJSON, client-compatible: "ivB64.ctB64" (STANDARD b64) AES-GCM -> parsed object. */
async function decryptJSONStd(key, token) {
  const [ivB64, ctB64] = String(token).split('.');
  if (!ivB64 || !ctB64) throw new Error('bad_ciphertext');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ivB64) }, key, b64ToBytes(ctB64));
  return JSON.parse(dec.decode(pt));
}
async function encryptJSONStd(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return bytesToB64(iv) + '.' + bytesToB64(ct);
}

/* Derive a device's raw Ki bytes through the escrow chain, as the OWNER's row allows.
 *
 * Returns { raw: Uint8Array, path: 'wrappedKis' | 'member_key' } or null when the chain does not
 * reach this device. ⚠ null is a NORMAL outcome, not an error: an account created before escrow, a
 * wrappedKis entry lost to a settings rewrite, a fixture row with fake ciphertext. The backfill
 * reports these as skipped; it must never fail the run for them, because one unreachable device must
 * not stop the fleet (the same posture as backfill-drive-objects' "one disconnected account").
 *
 * `decAtRest` is passed in rather than imported to keep this module dependency-free of v1.js
 * (which imports US) — the same inversion drive-object.js uses. */
export async function deriveKiRaw(env, db, decAtRest, ownerRow, instanceId) {
  /* On failure this returns { fail: [...] } — COARSE reasons, never key material, shown only on the
   * operator route. Added after the first production run reported 16 bare 'skipped_no_ki' and the
   * cause (the base64 alphabet) took a live-browser replay to find. A reason turns the next such
   * skip from an investigation into a sentence. */
  if (!ownerRow) return { fail: ['owner_row_missing'] };
  if (!ownerRow.kr_server_enc) return { fail: ['no_kr_escrow'] };
  const krB64 = await decAtRest(env, ownerRow.kr_server_enc);
  if (!krB64) return { fail: ['kr_undecryptable'] };
  let krKey = null;
  try { krKey = await importAesRaw(b64ToBytes(krB64)); } catch { return { fail: ['kr_import_failed'] }; }

  const fails = [];
  /* Path A — the legacy Kr-wrapped store inside settings_blob. Cheapest, and the one every
   * owner-created device has. */
  try {
    const settings = JSON.parse(ownerRow.settings_blob || '{}');
    const w = settings && settings.wrappedKis && settings.wrappedKis[instanceId];
    if (w) {
      try {
        const { k } = await decryptJSONStd(krKey, w);
        if (k) return { raw: b64ToBytes(k), path: 'wrappedKis' };
        fails.push('wrappedKis_no_k');
      } catch { fails.push('wrappedKis_undecryptable'); }
    } else fails.push('no_wrappedKis_entry');
  } catch { fails.push('settings_blob_unparseable'); }

  /* Path B — the owner's own member_key grant (RSA-OAEP to their pubkey), unwrapped with the
   * privkey escrowed under Kr. Newer devices (member-created ones especially) live here. */
  try {
    if (!ownerRow.wrapped_privkey) { fails.push('no_wrapped_privkey'); return { fail: fails }; }
    const { pkcs8 } = await decryptJSONStd(krKey, ownerRow.wrapped_privkey);
    if (!pkcs8) { fails.push('privkey_no_pkcs8'); return { fail: fails }; }
    const priv = await crypto.subtle.importKey('pkcs8', b64ToBytes(pkcs8),
      { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
    const g = await db.prepare(
      'SELECT wrapped_ki FROM member_key WHERE instance_id=? AND researcher_id=? ORDER BY key_version DESC LIMIT 1'
    ).bind(instanceId, ownerRow.researcher_id).first();
    if (!g || !g.wrapped_ki) { fails.push('no_owner_grant'); return { fail: fails }; }
    const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, b64ToBytes(g.wrapped_ki));
    return { raw: new Uint8Array(raw), path: 'member_key' };
  } catch { fails.push('grant_unwrap_failed'); return { fail: fails }; }
}

/* Fetch-or-mint the project's Kp; returns { raw, key_version }.
 * INSERT-then-reselect makes a concurrent double-mint converge on one winner instead of two
 * projects' worth of state — the same shape as every other first-writer-wins row here. */
export async function ensureProjectKp(env, db, encAtRest, decAtRest, projectId, now) {
  const read = async () => {
    const row = await db.prepare('SELECT kp_enc, key_version FROM project_key WHERE project_id=?')
      .bind(projectId).first();
    if (!row) return null;
    const b64 = await decAtRest(env, row.kp_enc);
    if (!b64) return null;                       // undecryptable = treat as absent, never crash
    return { raw: b64ToBytes(b64), key_version: row.key_version || 1, minted: false };
  };
  const existing = await read();
  if (existing) return existing;
  const kp = crypto.getRandomValues(new Uint8Array(32));
  await db.prepare('INSERT OR IGNORE INTO project_key (project_id, kp_enc, key_version, created_at) VALUES (?,?,1,?)')
    .bind(projectId, await encAtRest(env, bytesToB64(kp)), now).run();
  const after = await read();                    // re-read: a concurrent mint may have won the IGNORE
  return after ? { ...after, minted: true } : null;
}

export async function wrapKiUnderKp(kpRaw, kiRaw) {
  return encryptJSONStd(await importAesRaw(kpRaw), { k: bytesToB64(kiRaw) });
}
export async function unwrapKiUnderKp(kpRaw, token) {
  const { k } = await decryptJSONStd(await importAesRaw(kpRaw), token);
  return b64ToBytes(k);
}

/* The Phase-1 backfill: for every project (or one), mint Kp if absent, then wrap each live
 * device's Ki under it. IDEMPOTENT — a wrapped instance reports 'already' and is not rewritten,
 * so re-running after a partial failure completes the remainder and a full re-run is a no-op.
 *
 * ⚠ EVERY WRAP IS SELF-VERIFIED before it is written: unwrap the fresh token and byte-compare
 * against the derived Ki. A wrap that does not round-trip is reported 'verify_failed' and NOT
 * stored — a stored-but-wrong ki_kp would be worse than none, because Phase 2 would trust it. */
export async function backfillProjectKeys(env, db, encAtRest, decAtRest, now, onlyProjectId) {
  const projects = onlyProjectId
    ? (await db.prepare('SELECT project_id, owner_id FROM project WHERE project_id=?').bind(onlyProjectId).all()).results || []
    : (await db.prepare('SELECT project_id, owner_id FROM project').all()).results || [];
  const out = [];
  const totals = { wrapped: 0, already: 0, skipped: 0, verify_failed: 0 };
  for (const p of projects) {
    const rep = { project_id: p.project_id, minted: false, instances: [] };
    const owner = p.owner_id ? await db.prepare(
      'SELECT researcher_id, kr_server_enc, settings_blob, wrapped_privkey FROM researcher WHERE researcher_id=?'
    ).bind(p.owner_id).first() : null;
    const insts = (await db.prepare(
      'SELECT instance_id, ki_kp FROM instance WHERE project_id=? AND revoked=0'
    ).bind(p.project_id).all()).results || [];
    /* Kp is minted only when the project has a device to wrap — an empty project gets its key the
     * day it first needs one, and the table stays a map of projects that actually hold anything. */
    let kp = null;
    for (const it of insts) {
      if (it.ki_kp) { rep.instances.push({ instance_id: it.instance_id, status: 'already' }); totals.already++; continue; }
      const ki = await deriveKiRaw(env, db, decAtRest, owner, it.instance_id);
      if (!ki || !ki.raw) {
        rep.instances.push({ instance_id: it.instance_id, status: 'skipped_no_ki', reason: (ki && ki.fail) || ['unknown'] });
        totals.skipped++; continue;
      }
      if (!kp) {
        kp = await ensureProjectKp(env, db, encAtRest, decAtRest, p.project_id, now);
        if (!kp) { rep.instances.push({ instance_id: it.instance_id, status: 'skipped_no_kp' }); totals.skipped++; continue; }
        rep.minted = !!kp.minted;
      }
      const token = await wrapKiUnderKp(kp.raw, ki.raw);
      let ok = false;
      try {
        const back = await unwrapKiUnderKp(kp.raw, token);
        ok = back.length === ki.raw.length && back.every((b, i) => b === ki.raw[i]);
      } catch { ok = false; }
      if (!ok) { rep.instances.push({ instance_id: it.instance_id, status: 'verify_failed' }); totals.verify_failed++; continue; }
      await db.prepare('UPDATE instance SET ki_kp=?, ki_kp_version=? WHERE instance_id=?')
        .bind(token, kp.key_version, it.instance_id).run();
      rep.instances.push({ instance_id: it.instance_id, status: 'wrapped', path: ki.path });
      totals.wrapped++;
    }
    out.push(rep);
  }
  return { projects: out, totals };
}

/* VERIFY ki_kp AGAINST REALITY — the pre-Phase-2 gate.
 *
 * The backfill's round-trip check proves each stored wrap matches what was DERIVED; this proves the
 * derivation matched what the DEVICE actually holds, by decrypting ciphertext the device world
 * minted: an install's reported_blob (encryptJSON(Ki, inventory), written by sync.js on every
 * report) or, failing that, an encrypted command in the desired lane. If ki_kp's Ki opens those,
 * it is the true Ki — and Phase 2 may hand it to new installs without qualification.
 *
 * ⚠ READ-ONLY, and it returns BOOLEANS ONLY — never a byte of plaintext. A verify that echoed the
 * decrypted inventory would turn an integrity check into a disclosure route.
 * ⚠ 'no_ciphertext' is a neutral outcome, not a pass: a device that has never reported and holds no
 * encrypted commands offers nothing to check against. It is counted separately so the summary cannot
 * claim more than it measured. */
export async function verifyProjectKeys(env, db, decAtRest, onlyProjectId) {
  const projects = onlyProjectId
    ? (await db.prepare('SELECT project_id FROM project_key WHERE project_id=?').bind(onlyProjectId).all()).results || []
    : (await db.prepare('SELECT project_id FROM project_key').all()).results || [];
  const out = [];
  const totals = { verified: 0, failed: 0, no_ciphertext: 0 };
  for (const p of projects) {
    const kpRow = await db.prepare('SELECT kp_enc FROM project_key WHERE project_id=?').bind(p.project_id).first();
    const kpB64 = kpRow ? await decAtRest(env, kpRow.kp_enc) : null;
    if (!kpB64) { out.push({ project_id: p.project_id, error: 'kp_undecryptable' }); continue; }
    const kpRaw = b64ToBytes(kpB64);
    const rep = { project_id: p.project_id, instances: [] };
    const insts = (await db.prepare(
      'SELECT instance_id, ki_kp, desired_blob FROM instance WHERE project_id=? AND revoked=0 AND ki_kp IS NOT NULL'
    ).bind(p.project_id).all()).results || [];
    for (const it of insts) {
      let kiRaw = null;
      try { kiRaw = await unwrapKiUnderKp(kpRaw, it.ki_kp); }
      catch { rep.instances.push({ instance_id: it.instance_id, ok: false, source: 'unwrap_failed' }); totals.failed++; continue; }
      let kiKey = null;
      try { kiKey = await importAesRaw(kiRaw); }
      catch { rep.instances.push({ instance_id: it.instance_id, ok: false, source: 'ki_import_failed' }); totals.failed++; continue; }
      /* Newest report from a live install is the strongest material — freshly minted by the device. */
      const inst = await db.prepare(
        'SELECT reported_blob FROM install WHERE instance_id=? AND revoked=0 AND reported_blob IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1'
      ).bind(it.instance_id).first();
      let token = inst && inst.reported_blob, source = 'report';
      if (!token) {
        /* Fall back to an encrypted command the RESEARCHER minted under the same Ki. Weaker (it
         * proves agreement with the panel, not the device) but real ciphertext nonetheless. */
        try {
          const blob = it.desired_blob ? JSON.parse(it.desired_blob) : null;
          const cmd = blob && Array.isArray(blob.commands) && blob.commands.find((c) => c && c.enc);
          if (cmd) { token = cmd.enc; source = 'command'; }
        } catch { /* no material */ }
      }
      if (!token) { rep.instances.push({ instance_id: it.instance_id, ok: null, source: 'no_ciphertext' }); totals.no_ciphertext++; continue; }
      try {
        await decryptJSONStd(kiKey, token);
        rep.instances.push({ instance_id: it.instance_id, ok: true, source });
        totals.verified++;
      } catch {
        rep.instances.push({ instance_id: it.instance_id, ok: false, source });
        totals.failed++;
      }
    }
    out.push(rep);
  }
  return { projects: out, totals };
}
