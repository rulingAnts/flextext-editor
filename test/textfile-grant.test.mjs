/* I2 — A MEMBER-MINTED TEXTFILE URL IS A POINTER, GOOD ONLY WHILE THE GRANT IS.
 *
 * WHY THIS INVARIANT EXISTS. The /v1/textfile token is SELF-STANDING by construction: everything
 * needed to serve it — the Drive owner, the file id, the expiry — travels inside the encrypted
 * token, so no lookup is required to honour it. That is what makes it work from a bare device fetch
 * with no headers, and it is also what makes it outlive the authority that created it. A member with
 * `assignTexts` mints URLs into the OWNER's Drive and has necessarily SEEN them. Remove that member
 * and, without a redemption-time check, they keep reading those files for the remainder of the 90
 * days with nothing behind it. Revocation with a 90-day tail is not revocation.
 *
 * ⚠ THE TEST ASSERTS A DIFFERENCE, NOT A DENIAL. "A member token dies after removal" would pass
 * equally well if every token died — including the owner-minted ones already in the field, which
 * would be a far worse bug than the one being fixed. Both kinds are therefore exercised against the
 * same worker, the same database and the same moment.
 *
 * Runs handleV1 against a fake D1 + fake Drive, the technique assignment-ttl.test.mjs established —
 * no cloud, no Google, no credentials.
 *
 * Run: node test/textfile-grant.test.mjs
 */
import { handleV1 } from '../worker/src/v1.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const HMAC = 'test-hmac-key';
const b64u = (buf) => { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
async function aesKey() {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(HMAC));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function encAtRest(plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(), new TextEncoder().encode(plain));
  return b64u(iv) + '.' + b64u(ct);
}

/* ⚠ REAL CIPHERTEXT, not the string 'enc'. driveAccessToken decrypts this column, so a placeholder
 * makes every redemption 502 in Drive — which looks like a failing assertion about grants and is
 * nothing of the kind. */
const REFRESH_ENC = await encAtRest('refresh-token');

const OWNER = 'r-owner', MEMBER = 'r-member';
const INST = 'i-1', FILE = 'file-1';

/* `memberRows` is the switch the whole test turns on: it is what the membership JOIN would find.
 * Emptying it IS removing the member, with nothing else about the world changed. */
let memberRows = 1;
const db = {
  prepare(sql) {
    return { bind(...args) {
      return {
        async first() {
          if (/FROM researcher/.test(sql)) {
            return { researcher_id: OWNER, drive_refresh_enc: REFRESH_ENC, drive_email: 'owner@example.invalid' };
          }
          if (/FROM instance WHERE instance_id=\? AND researcher_id=\? AND revoked=0/.test(sql)) {
            return { instance_id: INST };            // the device is live
          }
          if (/FROM project_member/.test(sql)) {
            return memberRows ? { ok: 1 } : null;    // ← the grant, present or withdrawn
          }
          return null;
        },
        async run() { return { meta: { changes: 1 } }; },
        async all() { return { results: [] }; },
      };
    } };
  },
  async batch() { return []; },
};
const ENV = { DB: db, SERVER_HMAC_KEY: HMAC, GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'cs' };

/* The fake Drive answers only enough to prove we REACHED it — that is the success signal. */
globalThis.fetch = async (input) => {
  const u = typeof input === 'string' ? input : input.url;
  if (u.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'AT' }), { headers: { 'content-type': 'application/json' } });
  if (u.includes('/drive/v3/files/')) return new Response('FILE-BYTES', { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  return new Response('{}', { status: 404 });
};

const token = async (extra) => encodeURIComponent(await encAtRest(JSON.stringify({
  r: OWNER, f: FILE, x: '', e: Date.now() + 86400000, n: 'nonce', iat: Date.now(), v: 2, i: INST, ...extra,
})));

async function redeem(tok) {
  const path = '/v1/textfile/' + tok;
  const res = await handleV1(new Request('https://w.test' + path), ENV, {}, new URL('https://w.test' + path), path, 'https://w.test');
  return res.status;
}

console.log('\nwith the grant in place, both kinds of token serve');
memberRows = 1;
ok(await redeem(await token({})) === 200, 'an OWNER-minted token (no `m`) serves');
ok(await redeem(await token({ m: MEMBER })) === 200, 'a MEMBER-minted token serves while they are still a member');

console.log('\nwithdraw the grant — and ONLY the member-minted token stops');
memberRows = 0;
{
  const ownerTok = await redeem(await token({}));
  const memberTok = await redeem(await token({ m: MEMBER }));
  ok(memberTok === 410, `⚠ the MEMBER-minted token is gone (got ${memberTok}) — no 90-day tail after removal`);
  ok(ownerTok === 200,
     `⚠⚠ and the OWNER-minted token still serves (got ${ownerTok}) — every token in the field today names no minter, and invalidating them would strand assignments mid-flight`);
  ok(memberTok !== ownerTok, 'the two differ, so this is testing the CHECK and not a blanket failure');
}

console.log('\na token whose minter IS the owner is not treated as delegated');
memberRows = 0;
ok(await redeem(await token({ m: OWNER })) === 200,
   '⚠ `m` equal to the Drive owner needs no membership — an owner is not a member of their own project, so a lookup would find nothing and deny forever');

console.log('\nexpiry and shape still win before any of this');
ok(await redeem(await token({ e: Date.now() - 1000, m: MEMBER })) === 401, 'an expired token is 401 regardless of grant');
ok(await redeem('not-a-real-token') === 401, 'a malformed token is 401');

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
