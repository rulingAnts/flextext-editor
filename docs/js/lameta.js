/* lameta.js — the lameta SESSION FOLDER writer, and the progress fields the suite writes into it.
 *
 * ONE TEXT → ONE FOLDER a researcher drops straight into a lameta project. Seth, 2026-09-10:
 * "I've got texts coming that I need to move from Researcher panel into my organized text corpus.
 * And I want to make that easier." Since v690 the same folder is also what the lameta device agent
 * writes (plans/lameta-device.md), carrying the stage fields of plans/lameta-progress-spec.md.
 *
 * ⚠ THE FORMAT HERE IS READ FROM lameta ITSELF — the shipped 3.0.21-beta bundle and the upstream
 * source — and checked against Seth's own projects under ~/Documents/lameta/. Until v690 this
 * header said the vocabularies came from lameta_core.py's VOCAB, "not guessed". That tool's lists
 * were themselves partial (seven of lameta's twenty-five contributor roles), and three claims made
 * from them were wrong: lameta does NOT drop a vocabulary value it has not seen (it registers it as
 * an encountered value and keeps it); `.fxpa` is NOT one of lameta's file types (its FLEx types are
 * fwdata, flextext, fwbackup, lift, fwdict, fwnotebook, fwthes — LAMETA_TYPES below); and the file
 * naming rule is more than a character class (lametaSanitize). Omission is still the rule for
 * anything we would only be guessing at: a field that looks answered but is not is worse than a blank.
 *
 * ⚠ SESSIONS ARE DISCOVERED, NOT REGISTERED — which is what makes a drop-in folder work at all. The
 * `.sprj` project file carries only project-level settings; it holds NO session list. lameta treats
 * EVERY directory under `Sessions/` as a session and reads `<dirname>.session` inside it. So:
 *
 *     Sessions/<id>/<id>.session          ⚠ the folder name MUST equal the id, or the session is broken
 *
 * Every file with a dot in its name at the session root is listed as one of the session's files and
 * gets a `.meta` sidecar; a SUBFOLDER inside a session is invisible to lameta and to its archive
 * exports — which is exactly where the suite keeps its own bookkeeping (LAMETA_SUITE_DIR).
 *
 * ⚠ ELAN EAF, NEVER THE SAYMORE PROFILE. Seth: "Lameta doesn't have a built in eaf/annotation editor
 * like SayMore does. It just opens ELAN." SayMore MANAGED annotation files — it rewrote
 * `<media>.annotations.eaf`, which is why our SayMore profile is deliberately two tiers. lameta
 * delegates to ELAN, so the complete six-tier hierarchy survives and is what a researcher actually
 * wants on the other side. `.pfsx` rides along because ELAN reads tier display order from it.
 *
 * Kept PURE — plain data in, plain data out, no DOM, no storage, no i18n, no zip — so the panel,
 * the lameta agent and node tests all build the same bytes. The one import is the document model,
 * for the progress counts and the .flextext's media links.
 */
import { segmentsFromOffsets, analysisLangs, glossIn, freeIn, linkPhraseMedia } from './flextext.js';

/* ─── VOCABULARIES, from lameta's own bundle ─────────────────────────────────────────────────── */
export const LAMETA_STATUS = ['Incoming', 'In_Progress', 'Finished', 'Skipped'];
/* All twenty-five contributor roles (lameta's locale/roles.csv: the OLAC role vocabulary plus its own
 * additions). ⚠ NOT the seven lameta_core.py knew. A role outside this list is written the way
 * lameta itself writes "no role" — see lametaSessionXml — never approximated to `speaker`. */
export const LAMETA_ROLES = ['annotator', 'author', 'careful_speech_speaker', 'compiler', 'consultant',
  'data_inputter', 'depositor', 'developer', 'editor', 'illustrator', 'interpreter', 'interviewer',
  'participant', 'performer', 'photographer', 'recorder', 'researcher', 'research_participant',
  'responder', 'signer', 'singer', 'speaker', 'sponsor', 'transcriber', 'translator'];
export const LAMETA_GENRES = ['', 'narrative', 'description', 'oratory', 'procedural_discourse',
  'procedural_text', 'singing', 'stimuli', 'conversation', 'elicitation', 'formulaic_discourse',
  'ludic', 'report', 'interactive_discourse', 'language_play', 'unintelligible_speech'];
/* lameta's file types, by extension — its own table. A caller can tell whether a file it is about
 * to add will be understood (audio, an ELAN file, a FLEx file) or merely carried. */
