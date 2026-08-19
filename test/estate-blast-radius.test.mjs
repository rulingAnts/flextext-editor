/* THE PROPERTY THAT MAKES THE PROJECT LAYER SAFE TO BUILD ON PRODUCTION.
 *
 * Seth agreed to develop the Drive project-folder layer directly against the production worker
 * rather than waiting for a staging backend, on ONE finding: getting it wrong breaks HIS DASHBOARD
 * and nothing else. A field device never sees the Drive tree — it resolves its own folder by an
 * opaque id through the worker and is handed back nothing but that id.
 *
 * ⚠ THAT IS A PROPERTY OF THE CURRENT CODE, NOT A LAW OF THE SYSTEM. The day somebody adds a
 * convenient `folders` field to a device-facing response, or calls buildDriveEstate from a second
 * route, the blast radius moves from a researcher's screen to a village — and nothing would say so.
 * The risk assessment the decision rests on would silently stop being true.
 *
 * So this file exists to make that a build failure. It is not testing behaviour; it is testing the
 * boundary the RISK ARGUMENT depends on.
 *
 * Run: node test/estate-blast-radius.test.mjs
 */
import { readFileSync } from 'node:fs';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const worker = readFileSync(new URL('../worker/src/v1.js', import.meta.url), 'utf8');

console.log('\nthe estate has exactly ONE consumer, and it is researcher-authed');
{
  // Definition + call sites. One of each is the whole assertion.
  const defs = [...worker.matchAll(/function buildDriveEstate\s*\(/g)].length;
  const calls = [...worker.matchAll(/buildDriveEstate\s*\(/g)].length - defs;
  ok(defs === 1, `buildDriveEstate is defined once (found ${defs})`);
  ok(calls === 1, `...and CALLED exactly once (found ${calls}) — a second caller moves the blast radius`);

  /* The one caller must be behind authResearcher. A device authenticates with authInstall; if the
   * estate ever became reachable that way, a compromised or buggy device would see the whole tree. */
  const at = worker.indexOf('buildDriveEstate(live)');
  const before = worker.slice(Math.max(0, at - 1200), at);
  ok(/authResearcher\(request, env\)/.test(before), 'its caller authenticates as a RESEARCHER');
  ok(!/authInstall\(/.test(before), '...and never as an install (a field device)');
}

console.log('\nno device-facing response carries folder STRUCTURE');
{
  /* A device receives `folderId` — one opaque id it echoes back on its next upload so the worker can
   * verify it by files.get. That is the entire Drive surface a device has, and it survives
   * re-parenting precisely because an id is not a location. Anything shaped like a tree would not. */
  const deviceLane = worker.slice(worker.indexOf("isub === 'upload'"), worker.indexOf("isub === 'upload'") + 12000);
  const returns = [...deviceLane.matchAll(/return j\(\{([^}]*)\}/g)].map((m) => m[1]).join(' | ');
  ok(returns.length > 0, 'the device upload lane has return statements to inspect');
  ok(!/estate|devices|tree|projects/i.test(returns),
     `no device response names an estate, device list, tree or project set`);
  ok(/folderId/.test(returns), '...they return only `folderId`, an opaque id the device echoes back');
}

console.log('\nthe id-before-parent resolution that makes re-parenting invisible');
{
  /* If either resolver ever looked at a PARENT before trusting a remembered id, re-parenting would
   * strand every device's memory — and would also re-open the v167 duplicate-folder bug, because a
   * parent-scoped search runs on Drive's eventually-consistent index. */
  const dev = worker.slice(worker.indexOf('async function driveEnsureDeviceFolder'));
  const devBody = dev.slice(0, dev.indexOf('\n}\n'));
  ok(devBody.indexOf('existingId') < devBody.indexOf('parents:'),
     'driveEnsureDeviceFolder checks the remembered id BEFORE it ever names a parent');
  ok(/files\/'\s*\+\s*encodeURIComponent\(existingId\)/.test(devBody),
     '...by files.get, which is strongly consistent');

  const txt = worker.slice(worker.indexOf('async function driveEnsureTextFolder'));
  const txtBody = txt.slice(0, txt.indexOf('\n}\n'));
  ok(txtBody.indexOf('knownId') < txtBody.indexOf('appProperties has'),
     'driveEnsureTextFolder honours the client-echoed id BEFORE falling back to the tag search');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
