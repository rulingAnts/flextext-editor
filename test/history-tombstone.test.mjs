/* The researcher history log must never invent a deletion.
 *
 * WHY THIS IS THE TEST THAT MATTERS: a deleted text leaves NO event behind — it simply stops
 * appearing in the next inventory report. So the log infers deletion from absence, and absence has
 * innocent causes: an install that has never reported, a decrypt failure, a malformed report. Treat
 * any of those as "empty" and one poll writes a tombstone for every text a device holds. The
 * researcher then sees a history claiming their coworker's whole corpus was destroyed.
 *
 * The failure DIRECTION is what this file pins down. Missing a real deletion costs one log entry.
 * Fabricating deletions destroys trust in the log, and a log nobody trusts is worse than no log —
 * it will be consulted precisely when something has gone wrong and the truth matters.
 *
 * Run: node test/history-tombstone.test.mjs
 */
import { diffInventory, snapshotOf, mergeEvents, assignedEvent, driveLink, driveIdFrom } from '../docs/js/history.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const ctx = { instanceId: 'i1', installId: 'd1', device: "Barnabas' phone", at: 1000 };
const item = (id, over) => ({ id, title: 'Text ' + id, uploadState: 'local', ...over });
const snap = (items) => snapshotOf(items);
const kinds = (evs) => evs.map((e) => e.kind).sort();

console.log('\nan UNREADABLE report is not evidence of anything (the guard that matters)');
{
  const prev = snap([item('a'), item('b'), item('c')]);
  for (const [label, bad] of [
    ['undefined (install has never reported)', undefined],
    ['null (no inventory at all)', null],
    ['a non-array (decrypt returned junk)', { items: 'nope' }],
    ['a string', 'a,b,c'],
  ]) {
    const r = diffInventory(prev, bad, ctx);
    ok(r.events.length === 0, `${label} -> NO events`);
    ok(r.snapshot === null, `${label} -> snapshot untouched (previous state is kept)`);
  }
}

console.log('\nfirst sight of an install is adopted silently, never replayed as history');
{
  const r = diffInventory(null, [item('a', { uploadedFileId: 'F1', done: true }), item('b')], ctx);
  ok(r.events.length === 0, 'no prior snapshot -> no events, even for already-uploaded/done texts');
  ok(r.snapshot && Object.keys(r.snapshot).length === 2, 'but the snapshot IS adopted');
}

console.log('\na genuinely empty report DOES tombstone (the real deletion case)');
{
  const prev = snap([item('a'), item('b')]);
  const r = diffInventory(prev, [], ctx);
  ok(kinds(r.events).join(',') === 'deleted,deleted', 'both texts recorded as deleted');
  ok(r.snapshot && Object.keys(r.snapshot).length === 0, 'and the snapshot becomes empty');
}

console.log('\nthe tombstone records WHICH path removed the text');
{
  const prev = snap([item('a', { pendingDelete: true }), item('b')]);
  const r = diffInventory(prev, [], ctx);
  const byId = Object.fromEntries(r.events.map((e) => [e.docId, e]));
  ok(byId.a.by === 'researcher', 'it was struck through (pendingDelete) -> researcher-triggered');
  ok(byId.b.by === 'device', 'it vanished with no pending flag -> the coworker deleted it');
}

console.log('\nan upload is observed from a CHANGED file id (the only available signal)');
{
  const prev = snap([item('a', { uploadedFileId: 'F1' })]);
  ok(diffInventory(prev, [item('a', { uploadedFileId: 'F1' })], ctx).events.length === 0,
     'same file id re-reported -> nothing (a poll must be replayable)');
  const r = diffInventory(prev, [item('a', { uploadedFileId: 'F2' })], ctx);
  ok(kinds(r.events).join(',') === 'submitted', 're-upload writes a new id -> one submitted event');
  ok(r.events[0].fileId === 'F2', 'the NEW file id is retained in the entry');
  const first = diffInventory(snap([item('a')]), [item('a', { uploadedFileId: 'F1' })], ctx);
  ok(first.events.length === 1 && first.events[0].fileId === 'F1', 'first ever upload is caught too');
}

console.log('\n"done" fires once, on the false->true edge');
{
  const prev = snap([item('a', { uploadedFileId: 'F1' })]);
  const r = diffInventory(prev, [item('a', { uploadedFileId: 'F1', done: true })], ctx);
  ok(kinds(r.events).join(',') === 'done', 'marking done -> one done event');
  ok(r.events[0].fileId === 'F1', 'it retains the file id of the latest upload');
  const again = diffInventory(r.snapshot, [item('a', { uploadedFileId: 'F1', done: true })], ctx);
  ok(again.events.length === 0, 'still done on the next poll -> no repeat');
}

