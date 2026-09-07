/* sfm.js — Toolbox / generic SFM ("standard format marker") interlinear reader.
 *
 * FORMAT-MODULE RULES (CLAUDE.md): imports nothing, no DOM, no settings, no IndexedDB, no i18n.
 * Runs under plain node; test/sfm.test.mjs is the enforcement.
 *
 * WHAT THESE FILES ARE (verified against SIL's *Technical Notes on Interlinear Import*, the spec
 * for how FLEx itself imports SFM interlinear text):
 *   \_sh v3.0  520  Text        ← Shoebox/Toolbox header line
 *   \id Frog Meets Fish         ← a header block: title/source/comment
 *   \ref Fish.001               ← a REFERENCE marker STARTS A SEGMENT
 *   \tx Todn        lyfch  nyr  ← a TEXT BLOCK: the baseline …
 *   \mb tod  -n     lyfch  nyr  ← … and the fields ALIGNED UNDERNEATH it
 *   \ge frog -Nom   lily.pad by
 *   \ft Long ago a frog lived…  ← the freeform block: free/literal translation, notes
 *
 * ⚠ THE THING THAT MAKES THIS HARD: word↔gloss alignment is by COLUMN POSITION, not token order.
 * Above, `Todn` is ONE word but TWO morphemes, so \tx has three tokens and \ge has four. A gloss
 * belongs to the baseline word whose column span contains the gloss token's start. Zipping the two
 * token lists positionally "works" on simple data and silently mis-glosses every multi-morpheme
 * word — which is most of them in an agglutinative language.
 *
 * ⚠ ONE FILE CAN HOLD A WHOLE CORPUS. A new text starts at an explicit new-text marker OR
 * implicitly whenever a header block appears after body content. The caller picks which text.
 *
 * TIMES AND SPEAKERS: Toolbox itself has none, but **ELAN's "Export as Toolbox file" writes
 * `\ELANBegin`, `\ELANEnd` and `\ELANParticipant` into every record** precisely because the format
 * lacks them — so a Toolbox file that came from ELAN carries real time alignment and speaker
 * names, and (with the audio dropped alongside) imports with working playback. A file authored in
 * Toolbox itself normally has neither.
 */

/* ---------------- tokenizing ---------------- */

// A field is one `\marker content`. A line that does NOT start with a backslash continues the
// previous field (Toolbox wraps long values). Returns [{ marker, value, line }].
export function parseSfm(text) {
  const out = [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const m = raw.match(/^\\(\S+)[ \t]?(.*)$/);
    if (m) {
      out.push({ marker: m[1], value: m[2], line: i + 1 });
    } else if (out.length && raw.trim()) {
      const prev = out[out.length - 1];
      prev.value += (prev.value ? ' ' : '') + raw.trim();   // continuation of the previous field
    }
  }
  return out;
}

/* ---------------- what the wizard shows ---------------- */

export function markerInventory(fields) {
  const by = new Map();
  for (const f of fields) {
    if (f.marker === '_sh') continue;                        // the Shoebox file header, not data
    if (!by.has(f.marker)) by.set(f.marker, { marker: f.marker, count: 0, sample: '' });
    const e = by.get(f.marker);
    e.count++;
    if (!e.sample && f.value.trim()) e.sample = f.value.trim().slice(0, 60);
  }
  return [...by.values()];
}

/* FLEx's own default marker table, plus ELAN's Toolbox-export markers. Shipping these means a
 * conventional file needs ZERO decisions — the user just presses Continue. Anything unrecognised
 * defaults to `ignore` rather than being guessed at. */
const DEFAULTS = {
  baseline: ['tx', 't', 's', 'po', 'lx'],
  gloss: ['ge', 'g', 'gl'],
  morphemes: ['mb', 'm', 'mor'],
  // `fte` before `te`: a real Toolbox file (Das Iau narratives) uses \fte for the free translation
  // and \te for a title translation, and matching `te` first mapped the wrong field to it.
  free: ['ft', 'fte', 'f', 'fe', 'fr', 'fre', 'et', 'st', 'te'],
  literal: ['lt', 'l', 'li', 'lit'],
  // `t` last: it is also a baseline candidate, and detectMapping drops it here if the file uses it
  // for the vernacular line. A real Toolbox file (Das Iau narratives) titles each text with \t.
  title: ['id', 'ti', 'tit', 'title', 'title-e', 'title-v', 'title-s', 'etitle', 'filename', 'itm', 'sectn', 't'],
  ref: ['ref', 'rf', 'tn'],
  note: ['nt', 'nd', 'note', 'cmt', 'com', 'dt', 'fn', 'sn', 'wn', 'en'],
  speaker: ['elanparticipant', 'sp', 'spkr', 'speaker', 'participant'],
  start: ['elanbegin', 'begin', 'starttime'],
  end: ['elanend', 'end', 'endtime'],
  newtext: ['name'],
};

