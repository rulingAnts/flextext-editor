/* A DEVICE MUST NEVER BE LEFT WITH NO WAY TO GET ITS WORK OFF.
 *
 * Seth reasoned this one out before it bit anyone (2026-08-14): "if I pair a device, set it to
 * upload only, and then unpair it, the last setting it had was 'upload'. Will it automatically
 * enable the defaults for an unpaired app at that point?"
 *
 * It did not. `sendOptions` is a PERSISTED device setting and unpairing does not touch it, so an
 * upload-only device that loses its pairing computed share:false, upload:false (no target),
 * save:false — and updateShareButton hid the whole Send button. Hours of transcription, sitting in
 * IndexedDB, with no route out and nothing on screen explaining why.
 *
 * The rule this pins: when NOTHING is possible, saving becomes possible. It is the one route that
 * needs no server, no pairing, and no permission from anyone.
 *
 * ⚠ MODELLED, NOT MOCKED. sendCapabilities lives in app.js, which cannot be imported outside a
 * browser — so this reimplements its LOGIC from the source text it asserts against, and fails if the
 * source stops matching. That is weaker than calling the real function and stronger than nothing;
 * the browser half is test/browser/unpaired-queue.playwright.mjs.
 *
 * Run: node test/send-capability-trap.test.mjs
 */
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const SEND_OPTIONS = ['share', 'upload', 'save'];

/* The model, mirroring allowedSend() + sendCapabilities() including the guard. */
function caps({ sendOptions, paired, canShare }) {
  const stored = sendOptions && sendOptions.length ? sendOptions : SEND_OPTIONS;
  const allow = new Set(stored);
  if (allow.has('download')) allow.add('save');
  const c = {
    share: allow.has('share') && canShare,
    upload: allow.has('upload') && paired,
    save: allow.has('save'),
  };
  if (!c.share && !c.upload && !c.save) c.save = true;   // the guard under test
  return c;
}
const anyRoute = (c) => c.share || c.upload || c.save;

console.log('\nthe trap Seth described: upload-only, then unpaired');
{
  const paired = caps({ sendOptions: ['upload'], paired: true, canShare: true });
  ok(paired.upload && !paired.save && !paired.share,
     'while PAIRED, an upload-only device is exactly that — the restriction is honoured in full');
  const unpaired = caps({ sendOptions: ['upload'], paired: false, canShare: true });
  ok(anyRoute(unpaired), 'and once UNPAIRED it still has a way to get the work off the device');
  ok(unpaired.save, '…which is Save — no server, no pairing, no permission from anyone');
  ok(!unpaired.upload, 'upload stays off, because there is genuinely nowhere to send it');
}

console.log('\nthe older instance of the same trap: share-only where the browser cannot share');
{
  // Desktop Firefox has no navigator.share for files. app.js documents this case as a bug it fixed
  // by HIDING the button — which strands the work just as thoroughly.
  const stuck = caps({ sendOptions: ['share'], paired: true, canShare: false });
  ok(anyRoute(stuck), 'a share-only device on a browser with no share can still save its work');
}

console.log('\nthe guard is a LAST RESORT and changes nothing else');
{
  ok(!caps({ sendOptions: ['upload'], paired: true, canShare: true }).save,
     'a working upload-only device does NOT get an extra Save button');
  ok(!caps({ sendOptions: ['share'], paired: false, canShare: true }).save,
     'a share-only device that CAN share is untouched by it');
  const all = caps({ sendOptions: [], paired: true, canShare: true });
  ok(all.share && all.upload && all.save, 'and an unrestricted device is unaffected');
}

console.log('\nthe rule is in the source, not just in this model');
{
  const fn = (app.match(/function sendCapabilities\(\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(/if \(!caps\.share && !caps\.upload && !caps\.save\) caps\.save = true;/.test(fn),
     'sendCapabilities carries the guard');
  ok(/upload: allow\.has\('upload'\) && !!Sync\.workerUploadTarget\(\)/.test(fn),
     '…and still gates upload on a REAL target, which is what makes the trap reachable at all');
  /* Being unlinked must also be SAID. The device used to clear its session on a 410 and tell nobody,
   * so the upload option vanished and a Save option appeared with no event tying them together. */
  ok(/sync\.revokedNotice/.test(app), 'and the device says so when it is unlinked');
  ok(/onStatus: \(kind\) => \{/.test(app) && /kind !== 'revoked'/.test(app),
     '…through the status hook that used to be an empty function');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
