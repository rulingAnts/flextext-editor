/* v8-value.js — turn the bytes Chromium stores for an IndexedDB value back into a JS value.
 *
 * A stored value is three layers deep:
 *   1. Blink's IndexedDB wrapper, used only for big values: 0xFF 0x11 then a command —
 *      0x02 "the rest is Snappy-compressed", 0x01 "the real bytes live in a blob file".
 *   2. Blink's envelope: 0xFF <blink version> [0xFE <trailer offset:8> <trailer size:4>].
 *   3. V8's ValueSerializer stream: 0xFF <v8 version>, then one tagged value.
 * Reference: v8/src/objects/value-serializer.cc; third_party/blink/renderer/bindings/core/v8/
 * serialization/ (serialization_tag.h, v8_script_value_deserializer.cc);
 * third_party/blink/renderer/modules/indexeddb/idb_value_wrapping.cc.
 *
 * Only what structured clone can put in a FlexText record is needed — objects, arrays, strings,
 * numbers, booleans, dates, blobs — but the common V8 tags are all handled so an unexpected field
 * does not take its neighbours down with it.
 *
 * ⚠ A VALUE THAT CANNOT BE FULLY DECODED IS RETURNED PARTIALLY, NEVER DROPPED. If decoding fails
 * halfway through a record, everything read before the failure is still handed back with `error`
 * set. For a recovery tool, "the record had one field we could not read" must never become "the
 * text is not there".
 */
import { snappyUncompress } from './snappy.js';
import { varint } from './leveldb.js';

const WRAPPED = 0x11;            // Blink's kRequiresProcessingSSVPseudoVersion
const REPLACE_WITH_BLOB = 0x01;
const SNAPPY = 0x02;

/* Layer 1. `externals` is the record's blob list (from its blob-entry key); `readExternal(obj)`
 * returns that blob's bytes. The wrapper blob is one of the record's externals, so it is reported
 * back in `consumed` and the caller can leave it out of what it shows as attachments. */
export async function unwrapIdbValue(bytes, externals = [], readExternal = null) {
  const consumed = new Set();
  for (let depth = 0; depth < 4 && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === WRAPPED; depth++) {
    const cmd = bytes[2];
    if (cmd === SNAPPY) {
      bytes = snappyUncompress(bytes.subarray(3));
    } else if (cmd === REPLACE_WITH_BLOB) {
      let p = 3;
      let size;
      let index;
      [size, p] = varint(bytes, p);
      [index, p] = varint(bytes, p);
      const ext = externals[index];
      if (!ext) throw new Error(`value is stored in blob #${index}, which this record does not list`);
      if (!readExternal) throw new Error('value is stored in a blob file, and no blob folder was provided');
      const inner = await readExternal(ext);
      if (!inner) throw new Error(`value is stored in blob file ${ext.path || ext.blobNumber}, which was not found`);
      if (inner.length !== size) throw new Error(`blob file holds ${inner.length} bytes, the record expects ${size}`);
      consumed.add(index);
      bytes = inner;
    } else {
      throw new Error(`unknown IndexedDB value wrapper command ${cmd}`);
    }
  }
  return { bytes, consumed };
}

/* Layers 2 and 3. Returns { value, error, blinkVersion, v8Version }. */
export function deserialize(bytes, externals = []) {
  let p = 0;
  let blinkVersion = 0;
  let v8Version = 0;
  if (bytes[p] === 0xff) {
    p++;
    [blinkVersion, p] = varint(bytes, p);
    if (bytes[p] === 0xfe) p += 13;            // trailer offset + size; the trailer is not needed
    if (bytes[p] === 0xff) { p++; [v8Version, p] = varint(bytes, p); }
    else { v8Version = blinkVersion; }          // very old data: one shared envelope
  }
  const r = new Reader(bytes, p, v8Version, blinkVersion, externals);
  try {
    return { value: r.readValue(), error: null, blinkVersion, v8Version };
  } catch (e) {
    return { value: e.partial, error: e.message || String(e), blinkVersion, v8Version };
  }
}

class Reader {
  constructor(b, p, v8Version, blinkVersion, externals) {
    this.b = b;
    this.p = p;
    this.v8Version = v8Version;
    this.blinkVersion = blinkVersion;
    this.externals = externals;
    this.objects = [];
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }

