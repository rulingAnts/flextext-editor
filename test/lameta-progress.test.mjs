/* THE PROGRESS FIELDS — plans/lameta-progress-spec.md, as the suite writes them into a lameta session.
 *
 * Seth, lameta issue #74: lameta's checklist stops at recording and archiving; he wants "transcription,
 * glossing, free translation, morpheme analysis, text charting, etc" tracked per session, customizable.
 * The spec is shared with the lameta pull request, corpus-keeper and the corpus checklist, so what is
 * pinned here is a CONTRACT: keys, values, the Status rule, the merge that never lowers, and the
 * version number the plan file carries. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LAMETA_PROGRESS_SPEC, DEFAULT_STEPS, DEFAULT_STATUS_PICKS, defaultProgressSteps, validStepId, stageKey,
  stageLang, normStage, textProgress, deriveStages, lametaStatusFor, mergeStages, lametaSuiteStamp,
  lametaCustomFieldsXml, lametaSessionXml, FX_DONE_BAR,
} from '../docs/js/lameta.js';

test('the spec version in the code is the one the plan file declares', () => {
  const plan = readFileSync(new URL('../plans/lameta-progress-spec.md', import.meta.url), 'utf8');
  const m = plan.match(/\*\*Spec version: (\d+)\*\*/);
  assert.ok(m, 'the plan states its version');
  assert.equal(LAMETA_PROGRESS_SPEC, Number(m[1]), 'bump both together');
});

test("the default steps are the corpus checklist's fourteen, ids verbatim, every one a valid id", () => {
  assert.deepEqual(DEFAULT_STEPS.map((s) => s.id), ['consent', 'metadata', 'record', 'segment', 'transcribe',
    'gloss-lwc', 'ft-lwc', 'flex', 'gloss-en', 'ft-en', 'morph', 'tagging', 'charting', 'para']);
  assert.equal(new Set(DEFAULT_STEPS.map((s) => s.id)).size, 14, 'unique');
  for (const s of DEFAULT_STEPS) { assert.ok(validStepId(s.id), s.id); assert.ok(s.label, `${s.id} has a label`); }
  const file = defaultProgressSteps();
  assert.equal(file.version, LAMETA_PROGRESS_SPEC);
  assert.deepEqual(file.status, { inProgressAfter: 'record', finishedAfter: 'archive-submitted' });
  assert.notEqual(file.steps, DEFAULT_STEPS, 'a fresh copy, so an editor cannot mutate the defaults');
});

/* ⚠ lameta force-parses any XML tag whose name contains `date` as a date and REPLACES its text. */
test('a step id is lower-case, short, and never contains "date"', () => {
  for (const bad of ['Consent', 'update-date', 'dated', '1st', 'a b', '', 'x'.repeat(33), 'gloss.en']) {
    assert.ok(!validStepId(bad), `${JSON.stringify(bad)} refused`);
  }
  for (const good of ['a', 'gloss-fr', 'archive-submitted', 'x_y', 'x'.repeat(32)]) assert.ok(validStepId(good), good);
});

test('the custom-field key: Stage_ plus the id with each part capitalized', () => {
  const keys = {
    consent: 'Stage_Consent', metadata: 'Stage_Metadata', record: 'Stage_Record', segment: 'Stage_Segment',
    transcribe: 'Stage_Transcribe', 'gloss-lwc': 'Stage_Gloss_Lwc', 'ft-lwc': 'Stage_Ft_Lwc', flex: 'Stage_Flex',
    'gloss-en': 'Stage_Gloss_En', 'ft-en': 'Stage_Ft_En', morph: 'Stage_Morph', tagging: 'Stage_Tagging',
    charting: 'Stage_Charting', para: 'Stage_Para', 'gloss-fr': 'Stage_Gloss_Fr', 'archive-submitted': 'Stage_Archive_Submitted',
    ft_en: 'Stage_Ft_En',
  };
  for (const [id, key] of Object.entries(keys)) {
    assert.equal(stageKey(id), key);
    assert.match(key, /^[A-Za-z_][A-Za-z0-9_]*$/, 'a valid XML name');
    assert.doesNotMatch(key, /date/i);
  }
});

