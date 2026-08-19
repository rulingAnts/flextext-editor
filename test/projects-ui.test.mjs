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

  console.log('\nthe undo is a first-class button on the same card');
  {
    const card = fn('function renderProjectsCard');
    ok(/data-pact="undo"/.test(card), 'the undo is rendered where the migration was offered');
    ok(/panel\.proj\.undo/.test(card), 'and labelled, not hidden behind a symbol');
    const f = fn('async function projectsUndoModal');
    ok(/trashed/.test(worker.slice(worker.indexOf("direction: 'unmigrate'"))) || /wouldTrashProject/.test(worker),
       'the worker reports whether the project folder would be trashed');
    ok(/panel\.proj\.undoIntro/.test(f), 'the modal explains that the folder is trashed only when empty');
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

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) process.exit(1);
});
