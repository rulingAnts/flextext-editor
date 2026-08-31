/* AN UNASSIGNED TEXT IN FLIGHT STAYS IN THE LIST IT LEFT FROM (issue #14, Brian's case 2).
 *
 * His report, precisely: moving an unassigned text to a device in ANOTHER project made it "not show
 * up in Unassigned (Project1). It disappears from there", while moving one to a device in the SAME
 * project correctly kept showing it with "on its way…". Both should look the same, and the
 * same-project case only looked right by accident — its projectId did not change.
 *
 * The cause: adopting re-parents the Drive folder to the destination FIRST and the device fetches it
 * later. In between, the text's own `projectId` names a project it has not reached, and the source
 * project's Unassigned card — which filters on exactly that field — stops listing it.
 *
 * ⚠ THE FAILURE MODE THIS MUST NEVER CAUSE is the opposite one. If a remembered origin is honoured
 * blindly and that project is gone (deleted, or the id stale from an older build), the text matches
 * NEITHER card and vanishes from the panel entirely — which is worse than the bug, and against the
 * rule renderUnassignedCard states at length: an in-flight text is SHOWN AND LOCKED, never hidden.
 * So the function is executed here against a fake estate, not merely pattern-matched.
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');

/* researcher-panel.js cannot be imported under plain node (panel-collapse.test.mjs's note), so the
 * pure function is extracted and given the two module-level things it reads. */
function loadHomeFn({ projects, pending }) {
  const src = (panel.match(/function unassignedHomeProject\(tx\) \{[\s\S]*?\n\}/) || [''])[0];
  if (!src) throw new Error('unassignedHomeProject not found');
  const make = new Function('estateCache', 'pendingCmds', `${src}; return unassignedHomeProject;`);
  return make({ projects }, new Map(pending));
}

test('an in-flight unassigned text keeps its source project', () => {
  const P1 = 'folder-project-1';
  const P2 = 'folder-project-2';
  const projects = [{ folderId: P1, name: 'Project1' }, { folderId: P2, name: 'Project2' }];
  const inFlight = [['docB', { kind: 'assign', seq: 9, instanceId: 'dev2', fromProject: P1 }]];

  console.log('\ncase 2: moved to a device in ANOTHER project — still listed under the source');
  {
    const home = loadHomeFn({ projects, pending: inFlight });
    // Drive already says Project2; the researcher is still looking at Project1.
    ok(home({ docId: 'docB', projectId: P2 }) === P1,
       'it stays in Project1\'s Unassigned while the destination has not picked it up');
  }

  console.log('\ncase 3: same project — unchanged, because nothing moved');
  {
    const home = loadHomeFn({ projects, pending: [['docC', { kind: 'assign', seq: 4, fromProject: P2 }]] });
    ok(home({ docId: 'docC', projectId: P2 }) === P2, 'the same-project case is untouched');
  }

  console.log('\na text with no pending command follows Drive, as always');
  {
    const home = loadHomeFn({ projects, pending: [] });
    ok(home({ docId: 'docA', projectId: P2 }) === P2, 'no marker ⇒ Drive\'s own answer');
    ok(home({ docId: 'docA', projectId: '' }) === '', 'and a flat estate still yields ""');
  }

  console.log('\n⚠ never hidden: a stale or deleted origin falls back to Drive');
  {
    const gone = loadHomeFn({ projects, pending: [['docB', { kind: 'assign', fromProject: 'folder-deleted' }]] });
    ok(gone({ docId: 'docB', projectId: P2 }) === P2,
       'an origin project that no longer exists is IGNORED — the text shows under Drive\'s project');
    const noProjects = loadHomeFn({ projects: [], pending: inFlight });
    ok(noProjects({ docId: 'docB', projectId: P2 }) === P2,
       'and an estate with no projects at all cannot hide it either');
  }

  console.log('\nonly an ASSIGN marker redirects — a delete or upload must not');
  {
    const other = loadHomeFn({ projects, pending: [['docB', { kind: 'delete', fromProject: P1 }]] });
    ok(other({ docId: 'docB', projectId: P2 }) === P2, 'a non-assign marker is ignored');
  }

  console.log('\nthe origin is captured BEFORE the adopt re-parents the folder');
  {
    const adopt = (panel.match(/async function adoptTextModal[\s\S]*?\n\}/) || [''])[0];
    const capture = adopt.indexOf('const originProject');
    const call = adopt.indexOf('Researcher.adoptText');
    ok(capture >= 0, 'adoptTextModal captures the origin project');
    ok(call < 0 || capture < call,
       '...at the top, before the Drive re-parent makes projectId name the destination');
    ok(/fromProject: originProject/.test(adopt), '...and stamps it on the pending marker');
  }

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) throw new Error(`${fail} check(s) failed`);
});
