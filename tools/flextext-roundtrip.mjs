#!/usr/bin/env node
/* SETH'S ROUND-TRIP ACCEPTANCE TESTS ON A REAL .flextext — local, read-only (the FLEx round-trip report,
 * 2026-10-17). test/flextext-roundtrip.test.mjs runs them on a made-up fixture; this runs them on yours.
 *
 *   node tools/flextext-roundtrip.mjs <file.flextext> [more files…] [--paths]
 *
 * Each file goes through the Audio Segmenter's own code (test/lib/segmenter-roundtrip.mjs): the import, on a
 * device set to each of the text's analysis languages in turn (what went wrong was a device whose language
 * is not the text's primary), then:
 *   1. exported at once — it must say what the file said: every paragraph, phrase, word and morph guid, every
 *      item by type, lang and value (segnum aside: FLEx computes it), every hard line break, no notes;
 *   2. its first phrase of two or more words split, both free translations then edited in the primary
 *      language — the first piece keeps the guid, the edits land in that language, every other one as it was;
 *   3. two phrases merged across a hard line break (when the text has one) — the survivor is the first, the
 *      break is gone, each language's free translation is both texts joined in that language;
 *   4. one word's gloss edited in the primary language — that one item, and nothing else, changes;
 *   5. every line given a time, the recording attached — every timed phrase names a <media> the file has.
 *
 * ⚠ IT PRINTS NO TEXT: PASS or FAIL per check, with counts. The files are real language data from real
 * people, and a log is easy to paste somewhere public. `--paths` adds each file's path, for the person
 * running it on their own machine — never in CI, never committed.
 *
 * ⚠ IT WRITES NOTHING. Each file is read once; every check runs on its own parsed copy. */
