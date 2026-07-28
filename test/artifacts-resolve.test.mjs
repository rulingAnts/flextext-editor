/* Which downloadable files a text has, and what each one is for.
 *
 * WHY THIS IS WORTH A TEST: this resolver stands between field devices that update on their own
 * schedule and a panel that must keep working for all of them. `uploadedFileId` is a legacy SCALAR;
 * it is moving to a per-kind MAP because one text will soon have five current artifacts. Both
 * shapes have to be readable FOREVER — a device still on the old engine must show its file, not an
 * empty dropdown. A regression here is invisible in testing (the panel just looks emptier) and
 * costly in the field (a researcher concludes the upload never happened).
 *
 * The other property pinned here: an entry is only ever offered when its URL genuinely resolves.
 * A dead link in this menu is worse than a missing one — it sends someone to a Drive 404 and makes
 * them think the file was deleted.
 *
 * Run: node test/artifacts-resolve.test.mjs
 */
import { resolveArtifacts, uploadedMap, emptyReason, ARTIFACT_KINDS, ARTIFACT_LABEL } from '../docs/js/artifacts.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const ID = '1AbCdEfGhIjK';   // Drive-shaped
const kinds = (r) => r.map((x) => x.kind);

console.log('\nthe LEGACY scalar report still works (field devices update on their own schedule)');
{
  const noAudio = resolveArtifacts({ id: 't1', uploadedFileId: ID, hasAudio: false }, null);
  ok(kinds(noAudio).join() === 'flextext', 'no audio -> the upload is a bare .flextext');
  const withAudio = resolveArtifacts({ id: 't1', uploadedFileId: ID, hasAudio: true }, null);
  ok(kinds(withAudio).join() === 'bundle', 'audio attached -> the upload is a zip bundle');
  ok(withAudio[0].inferred === true, 'and it is flagged INFERRED — the old report cannot state the kind');
  ok(withAudio[0].url.includes(ID), 'the link points at the reported file id');
}

console.log('\nthe NEW per-kind map is read when present');
{
  const item = { id: 't1', uploaded: {
    flextext: { fileId: '1flextextAAA' },
    'eaf-flex': { fileId: '1eafFlexAAAA' },
    'eaf-saymore': '1eafSayMoreA',        // bare id also accepted
    bundle: { fileId: '1bundleAAAAA' },
  } };
  const r = resolveArtifacts(item, null);
  ok(kinds(r).join() === 'flextext,bundle,eaf-flex,eaf-saymore', 'all four resolved, in the declared order');
  ok(r.every((x) => x.inferred === false), 'nothing is inferred — the device stated each kind');
  ok(new Set(kinds(r)).size === r.length, 'one entry per kind, never duplicated');
}

console.log('\nthe assigned audio comes from the History log, not the device');
{
  const url = 'https://drive.google.com/file/d/AUDIO1234567/view';
  const r = resolveArtifacts({ id: 't1', uploadedFileId: ID, hasAudio: true }, { audioUrl: url });
  ok(kinds(r)[0] === 'audio', 'audio is offered FIRST — it is what a researcher reaches for most');
  ok(r[0].url === url, 'and it is the exact assigned URL');
  ok(kinds(r).join() === 'audio,bundle', 'alongside the uploaded artifact');
  // A device never reports the assigned audio; it only reports what it UPLOADED.
  ok(resolveArtifacts({ id: 't1', uploadedFileId: ID, hasAudio: true }, null).find((x) => x.kind === 'audio') === undefined,
     'with no assigned record there is no audio entry — it is not invented from the upload');
}

console.log('\na dead entry is never offered (a Drive 404 reads as "my file was deleted")');
{
  ok(resolveArtifacts({ id: 't1' }, null).length === 0, 'nothing uploaded, nothing assigned -> no entries');
  ok(resolveArtifacts({ id: 't1', uploadedFileId: '' }, null).length === 0, 'an empty file id is not a link');
  ok(resolveArtifacts({ id: 't1', uploadedFileId: 'short' }, null).length === 0,
     'a non-Drive-shaped id is refused rather than linked');
  ok(resolveArtifacts({ id: 't1' }, { audioUrl: 'javascript:alert(1)' }, null).length === 0,
     'a non-http assigned URL is refused (it arrives via a report and reaches an href)');
  ok(resolveArtifacts({ id: 't1' }, { audioUrl: '' }).length === 0, 'an empty assigned URL is not an entry');
}

console.log('\nmalformed input degrades to empty, never throws (this renders in a privileged panel)');
{
  for (const [label, bad] of [['null', null], ['undefined', undefined], ['a string', 'nope'],
                              ['an array uploaded', { uploaded: ['a'] }], ['uploaded=null', { uploaded: null }]]) {
    let threw = false, r = null;
    try { r = resolveArtifacts(bad, null); } catch { threw = true; }
    ok(!threw && Array.isArray(r), `${label} -> [] rather than a crash`);
  }
  ok(Object.keys(uploadedMap(null)).length === 0, 'uploadedMap(null) is an empty map');
}

console.log('\nthe empty state says something TRUE (Seth: pre-v126 audio is unrecoverable)');
{
  ok(emptyReason({ id: 't1', uploadedFileId: ID, hasAudio: false }, null) === null,
     'when there IS something to show, there is no empty reason');
  ok(emptyReason({ id: 't1' }, null) === 'panel.dl.noneYet',
     'never assigned, never uploaded -> "nothing yet"');
  ok(emptyReason({ id: 't1' }, { audioUrl: '' }) === 'panel.dl.noneAssignedPreV126',
     'assigned but with no retained URL -> the pre-v126 explanation, not a bare "nothing"');
}

console.log('\nevery kind has a label key, and they are all distinct');
{
  ok(ARTIFACT_KINDS.every((k) => !!ARTIFACT_LABEL[k]), 'no kind is missing a label key');
  ok(new Set(Object.values(ARTIFACT_LABEL)).size === ARTIFACT_KINDS.length, 'label keys are unique');
  ok(Object.values(ARTIFACT_LABEL).every((k) => k.startsWith('panel.dl.')), 'all namespaced panel.dl.*');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
