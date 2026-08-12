/* The Drive storage manager's grouping — and the two rules that make it safe to act on.
 *
 * WHY THIS TEST EXISTS: the storage modal is the first view in this suite that is NOT derived from
 * device inventory. Every other list answers "what does this device say it holds"; this one answers
 * "what is actually in the researcher's Drive", which is the only way a text that was uploaded and
 * then removed from its device is visible at all. Because it is also the surface that DELETES
 * things, its arithmetic has to be right for reasons beyond tidiness: a text whose size is reported
 * as 0 because its files sit in the `originals/` child looks like free cleanup, and a text whose
 * device attribution is wrong looks unassigned — which is exactly the class the modal permits
 * deleting.
 *
 * The three failure modes pinned here, all of which would look plausible in review:
 *   1. NOT rolling up `originals/` — the text's real bytes (the audio!) live in that child, so
 *      every recorded text would report a few KB of flextext and nothing else.
 *   2. Counting folders as files — Drive reports no `size` for a folder, so this shows as harmless
 *      until it silently offsets a total someone is making a delete decision from.
 *   3. Reading a MISSING quota `limit` as 0 — unlimited/pooled Google accounts omit it, and a
 *      reader that defaults to zero shows those researchers as permanently 100% full.
 *
 * Plus the done-marker rule, which is the one with a real blast radius: an ABSENT header must mean
 * "no change", because old engines send nothing and treating their silence as `false` would make
 * every upload from a not-yet-updated device silently un-mark finished texts.
 *
 * Run: node test/drive-estate.test.mjs
 */
import { readFileSync } from 'node:fs';

