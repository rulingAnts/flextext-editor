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

/* ---------------------------------------------------------------------------------------------
 * AND THE STRIPS DO NOT EXIST UNTIL THE AUDIO DOES (Seth, 2026-08-07).
 *
 * THE ACTUAL BUG, reproduced at last with a 6:02 recording (his, in Firefox; four earlier attempts
 * at 7s and 90s all missed it because the decode won the race every time):
 *   t+0.3s .. t+20s   doc.segments = [{ timePending: true }]   — the "⋯" button and the flat line
 *   after leave+return [{ start: 0, end: 362000 }]             — healed, which is the workaround
 *
 * newDocFromAudio enters the editor BEFORE it awaits attachAudioFile, so the Baseline tab set
 * itself up with NO media, seeded a span with no duration — `timePending` — and nothing re-rendered
 * when the decode finally landed.
 *
 * The fix is Seth's: don't show the UI until the audio is ready. That is also the honest shape — a
 * span seeded before the duration is known is not a placeholder, it is a wrong alignment written to
 * the doc.
 * --------------------------------------------------------------------------------------------- */
const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
/* ⚠ Count inside the en/id BLOCKS, not across the file: a third language (tpi) translating this key
 * would push a file-wide count to 3 and fail a test that has found nothing wrong. */
const i18nBlock = (lang) => {
  const at = i18n.indexOf(`\n${lang}: {`);
  const rest = i18n.slice(at + 1);
  const nxt = rest.search(/\n[a-z]{2,3}: \{/);
  return nxt < 0 ? i18n.slice(at) : i18n.slice(at, at + 1 + nxt);
};
const inEnAndId = (k) => {
  const re = new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'm');
  return (re.test(i18nBlock('en')) ? 1 : 0) + (re.test(i18nBlock('id')) ? 1 : 0);
};


console.log('\nthe strips stay hidden until the peaks are in');
ok(/\$\('#segment-strips'\)\.hidden = true;\s*\n\s*\$\('#baseline-text'\)\.hidden = true;\s*\n\s*\$\('#seg-loading'\)\.hidden = false;/.test(app),
   'entering the tab shows the loading line, NOT an empty strip list');
ok(/await ensurePeaks\([\s\S]{0,220}?\$\('#seg-loading'\)\.hidden = true;\s*\n\s*\$\('#segment-strips'\)\.hidden = false;\s*\n\s*renderStrips\(\);/.test(app),
   'and they are revealed only AFTER ensurePeaks resolves');
ok(/id="seg-loading"[^>]*hidden[^>]*data-i18n="seg\.loadingAudio"/.test(html), 'the placeholder exists in the markup');
ok(inEnAndId('seg.loadingAudio') === 2, 'and is translated in BOTH languages');

console.log('\nno audio at all falls back to the classic editor');
ok(/if \(!media \|\| !media\.blob\) \{/.test(app), 'the no-media case is handled explicitly');
ok(/\$\('#baseline-text'\)\.value = getBaselineParagraphs\(current\.doc\)\.join\('\\n'\);[\s\S]{0,160}\$\('#baseline-text'\)\.hidden = false;/.test(app),
   '⚠ the value is set BEFORE it is unhidden — applyBaseline is gated on DOM truth, and an unhidden '
   + 'empty textarea would be read as "the user cleared the text" and WIPE the doc');

console.log('\nattaching audio rebuilds the strips — nothing else would notice');
const attach = app.match(/async function attachAudioFile\(file\) \{[\s\S]*?\n\}/);
ok(!!attach && /if \(segmentationEnabled\(\) && isEditorTab\(activeTab\)\) switchTab\(activeTab\);/.test(attach[0]),
   'attachAudioFile re-enters the tab (it is not a tab switch and not a settings change)');
ok(/const stripsFor = current && current\.id;/.test(app) && (app.match(/current\.id !== stripsFor/g) || []).length >= 2,
   'and the async build bails if the doc changed under it, on both sides of the await');

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASSED\n');
process.exit(fail ? 1 : 0);
