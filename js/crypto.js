/* crypto.js — E2EE primitives for the connectivity layer (Phase E0).
 *
 * The Cloudflare Worker + D1 store only CIPHERTEXT: the field client and the
 * researcher panel encrypt every metadata blob (inventory, commands, settings)
 * before it leaves the device, so the worker / Cloudflare / a subpoena never see
 * plaintext. Routing/auth fields (ids, secret hashes, revs) stay plaintext — they
 * carry no content. Content (audio/flextext) was never in D1 (it's on Drive).
 *
 * Key model (see docs): researcher passphrase --PBKDF2--> master key Kr; each
 * instance has a random key Ki, wrapped under Kr in D1 (so the researcher's own
 * devices can unwrap it) and delivered to the field install out-of-band. This
 * module is the shared primitive layer; key DISTRIBUTION lives in sync.js / the
 * researcher panel. Pure WebCrypto (AES-256-GCM + PBKDF2-SHA256), no dependencies.
 */

const KDF_ITERATIONS = 600000;   // PBKDF2-SHA256 (OWASP 2023); runs only on the researcher's device
const IV_BYTES = 12;             // AES-GCM standard nonce length

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---- base64url <-> bytes ---- */
function bytesToB64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64ToBytes(b64) {
  const s = atob(String(b64).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/* ---- raw key material ---- */
export function randomBytesB64(n = 16) { return bytesToB64(crypto.getRandomValues(new Uint8Array(n))); }

// A fresh random AES-256-GCM content key (extractable so it can be wrapped/delivered).
export async function generateKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
export async function exportKeyB64(key) { return bytesToB64(await crypto.subtle.exportKey('raw', key)); }
export async function importKeyB64(b64) {
  return crypto.subtle.importKey('raw', b64ToBytes(b64), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

// Derive the researcher master key from a passphrase (+ stored, non-secret salt).
export async function deriveKeyFromPassphrase(passphrase, saltB64) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
}

/* ---- blob encryption (the workhorse: any JSON object <-> opaque string) ---- */
// Returns "<ivB64>.<ctB64>" — an opaque token safe to store in a D1 *_blob column.
export async function encryptJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return bytesToB64(iv) + '.' + bytesToB64(ct);
}
export async function decryptJSON(key, token) {
  const [ivB64, ctB64] = String(token).split('.');
  if (!ivB64 || !ctB64) throw new Error('bad_ciphertext');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ivB64) }, key, b64ToBytes(ctB64));
  return JSON.parse(dec.decode(pt));
}

/* ---- key wrapping (store Ki under Kr in D1; the worker can't unwrap) ---- */
export async function wrapKey(wrappingKey, keyToWrap) {
  return encryptJSON(wrappingKey, { k: await exportKeyB64(keyToWrap) });
}
export async function unwrapKey(wrappingKey, wrapped) {
  const { k } = await decryptJSON(wrappingKey, wrapped);
  return importKeyB64(k);
}