/* ⚠ ONE MARKER, ONE ROLE — and when two roles claim it, the answer is FIXED, not "whichever was
 * written last".
 *
 * The failure this exists to stop, reproduced in the converter's modal: a file with \tx \mb \ge,
 * the user points "Word glosses" at \mb while "Morphemes" still holds \mb, and sfmToTexts resolved
 * \mb to whichever role the mapping object happened to list last. Result: 0 of 2 words glossed, no
 * message, and a gloss-free .flextext that looks like a successful conversion. Object key order is
 * not a decision anybody made — detectMapping writes its keys in DEFAULTS order, and a select the
 * user changes keeps its ORIGINAL position — so the winner depended on nothing a reader could see.
 *
 * The list below IS the decision, ordered by what is lost when a role is dropped: with no baseline
 * there is no text at all, without the gloss the interlinear is empty, `morphemes` is read for
 * nothing (sfmToTexts ignores it) so it gives way to everything.
 *
 * ⚠ THIS IS THE BACKSTOP, NOT THE ANSWER TO THE USER. A mapping that reaches the reader with a
 * collision has already lost information — which role the person meant. The converter's modal
 * resolves it AT THE MOMENT OF THE CHOICE (the newest choice wins, the older role is emptied and
 * said out loud); this rule is for the mappings that arrive with no user event behind them: one
 * remembered from a previous file, one built by another app's wizard, one written in a test. */
export const ROLE_PRIORITY = ['baseline', 'gloss', 'ref', 'newtext', 'title', 'free', 'literal',
                              'speaker', 'start', 'end', 'note', 'morphemes'];

// The same mapping with every marker serving at most one role. Roles not in ROLE_PRIORITY (a role
// added to DEFAULTS and forgotten here) still take part, ranked last — never silently exempt.
export function dedupeMapping(mapping = {}) {
  const out = { ...mapping };
  const order = ROLE_PRIORITY.filter((r) => r in out)
    .concat(Object.keys(out).filter((r) => !ROLE_PRIORITY.includes(r)));
  const owner = new Map();
  for (const role of order) {
    const marker = String(out[role] || '').toLowerCase();
    if (!marker) continue;
    if (owner.has(marker)) delete out[role];
    else owner.set(marker, role);
  }
  return out;
}

export function detectMapping(fields) {
  const present = new Set(fields.map((f) => f.marker.toLowerCase()));
  /* ⚠ A TITLE THAT OCCURS ONCE IN A FILE OF MANY RECORDS IS THE FILE'S ID, NOT A TEXT'S TITLE.
   * Measured on two real Toolbox files (Das Iau narratives, 2026-09-07): `\id txnara.txt` appears
   * ONCE and `\t` appears eleven times, once per story. Taking `\id` — first in the candidate list
   * — named the whole file and, because a title only splits texts when it recurs, collapsed eleven
   * narratives into a single 407-line text. Counting fixes it without guessing: among the title
   * markers a file actually has, prefer one that recurs, keeping the list's order among those. */
  const count = new Map();
  for (const f of fields) { const k = f.marker.toLowerCase(); count.set(k, (count.get(k) || 0) + 1); }
  const m = {};
  for (const [role, markers] of Object.entries(DEFAULTS)) {
    const here = markers.filter((x) => present.has(x));
    const hit = (role === 'title' ? (here.find((x) => (count.get(x) || 0) > 1) || here[0]) : here[0]);
    if (hit) {
      // Give back the marker with the file's own capitalisation (\ELANBegin, not \elanbegin).
      m[role] = (fields.find((f) => f.marker.toLowerCase() === hit) || {}).marker || hit;
    }
  }
  /* `t` is a candidate for BOTH the vernacular line and the title. When a file uses it for the
   * baseline it cannot also be the title, so the title is dropped rather than left ambiguous —
   * `baseline` outranks `title` in ROLE_PRIORITY, which is the general form of that same rule and
   * covers any other overlap the candidate lists grow later. */
  return dedupeMapping(m);
}

