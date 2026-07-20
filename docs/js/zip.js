/* zip.js — minimal ZIP writer (STORE method, no compression).
 *
 * Bundles a .flextext with its (already-compressed) MP3 recording, so
 * compression would gain nothing. Hand-rolled to keep the app dependency-
 * free and fully offline. UTF-8 filenames (flag bit 11), ZIP version 2.0.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function le16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
function le32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

/**
 * Build a ZIP from entries: [{ name: string, data: Blob|Uint8Array }].
 * @returns {Promise<Blob>}
 */
export async function makeZip(entries) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const data = entry.data instanceof Uint8Array
      ? entry.data
      : new Uint8Array(await entry.data.arrayBuffer());
    const crc = crc32(data);

    const local = new Uint8Array([
      ...le32(0x04034b50),      // local file header signature
      ...le16(20),              // version needed
      ...le16(0x0800),          // flags: UTF-8 names
      ...le16(0),               // method: STORE
      ...le16(time), ...le16(date),
      ...le32(crc),
      ...le32(data.length),     // compressed size (= raw for STORE)
      ...le32(data.length),     // uncompressed size
      ...le16(nameBytes.length),
      ...le16(0),               // extra length
      ...nameBytes,
    ]);
    parts.push(local, data);

    central.push(new Uint8Array([
      ...le32(0x02014b50),      // central directory signature
      ...le16(20), ...le16(20),
      ...le16(0x0800),
      ...le16(0),
      ...le16(time), ...le16(date),
      ...le32(crc),
      ...le32(data.length), ...le32(data.length),
      ...le16(nameBytes.length),
      ...le16(0), ...le16(0),   // extra, comment
      ...le16(0),               // disk number
      ...le16(0),               // internal attrs
      ...le32(0),               // external attrs
      ...le32(offset),          // local header offset
      ...nameBytes,
    ]));
    offset += local.length + data.length;
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array([
    ...le32(0x06054b50),
    ...le16(0), ...le16(0),
    ...le16(entries.length), ...le16(entries.length),
    ...le32(centralSize),
    ...le32(offset),
    ...le16(0),
  ]);

  return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
}
