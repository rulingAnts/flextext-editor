/* ?devreset — where the hard wipe may run, and where it must refuse.
 *
 * devReset() calls eraseAllData(): the corpus IndexedDB, credentials, settings, caches and the
 * service worker, with NO confirmation step. A ?devreset link is an ordinary link — forwarded into
 * a WhatsApp group and tapped by a field worker, an honoured one destroys work that has not been
 * uploaded yet. So the host gate is a data-safety boundary, not a developer convenience, and the
 * production origins have to stay off the list however convenient it would be during a test.
 *
 * (The gate is also why Seth saw ?devreset "keep" a pairing session on staging: it had never run
 * there. Staging is now allowed and a refusal is no longer silent — both pinned below.) */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(root, 'docs/js/app.js'), 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

/* Run the real predicate rather than describing it: the source is lifted out and evaluated with a
 * stub isDevHost, so these are the function's ACTUAL answers, not a regex's opinion of them. */
const src = (app.match(/function devResetAllowed\(h\) \{[\s\S]*?\n\}/) || [''])[0];
const isDevHostSrc = (app.match(/function isDevHost\(h\) \{[\s\S]*?\n\}/) || [''])[0];
const allowed = new Function(`${isDevHostSrc}\n${src}\nreturn devResetAllowed;`)();

console.log('the wipe is reachable where testing happens');
{
  ok(!!src, 'devResetAllowed exists as its own predicate');
  for (const h of ['localhost', '127.0.0.1', 'dev.local', '192.168.1.9', '10.0.2.2']) {
    ok(allowed(h) === true, `allowed on ${h}`);
  }
  for (const h of ['staging-flextext-editor.68mh29kgsd.workers.dev',
                   'staging-flextext-researcher.68mh29kgsd.workers.dev',
                   'segmentation2-flextext-editor.68mh29kgsd.workers.dev']) {
    ok(allowed(h) === true, `allowed on the preview estate: ${h.split('.')[0]}`);
  }
}

console.log('\n…and REFUSED on every origin a field device can be on');
{
  /* ⚠ If one of these ever flips to true, a forwarded link can wipe a real corpus. */
  for (const h of ['flextext.app', 'www.flextext.app', 'connect.flextext.app', 'research.flextext.app',
                   'crowd.flextext.app', 'pat.flextext.app', 'rulingants.github.io']) {
    ok(allowed(h) === false, `refused on ${h}`);
  }
  ok(allowed('') === false && allowed(undefined) === false, 'and on a missing hostname');
  /* Not a substring match: an attacker-shaped lookalike must not pass for the preview estate. */
  ok(allowed('workers.dev.evil.example') === false, 'the preview check is an ENDING, not a substring');
}

console.log('\nthe gate is devreset\'s own, and a refusal is never silent');
{
  /* isDevHost also gates the service worker — widening IT to reach staging would change caching on
   * the preview estate as a side effect, which is why devreset carries its own predicate. */
  ok(/const isDev = isDevHost\(location\.hostname\)/.test(app),
     'isDevHost still gates the service worker, untouched by the devreset widening');
  ok(/if \(devResetAllowed\(location\.hostname\)\) \{ devReset\(\); return; \}/.test(app),
     'setup() asks the devreset predicate, not isDevHost');
  ok(/console\.warn\('\[flextext\] \?devreset ignored on this host/.test(app),
     'an ignored ?devreset says so — silence read as a wipe that failed');
}

console.log(failures ? `\nFAILED (${failures})` : '\nall passed');
process.exit(failures ? 1 : 0);
