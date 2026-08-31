/* THE PREVIEW PLAYER'S CONTRACT, both halves (v533, Seth's design conversation of 2026-08-31):
 *
 *   - The worker mints SHORT-lived header-less URLs (an <audio> element cannot send auth
 *     headers), and serves a token whose x === 'preview' as a low-bandwidth HEAD — the PCM
 *     decimator (worker/src/preview.js, its own unit suite) or the raw first 256 KB. The member
 *     lane keeps every guard the file-streaming route has: doc gate, belongs-to-doc walk, scoped
 *     revocable token stamped with its minter.
 *   - The panel plays the lightest thing available and DIES WITH ITS MODAL ("have it stop
 *     playing the moment it's closed"); the crowd pre-cache is idle-time, capped, evicting, and
 *     disables itself entirely against an old worker rather than pre-fetching full originals
 *     ("the rest of the app working smoothly matters more").
 *
 * Source pins — the panel cannot be imported under plain node, and the worker's serve path needs
 * real Drive. The decimator itself is exercised for real in preview-decimator.test.mjs.
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

test('preview player contract', () => {
  const worker = readFileSync(new URL('../worker/src/v1.js', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
  const res = readFileSync(new URL('../docs/js/researcher.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');

  console.log('\nworker: the mint routes are short-lived and guarded');
  {
    ok(/seg\[4\] === 'preview-url'/.test(worker) && /seg\[7\] === 'preview-url'/.test(worker),
       'both lanes exist (owner drive-file, member instance/texts/files)');
    const mints = worker.match(/mintTextfileUrl\([^)]*'preview', 3600000/g) || [];
    ok(mints.length === 2, `both mint with a ONE-HOUR TTL, not ninety days (${mints.length}/2)`);
    const memberMint = (worker.match(/seg\[7\] === 'preview-url'[\s\S]{0,1600}/) || [''])[0];
    ok(/authorizeDocForProject/.test(memberMint) && /driveFileBelongsToDoc/.test(memberMint),
       'the member lane keeps the doc gate AND the belongs-to-doc walk');
    ok(/\{ instanceId, docId \}, ctx\.caller\.researcher_id/.test(memberMint),
       '...and mints SCOPED, stamped with its minter (revocation invariants I2 hold)');
    ok(/if \(tk\.x === 'preview'\) return await servePreviewHead/.test(worker),
       'a preview token short-circuits BEFORE the whole-file fetch');
  }

  console.log('\nworker: the head degrades to heavier, never to wrong bytes');
  {
    const serve = (worker.match(/async function servePreviewHead[\s\S]*?\n\}/) || [''])[0];
    ok(/bytes=0-262143/.test(serve), 'non-PCM sources fall back to the raw first 256 KB');
    ok(/content-length', String\(44 \+ plan\.outBytes\)/.test(serve),
       'the decimated shape promises an exact content-length before the first body byte');
  }

  console.log('\npanel: the player dies with its modal');
  {
    const open = (panel.match(/async function openPreviewModal[\s\S]*?\n\}/) || [''])[0];
    ok(/audioEl\.pause\(\)/.test(open) && /URL\.revokeObjectURL/.test(open) && /removeAttribute\('src'\)/.test(open),
       'onClose pauses, detaches, and revokes — every close path (modal() contract)');
    ok(/if \(!m\.el\.isConnected\) return/.test(open),
       'a modal closed mid-resolve never starts playing');
    ok(/fetchDriveFile\(f\.id/.test(open), 'the original-download fallback exists (old worker ⇒ heavier, still works)');
  }

  console.log('\npanel: the pre-cache can never cost the page');
  {
    const sweep = (panel.match(/function sweepCrowdPreviews[\s\S]*?\n\}/) || [''])[0];
    ok(/saveData/.test(sweep) && /2g/.test(sweep), 'data-saver and 2G connections are skipped');
    ok(/requestIdleCallback/.test(sweep), 'it waits for idle time');
    ok(/prevMintDead = true; break/.test(sweep),
       'an old worker DISABLES the sweep — full originals are never pre-fetched');
    ok(/prevCache\.delete\(k\)/.test(sweep), 'a deleted text drops its cached audio (Seth’s rule)');
    ok(/\.slice\(0, 12\)/.test(sweep), 'bounded per sweep');
    ok((panel.match(/sweepCrowdPreviews\(crowdCache, estateCache\)/g) || []).length >= 1,
       'and it actually runs after dashboard renders');
  }

  console.log('\nclient plumbing: refusals fall back, they do not error');
  {
    const pu = (res.match(/export async function previewUrl[\s\S]*?\n\}/) || [''])[0];
    ok(/if \(!r\.ok\) return null/.test(pu) && /catch \{ return null; \}/.test(pu),
       'previewUrl answers null to every refusal — the caller’s fallback is the handling');
  }

  console.log('\nthe typed speaker name rides only when present, and is sanitised server-side');
  {
    ok(/name: item\.speaker/.test(app), 'the crowd start body carries the typed name');
    ok(/function crowdSpeakerName/.test(worker) && /slice\(0, 60\)/.test(worker),
       'the worker sanitises + caps it before it becomes a Drive folder name');
    ok(/driveEnsureCrowdTextFolder\(env, access, rec, subId, now, body\.name\)/.test(worker),
       'the chunked start path passes it through; the legacy single-POST path stays untouched');
    ok(/function crowdRowLabel/.test(panel) && /prefix \+ ' — ' \+ when/.test(panel),
       'the panel row leads with the name when the title carries one');
  }

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) throw new Error(`${fail} check(s) failed`);
});
