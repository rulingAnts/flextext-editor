/* THE GUARD THAT KEEPS CREDENTIALS OUT OF A PUBLIC REPO.
 *
 * Seth, 2026-08-15, after credentials in a OneStory project file sat in a public repo: "let's have
 * more careful guards to make sure we check for and don't upload secrets publicly in the future."
 *
 * ⚠ WHAT IS ACTUALLY BEING PROTECTED, because it decides every design choice below: a push to a
 * public repo is IRREVERSIBLE. The moment it lands it is cloned, cached and indexed; deleting the
 * file afterwards removes nothing, and the credential has to be rotated whatever you do next. There
 * is exactly one cheap moment, and it is before the bytes leave.
 *
 * ⚠ AND THE FAILURE MODE THIS FILE EXISTS TO PREVENT IS NOT "the guard is missing" — it is "the
 * guard is there and asserts nothing." Three ways that happens, each pinned below:
 *   - the scan runs but its exit code never reaches git (a hook that prints and passes);
 *   - the self-reference exemption grows a DIRECTORY, and real secrets inside it sail through;
 *   - an override env var appears for the secrets check, the way the policy checks have one.
 *
 * Run: node test/secret-guard.test.mjs
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname — the latter leaves a space in the repo path %20-encoded, so
// existsSync/execFileSync miss every file when the checkout lives under a directory with a space.
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

console.log('\nthe pieces exist and are runnable');
{
  for (const f of ['check-secrets.sh', 'hooks/pre-push', 'install-hooks.sh']) {
    ok(existsSync(join(root, f)), `${f} is tracked in the repo`);
    /* ⚠ Executable BIT, not just presence. git preserves mode 100755, and a hook copied in without
     * it is silently never run — the exact "guard that asserts nothing" this file is about. */
    ok((statSync(join(root, f)).mode & 0o111) !== 0, `…and is executable (git tracks the mode)`);
  }
}

console.log('\nthe hook actually gates the push on the scan');
{
  const hook = read('hooks/pre-push');
  ok(/check-secrets\.sh/.test(hook), 'the hook calls check-secrets.sh');
  /* Printing a warning and returning 0 is the classic dud. `|| exit 1` is what makes git refuse. */
  ok(/check-secrets\.sh"[^\n]*\|\| exit 1/.test(hook), '…and EXITS NONZERO on a hit, which is what makes git refuse the push');
  ok(/ALLOW_WORKFLOW_PUSH/.test(hook) && /ALLOW_MAIN_PUSH/.test(hook),
     'the pre-existing workflow + production guards are preserved, not replaced');
  /* ⚠ The asymmetry is deliberate and worth pinning: the POLICY guards have an override because
   * Seth approves a specific push; the SECRETS guard must not, because "I know what I'm doing" is
   * the one thing every leaked key has in common. */
  const secretsBlock = hook.slice(hook.indexOf('1. SECRETS'), hook.indexOf('2. WORKFLOWS'));
  ok(!/ALLOW_[A-Z_]*=/.test(secretsBlock), 'and the SECRETS check has no override env var of its own');

  /* ⚠⚠ THE FILE GIT ACTUALLY RUNS is .git/hooks/pre-push (in the COMMON git dir, so worktrees share
   * it), NOT the tracked hooks/pre-push above. This test used to read only the tracked copy, so it
   * passed while the INSTALLED hook could be a stale version that never calls check-secrets at all —
   * false assurance, which is the precise failure this file exists to prevent (uncovered sweep #9).
   *   · absent  → informational: a fresh checkout / CI does not run local hooks, and install-hooks.sh
   *               is how it gets there; the tracked hook is the source of truth.
   *   · present but stale → HARD FAIL: an installed hook that does not run the scan is active false
   *               assurance, and the only way to end it is to re-install the tracked one. */
  let commonDir = '.git';
  try { commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim(); }
  catch { /* not a git dir — leave the default */ }
  const installedHook = isAbsolute(commonDir) ? join(commonDir, 'hooks', 'pre-push') : join(root, commonDir, 'hooks', 'pre-push');
  if (existsSync(installedHook)) {
    const live = readFileSync(installedHook, 'utf8');
    ok(/check-secrets\.sh/.test(live) && /\|\| exit 1/.test(live),
       `⚠⚠ the INSTALLED hook (${installedHook}) also runs check-secrets and exits nonzero — a stale installed hook that skips the scan is the false-assurance case #9. Re-install: ./install-hooks.sh (remove the old one first if it refuses).`);
  } else {
    console.log('  --    no installed .git/hooks/pre-push (fresh checkout / CI) — run ./install-hooks.sh; the tracked hook above is the source of truth');
  }
}

console.log('\nthe self-reference exemption cannot become a hiding place');
{
  const sh = read('check-secrets.sh');
  const list = (sh.match(/is_selfref\(\)[\s\S]*?esac/) || [''])[0];
  ok(list.length > 40, 'the exemption list is where it is expected');
  /* ⚠ THIS ONE ALREADY BIT, ten minutes after being written: the list shipped with `plans/*` in it,
   * which would have skipped every file under plans/ — a real credential dropped there would have
   * been waved straight through by a check whose own comment says never to do this. A glob ending
   * in / or /* is the shape to refuse. */
  /* ⚠ SPLIT THE case PATTERN ON `|`. The first version of this check matched `([\w./*-]+)\)` — which
   * only ever sees the LAST alternative, the one touching the paren. It passed happily with
   * `plans/*` sitting in the middle of the list, i.e. it asserted nothing, which is the precise
   * disease this whole file is about. Watched it fail only after this rewrite. */
  const pattern = (list.match(/case "\$1" in\s*\n\s*([^)]*)\)/) || ['', ''])[1];
  const alts = pattern.split('|').map((s) => s.trim()).filter(Boolean);
  ok(alts.length >= 4, `the list names ${alts.length} individual files`);
  const globs = alts.filter((s) => /\/\*$/.test(s) || /\/$/.test(s) || s === '*');
  ok(globs.length === 0, `no DIRECTORY exemptions${globs.length ? ' — found: ' + globs.join(', ') : ''}`);
}

