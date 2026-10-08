/* THE LAMETA SESSION FOLDER — checked against REAL lameta files, not against a guess.
 *
 * Ground truth: Seth's own projects under ~/Documents/lameta/ and, since v690, lameta's own code
 * (the shipped 3.0.21-beta bundle and the upstream source). Until v690 the vocabularies came from
 * `lameta-editor/lameta_core.py`, whose lists were partial (seven of twenty-five roles) and whose
 * belief that lameta DROPS an unrecognised value was wrong: lameta keeps a value it has not seen
 * and registers it as an encountered one. Omission is still the rule — a field that looks answered
 * but was guessed is worse than a blank — but the reason is honesty, not loss.
 *
 * ⚠ THE FAILURE THAT IS STILL SILENT: a session whose folder name does not match its id is broken
 * in lameta (every directory under Sessions/ is a session, read from <dirname>.session), and a bad
 * export looks like a successful one until a researcher notices work missing from their corpus. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lametaSessionXml, lametaSessionId, lametaStatus, lametaFileMetaXml, lametaSessionEntries,
  LAMETA_STATUS, LAMETA_ROLES, LAMETA_GENRES, LAMETA_TYPES, LAMETA_SUITE_DIR, lametaFileType, lametaHowToOpen,
} from '../docs/js/lameta.js';

/* This is a REAL session file from Seth's project, copied verbatim. It is the shape to match. */
const REAL = `<?xml version="1.0" encoding="utf-8"?>
<Session minimum_lameta_version_to_read="0.0.0">
  <id type="string">narr_air_rifle_accident</id>
  <Title type="string">Air Rifle Accident</Title>
  <Genre type="string">narrative</Genre>
  <Status type="string">In_Progress</Status>
  <Contributions>
    <contributor>
      <name>Suhu, Yohanis</name>
      <role>author</role>
      <date>0001-01-01</date>
    </contributor>
  </Contributions>
</Session>`;

test('we reproduce a real lameta session file', () => {
  const xml = lametaSessionXml({
    id: 'narr_air_rifle_accident',
    title: 'Air Rifle Accident',
    genre: 'narrative',
    status: 'In_Progress',
    contributors: [{ name: 'Suhu, Yohanis', role: 'author' }],
  });
  assert.equal(xml.trim(), REAL.trim());
});

test('the declaration and root element match what lameta writes', () => {
  const xml = lametaSessionXml({ title: 'x' });
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>\n/);
  assert.match(xml, /<Session minimum_lameta_version_to_read="0\.0\.0">/);
  assert.match(xml, /<\/Session>\n$/);
});

/* ⚠ THE FOLDER NAME MUST EQUAL THE ID, or lameta never sees the session: it discovers sessions by
 * scanning Sessions/ for a directory containing <dirname>.session. The .sprj holds NO session list,
 * which is exactly what makes a drop-in folder work — and exactly what makes a mismatch invisible. */
test('the folder name and the id are the same string, always', () => {
  for (const title of ['Air Rifle Accident', "Suu's story", 'a/b\\c', '  padded  ', 'ünïcödé']) {
    const entries = lametaSessionEntries({ title });
    const sessionFile = entries.find((e) => e.name.endsWith('.session'));
    const m = sessionFile.name.match(/^Sessions\/([^/]+)\/([^/]+)\.session$/);
    assert.ok(m, `path shape for ${JSON.stringify(title)}: ${sessionFile.name}`);
    assert.equal(m[1], m[2], 'folder name equals the session file basename');
    assert.match(sessionFile.data, new RegExp(`<id type="string">${m[1]}</id>`),
      'and equals the id inside the file');
  }
});

/* lameta's own filename charset, from lameta_core.py's VALID. */
test('ids are restricted to the charset lameta itself uses', () => {
  assert.equal(lametaSessionId('Air Rifle Accident'), 'Air_Rifle_Accident');
  assert.equal(lametaSessionId("Suu's story"), 'Suu_s_story');
  assert.equal(lametaSessionId('a//b'), 'a_b', 'runs of illegal characters collapse');
  assert.equal(lametaSessionId('...trim...'), 'trim', 'no leading or trailing punctuation');
  assert.equal(lametaSessionId(''), 'session', 'and never empty — an empty folder name is unusable');
  assert.doesNotMatch(lametaSessionId('ünïcödé x'), /[^0-9a-zA-Z_.\-]/);
});

