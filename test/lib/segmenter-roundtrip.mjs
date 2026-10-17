/* A .flextext through the Audio Segmenter's own code, under node: the import (parseFlextext + app.js
 * normalizePhraseLines), the Matcher's verbs as they ship (lifted from app.js — test/lib/lift.mjs), Done's
 * write-back, and the export. Shared by test/flextext-roundtrip.test.mjs (a made-up fixture) and
 * tools/flextext-roundtrip.mjs (a real file, locally), so the two cannot drift apart. */
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './mini-xml-dom.mjs';
import { liftAll } from './lift.mjs';
installMiniXmlDom();
export const FT = await import('../../docs/js/flextext.js');
export const APP = readFileSync(new URL('../../docs/js/app.js', import.meta.url), 'utf8');

export const { normalizePhraseLines, ensureMediaRef } = new Function('FT', `
  const { makeSegment, newGuid, segmentsFromOffsets, foldLineBreaks, mediaGuidsOf, esc } = FT;
  const mkGuid = newGuid, isProbablyUrl = (u) => /^https?:/.test(u || '');
  ${liftAll(APP, ['normalizePhraseLines', 'ensureMediaRef'])}
  return { normalizePhraseLines, ensureMediaRef };`)(FT);

// The app's import (importFile): read with THIS device's analysis language, then one phrase per line.
export function importAs(xml, analLang) {
  const doc = FT.parseFlextext(xml, { vernLang: '', analLang }).texts[0];
  normalizePhraseLines(doc);
  return doc;
}
// The Segmenter's export (app.js): times on, the audio notes as the device says — off unless it says so.
export const exportOf = (doc, opts = {}) => FT.serializeFlextext(doc, { analLang: doc.analLang }, { segTimes: true, producedBy: 'test', ...opts });

// The Matcher on a doc's lines (mgLoad's shape); commitTo is Done's write-back (mgCommit's paragraphs).
export function matcher(doc, { breakKind = 'clause' } = {}) {
  const lines = doc.paragraphs.map((p, i) => ({ id: 'ln' + i, phrases: (p.segments || []).slice(), guid: p.guid, paraOf: p.paraOf }));
  const prim = doc.analLang;
  return new Function('env', `
    const { FT, lines, prim, breakKind } = env;
    const { makeSegment, makeWord, mergePhrases, baselineFromWords, newGuid, normalizeBreakKind, applyNewLineBreak,
            setFreeIn, freeIn, setGlossIn, glossIn } = FT;
    const freesOfPhrase = FT.phraseFrees;
    let MG = { docId: 'd', spans: [], lines, selSpan: null, selLine: null, pendingWordCut: null, edited: false, holdDraft: false };
    let mgUndoStack = [], mgRedoStack = [], player = null, current = null;
    const settings = { breakKind };   // 'clause': a split stays in its FLEx paragraph, as FLEx's own does
    const $ = () => null, t = (k) => k, toast = () => {};
    const mgDraw = () => {}, mgSaveDraft = () => {}, mgGuessOf = () => null;
    const mgPrimaryLang = () => prim;
    ${liftAll(APP, ['MG_UNDO_MAX', 'mgSnap', 'mgCapture', 'breakKindSetting', 'mgSplitLine', 'mgSplitSource', 'mgJoinLine',
                    'mgLinePhrase', 'mgRealIndex', 'mgEditWord', 'mgEditFree', 'mgSame', 'mgAdoptGuess'])}
    return { get MG() { return MG; }, depth: () => mgUndoStack.length, mgSplitLine, mgJoinLine, mgEditWord, mgEditFree,
      lineOf: (guid) => MG.lines.find((l) => l.phrases.some((p) => p.attrs.guid === guid)).id,
      commitTo(doc) {
        doc.paragraphs = MG.lines.map((l) => ({ guid: l.guid || newGuid(),
          segments: l.phrases.length > 1 ? [mergePhrases(l.phrases, { prim })] : l.phrases, ...(l.paraOf == null ? {} : { paraOf: l.paraOf }) }));
        doc.segments = [];
      } };
  `)({ FT, lines, prim, breakKind });
}
