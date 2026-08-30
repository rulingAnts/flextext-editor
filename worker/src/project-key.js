/* PROJECT KEY (Kp) — Phases 1 and 2 of the project-key rework.
 *
 * DESIGN: plans/BACKLOG.md, "DECIDED DIRECTION: instances belong to PROJECTS, and the project holds
 * the key" (Seth, 2026-08-28) and "the reconciliation" beneath it. Read those before extending this;
 * in particular, the 5-design review's fatal verdicts on every worker-blind delegation scheme, and
 * the decision that member_key stays materialised FOREVER.
 *
 * PHASE 1: the Kp store and the operator-run backfill (backfillProjectKeys / verifyProjectKeys,
 * admin-only). PHASE 2 (2026-08-30): the server-key lane — kiForInstall() resolves a device's Ki
 * server-side (stored ki_kp first, checked against reality; else the same evidence-based derivation
 * the backfill uses, lazily writing ki_kp) and wrapKiToInstallPubkey() mints the install wrap the
 * panel used to mint client-side. That inversion is what delivers delegated device approval: the
 * approving researcher ASKS, and the worker performs the wrap — it cannot be handed a ciphertext it
 * did not mint, so the substitution concern that kept /key owner-only does not arise on this lane.
 * The owner-only submit-a-blob /key route stays exactly as it was. member_key maintenance (the rest
 * of the BACKLOG's Phase 2) is still to come; every existing key-writing path is unchanged.
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
export async function deriveKiCandidates(env, db, decAtRest, ownerRow, instanceId) {
  /* Returns { candidates: [{raw, path}...], fail: [...] } — candidates in CLIENT precedence order.
   *
   * ⚠⚠ PRECEDENCE IS member_key FIRST, wrappedKis SECOND — the same order as the panel's getKi() —
   * AND GETTING THIS BACKWARDS SHIPPED 10 STALE WRAPS TO PRODUCTION (2026-08-30). The first version
   * derived wrappedKis first, on the reasoning that it was "cheapest and every owner-created device
   * has one". But the two stores DIVERGE on older devices, and when they do, the member_key grant is
   * what the device was actually keyed from: deliverPendingDeviceKeys wraps getKi()'s result, and
   * getKi reads the grant first. The stale legacy copy still decrypts CLEANLY under Kr — a perfectly
   * valid OLD key — so the backfill's round-trip self-check passed while the device's real reports
   * refused to open. The verify-against-reality route caught it: 10 of 15 production wraps held the
   * wrong key. The panel decrypting a device's inventory that the derived key could not open was the
   * proof (RevokeTest, 13dff94c).
   *
   * BOTH candidates are returned because precedence alone is a HEURISTIC — the backfill now proves
   * the choice against device-minted ciphertext wherever any exists, and only falls back to this
   * ordering when the device has never reported. Coarse failure reasons ride along; never key
   * material. */
  if (!ownerRow) return { candidates: [], fail: ['owner_row_missing'] };
  if (!ownerRow.kr_server_enc) return { candidates: [], fail: ['no_kr_escrow'] };
  const krB64 = await decAtRest(env, ownerRow.kr_server_enc);
  if (!krB64) return { candidates: [], fail: ['kr_undecryptable'] };
  let krKey = null;
  try { krKey = await importAesRaw(b64ToBytes(krB64)); } catch { return { candidates: [], fail: ['kr_import_failed'] }; }

  const fails = [];
  const candidates = [];

  /* member_key grant — the store the device was actually keyed from, per getKi's precedence. */
  try {
    if (!ownerRow.wrapped_privkey) fails.push('no_wrapped_privkey');
    else {
      const { pkcs8 } = await decryptJSONStd(krKey, ownerRow.wrapped_privkey);
      if (!pkcs8) fails.push('privkey_no_pkcs8');
      else {
        const priv = await crypto.subtle.importKey('pkcs8', b64ToBytes(pkcs8),
          { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
        const g = await db.prepare(
          'SELECT wrapped_ki FROM member_key WHERE instance_id=? AND researcher_id=? ORDER BY key_version DESC LIMIT 1'
        ).bind(instanceId, ownerRow.researcher_id).first();
        if (!g || !g.wrapped_ki) fails.push('no_owner_grant');
        else {
          const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, b64ToBytes(g.wrapped_ki));
          candidates.push({ raw: new Uint8Array(raw), path: 'member_key' });
        }
      }
    }
  } catch { fails.push('grant_unwrap_failed'); }

  /* wrappedKis — the legacy Kr-wrapped store. Kept as a candidate, not a truth: on divergence it is
   * the STALE copy (see the header), but for never-granted legacy devices it is the only copy. */
  try {
    const settings = JSON.parse(ownerRow.settings_blob || '{}');
    const w = settings && settings.wrappedKis && settings.wrappedKis[instanceId];
    if (w) {
      try {
        const { k } = await decryptJSONStd(krKey, w);
        if (k) {
          const raw = b64ToBytes(k);
          /* Deduplicate: when both stores agree (the healthy modern case) there is ONE candidate. */
          if (!candidates.some((c) => c.raw.length === raw.length && c.raw.every((b, i) => b === raw[i]))) {
            candidates.push({ raw, path: 'wrappedKis' });
          }
        } else fails.push('wrappedKis_no_k');
      } catch { fails.push('wrappedKis_undecryptable'); }
    } else fails.push('no_wrappedKis_entry');
  } catch { fails.push('settings_blob_unparseable'); }

  return { candidates, fail: fails };
}

