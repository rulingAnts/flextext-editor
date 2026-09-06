/* Segmentation export formats — EAF (ELAN-for-FLEx + SayMore profiles), the standalone
 * audio-segment preview page, and the BWF `bext` provenance chunk for derived WAVs.
 *
 * FORMAT MODULE RULES (CLAUDE.md / plan): imports nothing but other format modules — no DOM, no
 * settings, no IndexedDB, no i18n. Input is a plain doc object (+ explicit options); output is a
 * string or ArrayBuffer. Must run under plain `node` (test/seg-exports.test.mjs does exactly that).
 * Satellites load this file cross-path, so it is a SHELL entry in the editor AND both satellite
 * service workers.
 *
 * ⚠ NO SEGNUM IN EAF FILES (Seth, 2026-08-03): line numbers are display sugar, not data. The EAF
 * carries only real content — baseline text, words, word glosses, free translations, times.
 */

import { esc, wordGlosses, phraseFrees, analysisLangs, glossIn, freeIn } from './flextext.js';

/* ---------------- shared helpers ---------------- */

const isAligned = (s) => !!s && typeof s.start === 'number' && typeof s.end === 'number' && !s.timePending;

// One phrase per paragraph is the segmentation-mode invariant (flat mode); walk paragraphs and
// pair phrase i with time segment i. Span precedence per phrase (audit find — a multi-phrase
// paragraph, e.g. merged in ELAN, exported every phrase as PENDING even though each carried its
// own offsets): 1) the LIVE app span when aligned (newest truth for single-phrase paragraphs),
// 2) the phrase's own begin/end-time-offset attributes (imported alignment), 3) pending.
function phraseRows(doc) {
  const segs = Array.isArray(doc.segments) ? doc.segments : [];
  const rows = [];
  let i = 0;
  for (const para of doc.paragraphs || []) {
    for (const phrase of para.segments || []) {
      const b = parseInt(phrase.attrs && phrase.attrs['begin-time-offset'], 10);
      const e = parseInt(phrase.attrs && phrase.attrs['end-time-offset'], 10);
      const own = (Number.isFinite(b) && Number.isFinite(e) && e > b) ? { start: b, end: e } : null;
      const live = para.segments.length === 1 ? (segs[i] || null) : null;
      rows.push({ phrase, span: (live && isAligned(live)) ? live : (own || live) });
    }
    i++;
  }
  return rows;
}

