/* THE DEPLOY WORKFLOWS: manual, routed through deploy.sh, and asymmetric on purpose.
 *
 * WHY THEY EXIST. Cloudflare's git integration built every Worker on every push to a connected
 * branch, whether or not the push changed anything a site serves. That produced a whole family of
 * failures this repo carried workarounds for: two pushes within a couple of minutes cancelling each
 * other, a docs commit restarting the spacing between `main` and `productionWeb`, and a one-app
 * staging test costing five builds. Seth, 2026-08-20: "I'm fed up with how long it takes in between
 * each iteration."
 *
 * WHAT MUST STAY TRUE:
 *
 *  1. NOTHING DEPLOYS ON PUSH. The entire point. A `push:` trigger creeping back in restores every
 *     problem above, and would do it silently — the builds simply start happening again.
 *
 *  2. THE WORKFLOW RUNS deploy.sh; IT DOES NOT REIMPLEMENT IT. Each app's deploy.sh owns the branch
 *     routing that keeps a feature branch off app.flextext.app, plus version-sync and the SHELL-path
 *     check. A workflow calling `wrangler deploy` directly would bypass all of it, and would look
 *     entirely reasonable while doing so.
 *
 *  3. STAGING CHOOSES APPS; PRODUCTION CANNOT. Seth: "We want all five to build any time we're
 *     pushing production. But for staging being able to only push what we're actually testing would
 *     be a huge time and AI cost savings." A release is one estate at one version — the satellites
 *     declare the ENGINE they were built against — so a partial production deploy is not a smaller
 *     release, it is a broken one. The protection is that the choice is not offered.
 *
 *  4. ⚠ PRODUCTION DEPLOYS EVERY APP THAT EXISTS, not every app that existed when this was written.
 *     The list is checked against the folders on disk, so adding a sixth app and forgetting to add
 *     it here fails the build instead of quietly never shipping it.
 *
 * Run: node test/deploy-workflows.test.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const reusable = read('../.github/workflows/deploy-apps.yml');
const staging  = read('../.github/workflows/deploy-staging.yml');
const prod     = read('../.github/workflows/deploy-production.yml');

console.log('\nnothing deploys on push — the whole reason these exist');
{
  for (const [name, src] of [['deploy-apps', reusable], ['deploy-staging', staging], ['deploy-production', prod]]) {
    // The `on:` block only, so the word "push" in prose can't satisfy or break this.
    const on = src.slice(src.indexOf('\non:'), src.indexOf('\njobs:'));
    ok(!/^\s*push:/m.test(on), `${name} has no push trigger`);
    ok(!/^\s*schedule:/m.test(on), `${name} has no schedule — nothing fires on its own`);
  }
  ok(/workflow_call:/.test(reusable), 'the reusable one is callable only by the other two');
  ok(/workflow_dispatch:/.test(staging) && /workflow_dispatch:/.test(prod),
     'both entry points are manual');
}

console.log('\nthe deploy goes through deploy.sh, which owns the branch routing');
{
  ok(/run: bash deploy\.sh/.test(reusable), 'it runs the app folder\'s own deploy.sh');
  ok(/WORKERS_CI_BRANCH: \$\{\{ inputs\.branch \}\}/.test(reusable),
     '...passing the branch deploy.sh routes on, exactly as Cloudflare used to');
  /* ⚠ Comments FIRST. This file's own header explains that calling wrangler directly is forbidden,
   * and the workflow's comments name `wrangler deploy` while describing what deploy.sh does — so a
   * raw grep matches the prose and reports a violation that does not exist. It did exactly that. */
  const reusableCode = reusable.replace(/^\s*#.*$/gm, '');
  ok(!/wrangler deploy|versions upload/.test(reusableCode),
     '⚠ and never calls wrangler itself — that would bypass the production/preview guard');
  ok(/cancel-in-progress: false/.test(reusable),
     'concurrent runs queue rather than cancel — a half-uploaded Worker is worse than waiting');
  ok(/fail-fast: false/.test(reusable), 'one app failing does not cancel the rest');
}

console.log('\nstaging picks apps and can never reach production');
{
  ok(/type: boolean/.test(staging), 'the apps are individually selectable');
  ok(/github\.ref_name == 'productionWeb'[\s\S]{0,200}exit 1/.test(staging),
     '⚠ it refuses to run on productionWeb outright, not merely by convention');
  ok(/No apps ticked/.test(staging), 'ticking nothing is a clear error, not an empty success');
  ok(/branch: \$\{\{ github\.ref_name \}\}/.test(staging), 'it deploys the branch you selected');
}

console.log('\nproduction offers NO choice — a partial release is impossible by construction');
{
  const on = prod.slice(prod.indexOf('\non:'), prod.indexOf('\njobs:'));
  ok(!/inputs:/.test(on), '⚠ the production workflow has no inputs at all');
  ok(!/type: boolean/.test(prod), '...and specifically no per-app checkboxes');
  ok(/github\.ref_name != 'productionWeb'[\s\S]{0,200}exit 1/.test(prod),
     'it refuses any ref that is not productionWeb');
  ok(/branch: productionWeb/.test(prod), 'and hard-codes the branch it passes to deploy.sh');
}

console.log('\n⚠ production deploys every app that EXISTS, not every app that existed when this was written');
{
  const listed = (prod.match(/apps: '(\[[^']*\])'/) || [])[1];
  ok(!!listed, 'the production app list is findable');
  const inWorkflow = new Set(JSON.parse(listed || '[]'));

  // An app == a folder holding BOTH a wrangler.toml and a deploy.sh. worker/ has a wrangler.toml but
  // no deploy.sh (it ships via worker-deploy.yml, deliberately independent), so it is excluded by
  // the same rule rather than by being named here.
  const root = new URL('../', import.meta.url);
  const candidates = [];
  for (const d of readdirSync(new URL('apps/', root), { withFileTypes: true })) {
    if (d.isDirectory()) candidates.push('apps/' + d.name);
  }
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (d.isDirectory() && !['apps', 'node_modules', '.git'].includes(d.name)) candidates.push(d.name);
  }
  const onDisk = candidates.filter((c) =>
    existsSync(new URL(c + '/wrangler.toml', root)) && existsSync(new URL(c + '/deploy.sh', root)));

  ok(onDisk.length > 0, `found deployable app folders on disk (${onDisk.length})`);
  const missing = onDisk.filter((a) => !inWorkflow.has(a));
  const extra = [...inWorkflow].filter((a) => !onDisk.includes(a));
  ok(missing.length === 0, `every deployable app is in the production list${missing.length ? ' — MISSING: ' + missing.join(', ') : ''}`);
  ok(extra.length === 0, `the production list names nothing that does not exist${extra.length ? ' — STALE: ' + extra.join(', ') : ''}`);
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall good\n');
process.exit(fail ? 1 : 0);