console.log('\nit catches real credential shapes, and does not cry wolf');
{
  const dir = mkdtempSync(join(tmpdir(), 'secguard-'));
  execFileSync('git', ['init', '-q', dir]);
  cpSync(join(root, 'check-secrets.sh'), join(dir, 'check-secrets.sh'));
  execFileSync('chmod', ['+x', join(dir, 'check-secrets.sh')]);
  mkdirSync(join(dir, 'sub'), { recursive: true });

  const scan = () => {
    /* ⚠ `-f`, AND THE REASON IS THE WHOLE POINT OF THIS FILE. A developer's GLOBAL gitignore
     * (core.excludesFile) commonly lists `*.pem` / `*.key` / `.env` — Seth's does — and a plain
     * `git add -A` honours it, so the fixture's decoy secret is never staged. check-secrets.sh then
     * scans a tree with no secret in it, finds nothing, and the "catches a PEM private key"
     * assertion FAILS on the maintainer's machine while passing on a CI runner that has no global
     * excludes. A guard test whose verdict depends on whose laptop it runs on is not a guard.
     *
     * Forcing the add is safe here — `dir` is a throwaway temp repo that is never pushed — and it is
     * also the honest fixture: the incident this guards against was a secret that WAS committed, so
     * the test must be able to stage one. It does not weaken the check under test; check-secrets.sh
     * still has to find it on its own. */
    execFileSync('git', ['-C', dir, 'add', '-A', '-f']);
    try { execFileSync(join(dir, 'check-secrets.sh'), { cwd: dir, stdio: 'pipe' }); return 0; }
    catch (e) { return e.status; }
  };

  /* ⚠ THE DECOYS COME FIRST, and they are the more important half. A scanner that flags the word
   * "password" in ordinary source gets bypassed with --no-verify within a week, after which it
   * protects nothing at all — so "clean stays clean" is a correctness property, not politeness. */
  writeFileSync(join(dir, 'sub/fine.js'), 'const hint = "type your password here";\nconst k = "secretSauce";\n');
  writeFileSync(join(dir, '.dev.vars.example'), 'RELAY_SECRET=replace-me\n');
  writeFileSync(join(dir, 'README.md'), 'Set your API key in .dev.vars (never commit it).\n');
  ok(scan() === 0, 'prose about passwords, a .example template and a README do NOT trip it');

  const cases = [
    ['sub/deploy.pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n', 'a .pem FILE TYPE, whatever is in it'],
    /* ⚠ THE SAME KEY UNDER AN INNOCUOUS NAME, and this is the case that actually tests the PEM
     * CONTENT pattern. The `.pem` case above cannot: check-secrets.sh catches that file by its
     * EXTENSION, so it passes with the content rule deleted — which is exactly what a mutation test
     * found (2026-08-24). Two rules were being credited to one assertion; a key pasted into
     * `config.txt` is the shape the content rule exists for, and nothing else here exercises it. */
    ['sub/config.txt', 'key = """\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n"""\n', 'a PEM private key pasted into an ordinary text file'],
    ['sub/notes.txt', 'TOKEN=ghp_' + '0123456789abcdefghijABCDEFGHIJ0123' + '\n', 'a GitHub token pasted into a text file'],
    ['sub/aws.txt', 'id=AKIA' + 'ABCDEFGHIJKLMNOP' + '\n', 'an AWS access key id'],
    ['sub/url.txt', 'db=https://admin:hunter2@db.internal/app\n', 'credentials embedded in a URL'],
    ['members.onestory', '<Members><Member email="a@b.org"/></Members>\n', 'a OneStory project file — the file type that started this'],
    ['sa.json', '{"private_key_id": "abc", "type": "service_account"}\n', 'a Google service-account JSON'],
  ];
  for (const [path, body, what] of cases) {
    writeFileSync(join(dir, path), body);
    ok(scan() === 1, `catches ${what}`);
    execFileSync('git', ['-C', dir, 'rm', '-q', '--cached', path]);
    execFileSync('rm', ['-f', join(dir, path)]);
  }
  ok(scan() === 0, 'and goes back to clean once they are gone — no sticky state');
}

console.log('\nthe repository this runs in is itself clean');
{
  /* Not a formality: this is the assertion that would have caught the original incident, and it
   * runs on every suite invocation from now on. */
  let status = 0;
  try { execFileSync(join(root, 'check-secrets.sh'), { cwd: root, stdio: 'pipe' }); }
  catch (e) { status = e.status; }
  ok(status === 0, 'check-secrets.sh reports the tracked tree clean');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
