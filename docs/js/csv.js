/* csv.js — comma / tab / semicolon separated interlinear data.
 *
 * FORMAT-MODULE RULES (CLAUDE.md): imports nothing, no DOM, no settings, no IndexedDB, no i18n.
 * Runs under plain node; test/csv.test.mjs is the enforcement.
 *
 * WHY THIS IS THE LOOSEST IMPORT OF THE FOUR: a spreadsheet has no conventions at all. Toolbox has
 * FLEx's marker table, EAF has tier types and PARENT_REF — a CSV has whatever somebody typed in
 * row 1, if anything. So this module deliberately decides almost nothing: it parses the grid
 * faithfully, reports the columns, and the WIZARD asks which column is what. The only inference is
 * the delimiter and whether row 1 looks like a header.
 *
 * ⚠ WORD GLOSSES PAIR POSITIONALLY HERE, unlike Toolbox. Toolbox aligns glosses to words by COLUMN
 * POSITION because its fields are whitespace-padded text; a spreadsheet cell has no such geometry,
 * so a "words" cell and a "glosses" cell are split on whitespace and paired in order. That means a
 * multi-morpheme word must be written as ONE gloss token (frog-Nom, not "frog -Nom") — which the
 * wizard states plainly, because getting it wrong silently shifts every gloss in the line.
 */

/* ---------------- the grid ---------------- */

// RFC 4180-ish: quoted fields may contain the delimiter, newlines, and doubled quotes.
export function parseDelimited(text, delimiter) {
  const src = String(text).replace(/\r\n?/g, '\n');
  const delim = delimiter || sniffDelimiter(src);
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { rows.push(row); row = []; };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === delim) { pushField(); i++; continue; }
    if (c === '\n') { pushField(); pushRow(); i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { pushField(); pushRow(); }
  // Drop wholly empty trailing rows (a file almost always ends with a newline).
  while (rows.length && rows[rows.length - 1].every((f) => !String(f).trim())) rows.pop();
  return { rows, delimiter: delim };
}

