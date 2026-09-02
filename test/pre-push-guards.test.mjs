/* The pre-push guards must actually fire.
 *
 * ⚠ WHY THIS EXISTS. The production guard read `remote_ref="${2:-}"` and matched it against
 * `*refs/heads/main*`. git passes the remote NAME in $1 and the remote URL in $2 — neither is a
 * ref — so the pattern could never match and THE GUARD HAD NEVER FIRED. `git push origin main`
 * went through with no ALLOW_MAIN_PUSH and no complaint. Compounding it, the refs do arrive on
 * stdin, but the secrets guard consumed the stream first, so a corrected read would still have
 * found nothing.
 *
 * A hook that silently passes is indistinguishable from a hook that approves, which is why this
 * drives the guard with the arguments git really uses instead of reading it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const root = fileURLToPath(new URL('..', import.meta.url));
const hook = readFileSync(join(root, 'hooks/pre-push'), 'utf8');

console.log('the hook reads refs from where git actually puts them');
ok(/REFS="\$\(cat\)"/.test(hook), 'stdin is captured once, before any guard consumes it');
ok(!/remote_ref="\$\{2:-\}"/.test(hook),
   '$2 (the remote URL) is never mistaken for a ref — the bug that disarmed this guard');
ok(/done <<< "\$REFS"/.test(hook), 'guards are fed from the captured refs, not the exhausted stream');

/* Guard 3 in isolation: the secrets scan ahead of it walks the tree and is far too slow to drive
 * once per case, and it is not what broke. */
const guard3 = (hook.match(/# ── 3\. PRODUCTION[\s\S]*?\n\}?\nfi\n/) || [])[0]
  || hook.slice(hook.indexOf('# ── 3. PRODUCTION'));
const SHA = 'a'.repeat(40), ZERO = '0'.repeat(40);
const run = (refs, env = {}) => {
  try {
    execFileSync('bash', ['-c', 'set -uo pipefail; eval "$GUARD"'],
      { encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, GUARD: guard3, REFS: refs, ...env } });
    return 0;
  } catch (e) { return e.status; }
};
const line = (ref) => `refs/heads/x ${SHA} ${ref} ${ZERO}`;

console.log('\nproduction branches are refused; everything else passes');
ok(run(line('refs/heads/productionWeb')) === 1, 'productionWeb is blocked without the flag');
ok(run(line('refs/heads/main')) === 1, 'main is blocked without the flag');
ok(run(line('refs/heads/staging')) === 0, 'staging pushes freely');
ok(run(line('refs/heads/some-feature')) === 0, 'a feature branch pushes freely');

console.log('\nthe override is a deliberate act, and it works');
ok(run(line('refs/heads/productionWeb'), { ALLOW_MAIN_PUSH: '1' }) === 0, 'ALLOW_MAIN_PUSH=1 permits productionWeb');
ok(run(line('refs/heads/main'), { ALLOW_MAIN_PUSH: '1' }) === 0, 'ALLOW_MAIN_PUSH=1 permits main');

console.log('\na multi-ref push is judged by its worst ref');
ok(run([line('refs/heads/some-feature'), line('refs/heads/productionWeb')].join('\n')) === 1,
   'one production ref in a multi-ref push blocks the whole push');

console.log(fail ? `\nFAILED (${fail}) — a pre-push guard is not armed.\n`
                 : '\nPASS: the pre-push guards fire.\n');
process.exit(fail ? 1 : 0);
