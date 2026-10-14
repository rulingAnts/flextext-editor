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

// Derive a key-encryption key (KEK) from a password (+ stored, non-secret salt). In the
// email+password model this WRAPS the random data key Kr (so a password change re-wraps Kr
// without changing it); the old passphrase model used it as Kr directly. Same primitive.
export async function deriveKeyFromPassphrase(passphrase, saltB64) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
}

// Derive a server-side AUTH secret from the password — separate from the KEK above (distinct
// salt context) so the server, which receives authSecret to verify login, learns nothing about
// the data-key KEK. Server stores only sha256(authSecret). Returns base64url (256-bit).
export async function deriveAuthSecret(password, saltB64) {
  const saltBytes = b64ToBytes(saltB64);
  const authSalt = new Uint8Array(saltBytes.length + 4);
  authSalt.set(saltBytes); authSalt.set(enc.encode('auth'), saltBytes.length); // domain separation
  const base = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: authSalt, iterations: KDF_ITERATIONS, hash: 'SHA-256' }, base, 256
  );
  return bytesToB64(bits);
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

/* ---- asymmetric Ki delivery (model A — hardened) ----
 * The field install generates an RSA-OAEP keypair, sends only its PUBLIC key with the
 * claim, and keeps the private key NON-EXTRACTABLE (stored as a CryptoKey in IndexedDB,
 * never serialized). After approval the researcher wraps Ki to that public key; the
 * Worker only ever relays the wrapped blob. So a leaked invite never exposes Ki — only
 * the install's private key (which never leaves it) can unwrap it. */
export async function generateInstallKeypair() {
  // extractable=false → private key non-extractable; the public key is always extractable.
  return crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    false, ['encrypt', 'decrypt']
  );
}
export async function exportPublicKeyB64(publicKey) { return bytesToB64(await crypto.subtle.exportKey('spki', publicKey)); }
export async function importPublicKeyB64(b64) {
  return crypto.subtle.importKey('spki', b64ToBytes(b64), { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
}
// Researcher side: RSA-OAEP-encrypt Ki's raw bytes to the install's public key.
export async function wrapKeyForInstall(installPublicKey, Ki) {
  const raw = await crypto.subtle.exportKey('raw', Ki);
  return bytesToB64(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, installPublicKey, raw));
}
// Install side: RSA-OAEP-decrypt with the private key → Ki as a NON-extractable AES-GCM key.
export async function unwrapKeyFromResearcher(installPrivateKey, wrappedB64) {
  const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, installPrivateKey, b64ToBytes(wrappedB64));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
/* RESEARCHER side: the same RSA-OAEP decrypt, but the Ki comes back EXTRACTABLE.
 *
 * ⚠ THE DIFFERENCE IS THE ROLE, AND IT IS NOT OPTIONAL. An install only ever encrypts and decrypts
 * its own reports, so its Ki can and must be non-extractable — it has nowhere legitimate to go. A
 * researcher's job includes RE-WRAPPING Ki to each new install's public key, and wrapKeyForInstall
 * does that with exportKey('raw', Ki). A non-extractable Ki cannot be exported, so the researcher
 * simply cannot approve a device.
 *
 * ⚠ THIS IS WHY IT EXISTS (2026-08-20). getKi's grant path called the INSTALL's helper above, so
 * every Ki resolved from a member_key grant was non-extractable and "Approve & send key" died with
 * "Failed to execute 'exportKey' on 'SubtleCrypto': key is not extractable". It lay dormant from
 * v434 until the moment the self-grant actually started writing rows — while member_key was empty,
 * getKi always fell through to the legacy Kr-wrapped copy, which importKeyB64 makes extractable.
 * Fixing the 500s that were blocking the grants is what armed it.
 *
 * ⚠ DO NOT "unify" these two by adding an extractable flag to the install's function. The default
 * would then be a decision made at each call site rather than by the role, and the install's key is
 * the one that must never become exportable. */
export async function unwrapGrantForResearcher(researcherPrivateKey, wrappedB64) {
  const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, researcherPrivateKey, b64ToBytes(wrappedB64));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}
/* ---- the RESEARCHER's own keypair (Phase B: member key grants) ----
 *
 * ⚠ EXTRACTABLE, UNLIKE AN INSTALL'S — and the difference is deliberate, not an oversight.
 *
 * An install's private key is non-extractable because it lives on exactly one device and must never
 * leave it: there is nowhere it would legitimately go. A RESEARCHER signs in from several browsers
 * and must be able to read their key grants from all of them, and the only thing that travels
 * between those browsers is Kr. So the private key is exported, wrapped under Kr, and stored on the
 * researcher row as `wrapped_privkey`; a new browser fetches it and unwraps it with Kr.
 *
 * What that costs, stated plainly: anyone who holds Kr can recover this private key. That is already
 * true of everything Kr protects, so it adds no exposure — but it does mean this key is exactly as
 * strong as Kr and no stronger, and it must never be described as if it were an independent factor.
 */
export async function generateResearcherKeypair() {
  return crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['encrypt', 'decrypt']          // extractable: the private half is wrapped under Kr, see above
  );
}
export async function exportPrivateKeyB64(privateKey) {
  return bytesToB64(await crypto.subtle.exportKey('pkcs8', privateKey));
}
// Import a researcher private key for DECRYPT only — it unwraps grants, it never wraps them.
export async function importPrivateKeyB64(b64) {
  return crypto.subtle.importKey('pkcs8', b64ToBytes(b64), { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['decrypt']);
}

// Short fingerprint of a public key (SHA-256 of SPKI) — for out-of-band verification at approval.
export async function publicKeyFingerprint(publicKey) {
  const h = await crypto.subtle.digest('SHA-256', await crypto.subtle.exportKey('spki', publicKey));
  return [...new Uint8Array(h)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