  fail(msg) { throw new Error(`${msg} (at byte ${this.p})`); }
  byte() { if (this.p >= this.b.length) this.fail('value ends early'); return this.b[this.p++]; }
  tag() { let t; do { t = this.byte(); } while (t === 0x00); return t; }             // 0x00 = padding
  peek() { let q = this.p; while (q < this.b.length && this.b[q] === 0x00) q++; return this.b[q]; }
  varint() { const [v, p] = varint(this.b, this.p); this.p = p; return v; }
  zigzag() { const v = this.varint(); return v % 2 ? -(v + 1) / 2 : v / 2; }
  double() {
    if (this.p + 8 > this.b.length) this.fail('number runs past the end');
    const v = this.dv.getFloat64(this.p, true);
    this.p += 8;
    return v;
  }
  raw(n) {
    if (this.p + n > this.b.length) this.fail('data runs past the end');
    const out = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return out;
  }
  oneByte() { const n = this.varint(); let s = ''; const r = this.raw(n); for (let i = 0; i < r.length; i++) s += String.fromCharCode(r[i]); return s; }
  twoByte() { const n = this.varint(); return new TextDecoder('utf-16le').decode(this.raw(n)); }
  utf8() { const n = this.varint(); return new TextDecoder().decode(this.raw(n)); }
  reg(obj) { this.objects.push(obj); return obj; }

  readValue() {
    const t = this.tag();
    switch (t) {
      case 0x5f: return undefined;                 // _
      case 0x30: return null;                      // 0
      case 0x54: return true;                      // T
      case 0x46: return false;                     // F
      case 0x49: return this.zigzag();             // I  int32
      case 0x55: return this.varint();             // U  uint32
      case 0x4e: return this.double();             // N  double
      case 0x5a: return this.bigint();             // Z
      case 0x22: return this.oneByte();            // "  Latin-1 string
      case 0x63: return this.twoByte();            // c  UTF-16LE string
      case 0x53: return this.utf8();               // S  UTF-8 string (old versions)
      case 0x5e: {                                 // ^  back-reference
        const id = this.varint();
        if (!(id in this.objects)) this.fail(`reference to unknown object #${id}`);
        return this.objects[id];
      }
      case 0x6f: return this.object();             // o
      case 0x41: return this.denseArray();         // A
      case 0x61: return this.sparseArray();        // a
      case 0x44: return this.reg(new Date(this.double()));             // D
      case 0x79: return this.reg(Object(true));                        // y
      case 0x78: return this.reg(Object(false));                       // x
      case 0x6e: return this.reg(Object(this.double()));               // n
      case 0x7a: return this.reg(Object(this.bigint()));               // z
      case 0x73: return this.reg(Object(this.stringValue()));          // s
      case 0x52: {                                                     // R  RegExp
        const slot = this.objects.push(null) - 1;
        const src = this.stringValue();
        const flags = this.varint();
        const f = ['g', 'i', 'm', 'y', 'u', 's', 'd', 'v'].filter((_, i) => flags & (1 << i)).join('');
        let re;
        try { re = new RegExp(src, f); } catch { re = { regexp: src, flags: f }; }
        this.objects[slot] = re;
        return re;
      }
      case 0x3b: return this.map();                // ;
      case 0x27: return this.set();                // '
      case 0x42: return this.arrayBuffer(false);   // B
      case 0x7e: return this.arrayBuffer(true);    // ~  resizable
      case 0x5c: return this.hostObject();         // \  Blink object (blob, file, view…)
      case 0x72: return this.error();              // r
      default:
        return this.fail(`unsupported value tag 0x${t.toString(16)}`);
    }
  }

  stringValue() {
    const t = this.tag();
    if (t === 0x22) return this.oneByte();
    if (t === 0x63) return this.twoByte();
    if (t === 0x53) return this.utf8();
    return this.fail(`expected a string, found tag 0x${t.toString(16)}`);
  }

  bigint() {
    const bitfield = this.varint();
    const bytes = this.raw(Math.floor(bitfield / 2));
    let v = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
    return bitfield & 1 ? -v : v;
  }

  /* The property loop shared by objects and arrays: reads key/value pairs until `end`, attaching
   * whatever was salvaged if a value fails partway. */
  props(target, end) {
    let key;
    try {
      while (this.peek() !== end) {
        if (this.p >= this.b.length) this.fail('object never closes');
        key = undefined;
        const k = this.readValue();
        key = k;
        target[k] = this.readValue();
      }
      this.tag();
    } catch (e) {
      if (key !== undefined && e.partial !== undefined) target[key] = e.partial;
      e.partial = target;
      throw e;
    }
  }

  object() {
    const obj = this.reg({});
    this.props(obj, 0x7b);                       // {
    this.varint();                               // property count — not needed
    return obj;
  }