/* ⚠ A VALUE OUTSIDE THE VOCABULARY IS NEVER APPROXIMATED. lameta would keep it (it registers values it
 * has not seen), but a guessed genre or role reads as a fact about the recording. Omit, or write
 * what lameta itself writes for "not specified". */
test('values outside lameta vocabularies are omitted, never approximated', () => {
  const xml = lametaSessionXml({ title: 'x', genre: 'folk tale', status: 'nearly done' });
  assert.doesNotMatch(xml, /folk tale/, 'an invented genre does not travel');
  assert.doesNotMatch(xml, /<Genre/, 'it is omitted entirely rather than blanked');
  assert.match(xml, /<Status type="string">In_Progress<\/Status>/, 'a bad status falls back to a real one');

  /* lameta's own "no role" encoding, read from its bundle: the role element says participant and a
   * sibling <smxrole>unspecified</smxrole> tells lameta to read it back as no role at all. v665–v689
   * wrote `speaker` here — a guess presented as a fact. */
  const role = lametaSessionXml({ title: 'x', contributors: [{ name: 'A', role: 'glosser' }, { name: 'B', role: 'transcriber' }] });
  assert.match(role, /<name>A<\/name>\n\s*<role>participant<\/role>\n\s*<smxrole>unspecified<\/smxrole>\n\s*<date>0001-01-01<\/date>/,
    'an unknown role is written the way lameta writes an unspecified one');
  assert.match(role, /<name>B<\/name>\n\s*<role>transcriber<\/role>\n\s*<date>/, 'a known role has no smxrole');
  assert.doesNotMatch(role, /glosser|<role>speaker/, 'neither passed through nor guessed');

  for (const v of ['narrative', 'elicitation', 'conversation']) assert.ok(LAMETA_GENRES.includes(v));
  assert.deepEqual(LAMETA_STATUS, ['Incoming', 'In_Progress', 'Finished', 'Skipped']);
  // All twenty-five of lameta's roles (its locale/roles.csv), not lameta_core.py's seven.
  assert.equal(LAMETA_ROLES.length, 25);
  for (const r of ['annotator', 'consultant', 'depositor', 'interviewer', 'signer', 'singer', 'speaker', 'transcriber',
    'careful_speech_speaker', 'research_participant']) {
    assert.ok(LAMETA_ROLES.includes(r), r);
  }
});

test('done maps to Finished, and unfinished work to In_Progress', () => {
  assert.equal(lametaStatus(true), 'Finished');
  assert.equal(lametaStatus(false), 'In_Progress');
  assert.match(lametaSessionXml({ title: 'x', done: true }), /<Status type="string">Finished</);
  assert.match(lametaSessionXml({ title: 'x', done: false }), /<Status type="string">In_Progress</);
});

/* Empty fields must not be emitted: a researcher completes the rest in lameta, which is what lameta
 * is for, and an empty element reads as answered. */
test('unknown fields are left out for the researcher to fill in lameta', () => {
  const xml = lametaSessionXml({ title: 'Only a title' });
  assert.match(xml, /<Title type="string">Only a title<\/Title>/);
  for (const f of ['Description', 'Location', 'Access', 'Keywords', 'Topic', 'Date', 'Genre']) {
    assert.doesNotMatch(xml, new RegExp(`<${f}`), `${f} is omitted, not blank`);
  }
});

test('the vernacular and analysis languages land in the right fields, typed as lameta types them', () => {
  const xml = lametaSessionXml({ title: 'x', vernLang: 'fau', analLang: 'id' });
  /* lameta's own type attributes (its writer, read from the bundle): the subject languages are a
   * languageChoices field, the working language a string. It reads either; writing its own keeps a
   * session it re-saves identical to the one we wrote. */
  assert.match(xml, /<languages type="languageChoices">fau<\/languages>/, 'subject language = vernacular');
  assert.match(xml, /<WorkingLanguages type="string">id<\/WorkingLanguages>/, 'working = analysis');
});

