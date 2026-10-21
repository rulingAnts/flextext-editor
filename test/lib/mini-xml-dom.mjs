/* A deliberately MINIMAL XML DOM for running flextext.js's parser under plain node — no npm deps,
 * because CI runs `node test/*.test.mjs` with no install step. Implements exactly what
 * parseFlextext/parsePhrase/parseWord touch: parseFromString, querySelector('parsererror'),
 * documentElement, tagName, getAttribute, attributes, children, textContent, XMLSerializer.
 * No namespaces, CDATA, comments, or processing instructions beyond skipping the <?xml?> prolog —
 * test fixtures must stay within that. NOT a general parser; do not reuse outside tests. */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => ENT[n]);
const encode = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const encodeAttr = (s) => encode(s).replace(/"/g, '&quot;');

class MiniElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = [];          // [{ name, value }]
    this.childNodes = [];          // MiniElement | string (text)
  }
  get children() { return this.childNodes.filter((c) => c instanceof MiniElement); }
  getAttribute(name) {
    const a = this.attributes.find((x) => x.name === name);
    return a ? a.value : null;
  }
  get textContent() {
    return this.childNodes.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
}

function parseXml(src) {
  let i = 0;
  const s = String(src);
  const skipWs = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  skipWs();
  if (s.startsWith('<?xml', i)) { i = s.indexOf('?>', i); if (i < 0) throw new Error('bad prolog'); i += 2; }

  function parseElement() {
    skipWs();
    if (s[i] !== '<') throw new Error('expected < at ' + i);
    i++;
    const nm = s.slice(i).match(/^[\w:-]+/);
    if (!nm) throw new Error('bad tag name at ' + i);
    const el = new MiniElement(nm[0]);
    i += nm[0].length;
    for (;;) {
      skipWs();
      if (s[i] === '/' && s[i + 1] === '>') { i += 2; return el; }
      if (s[i] === '>') { i++; break; }
      const am = s.slice(i).match(/^([\w:-]+)\s*=\s*"([^"]*)"/);
      if (!am) throw new Error('bad attribute at ' + i);
      el.attributes.push({ name: am[1], value: decode(am[2]) });
      i += am[0].length;
    }
    for (;;) {
      if (i >= s.length) throw new Error('unclosed <' + el.tagName + '>');
      if (s[i] === '<') {
        if (s[i + 1] === '/') {
          const close = s.slice(i).match(/^<\/([\w:-]+)\s*>/);
          if (!close || close[1] !== el.tagName) throw new Error('mismatched close for <' + el.tagName + '> at ' + i);
          i += close[0].length;
          return el;
        }
        el.childNodes.push(parseElement());
      } else {
        const next = s.indexOf('<', i);
        if (next < 0) throw new Error('text outside element');
        const text = decode(s.slice(i, next));
        if (text) el.childNodes.push(text);
        i = next;
      }
    }
  }

  const root = parseElement();
  skipWs();
  if (i < s.length) throw new Error('trailing content after root');
  return root;
}

function serialize(el) {
  if (typeof el === 'string') return encode(el);
  const attrs = el.attributes.map((a) => ` ${a.name}="${encodeAttr(a.value)}"`).join('');
  if (!el.childNodes.length) return `<${el.tagName}${attrs}/>`;
  return `<${el.tagName}${attrs}>${el.childNodes.map(serialize).join('')}</${el.tagName}>`;
}

export function installMiniXmlDom() {
  globalThis.DOMParser = class {
    parseFromString(str /*, type */) {
      try {
        const root = parseXml(str);
        return { documentElement: root, querySelector: () => null };
      } catch (e) {
        const errEl = { textContent: String(e.message || e) };
        return { documentElement: new MiniElement('parsererror'), querySelector: (sel) => (sel === 'parsererror' ? errEl : null) };
      }
    }
  };
  globalThis.XMLSerializer = class {
    serializeToString(el) { return serialize(el); }
  };
}
