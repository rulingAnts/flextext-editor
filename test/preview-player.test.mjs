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
    ok(/bytes=0-4095/.test(serve),
       'the header probe reads 4 KB — our own crowd WAVs are BWF, data past a ~900-byte bext');
    ok(/content-length', String\(44 \+ plan\.outBytes\)/.test(serve),
       'the decimated shape promises an exact content-length before the first body byte');
    /* ⚠ TRUNCATION IS NOT UNIVERSAL (Seth: "some wav, some mp3, some m4a"). MP3 frames and OGG
     * pages play from a head; MP4/M4A can carry its `moov` index at the END, so a truncated one
     * may not decode at all. Those must be served whole. */
    ok(/audio\\\/\(mpeg\|mp3\|ogg\|opus\)/.test(serve) || /mpeg\|mp3\|ogg\|opus/.test(serve),
       'only frame/page containers are truncated to a head');
    ok(/truncatable \? 'bytes=0-262143' : 'bytes=0-'/.test(serve),
       '...everything else (m4a, flac, unknown) is served WHOLE rather than broken');
  }

  /* ⚠ NOT A MODAL (Seth, 2026-08-31, after using the first build): "instant, rapid, preview play,
   * like Apple Music/iTunes … if another one is clicked the first one stops, toggle play/pause
   * once loading has finished". The row's button IS the transport; there is nothing to close. */
  console.log('\npanel: one player for the whole panel, driven from the row button');
  {
    ok(!/openPreviewModal/.test(panel), 'the modal player is gone entirely');
    ok(/let prevAudio = null;/.test(panel) && /prevAudio = new Audio\(\)/.test(panel),
       'a SINGLE detached <audio> serves every row — so a second click stops the first by construction');
    const start = (panel.match(/async function startPreview[\s\S]*?\n\}\n/) || [''])[0];
    ok(/stopPreview\(\);\s+\/\/ whatever was playing stops/.test(start),
       'starting a preview stops whatever was playing');
    const toggle = (panel.match(/function togglePreview[\s\S]*?\n\}/) || [''])[0];
    ok(/prevAudio\.paused/.test(toggle) && /prevAudio\.pause\(\)/.test(toggle),
       'clicking the SAME row toggles play/pause rather than restarting');
    ok(/const mine = \+\+prevToken/.test(start) && /const live = \(\) => mine === prevToken/.test(start),
       'a slow resolve landing after a newer click is discarded (no ghost audio)');
    ok(/function stopPreviewIfDetached[\s\S]*?prevBtn\.isConnected/.test(panel)
       && /stopPreviewIfDetached\(\);/.test(panel),
       'a repaint that removes the playing button stops the sound — the 12s poll rebuilds rows');
    ok(/icon\.textContent = state === 'playing' \? '⏸'/.test(panel),
       'the button icon carries all three states (idle / loading / playing)');
    ok(/fetchDriveFile\(f\.id/.test(start), 'the original-download fallback exists (old worker ⇒ heavier, still works)');
    ok(/addEventListener\('error', \(\) => \{ if \(live\(\)\) playFull\(f\); \}, \{ once: true \}\)/.test(start),
       'a preview head that will not decode falls back to the full original, once');
  }

  console.log('\npanel: a preview is a TASTE, and says so');
  {
    ok(/const PREVIEW_MAX_SECONDS = 35;/.test(panel),
       'the fallback paths stop at ~35s too, so every source behaves like the worker’s 30s head');
    ok(/currentTime >= PREVIEW_MAX_SECONDS\) stopPreview\(\)/.test(panel), '...enforced on timeupdate');
    const i18n = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
    const tip = (i18n.match(/'panel\.prev\.tip': '([^']*)'/) || [])[1] || '';
    ok(/low-bandwidth preview, not the original/.test(tip),
       'the button says plainly that this is a preview, not the archival file');
    ok((i18n.match(/'panel\.prev\.tip':/g) || []).length === 2, '...in both languages');
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