export const LAMETA_TYPES = {
  audio: ['wav', 'mp3', 'wma', 'ogg', 'flac', 'aac', 'm4a', 'aiff', 'aif', 'au', 'amr', 'ra', 'ram', 'caf'],
  video: ['mts', 'avi', 'mov', 'mp4', 'mpeg', 'mpg', 'avchd', 'wmv', 'm4v'],
  image: ['jpg', 'jpeg', 'png', 'tiff', 'gif', 'tif', 'svg', 'bmp'],
  chat: ['cha'],
  elan: ['eaf', 'pfsx'],
  transcriber: ['trs'],
  doc: ['pdf', 'html', 'htm', 'doc', 'docx', 'txt'],
  settings: ['psfx', 'typ', 'lng', 'etf'],
  toolbox: ['tbt'],
  praat: ['textgrid'],
  flex: ['fwdata', 'flextext', 'fwbackup', 'lift', 'fwdict', 'fwnotebook', 'fwthes'],
  geo: ['kml', 'kmz'],
};
/** The LAMETA_TYPES key for a file name, or '' when lameta would only carry it. */
export function lametaFileType(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  const ext = m ? m[1].toLowerCase() : '';
  for (const [type, exts] of Object.entries(LAMETA_TYPES)) if (exts.includes(ext)) return type;
  return '';
}

/* Field order, as lameta writes a session. Emitting in a different order is not fatal, but matching
 * it keeps our files diff-clean against ones lameta itself has written. */
const SESSION_ORDER = ['id', 'Title', 'Description', 'languages', 'WorkingLanguages', 'Genre',
  'Sub-Genre', 'Status', 'Date', 'Location', 'Location_Region', 'Location_Country',
  'Location_Continent', 'Access', 'AccessExplanation', 'Keywords', 'Topic'];
/* The `type` attribute lameta puts on each field: `string` for text, `languageChoices` for the
 * subject languages, and NONE for a date (its writer emits dates as a bare element). lameta reads
 * any of these forms; writing its own keeps a file it re-saves identical to the one we wrote. */
const FIELD_TYPE = { Date: '', languages: 'languageChoices' };

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/* ─── lameta's FILE NAMING RULE (archive configuration "ASCII", the REAP profile Seth uses) ────────
 *
 * Seth, 2026-09-11, from lameta 3.0.21-beta: every file of an imported session showed a red ! and
 * "This file does not comply with the file naming rules of the current archive". The rule, read
 * from lameta's sanitizeForArchive (upstream V3): fold to ASCII with fold-to-ascii (Lucene's
 * ASCIIFoldingFilter; a character it cannot fold becomes "X"); trim; whitespace → "_"; anything
 * outside 0-9 A-Z a-z _ . - → "_"; then npm's sanitize-filename with an EMPTY replacement (a name
 * that is only dots, a Windows reserved stem like `con` or `com1`, and trailing dots and spaces
 * vanish; 255 bytes at most); then strip "_" from both ends. A name COMPLIES when the rule leaves it
 * unchanged — so lametaSanitize IS lameta's verdict, and lametaFileName / lametaSessionId only ever
 * return names it leaves alone.
 *
 * The fold: NFKD plus stripping combining marks reproduces Lucene's table for every accented letter
 * (Café → Cafe). FOLD_TABLE is every letter and punctuation mark in the Latin, IPA and general
 * punctuation ranges that NFKD cannot reach (ø ł đ æ œ ß þ ð, ɛ ɔ ə ŋ, curly quotes, dashes…),
 * generated from fold-to-ascii's ascii-folder.js (Apache-2.0; the Lucene port lameta itself uses).
 * Anything else non-ASCII folds to "X", as it does in lameta. Exact parity is a courtesy to the
 * reader of the folder name — compliance never depends on it, because lameta checks OUR output and
 * everything here is plain ASCII by the time it is checked. */
