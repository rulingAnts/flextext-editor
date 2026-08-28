/* "Is the recording still on its way?" — ONE definition, and the two waiting screens must use it.
 *
 * WHY THIS FILE EXISTS. There were three copies of this test and they had drifted, in the direction
 * that hurts the people this app is for. landingTab excluded a FAILED download; the Cut and Baseline
 * waiting screens did not — even though the Baseline one carried a comment claiming it used the
 * "same test, same two states" as Cut. It did not.
 *
 * The consequence landed exactly on the project's hardest constraint (Seth: "don't make the basic
 * offline/poor-connection context fail"). On a weak connection an assigned text's audio download
 * fails; `pendingAudio` stays set and `audioError` is recorded. Both tabs then read "still coming"
 * forever. On the Baseline tab that branch also HIDES THE TEXTAREA — so a transcriber could not type
 * at all, waiting on bytes that were never arriving, with no error shown and no retry offered.
 *
 * A source-shape test rather than a behavioural one, because these are inline expressions inside two
 * long render functions with no seam to call. What it defends is that ONE function decides, and that
 * both screens ask IT — which is the property whose absence caused the drift.
 *
 * Run: node test/audio-still-coming.test.mjs
 */
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
let fail = 0;
const ok = (c, msg) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${msg}`); if (!c) fail++; };

console.log('\nthere is exactly one definition, and it makes the three distinctions that matter');
{
  const fn = (app.match(/function audioStillComing\(rec, attachingForThisDoc\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(!!fn, 'audioStillComing exists');
  ok(/if \(attachingForThisDoc\) return true;/.test(fn),
     'a local attach in progress IS coming');
  ok(/if \(!rec \|\| !rec\.pendingAudio\) return false;/.test(fn),
     'nothing pending means nothing coming');
  ok(/if \(rec\.audioError\) return false;/.test(fn),
     '⚠ a FAILED download is NOT coming — the drift that hid the error and hid the textarea');
  ok(/status === 'paused'\) return false;/.test(fn),
     '⚠ and neither is one the USER paused — they stopped it to work now, not to be held on a spinner');
}

console.log('\n...and BOTH waiting screens ask it, rather than re-deriving it');
{
  const callers = [...app.matchAll(/const coming = ([^\n;]+);/g)].map((m) => m[1].trim());
  ok(callers.length === 2, `both waiting screens compute \`coming\` (found ${callers.length})`);
  ok(callers.every((c) => c.startsWith('audioStillComing(')),
     '⚠ every one of them calls audioStillComing — a re-derived copy here is the whole bug, twice');
  ok(callers.some((c) => /forDoc/.test(c)) && callers.some((c) => /stripsFor/.test(c)),
     '...the Cut tab (forDoc) and the Baseline strips (stripsFor), each passing its own doc');
}

console.log('\nlandingTab keeps its own test on purpose — a DIFFERENT question');
{
  /* It asks "does this doc have audio at all, so should we land on Cut?", for which a paused download
   * SHOULD still count. Sharing one helper across both questions is how a later change silently
   * answers one of them wrongly — the same mechanism as the drift above, running the other way. */
  const landing = (app.match(/const audioHere = docSegments\(current\.doc\)[\s\S]*?;\n/) || [''])[0];
  ok(/pendingAudio && !current\.audioError/.test(landing),
     'landingTab still excludes a failed download itself');
  ok(!/audioStillComing/.test(landing),
     '...without being collapsed into the helper, because a paused download should still land on Cut');
}

console.log(fail ? `\nFAILED (${fail}) — "still coming" has drifted apart again.\n`
                 : '\nPASS: one definition of "still coming", asked by both screens.\n');
process.exit(fail ? 1 : 0);