export function fmtClock(ms) {
  const t = Math.max(0, Math.round(ms));
  const m = Math.floor(t / 60000), s = Math.floor((t % 60000) / 1000), f = t % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(f).padStart(3, '0')}`;
}

/* ---------------- .fxpa (FlexText Paragraph Analysis) ---------------- */

/* The interchange for the Paragraph Analysis satellite (Seth, 2026-08-05): JSON inside, a
 * proprietary `.fxpa` extension outside (`.fxp` is FL Studio's; `.fxpa` has no known claimant).
 * OPTIONAL and NOT primary — flextext remains the suite's canonical format; this exists so the
 * paragraph app can carry a grouping TREE + embedded audio in one portable file.
 *
 * Shape: { format, version, title, vernLang, analLang, audio?, lines[], tree[] } —
 * - lines carry STABLE ids (L1..Ln, minted here): tree nodes reference ids, never indexes, so
 *   the grouping survives later bottom-level edits.
 * - TEXT-ONLY is first-class: `audio` may be absent, and a line without alignment simply has no
 *   start/end — the app then works without players/waves (a flextext with no segmentation, or
 *   no audio at all, is a legitimate source).
 * - `speaker` on a line + the optional top-level `speakers[]` — flextext's phrase-level model,
 *   which is what EAF's tier-per-speaker collapses INTO on import. Absent when there is one
 *   speaker, so older files and single-speaker texts are unaffected.
 * - `tree` is written by the paragraph app (empty at export): nodes
 *   { id, level, children[ids], joinType: 'sym'|'asym', head? (asym only), relation,
 *     labels? { childId: 'role' } }. BOTH labels are optional and independent: `relation` names
 *   the whole group, `labels` names each member's role in it (the SSA convention).
 * Returns a plain object; the caller JSON.stringifies it into the `.fxpa` file. */
export function buildFxpa(doc, opts = {}) {
  const { title = 'Text', vernLang = 'und', analLang = 'en', audio = null } = opts;
  const rows = phraseRows(doc);
  const lines = rows.map((r, i) => {
    const t = r.phrase;
    const line = { id: 'L' + (i + 1), baseline: t.baseline || '' };
    if (isAligned(r.span)) {
      line.start = Math.round(r.span.start);
      line.end = Math.round(r.span.end);
      if (r.span.timeEstimated) line.timeEstimated = true;
    }
    line.words = (t.words || []).map((w) => {
      const o = { txt: w.txt || '' };
      if (w.punct) o.punct = true;
      else if (w.gls) o.gls = w.gls;
      return o;
    });
    if (t.free) line.free = t.free;
    // SPEAKER (Seth, 2026-08-04): flextext carries it per PHRASE and so do we — EAF's
    // tier-per-speaker is collapsed to this on import. Optional: absent in a single-speaker text.
    if (t.speaker) line.speaker = t.speaker;
    return line;
  });
  const out = { format: 'flextext-paragraph-analysis', version: 1, title, vernLang, analLang };
  if (audio && audio.b64) {
    out.audio = { b64: audio.b64, mime: audio.mime || 'audio/wav', name: audio.name || 'audio' };
    if (audio.derived) { out.audio.derived = true; out.audio.srcName = audio.srcName || ''; }
  }
  const speakers = opts.speakers && opts.speakers.length
    ? [...opts.speakers]
    : [...new Set(lines.map((l) => l.speaker).filter(Boolean))];
  if (speakers.length) out.speakers = speakers;
  out.lines = lines;
  out.tree = [];
  return out;
}

/* ---------------- EAF (ELAN Annotation Format 3.0) ---------------- */

/* Two profiles from ONE writer (verified against the ELAN manual + SayMore docs, 2026-08-03):
 *
 * - 'flex': the full ELAN-for-FLEx hierarchy `interlinear-text > paragraph > phrase > word`,
 *   tier names in ELAN's decodable `<Speaker>_<element>-<item-type>-<language>` schema. The
 *   PARAGRAPH tier mirrors the phrase tier annotation-for-annotation, SHARING its time slots
 *   (Seth's design): ELAN can MERGE annotations but not split ones with dependents, so starting
 *   maximally split lets the user build real paragraph structure by joining — the same
 *   over-segment-then-merge logic as pause-based breaking. ELAN's FLEx exporter treats both
 *   structural tiers as optional, so their absence elsewhere is safe.
 * - 'saymore': ONLY the two tiers SayMore documents — literal `Transcription` /
 *   `Free Translation`. SIL's docs say extra tiers are ignored and advise against adding any
 *   (SayMore rewrites annotation files), so word/gloss detail is deliberately NOT included —
 *   it lives in the .eaf and the .flextext (Seth, 2026-08-03).
 *
 * Shared machinery: contiguous boundaries share TIME_SLOTs; pending segments get slots WITHOUT
 * TIME_VALUE (ELAN's own unaligned mechanism); empty (silence) segments are empty aligned
 * annotations. All schema-verified in the plan. */
const eafTierNames = (flex, vern, anal) => (flex
  ? { itext: `A_interlinear-text-title-${anal}`, para: 'A_paragraph',
      phrase: `A_phrase-txt-${vern}`, free: `A_phrase-gls-${anal}`,
      word: `A_word-txt-${vern}`, gloss: `A_word-gls-${anal}` }
  : { phrase: 'Transcription', free: 'Free Translation' });

export function serializeEaf(doc, opts = {}) {
  const { profile = 'flex', vern = 'und', anal = 'en', mediaName = '', mediaMime = 'audio/x-wav' } = opts;
  const flex = profile !== 'saymore';
  const names = eafTierNames(flex, vern, anal);

  const rows = phraseRows(doc);
  // TIME_ORDER: one slot per boundary; contiguous aligned neighbours SHARE the joint slot.
  // Pending spans get their own value-less slots (schema-legal; ELAN interpolates their position).
  const slots = [];
  const slot = (value) => { const id = 'ts' + (slots.length + 1); slots.push({ id, value }); return id; };
  let prev = null;                       // { span, endSlot }
  const anns = [];                       // { id, ts1, ts2, text, words:[{id, text, gloss}], free }
  let aid = 0;
  for (const r of rows) {
    const a = { id: 'a' + (++aid), text: r.phrase.baseline || '', free: r.phrase.free || '', frees: phraseFrees(r.phrase), words: [] };
    if (isAligned(r.span)) {
      a.ts1 = (prev && isAligned(prev.span) && prev.span.end === r.span.start) ? prev.endSlot : slot(r.span.start);
      a.ts2 = slot(r.span.end);
    } else {
      a.ts1 = slot(undefined);
      a.ts2 = slot(undefined);
    }
    for (const w of r.phrase.words || []) {
      a.words.push({ id: 'a' + (++aid), text: w.txt || '', gloss: (!w.punct && w.gls) ? w.gls : '', glosses: w.punct ? [] : wordGlosses(w) });
    }
    prev = { span: r.span, endSlot: a.ts2 };
    anns.push(a);
  }

  /* ⚠ EVERY ANALYSIS LANGUAGE GETS ITS OWN TIER (Seth, 2026-09-05: "ELAN and SayMore exports should
   * export all that are present"). A FLEx text glossed in Indonesian AND English used to leave here
   * with one A_word-gls-id tier and one A_phrase-gls-id tier — the English lines, preserved
   * verbatim in the doc, were silently dropped. The primary language (the one this device edits)
   * keeps the tier names it always had and comes first, so a reader that takes the first
   * phrase-gls / word-gls tier (eaf-read.js) still lands on it; each further language is one more
   * tier of the same type under the same parent, e.g. A_word-gls-en. The SayMore profile keeps its
   * two documented tiers — SIL says extra tiers are ignored and advises against adding any — so
   * the full set lives in the ELAN .eaf beside it. */
  const langOf = (g) => g.lang || anal;
  const { gloss: glossLangs, free: freeLangs } = analysisLangs(doc, anal);
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  /* ⚠ AUTHOR IS A PERSON, AND WE MUST NOT SIT IN IT. It held "FlexText Editor" — a tool name in a
   * field ELAN provides for the human who made the annotations (Seth: "What we don't want to do is
   * repurpose a field like AUTHOR … THAT field is probably supposed to be for the speaker"). An
   * archivist reading that later would be told, in the one place the format sets aside for a person,
   * the name of a program. Empty is honest; a caller who knows the annotator can pass one.
   *
   * ⚠ AND IT IS REQUIRED (`use="required"` in EAFv3.0.xsd), so it cannot simply be dropped. Empty is
   * what ELAN itself writes when it does not know, and is the honest value here.
   *
   * The TOOL goes in a HEADER <PROPERTY>, which the schema provides for exactly this:
   *     <xsd:element name="PROPERTY" type="propType" minOccurs="0" maxOccurs="unbounded"/>
   *     <xsd:attribute name="NAME" type="xsd:string" use="optional"/>
   * — an arbitrary key/value extension point, optional, documented. That beats the XML comment this
   * first used: same information, but machine-readable and sanctioned rather than merely tolerated.
   * Seth's order of preference throughout: documented optional field, then a comment, and never a
   * semantic field borrowed for something it does not mean. */
  L.push(`<ANNOTATION_DOCUMENT AUTHOR="${esc(opts.author || '')}" DATE="${esc(opts.date || new Date().toISOString())}" FORMAT="3.0" VERSION="3.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.mpi.nl/tools/elan/EAFv3.0.xsd">`);
  L.push('  <HEADER MEDIA_FILE="" TIME_UNITS="milliseconds">');
  if (mediaName) {
    // RELATIVE_MEDIA_URL beside a matching basename is what makes ELAN/SayMore find the media
    // with NO relinking dialog — the highest-value line in this writer (plan: media-relinking).
    L.push(`    <MEDIA_DESCRIPTOR MEDIA_URL="file:///./${esc(mediaName)}" MIME_TYPE="${esc(mediaMime)}" RELATIVE_MEDIA_URL="./${esc(mediaName)}"/>`);
  }
  // ⚠ LAST IN THE HEADER: the XSD sequence is MEDIA_DESCRIPTOR*, LINKED_FILE_DESCRIPTOR*, PROPERTY*,
  // so a PROPERTY emitted before a MEDIA_DESCRIPTOR would not validate.
  if (opts.producedBy) L.push(`    <PROPERTY NAME="generator">${esc(String(opts.producedBy))}</PROPERTY>`);
  L.push('  </HEADER>');
  L.push('  <TIME_ORDER>');
  for (const s of slots) {
    L.push(s.value === undefined
      ? `    <TIME_SLOT TIME_SLOT_ID="${s.id}"/>`
      : `    <TIME_SLOT TIME_SLOT_ID="${s.id}" TIME_VALUE="${Math.round(s.value)}"/>`);
  }
  L.push('  </TIME_ORDER>');

  // Structural tiers (flex profile, and only when something is aligned — Included_In children
  // need a real parent span to sit inside). The interlinear-text annotation spans first..last
  // aligned boundary (REUSING those rows' slots, so containment is exact) and carries the title;
  // each paragraph annotation MIRRORS its phrase — same slots, empty value — so the ELAN user
  // can merge paragraphs into real groupings but never needs to split one.
  const alignedAnns = anns.filter((a, k) => isAligned(rows[k].span));
  const structural = flex && alignedAnns.length > 0;
  if (structural) {
    const itextId = 'a' + (++aid);
    L.push(`  <TIER LINGUISTIC_TYPE_REF="interlinear-text" TIER_ID="${esc(names.itext)}">`);
    L.push(`    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="${itextId}" TIME_SLOT_REF1="${alignedAnns[0].ts1}" TIME_SLOT_REF2="${alignedAnns[alignedAnns.length - 1].ts2}"><ANNOTATION_VALUE>${esc(doc.title || '')}</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>`);
    L.push('  </TIER>');
    L.push(`  <TIER LINGUISTIC_TYPE_REF="paragraph" PARENT_REF="${esc(names.itext)}" TIER_ID="${esc(names.para)}">`);
    for (const a of anns) {
      L.push(`    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="a${++aid}" TIME_SLOT_REF1="${a.ts1}" TIME_SLOT_REF2="${a.ts2}"><ANNOTATION_VALUE></ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>`);
    }
    L.push('  </TIER>');
  }

  // Baseline: time-aligned; a child of the paragraph tier when the structure exists. Empty
  // segments export with an empty ANNOTATION_VALUE (schema-legal) — timed silence is real data.
  L.push(`  <TIER LINGUISTIC_TYPE_REF="phrase"${structural ? ` PARENT_REF="${esc(names.para)}"` : ''} TIER_ID="${esc(names.phrase)}">`);
  for (const a of anns) {
    L.push(`    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="${a.id}" TIME_SLOT_REF1="${a.ts1}" TIME_SLOT_REF2="${a.ts2}"><ANNOTATION_VALUE>${esc(a.text)}</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>`);
  }
  L.push('  </TIER>');

  if (flex) {
    // Words: Symbolic_Subdivision of the phrase (ordered children, no times of their own).
    L.push(`  <TIER LINGUISTIC_TYPE_REF="word" PARENT_REF="${esc(names.phrase)}" TIER_ID="${esc(names.word)}">`);
    for (const a of anns) {
      let prevW = null;
      for (const w of a.words) {
        const chain = prevW ? ` PREVIOUS_ANNOTATION="${prevW}"` : '';
        L.push(`    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="${w.id}" ANNOTATION_REF="${a.id}"${chain}><ANNOTATION_VALUE>${esc(w.text)}</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>`);
        prevW = w.id;
      }
    }
    L.push('  </TIER>');

    // Word glosses: Symbolic_Association on the WORD (1:1) — chaining to words, not the phrase,
    // is what binds each gloss to its specific word. One tier per analysis language, primary first.
    for (const lang of glossLangs) {
      const tierId = lang === anal ? names.gloss : `A_word-gls-${lang}`;
      L.push(`  <TIER LINGUISTIC_TYPE_REF="wordGloss" PARENT_REF="${esc(names.word)}" TIER_ID="${esc(tierId)}">`);
      for (const a of anns) {
        for (const w of a.words) {
          const g = w.glosses.find((x) => langOf(x) === lang);
          const text = g ? g.text : '';
          if (!text) continue;
          L.push(`    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="a${++aid}" ANNOTATION_REF="${w.id}"><ANNOTATION_VALUE>${esc(text)}</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>`);
        }
      }
      L.push('  </TIER>');
    }
  }

  // Free translation: Symbolic_Association on the phrase. Empty → no annotation at all. FLEx
  // profile: one tier per analysis language, primary first; SayMore: its one documented tier.
  const freeTiers = flex
    ? freeLangs.map((lang) => ({ lang, id: lang === anal ? names.free : `A_phrase-gls-${lang}` }))
    : [{ lang: anal, id: names.free }];
  for (const ft of freeTiers) {
    L.push(`  <TIER LINGUISTIC_TYPE_REF="phraseGloss" PARENT_REF="${esc(names.phrase)}" TIER_ID="${esc(ft.id)}">`);
    for (const a of anns) {
      const f = a.frees.find((x) => langOf(x) === ft.lang);
      const text = f ? f.text : (ft.lang === anal ? a.free : '');
      if (!text) continue;
      L.push(`    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="a${++aid}" ANNOTATION_REF="${a.id}"><ANNOTATION_VALUE>${esc(text)}</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>`);
    }
    L.push('  </TIER>');
  }

  // The stereotype names are ELAN conventions recognised BY NAME, not schema-enforced — the
  // standard CONSTRAINT declarations below are required for ELAN to interpret the tiers.
  // Included_In (not Time_Subdivision) for the structural children: it tolerates gaps and
  // unaligned (pending) members, which Time_Subdivision's no-gaps rule would not.
  if (structural) {
    L.push('  <LINGUISTIC_TYPE GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="interlinear-text" TIME_ALIGNABLE="true"/>');
    L.push('  <LINGUISTIC_TYPE CONSTRAINTS="Included_In" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="paragraph" TIME_ALIGNABLE="true"/>');
    L.push('  <LINGUISTIC_TYPE CONSTRAINTS="Included_In" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="phrase" TIME_ALIGNABLE="true"/>');
  } else {
    L.push('  <LINGUISTIC_TYPE GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="phrase" TIME_ALIGNABLE="true"/>');
  }
  if (flex) {
    L.push('  <LINGUISTIC_TYPE CONSTRAINTS="Symbolic_Subdivision" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="word" TIME_ALIGNABLE="false"/>');
    L.push('  <LINGUISTIC_TYPE CONSTRAINTS="Symbolic_Association" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="wordGloss" TIME_ALIGNABLE="false"/>');
  }
  L.push('  <LINGUISTIC_TYPE CONSTRAINTS="Symbolic_Association" GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="phraseGloss" TIME_ALIGNABLE="false"/>');
  L.push('  <CONSTRAINT DESCRIPTION="Time subdivision of parent annotation\'s time interval, no time gaps allowed within this interval" STEREOTYPE="Time_Subdivision"/>');
  L.push('  <CONSTRAINT DESCRIPTION="Symbolic subdivision of a parent annotation. Annotations refering to the same parent are ordered" STEREOTYPE="Symbolic_Subdivision"/>');
  L.push('  <CONSTRAINT DESCRIPTION="1-1 association with a parent annotation" STEREOTYPE="Symbolic_Association"/>');
  L.push('  <CONSTRAINT DESCRIPTION="Time alignable annotations within the parent annotation\'s time interval, gaps are allowed" STEREOTYPE="Included_In"/>');
  L.push('</ANNOTATION_DOCUMENT>');
  return L.join('\n') + '\n';
}

/* ---------------- waveform peak bucketing ---------------- */

/* HOW MANY SAMPLES PER PEAK BUCKET — and why this is CEIL, not FLOOR (Seth, 2026-08-05).
 *
 * A peaks array of `buckets` entries, each the max of `per` consecutive samples, is only usable as
 * a TIME index if the buckets actually span the whole recording. With `per = floor(samples /
 * buckets)` they do not: the array covers `buckets × per` samples, and the remainder — up to one
 * whole bucket per bucket, i.e. nearly `buckets` samples — falls off the end.
 *
 * That is not a rounding wobble, it is a hard truncation. A real case: a 62.25 s file decoded to
 * 2,987,990 samples at 48 kHz with 124,500 buckets gives 2,987,990/124,500 = 23.9999 → per = 23,
 * so the peaks cover 2,863,500 samples = 59.66 s. The last 2.6 SECONDS have no peaks at all. Every
 * consumer then converts a time to a bucket index and gets clamped at the end of the array, so:
 *   - the overview drew 0–59.66 s stretched across a ruler labelled 0–62.25 s, displacing every
 *     feature by a factor of 1.043 — a drift reaching 2.6 s at the right-hand edge, which is what
 *     made the playhead and the waveform disagree WAY out of proportion late in a recording;
 *   - the last line's strip drew only the part of its span below 59.66 s, stretched to full width.
 * Gaps made it obvious rather than caused it: the further into the file a line sits, the worse.
 *
 * CEIL guarantees `buckets × per >= samples`, so every time in the file maps to a bucket that
 * exists. Overshoot is harmless — the tail buckets simply sit past the audio and are never drawn,
 * because a span is converted with msPerBucket, which stays exact either way.
 *
 * ⚠ Bucket b covers samples [b·per, (b+1)·per) — a bucket index is NOT b/buckets of the duration.
 * Convert with msPerBucket and nothing else (the same rule segment-strips.js states). */
export function peakPlan(sampleCount, sampleRate, durationSec, opts = {}) {
  const perSec = opts.perSec || 2000;
  const buckets = Math.min(opts.max || 2000000, Math.max(opts.min || 4000, Math.round(durationSec * perSec)));
  const per = Math.max(1, Math.ceil(sampleCount / buckets));
  return { buckets, per, msPerBucket: (per / sampleRate) * 1000 };
}

/* ---------------- ELAN display preferences (.pfsx) ---------------- */

/* WHY THIS FILE EXISTS: opened cold, ELAN stacked the ANALYSIS tiers above the VERNACULAR ones —
 * free translation over baseline, word glosses over words — which is upside down for reading
 * interlinear text, and a non-technical user has no reason to know it is a display setting rather
 * than how we wrote the file (Seth, 2026-08-05).
 *
 * The cause is not our tier order; the .eaf already lists vernacular first. It is ELAN's
 * `sortAlphabetically`, which is applied to the tier list BEFORE the sort mode is even consulted
 * (MultiTierControlPanel.createSortedTree) — and alphabetically `A_phrase-gls-en` precedes
 * `A_phrase-txt-fau`, `A_word-gls-en` precedes `A_word-txt-fau`. Every gloss tier therefore rises
 * above its own vernacular partner. That setting is remembered globally, so it follows the user
 * from file to file with nothing in THIS file to blame.
 *
 * ELAN stores per-document display settings in a `<same-basename>.pfsx` sidecar, so we can simply
 * state the order we want. All three keys are required and were read off ELAN's source (the
 * misspelling in `SortAlpabetically` is ELAN's own — matching it exactly is what makes it work):
 *   - MultiTierViewer.TierOrder        our order, verbatim
 *   - MultiTierViewer.TierSortingMode  0 = UNSORTED, i.e. "use that order"
 *   - MultiTierViewer.SortAlpabetically  false, or the alphabetical pass re-inverts it anyway
 * Naming a tier that does not exist is harmless — ELAN drops unknown names when it loads the list
 * (ViewerManager2), which is why the structural tiers can be listed unconditionally.
 *
 * NOT written for the 'saymore' profile: that file has exactly two tiers, already in reading
 * order, and SIL advise against adding files to a SayMore session folder. */
export function serializeEafPrefs(opts = {}) {
  const { profile = 'flex', vern = 'und', anal = 'en', doc = null } = opts;
  const n = eafTierNames(profile !== 'saymore', vern, anal);
  // Reading order: what you transcribed, then its words, then what they mean (every gloss
  // language, primary first), then the whole sentence's meaning (likewise) — structural
  // containers last, out of the way of the text. Pass `doc` so the extra-language tiers
  // serializeEaf wrote are ordered too; without it the order names only the primary pair.
  const langs = doc ? analysisLangs(doc, anal) : { gloss: [anal], free: [anal] };
  const glossTiers = langs.gloss.map((l) => (l === anal ? n.gloss : `A_word-gls-${l}`));
  const freeTiers = langs.free.map((l) => (l === anal ? n.free : `A_phrase-gls-${l}`));
  const order = profile !== 'saymore'
    ? [n.phrase, n.word, ...glossTiers, ...freeTiers, n.para, n.itext]
    : [n.phrase, n.free];
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<preferences version="1.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.mpi.nl/tools/elan/Prefs_v1.1.xsd">');
  L.push('    <prefList key="MultiTierViewer.TierOrder">');
  for (const t of order) L.push(`        <String>${esc(t)}</String>`);
  L.push('    </prefList>');
  L.push('    <pref key="MultiTierViewer.TierSortingMode">');
  L.push('        <Int>0</Int>');
  L.push('    </pref>');
  L.push('    <pref key="MultiTierViewer.SortAlpabetically">');
  L.push('        <Boolean>false</Boolean>');
  L.push('    </pref>');
  L.push('</preferences>');
  return L.join('\n') + '\n';
}

/* ---------------- standalone segment preview page ---------------- */

/* A single self-contained HTML file: a READ-ONLY twin of the segmentation editor (Seth,
 * 2026-08-03) — scrubbable full-track player up top, per-line mini waveforms below, all computed
 * at load from the audio embedded as base64. Purpose: a researcher keeps this open in a browser
 * and alt-tabs to it while doing interlinear/charting work in FLEx — no app, no server, no
 * network. The waveform math mirrors segment-strips.js exactly (2000 buckets/s, exact msPerBucket
 * mapping, range-max vs interpolation regimes, m^0.6 display curve) so the page and the editor
 * show the SAME picture. English-only on purpose: it is a researcher-side artifact.
 *
 * ⚠ TWO FLAVORS FROM THE ONE GENERATOR (Seth, 2026-08-16: the fxpa treatment, applied here). WITH
 * a recording this is the LISTENING page — player, per-line waves, Space/follow transport. WITHOUT
 * one (none supplied, or the text has no usable alignment to segment it by) it is the INTERLINEAR
 * page: the same rows as a readable offline document, with no player, no dead play buttons, and no
 * script at all. One branch, never a second template — the paragraph tool's page has worked this
 * way all along (paragraph-export.js gates on audioB64 identically), and two near-copies of a
 * 200-line template is exactly the drift this module exists to prevent. */
export function buildSegPreviewHtml(doc, opts = {}) {
  const { title = 'Text', audioB64 = '', audioMime = 'audio/wav', mediaName = '' } = opts;
  const withAudio = !!audioB64;
  const rows = phraseRows(doc);
  /* ⚠ A TEXT GLOSSED IN MORE THAN ONE LANGUAGE SHOWS ONE AT A TIME, THE READER'S CHOICE (Seth,
   * 2026-09-05: "we need to be able to select analysis writing system for gloss and for free
   * translation if there are multiple choices"). Every language's line is in the page, marked
   * data-l; the primary (the language this device edits) shows first, and a picker per tier
   * appears only when there is something to pick. One language → no picker, the page as before. */
  const anal = opts.anal || doc.analLang || 'en';
  const { gloss: glossLangs, free: freeLangs } = analysisLangs(doc, anal);
  const multi = glossLangs.length > 1 || freeLangs.length > 1;
  const wsPick = (id, label, langs) => langs.length > 1
    ? `<label>${label} <select id="${id}">${langs.map((l) => `<option value="${esc(l)}"${l === langs[0] ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`
    : '';
  const wsBar = multi ? `<div class="ws">${wsPick('glossws', 'Gloss language', glossLangs)}${wsPick('freews', 'Translation language', freeLangs)}</div>` : '';
  const body = rows.map((r) => {
    const t = r.phrase;
    const timed = isAligned(r.span);
    const est = timed && r.span.timeEstimated ? '~' : '';
    // Times still shown text-only when the doc carries them — they are data, not controls.
    const time = timed ? `${est}${fmtClock(r.span.start)}–${fmtClock(r.span.end)}` : '';
    const words = (t.words || []).map((w) => w.punct
      ? `<span class="w punct"><span class="wt">${esc(w.txt)}</span></span>`
      : `<span class="w"><span class="wt">${esc(w.txt)}</span>${glossLangs.map((l) =>
        `<span class="wg" data-l="${esc(l)}"${l === glossLangs[0] ? '' : ' hidden'}>${esc(glossIn(w, l, anal) || ' ')}</span>`).join('')}</span>`).join('');
    const free = freeLangs.map((l) => {
      const txt = freeIn(t, l, anal);
      return txt ? `<div class="free" data-l="${esc(l)}"${l === freeLangs[0] ? '' : ' hidden'}>${esc(txt)}</div>` : '';
    }).join('');
    const blank = !(t.baseline || '').trim() && !(t.words || []).length;
    const wave = withAudio && timed ? '<div class="wwrap"><canvas class="rw"></canvas><div class="cur" hidden></div></div>' : '';
    const btn = withAudio ? `<button class="play"${timed ? '' : ' disabled'}>${timed ? '&#9654;' : '&#8943;'}</button>
  ` : '';
    return `<div class="seg${blank ? ' blank' : ''}"${withAudio && timed ? ` data-s="${Math.round(r.span.start)}" data-e="${Math.round(r.span.end)}"` : ''}>
  ${btn}<div class="cell"><div class="meta">${esc(time)}</div>${wave}${blank ? '<div class="blanklbl">(blank line)</div>' : `<div class="words">${words}</div>${free}`}</div>
</div>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — ${withAudio ? 'segments' : 'interlinear'}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.5 -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif; padding: 16px clamp(10px, 4vw, 40px) 60px; }
  h1 { font-size: 19px; margin: 4px 0 2px; }
  .src { opacity: .6; font-size: 12px; margin-bottom: 10px; }
  .ws { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; margin: 0 0 8px; }
  .ws select { font-size: 13px; padding: 2px 4px; border-radius: 6px; border: 1px solid rgba(127,127,127,.4); background: transparent; }
  .player { position: sticky; top: 0; background: Canvas; padding: 6px 0 4px; z-index: 5;
            border-bottom: 1px solid rgba(127,127,127,.35); margin-bottom: 8px; }
  .wwrap { position: relative; }
  .player .wwrap { overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }   /* the overview scrolls once zoomed */
  #ov { width: 100%; height: 72px; display: block; cursor: crosshair; touch-action: pan-y; }
  .rw { width: 100%; height: 26px; display: block; cursor: crosshair; touch-action: pan-y; }
  .cur { position: absolute; top: 0; bottom: 0; width: 2px; background: #d33; pointer-events: none; }
  @media (pointer: coarse) {
    .cur { width: 32px; margin-left: -15px; background: transparent; pointer-events: auto; touch-action: none; z-index: 3; }
    .cur::before { content: ''; position: absolute; left: 15px; top: 0; bottom: 0; width: 3px; background: #d33; border-radius: 2px; }
  }
  .bar { display: flex; gap: 10px; align-items: center; margin-top: 6px; }
  #mplay { width: 44px; height: 36px; font-size: 15px; border-radius: 8px; border: 1px solid rgba(127,127,127,.4); background: transparent; cursor: pointer; }
  #mspeed { height: 36px; border-radius: 8px; border: 1px solid rgba(127,127,127,.4); background: transparent; font-size: 13px; }
  #mtime { font-size: 13px; opacity: .7; font-variant-numeric: tabular-nums; }
  .seg { display: flex; gap: 10px; align-items: flex-start; padding: 8px 6px; border-bottom: 1px solid rgba(127,127,127,.25); }
  .seg.on { background: rgba(80,130,220,.12); }
  .seg.blank { opacity: .55; }
  .seg .cell { flex: 1; min-width: 0; }
  .play { flex: none; width: 40px; height: 40px; font-size: 15px; border-radius: 8px; border: 1px solid rgba(127,127,127,.4); background: transparent; cursor: pointer; }
  .play:disabled { opacity: .4; cursor: default; }
  .meta { font-size: 11px; opacity: .6; font-variant-numeric: tabular-nums; }
  .words { display: flex; flex-wrap: wrap; gap: 2px 14px; margin: 2px 0; }
  .w { display: inline-flex; flex-direction: column; }
  .wt { color: #2555b0; font-size: 17px; }
  .wg { color: #2a6e2a; font-size: 13px; }
  .blanklbl, .free { font-style: italic; }
  .free { margin-top: 2px; }
  .note { font-size: 12px; opacity: .6; margin-top: 18px; }
</style></head><body>
<h1>${esc(title)}</h1>
${mediaName ? `<div class="src">${esc(mediaName)}</div>` : ''}
${wsBar}
${withAudio ? `<div class="player">
  <div class="wwrap"><canvas id="ov"></canvas><div class="cur" id="ovcur"></div></div>
  <div class="bar"><button id="mplay">&#9654;</button><select id="mspeed" title="Playback speed"><option value="0.5">Very slow</option><option value="0.75">Slow</option><option value="1" selected>Normal</option></select><span id="mtime"></span></div>
</div>` : ''}
${body}
<p class="note">${withAudio
    ? 'Generated by FlexText Editor. Audio is embedded in this file — it works offline and needs no other files. Click or drag on any waveform to position the playhead; the round buttons play a line (or the whole recording) from there. <b>Press the space bar to play or pause</b>, and the page follows the line being played.'
    : 'Generated by FlexText Editor. A read-only interlinear view of this text — words, glosses and free translations. It works offline and needs no other files.'}</p>
${withAudio ? `<script>
(function () {
  var b64 = ${JSON.stringify(audioB64)};
  var bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  var audio = new Audio(URL.createObjectURL(new Blob([u8], { type: ${JSON.stringify(audioMime)} })));
  var stopAt = 0, active = null;
  var peaks = null, mpb = 0, durMs = 0;
  var rows = [].slice.call(document.querySelectorAll('.seg[data-s]'));
  var ov = document.getElementById('ov'), ovcur = document.getElementById('ovcur');
  var mplay = document.getElementById('mplay'), mtime = document.getElementById('mtime');

  // Boundary stop must NOT depend on the rAF loop: browsers throttle rAF in background tabs
  // while audio keeps playing, and a line would blow through its boundary. timeupdate fires
  // regardless of tab visibility.
  audio.addEventListener('timeupdate', function () {
    if (stopAt && audio.currentTime * 1000 >= stopAt - 20) audio.pause();
  });

  function fmt(ms) {
    var t = Math.max(0, Math.round(ms)), m = Math.floor(t / 60000), s = Math.floor((t % 60000) / 1000);
    return m + ':' + String(s).padStart(2, '0') + '.' + String(Math.floor((t % 1000) / 100));
  }
  function totalMs() { return durMs || (isFinite(audio.duration) ? audio.duration * 1000 : 0); }

  // One decode at load, peaks kept, buffer discarded — same math as the editor's strips
  // (exact msPerBucket mapping; proportional-to-duration drifts toward the file end).
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      var actx = new AC();
      actx.decodeAudioData(u8.buffer.slice(0)).then(function (buf) {
        var ch = buf.getChannelData(0);
        var B = Math.min(2000000, Math.max(4000, Math.round(buf.duration * 2000)));
        // CEIL, never floor: flooring leaves the tail of the recording with no buckets, so every
        // time past that point clamps to the end of the array and the waveform drifts (peakPlan).
        var per = Math.max(1, Math.ceil(ch.length / B));
        peaks = new Float32Array(B);
        for (var b = 0; b < B; b++) {
          var m = 0, off = b * per, end = Math.min(ch.length, off + per);
          for (var i = off; i < end; i += 4) { var v = Math.abs(ch[i]); if (v > m) m = v; }
          peaks[b] = m;
        }
        mpb = per / buf.sampleRate * 1000;
        durMs = Math.round(buf.duration * 1000);
        try { actx.close(); } catch (e) {}
        drawAll();
      }).catch(function () { /* undecodable → page still plays, no waves */ });
    }
  } catch (e) {}

  function draw(canvas, sMs, eMs) {
    var dpr = window.devicePixelRatio || 1;
    var W = Math.max(1, Math.round((canvas.clientWidth || 300) * dpr));
    var H = Math.max(1, Math.round((canvas.clientHeight || 26) * dpr));
    canvas.width = W; canvas.height = H;
    var g = canvas.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (!peaks || !mpb || eMs <= sMs) { g.fillStyle = 'rgba(120,130,150,.45)'; g.fillRect(0, H / 2 - 1, W, 2); return; }
    var B = peaks.length;
    var b0 = Math.min(B - 1, Math.max(0, Math.floor(sMs / mpb)));
    var b1 = Math.min(B, Math.max(b0 + 1, Math.ceil(eMs / mpb)));
    var n = b1 - b0;
    g.fillStyle = '#1f4f8f';
    for (var x = 0; x < W; x++) {
      var fpos = (x / W) * n + b0;
      var i0 = Math.floor(fpos);
      var i1 = Math.max(i0 + 1, b0 + Math.ceil(((x + 1) / W) * n));
      var m = 0;
      if (i1 - i0 <= 1) {
        var fr = fpos - i0;
        m = (peaks[i0] || 0) * (1 - fr) + (peaks[Math.min(i0 + 1, b0 + n - 1)] || 0) * fr;
      } else {
        for (var i = i0; i < i1; i++) { var v = peaks[i] || 0; if (v > m) m = v; }
      }
      var h = Math.max(2, Math.pow(m, 0.6) * (H - 4));
      g.fillRect(x, (H - h) / 2, 1, h);
    }
  }
  function drawAll() {
    draw(ov, 0, totalMs());
    rows.forEach(function (row) {
      var c = row.querySelector('.rw');
      if (c) draw(c, +row.dataset.s, +row.dataset.e);
    });
  }
  var rsz; window.addEventListener('resize', function () { clearTimeout(rsz); rsz = setTimeout(drawAll, 150); });

  // Scrub = position only (the editor's interaction language): click or drag parks the playhead;
  // the play buttons start sound. Overview scrubs the whole file; a row wave scrubs its span.
  function wireScrub(el, s, e) {
    var down = false, dragged = false;
    function seek(ev) {
      var start = (typeof s === 'function' ? s() : s);
      var span = (typeof e === 'function' ? e() : e) - start;
      var r = el.getBoundingClientRect();
      var f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      var ms = start + f * Math.max(0, span);
      if (span > 0) audio.currentTime = ms / 1000;
      return ms;
    }
    // The overview's momentary close-up while a ROW is scrubbed (the editor's dock does the same,
    // v598): opens on the first move of a drag, never on a click or a tap, follows the playhead,
    // closes on release. Scrubbing the overview itself is left alone.
    function drag(ev) { var ms = seek(ev); if (el !== ov) ovFocus(dragged ? 'move' : 'start', ms); dragged = true; }
    function release() { if (dragged && el !== ov) ovFocus('end'); dragged = false; }
    // Touch (same rule as the editor's strips): a tap parks the playhead, dragging the dot scrubs,
    // dragging anywhere else scrolls (touch-action:pan-y above; no pointermove on the canvas).
    el.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType === 'touch') {
        if (el === ov) return;   // the overview has its own touch grammar — see below
        var x0 = ev.clientX, y0 = ev.clientY;
        var up = function (e2) { el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
          if (e2.type === 'pointerup' && Math.abs(e2.clientX - x0) < 10 && Math.abs(e2.clientY - y0) < 10) { audio.pause(); seek(e2); } };
        el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
        return;
      }
      ev.preventDefault(); down = true; dragged = false; seek(ev);
    });
    el.addEventListener('pointermove', function (ev) { if (down && ev.pointerType !== 'touch') drag(ev); });
    window.addEventListener('pointerup', function () { if (down) release(); down = false; });
    var knob = el.parentNode && el.parentNode.querySelector('.cur');
    if (knob) knob.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType !== 'touch') return;
      ev.preventDefault(); try { knob.setPointerCapture(ev.pointerId); } catch (e) {}
      audio.pause(); dragged = false;
      var move = function (e2) { drag(e2); };
      var end = function () { knob.removeEventListener('pointermove', move); knob.removeEventListener('pointerup', end); knob.removeEventListener('pointercancel', end); release(); };
      knob.addEventListener('pointermove', move); knob.addEventListener('pointerup', end); knob.addEventListener('pointercancel', end);
    });
  }
  wireScrub(ov, 0, totalMs);
  rows.forEach(function (row) {
    var c = row.querySelector('.rw');
    if (c) wireScrub(c, +row.dataset.s, +row.dataset.e);
  });

  /* ── THE OVERVIEW'S OWN TOUCH GRAMMAR (Seth, 2026-09-06; the editor's big player does the same):
   * a tap parks the playhead where it lands, dragging anywhere but the playhead line scrolls the
   * waveform once it is zoomed, pinching zooms in and out, and the playhead line itself scrubs
   * (the knob above). A trackpad pinch (a wheel with ctrlKey) zooms too; a horizontal two-finger
   * swipe scrolls natively (overflow-x on the wrapper). Vertical drags still scroll the page. */
  var ovWrap = ov.parentNode, ovZoom = 1, focusPrev = null;
  /* The close-up: about four seconds across the overview around the playhead (the editor's
   * FOCUS_WINDOW_S), the playhead kept centred, then the zoom and scroll put back. */
  function ovFocus(phase, ms) {
    var T = totalMs(); if (!(T > 0)) return;
    if (phase === 'start') { focusPrev = { z: ovZoom, scroll: ovWrap.scrollLeft }; setOvZoom(Math.max(ovZoom, T / 4000), ms, ovWrap.getBoundingClientRect().left + ovWrap.clientWidth / 2); }
    if (phase === 'start' || phase === 'move') ovWrap.scrollLeft = (ms / T) * ov.clientWidth - ovWrap.clientWidth / 2;
    if (phase === 'end' && focusPrev) { var p = focusPrev; focusPrev = null; setOvZoom(p.z, 0, ovWrap.getBoundingClientRect().left); ovWrap.scrollLeft = p.scroll; }
  }
  function ovMs(clientX) { var r = ov.getBoundingClientRect(), T = totalMs(); return r.width > 0 ? Math.min(T, Math.max(0, (clientX - r.left) / r.width * T)) : 0; }
  function setOvZoom(z, anchorMs, clientX) {
    z = Math.min(40, Math.max(1, z));
    if (Math.abs(z - ovZoom) < 0.001) return;
    ovZoom = z;
    ov.style.width = (z * 100) + '%';
    draw(ov, 0, totalMs());
    var T = totalMs();
    if (T > 0) ovWrap.scrollLeft = (anchorMs / T) * ov.clientWidth - (clientX - ovWrap.getBoundingClientRect().left);
  }
  (function () {
    var touches = {}, count = 0, mode = null, x0 = 0, y0 = 0, scroll0 = 0, dist0 = 1, z0 = 1, midMs = 0;
    function pts() { var a = []; for (var k in touches) a.push(touches[k]); return a; }
    function dist(p) { return Math.max(1, Math.sqrt((p[0].x - p[1].x) * (p[0].x - p[1].x) + (p[0].y - p[1].y) * (p[0].y - p[1].y))); }
    ov.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType !== 'touch') return;
      touches[ev.pointerId] = { x: ev.clientX, y: ev.clientY }; count++;
      try { ov.setPointerCapture(ev.pointerId); } catch (e) {}
      if (count === 1) { mode = 'tap'; x0 = ev.clientX; y0 = ev.clientY; scroll0 = ovWrap.scrollLeft; }
      else if (count === 2) { var p = pts(); mode = 'pinch'; dist0 = dist(p); z0 = ovZoom; midMs = ovMs((p[0].x + p[1].x) / 2); ev.preventDefault(); }
    });
    ov.addEventListener('pointermove', function (ev) {
      if (!touches[ev.pointerId]) return;
      touches[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
      if (mode === 'pinch' && count >= 2) { var p = pts(); setOvZoom(z0 * dist(p) / dist0, midMs, (p[0].x + p[1].x) / 2); ev.preventDefault(); return; }
      var dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (mode === 'tap' && Math.sqrt(dx * dx + dy * dy) > 10) mode = 'scroll';
      if (mode === 'scroll') { ovWrap.scrollLeft = scroll0 - dx; ev.preventDefault(); }
    });
    function end(ev) {
      if (!touches[ev.pointerId]) return;
      delete touches[ev.pointerId]; count--;
      if (mode === 'tap' && ev.type === 'pointerup') { audio.pause(); audio.currentTime = ovMs(ev.clientX) / 1000; }
      if (count <= 0) { count = 0; mode = null; }
      else if (count === 1) { var p = pts(); x0 = p[0].x; y0 = p[0].y; scroll0 = ovWrap.scrollLeft; mode = 'scroll'; }
    }
    ov.addEventListener('pointerup', end); ov.addEventListener('pointercancel', end);
    ov.addEventListener('wheel', function (ev) { if (!ev.ctrlKey) return; ev.preventDefault(); setOvZoom(ovZoom * Math.exp(-ev.deltaY * 0.005), ovMs(ev.clientX), ev.clientX); }, { passive: false });
  })();

  /* ── SPACE = PLAY/PAUSE, and the view FOLLOWS the playing line ────────────────────────────────
   * Seth, 2026-08-15: "add the auto-scrolling and space to play/pause behavior to the
   * preview/listening html pages our app suite exports … on the model of what we already have for
   * various editor tabs and paragraph analysis tool."
   *
   * The follow rule is the editor's, clause for clause (segment-strips.js followLine): scroll
   * only on a line CHANGE, only while actually PLAYING, only when the row is off screen, and never
   * within 4 seconds of the user scrolling.
   *
   * ⚠ "ONLY WHILE PLAYING" IS LOAD-BEARING HERE IN A WAY IT IS NOT IN THE APP, and dropping it as
   * redundant would break the page's main gesture: tick() runs whether or not audio is playing,
   * and dragging on ANY waveform moves currentTime while PAUSED (see wireScrub). Without the
   * gate, a drag across the overview smooth-scrolls the page once per row it crosses — yanking the
   * view out from under the hand doing the dragging. */
  var lastUserScroll = 0, followRow = null;
  ['wheel', 'touchmove'].forEach(function (ev) {
    // Only gestures that MOVE THE VIEWPORT count — the PAT rule. A click is not "stop following".
    window.addEventListener(ev, function () { lastUserScroll = Date.now(); }, { passive: true });
  });
  /* ⚠ MEASURE THE STICKY HEADER — do NOT hardcode 60 the way the app does. That constant is the
   * editor's topbar height, and it is already slightly wrong there: a row hidden under the sticky
   * dock player still reports top > 60 and is judged on screen. This page's .player is ~125px and
   * changes with the viewport, so ask it rather than guess. */
  function headRoom() {
    var p = document.querySelector('.player');
    return p ? Math.max(0, p.getBoundingClientRect().bottom) : 0;
  }
  function offScreen(row) {
    var r = row.getBoundingClientRect();
    return r.top < headRoom() || r.bottom > (window.innerHeight - 20);
  }
  function follow(row) {
    if (row === followRow) return;               // same line: nothing changed, nothing to do
    followRow = row;
    if (Date.now() - lastUserScroll > 4000 && offScreen(row)) {
      /* block:'center' with NO scroll-margin. The two do not compose: scrollIntoView aligns the
       * border box PLUS scroll-margin, so a top margin would push a centred row half that margin
       * below centre. The header is accounted for in offScreen instead. */
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  /* SPACE toggles the transport, exactly as it does on every editor tab (app.js
   * transportKeysApply).
   *
   * ⚠ preventDefault IS THE FEATURE, not tidiness. Two things both bite on this page: Space scrolls
   * the document by default, and Space on a FOCUSED BUTTON re-activates it — so after clicking a
   * line's ▶, Space would press that same button again instead of pausing. The editor had exactly
   * that bug ("spacebar to play/pause is jammed … nothing plays until I click the big player") and
   * fixed it exactly this way. This page is nothing but buttons, so it would have inherited it.
   *
   * The typing guard is carried over even though this page has no text fields today: it costs one
   * selector, and it is what keeps the rule correct if anyone ever adds one. */
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== ' ' && ev.code !== 'Space') return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;      // leave modifier combos to the browser
    var el = ev.target;
    /* NOT select (Seth, 2026-08-17): after changing the speed picker, Space must PLAY — the same
     * rule as the editor. preventDefault below keeps the dropdown closed; arrows still change it. */
    if (el && el.closest && el.closest('input, textarea, [contenteditable]')) return;
    ev.preventDefault();
    if (!audio.paused) { audio.pause(); return; }
    /* ⚠ AN ARMED SPAN THE PLAYHEAD HAS LEFT IS STALE, and Space must drop it rather than obey it.
     * Two ways it goes wrong otherwise, and a browser test caught both:
     *   - the span FINISHED, so the playhead sits on its boundary: play() is undone by the
     *     timeupdate handler on the very next frame, and the key visibly does nothing;
     *   - the reader SCRUBBED somewhere else and pressed Space, which they mean as "play from
     *     here" — snapping back to a line they left is the page overriding a deliberate gesture.
     * Clearing it gives the app's own rule: pause in place, resume from the playhead. */
    if (stopAt && active) {
      var s = +active.dataset.s, e = +active.dataset.e, t = audio.currentTime * 1000;
      if (!(t >= s && t < e - 20)) { stopAt = 0; active = null; }
    }
    audio.play();
  });

  /* The dock's speed picker, carried over (Seth, 2026-08-16: "I don't see the playspeed slider") —
   * same three rates as the editor. preservesPitch is the browser default but set on purpose,
   * because it IS the point: slower playback for checking a transcription without the pitch
   * dropping. The rate sticks to the media element, so it survives pause, seek and span playback
   * with no re-application anywhere else. Space is already guarded for selects, so focusing this
   * control never steals the transport key. */
  var mspeed = document.getElementById('mspeed');
  audio.preservesPitch = true;
  mspeed.addEventListener('change', function () { audio.playbackRate = parseFloat(mspeed.value) || 1; });

  mplay.addEventListener('click', function () {
    if (!audio.paused && !stopAt) { audio.pause(); return; }
    stopAt = 0; active = null;                     // full-file mode: play on through boundaries
    audio.play();
  });
  rows.forEach(function (row) {
    row.querySelector('.play').addEventListener('click', function () {
      var s = +row.dataset.s, e = +row.dataset.e;
      var t = audio.currentTime * 1000;
      if (!audio.paused && row === active) { audio.pause(); return; }
      active = row;
      audio.currentTime = ((t > s && t < e - 150) ? t : s) / 1000;   // resume-in-span, like the app
      stopAt = e;
      audio.play();
    });
  });

  (function tick() {
    var t = audio.currentTime * 1000, T = totalMs();
    if (stopAt && t >= stopAt - 20) audio.pause();
    if (T > 0) { ovcur.style.left = (Math.min(1, t / T) * ov.clientWidth) + 'px'; }
    mtime.textContent = fmt(t) + ' / ' + fmt(T);
    mplay.innerHTML = (!audio.paused && !stopAt) ? '&#9208;' : '&#9654;';
    var onRow = null;
    rows.forEach(function (row) {
      var s = +row.dataset.s, e = +row.dataset.e;
      var inSeg = t >= s && t < e;
      if (inSeg) onRow = row;
      row.classList.toggle('on', inSeg);
      var cur = row.querySelector('.cur'), c = row.querySelector('.rw');
      if (cur && c) {
        if (inSeg) { cur.hidden = false; cur.style.left = (((t - s) / (e - s)) * c.clientWidth) + 'px'; }
        else cur.hidden = true;
      }
      var btn = row.querySelector('.play');
      if (btn) btn.innerHTML = (!audio.paused && inSeg && row === active) ? '&#9208;' : '&#9654;';
    });
    // ⚠ The !audio.paused gate — see follow() above. Scrubbing while paused must not scroll.
    if (onRow && !audio.paused) follow(onRow);
    requestAnimationFrame(tick);
  })();
})();
</script>` : ''}
${multi ? `<script>
(function () {
  // The language pickers: show one language per tier, remember the choice for this page.
  function apply(sel, cls) {
    if (!sel) return;
    var lang = sel.value;
    var els = document.querySelectorAll('.' + cls + '[data-l]');
    for (var i = 0; i < els.length; i++) els[i].hidden = els[i].getAttribute('data-l') !== lang;
  }
  var g = document.getElementById('glossws'), f = document.getElementById('freews');
  if (g) g.addEventListener('change', function () { apply(g, 'wg'); });
  if (f) f.addEventListener('change', function () { apply(f, 'free'); });
  apply(g, 'wg'); apply(f, 'free');
})();
</script>` : ''}
</body></html>`;
  // (The base64 is interpolated directly above — an earlier .replace('__MARKER__') approach hit
  // the FIRST occurrence, so a title containing the literal marker text hijacked the audio slot.)
}

