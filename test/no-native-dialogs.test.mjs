/* THE EDITOR ASKS IN ITS OWN VOICE — no native confirm() anywhere in the engine.
 *
 * The panel replaced its sixteen native dialogs long ago; the editor's nine outlived them, which is
 * backwards: the editor is what a field transcriber uses all day, usually on an Android phone,
 * where a system dialog is the most jarring thing on screen and its buttons are the smallest. This
 * was an in-app Known issue until v540.
 *
 * ⚠ THE CLASS IS THE CONTRACT, not the styling. The editor's global key handler treats
 * `.modal:not([hidden])` as "a dialog owns the keyboard" — the rule that stops Space from playing
 * the recording behind an open dialog and Enter from cutting audio. A confirm built without
 * `class="modal"` would be a dialog the spacebar plays straight through, which is exactly the kind
 * of regression a rewrite invites, so it is pinned here rather than trusted to memory.
 *
 * ⚠ AND `window.confirm` MUST NOT COME BACK. It is not a style preference: a native dialog blocks
 * the thread, so every caller was written as if asking and acting were one instant. The in-app
 * dialog does not block, which is why cutGuessSplits re-checks the document after awaiting — see
 * its comment. A future `confirm()` slipped in beside these would look harmless and reintroduce a
 * different failure mode in the same file.
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('no native dialogs in the engine', () => {
  const app = read('../docs/js/app.js');
  const strips = read('../docs/js/segment-strips.js');

  console.log('\nthe engine never calls a native dialog');
  {
    /* ⚠ SCAN CODE, NOT PROSE. The first version of this test failed on its own subject matter: the
     * comments explaining why native confirm() was removed contain the words "native confirm()",
     * and a raw source scan cannot tell an explanation from a call. Comments are stripped first —
     * otherwise the honest thing to do would be to stop writing the explanations, which is exactly
     * backwards. */
    const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    /* Word-boundary and no leading dot, so confirmDialog / confirmReplace / `p.prompt()` (the PWA
     * install event, a different API entirely) are not matched. */
    for (const [name, src] of [['app.js', app], ['segment-strips.js', strips],
                               ['segments.js', read('../docs/js/segments.js')]]) {
      const hits = (stripComments(src).match(/(?<![\w.])(confirm|alert)\s*\(/g) || []);
      ok(hits.length === 0, `${name} has no bare confirm()/alert() (${hits.length})`);
    }
  }

  console.log('\nthe replacement is a real modal by the key handler\'s definition');
  {
    const dlg = (app.match(/function confirmDialog\(message\) \{[\s\S]*?\n\}/) || [''])[0];
    ok(!!dlg, 'confirmDialog exists');
    ok(/wrap\.className = 'modal';/.test(dlg),
       '⚠ it carries class="modal" — the key handler\'s test for "a dialog owns the keyboard"');
    ok(/\.modal:not\(\[hidden\]\)/.test(app),
       '...and that handler still keys off exactly that selector');
    ok(/role="dialog" aria-modal="true"/.test(dlg), 'and it is a dialog for assistive tech too');
  }

  console.log('\ncancel is the safe default on every exit path');
  {
    const dlg = (app.match(/function confirmDialog\(message\) \{[\s\S]*?\n\}/) || [''])[0];
    ok(/e\.key === 'Escape'.*finish\(false\)/s.test(dlg), 'Escape cancels');
    ok(/if \(e\.target === wrap\) finish\(false\)/.test(dlg), 'a backdrop click cancels');
    ok(/\[data-confirm-dialog\]'\)\) \{ resolve\(false\); return; \}/.test(dlg),
       'a second confirm while one is open answers NO rather than stacking dialogs');
    ok(/if \(done\) return;/.test(dlg), 'the first answer wins — Escape and a click cannot both resolve');
  }

  console.log('\nthe one synchronous contract was converted, not papered over');
  {
    ok(/export async function cutGuessSplits/.test(strips),
       'cutGuessSplits is async (its only caller ignores the return value)');
    ok(/if \(!await cutDeps\.confirmReplace\(\)\) return;/.test(strips), '...and awaits the answer');
    /* The await opens a gap a blocking confirm() never had: a remote command can retire the open
     * doc mid-dialog, and replacing the paragraphs of a doc that is no longer open would destroy
     * work in a text nobody is looking at. */
    ok(/if \(cutDeps\.getDoc\(\) !== doc\) return;/.test(strips),
       '⚠ and re-checks the document after the await, which the blocking dialog made unnecessary');
  }

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) throw new Error(`${fail} check(s) failed`);
});
