/* The editor's Utilities converter against the researcher panel's audioConverterModal().
 *
 * WHY THIS TEST EXISTS: the editor's converter was MP3-ONLY, at a fixed bitrate and sample rate,
 * while the panel offered every conversion validOutputs() permits. A standalone researcher — who has
 * no panel — simply could not reach conversions the suite performs, and nothing anywhere said so.
 * The two are now feature-matched, and deliberately NOT shared code (researcher-panel.js is also the
 * standalone Researcher app's, so an editor screen must not route through it). Hand-kept parity
 * drifts silently, so it is checked here.
 *
 * ⚠ THE PROPERTY THAT MATTERS MOST IS NOT PARITY, IT IS THE DIRECTION OF CONVERSION. validOutputs()
 * offers DOWNWARD conversions only: a lossy source may become a smaller MP3 and nothing else, never
 * WAV or FLAC. Widen that and the tool produces files that LOOK archival and are not — the damage is
 * already permanent, and the new container hides it from everyone downstream forever. The UI must
 * take its option list FROM that function and never assemble one of its own, so that is asserted
 * about the code rather than trusted.
 *
 * Run: node test/audio-converter.test.mjs
 */
import { readFileSync } from 'node:fs';
import { validOutputs, detectFormat, readWavHeader } from '../docs/js/convert.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const app = read('../docs/js/app.js');
const panel = read('../docs/js/researcher-panel.js');
const html = read('../docs/index.html');
const i18n = read('../docs/js/i18n.js');
/* ⚠ COUNT WITHIN A BLOCK, NOT ACROSS THE FILE. "appears exactly twice" was a fine proxy for
 * "in both en and id" while those were the only two dictionaries; the moment a third language
 * (tpi) defines the same key the count becomes 3 and a passing test fails for no real reason.
 * Worse, it would keep passing if a key were defined twice in en and never in id. */
const blockOf = (lang) => {
  const at = i18n.indexOf(`\n${lang}: {`);
  const rest = i18n.slice(at + 1);
  const nxt = rest.search(/\n[a-z]{2,3}: \{/);
  return nxt < 0 ? i18n.slice(at) : i18n.slice(at, at + 1 + nxt);
};
const EN_BLOCK = blockOf('en'), ID_BLOCK = blockOf('id');
const inBoth = (k) => {
  const re = new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'm');
  return (re.test(EN_BLOCK) ? 1 : 0) + (re.test(ID_BLOCK) ? 1 : 0);
};

console.log('\nDOWNWARD ONLY — a lossy source can never be offered a lossless container');
for (const src of ['mp3', 'ogg', 'aiff', null]) {
  const outs = validOutputs(src, null);
  ok(outs.every((o) => o.format === 'mp3'),
     `${src || 'unknown'} source offers MP3 only (${outs.map((o) => o.value).join(', ')}) — never "fake lossless"`);
}
console.log('\n...and a WAV source is offered only depths BELOW its own');
{
  const o16 = validOutputs('wav', 16).map((o) => o.value);
  ok(!o16.includes('wav24') && !o16.includes('wav32'), `16-bit WAV cannot inflate to 24/32 (${o16.join(', ')})`);
  const o24 = validOutputs('wav', 24).map((o) => o.value);
  ok(o24.includes('wav16') && !o24.includes('wav24'), `24-bit offers 16 but not itself (${o24.join(', ')})`);
  const o32 = validOutputs('wav', 32).map((o) => o.value);
  ok(o32.includes('wav24') && o32.includes('wav16'), `32-bit float offers both integer depths (${o32.join(', ')})`);
  ok(o32.includes('flac24') && o32.includes('mp3'), 'and FLAC + MP3');
}