/* ---------------- Capture provenance → BWF bext (honesty in the BYTES) ---------------- */

/* Turn what an app could ACTUALLY learn about a recording into a Description + EBU CodingHistory.
 * Pure, so it is testable in node; the callers collect the facts, this only phrases them.
 *
 * WHY THIS EXISTS AT ALL: the provenance was already collected — the native shells report the mic,
 * the routing and whether the OS processors were off, and the browser path knows its own DSP
 * settings — and it was already shown in the UI and stored on the doc. None of it reached the audio
 * file. So it died with the app: the WAV a researcher deposits in an archive years later carried
 * nothing about how it was made.
 *
 * ⚠ THE HARD RULE IS THE ONE FROM notes/audiotoolsandsettingsplan §0b: NEVER CLAIM A CAPTURE DEPTH
 * THE WEB CANNOT DELIVER. Web Audio is 32-bit float BY SPECIFICATION — `AudioWorkletProcessor`
 * hands out Float32Array and there is no integer capture path anywhere in it. So a browser-recorded
 * "24-bit WAV" is a float32 capture WRITTEN to 24-bit, and this must say exactly that. Only a native
 * shell that reports `depthVerified` may state a captured depth as fact.
 *
 * ⚠ AND BIT DEPTH IS NOT RESOLUTION. A phone ADC commonly gives ~16 effective bits whatever the
 * container says, so the extra depth is HEADROOM, not detail. The history therefore records the
 * CHAIN — what happened at each step — and never a quality verdict. An archive can judge; we report.
 */
