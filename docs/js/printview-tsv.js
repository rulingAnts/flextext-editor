/* printview-tsv.js — "copy this line as FLEx's Print view would" (plans/flex-desktop-segmenter.md §10). PURE.
 *
 * FLEx's Print-view copy puts CF_UNICODETEXT on the clipboard: NFC, CRLF line ends, trailing CRLF,
 * TAB-separated piles. This generator rebuilds that text from plain data the shell's printview_data()
 * returns, so LingTeX-Tools (which parses FLEx's own clipboard format) reads our output unchanged.
 *
 * Rules (from FLEx's code — InterlinPrintView / VwSelection::GetSelectionString — not from LingTeX's
 * examples): line 0 = `ref TAB label TAB cells` where ref = paragraph number plus `.segment` only when
 * the paragraph has more than one segment; later lines start with an empty number cell; labels are the
 * English UI strings with ` <WS abbr>` only when a line type repeats; a word bundle spans the sum of its
 * morph columns when morpheme lines are shown, else 1; a variant with an inflection type spreads Lex.
 * Gloss over 3 columns and Lex. Entries over 2; missing data is `***` (guesses only as a labelled
 * option, D10); punctuation (§ included) is a 1-line 1-column pile; Free / Lit. / Note lines are
 * `M_v Free␠ M_v M_a text` with U+200E (U+200F for RTL), omitted for a Graphite-enabled WS. */

const FLID = { word: 5062001, morphemes: 5112002, lexEntries: 103, lexGloss: 5112004, lexGram: 5112003,
               wordGloss: 5060001, wordCat: 5059003, free: -61, lit: -62, note: -63, media: -65 };
const LABEL = { 5062001: 'Word', 5112002: 'Morphemes', 103: 'Lex. Entries', 5112004: 'Lex. Gloss', 5112003: 'Lex. Gram. Info.',
                5060001: 'Word Gloss', 5059003: 'Word Cat.', '-61': 'Free', '-62': 'Lit.', '-63': 'Note', '-65': 'Media' };
const MISSING = '***';
const LRM = '‎', RLM = '‏';

/* FLEx's standard line set when the user has no saved Print-view configuration. */
export function standardLines(vernWs, analWs) {
  return [{ flid: FLID.word, ws: vernWs }, { flid: FLID.morphemes, ws: vernWs }, { flid: FLID.lexEntries, ws: vernWs },
          { flid: FLID.lexGloss, ws: analWs }, { flid: FLID.lexGram, ws: analWs }, { flid: FLID.wordGloss, ws: analWs },
          { flid: FLID.wordCat, ws: analWs }, { flid: FLID.free, ws: analWs }];
}

function labelsFor(lines, wsAbbr) {
  const count = {};
  for (const l of lines) count[l.flid] = (count[l.flid] || 0) + 1;
  return lines.map((l) => LABEL[l.flid] + (count[l.flid] > 1 ? ' ' + (wsAbbr(l.ws) || l.ws) : ''));
}

const nfc = (s) => String(s == null ? '' : s).normalize('NFC');

/**
 * printViewTsv(data, opts) → string
 *   data: { paraNumber, segNumber, segsInPara, words: [{ form, punct, glosses: {ws: text}, kind,
 *           morphs?: [{ form, lexEntry, lexGloss, lexGram, inflType?, prepend?, append? }], cat? }],
 *           free: {ws: text}, lit: {ws: text}, notes: [{ text, ws }], ws: { vern: [...], anal: [...] } }
 *   opts: { lines?: [{flid, ws, enabled}], showGuesses?: false }
 */
