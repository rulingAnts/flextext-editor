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
  ok(/async function driveTextHousekeeping\(access, folderId, \{/.test(worker), 'the housekeeping writer exists');
  ok(/if \(want === null\) return;/.test(worker), 'null (= absent header) is an explicit no-op for the marker');
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
  ok(/\(props\.flextextDone === '1'\) === want\) return;/.test(worker), 'and an already-correct marker is not rewritten');
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
  /* ⚠ EACH DELETE IS A SUBREQUEST, and a Worker has a hard per-request subrequest cap (50 free).
   * The first version looped over EVERY trashed file, so a researcher who had been testing removals
   * blew the cap — and that runtime error is not catchable by the try around it, it kills the whole
   * request. Reported as "Reclaim space throws an error", with the trashed-file COUNT as the hidden
   * variable: it works in testing and fails in use, which is the worst way for a bound to be wrong. */
  ok(/seen < CAP/.test(purge), 'the batch is BOUNDED per request (subrequest cap)');
  /* ⚠ THE SECOND LIMIT, which the first fix missed: the CLIENT aborts at REQ_TIMEOUT_MS. 40
   * SEQUENTIAL Drive deletes at ~500ms each is exactly 20s, so bounding the COUNT alone still timed
   * out — reported as "The operation was aborted", a different error with the same root cause.
   * Deleting in parallel waves makes wall time one round trip PER WAVE rather than per file, and
   * the time budget stops a slow Drive walking into the timeout however fast calls nominally are. */
  ok(/await Promise\.all\(wave\.map/.test(purge), 'deletes run in PARALLEL waves, not one at a time');
  ok(/Date\.now\(\) - started\) < BUDGET_MS/.test(purge), 'and a wall-clock budget bounds the request independently');
  const cap = parseInt((purge.match(/CAP = (\d+)/) || [])[1], 10);
  const wave = parseInt((purge.match(/WAVE = (\d+)/) || [])[1], 10);
  const budget = parseInt((purge.match(/BUDGET_MS = (\d+)/) || [])[1], 10);
  const clientTimeout = parseInt((readFileSync(new URL('../docs/js/researcher.js', import.meta.url), 'utf8')
    .match(/REQ_TIMEOUT_MS\s*=\s*(\d+)/) || [])[1], 10);
  ok(cap + 2 < 50, `subrequests stay under the Worker cap (~${cap + 2} of 50)`);
  ok(budget < clientTimeout, `the server budget (${budget}ms) fires BEFORE the client aborts (${clientTimeout}ms)`);
  // Even at a pessimistic 500ms per Drive call, the waves must finish inside the client's timeout.
  ok(Math.ceil(cap / wave) * 500 < clientTimeout,
     `worst-case wall time ${(Math.ceil(cap / wave) * 500) / 1000}s < ${clientTimeout / 1000}s abort`);
  ok(/remaining = Math\.max\(0, dead\.length - seen\)/.test(purge), 'and it reports what is left');
  const panelSrc = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  ok(/if \(!r\.remaining\) break;/.test(panelSrc), 'the panel repeats until nothing remains, so a backlog still clears');
  ok(/for \(let pass = 0; pass < 25; pass\+\+\)/.test(panelSrc), '...with a hard stop, so it can never spin forever');
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
  ok(/const isUnassigned = \(tx\) => !assigned\.has\(tx\.docId\)/.test(modal),
     'unassigned = no device reports the docId');
  /* ⚠ …AND NOTHING IS ON ITS WAY TO A DEVICE. The tag drives a Remove that trashes the text's Drive
   * folder, and the worker creates that folder at assignment/begin — before a byte is uploaded — so
   * without these two exclusions a text mid-assignment or mid-move was offered for deletion while it
   * was the only copy of live work. Reclaim-space reads the same predicate, and that one does not
   * go through Drive's trash. */
  ok(/!pendingMoves\.has\(tx\.docId\) && !inFlight\.has\(tx\.docId\)/.test(modal),
     '...and not mid-move or mid-assignment');
  ok(/function inFlightAssignIds\(\)/.test(panel)
     && /if \(p\.kind === 'assign' && p\.docId\) ids\.add\(p\.docId\)/.test(panel),
     'in-flight assignments are derived from the SHARED server-side pending map, not just this browser');
  ok(/const ids = new Set\(aqQueued\);/.test(panel),
     '...plus this browser\'s own upload queue, which only it can see');
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
  const calls = [...worker.matchAll(/(await|ctx\.waitUntil\()\s*driveTextHousekeeping\(/g)].map((mm) => mm[1]);
  ok(calls.length === 2, `both upload paths do housekeeping (${calls.length})`);
  ok(calls.every((c) => c.startsWith('ctx.waitUntil')),
     'and NEITHER awaits it — housekeeping is never in the upload critical path');
  ok(!/await driveTextHousekeeping\(/.test(worker), 'no awaited call survives anywhere');
  /* Both jobs (return-from-Unassigned + done marker) share ONE Drive read inside that single
   * waitUntil, so folding the second job in did not add a round trip to the upload. */
  ok((worker.match(/driveJson\(access, 'GET',[\s\S]{0,200}fields=id,name,parents,appProperties/g) || []).length === 1,
     'and both jobs share a single Drive read');
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

console.log('\nUNASSIGNED: the folder tree tells the truth, and can find its way back');
{
  /* Seth: a text's folder must MOVE to "FlexText Uploads / Unassigned" once no device holds it.
   * Until then the Drive tree said the text belonged to whichever device used to have it, which is
   * simply false to anyone browsing Drive without our tools. */
  /* ⚠ Assert the RULE, not the signature. The first version of this pinned the exact parameter list
   * `(access)`, so adding the project parameter failed a test whose subject had not changed. The
   * rule is that the folder is found by its ROLE TAG — never by its name, which a researcher may
   * translate or rename — and, since §16.16, scoped to the project it belongs to. */
  const un = worker.slice(worker.indexOf('async function driveUnassignedFolder'));
  const unBody = un.slice(0, un.indexOf('\n}\n'));
  ok(/value='unassigned'/.test(unBody), 'the Unassigned folder is found by ROLE tag, not by name');
  ok(/in parents and appProperties has/.test(unBody),
     '...and is scoped to its PROJECT — one per project, never a global singleton (§16.22)');
  ok(/parents: \[parent\]/.test(unBody), '...and is created under that same parent when absent');
  ok(/flextextRole' and value='unassigned'/.test(worker), '...not by name, like every other structural folder');
  ok(/seg\[2\] === 'drive-unassign'/.test(worker), 'the sweep endpoint exists');

  const sweep = (worker.match(/drive-unassign'\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(/\(f\.parents \|\| \[\]\)\.includes\(target\)\) continue;/.test(sweep), 'moving an already-filed text is a no-op');
  ok(/flextextUnassigned: '1'/.test(sweep), 'a swept folder is TAGGED as swept');
  ok(/catch \{ \/\* one text failing must not abort the sweep/.test(sweep), 'one failure does not abort the batch');

  /* ⚠ THE RETURN TRIP ONLY UNDOES OUR OWN SWEEP. If it moved any folder whose parent was not the
   * device, it would drag back a text the researcher had deliberately filed elsewhere in their own
   * Drive — silently reorganising someone's Drive is far worse than a stale-looking tree. */
  const hk = (worker.match(/async function driveTextHousekeeping[\s\S]*?\n\}/) || [''])[0];
  ok(/const unassigned = props\.flextextUnassigned === '1';/.test(hk) && /if \(unassigned\) \{/.test(hk),
     'the return trip fires ONLY for a folder we ourselves swept');
  ok(/flextextUnassigned: ''/.test(hk), 'and clears the tag on the way back');

  // Moving a folder must not change how anything resolves it.
  ok(/appProperties has \{ key='flextextDoc'/.test(worker), 'text folders are still found by tag, never by parent');
}

console.log('\n...and the Unassigned folder is never mistaken for a DEVICE');
{
  /* It sits directly under master, exactly like a device folder does. A filter that only skipped
   * TEXT folders would list it as a device — and every swept text would then read as "held by a
   * device called Unassigned", the precise opposite of what it means. */
  const est = buildDriveEstate([
    dir('M', 'FlexText Uploads', '', { flextextRole: 'uploads-master' }),
    dir('D1', 'Edo Phone', 'M'),
    dir('U', 'Unassigned', 'M', { flextextRole: 'unassigned' }),
    dir('T1', 'On A Device', 'D1', { flextextDoc: 'd1' }),
    file('f1', 'a.mp3', 'T1', 1000),
    dir('T2', 'Swept', 'U', { flextextDoc: 'd2', flextextUnassigned: '1' }),
    file('f2', 'b.mp3', 'T2', 2000),
  ]);
  ok(est.devices.length === 1 && est.devices[0].name === 'Edo Phone',
     `only real devices are listed (${est.devices.map((d) => d.name).join(', ')})`);
  ok(est.unassignedFolderId === 'U', 'the Unassigned folder is reported separately');
  const swept = est.texts.find((t) => t.docId === 'd2');
  ok(swept.inUnassigned === true, 'a swept text reports where it actually sits');
  ok(swept.device === '' && swept.deviceFolderId === '', '...and claims no device');
  const held = est.texts.find((t) => t.docId === 'd1');
  ok(held.inUnassigned === false && held.device === 'Edo Phone', 'a held text is unaffected');
  ok(swept.bytes === 2000, 'and its bytes still roll up normally from the new location');
}

console.log('\nthe UNASSIGNED card is on the dashboard, and is NOT a pseudo-instance');
{
  const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  ok(/function renderUnassignedCard\(estate\)/.test(panel), 'the card renderer exists');
  ok(/\$\{renderUnassignedCard\(estateCache\)\}/.test(panel), 'and is rendered in the dashboard body');

  /* ⚠ THE STRUCTURAL RULE. A synthetic entry in lastData.instances would have to be special-cased
   * at every site that iterates instances — the "one rule, several paths" drift the backlog warns
   * about — and a fake instance_id could reach the worker, which has no such instance. */
  ok(!/instances\.push\(|instances\.concat\(\[\{/.test(panel), 'nothing is injected into lastData.instances');
  const card = (panel.match(/function renderUnassignedCard[\s\S]*?\n\}/) || [''])[0];
  ok(!/instance_id:/.test(card), 'the card mints no instance_id of its own');
  ok(/data-uact=/.test(card) && !/data-iact=/.test(card),
     'its actions use their OWN attribute — instanceAction() assumes a real instance id');

  // Same buttons as a device row, with the one substitution.
  ok(/filesMenuHtml\(iid, tx\.docId/.test(card), 'Files menu');
  ok(/data-uact="adopt"/.test(card) && /panel\.move\.btn/.test(card), 'Move…');
  ok(/data-uact="drop"/.test(card) && /panel\.store\.remove/.test(card),
     '"Remove from Google Drive" replaces "Remove from Device" — there is no device to remove from');

  /* A text mid-MOVE is between devices, not unassigned. Listing it here would offer to delete
   * Drive's only copy while the destination is still fetching it. */
  const sel = (panel.match(/function unassignedTexts[\s\S]*?\n\}/) || [''])[0];
  ok(/!assigned\.has\(tx\.docId\)/.test(sel), 'unassigned = no device inventory claims it');
  ok(/!pendingMoves\.has\(tx\.docId\)/.test(sel), '...and a text mid-move is excluded');

  // The estate is a Drive round trip: it must not ride the 12s poll.
  ok(/if \(!prefetched && Researcher\.isApprovedSelf\(\)\) \{[\s\S]{0,400}Researcher\.driveEstate\(\)/.test(panel),
     'the estate is fetched on FULL renders only, never the poll');
}

console.log('\n...and Move from Unassigned is a REAL re-assignment');
{
  const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  const modalSrc = (panel.match(/function adoptTextModal[\s\S]*?\n\}\n\n/) || [''])[0];
  ok(/Researcher\.adoptText\(to, docId/.test(modalSrc), 'it re-files the folder and mints streaming URLs');
  ok(/await Researcher\.assign\(to, docId, fields\)/.test(modalSrc),
     '...and then sends a real assign command, so the text goes live on the device');
  ok(/kind: 'assign'/.test(modalSrc), 'with the same pending marker any assignment gets');
  ok(/panel\.move\.nothingToMove/.test(modalSrc), 'and refuses when there is no content to deliver');

  /* The adopt endpoint is ADDITIVE. /move requires toId !== instanceId by design; relaxing that to
   * serve a source-less flow would make one endpoint mean two things, on a path field devices use. */
  ok(/seg\[5\] === 'adopt'/.test(worker), 'the worker has its own adopt route');
  ok(/toId === instanceId\) return j\(\{ error: 'bad_move' \}/.test(worker), '/move keeps its distinct-devices guard');
  const adopt = (worker.match(/seg\[5\] === 'adopt'\) \{[\s\S]*?\n    \}/) || [''])[0];
  ok(/flextextUnassigned: ''/.test(adopt), 'adopting clears the swept tag, so housekeeping will not fight it');
  ok(/driveReparent\(access, f\.id, toFolder/.test(adopt), 'and the folder moves under the adopting device');
}

console.log('\nthe Unassigned card collapses like a device, but starts closed EVERY load');
{
  const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');
  const card = (panel.match(/function renderUnassignedCard[\s\S]*?\n\}/) || [''])[0];

  ok(/rp-inst-toggle/.test(card) && /rp-caret/.test(card), 'it uses the same toggle component as a device card');
  ok(/rp-inst-collapsed/.test(card) && /rp-inst-body/.test(card), '...and the same collapsed/body classes');
  ok(/aria-expanded=/.test(card) && /aria-controls=/.test(card), 'with the accessibility wiring devices get');

  /* ⚠ NOT PERSISTED, unlike device collapse state (localStorage). Seth: collapsed by default "on
   * every load". A remembered expansion would defeat that on exactly the accounts with the most
   * unassigned texts — the ones where the card is largest. */
  ok(/^let unassignedOpen = false;$/m.test(panel), 'the open state defaults to CLOSED');
  ok(!/unassignedOpen[\s\S]{0,80}localStorage/.test(panel), '...and is never persisted');
  ok(/unassignedOpen = !unassignedOpen/.test(panel), 'the toggle flips it in memory');

  // It must render BEFORE the device cards.
  const cardAt = panel.indexOf('${renderUnassignedCard(estateCache)}');
  const devsAt = panel.indexOf('${insts.length ? cards.join(\'\')');
  ok(cardAt > 0 && devsAt > 0 && cardAt < devsAt, 'and it renders at the TOP, above the device cards');
}

console.log('\ntext lists are capped and scrollable — and the Files menu still escapes the box');
{
  const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');
  ok(/\.rp-inv \{[^}]*max-height: 26rem/.test(css), 'the list is height-capped (~8-9 rows)');
  ok(/\.rp-inv \{[^}]*overflow-y: auto/.test(css), 'and scrolls past it');
  ok(/overscroll-behavior: contain/.test(css),
     'a flick that bottoms out does not jump the whole dashboard');

  /* ⚠ THE ORIGINAL REGRESSION: overflow:auto makes each list a CLIPPING container, and the Files
   * list is taller than a couple of rows, so an absolutely-positioned menu was sliced off for any
   * text near the bottom — precisely the rows you had to scroll to reach.
   *
   * v347 SETTLES IT DIFFERENTLY. `fixed` escaped the clipping but could not follow its button, so
   * it closed on scroll — and Seth reported exactly that: "if I scroll… it disappears and it won't
   * come back again until I refresh the page." The list is now a MODAL, which has no anchor to
   * lose. The scroll cap above still matters (it is what makes the dashboard usable with 42 texts);
   * what is gone is the whole class of positioning bug that came with anchoring to a row. */
  ok(!/function placeDlMenu/.test(panel), 'no anchored-menu placement remains');
  ok(!/openDl\b/.test(panel), '...nor the open-menu singleton it needed');
  ok(/function openFilesModal\(rowWrap\)/.test(panel), 'the Files control opens a modal instead');
  ok(/openFilesModal\(wrap\);/.test(panel), 'and the row button opens it');
  /* A modal that opened on hover would take over the screen while the pointer merely crossed a list
   * of forty texts. Opening a dialog is an action, not a hover — pin that it is click-only. */
  // Match the LISTENER, not the word: the comment explaining why hover was dropped says "mouseenter".
  ok(!/addEventListener\('mouseenter'/.test(panel), 'it is click-only — no hover-to-open');
}

/* CROWD RECORDERS AS TEXT CONTAINERS (2026-08-19).
 *
 * Seth: crowd submissions must "mirror how texts are created in text folders on devices, exact same
 * folder structure, reparenting, etc as much as possible" — and share the code, "to avoid drift".
 * The worker does that by calling driveEnsureTextFolder with the crowd folder in the device
 * folder's place, so everything below is a consequence rather than new logic. What still needs
 * pinning is the GROUPING, because it used to work by accident.
 *
 * ⚠ THE ACCIDENT: a crowd folder was untagged and unroled directly under master, which is exactly
 * this function's definition of a device — so crowd recorders have always been listed as devices
 * without anyone deciding they should be. Tagging them role='crowd' would have SILENTLY DROPPED
 * them from the estate (the old filter excluded every role-tagged folder), taking every text inside
 * with them into the loose "no device" bucket. These assertions are what make that a test failure
 * rather than a researcher's recordings quietly moving groups. */
{
  console.log('\ncrowd folders are text containers, and are marked as such');
  const est = buildDriveEstate([
    dir('M', 'FlexText Uploads', '', { flextextRole: 'uploads-master' }),
    dir('D1', 'Phone A', 'M'),
    dir('C1', 'Crowd — Market survey', 'M', { flextextRole: 'crowd' }),
    dir('T1', 'Story one', 'D1', { flextextDoc: 'doc-1' }),
    dir('T2', 'Market survey — 2026-08-19 04:00', 'C1', { flextextDoc: 'sub-2' }),
    file('f1', 'story.flextext', 'T1', 2048),
    file('f2', 'crowd_market_2026.zip', 'T2', 4096),
  ]);
  const byName = new Map(est.devices.map((d) => [d.name, d]));
  ok(byName.has('Phone A') && byName.has('Crowd — Market survey'),
     'both a device folder and a crowd folder are listed as containers');
  ok(byName.get('Phone A').kind === 'device' && byName.get('Crowd — Market survey').kind === 'crowd',
     '...and `kind` is what distinguishes them, so the panel can refuse a crowd DESTINATION');

  const t2 = est.texts.find((t) => t.docId === 'sub-2');
  ok(!!t2, 'a crowd submission is a first-class text, found by the same flextextDoc tag');
  ok(t2 && t2.deviceFolderId === 'C1' && t2.device === 'Crowd — Market survey',
     '...attributed to its crowd recorder, so the storage view groups it there and not under "no device"');
  ok(t2 && t2.bytes === 4096, '...and its bytes roll up exactly as a device text\'s do');
  ok(t2 && t2.fromCrowd === true, '...and it is flagged as crowd-born');
  const t1 = est.texts.find((t) => t.docId === 'doc-1');
  ok(t1 && t1.fromCrowd === false, 'a device text is not');
}

/* The structural folders must STILL be excluded. This is the assertion the widened filter could
 * plausibly break: it now admits one named role, and admitting roles in general would put
 * "Unassigned" back in the device list — the precise bug the original filter was written for, where
 * every swept text appeared to be held by a device called "Unassigned". */
{
  console.log('\nwidening the container filter did not re-admit the structural folders');
  const est = buildDriveEstate([
    dir('M', 'FlexText Uploads', '', { flextextRole: 'uploads-master' }),
    dir('U', 'Unassigned', 'M', { flextextRole: 'unassigned' }),
    dir('C1', 'Crowd — X', 'M', { flextextRole: 'crowd' }),
  ]);
  const names = est.devices.map((d) => d.name);
  ok(!names.includes('Unassigned'), '"Unassigned" is not a container of its own');
  ok(!names.includes('FlexText Uploads'), '...nor is the master folder');
  ok(names.includes('Crowd — X'), '...but the crowd folder still is');
}

/* THE PROJECT FOLDER LAYER — three tree shapes, one function (plans/drive-as-truth.md §16.16/§16.23).
 *
 * The migration adds a level: master / <project> / <container> / <text>. The worker must be
 * deployable BEFORE any folder moves, so this function has to read the old tree, the new tree, and —
 * the case that decides the design — the HALF-MIGRATED tree an interrupted sweep leaves behind.
 *
 * ⚠ WRITING THE HALF-MIGRATED CASE IS WHAT CAUGHT THE BUG. The design first written down was
 * "containers are children of the projects, or of master when there are no projects" — swap the
 * parent set once projects exist. That is wrong the instant the FIRST project folder is created:
 * every container still under master stops matching and vanishes from the estate, taking its texts
 * and byte totals with it, for the whole duration of the sweep. Keeping master in the set always
 * costs nothing and removes the branch.
 */
{
  console.log('\nFLAT tree (today) — the output must be byte-identical to before projects existed');
  const flat = [
    dir('M', 'FlexText Uploads', '', { flextextRole: 'uploads-master' }),
    dir('U', 'Unassigned', 'M', { flextextRole: 'unassigned' }),
    dir('D1', 'Phone A', 'M'),
    dir('T1', 'Story one', 'D1', { flextextDoc: 'doc-1' }),
    file('f1', 'a.wav', 'T1', 1024),
  ];
  const est = buildDriveEstate(flat);
  ok(est.devices.length === 1 && est.devices[0].name === 'Phone A', 'the device is still a container');
  ok(est.devices[0].projectId === '', '...with an EMPTY projectId — the field appears, unset');
  ok(est.unassignedFolderId === 'U', 'unassignedFolderId still returns a single id for shipped panels');
  ok(est.projects.length === 0, 'and no projects are reported');
  const t = est.texts.find((x) => x.docId === 'doc-1');
  ok(t && t.device === 'Phone A' && t.bytes === 1024, 'the text is attributed and its bytes roll up as before');
}

{
  console.log('\nNESTED tree — containers group under their project');
  const nested = [
    dir('M', 'FlexText Uploads', '', { flextextRole: 'uploads-master' }),
    dir('P1', 'Fayu', 'M', { flextextRole: 'project' }),
    dir('P2', 'Kirikiri', 'M', { flextextRole: 'project' }),
    dir('U1', 'Unassigned', 'P1', { flextextRole: 'unassigned' }),
    dir('U2', 'Unassigned', 'P2', { flextextRole: 'unassigned' }),
    dir('D1', 'Phone A', 'P1'),
    dir('C1', 'Crowd — Market', 'P2', { flextextRole: 'crowd' }),
    dir('T1', 'Story one', 'D1', { flextextDoc: 'doc-1' }),
    dir('T2', 'Adrift', 'U2', { flextextDoc: 'doc-2' }),
    file('f1', 'a.wav', 'T1', 2048),
  ];
  const est = buildDriveEstate(nested);
  const byName = new Map(est.devices.map((d) => [d.name, d]));
  ok(byName.size === 2, 'both containers are found one level deeper');
  ok(byName.get('Phone A').projectId === 'P1', 'a device reports its project');
  ok(byName.get('Crowd — Market').projectId === 'P2', '...and so does a crowd recorder');
  ok(byName.get('Crowd — Market').kind === 'crowd', '...keeping its kind, so it stays a non-destination');
  ok(est.projects.length === 2, 'the projects themselves are reported for new clients');
  /* ⚠ THE STRUCTURAL-FOLDER RULE MUST SURVIVE THE DEEPER WALK. A per-project "Unassigned" sits
   * exactly where a container sits, so a filter that only looked at depth would list it as a device
   * and make every swept text look like it was held by a device called Unassigned. */
  ok(!byName.has('Unassigned'), 'a per-project Unassigned is NOT listed as a container');
  ok(!byName.has('Fayu') && !byName.has('Kirikiri'), '...nor are the project folders themselves');
  const t2 = est.texts.find((x) => x.docId === 'doc-2');
  ok(t2 && t2.inUnassigned === true, 'a text in the SECOND project\'s Unassigned is still recognised');
  ok(est.unassignedFolderIds.length === 2, 'both Unassigned folders are reported');
}

{
  console.log('\n⚠ HALF-MIGRATED tree — what an interrupted sweep leaves, and nothing may vanish');
  const half = [
    dir('M', 'FlexText Uploads', '', { flextextRole: 'uploads-master' }),
    dir('P1', 'Fayu', 'M', { flextextRole: 'project' }),
    dir('D1', 'Phone A', 'P1'),          // already moved
    dir('D2', 'Phone B', 'M'),           // NOT yet moved
    dir('T1', 'Story one', 'D1', { flextextDoc: 'doc-1' }),
    dir('T2', 'Story two', 'D2', { flextextDoc: 'doc-2' }),
    file('f1', 'a.wav', 'T1', 512),
    file('f2', 'b.wav', 'T2', 512),
  ];
  const est = buildDriveEstate(half);
  const names = est.devices.map((d) => d.name).sort();
  ok(names.join(',') === 'Phone A,Phone B',
     'BOTH containers survive — the moved one and the not-yet-moved one');
  ok(est.texts.length === 2, '...and so do both texts');
  ok(est.texts.every((x) => x.device), '...each still attributed to its container');
  const moved = est.devices.find((d) => d.name === 'Phone A');
  const notYet = est.devices.find((d) => d.name === 'Phone B');
  ok(moved.projectId === 'P1' && notYet.projectId === '',
     'and the difference is visible: one has a project, one does not yet');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