export function captureBext(prov = {}) {
  const p = prov || {};
  const nat = p.native || null;
  const mode = (nat && nat.encoding) ? 'native' : (p.mode || 'browser');
  const rate = p.sampleRate || (nat && nat.sampleRate) || null;
  const chans = p.channels || (nat && nat.channels) || null;
  const M = chans >= 2 ? 'stereo' : (chans === 1 ? 'mono' : '?');
  const F = rate || '?';
  const lines = [];
  const notes = [];

  if (mode === 'native') {
    /* A native shell OPENS the device itself, so it can report the real mic and — where the OS
     * allows — a genuinely integer capture. depthVerified is what separates "we asked for 24-bit"
     * from "the hardware gave 24-bit"; without it we say requested, never captured. */
    const dev = [nat.device, nat.deviceType].filter(Boolean).join(' / ') || nat.label || 'unknown device';
    const w = nat.encoding && /(\d+)/.test(nat.encoding) ? nat.encoding.match(/(\d+)/)[1] : (p.bits || '?');
    lines.push(`A=PCM,F=${F},W=${w},M=${M},T=captured by ${dev}${p.platform ? ` via the ${p.platform} shell` : ''}`
             + `${nat.encoding ? `; encoding ${nat.encoding}` : ''}`
             + `${nat.depthVerified === true ? '; depth verified by the device'
                 : nat.depthVerified === false ? '; DEPTH NOT VERIFIED - requested, not confirmed' : ''}`);
    if (nat.unprocessed === true) notes.push('OS audio processing was off');
    else if (nat.unprocessed === false) notes.push('OS AUDIO PROCESSING WAS ON - not an unmodified transfer');
    if (nat.wireless) notes.push('WIRELESS microphone - the link itself may compress');
    if (nat.substituted) notes.push(`the device substituted a different format${nat.substitutionReason ? ` (${nat.substitutionReason})` : ''}`);
    if (nat.archival === false && nat.archivalReason) notes.push(nat.archivalReason);
  } else {
    /* The browser path. State the specification limit plainly rather than letting the container
     * depth imply a capture depth it cannot have had. */
    lines.push(`A=PCM,F=${F},W=32,M=${M},T=captured through Web Audio, which is 32-bit float by specification`
             + `${p.micLabel ? ` (input: ${p.micLabel})` : ''}`);
    /* ⚠ agc ARRIVES IN TWO SHAPES and a bare truthiness test gets one of them exactly backwards.
     * `settings.agc` is a TRISTATE STRING ('off' | 'on' | 'auto'); effectiveAgc() resolves it to a
     * boolean before recordingProvenance() passes it here. `p.agc ? …` reads the string 'off' as
     * TRUE — so wiring the setting straight through (the obvious thing to do, and what a caller
     * outside app.js would naturally write) stamps "AGC ON - auto-gain alters dynamics" onto a take
     * whose whole point was that AGC was off.
     * That is the worst field in the file to be wrong in: a researcher who turned auto-gain off FOR
     * archival quality gets a master that permanently claims their audio was auto-gained, and no
     * later listener can tell it is a lie. Accept both shapes, and name the unresolved 'auto' case
     * rather than picking a side of it. */
    const dsp = [];
    const agcOn = p.agc === true || p.agc === 'on';
    dsp.push(p.agc === 'auto' ? 'AGC left to the browser default - not recorded for this take'
           : agcOn ? 'AGC ON - auto-gain alters dynamics' : 'AGC off');
    if (p.nr) dsp.push('noise reduction ON');
    if (p.echo) dsp.push('echo cancellation ON');
    if (p.normalized) dsp.push('peak-normalised after capture - an edit');
    notes.push(dsp.join('; '));
  }

  // What the writer did, if anything.
  const outW = p.bits || null;
  if (outW && mode !== 'native') {
    lines.push(`A=PCM,F=${F},W=${outW},M=${M},T=written by ${p.app || 'FlexText'} as ${outW}-bit PCM`
             + `${outW === 32 ? ' (the captured float, unconverted)'
                 : outW >= 24 ? ' - float-to-24-bit reduction (faithful)'
                 : ` - requantised from float to ${outW}-bit (irreversible)`}`);
  }
  if (notes.length) lines.push(`T=${notes.join('; ')}`);
  if (p.appVersion) lines.push(`T=engine ${p.appVersion}${p.platform ? ` on ${p.platform}` : ''}`);

  const desc = mode === 'native'
    ? `Field recording captured by ${p.app || 'FlexText'} through a native audio device.`
    : `Field recording captured by ${p.app || 'FlexText'} in a web browser (32-bit float capture; see CodingHistory).`;
  return { description: desc, originator: p.app || 'FlexText Editor', codingHistory: lines.join('\n') };
}

