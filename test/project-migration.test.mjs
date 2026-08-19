/* THE PROJECT MIGRATION — insert the folder layer, and take it back out.
 *
 * This is the first thing in the whole drive-as-truth programme that MOVES a researcher's folders.
 * Everything before it either read Drive or wrote new files. So the properties that make it safe to
 * run on a live estate are worth asserting rather than trusting:
 *
 *   1. DRY BY DEFAULT — a caller that forgets the flag previews. A migration tool that acts before
 *      you have read its plan is how a tangle becomes a disaster (§17.3).
 *   2. A dry run creates NOTHING, not even the project folder. "Dry except for one folder" is not dry,
 *      and it is exactly the kind of exception that makes a preview untrustworthy.
 *   3. It only ever RE-PARENTS. Metadata only, no bytes move, ids preserved — which is why every id
 *      in D1, in a client's memory and in a minted URL survives it (§16.21).
 *   4. It is REVERSIBLE, and the reverse is a real route rather than a hypothesis (§17.5).
 *
 * Run: node test/project-migration.test.mjs
 */
import { readFileSync } from 'node:fs';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const root = new URL('../', import.meta.url);
const worker = readFileSync(new URL('worker/src/v1.js', root), 'utf8');
const rjs = readFileSync(new URL('docs/js/researcher.js', root), 'utf8');
const route = worker.slice(worker.indexOf("seg[3] === 'migrate' || seg[3] === 'unmigrate'"));
const body = route.slice(0, route.indexOf("seg[3] === 'rename'"));
const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\ndry by default — acting must be deliberate');
{
  ok(/const dry = body\.dry !== false;/.test(code),
     'dry defaults to TRUE: only an explicit dry:false moves anything');
  /* THE ASSERTION THAT MATTERS FOR TRUST: a dry run must not create the project folder either. */
  const dryBranch = code.slice(code.indexOf('if (dry) {'), code.indexOf('const target ='));
  ok(!/driveEnsureDefaultProject/.test(dryBranch),
     '...and a dry run creates NOTHING — not even the project folder it would use');
  ok(/wouldCreateProject/.test(body), '...it REPORTS that it would create one instead');
  ok(/moves: plan/.test(code), 'the preview lists the exact folders it would move');
}

console.log('\nit re-parents, and never deletes');
{
  ok(/driveReparent\(access, movers\[i\]\.id, target/.test(code), 'migrate re-parents each container');
  ok(/driveReparent\(access, back\[i\]\.id, master/.test(code), 'unmigrate puts them back under master');
  /* The ONE deletion-shaped act, and its guard. Trashing a project folder that still held containers
   * would strand them; trash is also reversible for 30 days, unlike drive-purge. */
  const trashPart = code.slice(code.indexOf('let trashedProject'));
  ok(/if \(!\(left\.files \|\| \[\]\)\.length\)/.test(trashPart),
     'the project folder is trashed ONLY when verified empty');
  ok(/trashed: true/.test(trashPart) && !/files\.delete|method: 'DELETE'/.test(code),
     '...and TRASHED, never permanently deleted — the 30-day net stays available');
}

console.log('\nit cannot move a text, only containers');
{
  ok(/!\(f\.appProperties \|\| \{\}\)\.flextextDoc/.test(code),
     'anything carrying a flextextDoc tag is excluded — texts stay where they are');
  ok(/roleOf\(f\) !== 'project'/.test(code), '...and the project folder does not move itself into itself');
}

console.log('\nbounded, like every other Drive loop in this file');
{
  ok(/const CAP = 20;/.test(code), 'a cap exists');
  ok(/remaining: Math\.max\(0, movers\.length - i\)/.test(code),
     '...and what it did not reach is reported, so a large estate drains rather than dying halfway');
}

console.log('\nrename is display-only and cannot orphan anything');
{
  const ren = worker.slice(worker.indexOf("seg[3] === 'rename'"));
  const renBody = ren.slice(0, ren.indexOf('\n  }\n'));
  ok(/!== 'project'\) return j\(\{ error: 'not_a_project' \}/.test(renBody),
     'it refuses any folder that is not tagged as a project');
  ok(/\{ name \}\)/.test(renBody) && !/appProperties/.test(renBody.split('PATCH')[1] || ''),
     '...and changes only the NAME, never the tags that are the real identity');
}

console.log('\nthe client wrappers exist and inherit the safe default');
{
  for (const f of ['projectsMigrate', 'projectsUnmigrate', 'projectRename']) {
    ok(new RegExp(`export function ${f}\\(`).test(rjs), `${f} is exported`);
  }
  ok(/retry: false/.test(rjs.slice(rjs.indexOf('projectsMigrate'))),
     'migrate does not blind-retry — a lost response must not re-run a folder move');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
