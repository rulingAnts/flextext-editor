/* THE ASSIGNMENT TITLE FILLS ITSELF IN — the panel's assign modal (Seth, 2026-08-14).
 *
 * "have a new text title default to the flextext filename (minus the file extension) if there is
 *  one, and the audio file's filename (minus the file extension) if there isn't. And of course
 *  manually editable in the title field and the manual edit is the final source of authority. But if
 *  it's blank and a file is attached, then populate it with the filename. If the filename is the
 *  same as the audio, and then a flextext file is added, pull the title from within the flextext XML
 *  (should be near the top) and populate the title field with that."
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
    const ftBase = baseName(ftName);
    const audioBase = audioName ? baseName(audioName) : '';
    if (audioBase && ftBase.toLowerCase() === audioBase.toLowerCase()) {
      try {
        const parsed = parseFlextext(ftXml || '');
        const inner = ((parsed.texts && parsed.texts[0] && parsed.texts[0].title) || '').trim();
        if (inner) return inner;
      } catch { /* fall through to the filename */ }
    }
    return ftBase;
  }
  return audioName ? baseName(audioName) : '';
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

console.log('\nsame base name ⇒ the filename says nothing new, so read the title INSIDE the file');
{
  const st = fillTitle({ value: 'Story', touched: false },
    { audioName: 'Story.mp3', ftName: 'Story.flextext', ftXml: XML('Kisah Ular yang Kami Makan') });
  ok(st.value === 'Kisah Ular yang Kami Makan',
     `the flextext's own title replaces the redundant filename ("${st.value}")`);
  // Case-insensitively, because file systems and exporters disagree about case.
  const st2 = fillTitle({ value: 'story', touched: false },
    { audioName: 'story.MP3', ftName: 'Story.flextext', ftXml: XML('Inner Title') });
  ok(st2.value === 'Inner Title', 'and the base names are compared without regard to case');
  // A flextext with no usable inner title falls back rather than blanking the field.
  const st3 = fillTitle({ value: '', touched: false },
    { audioName: 'Story.mp3', ftName: 'Story.flextext', ftXml: XML('   ') });
  ok(st3.value === 'Story', 'an empty inner title falls back to the filename');
  const st4 = fillTitle({ value: '', touched: false },
    { audioName: 'Story.mp3', ftName: 'Story.flextext', ftXml: 'not xml at all' });
  ok(st4.value === 'Story', 'and so does an unreadable file — the send handler reports that properly');
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
  const better = fillTitle(auto, { audioName: 'Story.mp3', ftName: 'Story.flextext', ftXml: XML('Real Title') });
  ok(better.value === 'Real Title', 'and an auto-filled title is replaced when a truer one arrives');
}

console.log('\nthe rules are in the panel, not only in this model');
{
  const fn = (panel.match(/function assignModal\(instanceId\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(/let touched = false;/.test(fn) && /titleInput\.addEventListener\('input'/.test(fn),
     'typing latches the manual-authority flag');
  ok(/if \(touched && titleInput\.value\.trim\(\)\) return;/.test(fn),
     '…and a typed, non-empty title is never overwritten');
  ok(/ftBase\.toLowerCase\(\) === audioBase\.toLowerCase\(\)/.test(fn),
     'the same-base-name case is compared case-insensitively');
  ok(/parsed\.texts\[0\]\.title/.test(fn), '…and reads the title from inside the flextext');
  ok(/audioInput\.addEventListener\('change', fillTitle\)/.test(fn)
     && /ftInput\.addEventListener\('change', fillTitle\)/.test(fn),
     'both file inputs trigger it');
  ok(/replace\(\/\\\.\[\^\.\/\\\\\]\+\$\/, ''\)/.test(fn) || /baseName = /.test(fn),
     'and the extension is stripped in one named helper');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