/* ---------------- BWF bext chunk (derived-WAV honesty in the BYTES) ---------------- */

/* Insert a Broadcast Wave `bext` chunk (EBU Tech 3285) into a plain RIFF/WAVE buffer. Filenames
 * get renamed; the bext CodingHistory is the label that SURVIVES — it states the true lossy
 * origin and that this file is NOT an archival master ([[audio-archival-standards]]). The chunk
 * is inserted before `data`; RIFF size is updated. Input buffer is not modified. */
export function wavWithBext(buf, opts = {}) {
  const src = new Uint8Array(buf);
  const dv = new DataView(buf);
  if (src.length < 12 || dv.getUint32(0) !== 0x52494646 /* RIFF */) return buf;
  const enc = (s, len) => {
    const out = new Uint8Array(len);
    for (let i = 0; i < Math.min(s.length, len); i++) out[i] = s.charCodeAt(i) & 0x7f;
    return out;
  };
  const history = (opts.codingHistory || '').replace(/\n/g, '\r\n') + '\r\n';
  const histBytes = enc(history, history.length + (history.length % 2)); // pad to even
  const now = opts.date ? new Date(opts.date) : new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const chunkLen = 602 + histBytes.length;
  const bext = new Uint8Array(8 + chunkLen);
  const bdv = new DataView(bext.buffer);
  bext.set(enc('bext', 4), 0);
  bdv.setUint32(4, chunkLen, true);
  bext.set(enc(opts.description || '', 256), 8);                                  // Description
  bext.set(enc(opts.originator || 'FlexText Editor', 32), 8 + 256);               // Originator
  bext.set(enc(opts.originatorRef || '', 32), 8 + 288);                           // OriginatorReference
  bext.set(enc(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, 10), 8 + 320);
  bext.set(enc(`${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, 8), 8 + 330);
  bdv.setUint16(8 + 346, 2, true);                                                // Version 2
  // TimeReference(8) zero, UMID(64) zero, loudness fields (10) zero, Reserved(180) zero.
  bext.set(histBytes, 8 + 602);
  // Splice after the fmt chunk (before whatever follows it — usually `data`).
  let off = 12;
  while (off + 8 <= src.length) {
    const id = String.fromCharCode(src[off], src[off + 1], src[off + 2], src[off + 3]);
    const size = dv.getUint32(off + 4, true);
    off += 8 + size + (size % 2);
    if (id === 'fmt ') break;
  }
  const out = new Uint8Array(src.length + bext.length);
  out.set(src.subarray(0, off), 0);
  out.set(bext, off);
  out.set(src.subarray(off), off + bext.length);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);                    // RIFF size
  return out.buffer;
}

/* ---------------- shared bundle assembly (assign-by-upload, 2026-08-11) ---------------- */

// FileReader-free (chunked btoa over the raw bytes) so this module stays runnable under plain
// node — the format-module rule. Shared by app.js, paragraph-ui.js, and the researcher panel.
export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// The end-user instructions bundled beside the annotation exports. Plain text, plain words,
// naming this bundle's ACTUAL files — the reader is a researcher (or their student) with the
// unzipped folder open, not someone who knows our terminology.
export function howToOpenText({ base, segMediaName, derived, eaf, saymore, preview, previewName, json,
                                lossyUnconverted = false }) {
  const L = [];
  L.push('HOW TO OPEN THESE FILES');
  L.push('=======================');
  L.push('');
  L.push('Keep everything from this zip together in ONE folder, and do not rename the');
  L.push('files — the annotation files find the audio by its exact name.');
  L.push('');
  if (eaf) {
    L.push(`ELAN — open "${base}.eaf"`);
    L.push('  Double-click it (or ELAN > File > Open). ELAN finds the audio in the same');
    L.push('  folder automatically — no relinking dialog.');
    L.push(`  The small "${base}.pfsx" beside it just tells ELAN to stack the tiers in`);
    L.push('  reading order (text, words, glosses, translation). It holds no annotations;');
    L.push('  delete it if you prefer your own tier order.');
    L.push('');
  }
  if (saymore) {
    // The drop-in (copy into the session folder) does NOT work — Seth tested it 2026-08-03.
    // The route that works is New Session from the audio + Copy Existing ELAN file.
    L.push(`SayMore — use "${segMediaName}.annotations.eaf"`);
    L.push('  1. In SayMore: New Session from Device/File — choose the audio file.');
    L.push('  2. Select the audio, open the "Start Annotating" tab.');
    L.push('  3. Choose "Copy Existing ELAN file" and pick this .annotations.eaf file.');
    L.push('  The transcriptions and free translations appear on the Annotations tab.');
    L.push('');
  }
  L.push(`FLEx — import "${base}.flextext"`);
  L.push('  FLEx > Texts & Words > Import > FLExText interlinear. The segment times show');
  L.push('  on the Note line (Configure Interlinear Lines > Note).');
  L.push('');
  if (preview) {
    L.push(`Quick listen — open "${previewName}" in any browser`);
    L.push('  The audio is embedded in the page: it works offline, plays line by line, and');
    L.push('  needs no other files. Handy beside FLEx while glossing or charting.');
    L.push('');
  }
  if (json) {
    L.push(`Paragraph analysis — open "${base}.fxpa"`);
    L.push('  In the Flextext Paragraph Analysis app:');
    L.push('  https://pat.flextext.app/');
    L.push('  Drop the .fxpa file on the open screen to group the lines into phrases,');
    L.push('  clauses, sentences, and paragraphs. Text and audio are inside the file.');
    L.push('');
  }
  if (derived) {
    L.push(`ABOUT "${segMediaName}"`);
    L.push('  The original recording was not a WAV, so this converted listening copy was');
    L.push('  made for exact time alignment — the annotation files point at it. It is NOT');
    L.push('  an archival master; the original recording is included unchanged.');
    L.push('');
  }
  /* ⚠ The alignment caveat must travel WITH the files, not only in a toast the researcher saw for
   * eight seconds a week ago. This bundle's annotation times were measured against decoded PCM, but
   * the audio shipped here is the compressed original — normally a converted WAV would sit between
   * them, and it was skipped because the recording was too large to decode in a browser tab. */
  if (lossyUnconverted) {
    L.push(`⚠ ABOUT THE TIMING OF "${segMediaName}"`);
    L.push('  This recording was too large to convert in the browser, so the annotation');
    L.push('  files point at the ORIGINAL compressed audio instead of a converted WAV copy.');
    L.push('  Compressed formats (MP3, M4A/AAC) begin with a few hundredths of a second of');
    L.push('  encoder padding, so every annotation may sit slightly late against what you');
    L.push('  hear — usually around 0.04 seconds, enough to notice at word level and rarely');
    L.push('  enough to matter at sentence level.');
    L.push('  To correct it: convert the audio to WAV yourself and relink it in ELAN, or');
    L.push('  nudge the whole tier by the offset you measure.');
    L.push('');
  }
  return L.join('\n');
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT CAN BE BUILT FROM A GIVEN RECORDING — the size policy, in one pure function.
 *
 * ⚠ WHY THIS EXISTS AT ALL (v347). The panel used to hold ONE boolean, `tooBig`, computed from a
 * DECODED-size estimate, and refuse every conversion above it. That was wrong in a way that cost a
 * researcher every generated export on a text that needed no conversion: `if (isWav) segMedia =
 * media` skips `convertAudio` entirely, so a WAV is never decoded — yet a 217 MB WAV was refused by
 * a 200 MB decode ceiling. The menu row even described itself as "EAF + tier order + WAV — built
 * here", i.e. it said it would put the WAV in a zip and then refused because it thought it had to
 * decode it.
 *
 * The three costs are genuinely different and must be judged separately:
 *   - a ZIP ENTRY is the bytes, copied twice (arrayBuffer + Blob). Cheap. Never a reason to refuse.
 *   - a DECODE is Float32 per channel, ~10x a compressed source. Lossy sources only.
 *   - a BASE64 EMBED holds the byte-string, its base64 (+33%) and the assembled document at once.
 *
 * So the ladder DEGRADES rather than refusing (Seth, 2026-08-12):
 *   ELAN/SayMore  never refuse — above the ceiling they ship the ORIGINAL audio unconverted.
 *   .fxpa         never refuses — above the ceiling it is built WITHOUT audio, and says so.
 *   .preview.html REFUSES. Seth: "The whole value of that is the embedded sound and the
 *                 following/auto-scrolling/segmented players." An audio-less preview page is a
 *                 worse .flextext, so producing one would be a disservice, not a degradation.
 *
 * ⚠ It lives HERE, in the pure module, for one structural reason: the panel calls it TWICE — once to
 * grey out a menu row and once to decide what to actually build. Two thresholds would drift, and the
 * failure would be a menu that promises what the conversion then refuses. One function, two callers.
 *
 * SIZE ONLY. Whether a doc is aligned, or has audio at all, is a different question answered by the
 * caller; an unknown size (0) is deliberately permissive rather than blocking.
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */
export const CONV_DECODED_MAX = 200 * 1024 * 1024;

export function conversionCaps({ bytes = 0, isWav = false, max = CONV_DECODED_MAX } = {}) {
  const n = Number(bytes) || 0;
  // A WAV is used as-is; anything else must decode to PCM first, at roughly 10x its compressed size.
  const est = isWav ? n : n * 10;
  const over = est > max;
  return {
    est,
    over,
    /* May we decode a lossy source into the aligned WAV working copy? */
    convert: !over,
    /* Zip outputs never refuse: above the ceiling the ORIGINAL audio rides instead. */
    elan: true,
    saymore: true,
    /* The .fxpa is always produced; only its embedded audio is dropped. */
    fxpa: true,
    fxpaAudio: !over,
    /* The one genuine refusal — see the reasoning above. */
    preview: !over,
    /* True when the bundle will carry a LOSSY original that was never converted, which means the
     * EAF's times are against a timeline the player will not quite reproduce (~44 ms of AAC
     * priming). The caller must SAY so — silence here is a false alignment. */
    lossyUnconverted: over && !isWav && n > 0,
  };
}

/* The annotation/export entries of a bundle — ONE function feeding both the device's
 * buildBundleFor and the panel's Downloads conversions (assign-by-upload rule: what the
 * researcher downloads must be built by the same code as what the device uploads).
 * Inputs are fully resolved by the caller (no settings, no IndexedDB here):
 * - media: the ORIGINAL recording { name, mimeType, blob } (null when the doc has none);
 * - segMedia: the timeline the segment times live on — the WAV working copy when one exists,
 *   else `media` itself; null when there is no real alignment. The caller's aligned-media
 *   resolution IS the gate: no segMedia → no annotation entries.
 * - wants: { eaf, saymore, preview, fxpa } — researcher-selected export switches;
 * - full: local-save bundle (preview + fxpa ride ONLY these — upload bandwidth never pays
 *   for embedded audio).
 * Returns [{ name, data: Blob }] in bundle order. */
export async function assembleSegEntries({ doc, title = '', base = 'text', media = null, segMedia = null,
                                           wants = {}, vern = 'und', anal = 'en', full = false,
                                           producedBy = '' } = {}) {
  const entries = [];
  /* ⚠ ENCODE THE AUDIO AT MOST ONCE. The preview page and the .fxpa both embed base64 of the SAME
   * blob, and encoding it twice back to back costs roughly 4.3× the recording in transient heap for
   * no benefit whatsoever — on the hardware this suite exists for, that is the difference between a
   * bundle and a killed tab. Lazy, so a build wanting neither pays nothing. */
  let b64Memo = null;
  const b64Once = async (blob) => (b64Memo ??= await blobToBase64(blob));
  /* ⚠ NAMES COME FROM `base` (the story title), NEVER from the stored media name — the v3 rule.
   * A caller may pass a segMedia whose `name` is a pre-fix delivery token; deriving here means the
   * EAF's media reference, the WAV entry that ships beside it, and the SayMore `.annotations.eaf`
   * are all built from the same clean string, so they cannot disagree with each other either. */
  const segMediaName = segMedia
    ? (segMedia.derived ? derivedWavName(base) : mediaNameFor(base, segMedia))
    : '';
  if (media && segMedia && (wants.eaf || wants.saymore || wants.preview)) {
    const wavName = /\.wav$/i.test(segMediaName) || /wav$/i.test(segMedia.mimeType || '');
    const eafOpts = { vern, anal, producedBy, mediaName: segMediaName, mediaMime: wavName ? 'audio/x-wav' : (segMedia.mimeType || 'audio/*') };
    if (wants.eaf) {
      entries.push({ name: base + '.eaf', data: new Blob([serializeEaf(doc, { ...eafOpts, profile: 'flex' })], { type: 'application/xml' }) });
      // ELAN reads display settings from a sidecar of the SAME BASENAME — this is what makes the
      // tiers open vernacular-first instead of alphabetically inverted. Carries no annotation
      // data, so it is safe to delete and safe for ELAN to overwrite (see serializeEafPrefs).
      entries.push({ name: base + '.pfsx', data: new Blob([serializeEafPrefs({ ...eafOpts, profile: 'flex', doc })], { type: 'application/xml' }) });
    }
    // SayMore's OWN storage convention is <mediafile>.annotations.eaf beside the media — emitting
    // that exact name makes the drop-in path work: copy audio + this file into a session folder
    // and SayMore lists the annotations under the audio with no import step (Seth: loading must
    // be as simple as possible; HOW-TO-OPEN.txt below documents both paths).
    if (wants.saymore) entries.push({ name: segMediaName + '.annotations.eaf', data: new Blob([serializeEaf(doc, { ...eafOpts, profile: 'saymore' })], { type: 'application/xml' }) });
    if (segMedia.derived && (wants.eaf || wants.saymore)) {
      // The EAFs reference this WAV by name (RELATIVE_MEDIA_URL / the .annotations.eaf filename),
      // so it rides EVERY bundle that carries an EAF — uploads included (Seth, 2026-08-04: the
      // researcher's Drive copy must open in ELAN/SayMore without hunting for audio). Researcher
      // bandwidth control stays: turning the EAF exports off drops the WAV too. Honesty in the
      // BYTES: a BWF bext chunk names the lossy origin and states it is not a master.
      /* ⚠ STAMPING IS HONESTY, NOT CORRECTNESS — the same rule record-pcm.js:437 and convert.js:351
       * already state at their own wavWithBext calls, and this was the one site that did not. An
       * unreadable or malformed blob threw out of the WHOLE assembler here, losing every other file
       * in the bundle to save nothing. The audio still ships; it just ships unstamped. */
      let wavBytes = null;
      try {
        wavBytes = wavWithBext(await segMedia.blob.arrayBuffer(), {
          description: `DERIVED from lossy source (${segMedia.srcName || 'unknown'}) - NOT an archival master`,
          codingHistory: `A=${String(media.mimeType || 'lossy').replace(/^audio\//, '').replace(/[^\w-]/g, '').toUpperCase() || 'LOSSY'},T=original lossy source ${segMedia.srcName || ''}\nA=PCM,W=16,T=DERIVED from lossy source - NOT an archival master`,
        });
      } catch { wavBytes = null; }
      entries.push({ name: segMediaName, data: wavBytes ? new Blob([wavBytes], { type: 'audio/wav' }) : segMedia.blob });
    }
    if (full && wants.preview) {
      // Named after the ORIGINAL recording (Seth): story.m4a → story.preview.html.
      const previewBase = sanitizeBase(base) || 'audio';
      const b64 = await b64Once(segMedia.blob);
      entries.push({ name: previewBase + '.preview.html', data: new Blob([buildSegPreviewHtml(doc, {
        title: title || base, audioB64: b64, audioMime: segMedia.mimeType || 'audio/wav', mediaName: segMediaName,
      })], { type: 'text/html' }) });
    }
    // The instructions travel WITH the files (Seth: whatever the user must do, clearly
    // documented) — a plain-text README naming this bundle's actual files, one section per tool.
    entries.push({ name: 'HOW-TO-OPEN.txt', data: new Blob([howToOpenText({
      base, segMediaName, derived: !!segMedia.derived,
      // Not derived and not a WAV ⇒ the original rode unconverted; say what that costs.
      lossyUnconverted: !segMedia.derived && !wavName,
      eaf: wants.eaf, saymore: wants.saymore, preview: !!(full && wants.preview),
      previewName: (sanitizeBase(base) || 'audio') + '.preview.html',
      json: !!(full && wants.fxpa),
    })], { type: 'text/plain' }) });
  }
  // The .fxpa export for the Paragraph Analysis satellite (Seth, 2026-08-05): LOCAL bundles only
  // (embedded base64 audio — field upload bandwidth never pays), and deliberately NOT gated on
  // alignment: an unaligned or audio-less doc exports a TEXT-ONLY .fxpa the paragraph app can
  // still group. Audio embeds only when the working media exists (i.e. aligned + media present).
  if (full && wants.fxpa) {
    const fxpaAudio = segMedia && segMedia.blob
      ? { b64: await b64Once(segMedia.blob), mime: segMedia.mimeType || 'audio/wav',
          name: segMediaName, derived: !!segMedia.derived, srcName: segMedia.srcName || '' }
      : null;
    const fxpa = buildFxpa(doc, { title: title || base, vernLang: vern, analLang: anal, audio: fxpaAudio });
    entries.push({ name: base + '.fxpa', data: new Blob([JSON.stringify(fxpa)], { type: 'application/json' }) });
  }
  return entries;
}