const worker = readFileSync(new URL('../worker/src/v1.js', import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

// Lift the pure grouper out of the real worker source.
const src = worker.match(/function buildDriveEstate\(files\) \{[\s\S]*?\n\}/);
if (!src) { console.log('FAIL: buildDriveEstate not findable'); process.exit(1); }
const buildDriveEstate = new Function(`return (${src[0].replace('function buildDriveEstate', 'function')})`)();

const FOLDER = 'application/vnd.google-apps.folder';
const dir = (id, name, parent, props) => ({ id, name, mimeType: FOLDER, parents: parent ? [parent] : [], appProperties: props || {} });
const file = (id, name, parent, size) => ({ id, name, mimeType: 'audio/mpeg', parents: [parent], size: String(size), modifiedTime: '2026-08-10T00:00:00Z' });

/* The real shape: master > device > text > originals > files, plus a bare .flextext sitting
 * directly in the text folder (Lane B uploads land there, not in originals/). */
const estate = () => buildDriveEstate([
  dir('M', 'FlexText Uploads', '', { flextextRole: 'uploads-master' }),
  dir('D1', "Barnabas' Tablet", 'M'),
  dir('D2', 'Edo Phone', 'M'),
  dir('T1', 'Kisah Rusa', 'D1', { flextextDoc: 'doc1' }),
  dir('T1o', 'originals', 'T1', { flextextRole: 'originals' }),
  file('f1', 'Kisah Rusa.mp3', 'T1o', 5_000_000),
  file('f2', 'flextext-manifest.json', 'T1o', 400),
  file('f3', 'Kisah Rusa 2026-08-10.flextext', 'T1', 26_000),
  dir('T2', 'Edo Gets Bit (done)', 'D2', { flextextDoc: 'doc2', flextextDone: '1' }),
  file('f4', 'Edo.m4a', 'T2', 1_100_000),
  // An ORPHAN text: its folder is not under any device (the researcher moved it in Drive).
  dir('T3', 'Wandering Text', 'M', { flextextDoc: 'doc3' }),
  file('f5', 'w.flextext', 'T3', 1_000),
]);

console.log('\nthe tree is read from TAGS and parents, not from names');
{
  const e = estate();
  ok(e.master === 'M', 'the master folder is found by its role tag');
  ok(e.devices.length === 2, `two device folders (${e.devices.map((d) => d.name).join(', ')})`);
  ok(!e.devices.some((d) => d.folderId === 'T3'),
     'a TEXT folder sitting directly under master is not mistaken for a device');
  ok(e.texts.length === 3, 'three texts, found by their flextextDoc tag');
  const t1 = e.texts.find((t) => t.docId === 'doc1');
  ok(t1 && t1.device === "Barnabas' Tablet", 'a text is attributed to the device folder it sits in');
  const t3 = e.texts.find((t) => t.docId === 'doc3');
  ok(t3 && t3.device === '' && t3.deviceFolderId === '',
     'a text outside every device folder reports NO device rather than a wrong one');
}

console.log('\nFAILURE MODE 1: originals/ rolls UP into its text');
{
  const t1 = estate().texts.find((t) => t.docId === 'doc1');
  // 5,000,000 (audio, in originals/) + 400 (manifest, in originals/) + 26,000 (flextext, in the text folder)
  ok(t1.bytes === 5_026_400, `the audio in originals/ counts toward the text (${t1.bytes})`);
  ok(t1.files === 3, 'and so does its file count');
  // Without the roll-up this text reports 26,000 bytes — it would look like nothing worth deleting,
  // while actually holding 5 MB. That is a decision the researcher would be making on a false number.
  ok(t1.bytes > 5_000_000, 'a recorded text is never reported as just its flextext');
}

console.log('\nFAILURE MODE 2: folders contribute no bytes and are not counted as files');
{
  const e = estate();
  const total = e.texts.reduce((a, t) => a + t.bytes, 0);
  ok(total === 5_026_400 + 1_100_000 + 1_000, `totals sum only real files (${total})`);
  ok(e.texts.every((t) => t.files >= 1), 'every text with files reports at least one');
  // The originals/ folder row itself must not appear as a text or inflate a count.
  ok(!e.texts.some((t) => t.folderId === 'T1o'), 'the originals/ folder is not itself a text');
}

console.log('\nthe done marker is read from the TAG, never from the name');
{
  const e = estate();
  const t2 = e.texts.find((t) => t.docId === 'doc2');
  ok(t2.done === true, 'the tagged text reads as done');
  ok(t2.title === 'Edo Gets Bit', `the "(done)" suffix is stripped for display: ${JSON.stringify(t2.title)}`);
  // A folder NAMED "(done)" without the tag must not read as done — the name is decoration, and
  // trusting it would let a researcher's manual rename change a recorded fact.
  const spoof = buildDriveEstate([
    dir('M', 'FlexText Uploads', '', { flextextRole: 'uploads-master' }),
    dir('D', 'Dev', 'M'),
    dir('T', 'Renamed By Hand (done)', 'D', { flextextDoc: 'x' }),
  ]);
  ok(spoof.texts[0].done === false, 'a hand-renamed folder is NOT done — only the tag decides');
}

console.log('\nbiggest first, because that is what a storage view is for');
{
  const b = estate().texts.map((t) => t.bytes);
  ok(b.join(',') === [...b].sort((x, y) => y - x).join(','), `sorted descending (${b.join(', ')})`);
}

console.log('\nnothing about an odd listing can throw');
{
  ok(buildDriveEstate([]).texts.length === 0, 'empty listing');
  ok(buildDriveEstate(null).texts.length === 0, 'null listing');
  // No master folder at all (a brand-new account that has never uploaded).
  ok(buildDriveEstate([dir('T', 'x', '', { flextextDoc: 'd' })]).texts.length === 1, 'a text with no master still lists');
  // A file whose parent is nothing we know: dropped, not attributed to an arbitrary text.
  const stray = buildDriveEstate([
    dir('M', 'FlexText Uploads', '', { flextextRole: 'uploads-master' }),
    dir('T', 'A', 'M', { flextextDoc: 'd' }),
    { id: 'z', name: 'stray.bin', mimeType: 'application/octet-stream', parents: ['NOWHERE'], size: '999' },
  ]);
  ok(stray.texts[0].bytes === 0, 'a file outside every text folder is not charged to some text');
}

console.log('\nFAILURE MODE 3: an ABSENT quota limit means unlimited, never zero');
{
  const route = (worker.match(/drive-estate'\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(/limit: q\.limit != null \? Number\(q\.limit\) : null/.test(route),
     'a missing limit is passed through as null, not coerced to 0');
  ok(/usageInDriveTrash/.test(route),
     'trashed bytes are reported separately — they count INSIDE usage, so trashing reclaims nothing alone');
}

console.log('\nthe DONE header: absent means NO CHANGE');
{
  /* The blast radius: every upload from a device that has not updated yet would otherwise clear the
   * marker on texts the researcher had already seen marked finished. */
  ok(/async function driveMarkDone\(access, folderId, want, title\)/.test(worker), 'the marker writer exists');
  ok(/if \(want === null \|\| !folderId\) return;/.test(worker), 'null (= absent header) is an explicit no-op');
  ok(/body\.done === '1' \? true : body\.done === '0' \? false : null/.test(worker),
     'the chunked path maps 1/0/absent to true/false/no-change');
  ok(/hd === '1' \? true : hd === '0' \? false : null/.test(worker),
     'and so does the single-POST path, from the done query param');
  const up = readFileSync(new URL('../docs/js/upload.js', import.meta.url), 'utf8');
  ok(/'done=' \+ \(rec\.docDone \? '1' : '0'\)/.test(up), "the device sends '1' or '0' EXPLICITLY, never omission-as-false");
  ok(/done: rec\.docDone \? '1' : '0'/.test(up), '...on the chunked path too');

  /* ⚠⚠ THE ONE THAT BROKE EVERY UPLOAD. Done-ness was an `x-fx-done` HEADER for about an hour.
   * A custom request header must be named in the worker's Access-Control-Allow-Headers, and until
   * that worker is deployed the browser's CORS preflight refuses the request outright — the fetch
   * rejects, classifies as transient, and the queue retries forever showing "1 file(s) waiting to
   * upload" with no actionable error. A query param needs no preflight allowance, so a NEW client
   * works against an OLD worker and deploy order stops mattering.
   *
   * The rule this pins, which is bigger than this one field: adding a custom x-fx-* header to a
   * request the DEVICE makes is a breaking change until the worker ships, whatever the server does
   * with it. "Old workers ignore unknown headers" is true of the server and irrelevant to the
   * browser. */
  ok(!/x-fx-done['"]\s*:/.test(up), 'no x-fx-done header is sent (it would fail CORS preflight)');
  const cors = (worker.match(/'Access-Control-Allow-Headers': '([^']*)'/) || [])[1] || '';
  const sent = [...up.matchAll(/'(x-fx-[a-z-]+)':/g)].map((mm) => mm[1]);
  for (const h of new Set(sent)) {
    ok(cors.split(/,\s*/).includes(h), `every x-fx header upload.js sends is CORS-allowed: ${h}`);
  }
  // The media lane pins docDone false and must not touch the text's marker.
  ok(/sub !== 'originals'/.test(worker), 'source-package uploads never rewrite the text marker');
  ok(/isDone === want\) return;/.test(worker), 'and an already-correct marker is not rewritten');
}

console.log('\nreclaim deletes OUR trashed files — never the user\'s whole trash');
{
  /* files.emptyTrash would empty the researcher's ENTIRE Drive trash, personal files included, and
   * needs a broader scope than drive.file. This is the one operation here that could destroy
   * something we did not create, so its absence is asserted rather than assumed. */
  // Check for the CALL, not the word — the worker comments explain at length why it is not used,
  // and an assertion that forbade the explanation would push out the reasoning it exists to keep.
  ok(!/drive\/v3\/files\/trash/.test(worker) && !/emptyTrash\(/.test(worker),
     'the files.emptyTrash endpoint is never CALLED (the comment explaining why may mention it)');
  const purge = (worker.match(/drive-purge'\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(/driveListAll\(access, true\)/.test(purge), 'it enumerates our own trashed files');
  ok(/'DELETE', 'https:\/\/www\.googleapis\.com\/drive\/v3\/files\/'/.test(purge), 'and deletes them individually');
  ok(/catch \{/.test(purge), 'a child already removed with its parent folder is ignored, not fatal');
  ok(/logApproval\(env, request, 'drive_purged'/.test(purge), 'and the permanent deletion is logged');
}

console.log('\nlisting is bounded and scope-limited');
{
  const list = (worker.match(/async function driveListAll[\s\S]*?\n\}/) || [''])[0];
  ok(/page < 20/.test(list), 'page count is bounded so a pathological account cannot spin the worker');
  ok(/nextPageToken/.test(list), 'but it does paginate — a real account exceeds one page');
  ok(/trashed=/.test(list), 'and live vs trashed are separate queries');
}

/* ---------------------------------------------------------------------------------------------
 * PANEL SIDE: the unassigned gate, which is where the destructive action lives.
 * ------------------------------------------------------------------------------------------- */
console.log('\nthe unassigned gate is computed from DEVICE INVENTORY, and only it exposes Remove');
{
  const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  const fn = (panel.match(/function assignedDocIds\(\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(/ins\.inventory && Array\.isArray\(ins\.inventory\.items\)/.test(fn),
     'assigned-ness comes from what devices actually report holding');
  ok(/for \(const it of \(lastData && lastData\.instances\) \|\| \[\]\)/.test(fn),
     '...across EVERY instance, not just the current card');

  const modal = (panel.match(/function storageModal\(\) \{[\s\S]*?\n\}\n\n/) || [''])[0];
  ok(/const isUnassigned = \(tx\) => !assigned\.has\(tx\.docId\);/.test(modal),
     'unassigned = no device reports the docId');
  /* ⚠ Independent of WHERE the folder sits. A text still inside its old device folder but long
   * since deleted from that device is unassigned — which is the whole case this modal exists for,
   * and a gate keyed on deviceFolderId would get it exactly backwards. */
  ok(!/isUnassigned[\s\S]{0,120}deviceFolderId/.test(modal),
     'the gate never keys on the folder location, only on inventory');
  ok(/\$\{un \? `<button[^`]*data-storedel=/.test(modal),
     'Remove is rendered ONLY for an unassigned text');
  ok(/confirm\(t\('panel\.store\.removeConfirm'/.test(modal), 'and still asks first');
  ok(/Researcher\.trashFiles\(\[b\.dataset\.storedel\]/.test(modal),
     'removal TRASHES (30-day recoverable), it does not delete');
  ok(/confirm\(t\('panel\.store\.reclaimConfirm'/.test(modal), 'the permanent reclaim asks too');
  // A missing quota limit must not render as a full bar.
  ok(/q\.limit \? Math\.min\(100, Math\.round\(\(q\.usage \/ q\.limit\) \* 100\)\) : 0/.test(modal),
     'no limit -> 0% bar, never a division by zero or a full bar');
}

console.log('\nthe wording tells the researcher the thing they would otherwise discover the hard way');
{
  const i18n = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
  const en = (k) => (i18n.match(new RegExp(`'${k}': '([^']*)'`)) || [])[1] || '';
  ok(/still count against/i.test(en('panel.store.trashWhy')),
     'the trash block says trashed files still count against the quota');
  ok(/reclaim/i.test(en('panel.store.removeConfirm')),
     'and the remove confirm warns that space is not freed until reclaimed');
  ok(/nothing else in your Drive trash/i.test(en('panel.store.reclaimConfirm')),
     'the reclaim confirm promises it touches only files this app created');
  ok(/cannot be undone/i.test(en('panel.store.reclaimConfirm')), '...and that it is permanent');
  const block = (lang) => {
    const at = i18n.indexOf(`\n${lang}: {`);
    const rest = i18n.slice(at + 1);
    const nxt = rest.search(/\n[a-z]{2,3}: \{/);
    return nxt < 0 ? i18n.slice(at) : i18n.slice(at, at + 1 + nxt);
  };
  for (const k of ['panel.store.btn', 'panel.store.title', 'panel.store.unassignedGroup',
                   'panel.store.remove', 'panel.store.reclaim', 'panel.store.quotaNoLimit']) {
    const re = new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'm');
    ok(re.test(block('en')) && re.test(block('id')), `${k} is in en AND id`);
  }
}

console.log('\nthe DONE marker never blocks an upload');
{
  /* ⚠ THE RISK THIS REMOVES: driveMarkDone was `await`ed inside BOTH upload handlers, putting a
   * Drive round trip in the critical path of every text upload — the single most important path in
   * the system, where a field device on a bad connection pushes a text someone may have spent hours
   * on. The marker is COSMETIC (a tag plus a folder-name suffix). Awaiting it added latency to every
   * upload, and a Drive call that hung would have stalled the upload itself, to decorate a folder.
   * ctx.waitUntil runs it after the response instead, so a slow or failing Drive costs nothing. */
  const calls = [...worker.matchAll(/(await|ctx\.waitUntil\()\s*driveMarkDone\(/g)].map((mm) => mm[1]);
  ok(calls.length === 2, `both upload paths mark done (${calls.length})`);
  ok(calls.every((c) => c.startsWith('ctx.waitUntil')),
     'and NEITHER awaits it — the marker is never in the upload critical path');
  ok(!/await driveMarkDone\(/.test(worker), 'no awaited call survives anywhere');
}

console.log('\nsizes are honest — a storage view whose numbers lie is worse than none');
{
  const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  const m = panel.match(/const gb = \(b\) => \{[\s\S]*?\n\};/);
  ok(!!m, 'the size formatter is present');
  const gb = new Function(m[0] + ' return gb;')();
  /* The first version floored everything at 1 MB, so a 400-byte manifest, a 26 KB flextext and a
   * 1.1 MB recording all read "1 MB" — on the one screen whose purpose is deciding what to delete. */
  ok(gb(400) === '400 B', `bytes stay bytes (${gb(400)})`);
  ok(gb(26000) === '25 KB', `a small flextext is KB, not "1 MB" (${gb(26000)})`);
  ok(gb(1100000) === '1.0 MB', `just over a megabyte reads as such (${gb(1100000)})`);
  ok(gb(5026400) === '4.8 MB', `and keeps a decimal where it matters (${gb(5026400)})`);
  ok(gb(2147483648) === '2.0 GB', `gigabytes (${gb(2147483648)})`);
  ok(gb(0) === '0 B' && gb(undefined) === '0 B', 'zero and undefined are safe');
  // The old bug, stated as an assertion so it cannot come back.
  ok(!['400', '26000', '512000'].some((n) => gb(Number(n)) === '1 MB'), 'nothing small is rounded UP to 1 MB');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
