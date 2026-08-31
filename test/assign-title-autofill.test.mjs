/* THE ASSIGNMENT TITLE FILLS ITSELF IN — the panel's assign modal (Seth, 2026-08-14).
 *
 * The priority order, highest first, in his words:
 *   (1) what the researcher types into that box (if they type something)
 *   (2) the title of the text in the flextext file's xml code (first title that shows up)
 *   (3) the name of the flextext file
 *   (4) the name of the audio file
 *
 * So a flextext is asked what it calls ITSELF before its filename is considered — FLEx stores a real
 * title, and "export_final_2.flextext" is a fact about somebody's desktop, not about the text.
 *
 * ⚠ MODELLED, NOT MOCKED — the same limitation as send-capability-trap.test.mjs: assignModal lives
 * in researcher-panel.js, which needs a browser. This reimplements the RULES and then asserts the
 * source still matches them, so a rewrite that drops one is caught.
 *
 * Run: node test/assign-title-autofill.test.mjs
 */
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';

// flextext.js's parser needs a DOM; the repo already carries a minimal one for exactly this.
installMiniXmlDom();
const { parseFlextext } = await import('../docs/js/flextext.js');

const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const baseName = (n) => String(n || '').replace(/\.[^./\\]+$/, '').trim();

/* The model. `ftXml` stands in for reading the attached file. */
function autoTitle({ audioName, ftName, ftXml }) {
  if (ftName) {
    try {
      const parsed = parseFlextext(ftXml || '');
      const inner = ((parsed.texts && parsed.texts[0] && parsed.texts[0].title) || '').trim();
      if (inner) return inner;                       // (2)
    } catch { /* fall through to the filename */ }
    return baseName(ftName);                         // (3)
  }
  return audioName ? baseName(audioName) : '';       // (4)
}
function fillTitle(state, files) {
  if (state.touched && state.value.trim()) return state;      // their words stand
  const next = autoTitle(files);
  return next ? { ...state, value: next } : state;
}

const XML = (title) => `<?xml version="1.0" encoding="utf-8"?>
<document version="2"><interlinear-text><item type="title" lang="en">${title}</item>
<paragraphs><paragraph><phrases><phrase><item type="txt" lang="und">kata</item></phrase></phrases></paragraph></paragraphs>
</interlinear-text></document>`;

console.log('\nthe filename becomes the title');
{
  let st = { value: '', touched: false };
  st = fillTitle(st, { audioName: 'Cerita Jaha.mp3' });
  ok(st.value === 'Cerita Jaha', `audio alone → its filename without the extension ("${st.value}")`);

  let st2 = fillTitle({ value: '', touched: false }, { ftName: 'Snakes We Eat.flextext' });
  ok(st2.value === 'Snakes We Eat', `a flextext alone → its filename ("${st2.value}")`);

  let st3 = fillTitle({ value: '', touched: false },
    { audioName: 'recording-004.m4a', ftName: 'Snakes We Eat.flextext' });
  ok(st3.value === 'Snakes We Eat', 'with both and different names, the FLEXTEXT filename wins');

  ok(baseName('a.b.c.flextext') === 'a.b.c', 'only the LAST extension is stripped, so dotted names survive');
  ok(baseName('no-extension') === 'no-extension', 'and a name with no extension is left alone');
}

console.log('\nthe flextext is asked what it calls ITSELF before its filename is used');
{
  const st = fillTitle({ value: '', touched: false },
    { ftName: 'export_final_2.flextext', ftXml: XML('Kisah Ular yang Kami Makan') });
  ok(st.value === 'Kisah Ular yang Kami Makan',
     `the XML title beats the flextext filename outright ("${st.value}")`);
  const st2 = fillTitle({ value: '', touched: false },
    { audioName: 'Story.mp3', ftName: 'Story.flextext', ftXml: XML('Inner Title') });
  ok(st2.value === 'Inner Title', '…including when the two files share a base name');
  const st3 = fillTitle({ value: '', touched: false },
    { audioName: 'recording-004.m4a', ftName: 'Snakes We Eat.flextext', ftXml: XML('   ') });
  ok(st3.value === 'Snakes We Eat', 'a flextext with no usable title falls back to its filename (3)');
  const st4 = fillTitle({ value: '', touched: false },
    { audioName: 'Cerita Jaha.mp3', ftName: 'Broken.flextext', ftXml: 'not xml at all' });
  ok(st4.value === 'Broken', 'and so does an unreadable one — never silently down to the audio name');
  const st5 = fillTitle({ value: '', touched: false }, { audioName: 'Cerita Jaha.mp3' });
  ok(st5.value === 'Cerita Jaha', 'the audio filename is the last resort (4)');
  // The FIRST title in the file, per Seth: "first title that shows up".
  ok(/texts\[0\]/.test(autoTitle.toString()), 'and it is the FIRST text\'s title that is used');
}

console.log('\nwhat the researcher typed is the final authority');
{
  const typed = fillTitle({ value: 'My own title', touched: true }, { audioName: 'Whatever.mp3' });
  ok(typed.value === 'My own title', 'attaching a file does NOT overwrite a title they typed');
  const then = fillTitle(typed, { audioName: 'Whatever.mp3', ftName: 'Other.flextext' });
  ok(then.value === 'My own title', '…and neither does attaching a flextext afterwards');
  // Emptying the field asks for the default back — an assignment with no title helps nobody.
  const cleared = fillTitle({ value: '   ', touched: true }, { audioName: 'Cerita Jaha.mp3' });
  ok(cleared.value === 'Cerita Jaha', 'but a field they EMPTIED is refilled — that is a request, not a blank');
  // An auto-filled value is not "theirs", so a better source still wins.
  const auto = fillTitle({ value: '', touched: false }, { audioName: 'Story.mp3' });
  ok(auto.value === 'Story', 'an audio-only assignment starts at the audio name…');
  const better = fillTitle(auto, { audioName: 'Story.mp3', ftName: 'Story.flextext', ftXml: XML('Real Title') });
  ok(better.value === 'Real Title', '…and is replaced when a higher-priority source arrives');
}

console.log('\nthe rules are in the panel, not only in this model');
{
  // v544 gave assignModal a `target` (an instanceId, or a project — issue #4). The slice follows
  // the signature; every claim below is about title autofill and is unaffected by the destination.
  const fn = (panel.match(/function assignModal\(target\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(/let touched = false;/.test(fn) && /titleInput\.addEventListener\('input'/.test(fn),
     'typing latches the manual-authority flag');
  ok(/if \(touched && titleInput\.value\.trim\(\)\) return;/.test(fn),
     '…and a typed, non-empty title is never overwritten');
  ok(/parsed\.texts\[0\]\.title/.test(fn), 'the panel reads the FIRST text\'s title from inside the flextext');
  ok(fn.indexOf('if (inner) return inner;') < fn.indexOf('return baseName(ft.name);'),
     '…and prefers it over the flextext filename, which is the fallback beneath it');
  ok(fn.indexOf('return baseName(ft.name);') < fn.indexOf('audio ? baseName(audio.name)'),
     '…which in turn sits above the audio filename');
  ok(/audioInput\.addEventListener\('change', fillTitle\)/.test(fn)
     && /ftInput\.addEventListener\('change', fillTitle\)/.test(fn),
     'both file inputs trigger it');
  ok(/replace\(\/\\\.\[\^\.\/\\\\\]\+\$\/, ''\)/.test(fn) || /baseName = /.test(fn),
     'and the extension is stripped in one named helper');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