const FOLD_TABLE = {
  "\"": '\u00AB\u00BB\u201C\u201D\u201E\u2033\u2036',
  "%": '\u2052',
  "'": '\u2018\u2019\u201A\u201B\u2032\u2035\u2039\u203A',
  "*": '\u204E',
  "-": '\u2010\u2011\u2012\u2013\u2014',
  "/": '\u2044',
  ";": '\u204F',
  A: '\u018F\u023A',
  AE: '\u00C6\u01E2\u01FC',
  B: '\u0181\u0182\u0243\u0299',
  C: '\u0187\u023B\u0297',
  D: '\u00D0\u0110\u0189\u018A\u018B',
  E: '\u018E\u0190\u0246',
  F: '\u0191',
  G: '\u0193\u01E4\u01E5\u01E7\u0262\u029B',
  H: '\u0126\u029C',
  HV: '\u01F6',
  I: '\u0196\u0197\u026A',
  J: '\u0248',
  K: '\u0198',
  L: '\u013F\u0141\u023D\u029F',
  LL: '\u1EFA',
  M: '\u019C',
  N: '\u014A\u019D\u0220\u0274',
  O: '\u00D8\u0186\u019F\u01FE',
  OE: '\u0152\u0276',
  OU: '\u0222',
  P: '\u01A4',
  Q: '\u024A',
  R: '\u024C\u0280\u0281',
  SS: '\u1E9E',
  T: '\u0166\u01AC\u01AE\u023E',
  TH: '\u00DE',
  U: '\u0244',
  V: '\u01B2\u0245\u1EFC',
  W: '\u01F7',
  Y: '\u01B3\u024E\u028F\u1EFE',
  Z: '\u01B5\u021C\u0224',
  "[": '\u2045',
  "]": '\u2046',
  "^": '\u2038',
  a: '\u0250\u0259\u025A\u1E9A',
  ae: '\u00E6\u01E3\u01FD',
  b: '\u0180\u0183\u0253',
  c: '\u0188\u023C\u0255',
  d: '\u00F0\u0111\u018C\u0221\u0256\u0257',
  db: '\u0238',
  dz: '\u02A3\u02A5',
  e: '\u01DD\u0247\u0258\u025B\u025C\u025D\u025E\u029A',
  f: '\u0192\u1E9B',
  g: '\u0260\u0261',
  h: '\u0127\u0265\u0266\u02AE\u02AF',
  hv: '\u0195',
  i: '\u0131\u0268',
  j: '\u0237\u0249\u025F\u0284\u029D',
  k: '\u0199\u029E',
  l: '\u0140\u0142\u019A\u0234\u026B\u026C\u026D',
  ll: '\u1EFB',
  ls: '\u02AA',
  lz: '\u02AB',
  m: '\u026F\u0270\u0271',
  n: '\u0149\u014B\u019E\u0235\u0272\u0273',
  o: '\u00F8\u01FF\u0254\u0275',
  oe: '\u0153',
  ou: '\u0223',
  p: '\u01A5',
  q: '\u0138\u024B\u02A0',
  qp: '\u0239',
  r: '\u024D\u027C\u027D\u027E\u027F',
  s: '\u023F\u0282\u1E9C\u1E9D',
  ss: '\u00DF',
  t: '\u0167\u01AB\u01AD\u0236\u0287\u0288',
  tc: '\u02A8',
  th: '\u00FE',
  ts: '\u02A6',
  u: '\u0289',
  v: '\u028B\u028C',
  w: '\u01BF\u028D',
  y: '\u01B4\u024F\u028E\u1EFF',
  z: '\u01B6\u021D\u0225\u0240\u0290\u0291',
  "~": '\u2053',
};
const FOLD = new Map();
for (const [rep, chars] of Object.entries(FOLD_TABLE)) for (const ch of chars) FOLD.set(ch, rep);

