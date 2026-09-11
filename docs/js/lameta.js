/* lameta.js — the lameta SESSION FOLDER writer.
 *
 * ONE TEXT → ONE FOLDER a researcher drops straight into a lameta project. Seth, 2026-09-10:
 * "I've got texts coming that I need to move from Researcher panel into my organized text corpus.
 * And I want to make that easier."
 *
 * ⚠ THE FORMAT HERE IS READ FROM REAL FILES, NOT INFERRED. Verified against Seth's own project at
 * ~/Documents/lameta/Fayu-restructure-plan/ and against the working tool from the corpus
 * restructuring session (`lameta-editor/lameta_core.py`), which edits lameta projects on disk. Every
 * vocabulary below is copied from that tool's VOCAB, not guessed.
 *
 * ⚠ SESSIONS ARE DISCOVERED, NOT REGISTERED — which is what makes a drop-in folder work at all. The
 * `.sprj` project file carries only project-level settings (archive configuration, project name,
 * languages, guid); it holds NO session list. lameta finds a session by scanning `Sessions/` for a
 * directory containing `<dirname>.session`. So:
 *
 *     Sessions/<id>/<id>.session          ⚠ the folder name MUST equal the id, or it is invisible
 *
 * ⚠ ELAN EAF, NEVER THE SAYMORE PROFILE. Seth: "Lameta doesn't have a built in eaf/annotation editor
 * like SayMore does. It just opens ELAN." SayMore MANAGED annotation files — it rewrote
 * `<media>.annotations.eaf`, which is why our SayMore profile is deliberately two tiers. lameta
 * delegates to ELAN, so the complete six-tier hierarchy survives and is what a researcher actually
 * wants on the other side. `.pfsx` rides along because ELAN reads tier display order from it, and a
 * researcher arriving from lameta lands directly in ELAN.
 *
 * ⚠ AND lameta ALREADY RECOGNISES OUR FORMATS. Its annotation extension set is
 * {.eaf, .pfsx, .flextext, .fxpa} — so the `.flextext` is not a foreign body in the folder, it is a
 * first-class annotation file there. That is why it belongs in the package rather than beside it.
 *
 * Kept PURE — plain data in, plain data out, no DOM, no storage, no i18n, no zip — for the same
 * reason artifacts.js and history.js are: the panel builds these today and the Corpus Manager will
 * later, and it must be runnable under node so the format can be tested without a browser.
 */

/* Copied from lameta_core.py's VOCAB. ⚠ lameta DROPS an unrecognised value rather than complaining,
 * so anything not in these lists must be omitted, never approximated. */
export const LAMETA_STATUS = ['Incoming', 'In_Progress', 'Finished', 'Skipped'];
export const LAMETA_ROLES = ['author', 'speaker', 'transcriber', 'translator', 'researcher',
  'participant', 'recorder'];
export const LAMETA_GENRES = ['', 'narrative', 'description', 'oratory', 'procedural_discourse',
  'procedural_text', 'singing', 'stimuli', 'conversation', 'elicitation', 'formulaic_discourse',
  'ludic', 'report', 'interactive_discourse', 'language_play', 'unintelligible_speech'];

/* Field order, from lameta_core.py's SESSION_ORDER. Emitting in a different order is not fatal, but
 * matching it keeps our files diff-clean against ones lameta itself has written. */
const SESSION_ORDER = ['id', 'Title', 'Description', 'languages', 'WorkingLanguages', 'Genre',
  'Sub-Genre', 'Status', 'Date', 'Location', 'Location_Region', 'Location_Country',
  'Location_Continent', 'Access', 'AccessExplanation', 'Keywords', 'Topic'];

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/* ⚠ lameta's own filename charset, from lameta_core.py's VALID. The folder name and the id must
 * agree exactly, so both go through this — a title with a space or an apostrophe would otherwise
 * produce a folder lameta cannot match to its own session file. */