test('a date is a bare element, as lameta writes dates', () => {
  const xml = lametaSessionXml({ title: 'x', date: '2026-09-27' });
  assert.match(xml, /\n  <Date>2026-09-27<\/Date>\n/, 'no type attribute on a date');
});

/* The suite's own files ride in a SUBFOLDER of the session — lameta ignores subfolders, so they are
 * never listed, exported, or given a .meta (plans/lameta-device.md §3). */
test('suite files go under flextext/ with no .meta, and HOW-TO-OPEN explains the folder', () => {
  const entries = lametaSessionEntries({ id: 'narr_x', title: 'X' }, [{ name: 'narr_x.wav', data: 'W' }],
    [{ name: 'flextext-manifest.json', data: '{}' }]);
  const names = entries.map((e) => e.name);
  assert.equal(LAMETA_SUITE_DIR, 'flextext');
  assert.ok(names.includes('Sessions/narr_x/flextext/flextext-manifest.json'));
  assert.ok(!names.some((n) => n.startsWith('Sessions/narr_x/flextext/') && n.endsWith('.meta')), 'no sidecar in the subfolder');
  assert.deepEqual(names.filter((n) => !n.includes('/flextext/')),
    ['Sessions/narr_x/narr_x.session', 'Sessions/narr_x/narr_x.wav', 'Sessions/narr_x/narr_x.wav.meta'], 'the rest is unchanged');
  const how = lametaHowToOpen('narr_x');
  assert.match(how, /Sessions\/narr_x\/, the folder lameta lists as one session/);
  assert.match(how, /rename this folder BEFORE unzipping/, 'the rule for a taken id');
  assert.match(how, /the folder name and the id must agree exactly/);
  assert.match(how, /Sessions\/narr_x\/flextext\/ belongs to the FlexText apps/);
});

test('XML special characters in a title cannot break the file', () => {
  const xml = lametaSessionXml({ title: 'Suu & <the> "raid"' });
  assert.match(xml, /Suu &amp; &lt;the&gt; &quot;raid&quot;/);
  assert.doesNotMatch(xml.replace(/&[a-z]+;/g, ''), /[<>]the/);
});

test('every file gets the .meta sidecar lameta keeps beside it', () => {
  const entries = lametaSessionEntries(
    { id: 'narr_x', title: 'X' },
    [{ name: 'narr_x.eaf', data: 'E' }, { name: 'narr_x.wav', data: 'W' }],
  );
  const names = entries.map((e) => e.name);
  assert.deepEqual(names, [
    'Sessions/narr_x/narr_x.session',
    'Sessions/narr_x/narr_x.eaf', 'Sessions/narr_x/narr_x.eaf.meta',
    'Sessions/narr_x/narr_x.wav', 'Sessions/narr_x/narr_x.wav.meta',
  ]);
  assert.match(lametaFileMetaXml(), /^<\?xml version="1\.0" encoding="utf-8"\?>\n<Meta minimum_lameta_version_to_read="0\.0\.0">/);
});

/* ⚠ THE SAYMORE PROFILE MUST NOT APPEAR HERE. lameta has no annotation editor — it opens ELAN — so
 * the two-tier SayMore file would be a strict downgrade in the tool the researcher lands in, and
 * SayMore's `<media>.annotations.eaf` name is the slot SayMore itself rewrote. */