/* The newest REAL ciphertext a device's world has produced, for proving a key against reality:
 * an install's reported_blob (device-minted, strongest), else an encrypted desired-lane command
 * (panel-minted under the same Ki). null when the device has never produced anything checkable. */
export async function realityMaterial(db, instanceId, desiredBlob) {
  const inst = await db.prepare(
    'SELECT reported_blob FROM install WHERE instance_id=? AND revoked=0 AND reported_blob IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1'
  ).bind(instanceId).first();
  if (inst && inst.reported_blob) {
    /* ⚠⚠ reported_blob IS JSON-STRINGIFIED, NOT THE BARE TOKEN — the report route stores
     * `JSON.stringify(body.reported)` (v1.js), so the column holds the "iv.ct" string WRAPPED IN
     * QUOTES, and the panel unwraps it with safeParse() before decryptJSON (researcher.js:1253).
     * The first verify run passed the RAW column value: atob hit the leading quote and threw before
     * GCM ever ran, so ALL TEN report-sourced checks read FAILED while the five command-sourced ones
     * passed — a perfectly consistent wrong answer that pointed at the keys instead of the format.
     * Mirror safeParse exactly: parse if it parses to a string, use raw otherwise (belt for any
     * legacy bare rows). */
    let token = inst.reported_blob;
    try { const parsed = JSON.parse(token); if (typeof parsed === 'string') token = parsed; } catch { /* bare */ }
    return { token, source: 'report' };
  }
  try {
    const blob = desiredBlob ? JSON.parse(desiredBlob) : null;
    const cmd = blob && Array.isArray(blob.commands) && blob.commands.find((c) => c && c.enc);
    if (cmd) return { token: cmd.enc, source: 'command' };
  } catch { /* no material */ }
  return null;
}

