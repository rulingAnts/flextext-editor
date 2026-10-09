/* snappy.js — Snappy decompression (raw format, no framing).
 *
 * Chromium compresses two things this tool has to read with Snappy: LevelDB table blocks
 * (compression type 1 in the block trailer) and large IndexedDB values (Blink's
 * kCompressedWithSnappy wrapper). Format: https://github.com/google/snappy/blob/main/format_description.txt
 *
 * Decompression only, and deliberately strict: a malformed stream throws rather than returning
 * bytes that look plausible, because everything downstream of this would turn wrong bytes into a
 * wrong text with no visible symptom.
 */

export function snappyUncompress(src) {
  let pos = 0;
  let len = 0;
  let mul = 1;
  for (;;) {
    if (pos >= src.length) throw new Error('snappy: truncated length');
    const b = src[pos++];
    len += (b & 0x7f) * mul;
    if (!(b & 0x80)) break;
    mul *= 128;
    if (mul > 2 ** 35) throw new Error('snappy: length varint too long');
  }
  const out = new Uint8Array(len);
  let op = 0;
  while (pos < src.length) {
    const tag = src[pos++];
    const kind = tag & 3;
    if (kind === 0) {
      let n = tag >>> 2;
      if (n >= 60) {
        const bytes = n - 59;
        if (pos + bytes > src.length) throw new Error('snappy: truncated literal length');
        n = 0;
        for (let i = 0; i < bytes; i++) n += src[pos++] * 2 ** (8 * i);
      }
      n += 1;
      if (pos + n > src.length || op + n > len) throw new Error('snappy: literal overruns');
      out.set(src.subarray(pos, pos + n), op);
      pos += n;
      op += n;
      continue;
    }
    let length;
    let offset;
    if (kind === 1) {
      if (pos + 1 > src.length) throw new Error('snappy: truncated copy');
      length = ((tag >>> 2) & 7) + 4;
      offset = ((tag >>> 5) << 8) | src[pos++];
    } else if (kind === 2) {
      if (pos + 2 > src.length) throw new Error('snappy: truncated copy');
      length = (tag >>> 2) + 1;
      offset = src[pos] | (src[pos + 1] << 8);
      pos += 2;
    } else {
      if (pos + 4 > src.length) throw new Error('snappy: truncated copy');
      length = (tag >>> 2) + 1;
      offset = (src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16)) + src[pos + 3] * 0x1000000;
      pos += 4;
    }
    if (offset === 0 || offset > op) throw new Error('snappy: copy offset out of range');
    if (op + length > len) throw new Error('snappy: copy overruns');
    // Byte by byte on purpose: a copy may overlap its own output (offset < length is how Snappy
    // encodes a run), which set()/copyWithin would get wrong.
    let from = op - offset;
    for (let i = 0; i < length; i++) out[op++] = out[from++];
  }
  if (op !== len) throw new Error(`snappy: produced ${op} bytes, header promised ${len}`);
  return out;
}