// Pick the delimiter that yields the most CONSISTENT column count — a comma inside prose would
// otherwise beat a tab that actually structures the file.
export function sniffDelimiter(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim()).slice(0, 20);
  if (!lines.length) return ',';
  let best = ',', bestScore = -1;
  for (const d of ['\t', ',', ';', '|']) {
    const counts = lines.map((l) => l.split(d).length);
    const max = Math.max(...counts);
    if (max < 2) continue;
    const same = counts.filter((c) => c === max).length / counts.length;
    const score = same * 10 + Math.min(max, 8);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/* Row 1 is a header when every cell LOOKS LIKE A LABEL: non-numeric, short, and not a sentence.
 * "all non-numeric" alone was not enough — a first line of actual data ("ana bete", "He went
 * out.") passed it, and the file imported one line short. The sentence-punctuation and length
 * tests are what separate a label from prose. The wizard still shows a checkbox, because no
 * heuristic can be right about every file and this one is cheap to correct. */
export function looksLikeHeader(rows) {
  if (rows.length < 2) return false;
  const [h, next] = rows;
  const labelish = h.every((c) => {
    const v = String(c).trim();
    return v && v.length <= 30 && !/^-?[\d.:]+$/.test(v) && !/[.!?]$/.test(v);
  });
  const differs = h.some((c, i) => String(c).trim() !== String(next[i] || '').trim());
  return labelish && differs;
}

export function columnsOf(rows, hasHeader) {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const head = hasHeader ? rows[0] : [];
  const body = hasHeader ? rows.slice(1) : rows;
  return Array.from({ length: width }, (_, i) => {
    const sample = (body.find((r) => String(r[i] || '').trim()) || [])[i] || '';
    return {
      index: i,
      name: String(head[i] || '').trim() || `Column ${i + 1}`,
      sample: String(sample).trim().slice(0, 60),
      filled: body.filter((r) => String(r[i] || '').trim()).length,
    };
  });
}

/* Propose a mapping from header names, when there are any. Everything else the wizard asks. */
const NAME_HINTS = {
  baseline: [/^(text|baseline|vernacular|transcription|utterance|line|words?)$/i],
  gloss: [/^(gloss(es)?|morph(eme)?s?|interlinear)$/i],
  free: [/^(free|translation|english|meaning|ft)$/i, /^free[\s_-]*(translation|trans|tr)$/i, /translation$/i],
  speaker: [/^(speaker|participant|who|voice)$/i],
  start: [/^(start|begin|from|start ?time|onset)$/i],
  end: [/^(end|stop|to|end ?time|offset)$/i],
};

export function detectMapping(columns) {
  const m = {};
  for (const [role, pats] of Object.entries(NAME_HINTS)) {
    const hit = columns.find((c) => pats.some((p) => p.test(c.name)));
    if (hit) m[role] = hit.index;
  }
  // No headers at all: assume the commonest shape, text then translation.
  if (m.baseline === undefined && columns.length) m.baseline = 0;
  if (m.free === undefined && columns.length > 1 && !Object.values(m).includes(1)) m.free = 1;
  return m;
}

/* ---------------- times ---------------- */

// `units` is the user's answer, because a bare 1500 is ambiguous and guessing it wrong silently
// misaligns the whole text: 'auto' (clock, else seconds), 'seconds', 'ms'.
export function parseTime(value, units = 'auto') {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (s.includes(':')) {
    const parts = s.split(':').map((x) => parseFloat(x));
    if (parts.some((x) => !Number.isFinite(x))) return null;
    return Math.round(parts.reduce((acc, x) => acc * 60 + x, 0) * 1000);
  }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  if (units === 'ms') return Math.round(n);
  return Math.round(n * 1000);
}

/* ---------------- grid → lines ---------------- */

export function csvToLines(rows, mapping = {}, opts = {}) {
  const hasHeader = !!opts.hasHeader;
  const units = opts.timeUnits || 'auto';
  const body = hasHeader ? rows.slice(1) : rows;
  const cell = (r, role) => (mapping[role] === undefined || mapping[role] === null ? '' : String(r[mapping[role]] ?? '').trim());

  const lines = [];
  for (const r of body) {
    const baseline = cell(r, 'baseline');
    const free = cell(r, 'free');
    const speaker = cell(r, 'speaker');
    if (!baseline && !free) continue;                 // a wholly empty row is not a line
    const line = { baseline, words: [] };
    const glossCell = cell(r, 'gloss');
    if (baseline) {
      const words = baseline.split(/\s+/).filter(Boolean);
      // POSITIONAL pairing — see the header note. Extra glosses are dropped rather than smeared.
      const glosses = glossCell ? glossCell.split(/\s+/).filter(Boolean) : [];
      line.words = words.map((w, i) => (glosses[i] ? { txt: w, gls: glosses[i] } : { txt: w }));
    }
    if (free) line.free = free;
    if (speaker) line.speaker = speaker;
    const s = parseTime(cell(r, 'start'), units);
    const e = parseTime(cell(r, 'end'), units);
    if (typeof s === 'number' && typeof e === 'number' && e > s) { line.start = s; line.end = e; }
    lines.push(line);
  }
  return { lines };
}

/* A starter file, so "how do I structure it?" is answered by example rather than by prose. */
export function templateCsv() {
  return [
    'Speaker,Start,End,Text,Glosses,Free translation',
    'Barnabas,0.000,1.500,ana bete kabo,3SG go out,He went out.',
    'Tim,1.500,3.250,u sa doba,1SG go village,I went to the village.',
    ',3.250,4.100,toto ari,child laugh,The child laughed.',
    '',
    '# Only ONE column is required: the text (or, for a translation-only analysis, the free',
    '# translation). Leave any column out entirely if you do not have it.',
    '# Glosses pair with the words in order, so write one gloss per word: frog-Nom, not "frog -Nom".',
    '# Times may be seconds (1.5), milliseconds, or a clock (0:01.500) — you say which on import.',
  ].join('\n');
}