test('lameta types our files: ELAN, FLEx and audio — and .fxpa is NOT a lameta type', () => {
  assert.equal(lametaFileType('x.eaf'), 'elan'); assert.equal(lametaFileType('x.pfsx'), 'elan');
  assert.equal(lametaFileType('x.flextext'), 'flex');
  assert.equal(lametaFileType('x.wav'), 'audio'); assert.equal(lametaFileType('x.M4A'), 'audio');
  assert.equal(lametaFileType('x.fxpa'), '', 'the old header claimed lameta knew .fxpa; it does not');
  assert.equal(lametaFileType('x.flextext.meta'), '', 'a sidecar is not a typed file');
  assert.ok(LAMETA_TYPES.flex.includes('fwdata') && LAMETA_TYPES.video.includes('mp4'));
  const src = readFileSync(new URL('../docs/js/lameta.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /annotations\.eaf/,
    'nothing here emits the SayMore-managed filename');
});
import { readFileSync } from 'node:fs';

/* ─── THE PANEL BUTTON ────────────────────────────────────────────────────────
 * One more download kind beside ELAN and SayMore, asking for the same annotation payload and
 * wrapping it in a session folder. */
const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');

test('the panel offers a lameta session folder, and asks for the ELAN payload', () => {
  assert.match(PANEL, /conv\('lameta', 'lametaZip', true\)/, 'the menu row exists');
  assert.match(PANEL, /lameta: \{ eaf: true \}/,
    'it asks for the complete six-tier EAF, exactly what ELAN asks for');
  /* ⚠ NEVER the SayMore profile: lameta has no annotation editor and just opens ELAN, so the
   * two-tier file would be a downgrade in the tool the researcher lands in. */
  const branch = PANEL.slice(PANEL.indexOf("if (kind === 'lameta') {"),
                             PANEL.indexOf("} else if (kind === 'elan' || kind === 'saymore') {"));
  assert.doesNotMatch(branch, /saymore/, 'the SayMore profile does not appear in this package');
  assert.match(branch, /lametaSessionEntries\(/, 'entries go through the session-folder writer');
  assert.match(branch, /saveBlobAs\(await makeZip\(sessionEntries\)/, 'and are zipped');
});

test('the package carries the recording and the .flextext beside the annotation', () => {
  const branch = PANEL.slice(PANEL.indexOf("if (kind === 'lameta') {"),
                             PANEL.indexOf("} else if (kind === 'elan' || kind === 'saymore') {"));
  assert.match(branch, /src\.media && src\.media\.blob/, 'the original recording rides along');
  /* ⚠ THE .flextext IS THE FETCHED XML, NOT A RE-SERIALIZATION. #71 required it to come from the
   * same doc state as the EAF so the package cannot hold two annotations that disagree. The EAF was
   * built from parseFlextext(src.xml) in this same operation, so shipping src.xml satisfies that AND
   * avoids round-trip loss through our own parser. */
  // v711: the fetched XML minus an older device's empty timed lines (stripSilentPhrasesXml), then its media reference.
  assert.match(branch, /entries\.push\(\{ name: pkgBase \+ '\.flextext', data: new Blob\(\[lametaFlextextMedia\(stripSilentPhrasesXml\(src\.xml\), src\.segMedia \? src\.segMedia\.name : ''\)\]/,
    'the .flextext is the same XML the EAF was parsed from, with only its media reference repointed');
  assert.doesNotMatch(branch, /serializeFlextext/, 'not re-serialized — no round-trip loss');
});

test('only fields we actually know are written; the rest are left for lameta', () => {
  const branch = PANEL.slice(PANEL.indexOf("if (kind === 'lameta') {"),
                             PANEL.indexOf("} else if (kind === 'elan' || kind === 'saymore') {"));
  // `title` is a shorthand property, the rest are explicit — accept either form.
  for (const f of ['title', 'done', 'vernLang', 'analLang']) {
    assert.match(branch, new RegExp('\\b' + f + '\\s*[:,]'), `${f} is supplied`);
  }
  for (const f of ['genre', 'location', 'access', 'keywords']) {
    assert.doesNotMatch(branch, new RegExp('\\b' + f + ':', 'i'),
      `${f} is NOT invented — the researcher chooses it from lameta's own list`);
  }
});

/* v690: the session carries what the suite can DERIVE — stages, the consent receipt's signer, the
 * text's ids — and the manifest copy under flextext/, where lameta never looks. */
test('the panel derives stages, names the receipt signer, and packs the manifest copy', () => {
  const branch = PANEL.slice(PANEL.indexOf("if (kind === 'lameta') {"),
                             PANEL.indexOf("} else if (kind === 'elan' || kind === 'saymore') {"));
  assert.match(branch, /deriveStages\(\{ doc: src\.doc, manifest, files, analLang: src\.anal \|\| '' \}\)/,
    'stages from the doc, the manifest and the folder');
  assert.match(branch, /receipt\.signatureName/, 'the receipt names the speaker');
  assert.match(branch, /role: 'speaker'/, '...as a speaker, a role lameta has');
  assert.match(branch, /suiteFiles\.push\(\{ name: MANIFEST_NAME/, 'the manifest copy');
  assert.match(branch, /lametaSessionEntries\(\{[\s\S]*?\}, entries, suiteFiles\)/, 'goes in through the writer, under flextext/');
  assert.match(branch, /lametaHowToOpen\(pkgBase\)/, 'HOW-TO-OPEN gains the lameta paragraph');
  assert.match(branch, /const flexGuid = flextextTextGuid\(src\.xml\)/, 'the FLEx guid as the FILE carries it, never a minted one');
  assert.match(branch, /engine: ENGINE_VERSION/);
  assert.doesNotMatch(branch, /flextext-history/, 'a download records no custody: the text still lives where it lives');
});

/* ⚠ THE DONE DEFECT (v665–v689). The lameta branch read `wrap.dataset.done`, and nothing ever wrote
 * it: filesMenuHtml had no `done` argument and the modal copied no such attribute, so every session
 * shipped In_Progress whatever the coworker had marked. Seth verified format, not Status. */
test('the Done mark reaches the lameta branch: rendered by the rows, copied by the modal', () => {
  assert.match(PANEL, /function filesMenuHtml\(instanceId, docId, title, audioUrl, fileId, viaMember, done\)/);
  assert.match(PANEL, /\$\{done \? ' data-done="1"' : ''\}/, 'the row writes it');
  const modal = (PANEL.match(/function openFilesModal\(rowWrap\) \{[\s\S]*?\n\}/) || [''])[0];
  assert.match(modal, /rowWrap\.dataset\.done \? ' data-done="1"' : ''/, 'the modal copies it');
  assert.match(PANEL, /filesMenuHtml\(it\.instance_id, d\.id, d\.title \|\| '', '', '', !!memberCtx, !!d\.done\)/, "a device's text row passes it");
  assert.ok((PANEL.match(/filesMenuHtml\([^)]*!!tx\.done\)/g) || []).length >= 2, 'so do the estate rows');
  assert.match(PANEL, /done: wrap\.dataset\.done === '1' \|\| wrap\.dataset\.done === 'true'/, 'and the branch reads it');
});

test('both menu labels exist in English and Indonesian', () => {
  const i18n = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
  for (const k of ['panel.dl.lametaZip', 'panel.dl.lametaZipSub']) {
    assert.equal((i18n.match(new RegExp(`'${k}':`, 'g')) || []).length, 2, `${k} needs EN and ID`);
  }
  // The sub-line has to say what to DO with it — unzipping over the project is the whole trick.
  const en = i18n.match(/'panel\.dl\.lametaZipSub': '([^']*(?:\\'[^']*)*)'/)[1];
  assert.match(en, /Unzip over your lameta project/i, 'it says how to use it');
});

/* ⚠⚠ THE SEAM THAT WAS NEVER TESTED, AND THE ONE THAT BROKE. Seth, 2026-09-10, from the staging
 * Researcher panel: the lameta download "just says failed", with
 *
 *     TypeError: entry.data.arrayBuffer is not a function
 *         makeZip .../js/zip.js:81
 *         runMenuConversion .../js/researcher-panel.js:3881
 *
 * lametaSessionEntries builds the .session file and every .meta sidecar as XML STRINGS — deliberately,
 * because lameta.js is a pure format module and returning text is what keeps it testable in node —
 * and makeZip accepted only a Uint8Array or a Blob. FOUR of the five entries in a typical session are
 * strings, the .session file among them, so it threw on the FIRST entry: the panel button never
 * worked from the day it shipped.
 *
 * ⚠ AND EVERY EXISTING TEST PASSED. The 19 above exercise the format module alone; the panel tests
 * read researcher-panel.js as source text. Both halves were correct and did not fit together, which
 * is invisible to any test that does not RUN one into the other. Hence this: build real entries and
 * put them through the real zip writer, then read the archive back.
 *
 * Seth's format verification was real but came from a different producer — "your coworker session
 * produced a whole bunch of them today in bulk and they work fine" — so the panel path was confirmed
 * by nothing. */
test('lameta session entries actually go through the real zip writer', async () => {
  const { makeZip } = await import('../docs/js/zip.js');
  const entries = lametaSessionEntries(
    { id: 'Fayu_001', title: 'Kaisou fedahu', done: true, vernLang: 'fau', analLang: 'id' },
    [{ name: 'Fayu_001.flextext', data: '<document/>' },
     { name: 'Fayu_001.wav', data: new Uint8Array([1, 2, 3, 4]) }]);

  // the pre-condition that made this a bug: most entries ARE strings, and that is intended
  assert.ok(entries.filter((e) => typeof e.data === 'string').length >= 3,
    'the format module returns text, which is what keeps it node-pure');

  const zip = await makeZip(entries);          // this threw before the fix
  const buf = new Uint8Array(await zip.arrayBuffer());

  // read the local file headers back, so this asserts a real archive and not just "no throw"
  const dv = new DataView(buf.buffer);
  const found = [];
  let i = 0;
  while (i < buf.length - 4 && dv.getUint32(i, true) === 0x04034b50) {
    const nlen = dv.getUint16(i + 26, true);
    const elen = dv.getUint16(i + 28, true);
    const clen = dv.getUint32(i + 18, true);
    found.push({
      name: new TextDecoder().decode(buf.subarray(i + 30, i + 30 + nlen)),
      bytes: clen,
      body: new TextDecoder().decode(buf.subarray(i + 30 + nlen + elen, i + 30 + nlen + elen + clen)),
    });
    i += 30 + nlen + elen + clen;
  }

  const names = found.map((f) => f.name);
  assert.deepEqual(names, [
    'Sessions/Fayu_001/Fayu_001.session',
    'Sessions/Fayu_001/Fayu_001.flextext',
    'Sessions/Fayu_001/Fayu_001.flextext.meta',
    'Sessions/Fayu_001/Fayu_001.wav',
    'Sessions/Fayu_001/Fayu_001.wav.meta',
  ], 'every file lameta expects, under Sessions/<id>/');

  // the text entries survived the UTF-8 encoding as real XML, not as "[object Object]" or empty
  const session = found.find((f) => f.name.endsWith('.session'));
  assert.match(session.body, /^<\?xml/, 'the .session file is XML');
  assert.match(session.body, /Fayu_001|Kaisou fedahu/, 'and carries the session it describes');
  assert.ok(session.bytes > 100, 'and is not empty');
  for (const m of found.filter((f) => f.name.endsWith('.meta')))
    assert.match(m.body, /minimum_lameta_version_to_read/, `${m.name} is a real sidecar`);
  // and the binary entry is untouched
  assert.equal(found.find((f) => f.name.endsWith('.wav')).bytes, 4);
});

test('the zip writer takes text as well as bytes and blobs, so no caller can repeat this', async () => {
  const { makeZip } = await import('../docs/js/zip.js');
  const zip = await makeZip([
    { name: 'a.txt', data: 'plain text' },
    { name: 'b.bin', data: new Uint8Array([9, 9]) },
    { name: 'c.txt', data: new Blob(['from a blob']) },
  ]);
  const buf = new Uint8Array(await zip.arrayBuffer());
  const dv = new DataView(buf.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50, 'a real archive');
  const text = new TextDecoder().decode(buf);
  for (const expect of ['plain text', 'from a blob'])
    assert.ok(text.includes(expect), `${expect} is in the archive`);
  // ⚠ non-ASCII must round-trip as UTF-8, since session titles and Fayu text are not ASCII
  const zip2 = await makeZip([{ name: 'é.txt', data: 'kaisou fedahu — mémé ʔ' }]);
  const text2 = new TextDecoder().decode(new Uint8Array(await zip2.arrayBuffer()));
  assert.ok(text2.includes('kaisou fedahu — mémé ʔ'), 'UTF-8 text survives');
});