/* ---------------- column alignment ---------------- */

// Tokens with their START COLUMN in the raw field value — the whole basis of gloss alignment.
export function tokensWithColumns(value) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(value)) !== null) out.push({ text: m[0], col: m.index });
  return out;
}

// Join a word's morpheme glosses: "frog" + "-Nom" → "frog-Nom" (never "frog--Nom"), and
// "tod" + "n" → "tod-n" when the file omits the hyphens.
function joinMorphs(parts) {
  return parts.reduce((acc, tok) => {
    if (!acc) return tok;
    const glue = tok.startsWith('-') || tok.startsWith('=') || acc.endsWith('-') || acc.endsWith('=') ? '' : '-';
    return acc + glue + tok;
  }, '');
}

/* Words for ONE text block: baseline tokens, each carrying every gloss token whose start column
 * falls inside that word's span. `tabs` switches to positional pairing, because a file that
 * aligns with TAB characters has no reliable column arithmetic (tab stops are a renderer's
 * choice) — better an honest fallback than confidently wrong columns. */
export function alignBlock(baselineValue, glossValue, { tabs = false } = {}) {
  const words = tokensWithColumns(baselineValue);
  const glosses = tokensWithColumns(glossValue || '');
  if (!glossValue) return words.map((w) => ({ txt: w.text }));
  if (tabs) {
    return words.map((w, i) => (glosses[i] ? { txt: w.text, gls: glosses[i].text } : { txt: w.text }));
  }
  return words.map((w, i) => {
    const next = words[i + 1] ? words[i + 1].col : Infinity;
    const mine = glosses.filter((g) => g.col >= w.col && g.col < next).map((g) => g.text);
    // A gloss token starting slightly LEFT of its word (ragged hand alignment) still belongs to
    // the first word when nothing else claims it.
    if (!mine.length && i === 0) {
      const stray = glosses.filter((g) => g.col < w.col).map((g) => g.text);
      if (stray.length) return { txt: w.text, gls: joinMorphs(stray) };
    }
    return mine.length ? { txt: w.text, gls: joinMorphs(mine) } : { txt: w.text };
  });
}

/* ---------------- time parsing (ELAN's Toolbox export) ---------------- */

// `\ELANBegin 12.345` (seconds) or `00:00:12.345` (clock). Returns ms, or null.
export function parseSfmTime(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (s.includes(':')) {
    const parts = s.split(':').map((x) => parseFloat(x));
    if (parts.some((x) => !Number.isFinite(x))) return null;
    const secs = parts.reduce((acc, x) => acc * 60 + x, 0);
    return Math.round(secs * 1000);
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 1000) : null;   // seconds, as ELAN writes them
}

/* ---------------- fields → texts ---------------- */

/* Returns { texts: [{ title, lines: [{ baseline, words, free, speaker?, start?, end? }] }] }.
 *
 * A RECORD starts at the reference marker (or, with none mapped, at each baseline field). Inside a
 * record, EACH baseline field starts a new TEXT BLOCK whose aligned gloss field follows it; all of
 * a record's blocks make ONE line, because the freeform block (\ft) applies to the whole record. */
