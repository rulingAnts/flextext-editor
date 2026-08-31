/* Project default settings — the template's two dangerous halves (v519).
 *
 * A template is copied onto devices, and "apply to all" writes settings to every field device in a
 * project at once. Both halves have a failure mode that is silent on the researcher's screen and
 * loud in a village: a form that looks unconfigured but is not, and a bulk push that carries more
 * than the researcher chose. Each invariant below was a REAL defect found in review before this
 * shipped, so each one is pinned rather than remembered.
 *
 * Source-level assertions, like the other panel guards: the panel is a browser module with a large
 * dependency graph, and what is being protected here is the SHAPE of the code (what is deleted
 * before a push, what is checked before a seed, what stops a loop) rather than a computed value. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const panel = readFileSync(join(root, 'docs/js/researcher-panel.js'), 'utf8');
const i18n = readFileSync(join(root, 'docs/js/i18n.js'), 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

const applyAt = panel.indexOf('function applyTemplateModal');
const apply = panel.slice(applyAt, panel.indexOf('\nfunction ', applyAt + 10));

console.log('the apply-to-devices flow exists and is reachable');
{
  ok(applyAt > 0, 'applyTemplateModal is defined');
  ok(/applyTemplateModal\(target\.project, patch, prevTpl, targets\)/.test(panel),
     'and the template SAVE offers it — the only way a template reaches a device');
  ok(/const prevTpl = projectDefaults\(target\.project\.folderId\);\s*\n\s*await saveProjectDefaults\(/.test(panel),
     'the previous template is captured BEFORE the save overwrites it, or there is no delta to offer');
}

console.log('\nappLang is never re-sent by a bulk push (it is a one-shot command, not a setting)');
{
  /* The device runs applyDeviceLang whenever the key is PRESENT in a settings push. The merge base
   * is the last thing pushed to that device, which still carries any language ever sent — so
   * without this deletion an unrelated consent edit would flip a field worker's phone back to a
   * language they had deliberately changed. readForm deletes it at 'follow' for the same reason. */
  ok(/delete toPush\.appLang/.test(apply), 'the merge deletes appLang from what it pushes');
  ok(/if \(!\(changed\.includes\('appLang'\) && \('appLang' in patch\)\)\) delete toPush\.appLang/.test(apply),
     '...unless the language was DELIBERATELY changed in this very save');
  const delAt = apply.indexOf('delete toPush.appLang');
  const pushAt = apply.indexOf('Researcher.changeSettings(iid, toPush)');
  ok(delAt > 0 && pushAt > delAt, 'and the deletion happens before the push, not after it');
}

console.log('\nclosing the modal mid-push actually stops the push');
{
  /* busy() disables only the button it is given: Escape, the backdrop and "Not now" all stay live
   * while the loop runs. Without an abort the modal vanished — reading as cancelled — while every
   * remaining device kept being written, which in whole-template mode replaces entire settings. */
  ok(/\(\) => \{ if \(pushing\) cancelled = true; \}\)/.test(apply),
     'the modal\'s onClose flags the running loop');
  ok(/if \(cancelled\) break;/.test(apply), 'the loop checks that flag before each device');
  const breakAt = apply.indexOf('if (cancelled) break;');
  const bodyAt = apply.indexOf('Researcher.changeSettings(iid, toPush)');
  ok(breakAt > 0 && bodyAt > breakAt, 'and it checks BEFORE doing the device, not after');
  ok(/'panel\.apply\.stopped'/.test(apply), 'a stopped run says so, with how many devices it reached');
  ok(/if \(pushing\) \{ m\.close\(\); return; \}/.test(apply),
     '"Not now" mid-push is a stop, not a second toast contradicting the first');
}

console.log('\na declined offer keeps the delta, so the safe mode stays reachable');
{
  /* "Not now" promises nothing is lost. Without persistence, re-saving an unchanged template
   * produced an empty delta, leaving only the full overwrite — the exact thing changed-only mode
   * exists to avoid. */
  /* Anchored to the SKIP handler itself: `savePendingApply(…, changed)` also appears on the
   * partial-run path, so a loose match passed with the decline path deleted (caught by mutating
   * this very line — the repo's rule that a guard is only proven by making it fail). */
  const skipAt = apply.indexOf('[data-m="skip"]');
  const skip = apply.slice(skipAt, apply.indexOf('\n  };', skipAt));
  ok(skipAt > 0 && /savePendingApply\(project\.folderId, changed\)/.test(skip),
     'declining stores the pending keys');
  ok(/const changed = \[\.\.\.new Set\(\[\.\.\.templateChangedKeys\(prevTpl, patch\), \.\.\.pending\]\)\]/.test(apply),
     'and every later save unions them into its own delta');
  ok(/const clean = !failed\.length && !cancelled;/.test(apply) && /if \(clean\) await savePendingApply\(project\.folderId, \[\]\)/.test(apply),
     'the delta is cleared ONLY when it reached every ticked device — a partial run keeps it');
  ok(/projectDefaultsPending/.test(panel), 'stored in the researcher\'s own encrypted prefs, like the template');
  ok(!/projectDefaultsPending[\s\S]{0,400}?settings\[/.test(panel),
     'and it holds field KEYS only — never a copy of the values');
}

console.log('\nthe template is seeded onto a device only when the device is provably unconfigured');
{
  /* getInstanceSettings answers null both for "nothing configured" and "could not read it" (its
   * lane read swallows its own errors, and the snapshot is empty for a device somebody else
   * configured). Seeding on the second gives a full, valid-looking form over a member's real
   * configuration, with a note telling the researcher to push it. */
  const seedAt = panel.indexOf('let seededFromTemplate = false;');
  const seed = panel.slice(seedAt, seedAt + 2200);
  ok(seedAt > 0, 'the seeding gate is findable');
  ok(/await Researcher\.readSettingsLane\(target\.instance\.instance_id\)/.test(seed),
     'the lane is re-read DIRECTLY, where a failure throws instead of vanishing');
  ok(/catch \{ unreadable = true; \}/.test(seed), 'a failed read is recorded as its own state');
  ok(/if \(empty\) \{[\s\S]{0,200}?projectDefaults\(folder\)/.test(seed),
     'the template is applied only on a positive "there is nothing there"');
  ok(/if \(lane && Object\.keys\(lane\)\.length\) source = lane;/.test(seed),
     'and settings the first read missed are SHOWN, not overwritten by the template');
  ok(/'panel\.set\.readFailed'/.test(panel), 'an unreadable device says so');
  const en = (i18n.match(/'panel\.set\.readFailed': '([^']*)'/) || [])[1] || '';
  ok(/could not be read/i.test(en) && /blank/i.test(en),
     '...and the wording claims neither "configured" nor "unconfigured" — it says the read failed');
  ok(/'panel\.set\.fromTemplate'/.test(panel) && /Nothing is on the device yet/.test(i18n),
     'a template-seeded form says the values are NOT on the device yet');
}

console.log('\nthe template form never pretends to do a per-device act');
{
  /* The consent prompt upload streams into ONE device's Drive folder and mints a URL for it, so in
   * template mode its button had nothing to target and sat there dead. */
  ok(/const cu = box\.querySelector\('\[data-gact="consentUpload"\]'\);/.test(panel)
     && /cu\.remove\(\);/.test(panel),
     'the prompt-upload button is removed from the template form, not left dead');
  ok(/'panel\.set\.promptPerDevice'/.test(panel), 'and replaced by the reason, per the no-dead-controls rule');
}

console.log(failures ? `\nFAILED (${failures})` : '\nall passed');
process.exit(failures ? 1 : 0);
