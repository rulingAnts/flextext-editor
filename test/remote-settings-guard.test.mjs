/* A REMOTE COMMAND MAY NEVER SET A CONTROL-PLANE SETTING.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. The 2026-08-21 audit sweep found that a member holding only
 * `manageDevices` — the ONE capability v1 ships — could send
 *     { type: 'changeSettings', settings: { relayWorker: 'https://…' } }
 * and repoint a field device's entire backend. `settings.relayWorker` is what `workerBase()` returns:
 * the origin the device polls, reports to, and uploads to. The consequences were install credentials
 * captured on the next poll, every subsequent recording and transcription uploaded to the sender
 * instead of the owner's Drive, and a fabricated desired lane answering `{ wipe: true }` — which
 * sync.js honours "before every gate", destroying the device's work. A wipe, delegated by a
 * capability, when `check-project-scoping.sh` has a dedicated assertion that no capability can
 * delegate one. It was bypassed without ever touching the wipe route.
 *
 * ⚠ THE GUARD HAS TO LIVE ON THE DEVICE, and that is the part worth remembering. Settings are E2EE:
 * the worker stores ciphertext and cannot inspect what it forwards, so it can NEVER allow-list these
 * keys. The device is the only place they exist in the clear. The worker's matching check — that a
 * payload must be encrypted — is defence in depth, not the fix, and it is covered by the rig.
 *
 * ⚠ SOURCE-LEVEL ASSERTIONS, deliberately. The dispatch lives inside a switch in app.js, which is a
 * browser module with side effects at import; the same technique as worker-ownership-scoping. The
 * assertions are written to fail on the REFACTOR that would reintroduce the bug, not merely on the
 * literal text — the load-bearing one is that the merge consumes the FILTERED object.
 *
 * Run: node test/remote-settings-guard.test.mjs
 */
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const sync = readFileSync(new URL('../docs/js/sync.js', import.meta.url), 'utf8');

console.log('\nthe key is genuinely control-plane — otherwise the rest of this proves nothing');
{
  ok(/function workerBase\(\)[\s\S]{0,200}settings\.relayWorker/.test(app),
     '⚠ workerBase() reads settings.relayWorker, so setting it redirects the device');
  ok(/iface\.workerBase\(\)/.test(sync),
     'and sync.js routes through workerBase() — the poll, the report lane and the uploads');
  ok(/if \(r\.wipe\)/.test(sync),
     '⚠ and the desired lane honours a wipe, so a redirected device can be told to erase itself');
}

console.log('\nthe dispatch refuses control-plane keys rather than merging them');
{
  ok(/REMOTE_FORBIDDEN\s*=\s*\[[^\]]*'relayWorker'/.test(app),
     '⚠⚠ relayWorker is refused from a pushed settings patch');

  /* THE LOAD-BEARING ASSERTION. `Object.assign(s, cmd.settings ...)` is the original bug, and it is
   * what a well-meaning simplification would restore. The merge must consume the FILTERED object. */
  ok(!/Object\.assign\(\s*s\s*,\s*cmd\.settings/.test(app),
     '⚠⚠ the merge does NOT consume cmd.settings directly — that is the exact line the attack used');
  ok(/Object\.assign\(\s*s\s*,\s*patch\s*\)/.test(app),
     'it consumes the filtered patch instead');

  const guard = app.slice(app.indexOf('REMOTE_FORBIDDEN'), app.indexOf('REMOTE_FORBIDDEN') + 900);
  ok(/delete patch\[k\]/.test(guard), 'the forbidden keys are removed from the patch before it is applied');
  ok(/settingsKeyRefused|console\.warn/.test(guard),
     '⚠ and the refusal is ANNOUNCED — a researcher who pushed one has to know it did not apply');
}

console.log('\nthe refusal is remote-only: setting it locally still works');
{
  ok(/delete settings\.relayWorker/.test(app),
     'the local override is still clearable from the app — this restricts the REMOTE lane, not the setting');
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