export function sfmToTexts(fields, mapping = {}) {
  /* ⚠ dedupeMapping FIRST, and do not "simplify" it away: building roleOf straight from the
   * mapping made a marker claimed by two roles resolve to whichever Object.entries yielded LAST,
   * silently dropping the other role (see ROLE_PRIORITY). A mapping remembered from an earlier
   * file is the everyday way one arrives here — \t as a title in one file, as the vernacular line
   * in the next — and the symptom was "No texts found" on a perfectly good file. */
  const resolved = dedupeMapping(mapping);
  const roleOf = new Map();
  for (const [role, marker] of Object.entries(resolved)) {
    if (marker) roleOf.set(String(marker).toLowerCase(), role);
  }
  const role = (f) => roleOf.get(f.marker.toLowerCase()) || null;

  const hasRef = !!resolved.ref;
  const texts = [];
  let text = null;                 // { title, lines }
  let line = null;                 // the record being built
  let sawBody = false;             // a header field AFTER body content starts a new text
  let pendingBlock = null;         // { baseline, gloss }

  const newText = (title) => { text = { title: title || '', lines: [] }; texts.push(text); sawBody = false; };
  const flushBlock = () => {
    if (!pendingBlock || !line) { pendingBlock = null; return; }
    const tabs = /\t/.test(pendingBlock.baseline) || /\t/.test(pendingBlock.gloss || '');
    const words = alignBlock(pendingBlock.baseline, pendingBlock.gloss, { tabs });
    line.words.push(...words);
    line.baseline = (line.baseline ? line.baseline + ' ' : '') + pendingBlock.baseline.replace(/\s+/g, ' ').trim();
    pendingBlock = null;
  };
  const flushLine = () => { flushBlock(); if (line && (line.baseline || line.words.length || line.free)) text.lines.push(line); line = null; };
  const startLine = () => { flushLine(); if (!text) newText(''); line = { baseline: '', words: [], free: '' }; };

  for (const f of fields) {
    if (f.marker === '_sh') continue;
    const r = role(f);
    const v = f.value;

    /* ⚠ THE NEW-TEXT MARKER USUALLY CARRIES NO TITLE — it is a record number, and FLEx's own
     * documentation says to use its "New Text" destination for "the marker which indicates the
     * beginning of a new text … when that marker does not contain any data to import". Measured on
     * two real Toolbox files (Das Iau narratives, 2026-09-07): `\no 1` starts each text and `\t`
     * holds its actual title, so taking the marker's value gave every text the name "1", "2", "3"
     * and threw the real titles away — the later \t found a title already set and left it alone.
     * The value is now only a FALLBACK, used when nothing else is mapped to hold the title. */
    if (r === 'newtext') { flushLine(); newText(roleOf.has(String(resolved.title || '').toLowerCase()) ? '' : v.trim()); continue; }
    if (r === 'title') {
      // A title after body content means the previous text ended and another begins.
      if (sawBody) { flushLine(); newText(v.trim()); }
      else { if (!text) newText(v.trim()); else if (!text.title) text.title = v.trim(); }
      continue;
    }
    if (r === 'ref') { startLine(); sawBody = true; if (line) line.ref = v.trim(); continue; }

    if (r === 'baseline') {
      sawBody = true;
      // WITH a reference marker, that marker delimits records and a second baseline field is
      // another TEXT BLOCK of the same line. WITHOUT one there is no delimiter at all, so each
      // baseline field has to start its own line — otherwise a whole file collapses into one line.
      if (!line || !hasRef) startLine();
      else flushBlock();
      pendingBlock = { baseline: v, gloss: '' };
      continue;
    }
    if (r === 'gloss') { if (pendingBlock && !pendingBlock.gloss) pendingBlock.gloss = v; continue; }
    if (r === 'morphemes') continue;           // used only to align glosses, never displayed

    if (r === 'free') { flushBlock(); if (line) line.free = (line.free ? line.free + ' ' : '') + v.trim(); sawBody = true; continue; }
    if (r === 'speaker') { if (line) line.speaker = v.trim(); continue; }
    if (r === 'start') { if (line) { const t = parseSfmTime(v); if (t !== null) line.start = t; } continue; }
    if (r === 'end') { if (line) { const t = parseSfmTime(v); if (t !== null) line.end = t; } continue; }
    // everything else (notes, source, literal, unmapped markers) is ignored by design
  }
  flushLine();

  // Times ride only when BOTH ends are real and ordered — never invent or half-invent a span.
  for (const t of texts) {
    for (const l of t.lines) {
      if (!(typeof l.start === 'number' && typeof l.end === 'number' && l.end > l.start)) {
        delete l.start; delete l.end;
      }
      if (!l.free) delete l.free;
      if (!l.speaker) delete l.speaker;
    }
  }
  return { texts: texts.filter((t) => t.lines.length) };
}

