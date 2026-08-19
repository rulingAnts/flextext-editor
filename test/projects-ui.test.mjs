/* THE PROJECTS CARD — the Drive folder layer, with a button on it at last.
 *
 * WHY THIS TEST EXISTS. This is the first operation in the suite that MOVES a researcher's folders,
 * and it was deliberately console-only (`fxProjects()`) until the round trip had been executed and
 * measured on the real production estate — 103 objects, nothing lost, no id changed, byte delta
 * exactly zero (plans/drive-as-truth.md §17.4a). A button says "we are confident". These assertions
 * are the things that have to stay true for that confidence to survive a later edit.
 *
 * The three properties, in order of what they would cost if broken:
 *
 *   1. NOTHING MOVES WITHOUT A PREVIEW AND A PRESS. Every action fetches `dry: true` first and only
 *      ever sends `dry: false` from a handler the researcher clicked while looking at the list of
 *      folders that would move. The worker independently defaults `dry` to true, so forgetting
 *      either one is still safe — that redundancy is the design, not an accident.
 *   2. IT IS UNDOABLE FROM THE SAME CARD. §17 exists because the honest answer to "what if this
 *      tangles my Drive" has to be something the researcher can DO. An undo nobody can find is not
 *      reassurance.
 *   3. IT IS BACKWARD-COMPATIBLE IN BOTH DIRECTIONS — a flat estate is an offer, not a migration;
 *      and the worker keeps emitting the pre-project fields so a panel that predates projects still
 *      renders a migrated estate.
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const panel = read('../docs/js/researcher-panel.js');
const worker = read('../worker/src/v1.js');
const i18n = read('../docs/js/i18n.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const fn = (name, src = panel) => {
  const at = src.indexOf(name);
  if (at < 0) return '';
  const nxt = src.indexOf('\n}\n', at);
  return nxt < 0 ? src.slice(at) : src.slice(at, nxt + 3);
};

test('projects UI', async () => {
  console.log('\nthe card is an OFFER on a flat estate — it never migrates by itself');
  {
    const card = fn('function renderProjectsCard');
    ok(!!card, 'the card exists');
    ok(/if \(!projects\.length\)/.test(card), 'it branches on whether any project folder exists');
    ok(/data-pact="setup"/.test(card), 'and offers setup rather than performing it');
    /* ⚠ A render function that CALLED the migration would migrate on every repaint, including the
     * 12s poll. Rendering must stay free of side effects. */
    ok(!/projectsMigrate|projectsUnmigrate|projectRename/.test(card),
       'rendering calls no project route at all — a repaint must never move a folder');
  }

  console.log('\nevery action previews first, and dry:false only ever comes from a press');
  {
    for (const [name, route] of [['projectsSetupModal', 'projectsMigrate'], ['projectsUndoModal', 'projectsUnmigrate']]) {
      const f = fn('async function ' + name);
      ok(!!f, `${name} exists`);
      const dryAt = f.indexOf('dry: true');
      const goAt = f.indexOf('data-m="go"');
      ok(dryAt > 0, `  ${name} fetches a dry run`);
      ok(dryAt < goAt, '  ...BEFORE the confirm button is built, so the plan is on screen first');
      ok(new RegExp(`Researcher\\.${route}\\(\\{ dry: true \\}\\)`).test(f), `  and the preview really is ${route} with dry:true`);
      // The only dry:false must sit inside the click handler.
      const clickAt = f.indexOf('addEventListener(\'click\'');
      const applyAt = f.indexOf('dry: false');
      ok(applyAt > clickAt && clickAt > 0, '  the applying call is inside the click handler, never at open time');
    }
    ok(/disabled/.test(fn('async function projectsSetupModal')),
       'a plan that moves nothing cannot be confirmed');
  }

  /* ⚠ THE SECOND DEFAULT. The worker must keep defaulting to dry independently of this UI, so a
   * hand-written call, an old client or a bug in the modal still previews rather than acts. */
  console.log('\n...and the worker defaults to dry on its own, independently of this UI');
  {
    ok(/const dry = body\.dry !== false;/.test(worker), 'migrate/unmigrate default dry:true server-side');
  }

  /* ⚠ THE UNDO MOVED OFF THE CARD (§16.28), and this assertion was REVERSED rather than deleted.
   * It used to require the undo to be a first-class button, argued from §17: the honest answer to
   * "what if this tangles my Drive" has to be something the researcher can DO. That is still true —
   * what changed is where it belongs. Projects are one-way, permanent and for everyone, and a
   * prominent "go back to a flat folder" IS the optionality message however it is worded.
   *
   * So: no button on the card, and the modal must still EXIST and be reachable, because an undo
   * that was quietly deleted is a different and much worse thing than an undo that moved. */
  console.log('\nthe undo is off the card, but has NOT been deleted');
  {
    const card = fn('function renderProjectsCard');
    ok(!/data-pact="undo"/.test(card), 'no "go back to a flat folder" button on the card');
    ok(!/panel\.proj\.undo'/.test(card), '...and no copy inviting the researcher to leave');
    ok(/fxProjects\('undo'\)/.test(panel) || /verb === 'undo'/.test(panel),
       'the operator path still exists');
    ok(/if \(verb === 'undo'\) \{ await projectsUndoModal\(\)/.test(panel),
       '...and it opens the REAL modal — preview, settle and repaint, not a stripped-down twin');
    ok(/verb === 'undo!'/.test(panel), 'and the direct apply survives for scripted use');
    const f = fn('async function projectsUndoModal');
    ok(!!f, 'the modal is still here — a deleted undo is a different thing from a moved one');
    ok(/trashed/.test(worker.slice(worker.indexOf("direction: 'unmigrate'"))) || /wouldTrashProject/.test(worker),
       'the worker reports whether the project folder would be trashed');
    ok(/panel\.proj\.undoIntro/.test(f), 'the modal explains that the folder is trashed only when empty');
  }

  /* ⚠ THE FRAMING IS PART OF THE FEATURE (§16.28). "We don't want to communicate to them that this
   * is an optional mode they can use if they want to." A card that pitches a benefit teaches a
   * choice, and the model it teaches is the wrong one. */
  console.log('\nthe card states a required update — it does not offer an option');
  {
    const en = (k) => (i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '([^']*)'`)) || [])[1] || '';
    const intro = en('panel.proj.introFlat');
    ok(/need|must/i.test(intro), 'the intro says the move is NEEDED');
    ok(!/keeps several bodies of work apart/i.test(intro), '...and no longer pitches it as a way to organise');
    ok(!/you can undo/i.test(en('panel.proj.setupIntro')),
       'the confirm step does not advertise reversibility');
    /* ⚠ But the PREVIEW is not what "not optional" removes. The destination is mandatory; acting
     * blind is not. This is the line that stops a future reframing from taking the preview too. */
    ok(/dry: true/.test(fn('async function projectsSetupModal')),
       'the dry-run preview SURVIVES the reframing — mandatory destination, never a blind move');
  }

  console.log('\na half-finished migration is SHOWN, not hidden');
  {
    const card = fn('function renderProjectsCard');
    /* An interrupted run leaves containers under master. The estate reads that shape correctly, so
     * nothing is broken — but a card that looked finished would hide a job still to do. */
    ok(/const stray = devices\.filter\(\(d\) => !d\.projectId\)\.length;/.test(card),
       'containers still outside a project are counted');
    ok(/panel\.proj\.stray/.test(card) && /panel\.proj\.finish/.test(card),
       'and reported with a way to finish the job');
  }

  console.log('\none press finishes an estate of any size');
  {
    const f = fn('async function projectsRunToEnd');
    ok(!!f, 'the drain helper exists');
    ok(/if \(!r\.remaining\) return/.test(f),
       'it keeps going while the worker reports remaining containers (the CAP is 20 per call)');
    ok(/pass < 10/.test(f), '...but is itself bounded — a server that never drains must not spin forever');
    ok(/const CAP = 20;/.test(worker), 'and the worker really does cap each call');
  }

  /* ⚠ THE FOURTH-TIME RULE (viewSig). Three separate bugs have been caused by rendering state that
   * the poll signature could not see: the dashboard concluded "nothing to redraw" and the change
   * appeared only on a manual refresh. This card is drawn from `estateCache`, which is not part of
   * `data`. */
  console.log('\nthe poll can SEE a migration finish — the viewSig rule, in the same commit');
  {
    const sig = fn('function viewSig');
    ok(/estateCache && estateCache\.projects/.test(sig), 'the projects are part of the render signature');
    ok(/estateCache && estateCache\.devices/.test(sig) && /d\.projectId/.test(sig),
       '...and so is which project each container sits under');
    ok(!/estateCache\.texts/.test(sig),
       'but NOT the text list — that would redraw the whole dashboard on every upload');
  }

  console.log('\nbackward compatibility, in both directions');
  {
    /* A panel shipped before projects existed must render a MIGRATED estate. That works because the
     * worker keeps emitting the old fields; if this ever became a `projects`-only shape, every
     * un-updated researcher browser would show an empty dashboard. */
    ok(/unassignedFolderId/.test(worker) && /projects, unassignedFolderIds/.test(worker),
       'the estate still emits the singleton unassignedFolderId beside the new per-project list');
    /* And a NEW device folder must find its project through DRIVE, not D1 — so this ships with
     * `instance.project_id` still NULL and needs no migration applied to any database. */
    ok(/return driveDefaultProjectFolder\(access\);/.test(worker),
       'a container with no project_id falls back to the default project folder found in Drive');
  }

  console.log('\nthe default project is called what Seth asked for, and can be renamed');
  {
    ok(/'panel\.proj\.defaultName': 'Default Project'/.test(i18n), 'the client offers "Default Project"');
    ok(/\|\| 'Default Project'/.test(worker), '...and the worker falls back to the same name');
    /* The name is supplied BY THE CLIENT precisely so it can be localised — the worker has no idea
     * what language the researcher reads. */
    ok(/name: the DEFAULT project's folder name, supplied by the client so it can be localized/.test(worker),
       'the name comes from the client so it can be localised');
    ok(/data-pact="rename"/.test(fn('function renderProjectsCard')), 'and every project can be renamed');
    ok(/panel\.proj\.renameNote/.test(fn('async function projectRenameModal')),
       'the rename says it is display-only — folders are found by tag, never by name');
  }

  /* ⚠ THE EVENTUAL-CONSISTENCY BUG, reported the first time this was driven on a real estate: "it
   * updated Google drive, but not the researcher UI". `driveListAll` lists with a SEARCH query and
   * reads `parents` off that result, and Drive's search index lags a write — so a re-parent can be
   * complete and invisible to the very next estate call. This is the v167 lesson in a new place. */
  console.log('\nthe migration WAITS for Drive\'s search index, and says so when it will not settle');
  {
    const f = fn('async function estateSettle');
    ok(!!f, 'the settle loop exists');
    ok(/Researcher\.driveEstate\(\)/.test(f) && /=== wantProjects/.test(f),
       'it re-reads the estate until the shape matches what was just asked for');
    ok(/i < 6/.test(f), '...bounded, because Drive settling is not guaranteed');
    ok(/estateCache = est;/.test(f), 'and it keeps the settled estate rather than throwing it away');

    const setup = fn('async function projectsSetupModal');
    ok(/await estateSettle\(true, say\)/.test(setup), 'the migration settles before it repaints');
    ok(/renderFromSettledEstate\(\)/.test(setup) && !/\brenderDashboard\(\);/.test(setup),
       '...and repaints WITHOUT a second fetch, which would be a second chance at the stale answer');
    ok(/panel\.proj\.doneSlow/.test(setup),
       'and when it does not settle it SAYS so rather than showing a card that looks like nothing happened');
    ok(/await estateSettle\(false, say\)/.test(fn('async function projectsUndoModal')), 'the undo settles too');
  }

  /* ⚠ THE ONLY PATH THAT CAN MINT A DUPLICATE. Re-running is otherwise harmless — re-parenting to
   * where a folder already is, is a no-op — but `driveEnsureDefaultProject` finds the existing
   * project by TAG SEARCH, so a lagging index makes it create a SECOND one. */
  console.log('\n...and a re-run cannot create a second project folder');
  {
    const setup = fn('async function projectsSetupModal');
    ok(/if \(plan\.wouldCreateProject && \(\(estateCache && estateCache\.projects\) \|\| \[\]\)\.length\)/.test(setup),
       '"would create a project" while we already hold one IS the stale-index signature');
    ok(/panel\.proj\.stale/.test(setup) && /return;/.test(setup),
       'and it refuses, explaining why, instead of acting on a stale plan');
  }

  /* ⚠ A CLAIM MADE OUT LOUD AND WRONG: that adding the estate to viewSig would make a finished
   * migration appear within a poll tick. It cannot — the poll passes `prefetched` and deliberately
   * skips the Drive round trip, so estateCache cannot change on that path. The comment must say so,
   * or the next reader repeats the mistake. */
  console.log('\nthe viewSig entries do not pretend to be the refresh mechanism');
  {
    const sig = fn('function viewSig');
    ok(/THE ESTATE DOES NOT RIDE THE 12s POLL/.test(sig),
       'the comment states plainly that the poll does not refetch the estate');
    ok(/estateSettle/.test(sig), '...and points at what actually refreshes the card');
  }

  /* ⚠ THE HIERARCHY IS THE FEATURE, not the projects card. A list of projects above a flat list of
   * devices is a LABEL — Seth, on being shown exactly that: "that's not QUITE the projects UI
   * working, because you forgot one key element of the design: hierarchical navigation/UI/UX that
   * reflects the hierarchical projects with devices under them."
   *
   * One project at a time, chosen against where this is going (several projects per researcher,
   * several researchers per project): stacking every project on one page scales into a scroll and is
   * the opposite of an access model where a member holds rights to ONE project. */
  console.log('\nthe dashboard shows ONE project at a time, and the flat estate is untouched');
  {
    const scope = fn('function projectScope');
    ok(!!scope, 'the scope resolver exists');
    ok(/if \(!projects\.length\) return null;/.test(scope),
       'a flat estate returns null — the classic layout renders byte for byte');
    ok(/const scope = projectScope\(insts, estateCache, crowdCache\);/.test(panel) && /if \(!scope\) \{/.test(panel),
       '...and the dashboard branches on exactly that');

    /* ⚠ BY FOLDER ID, NEVER BY NAME. The instance now carries oauth_folder_id precisely so this join
     * does not have to go through the device's display name, which a rename would break. */
    ok(/byFolder\.get\(folderId\)/.test(scope) && /it\.oauth_folder_id/.test(scope),
       'devices are matched to projects by folder id');
    ok(/oauth_folder_id FROM instance/.test(worker), '...which the worker now returns');
    ok(!/nickname === |\.name === p\.name/.test(scope), 'and never by name');

    ok(/renderProjectSwitcher/.test(panel) && /rp-ptab/.test(panel), 'a switcher is rendered');
    ok(/data-pact="pick"/.test(panel) && /currentProject = el\.dataset\.p/.test(panel),
       'picking a tab selects a project');
    ok(/renderDashboard\(lastData \|\| undefined\)/.test(panel.slice(panel.indexOf("act === 'pick'"))),
       '...from CACHED data — switching tabs is not a Drive round trip');

    /* A stored tab can point at a project that was renamed away, undone, or belonged to another
     * account. Falling back to "whatever was stored" renders an empty dashboard that reads as though
     * the devices are gone. */
    ok(/if \(sel !== STRAY_TAB && !ids\.has\(sel\)\) sel = null;/.test(scope),
       'a stale selection falls back to the first project rather than showing nothing');
    ok(/if \(sel === STRAY_TAB && !hasStrays\) sel = null;/.test(scope),
       '...and the strays tab disappears once there are none');

    /* Containers an interrupted migration never reached still work, so they must be REACHABLE —
     * their own tab, never hidden and never folded into the first project as if they belonged. */
    ok(/const STRAY_TAB = '__none';/.test(panel), 'containers outside every project get their own tab');
    ok(/panel\.proj\.outsideNote/.test(panel), '...with a note saying the update did not finish');

    // Each project has its OWN Unassigned folder, so the pile must be scoped to the tab.
    ok(/renderUnassignedCard\(estateCache, scope\.sel\)/.test(panel),
       'Unassigned is scoped to the project on screen');
    ok(/currentProject,/.test(fn('function viewSig')),
       'and the selected tab is in viewSig — render state that is not part of `data`');
  }

  /* ⚠ THE TAB STRIP MUST NEVER BECOME A CLIENT-SIDE ACCESS FILTER (§16.30). Seth: "They also
   * shouldn't be SEEING projects they can't open." That is an access-control property, and hiding a
   * tab does not deliver it — the names, ids, device nicknames and text titles would still be in the
   * response, in devtools and in any cache. §11 is explicit that those names are the plaintext this
   * design is careful about.
   *
   * So the switcher renders whatever the estate contains, deliberately and with nothing clever: once
   * the WORKER scopes /drive-estate to the caller's grants, a correctly scoped estate produces a
   * correctly scoped tab strip for free. A filter here would hide the server's over-sharing instead
   * of fixing it. */
  console.log('\nthe switcher does not filter — scoping is the worker\'s job, not a hidden tab');
  {
    const scope = fn('function projectScope');
    const sw = fn('function renderProjectSwitcher');
    ok(/const projects = \(estate && estate\.projects\) \|\| \[\];/.test(scope),
       'the tab list is exactly what the estate returned');
    ok(!/canOpen|hasGrant|allowed|member/i.test(scope + sw),
       'no client-side notion of which projects may be shown');
    ok(/scope\.projects\.map/.test(sw), '...and every project in the estate gets a tab');
  }

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) process.exit(1);
});
