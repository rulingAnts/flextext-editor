/* local-storage.js — read Chromium's localStorage LevelDB ("Local Storage/leveldb").
 *
 * One LevelDB holds every site's localStorage for a browser profile. Keys are
 *   "_" <origin> 0x00 <encoding byte> <key>     (0x01 = Latin-1, 0x00 = UTF-16LE)
 * and values carry the same one-byte encoding prefix. Newer Chromium may append a partition to the
 * origin part (storage keys); the origin is still the text before the first "^" or 0x00.
 *
 * The recovery tool needs exactly one thing from here: the FlexText device settings
 * (flextext-ws-settings), because the app resolves writing-system codes for app-authored texts from
 * the LIVE settings at export time (flextext.js serializeFlextext).
 */
import { readLevelDb } from './leveldb.js';

function decodeString(bytes) {
  if (!bytes || !bytes.length) return '';
  const body = bytes.subarray(1);
  if (bytes[0] === 0) return new TextDecoder('utf-16le').decode(body);
  let s = '';
  for (let i = 0; i < body.length; i += 8192) s += String.fromCharCode.apply(null, body.subarray(i, i + 8192));
  return s;
}

/* files: the Local Storage/leveldb directory's files. wantOrigin(origin) → bool limits what is
 * decoded (one profile's localStorage can hold tens of thousands of other sites' keys).
 * Returns Map<origin, Map<key, string>>. */
export async function readLocalStorage(files, wantOrigin = () => true) {
  const ldb = await readLevelDb(files);
  const out = new Map();
  for (const e of ldb.current.values()) {
    if (e.deleted || e.key[0] !== 0x5f) continue;                 // "_"
    const sep = e.key.indexOf(0);
    if (sep < 0) continue;
    let origin = '';
    for (let i = 1; i < sep; i++) origin += String.fromCharCode(e.key[i]);
    origin = origin.split('^')[0];
    if (!wantOrigin(origin)) continue;
    const name = decodeString(e.key.subarray(sep + 1));
    if (!out.has(origin)) out.set(origin, new Map());
    out.get(origin).set(name, decodeString(e.value));
  }
  return { byOrigin: out, problems: ldb.problems };
}