console.log('\nthe entry carries what a researcher needs MONTHS later');
{
  const assigned = { a: { audioUrl: 'https://drive.google.com/file/d/AUDIO123456/view' } };
  const prev = snap([item('a', { uploadedFileId: 'F9', pendingDelete: true })]);
  const r = diffInventory(prev, [], { ...ctx, assigned });
  const e = r.events[0];
  ok(e.title === 'Text a', 'the title (the text is gone; this is all that names it)');
  ok(e.device === "Barnabas' phone", 'which device had it');
  ok(e.at === 1000, 'when');
  ok(e.audioUrl === assigned.a.audioUrl, 'the audio that was ASSIGNED to it');
  ok(e.fileId === 'F9', 'the most recent uploaded file, retained at the moment it vanished');
}

console.log('\nappending is idempotent (the dashboard re-renders on a 12s poll)');
{
  const evs = [{ kind: 'done', docId: 'a', at: 5, fileId: 'F1' }];
  const once = mergeEvents([], evs);
  const twice = mergeEvents(once, evs);
  ok(twice.length === 1, 'replaying the same event does not double the log');
  const later = mergeEvents(twice, [{ kind: 'done', docId: 'a', at: 6, fileId: 'F1' }]);
  ok(later.length === 2, 'but the same kind at a different time is a distinct event');
  ok(mergeEvents(null, evs).length === 1, 'a missing/corrupt existing log does not throw');
}

console.log('\nthe log is capped, dropping the OLDEST (a field account runs for years)');
{
  const many = Array.from({ length: 12 }, (_, i) => ({ kind: 'done', docId: 'd' + i, at: i }));
  const capped = mergeEvents([], many, 5);
  ok(capped.length === 5, 'capped to the limit');
  ok(capped[0].docId === 'd7' && capped[4].docId === 'd11', 'the newest survive, the oldest fall off');
}

console.log('\nDrive links DOWNLOAD the file — they never open the preview page (Seth)');
{
  const L = driveLink('1AbC-dEfGh_2i');
  ok(L.startsWith('https://drive.usercontent.google.com/download?'), 'a real id -> the download endpoint');
  ok(/[?&]export=download(&|$)/.test(L), 'export=download is present');
  ok(/[?&]confirm=t(&|$)/.test(L), 'confirm=t skips the large-file interstitial');
  ok(!L.includes('/view'), 'NOT the /view preview page — Drive cannot render .flextext or .eaf anyway');
  ok(L.includes('1AbC-dEfGh_2i'), 'and it carries the file id');
  ok(driveLink('') === '', 'no id -> no link');
  ok(driveLink('short') === '', 'a too-short id is refused rather than linked');
  ok(driveLink('javascript:alert(1)') === '', 'a scheme injected via a device report is refused');
  ok(driveLink('abc"onmouseover="x') === '', 'an attribute-breakout attempt is refused');
}

console.log('\na pasted Drive share URL yields its id, so it too can become a download');
{
  ok(driveIdFrom('https://drive.google.com/file/d/1AbC-dEfGh_2i/view?usp=sharing') === '1AbC-dEfGh_2i',
     'the /file/d/<id>/view share form');
  ok(driveIdFrom('https://drive.google.com/open?id=1AbC-dEfGh_2i') === '1AbC-dEfGh_2i', 'the open?id= form');
  ok(driveIdFrom('https://drive.google.com/uc?export=download&id=1AbC-dEfGh_2i') === '1AbC-dEfGh_2i',
     'the older /uc?export=download form');
  ok(driveIdFrom('https://example.org/audio.wav') === '', 'a NON-Drive URL yields nothing, so it is left untouched');
  ok(driveIdFrom('') === '' && driveIdFrom(null) === '', 'empty/null are safe');
}

console.log('\nitems with no id cannot be tracked and are skipped, not crashed on');
{
  ok(snapshotOf([{ title: 'no id' }, item('a')]) && Object.keys(snapshotOf([{ title: 'x' }, item('a')])).length === 1,
     'an id-less item is dropped from the snapshot');
  ok(snapshotOf([null, undefined, item('a')]) !== null, 'null entries do not throw');
  ok(assignedEvent({ docId: 'a', title: 'T' }).kind === 'assigned', 'assignedEvent builds a well-formed entry');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
