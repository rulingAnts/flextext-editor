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
     * 12s poll. Rendering must stay free of side effects — with ONE exception, below, which is
     * allowed precisely because it can never move anything. */
    ok(!/projectsMigrate|projectsUnmigrate|projectRename/.test(card),
       'rendering calls no project route at all — a repaint must never move a folder');
  }

  /* ⚠ AN ACCOUNT WITH NOTHING TO MOVE IS NEVER SHOWN THE MIGRATION CARD (Seth, 2026-08-20).
   *
   * v432 fixed the wrong half of this: it noticed that an account with no devices met the card and
   * then a DISABLED button, and enabled the button. But a brand-new researcher should simply START
   * in the project layout, and an older empty account should arrive there without being told its
   * folders are wrong and asked to authorise a repair — "an unsettling sounding extra step" for
   * people who have nothing wrong with them. Four of the seven production accounts have no devices.
   *
   * The rules that keep this honest:
   *   - the decision comes from the WORKER's dry run — the same call the modal previews with — not
   *     from a second client-side guess at "is this estate empty", which could drift from it;
   *   - it acts only when `count` is 0, so it can create folders and can never move one;
   *   - it runs at most once per panel session, or the 12s poll would re-ask forever;
   *   - a FAILED check falls through to the card, because offering a button that works beats hiding
   *     the only way forward — which is the exact trap v432 climbed out of. */
  console.log('\nan estate with nothing to move is set up silently, and the card never appears');
  {
    const card = fn('function renderProjectsCard');
    const ens = fn('async function ensureProjectLayout');
    ok(/layoutState === 'idle' \|\| layoutState === 'running'/.test(card),
       'while the check is pending the flat-estate card renders NOTHING');
    ok(/return '';/.test(card.slice(card.indexOf('layoutState'))), '...it returns an empty string, not a placeholder');
    ok(!!ens, 'the silent path exists');
    ok(ens.indexOf('dry: true') < ens.indexOf('dry: false'),
       'it asks the worker what would move BEFORE it acts');
    ok(/if \(plan && !plan\.count\)/.test(ens),
       '⚠ it acts ONLY when the worker says nothing would move — never on a plan with moves in it');
    ok(/layoutState = 'done'/.test(ens) && /layoutState = 'failed'/.test(ens),
       'both outcomes are terminal: the poll cannot re-run this');
    ok(/estateSettle\(true\)/.test(ens),
       "...and it waits out Drive's lagging search index before repainting");
    ok(/catch \{ layoutState = 'failed'; \}/.test(ens) && /renderFromSettledEstate\(\)/.test(ens),
       'a failure re-renders, which is what puts the manual card back on screen');
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
    /* ⚠ REWORDED. It said "your folders are still in the OLD LAYOUT", which is false for a brand-new
     * account that has no folders at all — and those accounts were the ones getting stuck. It still
     * states the setup as a step to take, not an option to consider. */
    ok(/takes one step|need|must/i.test(intro), 'the intro states setup as a step, not an option');
    ok(!/keeps several bodies of work apart/i.test(intro), '...and no longer pitches it as a way to organise');
    /* ⚠ THE STUCK ACCOUNT. A researcher with no devices was told to update and then handed a disabled
     * button: prompted, blocked, no way forward. The migration creates the project folder whether or
     * not anything moves, so the only thing in the way was the client. */
    ok(/\(plan\.count \|\| plan\.wouldCreateProject\) \? '' : ' disabled'/.test(panel),
       'an account with nothing to move can still create its project');
    ok(/panel\.proj\.planEmptyNew/.test(panel) && /panel\.proj\.goEmpty/.test(panel),
       '...and is told that is what the button does, rather than "nothing needs to move"');
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
    /* liveDevice() rode in with issue #10: revoked devices leave Drive folders behind, and counting
     * those told a researcher with zero paired devices they had four. Stray containers are still
     * counted — but only ones backed by a live pairing (with a raw-count fallback when the estate
     * carries no live signal at all; see the comment at the filter). */
    ok(/const stray = devices\.filter\(\(d\) => !d\.projectId && liveDevice\(d\)\)\.length;/.test(card),
       'containers still outside a project are counted — live-backed ones only (issue #10)');
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
    // 4th argument since the shared-project tabs landed — and it is `data.memberProjects`, i.e. the
    // WORKER's answer, which is the point pinned behaviourally further down.
    ok(/const scope = projectScope\(insts, estateCache, crowdCache, data\.memberProjects\);/.test(panel) && /if \(!scope\) \{/.test(panel),
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
    /* The single `if` became a three-way branch when shared tabs arrived (stray / shared / owned).
     * The invariant is unchanged and is what these pin: any selection that no longer resolves falls
     * back to the first owned project, because rendering an empty dashboard reads as "my devices are
     * gone". Each of the three cases is asserted, so a future fourth cannot quietly skip the rule. */
    ok(/else if \(!ids\.has\(sel\)\) sel = null;/.test(scope) && /if \(sel === null\) sel = projects\[0\]\.folderId;/.test(scope),
       'a stale selection falls back to the first project rather than showing nothing');
    ok(/if \(sel === STRAY_TAB\) \{ if \(!hasStrays\) sel = null; \}/.test(scope),
       '...and the strays tab disappears once there are none');
    ok(/if \(!mps\.some\(\(m\) => memberTabId\(m\.project_id\) === sel\)\) sel = null;/.test(scope),
       '...and so does a SHARED tab whose share was revoked between renders — same rule, third case');

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
    /* ⚠ THE WORD 'member' WAS REMOVED FROM THIS BAN, AND THAT IS A DELIBERATE NARROWING, not a
     * loosening. The invariant is "scoping is the worker's job, not a hidden tab" — the client must
     * never DECIDE which projects a user may see. `memberProjects` is a DATA SHAPE handed down by the
     * worker (data.memberProjects), so banning the substring started matching the correct
     * implementation of the very rule it guards. The permission-DECISION vocabulary is still banned,
     * and two positive assertions now pin the actual invariant: the list comes from the server, and
     * the switcher renders all of it. A ban that fires on the right answer teaches people to delete
     * the test. */
    ok(!/canOpen|hasGrant|allowed/i.test(scope + sw),
       'no client-side notion of which projects may be shown');
    ok(/const scope = projectScope\(insts, estateCache, crowdCache, data\.memberProjects\);/.test(panel),
       '...the shared projects are the ones the WORKER returned, not ones the client decided it may show');
    ok(/for \(const mp of scope\.memberProjects \|\| \[\]\) \{/.test(sw),
       '...and EVERY one of them gets a tab — the switcher filters none of them');
    ok(/scope\.projects\.map/.test(sw), '...and every project in the estate gets a tab');
  }

  /* ⚠ A HIERARCHY WITH ONE PROJECT IS UNTESTED (Seth: "I need a way to create New projects to truly
   * test whether the hierarchy works correctly in Drive, D1, and researcher UI" … "need to be able
   * to move and CREATE new containers in each project"). Three routes make the shape real. */
  console.log('\nprojects can be created, and containers moved into and born into them');
  {
    ok(/seg\[3\] === 'create'/.test(worker), 'a project can be created');
    /* ⚠ EXACTLY ONE DEFAULT, FOREVER. flextextDefault marks the folder new containers fall back
     * into; a second one carrying it makes driveDefaultProjectFolder's orderBy=createdTime pick the
     * older silently, and every new device lands in whichever project happened to be first. */
    /* ⚠ Slice to the CATCH, not to the first `return j(` — the first one is the bad_body guard, which
     * sits well before the code this is about, so the shorter slice never contained the line it was
     * asserting on and passed against a mutant that tagged every new project as the default. */
    const create = worker.slice(worker.indexOf("seg[3] === 'create'"));
    const createBody = create.slice(0, create.indexOf('} catch'));
    ok(/appProperties: \{ flextextRole: 'project' \}/.test(createBody) && !/flextextDefault/.test(createBody),
       '...and a NEW project is never tagged as the default');

    ok(/seg\[3\] === 'assign'/.test(worker), 'a container can be moved between projects');
    const assign = worker.slice(worker.indexOf("seg[3] === 'assign'"));
    const assignBody = assign.slice(0, assign.indexOf('} catch'));
    ok(/error: 'is_a_text'/.test(assignBody), 'moving a TEXT is refused — that would re-home somebody\'s work');
    ok(/error: 'not_a_project'/.test(assignBody), 'the destination must really be a project');
    ok(/error: 'not_a_container'/.test(assignBody), '...and the source must really be a container');
    /* ⚠ THIS ASSERTION USED TO SAY "NOTHING is written to D1 — parentage is the single authority",
     * and it was right for as long as the two namespaces were unjoinable: writing a DRIVE folder id
     * into instance.project_id — a column holding D1 project GUIDs — would have been a second,
     * differently-shaped answer to "which project is this in".
     *
     * ⚠ WHAT CHANGED (2026-08-20): project.drive_folder_id joins them, so the D1 project for a Drive
     * folder is a LOOKUP rather than a guess. That converts the update from drift into its opposite —
     * Phase C authorizes from instance.project_id, so a container that moved in Drive while D1 still
     * said otherwise would be authorized against the project it had just LEFT. The old invariant now
     * describes the bug rather than preventing it.
     *
     * So what is pinned is the property that actually matters and always did: both are written in
     * ONE act (invariant I3), so nothing can update one without the other. */
    ok(/SELECT project_id FROM project WHERE drive_folder_id=\? AND owner_id=\?/.test(assignBody),
       'the destination folder is resolved to its D1 project by the LINK, never guessed');
    ok(/UPDATE instance SET project_id=\?/.test(assignBody) && /UPDATE crowd_recorder SET project_id=\?/.test(assignBody),
       '...and D1 is updated in the SAME act as the Drive move, so the two cannot drift');
    ok(/const newPid = destRow \? destRow\.project_id : null;/.test(assignBody),
       '⚠ a folder with no D1 project CLEARS project_id — stale would authorize against the project just left');

    // A device created while a project is open must be BORN in it, not in the default.
    ok(/const wantProject = String\(\(body && body\.projectFolderId\)/.test(worker),
       'instance creation accepts a target project');
    /* v544 made creation idempotent (issue #6), so this call gained two replay-aware arguments: the
     * STORED nickname (a retry must not rename an existing device's folder) and the known folder id
     * (the v167 strongly-consistent echo instead of a lagging tag search). The CLAIM is unchanged
     * and still the point — eager, and under the REQUESTED project, never lazily in the default. */
    ok(/driveEnsureDeviceFolder\(env, access, instance_id, placeName, .*?, wantProject\)/.test(worker),
       '...and creates the folder EAGERLY under it, rather than lazily in the default project');
    ok(/const placeName = replayed \? replayed\.nickname : nickname;/.test(worker),
       '...naming it from the stored row on a replay, so a retry cannot rename a device');
    // A SHARED tab is excluded too: its id is a D1 project uuid, not a Drive folder id, and the new
    // device would be the caller's own — so it falls back to the lazy default, as the modal's note says.
    ok(/const intoProject = \(currentProject && currentProject !== STRAY_TAB && !isMemberTab\(currentProject\)\) \? currentProject : '';/.test(panel),
       'the panel passes the tab on screen');

    /* A control that always errs into "there is no other project" teaches that the button is
     * broken, so it is not rendered until there is somewhere to go. */
    ok(/if \(projects\.length < 2\) return '';/.test(fn('function projectMoveBtn')),
       'Move to project… appears only once a second project exists');
  }

  /* ⚠ CROSS-PROJECT MOVES: POSSIBLE, NEVER ACCIDENTAL (Seth, 2026-08-20). "We don't want it to be
   * easy to accidentally move texts across projects, and also clear that each project has its own
   * 'unassigned' box, not some universal, unassigned anywhere box."
   *
   * Both were wrong before: every device was listed flat, so one three projects away looked exactly
   * like the one next door; and a single "Google Drive (Unassigned)" row implied a universal box
   * that does not exist. */
  console.log('\nmove destinations are grouped by project, and crossing one is deliberate');
  {
    const g = fn('function groupedDestinations');
    ok(!!g, 'destinations are grouped');
    ok(/if \(!projects\.length\) return '';/.test(g),
       'a flat estate gets the ungrouped list it always had — the callers fall back to it');
    ok(/\(b\.folderId === homeProject\) - \(a\.folderId === homeProject\)/.test(g),
       'the text\'s OWN project is listed first');
    ok(/const away = p\.folderId !== homeProject/.test(g) && /panel\.move\.otherProject/.test(g),
       '...and every other project is headed and marked as such');
    ok(/const checked = ok && first && !away;/.test(g),
       'the default selection can never land in another project');
    ok(/panel\.proj\.outside/.test(g),
       'devices no project claims are still reachable, in their own labelled group');

    /* ⚠ fn() finds the FIRST match, and confirmCrossProjectFile now precedes it — so this sliced the
      * wrong function and asserted nothing about the one it names. */
    const cc = fn('function confirmCrossProject(toInstanceId');
    ok(/if \(!homeProject \|\| !toInstanceId\)/.test(cc) || /to === homeProject\) return true;/.test(cc),
       'a same-project move is not interrupted');
    ok(/panel\.move\.crossConfirm/.test(cc), '...and a cross-project one must be confirmed by name');
    // Both modals gate on it — the device move AND the source-less one.
    ok((panel.match(/confirmCrossProject\(to, homeProject\)/g) || []).length === 2,
       'both the device move and the source-less move go through the gate');

    /* ⚠ Each project has its OWN Unassigned. drive-unassign files a text into the Unassigned of ITS
     * OWN container's project and takes no target, so exactly one is offered — named after that
     * project, which makes the per-project truth visible where it matters. */
    ok(/panel\.move\.unassignedOf/.test(panel) && /panel\.move\.unassignedPerProject/.test(panel),
       'the Unassigned option is named after its project, with the per-project rule stated');
    const en = (k) => (i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '([^']*)'`)) || [])[1] || '';
    ok(/\{project\}/.test(en('panel.move.unassignedOf')), '...and the name is interpolated, not generic');
    ok(/different projects/i.test(en('panel.move.crossConfirm')),
       'the confirm says plainly that these are different projects');
  }

  /* ⚠ THE AUDIT FINDINGS (2026-08-20). Seth, after finding three bugs one at a time: "can you run an
   * audit to find any more bugs that honestly should have been predictable? It's kind of annoying for
   * me to have to find bugs one at a time when you probably could find them ahead of time." Each of
   * these was found by pattern, not by a researcher hitting it. */
  console.log('\nthe audit findings stay fixed');
  {
    /* ⚠ A TEXT CARRIES ITS OWN projectId, and it cannot be derived client-side. The first
     * per-project Unassigned filter joined through estate.devices on deviceFolderId — but an
     * unassigned text has NO device folder by construction (the estate reports '' when the parent is
     * not a device), so the filter matched nothing in EVERY tab and the card was silently empty
     * everywhere, not just in the new project where it was noticed. */
    ok(/projectId: projectIds\.has\(parentOf\(byId\.get\(dev\) \|\| \{\}\)\)/.test(worker),
       'the worker stamps each text with its project');
    /* v541 routed this through unassignedHomeProject(tx) so an in-flight text stays under the
     * project it left (issue #14 case 2). The CLAIM is unchanged and still what matters: the answer
     * comes from the text's OWN projectId, never from a device join — so both halves are asserted,
     * and a reintroduced deviceFolderId join still fails here. */
    ok(/texts = texts\.filter\(\(tx\) => unassignedHomeProject\(tx\) === projectFolderId\);/.test(panel),
       '...and the Unassigned card filters on THAT (via unassignedHomeProject)');
    const home = (panel.match(/function unassignedHomeProject\(tx\) \{[\s\S]*?\n\}/) || [''])[0];
    ok(/const here = \(tx && tx\.projectId\) \|\| '';/.test(home) && /return here;/.test(home),
       '...whose answer is the text\'s own projectId, defaulted to and fallen back to');
    ok(!/deviceFolderId/.test(home),
       '⚠ and NOT a device join — an unassigned text has no device folder, which emptied every card');

    /* ⚠ Same gap as v426's device path, one function over, missed then: a crowd recorder created
     * while a second project is open would silently appear in the first. */
    ok(/const wantProject = String\(body\.projectFolderId \|\| ''\)/.test(worker),
       'crowd creation accepts a target project');
    ok(/Researcher\.crowdCreate\(label, '', Object\.assign\(\{\}, CROWD_DEFAULT_CONFIG\), intoProject\)/.test(panel),
       '...and the panel passes the tab on screen, exactly as it does for a device');

    // The storage view is hierarchical: project > container > texts, each project with its own pile.
    const sbp = fn('const storeByProject');
    ok(/if \(!projects\.length\) \{/.test(sbp),
       'a flat estate gets the old flat output, byte for byte');
    ok(/panel\.move\.unassignedOf/.test(sbp),
       'each project lists ITS OWN Unassigned, named after it');
    ok(/panel\.proj\.outside/.test(sbp),
       'and anything no project claims is still shown — this view must account for all of Drive');

    /* ⚠ FIFTH INSTANCE OF THE SAME PATTERN, found by Seth asking "that's what happens now, right?"
     * rather than by anything failing. Recreating a trashed container folder used
     * driveProjectFolderFor(rec.project_id) — and project_id is ALWAYS NULL by design, since Drive
     * parentage is the single authority — so it fell through to the DEFAULT project. A recorder or
     * device living in a second project would be resurrected in the first, silently, at the moment
     * its folder was restored. */
    ok(/async function drivePriorProjectParent/.test(worker),
       'a recreated container folder asks where it USED to live');
    ok(/if \(!par\.trashed && \(\(par\.appProperties \|\| \{\}\)\.flextextRole \|\| ''\) === 'project'\) return par\.id;/.test(worker),
       '...and only reuses that parent when it is still a live project folder');
    ok(/await drivePriorProjectParent\(access, rec\.oauth_folder_id\)/.test(worker),
       'crowd folders recreate in place');
    ok(/projectFolderId \|\| \(await drivePriorProjectParent\(access, existingId\)\)/.test(worker),
       'device folders too — and an EXPLICIT target still wins, since that is a choice, not a resurrection');

    // Console rename acted on projects[0] — the wrong project the moment a second one existed.
    ok(/const proj = \(currentProject && ids\.has\(currentProject\)\)/.test(panel),
       'fxProjects("rename") renames the project on screen');
  }

  /* ⚠ ANOTHER PROJECT'S UNASSIGNED IS A REAL DESTINATION (Seth, 2026-08-20): "What I can't do is move
   * a text directly to ANOTHER project's unassigned box, and that should be possible." It used to
   * require moving to a device in that project first and filing it from there — two deliberate acts
   * to express one intention.
   *
   * ⚠ And the difference must stay unmissable, which is why the box sits INSIDE its own project's
   * group rather than as a second row that reads almost the same. */
  console.log('\nevery project\'s Unassigned box is reachable, and never by accident');
  {
    const g = fn('function groupedDestinations');
    ok(/opt\('__unassigned:' \+ p\.folderId/.test(g),
       'each project group carries its OWN Unassigned option');
    ok(/panel\.move\.unassignedOf/.test(g), '...named after that project');
    ok(/away \? t\('panel\.move\.unassignedAway'\) : t\('panel\.move\.unassignedHere'\)/.test(g),
       '...and a box in another project says the text LEAVES this one');
    /* A project with no devices still has a box, and skipping the empty group would hide the only
     * thing such a project can receive. */
    ok(/if \(!mine\.length && !withUnassigned\) continue;/.test(g),
       'an empty project still offers its box');

    ok(/function confirmCrossProjectFile/.test(panel), 'filing across projects has its own confirm');
    ok((panel.match(/confirmCrossProjectFile\(to\.slice\(13\), homeProject\)/g) || []).length === 2,
       '...gating both modals');

    /* ⚠ The worker had to learn a TARGET: drive-unassign files a text into its own container's
     * project, so any other project must be asked for explicitly. Absent — every shipped client and
     * the sweep itself — behaviour is unchanged. */
    ok(/const wantTarget = String\(body\.projectFolderId \|\| ''\)/.test(worker),
       'drive-unassign accepts a target project');
    ok(/if \(forceProject\) proj = forceProject;/.test(worker), '...and uses it in place of per-text resolution');
    ok(/=== 'project'\) forceProject = dest\.id;/.test(worker),
       '...only after verifying it really is a project folder');
  }

  /* ⚠ TILES, NOT BARE RADIOS. `.rp-field` stacks label above input, so a radio rendered as one sat
   * CENTRED ABOVE the next option's name — Seth: "radio buttons don't align with text names, so it's
   * easy to get confused which is which", in the modal where a wrong pick moves a text to the wrong
   * project. The radio remains the control; the label became the target. */
  console.log('\ndestinations are selectable tiles, and still real radios underneath');
  {
    const to = fn('function tileOpt');
    ok(/<input type="radio"/.test(to), 'the radio is still there — keyboard, screen readers, grouping');
    ok(/class="rp-tile/.test(to), '...inside a tile that carries the selected styling');
    ok(!/rp-field/.test(fn('async function moveTextModal').slice(0, 2000)),
       'the move modal no longer uses the stacked field layout for destinations');
  }

  /* ⚠ THE CROWD CARD MUST NOT BE GATED ON ALREADY HAVING ONE (Seth, 2026-08-31: "new projects I
   * create do not have a crowd-recorder area… Looks like I can't add a crowd recorder to a new
   * project I create"). It was rendered only when scope.recs.length was truthy, so the ONLY way to
   * get the area — and the "+ New crowd recorder" button inside it — was to already have a
   * recorder in that project. The feature was therefore unreachable on every project created after
   * the first, and on a new researcher's default project. */
  console.log('\nan owned project always offers the crowd-recorder area, empty or not');
  {
    ok(/\$\{\(scope\.selProject \|\| scope\.recs\.length\) && Researcher\.isApprovedSelf\(\)/.test(panel),
       'the card renders for any owned project, not only one that already has a recorder');
    ok(!/\$\{scope\.recs\.length && Researcher\.isApprovedSelf\(\)/.test(panel),
       '...and the old already-have-one gate is gone');
    const card = fn('function renderCrowdCard');
    ok(/else if \(!recs\.length\)/.test(card) && /panel\.crowd\.empty/.test(card),
       'the card carries its own empty state, so an empty project renders sensibly');
    ok(/data-cact="new"/.test(card), '...and the add button, which is the whole point of showing it');
  }

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) process.exit(1);
});
