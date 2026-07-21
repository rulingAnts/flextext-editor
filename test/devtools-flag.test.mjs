/* Whether a packaged desktop build ships with Developer Tools enabled.
 *
 * WHY THIS IS WORTH A TEST: the desktop renderer runs REMOTE content with a native bridge attached.
 * DevTools is a console with that bridge in scope, on a machine used by someone who cannot judge
 * what is safe to paste into it — "run this to fix your problem" is a plausible thing for a stranger
 * to say. So the release default must be OFF, and it must stay OFF through every way this can go
 * wrong: no flags file, an unreadable one, malformed JSON, or a value that merely looks true.
 *
 * The whole point is the failure DIRECTION. A bug that leaves devtools off in a test build is an
 * inconvenience; a bug that turns them on in a field build is a security regression nobody would
 * notice, because everything still works.
 *
 * Run: node test/devtools-flag.test.mjs
 */
import { createRequire } from 'node:module';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);
const { devToolsAllowed } = require_('../electron/src/flags.js');

const dir = mkdtempSync(join(tmpdir(), 'flextext-flags-'));
const file = join(dir, 'build-flags.json');
const write = (c) => writeFileSync(file, typeof c === 'string' ? c : JSON.stringify(c));

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const noEnv = {};

console.log('\noff unless explicitly asked for (the release path)');
try { unlinkSync(file); } catch { /* already absent */ }
ok(devToolsAllowed({ env: noEnv, file }) === false, 'no flags file at all -> OFF');
write({ devTools: false });
ok(devToolsAllowed({ env: noEnv, file }) === false, 'flags say false -> OFF');
write('{ not valid json');
ok(devToolsAllowed({ env: noEnv, file }) === false, 'malformed JSON -> OFF, not a crash');
write({});
ok(devToolsAllowed({ env: noEnv, file }) === false, 'flags file with no devTools key -> OFF');
ok(devToolsAllowed({ env: noEnv, file: join(dir, 'nope', 'deeper.json') }) === false,
   'unreadable path -> OFF');

console.log('\nnothing that merely LOOKS true may enable it');
for (const v of ['true', 1, 'yes', [], {}, 'TRUE']) {
  write({ devTools: v });
  ok(devToolsAllowed({ env: noEnv, file }) === false,
     `devTools: ${JSON.stringify(v)} (truthy but not boolean true) -> OFF`);
}

console.log('\non only when genuinely requested');
write({ devTools: true });
ok(devToolsAllowed({ env: noEnv, file }) === true, 'devTools: true -> ON (a test build)');
write({ devTools: false });
ok(devToolsAllowed({ env: { FLEXTEXT_DEVTOOLS: '1' }, file }) === true,
   'FLEXTEXT_DEVTOOLS=1 -> ON (running from source)');
ok(devToolsAllowed({ env: { FLEXTEXT_DEVTOOLS: 'true' }, file }) === false,
   'FLEXTEXT_DEVTOOLS=true (not "1") -> OFF — the escape hatch is exact too');

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASS: developer tools stay off unless a build asked for them.\n');
process.exit(fail ? 1 : 0);