export function printViewTsv(data, opts = {}) {
  const wsInfo = new Map();
  for (const w of [...(data.ws?.vern || []), ...(data.ws?.anal || [])]) wsInfo.set(w.id, w);
  const wsAbbr = (id) => (wsInfo.get(id) || {}).abbr || id;
  const vern = (data.ws?.vern || [])[0]?.id || 'vern';
  const anal = (data.ws?.anal || [])[0]?.id || 'en';
  const lines = (opts.lines || standardLines(vern, anal)).filter((l) => l.enabled !== false);
  const labels = labelsFor(lines, wsAbbr);
  const interlinear = lines.filter((l) => l.flid > 0);
  const morphShown = interlinear.some((l) => [FLID.morphemes, FLID.lexEntries, FLID.lexGloss, FLID.lexGram].includes(l.flid));
  const ref = data.segsInPara > 1 ? `${data.paraNumber}.${data.segNumber}` : `${data.paraNumber}`;

  // piles: one per word; each pile is a list of rows (one per interlinear line) of cells
  const piles = (data.words || []).map((w) => {
    if (w.punct || w.kind === 'punct') {
      return { width: 1, rows: interlinear.map((l, ri) => (ri === 0 ? [nfc(w.form)] : [''])) };
    }
    const morphs = w.morphs && w.morphs.length ? w.morphs : null;
    const width = morphShown && morphs ? morphs.reduce((n, m) => n + (m.inflType ? 3 : 1), 0) : 1;
    const rows = interlinear.map((l) => {
      const cells = [];
      const g = (m, key, ws) => (m[key] && typeof m[key] === 'object' ? m[key][ws] : m[key]);
      switch (l.flid) {
        case FLID.word: cells.push(nfc(w.form)); break;
        case FLID.wordGloss: {
          const v = (w.glosses || {})[l.ws];
          cells.push(v ? nfc(v) : (opts.showGuesses && w.guess && w.guess[l.ws] ? nfc(w.guess[l.ws]) : MISSING));
          break;
        }
        case FLID.wordCat: cells.push(w.cat ? nfc(typeof w.cat === 'object' ? w.cat[l.ws] : w.cat) || MISSING : MISSING); break;
        case FLID.morphemes: if (morphs) for (const m of morphs) { cells.push(nfc(g(m, 'form', l.ws)) || MISSING); if (m.inflType) cells.push('', ''); } else cells.push(MISSING); break;
        case FLID.lexEntries: if (morphs) for (const m of morphs) { cells.push(nfc(g(m, 'lexEntry', l.ws)) || MISSING); if (m.inflType) cells.push(nfc(m.inflType.entry || ''), ''); } else cells.push(MISSING); break;
        case FLID.lexGloss: if (morphs) for (const m of morphs) { if (m.inflType) cells.push(nfc(m.inflType.prepend || ''), nfc(g(m, 'lexGloss', l.ws)) || MISSING, nfc(m.inflType.append || '')); else cells.push(nfc(g(m, 'lexGloss', l.ws)) || MISSING); } else cells.push(MISSING); break;
        case FLID.lexGram: if (morphs) for (const m of morphs) { cells.push(nfc(g(m, 'lexGram', l.ws)) || MISSING); if (m.inflType) cells.push('', ''); } else cells.push(MISSING); break;
        default: cells.push('');
      }
      while (cells.length < width) cells.push('');
      return cells.slice(0, width);
    });
    return { width, rows };
  });

  const out = [];
  interlinear.forEach((l, ri) => {
    const cells = piles.flatMap((p) => p.rows[ri]);
    const label = labels[lines.indexOf(l)];
    out.push([ri === 0 ? ref : '', label, ...cells].join('\t'));
  });
  // Free / Lit. / Note lines: one block per value; empty values still produce a labelled line
  const textLine = (l, flid) => {
    const vals = flid === FLID.free ? (data.free || {}) : flid === FLID.lit ? (data.lit || {}) : null;
    const wsList = lines.filter((x) => x.flid === flid).map((x) => x.ws);
    const multi = wsList.length > 1;
    const text = vals ? (vals[l.ws] || '') : '';
    const info = wsInfo.get(l.ws) || {};
    const mark = info.graphite ? '' : (info.rtl ? RLM : LRM);
    const markA = (wsInfo.get(vern) || {}).graphite ? '' : LRM;
    const label = LABEL[flid] + (multi ? ' ' + wsAbbr(l.ws) : '');
    const prefix = mark ? `${mark}${LABEL[flid]}${multi ? ' ' + wsAbbr(l.ws) : ''} ${mark}${markA}` : label + ' ';
    return ['', prefix + nfc(text)].join('\t');
  };
  for (const l of lines) {
    if (l.flid === FLID.free || l.flid === FLID.lit) out.push(textLine(l, l.flid));
    else if (l.flid === FLID.note) for (const n of (data.notes || [])) out.push(textLine({ ws: n.ws || l.ws }, FLID.note).replace(/\t([^\t]*)$/, (m, p) => '\t' + p + nfc(n.text)));
  }
  return out.map(nfc).join('\r\n') + '\r\n';
}

export { FLID, LABEL, MISSING };