/* The source-package manifest's filename. Lives HERE, in the shared format module, because both
 * writers must agree on it exactly: the device writes one for a recorded text (app.js) and the
 * panel writes one for an assigned text (researcher-panel.js), and the Files menu finds the package
 * by this name. Two string literals would have drifted the first time one was edited. */
export const MANIFEST_NAME = 'flextext-manifest.json';

/* THE SOURCE-PACKAGE MANIFEST — one builder, here, for the same reason MANIFEST_NAME is here.
 *
 * ⚠ IT WAS ALREADY DRIFTING. app.js had `buildSourceManifest`; researcher-panel.js inlined a
 * hand-copied object literal of the same shape. Two writers of one contract, and the contract is
 * what every consumer checks completeness against — so the first divergence would have shown up as
 * "the panel says this package is incomplete" on a text that was fine. Moving it here is the same
 * fix MANIFEST_NAME got, applied to the thing the name refers to.
 *
 * Everything is a PARAMETER: the old version read app.js module state (`settings`, ENGINE_VERSION,
 * BUILD_TAG) directly, which is exactly what a second writer cannot do and why the panel copied it
 * instead of calling it.
 *
 * ---------------- schema 2: provenance ----------------
 * Seth, 2026-08-19: *"it might be important some time in the future to check the origin of all texts
 * in our Google Drive folders — recorded on a device (which one??), crowd recorder, or uploaded by
 * researcher (and history of which devices it's been assigned to…)"*
 *
 * `origin` (schema 1) answered HOW a text came to exist but never WHERE, so "which device recorded
 * this" was unanswerable from Drive alone — the drive-as-truth premise says it must be. `source`
 * names the birthplace and is WRITTEN ONCE, at package time, never rewritten:
 *
 *   source: { kind: 'device'|'crowd'|'researcher', id, name }
 *
 * ⚠ CUSTODY HISTORY IS DELIBERATELY NOT HERE — see plans/drive-as-truth.md §16.12. This file is
 * written FIRST, before a single source byte, and declares an INTENDED FILE SET that a consumer
 * compares against the folder to derive completeness. That only works because it is immutable.
 * Appending a move to it means rewriting it, and a rewrite that races an in-flight upload can
 * regress the declared set — turning the one document that answers "what is missing" into a
 * document that can be wrong about it. History is append-only and belongs in its own file.
 *
 * Additive by design: readers MUST ignore keys they do not know, so a schema-1 reader handles this
 * unchanged and an old manifest simply has no `source`. */