/* ---------------- clipboard-paste support (SFM arrives PASTED, not as a file) ----------------
 *
 * Seth's executive decision, 2026-08-05: "don't import SFM through SFM files, provide a text box to
 * paste the SFM code for a single text from whatever source document it's in." Coworkers keep
 * their SFM inside RTF/DOC/DOCX, so there is often no .sfm file to hand us at all — and pasting
 * dissolves the "pick one story out of a corpus" step, because the user selects the story.
 *
 * What pasting COSTS is fidelity of whitespace, and this module pairs glosses to words by COLUMN
 * POSITION. So these helpers exist to notice when a paste cannot be trusted and say so, rather
 * than silently mis-pairing every gloss in the text — the failure mode that quietly corrupts data
 * and is nearly invisible afterwards. */

/* Word processors mangle whitespace in ways that destroy column alignment. Normalize what is
 * safely normalizable (line endings, NBSP, a BOM) and leave everything else alone — in particular
 * never touch runs of spaces, which ARE the alignment. */
export function normalizePastedSfm(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')            // BOM from a Windows editor
    .replace(/\r\n?/g, '\n')           // CRLF (Windows) and CR (old Mac) → LF
    .replace(/\u00A0/g, ' ')           // non-breaking space: Word inserts these silently
    .replace(/[\u2028\u2029]/g, '\n');  // Unicode line/paragraph separators
}

// Does this look like SFM at all? One backslash marker at the start of a line is the whole test.
export const looksLikeSfm = (text) => /^\\\S+/m.test(String(text || ''));

/* ⚠ CAN THE GLOSS COLUMNS BE TRUSTED?
 *
 * Column alignment survives a copy only if the source really used spaces or tabs to line the gloss
 * up under its word. Three things defeat it, and all three are common in a Word document:
 *   - the gloss line is single-spaced, so nothing lines up with anything (there is no geometry to
 *     read, and every gloss lands on the first word it happens to start under);
 *   - the source was displayed in a PROPORTIONAL font, so it looked aligned on screen while the
 *     character columns never matched;
 *   - the geometry is only PARTLY damaged — the runs of spaces are squeezed rather than removed,
 *     or some lines lose them and others do not — so the glosses slide LEFT onto their neighbours
 *     while the file still looks aligned.
 * We cannot detect the font. We can detect the other two, and we can detect a pairing that comes
 * out lopsided — far fewer glossed words than gloss tokens means the tokens bunched onto one word,
 * which is exactly what a mis-aligned paste produces.
 *
 * Returns null when it looks fine, else { reason, sample } for the wizard to show. Never blocks:
 * the user may know better, and the fix (editing words and glosses) is available in the app.
 *
 * ⚠ WHY A SECOND CHECK, WHEN 'lopsided' ALREADY EXISTS: 'lopsided' measures gloss COVERAGE, so it
 * only fires on a TOTAL collapse. Measured on a real Toolbox file (Das Iau narratives,
 * InterlinTxNarA.txt, 2026-09-07) with only the \gl lines' space runs collapsed — exactly what a
 * copy out of the .doc and .rtf files one of Seth's colleagues keeps her texts in does — 86.4% of
 * words still received a gloss, so nothing fired, yet only 55.2% of the word/gloss pairs matched
 * the clean file. Forty-five per cent of the corpus mis-glossed, silently. That is the case this
 * function exists for; a check that misses it is not doing its job. */

/* THE SIGNATURE OF GLOSSES THAT SLID LEFT: a STARVED TAIL. When the gloss line's space runs shrink,
 * its tokens pack toward column 0, so the words at the END of the line run out of gloss to catch
 * and the last word gets nothing — while the line still has plenty of gloss tokens.
 *
 * ⚠ AND WHY IT DOES NOT CRY WOLF ON A SPARSE GLOSS LINE, which is the thing that would make this
 * check worse than useless. A line is only JUDGED when it has at least as many gloss tokens as
 * words: if there are fewer glosses than words then some words must go unglossed and a starved
 * tail proves nothing. Measured over both real files, as a share of judged lines whose last word
 * came out unglossed:
 *
 *      clean file                    1.0%  /  0.9%      ← must never fire
 *      every gap nudged ±1 column    2.4%  /  3.6%      ← hand alignment, must never fire
 *      a quarter of \gl collapsed   12.5%  / 16.1%      ← must fire
 *      half of \gl collapsed        25.3%  / 30.8%      ← must fire
 *      all of \gl collapsed         45.9%  / 62.5%      ← the measured 45%-mis-glossed case
 *
 * The threshold sits at 12% of judged lines, which is ~3× the worst clean reading and ~10× the
 * real files', and it wants at least two starved lines out of at least six judged so that one odd
 * line in a short paste cannot raise the alarm on its own. A file with NO column geometry at all
 * lands in 'single-spaced' above and never reaches here.
 *
 * What the minimum costs, measured story by story on the same two files with every \gl line
 * collapsed (the realistic case, since a person pastes ONE story): 22 of the 24 stories warn, and
 * 0 of the 24 clean ones do. Both misses are 8-and-9-line stories whose glosses are so sparse that
 * fewer than six lines can be judged at all — too little to tell damage from an author who left a
 * line's last word unglossed. That is the side of the trade this check is deliberately on. */
