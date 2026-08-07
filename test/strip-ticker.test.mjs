/* The strips' requestAnimationFrame loop must be UNKILLABLE.
 *
 * WHY THIS TEST EXISTS: that loop is not only the playhead. fixStaleWave() — the ONLY thing that
 * ever redraws a baseline strip canvas which was drawn before its peaks finished decoding — is
 * called from inside it and from nowhere else. So if the loop stops, a strip that rendered during
 * the decode stays blank for as long as the tab is open, and the only cure is leaving and coming
 * back, which calls positionCursor() again and starts a new loop.
 *
 * That is exactly the shape of the bug Seth has reported repeatedly: "it still fails to load the
 * segmentable audio the first time (no wave display) until I refresh or exit and come back."
 *
 * And the loop COULD be stopped by one exception: `rafId = requestAnimationFrame(tick)` sat at the
 * end of the body, so anything throwing above it never re-armed — permanently, with no visible
 * error unless a console was open. docSegments(null) threw precisely there ("Cannot read properties
 * of null (reading 'segments')") on every run of the browser repro, whenever the editor was left.
 *
 * ⚠ NOT CLAIMED AS A REPRODUCTION OF SETH'S BUG. Four separate constructions failed to reproduce a
 * blank wave, so this is a real defect with a matching mechanism, not a confirmed diagnosis. The
 * assertions below are about the STRUCTURE — a loop that cannot die — because that is what makes
 * the whole class impossible rather than one instance of it.
 *
 * Run: node test/strip-ticker.test.mjs
 */
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../docs/js/segment-strips.js', import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

console.log('\nthe ticker re-arms in a finally, so nothing can end it');
const tick = src.match(/function positionCursor\(\) \{[\s\S]*?\n\}/);
ok(!!tick, 'positionCursor is findable');
const body = tick ? tick[0] : '';
ok(/\} finally \{[\s\S]{0,200}rafId = requestAnimationFrame\(tick\);[\s\S]{0,40}\}/.test(body),
   'the re-arm is inside a finally block');
ok(/const tick = \(\) => \{\s*\n\s*try \{/.test(body), 'and the whole body is inside the try');
// The old shape: the re-arm as the last statement of the body, reachable only if nothing threw.
ok(!/\}\);\s*\n\s*rafId = requestAnimationFrame\(tick\);\s*\n\s*\};/.test(body),
   'the old unguarded trailing re-arm is gone');

console.log('\nand it does not dereference a document that is no longer open');
ok(/const doc = deps\.getDoc\(\);/.test(body) && /if \(!doc\) return;/.test(body),
   'the tick bails when the editor has been left');
ok(/docSegments\(doc\)\[i\]/.test(body), 'and passes the checked doc, not a fresh getDoc() call');

console.log('\ndocSegments itself tolerates it too — it is exported and called from that loop');
const ds = src.match(/export function docSegments\(doc\) \{[\s\S]*?\n\}/);
ok(!!ds && /if \(!doc\) return \[\];/.test(ds[0]), 'docSegments(null) returns [] instead of throwing');

console.log('\nfixStaleWave really is reached only from the ticker (why a dead loop is fatal)');
const calls = (src.match(/fixStaleWave\(/g) || []).length;
ok(calls >= 2, `fixStaleWave is called ${calls}× (definition + call sites)`);
ok(/fixStaleWave\(row\.querySelector\('\.seg-wave'\)\);/.test(body),
   'the baseline strips get theirs from inside the tick — so a stopped tick never repairs them');
ok(/canvas\.__peaksGen !== peaksGen/.test(src),
   'and the staleness test is the peaks GENERATION, not just width (a right-sized blank canvas)');

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASSED\n');
process.exit(fail ? 1 : 0);