export function lametaSessionId(base) {
  const cleaned = String(base || '')
    .replace(/[^0-9a-zA-Z_.\-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return cleaned || 'session';
}

/* ⚠ lameta'S FILE NAMING RULE, NOT ONLY ITS ID RULE. Seth, 2026-09-11, from lameta 3.0.21-beta: every
 * file of an imported session showed a red ! and "This file does not comply with the file naming rules
 * of the current archive" ("Tautua Do.eaf", "Tautua Do.wav" and the rest) while the id and the folder
 * were already "Tautua_Do". His projects use the REAP archive configuration, whose fileNameRules is
 * "ASCII". Read from lameta's own bundle, that rule folds accents, turns whitespace into "_", turns
 * anything outside 0-9 a-z A-Z _ . - into "_", and trims "_" from both ends; a name complies when the
 * rule leaves it unchanged. This returns names the rule leaves unchanged, and returns a name that
 * already complies exactly as it was. */
export function lametaFileName(name) {
  const s = String(name == null ? '' : name).trim();
  const dot = s.lastIndexOf('.');
  const hasExt = dot > 0 && dot < s.length - 1;
  const clean = (part) => part.replace(/\s+/g, '_').replace(/[^0-9a-zA-Z_.\-]/g, '_')
    .replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  const stem = clean(hasExt ? s.slice(0, dot) : s) || 'file';
  const ext = hasExt ? clean(s.slice(dot + 1)) : '';
  return ext ? `${stem}.${ext}` : stem;
}

/* A .flextext names its recording in <media-files><media location="…"/>. The package renames the
 * recording, so that one attribute has to follow it or FLEx looks for a file that is not there (Seth:
 * "Also, update the flextext file's media reference"). ONLY that attribute changes: the rest of the
 * fetched XML ships byte for byte, which is why the package carries it rather than a re-serialization.
 * A bare file name, because the recording travels in the same folder as the .flextext. */
export function lametaFlextextMedia(xml, mediaName) {
  if (!xml || !mediaName) return xml;
  return String(xml).replace(/<media(?=[\s/>])[^>]*>/g,
    (tag) => tag.replace(/(\slocation=)(["'])[^"']*\2/, (m, attr, q) => `${attr}${q}${esc(mediaName)}${q}`));
}

/** `Finished` once the coworker has marked the text done; otherwise it is still being worked on. */
export function lametaStatus(done) { return done ? 'Finished' : 'In_Progress'; }

/**
 * The `<id>.session` XML.
 *
 * ⚠ EMPTY FIELDS ARE OMITTED, NOT EMITTED BLANK. A researcher fills the rest in lameta, which is
 * what lameta is for; writing empty elements would leave them looking answered.
 */
export function lametaSessionXml(s = {}) {
  const id = lametaSessionId(s.id || s.title);
  const vals = {
    id,
    Title: s.title || '',
    Description: s.description || '',
    languages: s.vernLang || '',                 // subject language(s) — the vernacular
    WorkingLanguages: s.analLang || '',          // the analysis language
    Genre: LAMETA_GENRES.includes(s.genre) ? s.genre : '',
    Status: LAMETA_STATUS.includes(s.status) ? s.status : lametaStatus(s.done),
    Date: s.date || '',
  };
  const lines = ['<?xml version="1.0" encoding="utf-8"?>',
    '<Session minimum_lameta_version_to_read="0.0.0">'];
  for (const k of SESSION_ORDER) {
    const v = vals[k];
    if (v === undefined || v === '') continue;
    lines.push(`  <${k} type="string">${esc(v)}</${k}>`);
  }
  /* Contributions is a nested element, not a field — shape taken from a real .session file:
   *   <Contributions><contributor><name/><role/><date/></contributor></Contributions> */
  const people = (s.contributors || []).filter((c) => c && c.name);
  if (people.length) {
    lines.push('  <Contributions>');
    for (const c of people) {
      const role = LAMETA_ROLES.includes(c.role) ? c.role : 'speaker';
      lines.push('    <contributor>');
      lines.push(`      <name>${esc(c.name)}</name>`);
      lines.push(`      <role>${role}</role>`);
      // ⚠ lameta writes 0001-01-01 for "no date" rather than an empty element — matched here so our
      // files look like its own.
      lines.push(`      <date>${esc(c.date || '0001-01-01')}</date>`);
      lines.push('    </contributor>');
    }
    lines.push('  </Contributions>');
  } else {
    lines.push('  <Contributions></Contributions>');
  }
  lines.push('</Session>');
  return lines.join('\n') + '\n';
}

/* The per-file sidecar lameta keeps beside each media/annotation file, byte-for-byte from
 * lameta_core.py's META_STUB. lameta will create these itself if absent, but the restructuring tool
 * writes them, so writing them costs nothing and matches a project lameta has already touched. */
export function lametaFileMetaXml() {
  return '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<Meta minimum_lameta_version_to_read="0.0.0">\n'
    + '  <Contributions></Contributions>\n</Meta>';
}

/* Which extensions lameta treats as annotations, from lameta_core.py's ANN. Kept so a caller can
 * tell whether a file it is about to add will be understood or merely carried. */
export const LAMETA_ANNOTATION_EXT = ['.eaf', '.pfsx', '.flextext', '.fxpa'];

/* The instructions sit at the TOP of the zip, not in the session folder. Seth, 2026-09-11: "put the
 * How-To-OPEN instructions in the zip root. Rather than in the actual lameta session folder." Inside it,
 * lameta would list them as one of the session's files. */
export const LAMETA_ROOT_FILES = ['HOW-TO-OPEN.txt'];

/**
 * The complete folder for one text, as `{ name, data }` entries with paths relative to the lameta
 * PROJECT root — so a caller can zip them and the researcher unzips over their project.
 *
 * `files` is whatever the caller has already assembled for this text ({ name, data }), typically the
 * ELAN EAF, its .pfsx, the .flextext, the recording, and the derived WAV. ⚠ NAME THEM FROM
 * lametaSessionId(base) BEFORE BUILDING THEM: the EAF and the .flextext refer to the recording by name,
 * and a rename made here could not follow them inside. lametaFileName is applied again only as a net.
 */
export function lametaSessionEntries(session = {}, files = []) {
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
  return [...root, ...out];
}
