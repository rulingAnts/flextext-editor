/* The two-lane upload split (assign-by-upload rule 4).
 *
 * WHY THIS IS WORTH A TEST: the lanes replace hold-until-finished, and every rule here is a
 * data-safety rule. Lane A (recording + consent zip, ASAP) is the only way a take now leaves the
 * device; Lane B (bare flextext) is the only thing that certifies the TEXT as backed up. Cross
 * the wires — a media zip stamping the backup proof, an assigned recording re-uploading, a lane
 * record losing its wire identity — and either field data silently never leaves, or delete-safety
 * trusts an upload that never carried the text.
 *
 * app.js cannot run under node (DOM at module scope, by design) — regex-pin technique, same as
 * assign-intake.test.mjs. upload.js's wire rule is pinned the same way.
 *
 * Run: node test/upload-lanes.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const app = read('../docs/js/app.js');
const up = read('../docs/js/upload.js');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

console.log('\nLane A fires the moment a recording is saved');
{
  const save = app.match(/async function saveRecording\(\) \{([\s\S]*?)\n\}/);
  ok(!!save, 'saveRecording present');
  ok(!!save && /await queueMediaUpload\(newId\)/.test(save[0]), 'saveRecording queues the media upload for the new doc');
  ok(!!save && /newId && Sync\.workerUploadTarget\(\)/.test(save[0]),
     'but only on a researcher-linked device (standalone devices have no upload target)');
  ok(/const newId = await newDocFromAudio\(file, title\)/.test(app), 'the new doc id comes back from newDocFromAudio');
}

console.log('\nLane A is the SOURCE PACKAGE: individual role-tagged files in originals/, never a zip');
{
  const q = app.match(/async function queueMediaUpload\(docId\) \{([\s\S]*?)\n\}/);
  ok(!!q, 'queueMediaUpload present');
  const body = q ? q[1] : '';
  ok(/if \(isAudioLocked\(rec\)\) return false;/.test(body), 'assigned-from-Drive audio NEVER rides an upload');
  ok(/if \(rec\.mediaUploaded \|\| rec\.sourcePackaged\) return false;/.test(body),
     'a package that was already queued is never queued twice');
  ok(/const key = 'media:' \+ docId;/.test(body), "queued under its own 'media:' key, beside the Lane B record");
  ok(/docDone: false,/.test(body), 'docDone:false — a source file can never trigger auto-delete of the text');
  ok(/docId, lane: 'media',/.test(body), 'the wire docId rides IN the record (the key is not the identity)');
  // v2: the zip is gone. Each piece is its own retrying record, in the originals/ child, tagged.
  ok(!/makeZip/.test(body), 'no zip: the pieces upload individually so the whole suite can see them');
  ok(/sub: 'originals', role: p\.role,/.test(body), "every part declares sub:'originals' + its role tag");
  ok(/role: 'source-audio'/.test(body), 'the recording is tagged source-audio');
  ok(/upload:' \+ k/.test(body), 'one persistent queue record PER PART, so each retries on its own');

  // The manifest is the completeness contract, and it must be queued FIRST.
  const manifestAt = body.indexOf("slot: 'manifest'");
  const audioAt = body.indexOf("slot: 'audio'");
  ok(manifestAt > 0, 'a manifest part exists');
  ok(/const queue = \[\s*\{ slot: 'manifest'/.test(body),
     'and it heads the queue — written FIRST, so a consumer can NAME what has not arrived yet');
  ok(audioAt > 0, 'the audio part exists too');
  ok(/\<Storyname\>|sanitizeBase\(rec\.title\)/.test(body), 'the audio is named from the story title');
  ok(/consent-receipt\.json/.test(body) && /'consent:' \+ docId/.test(body) && /'consent-prompt:' \+ docId/.test(body),
     'the consent clip, prompt and receipt all travel with the take');
}

console.log('\nLane A completion stamps mediaUploaded — never the text backup proof');
{
  const m = app.match(/if \(String\(docId\)\.startsWith\('media:'\)\) \{([\s\S]*?)\n {8}\}/);
  ok(!!m, "the completion handler has a 'media:' branch");
  const body = m ? m[1] : '';
  ok(/d\.mediaUploaded = true/.test(body), 'it stamps mediaUploaded');
  ok(!/uploadedFileId|uploadedSig|uploadedModified/.test(body),
     'and NEVER uploadedFileId/uploadedSig/uploadedModified (delete-safety certifies the TEXT)');
  ok(/if \(st\.folderId\) d\.driveFolderId = st\.folderId/.test(body), 'the folder echo still lands (dedupe)');
}

console.log('\nLane B: an upload is the BARE flextext, never zipped');
{
  const fn = app.match(/async function buildBundleFor\(([\s\S]*?)\n\}/);
  ok(!!fn, 'buildBundleFor present');
  const body = fn ? fn[0] : '';
  const laneB = body.match(/if \(!opts\.full\) \{([\s\S]*?)\n {2}\}/);
  ok(!!laneB, 'the non-full (upload) path is its own early return');
  ok(!!laneB && /zipped: false/.test(laneB[1]) && /\.flextext`/.test(laneB[1]), 'and returns a bare .flextext');
  ok(!!laneB && !/makeZip/.test(laneB[1]), 'no zip on the upload path');
  /* v3: the reference is still ORIGINAL-vs-working-copy, but BOTH names are now derived from the
   * story title (mediaNameFor / derivedWavName) instead of read off the stored media record — an
   * assigned text's media.name was the delivery token. See test/media-filenames.test.mjs. */
  ok(!!laneB && /isAudioLocked\(rec\) \? mediaNameFor\(base, media\) : segMediaName/.test(laneB[1]),
     'assigned/locked docs reference the ORIGINAL media name, others the working copy');
  ok(!/media\.name \|\| 'audio'/.test(body), 'and no upload name is read straight off the stored media record');
  ok(/full: !!opts\.full/.test(body) || /opts\.full/.test(body), 'local saves (opts.full) still take the full bundle path');
}

console.log('\nqueue records stay backward-readable across the engine update');
{
  ok((up.match(/rec\.docId \|\| this\.docId/g) || []).length >= 2,
     'upload.js sends rec.docId falling back to the queue key — BOTH wire paths (single POST + chunked start)');
  ok(/startsWith\('upload:'\)/.test(up), "listPendingUploads still sweeps every 'upload:' key, lane records included");
}

console.log('\narrival progress: real bytes, light ticker');
{
  ok(/d\.pendingAudio/.test(app.match(/async function renderDocList[\s\S]*?renderWsBanner\(\);\n\}/)[0]),
     'the doc list renders an arriving row for pendingAudio');
  const tick = app.match(/function syncArrivalTicker\(\) \{([\s\S]*?)\n\}/);
  ok(!!tick, 'the arrival ticker exists');
  ok(!!tick && /clearInterval\(arrivalTicker\)/.test(tick[1]), 'and STOPS itself when nothing is downloading');
  ok(/getDownload\(docId\)/.test(app.match(/function paintArrivalRow\([\s\S]*?\n\}/)[0]),
     "progress comes from the downloader's own received/total");
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