export function lametaFold(s) {
  let out = '';
  for (const ch of String(s == null ? '' : s)) {
    if (ch.length === 1 && ch.charCodeAt(0) < 128) { out += ch; continue; }
    const t = FOLD.get(ch);
    if (t !== undefined) { out += t; continue; }
    const n = ch.normalize('NFKD').replace(/\p{M}+/gu, '');
    out += /^[A-Za-z0-9]+$/.test(n) ? n : 'X';
  }
  return out;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** lameta's rule, applied once: what lameta would rename `name` to. Equal to `name` ⇔ compliant. */
export function lametaSanitize(name) {
  let n = lametaFold(name).trim().replace(/\s/g, '_').replace(/[^0-9A-Za-z_.-]/g, '_');
  // sanitize-filename with '' as the replacement. Its illegal-character and control-character
  // clauses can no longer act (everything is already "_"), so only these three remain.
  n = n.replace(/^\.+$/, '').replace(WIN_RESERVED, '').replace(/[. ]+$/, '');
  n = n.slice(0, 255);                                       // ASCII by now, so bytes are characters
  return n.replace(/^_+/, '').replace(/_+$/, '');
}
export const lametaCompliant = (name) => lametaSanitize(name) === String(name);

/* One name part, made compliant AND tidy: the rule's own steps minus the reserved-stem erasure
 * (handled by the callers, who append "_" instead), then runs of "_" collapsed, because "a__b"
 * is legal but nobody wants it. Reserved stems are checked AFTER tidying so `con` cannot hide
 * behind a stray underscore. */
const collapse = (s) => s.replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
function cleanPart(s) {
  let n = lametaFold(s).trim().replace(/\s/g, '_').replace(/[^0-9A-Za-z_.-]/g, '_');
  n = n.replace(/^\.+$/, '').replace(/[. ]+$/, '').slice(0, 255);
  return collapse(n);
}

/* ⚠ THE FOLDER NAME AND THE ID MUST AGREE EXACTLY, so both go through this. A title with a space
 * or an apostrophe would otherwise produce a folder lameta cannot match to its own session file.
 * Leading and trailing dots and dashes go too (a folder named ".foo" is hidden), and the id is
 * capped short enough that lametaSessionIdFor's `_2`, `_3` suffixes always fit. */
export function lametaSessionId(base) {
  let id = cleanPart(base).replace(/^[._-]+|[._-]+$/g, '').slice(0, 200);
  // lameta's rule ERASES a bare reserved stem and strips a trailing "_", so only a prefix survives it.
  if (WIN_RESERVED.test(id)) id = 'session_' + id;
  return id || 'session';
}

/* The id for a text's session in a project that already has sessions: the text's OWN session when
 * a manifest with its docId is already there (an existing folder is never renamed — lameta renames
 * the folder and every id-prefixed file when a person edits an id, and we never do that for them),
 * otherwise the title's id, with `_2`, `_3`… on a collision. Case-insensitive, because the folder
 * lives on macOS or Windows. `existing` is [{ id, docId }] as scanned from Sessions/. */
export function lametaSessionIdFor(title, docId, existing = []) {
  const rows = (existing || []).filter((r) => r && r.id);
  const mine = docId ? rows.find((r) => r.docId === docId) : null;
  if (mine) return String(mine.id);
  const taken = new Set(rows.map((r) => String(r.id).toLowerCase()));
  const base = lametaSessionId(title);
  let id = base;
  for (let n = 2; taken.has(id.toLowerCase()); n++) id = `${base}_${n}`;
  return id;
}

/* A file name lameta's rule leaves alone. A compliant name is returned exactly as it came; a
 * non-compliant one becomes the nearest tidy compliant name — never empty, never a bare
 * extension, never a Windows reserved stem (lameta's rule ERASES `con.wav`; `con_.wav` it leaves). */
export function lametaFileName(name) {
  const s = String(name == null ? '' : name).trim();
  if (s && lametaCompliant(s) && !/^\./.test(s)) return s;
  const dot = s.lastIndexOf('.');
  const hasExt = dot >= 0 && dot < s.length - 1;          // ".wav" is an extension with no stem
  const ext = hasExt ? cleanPart(s.slice(dot + 1)).replace(/\./g, '_') : '';
  let stem = cleanPart(hasExt ? s.slice(0, dot) : s) || 'file';
  // "con_.wav" survives lameta's rule; a bare "con_" loses its "_" and is then erased, so: "file_con".
  if (WIN_RESERVED.test(stem)) stem = ext ? stem + '_' : 'file_' + stem;
  stem = stem.slice(0, 255 - (ext ? ext.length + 1 : 0));   // the rule's 255 bytes, extension kept
  const out = ext ? `${stem}.${ext}` : stem;
  return lametaCompliant(out) ? out : (lametaSanitize(out) || 'file');
}

/* A .flextext names its recording in <media-files><media location="…"/>. The package renames the
 * recording, so that one attribute has to follow it or FLEx looks for a file that is not there (Seth:
 * "Also, update the flextext file's media reference"). That reference has a second half: each timed
 * phrase's media-file, without which FLEx imports the phrase with its times thrown away — and the
 * suite's older uploads carry a media-files block with no links at all. So linkPhraseMedia gives
 * every timed phrase one, to the entry just repointed. Those are the only changes: the rest of the
 * fetched XML ships byte for byte, which is why the package carries it rather than a
 * re-serialization. A bare file name, because the recording travels in the same folder. */
export function lametaFlextextMedia(xml, mediaName) {
  if (!xml || !mediaName) return xml;
  const repointed = String(xml).replace(/<media(?=[\s/>])[^>]*>/g,
    (tag) => tag.replace(/(\slocation=)(["'])[^"']*\2/, (m, attr, q) => `${attr}${q}${esc(mediaName)}${q}`));
  return linkPhraseMedia(repointed, { mediaName });
}

/** `Finished` once the coworker has marked the text done; otherwise it is still being worked on. */
export function lametaStatus(done) { return done ? 'Finished' : 'In_Progress'; }

/* ─── PROGRESS FIELDS — plans/lameta-progress-spec.md ────────────────────────────────────────────
 *
 * Seth, lameta issue #74: track "transcription, glossing, free translation, morpheme analysis, text
 * charting, etc" per session, not only recording and archiving. The spec is shared with the lameta
 * pull request, corpus-keeper and the corpus checklist; LAMETA_PROGRESS_SPEC is its version, and
 * test/lameta-progress.test.mjs pins it to the plan file. */
export const LAMETA_PROGRESS_SPEC = 1;
export const STEP_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/* The corpus checklist's fourteen visible steps, ids verbatim, so the checklist, lameta and the
 * suite share one vocabulary. The researcher customizes the list in `<project>/progress-steps.json`. */
export const DEFAULT_STEPS = [
  { id: 'consent', label: 'Consent' },
  { id: 'metadata', label: 'Metadata' },
  { id: 'record', label: 'Audio recording' },
  { id: 'segment', label: 'Audio segmentation' },
  { id: 'transcribe', label: 'Transcription' },
  { id: 'gloss-lwc', label: 'LWC word gloss' },
  { id: 'ft-lwc', label: 'LWC free translation' },
  { id: 'flex', label: 'Import into FLEx' },
  { id: 'gloss-en', label: 'English word gloss' },
  { id: 'ft-en', label: 'English free translation' },
  { id: 'morph', label: 'Morphological analysis' },
  { id: 'tagging', label: 'Tagging' },
  { id: 'charting', label: 'Text charting' },
  { id: 'para', label: 'Paragraph analysis' },
];
/* The two picks that derive lameta's Status: not past the first → Incoming; past the second →
 * Finished. `archive-submitted` is one of the checklist's hidden steps, so the suite never sets it. */
export const DEFAULT_STATUS_PICKS = { inProgressAfter: 'record', finishedAfter: 'archive-submitted' };
export function defaultProgressSteps() {
  return { version: LAMETA_PROGRESS_SPEC, steps: DEFAULT_STEPS.map((s) => ({ ...s })), status: { ...DEFAULT_STATUS_PICKS } };
}
/* A step id is stable forever and must never contain `date`: lameta force-parses any XML tag whose
 * name contains it as a date and replaces the text. */
export function validStepId(id) { return STEP_ID_RE.test(String(id || '')) && !/date/i.test(String(id)); }
/** `gloss-lwc` → `Stage_Gloss_Lwc`: the custom-field key for a step. */
export function stageKey(id) {
  const parts = String(id || '').split(/[-_]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1));
  return 'Stage_' + parts.join('_');
}
/* The language suffix of a gloss / free-translation stage: English is `En`; the project's analysis
 * language, when it is not English, is `Lwc`; any other code is capitalized (`fr` → `Fr`). */
export function stageLang(lang, analLang = '') {
  const code = String(lang || '').toLowerCase();
  if (code === 'en' || code === 'eng') return 'En';
  if (code && code === String(analLang || '').toLowerCase()) return 'Lwc';
  return code.split(/[^a-z0-9]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join('_') || 'Und';
}

/* The checklist's bar: a layer counts as done at 95%, because the last few lines of a real text are
 * so often a title line or a fragment nobody glosses. */
export const FX_DONE_BAR = 0.95;
const stageOf = (n, total) => ((!total || !n) ? '' : (n / total >= FX_DONE_BAR ? 'done' : 'in_progress'));
/* Canonical spelling of a stored stage value: 'done' | 'in_progress' | '' (absent) | null (an
 * unknown non-empty value — someone else's, preserved, never rewritten). */
export function normStage(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (s === 'done' || s === 'in_progress') return s;
  return s ? null : '';
}

/** Counts behind the derived stages, from the document model alone. */
export function textProgress(doc, analLang = '') {
  const prim = analLang || (doc && doc.analLang) || 'en';
  const paras = (doc && doc.paragraphs) || [];
  const segs = paras.flatMap((p) => (p && p.segments) || []);
  const words = segs.flatMap((s) => (s.words || []).filter((w) => w && !w.punct));
  const hasText = (s) => !!String(s.baseline || '').trim()
    || (s.words || []).some((w) => w && !w.punct && String(w.txt || '').trim());
  const spans = (doc && segmentsFromOffsets(doc)) || [];
  const langs = analysisLangs(doc, prim);
  const gloss = {}, free = {};
  for (const l of langs.gloss) gloss[l] = { n: words.filter((w) => String(glossIn(w, l, prim) || '').trim()).length, total: words.length };
  for (const l of langs.free) free[l] = { n: segs.filter((s) => String(freeIn(s, l, prim) || '').trim()).length, total: segs.length };
  return {
    lines: paras.length, phrases: segs.length, words: words.length,
    transcribed: segs.filter(hasText).length,
    aligned: spans.filter((s) => s && typeof s.start === 'number' && !s.timePending).length,
    gloss, free,
  };
}

// The panel's SOURCE_AUDIO_ROLES, mirrored: the tags Drive puts on a text's recording.
const SOURCE_AUDIO_ROLES = ['source-audio', 'assigned-audio'];
/* What the suite can derive (spec §4), keyed by custom-field key, only the stages that are at least
 * begun — absent means not started. Everything else (metadata, flex, morph, tagging, charting,
 * para, every hidden step) is a person's to set. `files` are Drive rows or folder entries with a
 * `role`; `manifest` is the text's source manifest; `doc` the parsed flextext. */
export function deriveStages({ doc = null, manifest = null, files = [], analLang = '' } = {}) {
  const out = {};
  const rows = (files || []).filter(Boolean);
  const role = (f) => String(f.role || '');
  const consent = (manifest && manifest.consent) || {};
  // A consent RESPONSE or receipt — the spoken prompt alone is not consent.
  if (consent.response || consent.receipt || rows.some((f) => role(f) === 'consent-clip' || role(f) === 'consent-receipt')) {
    out.Stage_Consent = 'done';
  }
  if ((manifest && manifest.audio && manifest.audio.name)
      || rows.some((f) => SOURCE_AUDIO_ROLES.includes(role(f)) || (!role(f) && lametaFileType(f.name) === 'audio'))) {
    out.Stage_Record = 'done';
  }
  if (doc) {
    const p = textProgress(doc, analLang);
    const put = (key, n, total) => { const v = stageOf(n, total); if (v) out[key] = v; };
    put('Stage_Segment', p.aligned, p.lines);
    put('Stage_Transcribe', p.transcribed, p.phrases);
    const lang = analLang || doc.analLang || '';
    for (const [l, g] of Object.entries(p.gloss)) put('Stage_Gloss_' + stageLang(l, lang), g.n, g.total);
    for (const [l, f] of Object.entries(p.free)) put('Stage_Ft_' + stageLang(l, lang), f.n, f.total);
  }
  return out;
}

/* Spec §3, the two picks. `picks` null means the project derives no Status ('' back). The suite
 * never writes Skipped on its own: withdrawal is a person's word. */
export function lametaStatusFor(stages = {}, picks = DEFAULT_STATUS_PICKS, { withdrawn = false } = {}) {
  if (withdrawn) return 'Skipped';
  if (picks === null) return '';
  const p = { ...DEFAULT_STATUS_PICKS, ...(picks || {}) };
  const get = (id) => normStage((stages || {})[stageKey(id)]) || '';
  if (p.inProgressAfter && get(p.inProgressAfter) !== 'done') return 'Incoming';
  if (p.finishedAfter && get(p.finishedAfter) === 'done') return 'Finished';
  return 'In_Progress';
}

/* Monotonic merge (spec §4): a derived value never lowers a stored one — `done` stays `done` when a
 * recount says `in_progress`, because lowering is a person's decision. An unknown stored value is
 * someone else's and is left exactly as it is. Keys outside the derivation pass through untouched. */
const RANK = { '': 0, in_progress: 1, done: 2 };
export function mergeStages(existing = {}, derived = {}) {
  const out = { ...(existing || {}) };
  for (const [k, v] of Object.entries(derived || {})) {
    const d = normStage(v);
    if (!d) continue;
    const e = normStage(out[k]);
    if (e === null) continue;
    if (RANK[d] > RANK[e]) out[k] = d;
  }
  return out;
}

/** `<ISO time>;<engine>;status=<Status written>` — the stamp that lets a later writer tell a Status it
 * wrote from one a person set by hand (spec §3). */
export function lametaSuiteStamp({ now = Date.now(), engine = '', status = '' } = {}) {
  const iso = typeof now === 'number' ? new Date(now).toISOString() : String(now);
  return `${iso};${engine || ''};status=${status || ''}`;
}

/* The `<CustomFields type="xml">` block, indented for the session file, or '' when there is nothing
 * to say. A key that could not be a safe XML name, or that contains `date` (lameta would parse its
 * text as a date), is refused rather than written. Empty values are omitted: lameta drops them. */
const CUSTOM_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
export function lametaCustomFieldsXml(fields = {}) {
  const lines = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (!CUSTOM_KEY_RE.test(k) || /date/i.test(k)) continue;
    const val = String(v == null ? '' : v).trim();
    if (!val) continue;
    lines.push(`    <${k} type="string">${esc(val)}</${k}>`);
  }
  return lines.length ? ['  <CustomFields type="xml">', ...lines, '  </CustomFields>'].join('\n') : '';
}

/**
 * The `<id>.session` XML.
 *
 * ⚠ EMPTY FIELDS ARE OMITTED, NOT EMITTED BLANK. A researcher fills the rest in lameta, which is
 * what lameta is for; writing empty elements would leave them looking answered.
 *
 * Status: an explicit valid `status` wins; else Done → Finished (the coworker's word); else the
 * two-picks rule over `stages` when they are given; else In_Progress. `stages`, `docId`, `flexGuid`
 * and `engine` fill the CustomFields block (spec §2), which goes LAST, after Contributions, where
 * lameta itself puts it. `now` exists so tests can pin the stamp.
 */
export function lametaSessionXml(s = {}) {
  const id = lametaSessionId(s.id || s.title);
  const status = LAMETA_STATUS.includes(s.status) ? s.status
    : s.done ? 'Finished'
    : s.stages ? (lametaStatusFor(s.stages, s.picks === undefined ? DEFAULT_STATUS_PICKS : s.picks) || 'In_Progress')
    : lametaStatus(false);
  const vals = {
    id,
    Title: s.title || '',
    Description: s.description || '',
    languages: s.vernLang || '',                 // subject language(s) — the vernacular
    WorkingLanguages: s.analLang || '',          // the analysis language
    Genre: LAMETA_GENRES.includes(s.genre) ? s.genre : '',
    Status: status,
    Date: s.date || '',
  };
  const lines = ['<?xml version="1.0" encoding="utf-8"?>',
    '<Session minimum_lameta_version_to_read="0.0.0">'];
  for (const k of SESSION_ORDER) {
    const v = vals[k];
    if (v === undefined || v === '') continue;
    const ty = FIELD_TYPE[k] === undefined ? 'string' : FIELD_TYPE[k];
    lines.push(ty ? `  <${k} type="${ty}">${esc(v)}</${k}>` : `  <${k}>${esc(v)}</${k}>`);
  }
  /* Contributions is a nested element, not a field — shape taken from a real .session file:
   *   <Contributions><contributor><name/><role/><date/></contributor></Contributions>
   * ⚠ A role outside lameta's list is written the way lameta writes "no role": `participant` plus
   * `<smxrole>unspecified</smxrole>`, which lameta reads back as no role at all. Never a guess. */
  const people = (s.contributors || []).filter((c) => c && c.name);
  if (people.length) {
    lines.push('  <Contributions>');
    for (const c of people) {
      const role = LAMETA_ROLES.includes(c.role) ? c.role : '';
      lines.push('    <contributor>');
      lines.push(`      <name>${esc(c.name)}</name>`);
      lines.push(`      <role>${role || 'participant'}</role>`);
      if (!role) lines.push('      <smxrole>unspecified</smxrole>');
      // ⚠ lameta writes 0001-01-01 for "no date" rather than an empty element — matched here so our
      // files look like its own (it rewrites the date to that on every save anyway).
      lines.push(`      <date>${esc(c.date || '0001-01-01')}</date>`);
      lines.push('    </contributor>');
    }
    lines.push('  </Contributions>');
  } else {
    lines.push('  <Contributions></Contributions>');
  }
  const custom = {};
  for (const [k, v] of Object.entries(s.stages || {})) if (v) custom[k] = v;
  if (s.docId) custom.Suite_Doc_Id = String(s.docId);
  if (s.flexGuid) custom.Flex_Text_Guid = String(s.flexGuid);
  if (Object.keys(custom).length && s.stamp !== false) {
    custom.Suite_Stamp = lametaSuiteStamp({ now: s.now, engine: s.engine, status });
  }
  const cf = lametaCustomFieldsXml(custom);
  if (cf) lines.push(cf);
  lines.push('</Session>');
  return lines.join('\n') + '\n';
}

/* The per-file sidecar lameta keeps beside each media/annotation file, byte-for-byte what lameta
 * writes for a file with nothing recorded about it. lameta creates these itself if absent, so
 * writing them costs nothing and matches a project lameta has already touched. */
export function lametaFileMetaXml() {
  return '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<Meta minimum_lameta_version_to_read="0.0.0">\n'
    + '  <Contributions></Contributions>\n</Meta>';
}

/* The instructions sit at the TOP of the zip, not in the session folder. Seth, 2026-09-11: "put the
 * How-To-OPEN instructions in the zip root. Rather than in the actual lameta session folder." Inside it,
 * lameta would list them as one of the session's files. */
export const LAMETA_ROOT_FILES = ['HOW-TO-OPEN.txt'];

/* The suite's own bookkeeping lives in a subfolder of the session (plans/lameta-device.md §3): the
 * immutable copy of the text's source manifest, and — written by the agent, never by a download —
 * the custody history. lameta ignores subfolders entirely, so nothing here is ever listed, exported
 * or given a .meta. */
export const LAMETA_SUITE_DIR = 'flextext';

/* The lameta paragraph of HOW-TO-OPEN.txt: unzip at the project root, and what to do when the
 * folder name is already taken. Appended by the panel to the generic text, so it lives beside the
 * format it explains. */
export function lametaHowToOpen(id) {
  const L = [];
  L.push('lameta — unzip this over your lameta project');
  L.push(`  The zip holds Sessions/${id}/, the folder lameta lists as one session. Unzip it at`);
  L.push('  the project root (the folder holding the .sprj file), then open the project in');
  L.push('  lameta — it reads a project when it opens, so reopen it if it was already open.');
  L.push(`  If Sessions/${id}/ already exists, rename this folder BEFORE unzipping, give the`);
  L.push(`  "${id}.session" file inside it the same new name, and change the <id> inside that`);
  L.push('  file to match: the folder name and the id must agree exactly, or lameta cannot');
  L.push('  read the session.');
  L.push(`  Sessions/${id}/${LAMETA_SUITE_DIR}/ belongs to the FlexText apps (the text’s manifest).`);
  L.push('  lameta never lists it; leave it in place.');
  L.push('');
  return L.join('\n');
}

/**
 * The complete folder for one text, as `{ name, data }` entries with paths relative to the lameta
 * PROJECT root — so a caller can zip them and the researcher unzips over their project.
 *
 * `files` is whatever the caller has already assembled for this text ({ name, data }), typically the
 * ELAN EAF, its .pfsx, the .flextext, the recording, and the derived WAV. ⚠ NAME THEM FROM
 * lametaSessionId(base) BEFORE BUILDING THEM: the EAF and the .flextext refer to the recording by name,
 * and a rename made here could not follow them inside. lametaFileName is applied again only as a net.
 *
 * `suiteFiles` go under `Sessions/<id>/flextext/` (LAMETA_SUITE_DIR) — no .meta, never listed.
 */
export function lametaSessionEntries(session = {}, files = [], suiteFiles = []) {
  const id = lametaSessionId(session.id || session.title);
  const dir = `Sessions/${id}/`;
  const root = [];
  const out = [{ name: `${dir}${id}.session`, data: lametaSessionXml({ ...session, id }) }];
  for (const f of files) {
    if (!f || !f.name) continue;
    if (LAMETA_ROOT_FILES.includes(f.name)) { root.push({ name: f.name, data: f.data }); continue; }
    const name = lametaFileName(f.name);
    out.push({ name: dir + name, data: f.data });
    out.push({ name: `${dir}${name}.meta`, data: lametaFileMetaXml() });
  }
  for (const f of suiteFiles || []) {
    if (!f || !f.name) continue;
    out.push({ name: `${dir}${LAMETA_SUITE_DIR}/${f.name}`, data: f.data });
  }
  return [...root, ...out];
}

/* ─── READING A SESSION lameta WROTE (the agent's Adopt, plans/lameta-device.md §6) ─────────────
 *
 * A tolerant, DOM-free read of the elements Adopt needs: the title and Status for the text, the
 * contributors for the manifest, the custom fields for the progress merge. Tags are matched by
 * name and the `type` attribute is ignored (lameta reads any form); entities are unescaped; a
 * contributor's <smxrole>unspecified</smxrole> reads back as no role, exactly as lameta's own
 * loader does. This READS. Nothing here rewrites a session lameta holds. */
const unesc = (s) => String(s == null ? '' : s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
const tagText = (xml, tag) => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
  return m ? unesc(m[1].trim()) : '';
};
export function parseLametaSession(xml) {
  const s = String(xml || '');
  const out = {
    id: tagText(s, 'id'), title: tagText(s, 'Title'), status: tagText(s, 'Status'), genre: tagText(s, 'Genre'),
    date: tagText(s, 'Date'), languages: tagText(s, 'languages'), workingLanguages: tagText(s, 'WorkingLanguages'),
    contributors: [], customFields: {},
  };
  const cb = /<Contributions(?:\s[^>]*)?>([\s\S]*?)<\/Contributions>/.exec(s);
  if (cb) {
    for (const m of cb[1].matchAll(/<contributor>([\s\S]*?)<\/contributor>/g)) {
      const c = m[1];
      const smx = tagText(c, 'smxrole');
      out.contributors.push({ name: tagText(c, 'name'), role: smx === 'unspecified' ? '' : (smx || tagText(c, 'role')), date: tagText(c, 'date') });
    }
  }
  const cf = /<CustomFields(?:\s[^>]*)?>([\s\S]*?)<\/CustomFields>/.exec(s);
  if (cf) for (const m of cf[1].matchAll(/<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) out.customFields[m[1]] = unesc(m[2].trim());
  out.done = out.status === 'Finished';
  return out;
}

/* ─── THE HISTORY FILE: custody and events, the agent's own record (plans/lameta-device.md §3) ──
 *
 * Custody is never in the manifest (plans/drive-as-truth.md §16.12): the manifest holds birth
 * facts and is immutable; this file holds who has the text NOW and how it got there. D1's
 * drive_object.instance_id is the authority; this is the local mirror the agent reconciles. */
export const LAMETA_HISTORY_NAME = 'flextext-history.json';
const MOVES = ['created', 'adopted', 'assigned', 'moved', 'checked_out', 'returned'];
export function newHistory({ docId, sessionId = '', holder = null, by = null, kind = 'adopted', now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  const to = holder || { kind: 'unassigned' };
  return { schema: 1, docId: String(docId || ''), sessionId, custody: { holder: to, since: at },
           events: [{ at, kind, to, ...(by ? { by } : {}) }] };
}
/** A new object with the event appended; a custody-changing kind also moves `custody`. */
export function withHistoryEvent(h, { kind, from = null, to = null, by = null, now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  const base = h && typeof h === 'object' ? h : { schema: 1, events: [] };
  const out = { ...base, events: [...(base.events || []), { at, kind, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(by ? { by } : {}) }] };
  if (to && MOVES.includes(kind)) out.custody = { holder: to, since: at };
  return out;
}
export function historyCustody(h) { return (h && h.custody && h.custody.holder) || { kind: 'unassigned' }; }

/* ─── ADOPT: which file is the recording, which the FLEx text ───────────────────────────────────
 * Root files of a session ([{ name, size }]). The primary recording is audio by lameta's own type
 * table, never our converted copy, never a consent clip, never a `.returned-<date>` twin; lossless
 * beats lossy; ONE clear winner is picked, and several in the top class are a choice a person makes
 * (name, size — the modal adds the duration). The FLEx text is the one `.flextext`; several are a
 * choice; none is an audio-only adopt. */
const LOSSLESS = ['wav', 'flac', 'aiff', 'aif', 'caf', 'au'];
const extOf = (n) => ((/\.([A-Za-z0-9]+)$/.exec(String(n || '')) || [])[1] || '').toLowerCase();
export function pickPrimaryRecording(files = []) {
  const audio = (files || []).filter((f) => f && lametaFileType(f.name) === 'audio')
    .filter((f) => !/\.converted-NOT-ARCHIVAL\./i.test(f.name) && !/^consent-/i.test(f.name) && !/\.returned-\d{4}-\d\d-\d\d/.test(f.name));
  if (!audio.length) return { pick: null, candidates: [] };
  const lossless = audio.filter((f) => LOSSLESS.includes(extOf(f.name)));
  const top = (lossless.length ? lossless : audio).slice().sort((a, b) => (b.size || 0) - (a.size || 0));
  return { pick: top.length === 1 ? top[0] : null, candidates: top };
}
export function pickFlextext(files = []) {
  const fts = (files || []).filter((f) => f && /\.flextext$/i.test(String(f.name || '')));
  return { pick: fts.length === 1 ? fts[0] : null, candidates: fts };
}
/** A mime for a recording by its extension, for the manifest and the upload (Drive wants one). */
export function audioMimeOf(name) {
  return ({ wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg',
            wma: 'audio/x-ms-wma', aiff: 'audio/aiff', aif: 'audio/aiff', au: 'audio/basic', amr: 'audio/amr', caf: 'audio/x-caf' })[extOf(name)]
    || 'application/octet-stream';
}
