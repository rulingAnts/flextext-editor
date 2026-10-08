/* A .flextext HANDED OVER AS IT CAME LOSES THE EMPTY TIMED LINES A PRE-v709 DEVICE WROTE (v711; Seth, 2026-10-09:
 * "ALL flextext exports on ALL export options have our v709 export fix right?"). The fixture below is exactly what
 * the v707 serializer wrote for line / blank line / line — frozen here, because no current code can write it any more. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripSilentPhrasesXml } from '../docs/js/flextext.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const PANEL = rd('../docs/js/researcher-panel.js'), SEG = rd('../docs/js/seg-exports.js');
const fn = (src, name) => { const i = src.indexOf(`function ${name}(`); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i)); };

const HEAD = `<?xml version="1.0" encoding="utf-8"?>
<document version="2" exportSource="FlexText Editor v707">
  <interlinear-text guid="t1">
    <item type="title" lang="en">Old device</item>
    <paragraphs>
`;
const LINE1 = `      <paragraph guid="p1">
        <phrases>
          <phrase guid="f1" begin-time-offset="0" end-time-offset="2000">
            <item type="txt" lang="fau">kama fi</item>
            <words>
              <word guid="w1">
                <item type="txt" lang="fau">kama</item>
              </word>
            </words>
            <item type="gls" lang="en">The water is cold.</item>
            <item type="note" lang="en">audio 0:00.000–0:02.000</item>
          </phrase>
        </phrases>
      </paragraph>
`;
const BLANK = `      <paragraph guid="p2">
        <phrases>
          <phrase guid="f2" begin-time-offset="2000" end-time-offset="3500">
            <item type="txt" lang="fau"></item>
            <words>
            </words>
            <item type="note" lang="en">audio 0:02.000–0:03.500</item>
          </phrase>
        </phrases>
      </paragraph>
`;
const LINE3 = `      <paragraph guid="p3">
        <phrases>
          <phrase guid="f3" begin-time-offset="3500" end-time-offset="6000">
            <item type="txt" lang="fau">ani do</item>
            <words>
            </words>
            <item type="note" lang="en">audio 0:03.500–0:06.000</item>
          </phrase>
        </phrases>
      </paragraph>
`;
const TAIL = `    </paragraphs>
    <languages>
      <language lang="fau" vernacular="true" />
      <language lang="en" />
    </languages>
  </interlinear-text>
</document>`;

test('the blank line a v707 device uploaded is removed, its paragraph with it, and not one other byte changes', () => {
  const xml = HEAD + LINE1 + BLANK + LINE3 + TAIL;
  assert.equal(stripSilentPhrasesXml(xml), HEAD + LINE1 + LINE3 + TAIL);
  assert.equal(stripSilentPhrasesXml(xml.replace(/\n/g, '\r\n')), (HEAD + LINE1 + LINE3 + TAIL).replace(/\n/g, '\r\n'), 'a Windows file too');
  const est = BLANK.replace('audio 0:02.000', 'audio ~0:02.000');
  assert.equal(stripSilentPhrasesXml(HEAD + est + TAIL), HEAD + TAIL, 'an estimated time (~) is still our own note');
});

test('anything in a phrase keeps it — the rule is "nothing in it", never "no words"', () => {
  const keep = (from, to, why) => { const b = BLANK.replace(from, to); assert.equal(stripSilentPhrasesXml(HEAD + b + TAIL), HEAD + b + TAIL, why); };
  keep('<item type="txt" lang="fau"></item>', '<item type="txt" lang="fau">ah</item>', 'any text');
  keep('<item type="note" lang="en">audio', '<item type="gls" lang="id">jeda panjang</item>\n            <item type="note" lang="en">audio', 'a translation in any language');
  keep('<item type="note" lang="en">audio 0:02.000–0:03.500</item>', '<item type="note" lang="en">speaker coughs</item>', 'somebody else\'s note');
  keep('<item type="txt" lang="fau"></item>', '<item type="lit" lang="en">x</item>', 'an item we do not know');
  const xml = HEAD + LINE1 + LINE3 + TAIL;
  assert.equal(stripSilentPhrasesXml(xml), xml, 'nothing silent: the same string comes back');
  assert.equal(stripSilentPhrasesXml(''), ''); assert.equal(stripSilentPhrasesXml(null), '');
});

test('a paragraph keeps its other phrases; only one emptied by the removal goes', () => {
  const two = `      <paragraph guid="p9">
        <phrases>
          <phrase guid="a" begin-time-offset="0" end-time-offset="1000">
            <item type="txt" lang="fau">kama</item>
          </phrase>
          <phrase guid="b" begin-time-offset="1000" end-time-offset="2000">
            <item type="txt" lang="fau"></item>
            <words/>
            <item type="segnum" lang="en">2</item>
          </phrase>
        </phrases>
      </paragraph>
`;
  const out = stripSilentPhrasesXml(HEAD + two + TAIL);
  assert.match(out, /<paragraph guid="p9">/, 'the paragraph stays');
  assert.match(out, /<phrase guid="a"/); assert.doesNotMatch(out, /<phrase guid="b"/, 'its silent phrase goes (a segnum is numbering, not content)');
});

test('the wiring: Files… ▸ .flextext, the lameta session, Download all and the Convert/Export tool', () => {
  assert.match(PANEL, /saveBlobAs\(new Blob\(\[stripSilentPhrasesXml\(xml\)\], \{ type: 'application\/xml' \}\), base \+ '\.flextext'\);/, 'Files… ▸ .flextext');
  assert.match(PANEL, /lametaFlextextMedia\(stripSilentPhrasesXml\(src\.xml\), /, 'the lameta session\'s .flextext');
  assert.match(PANEL, /add\(zipName\(f\), await withoutSilentLines\(f, await Researcher\.fetchDriveFile\(f\.id,/, 'every .flextext in Download all');
  const w = fn(PANEL, 'withoutSilentLines');
  assert.match(w, /if \(!\(isFlextextName\(f\) \|\| hasRole\(f, SOURCE_FT_ROLES\)\) \|\| !data \|\| typeof data\.text !== 'function'\) return data;/, 'only .flextext files are read; everything else goes out as it came');
  assert.match(w, /return clean === xml \? data : new Blob\(\[clean\]/, 'an unchanged file is the same blob');
  assert.match(SEG, /if \(kind === 'flextext'\) return pack\(\[\{ name: base \+ '\.flextext', data: await cleanFlextextBlob\(flextextBlob\) \}\], ''\);/, 'the Convert/Export tool');
  assert.match(fn(SEG, 'cleanFlextextBlob'), /const clean = stripSilentPhrasesXml\(xml\);/);
});