test('the language suffix: English is En, the analysis language is Lwc, anything else its code', () => {
  assert.equal(stageLang('en', 'id'), 'En');
  assert.equal(stageLang('eng', 'id'), 'En');
  assert.equal(stageLang('id', 'id'), 'Lwc');
  assert.equal(stageLang('fr', 'id'), 'Fr');
  assert.equal(stageLang('pt-BR', 'id'), 'Pt_Br');
  assert.equal(stageLang('en', 'en'), 'En', 'an English-analysis project has no LWC');
  assert.equal(stageLang('', 'id'), 'Und');
});

test('stored values are read generously and written canonically', () => {
  for (const v of ['done', 'Done', ' DONE ']) assert.equal(normStage(v), 'done');
  for (const v of ['in_progress', 'in-progress', 'In Progress']) assert.equal(normStage(v), 'in_progress');
  assert.equal(normStage(''), '', 'absent');
  assert.equal(normStage(undefined), '');
  assert.equal(normStage('blocked'), null, 'an unknown value is someone else\'s: null, never rewritten');
});

/* A doc built by hand in the engine's own shape, so the counts can be exact. */
const mkDoc = ({ lines = 20, text = true, glossed = 0, freed = 0, timed = 0, analLang = 'id' } = {}) => {
  const paragraphs = [];
  for (let i = 0; i < lines; i++) {
    const words = text ? [{ txt: 'kata' }, { txt: 'satu' }, { txt: '.', punct: true }] : [];
    if (i < glossed) for (const w of words) if (!w.punct) w.gls = 'g';
    const seg = { baseline: text ? 'kata satu.' : '', words, attrs: {} };
    if (i < freed) seg.free = 'a free translation';
    if (i < timed) { seg.attrs['begin-time-offset'] = String(i * 1000); seg.attrs['end-time-offset'] = String(i * 1000 + 900); }
    paragraphs.push({ segments: [seg] });
  }
  return { analLang, vernLang: 'fau', paragraphs };
};

test('textProgress counts lines, phrases, words, transcription, alignment and each language layer', () => {
  const p = textProgress(mkDoc({ glossed: 5, freed: 7, timed: 3 }));
  assert.equal(p.lines, 20); assert.equal(p.phrases, 20); assert.equal(p.words, 40, 'punctuation is not a word');
  assert.equal(p.transcribed, 20); assert.equal(p.aligned, 3);
  assert.deepEqual(p.gloss, { id: { n: 10, total: 40 } });
  assert.deepEqual(p.free, { id: { n: 7, total: 20 } });
  const empty = textProgress(mkDoc({ text: false }));
  assert.equal(empty.transcribed, 0); assert.equal(empty.words, 0); assert.deepEqual(empty.gloss, { id: { n: 0, total: 0 } });
});

test('deriveStages: nothing begun is nothing written; the 95% bar; in_progress below it', () => {
  assert.equal(FX_DONE_BAR, 0.95, "the checklist's bar");
  assert.deepEqual(deriveStages({ doc: mkDoc({ text: false }) }), {}, 'no audio, no consent, no text: no fields');
  assert.deepEqual(deriveStages({ doc: mkDoc({}) }), { Stage_Transcribe: 'done' }, 'text alone is a transcription');
  assert.equal(deriveStages({ doc: mkDoc({ glossed: 10 }) }).Stage_Gloss_Lwc, 'in_progress', '50% glossed');
  assert.equal(deriveStages({ doc: mkDoc({ glossed: 18 }) }).Stage_Gloss_Lwc, 'in_progress', '90%: not yet');
  assert.equal(deriveStages({ doc: mkDoc({ glossed: 19 }) }).Stage_Gloss_Lwc, 'done', '95%: done');
  assert.equal(deriveStages({ doc: mkDoc({ freed: 18 }) }).Stage_Ft_Lwc, 'in_progress');
  assert.equal(deriveStages({ doc: mkDoc({ freed: 19 }) }).Stage_Ft_Lwc, 'done');
  assert.equal(deriveStages({ doc: mkDoc({ timed: 1 }) }).Stage_Segment, 'in_progress');
  assert.equal(deriveStages({ doc: mkDoc({ timed: 20 }) }).Stage_Segment, 'done');
  assert.equal(deriveStages({ doc: mkDoc({ freed: 20, analLang: 'en' }) }).Stage_Ft_En, 'done', 'an English project writes En');
  assert.equal(deriveStages({ doc: mkDoc({ freed: 20 }), analLang: 'fr' }).Stage_Ft_Lwc, 'done',
    'the CALLER\'s analysis language decides the suffix (the manifest\'s codes, not the file\'s)');
  const none = deriveStages({ doc: mkDoc({ glossed: 5 }) });
  for (const k of ['Stage_Metadata', 'Stage_Flex', 'Stage_Morph', 'Stage_Tagging', 'Stage_Charting', 'Stage_Para', 'Stage_Archive_Submitted']) {
    assert.ok(!(k in none), `${k} is a person's to set, never derived`);
  }
});

