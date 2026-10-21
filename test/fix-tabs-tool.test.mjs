// tools/fix-flextext-tabs.html — the standalone fixer Seth sends to a researcher whose .flextext files
// carry tabs (2026-10-21), before the same fixer reaches the panel and the devices in a release. It is
// opened from a file, offline, so it cannot import the engine: it carries COPIES of the two functions
// the export backstop uses. This keeps the copies honest until the in-app fixer replaces the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const TOOL = readFileSync(new URL('../tools/fix-flextext-tabs.html', import.meta.url), 'utf8');
const FX = readFileSync(new URL('../docs/js/flextext.js', import.meta.url), 'utf8');
const fn = (src, name) => {
  const m = src.match(new RegExp(`\\n(?:export )?function ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}\\n`))
    || src.match(new RegExp(`\\n(?:export )?function ${name}\\([^)]*\\) \\{[^\\n]*\\}\\n`));   // a one-line function
  assert.ok(m, `${name} found`);
  return m[0].replace(/^\n(?:export )?/, '').trim();
};
const script = TOOL.slice(TOOL.indexOf('<script>') + 8, TOOL.indexOf('</script>'));
// the page's pure part, run in node
const pure = new Function(`${fn(script, 'untabForXml')}\n${fn(script, 'untabFragmentForXml')}\n${fn(script, 'decodeTabRefs')}\n${fn(script, 'fixText')}\nreturn { untabForXml, fixText };`)();

test('the page carries the EXACT rule the export backstop uses', () => {
  for (const name of ['untabForXml', 'untabFragmentForXml']) {
    assert.equal(fn(script, name), fn(FX, name).replace(/^export /, ''), `${name}: the page's copy matches docs/js/flextext.js — update the page when the engine changes`);
  }
});

test('it changes text, never layout, and leaves a clean file byte for byte', () => {
  const src = '<?xml version="1.0" encoding="utf-8"?>\n<document>\n\t<phrase>\n\t\t<item type="txt" lang="x">aa\tbb \tcc</item>\n\t\t<item type="gls" lang="en">\tpst.subj\t</item>\n\t</phrase>\n</document>\n';
  const out = pure.fixText(src);
  assert.match(out, />aa bb cc</);
  assert.match(out, />pst\.subj</);
  assert.equal(out.split('\n').length, src.split('\n').length, 'same lines');
  assert.ok(out.includes('\n\t<phrase>\n\t\t<item'), 'indentation tabs are layout, untouched');
  const clean = '<?xml version="1.0"?>\n<document><item type="txt">aa  bb</item></document>\n';
  assert.equal(pure.fixText(clean), clean, 'no tab: not one byte changed (double spaces included)');
});

test('a tab written as a character reference is caught too', () => {
  assert.match(pure.fixText('<a><item type="txt">aa&#9;bb</item></a>'), />aa bb</);
  assert.match(pure.fixText('<a><item type="txt">aa&#x09;bb</item></a>'), />aa bb</);
});

test('the page is self-contained: no network, nothing loaded from anywhere', () => {
  assert.doesNotMatch(TOOL, /\bfetch\(|XMLHttpRequest|navigator\.sendBeacon|WebSocket|import\(/, 'no request of any kind');
  assert.doesNotMatch(TOOL, /<(script|link|img|iframe)[^>]+(src|href)=/i, 'no external script, stylesheet, image or frame');
  assert.match(TOOL, /Your original file is not changed, and nothing leaves this computer/);
  // checked before the download is offered: well-formed, same elements, no tab left
  for (const m of ['the fixed copy is well-formed XML', 'it has exactly the same elements as the original', 'no tab is left in any text']) {
    assert.ok(TOOL.includes(m), m);
  }
  assert.match(TOOL, /if \(!allOk\) \{[^}]*is not offered/, 'a copy that fails a check is never offered');
});