export function buildSourceManifest({
  docId, title = '', origin, originatedAt = null, engine = '', buildTag = '',
  vern = '', anal = '', audio = null, files = [], consent = null, source = null,
  now = Date.now(),
} = {}) {
  return {
    schema: 2,
    docId,
    title: title || '',
    origin,
    // Where it was born. Absent rather than half-filled: a `source` with no id is worse than none,
    // because it looks like an answer.
    ...(source && source.kind ? { source: {
      kind: source.kind,
      id: String(source.id || ''),
      name: String(source.name || ''),
    } } : {}),
    originatedAt: originatedAt || null,
    writtenAt: now,
    engine,
    buildTag: buildTag || '',
    writingSystems: { vern: vern || '', anal: anal || '' },
    audio,
    files: [{ name: MANIFEST_NAME, role: 'manifest', mime: 'application/json', bytes: 0 }, ...files],
    consent: consent || { mode: '', prompt: false, response: false, receipt: false },
  };
}

/* ---------------- FILE NAMING — one rule, shared by every writer ----------------
 *
 * ⚠ WHY THIS LIVES HERE (v3, after the v336 test drive produced `bwpX_YzJZRolHdh_.preview.html`):
 * every downloader used to name its file from the URL's LAST PATH SEGMENT. For an assigned text the
 * URL is `/v1/textfile/<token>`, so the "filename" was the opaque delivery token — and because the
 * stored media name is what the exports were derived from, ONE bad name at download time poisoned
 * the derived WAV, the SayMore `.annotations.eaf`, and the preview page. The rule is now:
 *
 *   the STORY TITLE names the file. A token can never become a filename.
 *
 * Same module as MANIFEST_NAME and for the same reason: the device (app.js), the panel
 * (researcher-panel.js) and the downloader (audio.js) must agree exactly, and three copies of a
 * sanitiser drift the first time one is edited. `sanitizeBase` is ALSO the worker's Drive folder
 * rule (v1.js `driveEnsureTextFolder`, 120 chars), so `<Storyname>.<ext>` and `<Storyname>/` cannot
 * disagree — that is why 120 won over the 80 that `docFilename` used to use.
 */
export function sanitizeBase(title) {
  return String(title || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 120);
}

// The extension to give a blob: the one its known name already carries, else one mapped from the
// MIME type. Returns '' when neither says anything — a name with no extension beats a wrong one.
export function extOf(name, mime) {
  const m = /(\.[A-Za-z0-9]{1,5})$/.exec(String(name || ''));
  if (m) return m[1].toLowerCase();
  const t = String(mime || '').split(';')[0].trim().toLowerCase();
  return ({ 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/vnd.wave': '.wav',
    'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/flac': '.flac', 'audio/x-flac': '.flac',
    'audio/ogg': '.ogg', 'audio/opus': '.opus', 'audio/webm': '.webm', 'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a', 'audio/aac': '.aac' })[t] || '';
}

const stripExt = (n) => String(n || '').replace(/\.[^.]+$/, '');

/* A filename out of a Content-Disposition header, or '' — RFC 5987 `filename*=UTF-8''…` first
 * (Drive sends it for non-ASCII names), then plain `filename="…"`. Any path is stripped: a header
 * is remote input and `../` in a download name is how a careless writer walks out of its folder. */
export function nameFromDisposition(header) {
  const h = String(header || '');
  let raw = '';
  const ext = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(h);
  if (ext) { try { raw = decodeURIComponent(ext[1].trim()); } catch { raw = ext[1].trim(); } }
  if (!raw) {
    const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(h);
    if (plain) raw = (plain[2] != null ? plain[2] : plain[3] || '').trim();
  }
  return raw.split(/[\\/]/).pop() || '';
}

/* A filename out of a URL's last path segment, or '' when that segment is not a filename.
 *
 * ⚠ THE GUARD IS THE POINT. `/v1/textfile/<token>` and `/drive?id=…` end in an opaque id, and a
 * token that becomes a filename is the exact v336 bug. Two refusals: the private-delivery route by
 * path (it is a token BY CONSTRUCTION, whatever the segment looks like), and any tail with no
 * plausible extension — a real audio file downloaded from a real URL has one. */