test('deriveStages: consent and recording come from the manifest and the folder, not the text', () => {
  assert.equal(deriveStages({ manifest: { consent: { response: true } } }).Stage_Consent, 'done');
  assert.equal(deriveStages({ manifest: { consent: { receipt: true } } }).Stage_Consent, 'done');
  assert.ok(!deriveStages({ manifest: { consent: { prompt: true } } }).Stage_Consent, 'a spoken prompt alone is not consent');
  assert.ok(!deriveStages({ files: [{ name: 'consent-prompt.m4a', role: 'consent-prompt' }] }).Stage_Consent);
  assert.equal(deriveStages({ files: [{ name: 'consent-receipt.json', role: 'consent-receipt' }] }).Stage_Consent, 'done');
  assert.equal(deriveStages({ manifest: { audio: { name: 'x.wav' } } }).Stage_Record, 'done');
  assert.equal(deriveStages({ files: [{ name: 'x.m4a', role: 'assigned-audio' }] }).Stage_Record, 'done');
  assert.equal(deriveStages({ files: [{ name: 'x.wav', role: '' }] }).Stage_Record, 'done', 'an untagged recording, by lameta\'s type table');
  assert.ok(!deriveStages({ files: [{ name: 'x.txt', role: '' }] }).Stage_Record);
  assert.ok(!deriveStages({ files: [{ name: 'x.wav', role: 'derived-wav' }] }).Stage_Record, 'our converted copy is not the recording');
});

test('the Status rule: withdrawn, then the two picks', () => {
  assert.equal(lametaStatusFor({}), 'Incoming', 'nothing recorded');
  assert.equal(lametaStatusFor({ Stage_Record: 'in_progress' }), 'Incoming');
  assert.equal(lametaStatusFor({ Stage_Record: 'done' }), 'In_Progress');
  assert.equal(lametaStatusFor({ Stage_Record: 'done', Stage_Para: 'done' }), 'In_Progress', 'analysis done is not archived');
  assert.equal(lametaStatusFor({ Stage_Record: 'done', Stage_Archive_Submitted: 'done' }), 'Finished');
  assert.equal(lametaStatusFor({ Stage_Archive_Submitted: 'done' }), 'Incoming', 'the first pick gates the second');
  assert.equal(lametaStatusFor({ Stage_Record: 'done' }, undefined, { withdrawn: true }), 'Skipped');
  assert.equal(lametaStatusFor({ Stage_Record: 'done' }, null), '', 'a project without picks derives nothing');
  assert.equal(lametaStatusFor({ Stage_Transcribe: 'done', Stage_Para: 'done' }, { inProgressAfter: 'transcribe', finishedAfter: 'para' }), 'Finished', 'custom picks');
  assert.equal(lametaStatusFor({ Stage_Record: 'done' }, { finishedAfter: 'para' }), 'In_Progress', 'a missing pick keeps its default');
  assert.deepEqual(DEFAULT_STATUS_PICKS, { inProgressAfter: 'record', finishedAfter: 'archive-submitted' });
});

test('the merge never lowers, keeps unknown values, and passes strangers through', () => {
  const merged = mergeStages(
    { Stage_Record: 'done', Stage_Gloss_Lwc: 'done', Stage_Foo: 'blocked', Progress_Other: 'x' },
    { Stage_Record: 'in_progress', Stage_Gloss_Lwc: 'done', Stage_Foo: 'done', Stage_Transcribe: 'in_progress', Stage_Nothing: '' });
  assert.equal(merged.Stage_Record, 'done', 'a recount cannot lower done');
  assert.equal(merged.Stage_Foo, 'blocked', 'an unknown stored value is someone else\'s');
  assert.equal(merged.Stage_Transcribe, 'in_progress', 'a new stage is added');
  assert.ok(!('Stage_Nothing' in merged), 'an absent derivation adds nothing');
  assert.equal(merged.Progress_Other, 'x', 'keys outside the spec are untouched');
  assert.equal(mergeStages({ Stage_Record: 'In Progress' }, { Stage_Record: 'done' }).Stage_Record, 'done', 'raises, reading the stored spelling generously');
  assert.equal(mergeStages({ Stage_Record: 'in_progress' }, { Stage_Record: 'In-Progress' }).Stage_Record, 'in_progress', 'equal rank: the canonical spelling is kept as is');
});

