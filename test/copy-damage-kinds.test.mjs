/* A DAMAGED COPY IS NOT ALWAYS AN EMPTY ONE (plans/move-upload-guards.md §2.1, §12 — the review).
 *
 * WHY THIS TEST EXISTS: the first build of the guards had one word for every file that failed the
 * structural check — "damaged" — and treated all of them as holding nothing. The review found three
 * ways that lost work:
 *   - CLEANUP trashed a 25-line, 40-gloss copy because its last 40 bytes were missing, or because one
 *     line carried a stray U+0000, while it KEPT a 4-line copy of the same text;
 *   - a DEVICE refused to queue any build of a text containing one NUL, so Send, Done, "Ask to send"
 *     and a move's release failed for ever — the opposite of "never refuse the only backup";
 *   - a copy holding FLEx morpheme analyses, literal translations or notes counted the same as a plain
 *     copy, so cleanup trashed the analysed one as "no more lines, words, glosses or timings".
 * And a fourth that cost a move: the serializer wrote a pasted control character raw, so a copy the
 * panel counted as fine could not be opened by the device it was sent to (nor by FLEx).
 *
 * The real flextext.js functions run here, and the real cleanupPlan is lifted from the panel.
 *
 * Run: node --test test/copy-damage-kinds.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { flextextStats, checkFlextextBytes, serializeFlextext, makeDoc, reconcileBaseline } = await import('../docs/js/flextext.js');

const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
const grab = (re, what) => { const m = panel.match(re); assert.ok(m, `${what} is findable`); return m[0]; };
const helpers = grab(/const STAT_ALL = [\s\S]*?\nfunction statsHaveContent\(s\) \{[\s\S]*?\n\}/, 'the stat helpers');
const planSrc = grab(/function cleanupPlan\(\{ backups, stats, deviceIds, keepIds \}\) \{[\s\S]*?\n\}/, 'cleanupPlan');
const { cleanupPlan, STAT_ALL, STAT_CONTENT, statsHaveContent } = new Function(`${helpers}\n${planSrc}\nreturn { cleanupPlan, STAT_ALL, STAT_CONTENT, statsHaveContent };`)();

const SET = { vernLang: 'qaa', analLang: 'id' };
const xml = (lines, { glossed = 0, guid = 'G-A' } = {}) => {
  const d = makeDoc(SET, 'Cerita');
  d.textAttrs.guid = guid;
  reconcileBaseline(d, lines.length ? lines : ['']);
  let g = glossed;
  for (const p of d.paragraphs) for (const s of p.segments) for (const w of s.words) if (g > 0 && !w.punct) { w.gls = 'x'; g--; }
  return serializeFlextext(d, SET);
};
const lines = (n) => Array.from({ length: n }, (_, i) => `kata ${i + 1} lagi`);
let seq = 0;
const copy = (day, body) => ({ id: 'f' + (++seq), name: `Cerita ${day}.flextext`, modified: `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`,
  size: body.length, role: '', sha256: '', body });
const stateOf = (st) => (st.ok ? 'ok' : st.damaged ? 'damaged' : 'unreadable');   // copyStats' own mapping
const plan = (files) => cleanupPlan({ backups: files, deviceIds: new Set(), keepIds: new Set(),
  stats: new Map(files.map((f) => { const st = flextextStats(f.body); return [f.id, { state: stateOf(st), stats: st }]; })) });
const verdictOf = (p, f) => p.rows.find((r) => r.file.id === f.id).verdict;

test('HOLLOW vs PARTIAL: only a file that holds nothing is "damaged"; a cut-off or NUL-marked copy is kept', () => {
  assert.equal(checkFlextextBytes('\u0000'.repeat(489)).hollow, true, 'the 489-byte all-NUL file holds nothing');
  assert.equal(checkFlextextBytes('').hollow, true);
  assert.equal(checkFlextextBytes('<html></html>').hollow, true);
  const full = xml(lines(25), { glossed: 40 });
  const cut = checkFlextextBytes(full.slice(0, full.length - 40));
  assert.equal(cut.reason, 'truncated');
  assert.equal(cut.hollow, false, 'cut off after 25 lines of work: it holds work, it is not empty');
  assert.equal(checkFlextextBytes(full.slice(0, 200)).hollow, true, '...but cut off before the first line, it holds nothing');
  const ls = lines(25); ls[7] = 'kata 8\u0000 lagi';
  const oneNul = checkFlextextBytes(xml(ls, { glossed: 40 }).replace('kata 8 lagi', 'kata 8\u0000 lagi'));
  assert.equal(oneNul.ok, false);
  assert.equal(oneNul.hollow, false, 'one stray NUL in a whole file is not "holds nothing"');

  const sTrunc = flextextStats(full.slice(0, full.length - 40));
  assert.equal(sTrunc.damaged, false, 'flextextStats: damaged means hollow, and only hollow');
  assert.equal(sTrunc.partial, true);
  assert.equal(stateOf(sTrunc), 'unreadable', 'so copyStats calls it unreadable — unknown, which every caller keeps');
});

test('CLEANUP keeps the partial copy that holds the work, and still trashes the hollow one', () => {
  const full = xml(lines(25), { glossed: 40 });
  const trunc = copy(10, full.slice(0, full.length - 40));
  const old4 = copy(2, xml(lines(4)));
  const p = plan([trunc, old4]);
  assert.equal(verdictOf(p, trunc), 'keepPartial', 'the review says it is damaged but may hold work — and keeps it');
  assert.deepEqual(p.trash, []);
  const nulNewest = copy(11, '\u0000'.repeat(489));
  const p2 = plan([nulNewest, old4]);
  assert.equal(verdictOf(p2, nulNewest), 'trashEmpty', 'the all-NUL file that landed last still goes');
  assert.equal((i18n.match(/^  'panel\.dl\.cleanup\.keepPartial':/gm) || []).length, 2, 'keepPartial is worded in English AND Indonesian');
});

test('the device QUEUE check never refuses a build over an embedded NUL (finding: never backed up again)', () => {
  const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  const q = app.match(/async function uploadDocById\(docId, opts = \{\}\) \{[\s\S]*?\n\}/)[0];
  assert.match(q, /if \(!chk\.ok && chk\.reason !== 'nulSome'\)/, 'only a build that holds nothing usable is refused');
  const whole = xml(lines(3)).replace('kata 2 lagi', 'kata 2\u0000 lagi');
  assert.equal(checkFlextextBytes(whole).reason, 'nulSome', 'the reason a whole file with one NUL gets');
});

test('MORPHEMES, literal translations and notes are counted, so an analysed copy outranks a plain one', () => {
  const doc = (morph) => `<?xml version="1.0" encoding="utf-8"?>
<document version="2">
  <interlinear-text guid="G">
    <item type="title" lang="en">Cerita</item>
    <paragraphs><paragraph guid="p1"><phrases><phrase guid="ph1">
      <item type="txt" lang="qaa">baru-ne</item>
      <words><word guid="w1"><item type="txt" lang="qaa">baru-ne</item>${morph ? `
        <morphemes><morph type="stem" guid="m1"><item type="txt" lang="qaa">baru</item><item type="gls" lang="en">house</item></morph>
        <morph type="suffix" guid="m2"><item type="txt" lang="qaa">-ne</item><item type="gls" lang="en">LOC</item></morph></morphemes>` : ''}
        <item type="gls" lang="en">at.house</item></word></words>${morph ? `
      <item type="lit" lang="en">house at</item>
      <item type="note" lang="en">check with the speaker</item>` : ''}
      <item type="note" lang="en">audio 0:00.000–0:01.000</item>
    </phrase></phrases></paragraph></paragraphs>
    <languages><language lang="qaa" vernacular="true"/></languages>
  </interlinear-text>
</document>
`;
  const a = flextextStats(doc(true)), b = flextextStats(doc(false));
  assert.equal(a.morphs, 2);
  assert.equal(a.litChars, 'houseat'.length);
  assert.equal(a.notes, 1, 'a person\'s note counts; the audio time note the app writes does not');
  assert.equal(b.morphs + b.litChars + b.notes, 0);
  for (const k of ['morphs', 'litChars', 'notes']) assert.ok(STAT_ALL.includes(k), `cleanup weighs ${k}`);
  for (const k of ['morphs', 'litChars']) assert.ok(STAT_CONTENT.includes(k), `a move weighs ${k} too (it survives joins)`);
  assert.equal(statsHaveContent({ morphs: 1 }), true);
  const analysed = copy(2, doc(true)), plain = copy(9, doc(false));
  const p = plan([plain, analysed]);
  assert.equal(verdictOf(p, analysed), 'keepRicher', 'the older copy WITH the morpheme analysis is kept');
});

test('a control character a file cannot carry: the panel SEES it, and the serializer no longer writes it', () => {
  const d = makeDoc(SET, 'Cerita');
  reconcileBaseline(d, ['satu\u000Bdua', 'tiga\u0007empat']);
  const out = serializeFlextext(d, SET);
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(out), 'nothing XML forbids reaches the file');
  assert.ok(out.includes('satu dua'), 'a vertical or form-feed break becomes a space — it separated words');
  assert.ok(out.includes('tigaempat'), 'any other control character is dropped');
  assert.equal(d.paragraphs[0].segments[0].baseline.includes('\u000B'), true, 'the text on the device is untouched — only the file changes');
  // A copy an OLDER engine wrote, with the character raw:
  const raw = xml(['satu dua']).replace('satu dua', 'satu\u000Bdua');
  const s = flextextStats(raw);
  assert.equal(s.ok, true, 'still counted (the panel blanks it before parsing)');
  assert.equal(s.forbidden, 1, '...but flagged: a device\'s strict parser cannot open this file');
  assert.equal(flextextStats(xml(['satu dua'])).forbidden, 0);
});