const STARVED_TAIL_SHARE = 0.12, MIN_JUDGED_LINES = 6, MIN_STARVED_LINES = 2;
/* ⚠ SAMPLE THE FILE, NOT ITS FIRST PAGE. This was 12 pairs, which on a corpus file judged the
 * opening story and nothing else: with half of InterlinTxNarA.txt's gloss lines collapsed the
 * whole file starves 25.3% of its lines, while its first 60 pairs starve under the threshold — the
 * damage was real and the sample was too small to see it. 400 pairs is ~1 ms of work (measured on
 * that file, and it runs once per change of the mapping) and still bounds a pathological corpus. */
const RISK_SAMPLE = 400;

export function alignmentRisk(fields, mapping = {}) {
  const bMark = String(mapping.baseline || '').toLowerCase();
  const gMark = String(mapping.gloss || '').toLowerCase();
  if (!bMark || !gMark) return null;                 // no glosses mapped: nothing to mis-pair

  const pairs = [];
  let pending = null;
  for (const f of fields) {
    const m = f.marker.toLowerCase();
    if (m === bMark) pending = f.value;
    else if (m === gMark && pending != null) { pairs.push([pending, f.value]); pending = null; }
  }
  if (!pairs.length) return null;

  const sample = pairs.slice(0, RISK_SAMPLE);
  const hasGeometry = sample.some(([b, g]) => /\t/.test(b) || /\t/.test(g) || /\s{2,}/.test(b) || /\s{2,}/.test(g));
  if (!hasGeometry) {
    return { reason: 'single-spaced', sample: sample[0] };
  }

  // Pairing sanity: how many words actually received a gloss?
  let words = 0, glossed = 0;
  let judged = 0, starved = 0, firstStarved = null;
  for (const [b, g] of sample) {
    const tabs = /\t/.test(b) || /\t/.test(g);
    const out = alignBlock(b, g, { tabs });
    words += out.length;
    glossed += out.filter((w) => w.gls).length;
    // Tab-aligned blocks pair positionally, so column geometry says nothing about them.
    if (tabs) continue;
    const glossTokens = tokensWithColumns(g).length;
    if (out.length < 3 || glossTokens < out.length) continue;
    judged++;
    if (!out[out.length - 1].gls) { starved++; if (!firstStarved) firstStarved = [b, g]; }
  }
  if (words >= 6 && glossed / words < 0.5) {
    return { reason: 'lopsided', sample: sample[0], words, glossed };
  }
  if (judged >= MIN_JUDGED_LINES && starved >= MIN_STARVED_LINES && starved / judged >= STARVED_TAIL_SHARE) {
    return { reason: 'shifted', sample: firstStarved, judged, starved };
  }
  return null;
}

/* A title for a pasted text, which has no filename to fall back on. `\id` is the Toolbox/USFM
 * convention; a mapped title marker wins over it because the user said so explicitly. */
export function titleFromSfm(fields, mapping = {}) {
  const wanted = String(mapping.title || '').toLowerCase();
  if (wanted) {
    const hit = fields.find((f) => f.marker.toLowerCase() === wanted && String(f.value || '').trim());
    if (hit) return String(hit.value).trim().slice(0, 120);
  }
  for (const m of ['id', 'h', 'title', 'name', 't']) {
    const hit = fields.find((f) => f.marker.toLowerCase() === m && String(f.value || '').trim());
    if (hit) return String(hit.value).trim().slice(0, 120);
  }
  return '';
}
