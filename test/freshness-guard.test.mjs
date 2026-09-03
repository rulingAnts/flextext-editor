/* The staleness guard must actually fire.
 *
 * ⚠ WHY THIS TEST EXISTS. The first version of check-freshness.sh called `timeout 20 git fetch`.
 * macOS has no timeout(1) — it is GNU coreutils — so on the machine it was written for the command
 * failed, the fetch never ran, and the script printed "could not reach origin — skipping" and
 * exited 0 while online. It looked like a working guard and checked nothing.
 *
 * A guard that no-ops is worse than none: it produces a reassuring line and a green exit, so the
 * thing it was installed to prevent goes on happening with a clean conscience. So this drives the
 * real script against a synthetic repository and asserts the exit codes, rather than reading it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'check-freshness.sh');

ok(existsSync(script), 'check-freshness.sh exists');

/* Portability, asserted at source level because the failure is silent and machine-specific: the
 * bare `timeout` call must stay behind a command -v probe, or this guard is dead on macOS again. */
{
  const src = readFileSync(script, 'utf8');
  // The property is ORDER, not absence: timeout may be used, but only after it has been probed
  // for, and there must be a path that reaches the fetch without it.
  const firstProbe = src.indexOf('command -v timeout');
  const firstUse = src.search(/^\s*timeout\s/m);
  ok(firstProbe !== -1 && (firstUse === -1 || firstUse > firstProbe),
     'timeout(1) is probed for before it is used — macOS does not have it');
  ok(/command -v timeout/.test(src) && /http\.lowSpeedTime/.test(src),
     'probes for timeout and falls back to git’s own low-speed abort');
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const run = (cwd, env = {}) => {
  try {
    execFileSync('bash', [script], { cwd, encoding: 'utf8', stdio: 'pipe',
      env: { ...process.env, FRESHNESS_NO_FETCH: '1', ...env } });
    return 0;
  } catch (e) { return e.status; }
};

// A synthetic repo: `origin/main` far ahead of the branch we are standing on.
const dir = mkdtempSync(join(tmpdir(), 'freshness-'));
git(dir, 'init', '-q', '-b', 'main');
git(dir, 'config', 'user.email', 't@example.com');
git(dir, 'config', 'user.name', 'test');
writeFileSync(join(dir, 'f'), '0');
git(dir, 'add', 'f'); git(dir, 'commit', '-qm', 'base');
const base = git(dir, 'rev-parse', 'HEAD').trim();
for (let i = 1; i <= 40; i++) {
  writeFileSync(join(dir, 'f'), String(i));
  git(dir, 'add', 'f'); git(dir, 'commit', '-qm', 'c' + i);
}
// Stand in for the remote-tracking ref without needing a remote.
git(dir, 'update-ref', 'refs/remotes/origin/main', git(dir, 'rev-parse', 'HEAD').trim());

git(dir, 'checkout', '-q', '-B', 'stale', base);
ok(run(dir) === 1, 'a branch 40 commits behind origin/main FAILS');
ok(run(dir, { FRESHNESS_MAX_COMMITS: '99999', FRESHNESS_MAX_DAYS: '99999' }) === 0,
   'an explicit override lets a deliberate case through');

// --warn must report without blocking: it is what dev-serve.sh and pre-push use, and a dev server
// that refuses to start offline would be switched off rather than obeyed.
try {
  execFileSync('bash', [script, '--warn'], { cwd: dir, encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, FRESHNESS_NO_FETCH: '1' } });
  ok(true, '--warn never exits non-zero');
} catch { ok(false, '--warn never exits non-zero'); }

git(dir, 'checkout', '-q', 'main');
ok(run(dir) === 0, 'a branch level with origin/main passes');

/* Wiring: the script existing is not the guard — being CALLED is. */
{
  const hook = readFileSync(join(root, 'hooks/pre-push'), 'utf8');
  ok(/check-freshness\.sh/.test(hook), 'pre-push runs the freshness check');
  ok(/check-freshness\.sh"? --warn/.test(hook),
     'pre-push runs it warn-only — by push time the work is done, blocking helps nobody');
  const dev = readFileSync(join(root, 'dev-serve.sh'), 'utf8');
  ok(/check-freshness\.sh/.test(dev),
     'dev-serve.sh warns at start — the moment before coding, which is the only one that helps');
}

if (fail) { console.error(`\nFAILED (${fail})`); process.exit(1); }
console.log('\nPASS: the staleness guard fires, and is wired where it can help.');