console.log('\nthe editor takes its option list FROM validOutputs, and does not assemble one');
ok(/import \{[^}]*\bvalidOutputs\b[^}]*\} from '\.\/convert\.js'/.test(app), 'app.js imports validOutputs');
ok(/const outs = validOutputs\(fmt, bits\);/.test(app), 'and calls it with the DETECTED format and depth');
ok(/fmtSel\.innerHTML = outs\.map\(/.test(app), 'the dropdown is built from its result, nothing else');
ok(!/<option value="wav24"|<option value="flac24"/.test(html),
   'the markup hard-codes NO output format — a static list could offer a forbidden conversion');

console.log('\nfeature parity with the panel: every control the panel offers exists here');
// The panel's own modal, lifted, so this compares against the real thing rather than a description.
const modal = panel.match(/function audioConverterModal\(\) \{[\s\S]*?\n\}/);
ok(!!modal, 'the panel modal is findable');
const pm = modal ? modal[0] : '';
const CONTROLS = [
  ['output format', /id="cv-fmt"/, /id="uc-fmt"/],
  ['mono/channel mode', /id="cv-mono"/, /id="uc-mono"/],
  ['MP3 bitrate', /id="cv-kbps"/, /id="uc-kbps"/],
  ['MP3 sample rate', /id="cv-rate"/, /id="uc-rate"/],
  ['MP3-only options block', /id="cv-mp3opts"/, /id="uc-mp3opts"/],
  ['source summary line', /id="cv-src"/, /id="uc-src"/],
  ['before player', /id="cv-src-player"/, /id="uc-src-player"/],
  ['after player', /id="cv-out-player"/, /id="uc-out-player"/],
  ['stereo channel hint', /id="cv-chan-hint"/, /id="uc-chan-hint"/],
];
for (const [name, inPanel, inEditor] of CONTROLS) {
  ok(inPanel.test(pm), `the panel has a ${name}`);
  ok(inEditor.test(html) || inEditor.test(app), `  ...and so does the editor`);
}
// Every mono mode, by value — a missing one silently removes a choice.
for (const v of ['keep', 'auto', 'mix', 'left', 'right']) {
  ok(new RegExp(`value="${v}"`).test(html), `mono mode "${v}" is offered in the editor`);
  ok(new RegExp(`value="${v}"`).test(pm), `  ...as it is in the panel`);
}
for (const k of ['32', '48', '64', '96', '128']) ok(new RegExp(`<option value="${k}"`).test(html), `bitrate ${k} offered`);
for (const r of ['16000', '22050', '44100']) ok(new RegExp(`<option value="${r}"`).test(html), `sample rate ${r} offered`);

console.log('\nthe MP3-only options hide for lossless targets (bitrate means nothing to a WAV)');
ok(/mp3opts\.hidden = o\.format !== 'mp3';/.test(app), 'the editor hides them off the chosen format');
ok(/mp3opts\.hidden = o\.format !== 'mp3';/.test(pm), 'as the panel does');

console.log('\nthe channel controls follow the DECODED channel count, not the header alone');
/* A header can be absent (any non-WAV source) or wrong. Trusting it alone would hide the left/right
 * choice on a stereo MP3 — the format most likely to have a usable voice on one channel only. */
ok(/srcWs\.on\('ready', \(\) => \{[\s\S]*?getDecodedData\(\)[\s\S]*?setStereoUi\(nch >= 2\);/.test(app),
   'the editor refines the stereo UI once decoding finishes');
ok(/setStereoUi\(chans == null \|\| chans >= 2\);/.test(app),
   'and assumes stereo until told otherwise, so the choice is never missing when it matters');

console.log('\nresources are released — a converter is opened repeatedly in one session');
ok(/const destroyPlayers = \(\) => \{[\s\S]*?URL\.revokeObjectURL/.test(app), 'players and object URLs are torn down');
ok(/destroyPlayers\(\);\s*\n\s*\$\('#uc-out-wrap'\)\.hidden = true;/.test(app), 'and on every new file, before the next pair is made');

console.log('\nA CONVERTED WAV IS HONEST IN THE BYTES AND IN THE NAME — both, not either');
const conv = read('../docs/js/convert.js');
/* A filename is the first thing to be lost: files get renamed, re-downloaded and handed on, and
 * the next person has only the bytes. So the bext chunk is the label that survives — and the name
 * is what someone reads first. Neither alone is enough, which is why both are asserted. */
ok(/import \{ wavWithBext \} from '\.\/seg-exports\.js';/.test(conv), 'convert.js writes a BWF bext chunk');
ok(/wavWithBext\(await wav\.arrayBuffer\(\)/.test(conv), 'and stamps the WAV it just encoded');
ok(/ext: 'wav', mime: 'audio\/wav', derived: true/.test(conv), 'a WAV result is flagged derived');
ok(/res\.derived \? '-converted' : ''/.test(app), 'the editor marks the filename from that flag');
ok(/res\.derived \? '-converted' : ''/.test(panel), 'and so does the panel — same converter, same honesty');
ok(/catch \{ \/\* stamping is honesty, not correctness: never fail the conversion over it \*\/ \}/.test(conv),
   'a stamping failure never loses the user their conversion');

console.log('\n...and the history does NOT overstate what was done');
/* Overstating is the same failure as hiding: a reader who meets one false warning stops trusting
 * the true ones. 32f->24 is a FAITHFUL reduction by the standards (float32 carries a 24-bit
 * mantissa); only a real drop in resolution may be called irreversible. */
ok(/float-to-24-bit reduction \(faithful\)/.test(conv), '32-bit float to 24-bit is called faithful');
ok(/requantised \$\{srcBits\}-bit to \$\{outBits\}-bit \(irreversible\)/.test(conv),
   'a genuine requantisation is called irreversible');
ok(/if \(mono && mono !== 'keep' && outChans < srcChans\)/.test(conv),
   'a channel EDIT is recorded only when the channel count actually changed (auto on a stereo file is not an edit)');
ok(/re-wrapped, samples unchanged/.test(conv), 'and a no-op conversion says exactly that');
ok(/const srcChans = chans\.length;[\s\S]{0,200}if \(opts\.mono && opts\.mono !== 'keep'\) chans = pickMono/.test(conv),
   'the source facts are captured BEFORE pickMono rewrites them');

console.log('\nno new precached file was needed for any of this');
/* wavesurfer.esm.js is already in every OFFLINE-CAPABLE sw.js SHELL (audio.js imports it) and
 * convert.js was already imported here — so this feature adds NO SHELL entry. A new precached
 * module would have to be added to the editor AND the offline satellites' sw.js files in the same
 * commit, or an updated satellite is dead offline (the v108 outage).
 * ⚠ The RESEARCHER satellite is deliberately absent since 2026-08-31: its worker caches nothing
 * (the panel is an online console; see satellites/flextext-researcher/sw.js), so it has no SHELL
 * to keep in sync — that is the design, not an omission. */
for (const sw of ['../docs/sw.js', '../satellites/text-recorder/sw.js',
                  '../paragraph-analysis/sw.js']) {
  const src = read(sw);
  ok(/vendor\/wavesurfer\.esm\.js/.test(src), `${sw.split('/').slice(-2).join('/')} already precaches wavesurfer`);
  ok(/js\/convert\.js/.test(src), `  ...and convert.js`);
}

console.log('\nconvertToMp3 is STILL imported — it has other callers');
/* Dropped from the import while swapping in convertAudio, this is a ReferenceError at runtime in the
 * consent-recording and saveRecording paths, and `node --check` cannot see it. */
ok(/import \{[^}]*\bconvertToMp3\b[^}]*\} from '\.\/convert\.js'/.test(app), 'still imported');
ok((app.match(/\bconvertToMp3\(/g) || []).length >= 2, 'and still called from the recording paths');

console.log('\nevery string it renders is translated');
const KEYS = ['convert.h', 'convert.note2', 'convert.pick', 'convert.go', 'convert.outFmt', 'convert.monoMode',
              'convert.mono.keep', 'convert.mono.auto', 'convert.mono.mix', 'convert.mono.left', 'convert.mono.right',
              'convert.kbps', 'convert.rate', 'convert.src', 'convert.bit', 'convert.stereo', 'convert.monoSrc',
              'convert.fmtUnknown', 'convert.before', 'convert.after', 'convert.chanHint', 'convert.play',
              'convert.working', 'convert.done', 'convert.failed', 'recfmt.helpLink'];
for (const k of KEYS) {
  const n = inBoth(k);
  ok(n === 2, `${k} is in BOTH en and id (found ${n})`);
}
// The format labels are built by concatenation — t('convert.fmt.' + value) — so expand them against
// every value validOutputs can actually produce, or a dropdown shows a raw key.
const produced = new Set();
for (const [f, b] of [['wav', 32], ['wav', 24], ['wav', 16], ['mp3', null], ['flac', null], [null, null]]) {
  for (const o of validOutputs(f, b)) produced.add(o.value);
}
for (const v of produced) {
  const n = inBoth('convert.fmt.' + v);
  ok(n === 2, `convert.fmt.${v} (a format validOutputs can emit) is in BOTH en and id (found ${n})`);
}

console.log(fail ? `\nFAILED (${fail})\n` : `\nPASSED\n`);
process.exit(fail ? 1 : 0);