export function nameFromUrl(url) {
  const u = String(url || '');
  if (/\/v1\/textfile\//i.test(u)) return '';
  let tail = '';
  try { tail = decodeURIComponent((u.split(/[?#]/)[0].split('/').pop() || '')); }
  catch { tail = (u.split(/[?#]/)[0].split('/').pop() || ''); }
  return /\.[A-Za-z0-9]{1,5}$/.test(tail) ? tail : '';
}

/* The name to STORE a downloaded media file under. Precedence is the v3 work order's: the story
 * title, then a filename the SERVER stated (`name` — a relay envelope's own field, or
 * Content-Disposition), then the URL tail — and 'audio' when all of them are silent. The EXTENSION
 * comes from whichever real filename was seen, or failing that the MIME type, because a title never
 * carries one.
 * ⚠ `name` must already be a trusted filename (server-stated), NOT a raw URL segment — that is what
 * nameFromUrl is for, and its token guard is the whole point of this module. */
export function storedMediaName({ title = '', name = '', disposition = '', url = '', mime = '' } = {}) {
  const stated = String(name || '').split(/[\\/]/).pop() || nameFromDisposition(disposition);
  const tail = nameFromUrl(url);
  const ext = extOf(stated, '') || extOf(tail, '') || extOf('', mime);
  const base = sanitizeBase(title) || stripExt(stated) || stripExt(tail) || 'audio';
  return base + ext;
}

/* The name the ORIGINAL recording travels under inside a bundle: `<Storyname>.<ext>`. Derived from
 * the TITLE, never from the stored media name — so a text whose audio was stored under a token name
 * before the v3 fix still exports correctly, with no migration and no re-download. */
export function mediaNameFor(base, media) {
  return (sanitizeBase(base) || 'audio') + extOf(media?.name || '', media?.mimeType || media?.mime || '');
}

/* The derived WAV working copy's name. Seth's honesty rule: a converted file is NAMED as converted,
 * so the name says what the bext chunk says. Title-derived for the same reason as above. */
export function derivedWavName(base) {
  return (sanitizeBase(base) || 'audio') + '.converted-NOT-ARCHIVAL.wav';
}

/* ================================================================================================
 * LOOSE-FILE CONVERSIONS — one .flextext + one recording, picked from disk.
 *
 * Seth, 2026-08-14, and this IS the specification: "exactly the same thing that our files drop down
 * box already does for texts that are on Google Drive, except that the user can submit their own
 * flextext and matching audio file … a backup way to do it with files they just happen to have
 * lying around that match. That's the goal of this utility, period."
 *
 * So the shape is the Files ▾ menu's, deliberately, row for row and want for want
 * (researcher-panel.js `menuRowsFor` / `runMenuConversion`): ELAN zip, SayMore zip, preview page,
 * .fxpa, .flextext — each its own row, each its own download, greyed with a REASON when it cannot
 * be built. Not a combined bundle: matching the menu is the point.
 *
 * ⚠ WHY THIS LIVES HERE AND THE UI DOES NOT. The editor's Utilities is static markup in index.html
 * driven from app.js; the panel's is a JS-built modal in researcher-panel.js. They share no UI layer
 * at all — but the DECISIONS are what drift, and those are here. This module is ALREADY precached by
 * every service worker in the suite, so putting them here costs zero new precached paths: no new
 * top-level import in app.js, and therefore none of the v108 outage class. It must also stay
 * node-runnable, so everything is pure — the one impure step, decoding audio to WAV, is INJECTED.
 * ============================================================================================= */

/* Which rows this pair can produce, and — when one cannot — WHY, as a code the caller translates
 * (this module has no i18n, by rule). Mirrors the Files ▾ row logic.
 *
 * Reason codes: 'noText' | 'noAudio' | 'noAlign' | 'badAlign' | 'tooBig'
 */
export function loosePlan({ doc = null, audioBytes = 0, isWav = false, hasAudio = false } = {}) {
  const rows = doc ? phraseRows(doc) : [];
  const alignedRows = rows.filter((r) => isAligned(r.span));
  const caps = conversionCaps({ bytes: audioBytes, isWav });
  /* ⚠ NO PHRASE ROWS ⇒ NOTHING AT ALL, not even the .fxpa that is otherwise always available:
   * buildFxpa would emit `lines: []` and the Paragraph Analysis app refuses to open that. Reporting
   * success on an empty file is worse than refusing, because the user only finds out in the other
   * app, later, with no idea which step lied. */
  const empty = rows.length === 0;
  const ordered = alignmentIsOrdered(rows);
  const annWhy = empty ? 'noText' : !alignedRows.length ? 'noAlign' : !ordered ? 'badAlign' : '';
  const r = (ok, reason) => ({ ok, reason: ok ? '' : reason });
  /* The listening page EMBEDS the recording only when the alignment can segment it. Anything less —
   * no recording in hand, or a text with no/unusable alignment — degrades to the text-only
   * INTERLINEAR flavor rather than refusing (Seth, 2026-08-16: the same treatment the .fxpa has
   * always had). Size still refuses the EMBED flavor (the pinned v346 rule: an audio-less page
   * offered where sound was possible is a worse .flextext) — but a text-only page has no audio to
   * be too big, so the text flavor never meets that ceiling. */
  const previewEmbed = !annWhy && hasAudio && caps.preview;
  return {
    rows: rows.length,
    alignedRows: alignedRows.length,
    spanEnd: alignedRows.reduce((m, x) => Math.max(m, x.span.end), 0),
    ordered,
    caps,
    /* ⚠ THE .flextext RIDES BYTE-FOR-BYTE as picked — never re-serialized. A foreign FLEx file may
     * carry elements this app's parser does not model, and serializeFlextext would silently drop
     * them. Passing the original bytes through is the only honest option. */
    flextext: r(!empty, 'noText'),
    /* ⚠ THE EAF NEEDS TIMES, NOT AUDIO. serializeEaf omits the MEDIA_DESCRIPTOR when mediaName is ''
     * and is otherwise a perfectly legal ELAN file, so a flextext WITH offsets and no recording in
     * hand still gets its ELAN package (Seth: "a text only elan package is okay if the user does not
     * submit an audio file"). It is also the only annotation output whose cost is O(text) rather
     * than O(audio) — the one artifact a cheap phone can always deliver. */
    elan: r(!annWhy, annWhy),
    // SayMore's convention IS the audio filename, so this one genuinely needs the recording.
    saymore: r(!annWhy && hasAudio, annWhy || 'noAudio'),
    /* Refused only when there is no text at all, or when the recording COULD be embedded but is
     * over the decode ceiling — silently downgrading that case to text-only would hand someone a
     * page with no sound and no explanation of where it went. */
    preview: r(!empty && (previewEmbed || annWhy !== '' || !hasAudio), empty ? 'noText' : 'tooBig'),
    previewEmbed,
    /* ⚠ A recording was supplied that NOTHING here can use — the text has no (ordered) alignment to
     * cut it by. The UIs surface this loudly (Seth: "warn/complain if the user supplied an audio
     * file in this case"): the commonest cause is picking the wrong flextext for the recording, and
     * silence would read as "it worked". */
    audioUnaligned: !empty && hasAudio && annWhy !== '',
    // Never refused for size — above the ceiling it is simply built text-only.
    fxpa: r(!empty, 'noText'),
    fxpaAudio: !empty && hasAudio && caps.fxpaAudio,
  };
}

/* ⚠ AN EAF WITH OVERLAPPING OR BACKWARD TIMES IS INVALID, and an "is anything aligned?" check reads
 * green for one. segmentsFromOffsets clamps monotonic on the way IN, but serializeEaf reads phrase
 * offsets directly — so a foreign file whose phrases overlap (merged in ELAN, hand-edited, written
 * by a tool with its own ideas) sails past an aligned check and produces a file ELAN will not open.
 * Checking here greys the row BEFORE the build instead of failing after it. */
export function alignmentIsOrdered(rows) {
  let prevEnd = -Infinity;
  for (const r of rows || []) {
    if (!isAligned(r.span)) continue;
    if (r.span.start < prevEnd) return false;
    prevEnd = r.span.end;
  }
  return true;
}

/* ⚠ DO THE TWO FILES BELONG TOGETHER? (Seth: "check to make sure the duration matches what's in
 * [the EAF] if there's a way to do that.") There is: the last aligned phrase cannot end after the
 * recording stops. A loose-file tool is the one place this can go wrong silently — the Files ▾ menu
 * gets its pair from a manifest, this gets it from two file pickers — and the failure is a
 * well-formed archival bundle that is quietly about a different recording.
 *
 * Returns 'ok' | 'short' (audio ends before the text does — likely the wrong file) | 'unknown'.
 * A recording LONGER than the text is normal (trailing silence), so it is never flagged.
 */
export function durationVerdict({ spanEndMs = 0, durationMs = 0, tolerantMs = 1500 } = {}) {
  if (!(durationMs > 0) || !(spanEndMs > 0)) return 'unknown';
  return spanEndMs > durationMs + tolerantMs ? 'short' : 'ok';
}

/* Build ONE conversion, exactly as the Files ▾ menu builds its rows.
 *
 * @param kind        'elan' | 'saymore' | 'preview' | 'fxpa' | 'flextext'
 * @param convertWav  async (blob) => Blob|null — the caller's converter (convert.js is outside this
 *                    module's dependency rules). null/throw ⇒ the original rides and 'lossyTiming'
 *                    is noted, rather than the whole build dying on an undecodable file.
 * @returns { entries, zip, saveName, notes }  notes are REASON CODES, never sentences.
 */
export async function buildLooseConversion({ kind, doc, base = 'text', title = '', producedBy = '',
                                             flextextBlob = null, audio = null, plan = null,
                                             vern = 'und', anal = 'en', convertWav = null,
                                             onPhase = null } = {}) {
  const say = (p) => { try { onPhase && onPhase(p); } catch { /* a progress hook must never break a build */ } };
  const notes = [];

  /* ONE FILE ⇒ HAND OVER THE FILE; MORE THAN ONE ⇒ A ZIP (Seth, 2026-08-15: "if there's more than
   * one file, build a ZIP just like our built in converter for Google Drive files already does").
   *
   * Written as the RULE rather than as a per-kind table, and it is the menu's own line
   * (researcher-panel.js, download-all: `const single = entries.length === 1`). Today every
   * ELAN/SayMore build has at least two entries, so this changes no current behaviour — which is
   * exactly why it is worth having: the day one of them yields a single file, the user gets that
   * file rather than a one-item zip they have to unpack for nothing. */
  const pack = (list, zipName) => (list.length > 1
    ? { entries: list, zip: true, saveName: zipName, notes }
    : { entries: list, zip: false, saveName: list.length ? list[0].name : '', notes });

  if (kind === 'flextext') return pack([{ name: base + '.flextext', data: flextextBlob }], '');

  /* ── TEXT-ONLY INTERLINEAR PAGE — the preview's no-audio flavor (the fxpa treatment). Decided by
   * the PLAN so the row the user clicked and the file they get cannot disagree; with no plan in
   * hand (bare test calls), having a recording means embedding it, exactly as before.
   *
   * ⚠ BEFORE the working-copy block, deliberately: converting a recording to WAV that this page
   * will not contain is minutes of decode on a phone for nothing. And when a recording WAS supplied
   * but the text has no alignment to cut it by, the build says so ('previewNoAudio') — a page that
   * quietly lacks the sound someone handed us reads as "it worked". */
  const previewEmbed = plan ? !!plan.previewEmbed : !!(audio && audio.blob);
  if (kind === 'preview' && !previewEmbed) {
    say('annotations');
    if (audio && audio.blob) notes.push('previewNoAudio');
    return pack([{
      name: (sanitizeBase(base) || 'text') + '.interlinear.html',
      data: new Blob([buildSegPreviewHtml(doc, { title: title || base })], { type: 'text/html' }),
    }], '');
  }

  // ── the working copy, exactly as the device makes one: WAV rides as-is, lossy is converted and
  // the derived file carries the BWF bext chunk naming its origin (assembleSegEntries does that).
  let segMedia = null, media = null;
  if (audio && audio.blob) {
    media = { blob: audio.blob, mimeType: audio.mimeType || 'audio/*', name: audio.name };
    const isWav = /\.wav$/i.test(audio.name || '') || /wav$/i.test(audio.mimeType || '');
    if (isWav) {
      segMedia = { blob: audio.blob, mimeType: 'audio/wav', name: audio.name, derived: false };
    } else if (convertWav) {
      say('converting');
      let wav = null;
      try { wav = await convertWav(audio.blob); } catch { wav = null; }
      if (wav) segMedia = { blob: wav, mimeType: 'audio/wav', name: audio.name, derived: true, srcName: audio.name || '' };
      else {
        /* ⚠ AN UNDECODABLE FILE MUST NOT KILL THE BUILD — AAC on a browser without the codec, AIFF,
         * a truncated copy. The recording still ships and the annotations still reference it; what
         * is lost is the WAV working copy, and the note says exactly that. */
        segMedia = { blob: audio.blob, mimeType: audio.mimeType || 'audio/*', name: audio.name, derived: false };
        notes.push('lossyTiming');
      }
    } else {
      segMedia = { blob: audio.blob, mimeType: audio.mimeType || 'audio/*', name: audio.name, derived: false };
      notes.push('lossyTiming');
    }
  }

  // ── TEXT-ONLY ELAN: no recording in hand. assembleSegEntries gates its whole annotation block on
  // media && segMedia, so this is built directly rather than by relaxing a gate five apps rely on.
  if ((kind === 'elan' || kind === 'eaf') && !segMedia) {
    say('annotations');
    const o = { vern, anal, producedBy, mediaName: '', mediaMime: '' };
    notes.push('eafNoMedia');
    const eafFile = { name: base + '.eaf', data: new Blob([serializeEaf(doc, { ...o, profile: 'flex' })], { type: 'application/xml' }) };
    // eaf-only is ONE file, so it is handed over bare — no zip around a single document, and no
    // .pfsx, which is ELAN's tier-order preference and belongs with the package, not the annotation.
    if (kind === 'eaf') return pack([eafFile], '');
    return pack([
      eafFile,
      { name: base + '.pfsx', data: new Blob([serializeEafPrefs({ ...o, profile: 'flex', doc })], { type: 'application/xml' }) },
    ], `${base} ELAN.zip`);
  }

  /* ⚠ THE WANT/FULL TABLE IS THE MENU'S, verbatim (researcher-panel.js:1842,1851): preview and fxpa
   * are the embedded-audio outputs and need `full`; the ELAN/SayMore zips match what an upload
   * bundle carries. Diverging here is how two surfaces start producing different files from the
   * same inputs. */
  const wants = { elan: { eaf: true }, eaf: { eaf: true }, saymore: { saymore: true },
                  preview: { preview: true }, fxpa: { fxpa: true } }[kind];
  if (!wants) return { entries: [], zip: false, saveName: '', notes };
  const full = kind === 'preview' || kind === 'fxpa';

  // An oversized .fxpa is built WITHOUT audio rather than refused — dropping the media IS the
  // mechanism, exactly as the menu does it (researcher-panel.js:1847).
  const dropAudio = kind === 'fxpa' && plan && !plan.fxpaAudio;
  if (dropAudio && media) notes.push('fxpaNoAudio');

  // `full` IS "preview or fxpa" — the embedded-audio outputs, which are the slow ones worth naming.
  say(full ? 'embedding' : 'annotations');
  const entries = await assembleSegEntries({
    doc, title, base, vern, anal, wants, full, producedBy,
    media: dropAudio ? null : media, segMedia: dropAudio ? null : segMedia,
  });

  /* The ORIGINAL recording rides in every ELAN / SayMore zip (Seth, 2026-09-04: "the original does
   * need to be saved and included"). The derived WAV is pushed by the assembler itself; when the
   * original IS that WAV it already sits in the zip under this name and is not doubled, and when a
   * lossy original was converted it rides beside the converted copy under its own name. Gated on
   * the two zip kinds so a preview-only or fxpa-only build does not drag the whole file along. */
  if (segMedia && audio && audio.blob && (kind === 'elan' || kind === 'saymore')) {
    const origName = mediaNameFor(base, segMedia.derived ? media : segMedia);
    if (!entries.some((x) => x.name === origName)) entries.push({ name: origName, data: audio.blob });
  }

  if (kind === 'elan' || kind === 'saymore') {
    return pack(entries, `${base} ${kind === 'elan' ? 'ELAN' : 'SayMore'}.zip`);
  }
  /* ⚠ The preview and the .fxpa are SINGLE-FILE outputs by design, and the extra entries the
   * assembler returns alongside them are deliberately dropped rather than zipped up: both embed
   * their audio, so a HOW-TO-OPEN.txt and a second copy of the recording would be pure weight — and
   * the Files ▾ menu hands over a bare .html / .fxpa too. Parity is the specification. */
  const pick = kind === 'preview' ? /\.preview\.html$/i : kind === 'eaf' ? /\.eaf$/i : /\.fxpa$/i;
  const one = entries.find((x) => pick.test(x.name));
  return pack(one ? [one] : [], '');
}