export async function kiOpens(kiRaw, token) {
  try { await decryptJSONStd(await importAesRaw(kiRaw), token); return true; }
  catch { return false; }
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

/* The Phase-1 backfill, EVIDENCE-BASED since the stale-wrap incident (2026-08-30).
 *
 * For each live device in each project:
 *   1. Derive every candidate Ki (member_key grant first, wrappedKis second — getKi's precedence).
 *   2. Fetch the newest REAL ciphertext the device's world produced (its own report, else an
 *      encrypted command). Where any exists, the key stored is the candidate that OPENS IT — and a
 *      stored wrap that fails against reality is REPLACED ('rewrapped'), which is how the 10 stale
 *      production wraps healed on the next run.
 *   3. Only a device that has never produced anything checkable falls back to precedence alone
 *      (recorded as proven:'none'), and an existing wrap is then left alone.
 *
 * ⚠ A KEY CONTRADICTED BY REALITY IS NEVER STORED. If every candidate fails against real material,
 * the device is 'skipped_candidates_fail_reality' — storing a key the device's own ciphertext
 * refuses would be worse than none, because Phase 2 would hand it to new installs.
 *
 * IDEMPOTENT BY EVIDENCE: a stored wrap that opens reality reports 'already'; re-runs converge. */
export async function backfillProjectKeys(env, db, encAtRest, decAtRest, now, onlyProjectId) {
  const projects = onlyProjectId
    ? (await db.prepare('SELECT project_id, owner_id FROM project WHERE project_id=?').bind(onlyProjectId).all()).results || []
    : (await db.prepare('SELECT project_id, owner_id FROM project').all()).results || [];
  const out = [];
  const totals = { wrapped: 0, rewrapped: 0, already: 0, skipped: 0, verify_failed: 0 };
  for (const p of projects) {
    const rep = { project_id: p.project_id, minted: false, instances: [] };
    const owner = p.owner_id ? await db.prepare(
      'SELECT researcher_id, kr_server_enc, settings_blob, wrapped_privkey FROM researcher WHERE researcher_id=?'
    ).bind(p.owner_id).first() : null;
    const insts = (await db.prepare(
      'SELECT instance_id, ki_kp, desired_blob FROM instance WHERE project_id=? AND revoked=0'
    ).bind(p.project_id).all()).results || [];
    let kp = null;
    const ensureKp = async () => {
      if (!kp) {
        kp = await ensureProjectKp(env, db, encAtRest, decAtRest, p.project_id, now);
        if (kp) rep.minted = rep.minted || !!kp.minted;
      }
      return kp;
    };
    for (const it of insts) {
      const material = await realityMaterial(db, it.instance_id, it.desired_blob);

      /* An existing wrap that still opens reality is settled — the common case after the first run. */
      if (it.ki_kp && material) {
        const k = await ensureKp();
        if (k) {
          let storedOk = false;
          try { storedOk = await kiOpens(await unwrapKiUnderKp(k.raw, it.ki_kp), material.token); } catch { /* treat as stale */ }
          if (storedOk) { rep.instances.push({ instance_id: it.instance_id, status: 'already', proven: material.source }); totals.already++; continue; }
        }
      } else if (it.ki_kp && !material) {
        /* Nothing to test against — leave the stored wrap alone rather than churning it. */
        rep.instances.push({ instance_id: it.instance_id, status: 'already', proven: 'none' }); totals.already++; continue;
      }

      const d = await deriveKiCandidates(env, db, decAtRest, owner, it.instance_id);
      if (!d.candidates.length) {
        rep.instances.push({ instance_id: it.instance_id, status: 'skipped_no_ki', reason: d.fail.length ? d.fail : ['unknown'] });
        totals.skipped++; continue;
      }
      let chosen = null, proven = 'none';
      if (material) {
        for (const c of d.candidates) { if (await kiOpens(c.raw, material.token)) { chosen = c; proven = material.source; break; } }
        if (!chosen) {
          /* Real ciphertext exists and NO derivable key opens it — never store a contradicted key. */
          rep.instances.push({ instance_id: it.instance_id, status: 'skipped_candidates_fail_reality',
            reason: d.fail, candidates: d.candidates.map((c) => c.path) });
          totals.skipped++; continue;
        }
      } else {
        chosen = d.candidates[0];   // getKi precedence — the best available heuristic with nothing to test
      }
      const k = await ensureKp();
      if (!k) { rep.instances.push({ instance_id: it.instance_id, status: 'skipped_no_kp' }); totals.skipped++; continue; }
      const token = await wrapKiUnderKp(k.raw, chosen.raw);
      let ok = false;
      try {
        const back = await unwrapKiUnderKp(k.raw, token);
        ok = back.length === chosen.raw.length && back.every((b, i) => b === chosen.raw[i]);
      } catch { ok = false; }
      if (!ok) { rep.instances.push({ instance_id: it.instance_id, status: 'verify_failed' }); totals.verify_failed++; continue; }
      await db.prepare('UPDATE instance SET ki_kp=?, ki_kp_version=? WHERE instance_id=?')
        .bind(token, k.key_version, it.instance_id).run();
      const wasRewrap = !!it.ki_kp;
      rep.instances.push({ instance_id: it.instance_id, status: wasRewrap ? 'rewrapped' : 'wrapped', path: chosen.path, proven });
      if (wasRewrap) totals.rewrapped++; else totals.wrapped++;
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
      /* ⚠ ONE material lookup — realityMaterial() — shared with the backfill. This function briefly
       * carried its OWN inline copy of this logic, and when the JSON-stringified-report unwrap was
       * fixed in realityMaterial, the copy here kept reading the raw column: the backfill healed
       * while verify went on reporting the very failures it had just healed. The probe's real-report
       * arm caught it before production did. Two copies of one truth is how that happens. */
      const m2 = await realityMaterial(db, it.instance_id, it.desired_blob);
      if (!m2) { rep.instances.push({ instance_id: it.instance_id, ok: null, source: 'no_ciphertext' }); totals.no_ciphertext++; continue; }
      const token = m2.token, source = m2.source;
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

/* ── PHASE 2: the server-key lane ─────────────────────────────────────────────────────────────────
 *
 * kiForInstall() — resolve ONE instance's true Ki for a worker-minted install wrap.
 *
 * Resolution order, each step answerable to reality (the backfill's rules, per instance):
 *   1. A stored ki_kp that opens the device's real ciphertext — or that has no ciphertext to
 *      contradict it — is used as-is. A stored ki_kp that reality REFUSES is discarded and healed.
 *   2. Otherwise derive candidates (member_key grant first, wrappedKis second — getKi's order) and
 *      prove against real material where any exists. All candidates refused → fail closed: handing
 *      an install a key its instance's own ciphertext contradicts would strand the device.
 *   3. A proven (or uncontradicted) resolution is written back to ki_kp so the next approval skips
 *      the chain — the lazy backfill for instances created after the operator run.
 *
 * Instances with no project (the dual-read window) resolve via candidates but skip the ki_kp store —
 * there is no project to hold a Kp. Returns { kiRaw, path, proven } or { fail: [reasons] }; never
 * key material in `fail`. */
export async function kiForInstall(env, db, encAtRest, decAtRest, ownerRow, projectId, instanceId, now) {
  const inst = await db.prepare('SELECT ki_kp, desired_blob FROM instance WHERE instance_id=? AND revoked=0')
    .bind(instanceId).first();
  if (!inst) return { fail: ['instance_missing'] };
  const material = await realityMaterial(db, instanceId, inst.desired_blob);

  const kp = projectId
    ? await ensureProjectKp(env, db, encAtRest, decAtRest, projectId, now)
    : null;

  if (inst.ki_kp && kp) {
    try {
      const kiRaw = await unwrapKiUnderKp(kp.raw, inst.ki_kp);
      if (!material || await kiOpens(kiRaw, material.token)) {
        return { kiRaw, path: 'ki_kp', proven: material ? material.source : 'none' };
      }
      // Stored wrap refused by the device's own ciphertext — fall through and re-derive (the heal).
    } catch { /* undecryptable ki_kp — fall through and re-derive */ }
  }

  const d = await deriveKiCandidates(env, db, decAtRest, ownerRow, instanceId);
  if (!d.candidates.length) return { fail: d.fail.length ? d.fail : ['no_candidates'] };
  let chosen = null, proven = 'none';
  if (material) {
    for (const c of d.candidates) {
      if (await kiOpens(c.raw, material.token)) { chosen = c; proven = material.source; break; }
    }
    if (!chosen) return { fail: ['candidates_fail_reality'] };
  } else {
    chosen = d.candidates[0];   // no material to arbitrate — getKi precedence, same as the backfill
  }

  if (kp) {
    const token = await wrapKiUnderKp(kp.raw, chosen.raw);
    // Round-trip self-check before storing, mirroring the backfill: a wrap that will not unwrap
    // must never become the stored truth.
    let roundtrip = false;
    try {
      const back = await unwrapKiUnderKp(kp.raw, token);
      roundtrip = back.length === chosen.raw.length && back.every((b, i) => b === chosen.raw[i]);
    } catch { /* roundtrip stays false */ }
    if (roundtrip) {
      await db.prepare('UPDATE instance SET ki_kp=?, ki_kp_version=? WHERE instance_id=?')
        .bind(token, kp.key_version, instanceId).run();
    }
  }
  return { kiRaw: chosen.raw, path: chosen.path, proven };
}

/* Mint the install wrap the panel's wrapKeyForInstall() mints: bare RSA-OAEP-SHA256 ciphertext of
 * the raw Ki bytes, url-safe unpadded base64, to the install's SPKI pubkey. NO envelope — the
 * device unwraps with a single RSA decrypt (crypto.js unwrapKeyFromResearcher) and any wrapper
 * would break every installed engine. This is the worker's only RSA-ENCRYPT; the import mirrors
 * the client's importPublicKeyB64 exactly (RSA-OAEP, SHA-256). Researcher pubkeys are the same
 * SPKI shape (the client wraps member grants with the same helper), so grant maintenance below
 * reuses this for researcher-targeted wraps too. */
export async function wrapKiToInstallPubkey(installPubkeyB64, kiRaw) {
  const pub = await crypto.subtle.importKey('spki', b64ToBytes(installPubkeyB64),
    { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  return bytesToB64(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, kiRaw));
}

/* ── PHASE 2b: worker-maintained member_key grants ────────────────────────────────────────────────
 *
 * The rest of the BACKLOG's Phase-2 spec: "when a device is created or a coworker added, the WORKER
 * writes the member_key rows." This replaces the panel's client-side N×M wrap loop (memberGrantSweep
 * / grantKeysToMember) as the thing that closes grant gaps — old panels keep working because the
 * rows they expect simply appear, minted here instead of in a browser.
 *
 * The rules that keep it safe:
 *   · MISSING rows only — INSERT OR IGNORE, never REPLACE. Maintenance can never clobber a standing
 *     grant, so the overwrite concern that keeps member writes narrow does not arise on this path.
 *   · Ki comes from kiForInstall — the evidence-based resolver. An instance whose Ki cannot be
 *     established (the keyless-by-design class, or ciphertext-contradicted stores) is reported in
 *     `keyless` and SKIPPED: never an error, never a retry loop, exactly as the BACKLOG requires.
 *   · The OWNER's own grant is maintained too (the wrap-to-owner invariant, now held by the worker
 *     itself): every instance that has a resolvable Ki ends up owner-readable by construction.
 *   · A grantee with no published pubkey is reported and skipped — there is nothing to wrap to yet;
 *     the next maintenance pass picks them up (same contract the client sweep had).
 *
 * Returns { granted, already, keyless: [{instance_id, reasons}], no_pubkey: [researcher ids] } —
 * counts and ids only, never key material. */
export async function maintainProjectGrants(env, db, encAtRest, decAtRest, ownerRow, projectId, now, onlyInstanceId, callerId) {
  const out = { granted: 0, already: 0, keyless: [], no_pubkey: [] };
  if (!projectId) return out;   // dual-read window: no project, no membership, nothing to maintain

  const memberRows = (await db.prepare(
    'SELECT m.researcher_id, r.pubkey FROM project_member m JOIN researcher r ON r.researcher_id=m.researcher_id WHERE m.project_id=?'
  ).bind(projectId).all()).results || [];
  const grantees = [];
  for (const mr of memberRows) {
    if (mr.pubkey) grantees.push({ researcher_id: mr.researcher_id, pubkey: mr.pubkey });
    else out.no_pubkey.push(mr.researcher_id);
  }
  if (ownerRow.pubkey) grantees.push({ researcher_id: ownerRow.researcher_id, pubkey: ownerRow.pubkey });
  else out.no_pubkey.push(ownerRow.researcher_id);
  if (!grantees.length) return out;

  const insts = onlyInstanceId
    ? (await db.prepare('SELECT instance_id FROM instance WHERE instance_id=? AND project_id=? AND revoked=0')
        .bind(onlyInstanceId, projectId).all()).results || []
    : (await db.prepare('SELECT instance_id FROM instance WHERE project_id=? AND revoked=0')
        .bind(projectId).all()).results || [];
  out.instances = insts.length;   // so callers can say "N devices, M of them keyless" honestly

  for (const it of insts) {
    const have = new Set(((await db.prepare(
      'SELECT researcher_id FROM member_key WHERE instance_id=?'
    ).bind(it.instance_id).all()).results || []).map((r) => r.researcher_id));
    const missing = grantees.filter((g) => !have.has(g.researcher_id));
    out.already += grantees.length - missing.length;
    if (!missing.length) continue;

    const res = await kiForInstall(env, db, encAtRest, decAtRest, ownerRow, projectId, it.instance_id, now);
    if (!res || !res.kiRaw) {
      out.keyless.push({ instance_id: it.instance_id, reasons: (res && res.fail) || [] });
      continue;
    }
    for (const g of missing) {
      let wrapped;
      try { wrapped = await wrapKiToInstallPubkey(g.pubkey, res.kiRaw); }
      catch { out.no_pubkey.push(g.researcher_id); continue; }   // unusable pubkey: report, never throw
      await db.prepare(
        'INSERT OR IGNORE INTO member_key (project_id, instance_id, researcher_id, key_version, wrapped_ki, wrapped_by, created_at) VALUES (?,?,?,1,?,?,?)'
      ).bind(projectId, it.instance_id, g.researcher_id, wrapped, callerId || ownerRow.researcher_id, now).run();
      out.granted++;
    }
  }
  return out;
}