import { readFileSync } from 'node:fs';
import { flextextModel, flextextDiff, phrasesOf, itemValue } from '../test/lib/flextext-semantic.mjs';
import { FT, ensureMediaRef, importAs, exportOf, matcher } from '../test/lib/segmenter-roundtrip.mjs';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const showPaths = process.argv.includes('--paths');
if (!files.length) { console.error('usage: node tools/flextext-roundtrip.mjs <file.flextext> [more files…] [--paths]'); process.exit(2); }
const SEGNUM = [/^segnum\|/];
const fold = (s) => String(s ?? '').replace(/[ \t\r\n]+/g, ' ').replace(/^ | $/g, '');   // as flextext-semantic compares a value
const wordsSay = (ws) => JSON.stringify(ws.map((w) => ({ ...w, items: [...w.items].sort() })));
let failed = 0;
const say = (ok, what, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ' — ' + detail : ''}`); if (!ok) failed++; };

files.forEach((file, n) => {
  const xml = readFileSync(file, 'utf8');
  const before = flextextModel(xml);
  const all = phrasesOf(before);
  const was = (guid) => all.find((q) => q.guid === guid);
  const probe = FT.parseFlextext(xml, {}).texts[0];
  const vern = probe.vernLang, prim = probe.analLang;
  const others = [...new Set(probe.languages.filter((l) => !l.vernacular).map((l) => l.lang))].filter((l) => l !== prim);
  const isBreak = (q) => itemValue(q.items, 'txt', vern) === FT.LINE_BREAK;
  const breaks = all.filter(isBreak).length;
  console.log(`\nfile ${n + 1} of ${files.length}${showPaths ? ' ' + file : ''}: ${before.paras.length} paragraphs, ${all.length} phrases (${breaks} hard line breaks); analysis languages ${[prim, ...others].join(', ')} (primary first)`);

  for (const device of [prim, ...others]) {
    console.log(` a device on ${device}:`);
    // 1. no edits
    const out1 = exportOf(importAs(xml, device));
    const d1 = flextextDiff(before, flextextModel(out1), { ignore: SEGNUM });
    const kept = phrasesOf(flextextModel(out1)).filter(isBreak).length;
    say(d1.length === 0, '1 exported at once, it says what the file said', `${d1.length} difference(s)`);
    say(kept === breaks, '1 every hard line break kept', `${kept} of ${breaks}`);
    say(!/type="note"/.test(out1) || (out1.match(/type="note"/g) || []).length === (xml.match(/type="note"/g) || []).length, '1 no notes added');

    // 2. split the first phrase of two or more words, its primary free translation at its first space
    {
      const doc = importAs(xml, device);
      const m = matcher(doc);
      const line = m.MG.lines.find((l) => l.phrases.length === 1 && l.phrases[0].words.filter((w) => !w.punct).length >= 2
        && /\S\s+\S/.test(FT.freeIn(l.phrases[0], prim, prim)));
      if (!line) say(true, '2 split — no phrase of two words with a free translation to split (skipped)');
      else {
        const ph = line.phrases[0], guid = ph.attrs.guid, ft = FT.freeIn(ph, prim, prim);
        m.mgSplitLine(line.id, 1, { [prim]: ft.search(/\S\s/) + 1 });
        const [a, b] = [line.id + 'a', line.id + 'b'];
        m.mgEditFree(a, 'edited one');
        m.mgEditFree(b, 'edited two');
        m.commitTo(doc);
        const ph2 = phrasesOf(flextextModel(exportOf(doc)));
        const k = ph2.findIndex((q) => q.guid === guid), [p, q] = [ph2[k], ph2[k + 1]];
        say(!!p && !!q && !!q.guid && q.guid !== guid && !was(q.guid) && q.para === p.para, '2 the first piece keeps the guid; the second is new, in the same paragraph');
        say(!!q && itemValue(p.items, 'gls', prim) === 'edited one' && itemValue(q.items, 'gls', prim) === 'edited two', `2 the edits land in gls ${prim}`);
        say(!!q && others.every((l) => itemValue(p.items, 'gls', l) === itemValue(was(guid).items, 'gls', l) && !itemValue(q.items, 'gls', l)),
          '2 every other language\'s free translation untouched, whole on the first piece');
        say(!!q && wordsSay([...p.words, ...q.words]) === wordsSay(was(guid).words), '2 every word as it was, guids and glosses');
      }
    }

    // 3. merge across the first hard line break with a phrase on each side, in one paragraph
    {
      const doc = importAs(xml, device);
      const m = matcher(doc);
      const k = m.MG.lines.findIndex((l, i) => i > 0 && l.phrases.length === 1 && m.MG.lines[i - 1].phrases.length === 1
        && (l.phrases[0].breaksBefore || []).length && l.paraOf === m.MG.lines[i - 1].paraOf);
      if (k < 0) say(true, '3 merge across a line break — the text has none between two phrases (skipped)');
      else {
        const a = m.MG.lines[k - 1].phrases[0], b = m.MG.lines[k].phrases[0];
        const joined = (l) => fold([a, b].map((s) => FT.freeIn(s, l, prim).trim()).filter(Boolean).join(' '));
        const gone = b.breaksBefore.map((s) => s.attrs.guid);
        m.mgJoinLine(m.MG.lines[k].id);
        m.commitTo(doc);
        const ph3 = phrasesOf(flextextModel(exportOf(doc)));
        const s = ph3.find((q) => q.guid === a.attrs.guid);
        say(!!s && !ph3.some((q) => q.guid === b.attrs.guid), '3 the survivor is the first phrase');
        say(!ph3.some((q) => gone.includes(q.guid)), '3 the break between them is gone');
        say(!!s && itemValue(s.items, 'gls', prim) === joined(prim), `3 the free translation is both texts, in ${prim}`);
        say(!!s && others.every((l) => (itemValue(s.items, 'gls', l) || '') === joined(l)), '3 every other language joined in that language, and only that');
        say(!!s && wordsSay(s.words) === wordsSay([...was(a.attrs.guid).words, ...was(b.attrs.guid).words]), '3 every word as it was, in order');
        say(ph3.filter(isBreak).length === breaks - gone.length, '3 every other line break kept');
      }
    }

    // 4. one word's gloss, edited in the primary language
    {
      const doc = importAs(xml, device);
      const m = matcher(doc);
      const line = m.MG.lines.find((l) => l.phrases.length === 1 && l.phrases[0].words.some((w) => !w.punct && w.guid && was(l.phrases[0].attrs.guid)));
      const w = line.phrases[0].words.find((x) => !x.punct), wguid = w.guid;
      m.mgEditWord(line.id, 0, 'gls', 'edited gloss');
      m.commitTo(doc);
      const mo = flextextModel(exportOf(doc));
      const d4 = flextextDiff(before, mo, { ignore: SEGNUM });
      const w0 = all.flatMap((q) => q.words).find((x) => x.guid === wguid), w1 = phrasesOf(mo).flatMap((q) => q.words).find((x) => x.guid === wguid);
      say(!!w1 && itemValue(w1.items, 'gls', prim) === 'edited gloss', `4 the gloss lands in that word's gls ${prim}`);
      say(!!w1 && others.every((l) => itemValue(w1.items, 'gls', l) === itemValue(w0.items, 'gls', l)), '4 its other languages as they were');
      say(d4.length === 1, '4 and nothing else in the file changes', `${d4.length} difference(s)`);
    }

    // 5. every line timed, the recording attached as the app attaches it
    {
      const doc = importAs(xml, device);
      doc.segments = doc.paragraphs.map((_, i) => ({ start: i * 1000, end: i * 1000 + 900 }));
      ensureMediaRef({ doc, mediaGuid: null }, 'recording.wav', '');
      const mo = flextextModel(exportOf(doc));
      const media = new Set(mo.media.map((x) => x.guid));
      const timed = phrasesOf(mo).filter((q) => q.attrs['begin-time-offset'] != null);
      const linked = timed.filter((q) => media.has(q.attrs['media-file'])).length;
      say(timed.length === doc.paragraphs.length && linked === timed.length, '5 every timed phrase names a <media> the file has', `${linked} of ${timed.length}`);
      say(phrasesOf(mo).filter(isBreak).every((q) => q.attrs['begin-time-offset'] == null), '5 no hard line break is given a time');
    }
  }
});
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
