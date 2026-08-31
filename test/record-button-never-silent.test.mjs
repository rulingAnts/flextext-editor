/* The Record button must never fail in silence.
 *
 * WHY THIS EXISTS: a crowd recorder was reported "broken" — pressing Record did nothing at all. No
 * modal, no toast, no error a user could report. The cause went with the recorder when it was
 * deleted, and that is the point: it could not be diagnosed because the failure had no voice.
 *
 * The mechanism was structural, not specific to that recorder. `requestConsentThen` is async, and
 * all three record buttons called it as a bare `() => requestConsentThen(...)` listener — no await,
 * no catch. Any throw inside the consent gate became an unhandled rejection, and the button did
 * nothing. That is indistinguishable from a dead click, on a PUBLIC page used by people who cannot
 * open a console, let alone report what is in it.
 *
 * So: one guarded entry point, used by every record button, that surfaces a failure. These
 * assertions are about the SHAPE that keeps it that way — a future refactor that re-inlines the
 * async call would silently restore the old behaviour, which is exactly what happened once. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(root, 'docs/js/app.js'), 'utf8');
const i18n = readFileSync(join(root, 'docs/js/i18n.js'), 'utf8');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

console.log('there is exactly one guarded way into the consent gate from a button');
{
  const fnSrc = (app.match(/function startConsentThenRecord\(\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(!!fnSrc, 'startConsentThenRecord exists');
  ok(/\.catch\(/.test(fnSrc), '...and it catches — the whole point');
  ok(/console\.error\(/.test(fnSrc), '...logs the real error for whoever can read a console');
  ok(/toast\(t\('consent\.gateFailed'\)/.test(fnSrc), '...and tells the person in front of the screen');
}

console.log('\nevery record button uses it — none re-inlines the unguarded call');
{
  const listeners = app.match(/addEventListener\('click',[^)]*requestConsentThen[^)]*\)/g) || [];
  ok(listeners.length === 0,
     'no click listener calls requestConsentThen directly' + (listeners.length ? `: ${listeners[0]}` : ''));
  const guarded = (app.match(/addEventListener\('click', startConsentThenRecord\)/g) || []).length;
  ok(guarded === 3, `all three record buttons route through the guard (found ${guarded})`);
}

console.log('\nthe message is honest and exists in both languages');
{
  const en = (i18n.match(/'consent\.gateFailed': '([^']*)'/) || [])[1] || '';
  ok(/did not start|tidak dimulai/i.test(en), 'it says recording did NOT start, rather than implying it did');
  ok(/reload|try again/i.test(en), '...and gives the person something to do');
  const block = (lang) => {
    const at = i18n.indexOf(`\n${lang}: {`);
    const rest = i18n.slice(at + 1);
    const nxt = rest.search(/\n[a-z]{2,3}: \{/);
    return nxt < 0 ? i18n.slice(at) : i18n.slice(at, at + 1 + nxt);
  };
  ok(/'consent\.gateFailed':/.test(block('en')) && /'consent\.gateFailed':/.test(block('id')),
     'present in en AND id — the crowd page is public and often Indonesian');
}

console.log(failures ? `\nFAILED (${failures})` : '\nall passed');
process.exit(failures ? 1 : 0);