  denseArray() {
    const len = this.varint();
    const arr = this.reg(new Array(len));
    let i = 0;
    try {
      for (; i < len; i++) {
        if (this.peek() === 0x2d) { this.tag(); continue; }  // -  hole
        arr[i] = this.readValue();
      }
    } catch (e) {
      if (e.partial !== undefined) arr[i] = e.partial;
      e.partial = arr;
      throw e;
    }
    this.props(arr, 0x24);                       // $
    this.varint();
    this.varint();
    return arr;
  }

  sparseArray() {
    const len = this.varint();
    const arr = this.reg(new Array(len));
    this.props(arr, 0x40);                       // @
    this.varint();
    this.varint();
    return arr;
  }

  map() {
    const m = this.reg(new Map());
    while (this.peek() !== 0x3a) m.set(this.readValue(), this.readValue());   // :
    this.tag();
    this.varint();
    return m;
  }

  set() {
    const s = this.reg(new Set());
    while (this.peek() !== 0x2c) s.add(this.readValue());                    // ,
    this.tag();
    this.varint();
    return s;
  }

  arrayBuffer(resizable) {
    const len = this.varint();
    if (resizable) this.varint();                // max length
    const buf = this.reg(this.raw(len).slice().buffer);
    if (this.peek() === 0x56) {                  // V  a view over the buffer just read
      this.tag();
      return this.view(buf);
    }
    return buf;
  }

  view(buf) {
    const sub = this.byte();
    const offset = this.varint();
    const length = this.varint();
    if (this.v8Version >= 14) this.varint();     // flags
    return this.reg(makeView(sub, buf, offset, length));
  }

  hostObject() {
    const t = this.byte();
    if (t === 0x69 || t === 0x65) {              // i blob index, e file index
      const index = this.varint();
      const ext = this.externals[index] || null;
      return this.reg({ __external: t === 0x65 ? 'file' : 'blob', index, info: ext });
    }
    if (t === 0x4c) {                            // L  file list (by index)
      const n = this.varint();
      const list = [];
      for (let i = 0; i < n; i++) {
        const index = this.varint();
        list.push({ __external: 'file', index, info: this.externals[index] || null });
      }
      return this.reg(list);
    }
    if (t === 0x62) {                            // b  blob by uuid (not used by IndexedDB)
      const uuid = this.utf8();
      const type = this.utf8();
      const size = this.varint();
      return this.reg({ __external: 'blob-uuid', uuid, type, size });
    }
    if (t === 0x56) {                            // V  ArrayBufferView, Blink-side
      const buf = this.objects[this.objects.length - 1];
      const sub = this.byte();
      const offset = this.varint();
      const length = this.varint();
      if (this.blinkVersion >= 21 || this.v8Version >= 14) this.varint();
      return this.reg(makeView(sub, buf instanceof ArrayBuffer ? buf : new ArrayBuffer(0), offset, length));
    }
    return this.fail(`unsupported browser object tag 0x${t.toString(16)}`);
  }

  error() {
    const out = this.reg({ __error: true });
    for (;;) {
      const t = this.byte();
      if (t === 0x2e) return out;                                    // .  end
      if (t === 0x6d) out.message = this.stringValue();              // m
      else if (t === 0x73) out.stack = this.stringValue();           // s
      else if (t === 0x63) out.cause = this.readValue();             // c
      else if ('EFRSTU'.includes(String.fromCharCode(t))) out.name = { E: 'EvalError', R: 'RangeError', F: 'ReferenceError', S: 'SyntaxError', T: 'TypeError', U: 'URIError' }[String.fromCharCode(t)];
      else this.fail(`unsupported error field 0x${t.toString(16)}`);
    }
  }
}

function makeView(sub, buf, offset, length) {
  const T = {
    0x62: Int8Array, 0x42: Uint8Array, 0x43: Uint8ClampedArray, 0x77: Int16Array, 0x57: Uint16Array,
    0x64: Int32Array, 0x44: Uint32Array, 0x66: Float32Array, 0x46: Float64Array,
    0x71: BigInt64Array, 0x51: BigUint64Array,
  }[sub];
  try {
    if (sub === 0x3f) return new DataView(buf, offset, length);      // ?  DataView
    if (T) return new T(buf, offset, length / T.BYTES_PER_ELEMENT);
  } catch { /* fall through */ }
  return new Uint8Array(buf, offset, Math.min(length, Math.max(0, buf.byteLength - offset)));
}
