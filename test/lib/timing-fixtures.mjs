/* The timing skeletons under test/fixtures/timing/ (plans/time-gaps-and-estimates.md §6.2, D16): real
 * files' offsets, notes and guids, with every word, gloss and translation replaced by "w" and every
 * title by the text's neutral label — no Fayu text, speaker or place in this public repo
 * (timing-fixtures-clean.test.mjs holds them to that). Loaded the way the editor imports a file:
 * parsed, then app.js's own normalizePhraseLines (lifted from the source, so it cannot drift) —
 * one phrase per line, spans from the offsets. */
import { readFileSync, readdirSync } from 'node:fs';
import { installMiniXmlDom } from './mini-xml-dom.mjs';
installMiniXmlDom();
const ft = await import('../../docs/js/flextext.js');

export const FIXTURE_DIR = new URL('../fixtures/timing/', import.meta.url);
/* Each recording's decoded length in ms (v713 audit), so the duration-sensitive rules see what a
 * device sees. T53's m4a decodes 63 ms SHORTER than its last line's end; E19's 7 ms shorter. */
export const DURATION = {
  elan40: 125457, e19: 45990, t151: 362131, 'l29-damaged': 50879, 'l29-13aug': 50879,
  e78: 157179, t53: 87755, t18: 25867,
  u60: 207331,   // v718: the all-untimed FLEx export — 60 phrases in ONE paragraph, no times at all
};
export const fixtureNames = () => readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.flextext')).map((f) => f.replace(/\.flextext$/, ''));
export const fixtureXml = (name) => readFileSync(new URL(name + '.flextext', FIXTURE_DIR), 'utf8');

const APP = readFileSync(new URL('../../docs/js/app.js', import.meta.url), 'utf8');
function lift(src, name) {
  const i = src.indexOf(`\nfunction ${name}(`);
  if (i < 0) throw new Error('app.js has no function ' + name);
  let d = 0, k = src.indexOf('{', src.indexOf(')', i));
  for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) break; }
  return src.slice(i + 1, k + 1);
}
export const normalizePhraseLines = new Function('ft',
  `const { segmentsFromOffsets, makeSegment, newGuid } = ft; ${lift(APP, 'normalizePhraseLines')}; return normalizePhraseLines;`)(ft);

/** A parsed (and, by default, opened) doc — the import path's shape. */
export function openXml(xml, { open = true } = {}) {
  const doc = ft.parseFlextext(xml, { vernLang: 'fau', analLang: 'id' }).texts[0];
  if (open) normalizePhraseLines(doc);
  return doc;
}
export const loadFixture = (name, opts) => openXml(fixtureXml(name), opts);
export { ft };