test('the stamp, and the CustomFields block lameta will round-trip', () => {
  assert.equal(lametaSuiteStamp({ now: 0, engine: 'v690', status: 'In_Progress' }), '1970-01-01T00:00:00.000Z;v690;status=In_Progress');
  assert.equal(lametaSuiteStamp({ now: '2026-09-27T10:00:00Z', engine: 'v690', status: 'Finished' }), '2026-09-27T10:00:00Z;v690;status=Finished');
  const xml = lametaCustomFieldsXml({ Stage_Record: 'done', Stage_Empty: '', Stage_Update_Date: 'done', 'bad key': 'x', Suite_Doc_Id: 'a&b' });
  assert.equal(xml, ['  <CustomFields type="xml">',
    '    <Stage_Record type="string">done</Stage_Record>',
    '    <Suite_Doc_Id type="string">a&amp;b</Suite_Doc_Id>',
    '  </CustomFields>'].join('\n'));
  assert.doesNotMatch(xml, /Update_Date/, 'a key with "date" in it would be parsed as a date by lameta: refused');
  assert.equal(lametaCustomFieldsXml({}), '', 'nothing to say, nothing written');
  assert.equal(lametaCustomFieldsXml({ Stage_Empty: '' }), '');
});

test('the session file carries the block LAST, after Contributions, and only when there is something to carry', () => {
  const xml = lametaSessionXml({ title: 'x', vernLang: 'fau', analLang: 'id', done: false,
    stages: { Stage_Record: 'done', Stage_Transcribe: 'in_progress' }, docId: 'bwpX_YzJZRolHdh_', flexGuid: '4f2c0c2e', engine: 'v690', now: 0,
    contributors: [{ name: 'A', role: 'speaker' }] });
  assert.ok(xml.indexOf('<CustomFields type="xml">') > xml.indexOf('</Contributions>'), 'after Contributions');
  assert.ok(xml.endsWith('  </CustomFields>\n</Session>\n'), 'and last');
  assert.match(xml, /<Stage_Record type="string">done<\/Stage_Record>/);
  assert.match(xml, /<Suite_Doc_Id type="string">bwpX_YzJZRolHdh_<\/Suite_Doc_Id>/);
  assert.match(xml, /<Flex_Text_Guid type="string">4f2c0c2e<\/Flex_Text_Guid>/);
  assert.match(xml, /<Suite_Stamp type="string">1970-01-01T00:00:00.000Z;v690;status=In_Progress<\/Suite_Stamp>/, 'the stamp names the Status written');
  assert.match(xml, /<Status type="string">In_Progress<\/Status>/, 'recorded, not archived: In_Progress by the two picks');
  assert.doesNotMatch(lametaSessionXml({ title: 'x' }), /CustomFields/, 'a session with nothing derived has no block at all');
  assert.doesNotMatch(lametaSessionXml({ title: 'x', stages: { Stage_Record: 'done' }, stamp: false }), /Suite_Stamp/, 'stamp:false for a writer that stamps elsewhere');
});

test('Status: an explicit value wins, then Done, then the picks, then In_Progress', () => {
  assert.match(lametaSessionXml({ title: 'x', status: 'Skipped', done: true }), /<Status type="string">Skipped</, 'explicit');
  assert.match(lametaSessionXml({ title: 'x', done: true, stages: {} }), /<Status type="string">Finished</, "the coworker's Done");
  assert.match(lametaSessionXml({ title: 'x', stages: {} }), /<Status type="string">Incoming</, 'no recording yet');
  assert.match(lametaSessionXml({ title: 'x', stages: { Stage_Record: 'done' } }), /<Status type="string">In_Progress</);
  assert.match(lametaSessionXml({ title: 'x', stages: { Stage_Record: 'done' }, picks: null }), /<Status type="string">In_Progress</, 'no picks: the old default');
  assert.match(lametaSessionXml({ title: 'x' }), /<Status type="string">In_Progress</, 'no stages: unchanged from v665');
});
