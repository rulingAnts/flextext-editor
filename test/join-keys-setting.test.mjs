/* BACKSPACE/DELETE-TO-JOIN IS RESEARCHER-GATED, AND OFF BY DEFAULT.
 *
 * Seth, 2026-08-13: "I'd like to have a researcher panel setting per device (disabled by default) to
 * enable/disable backspace to join. Our join buttons are reliable enough now that we don't need it,
 * and some users are finding it too easy to accidentally join lines and then they don't want to
 * split them again."
 *
 * ⚠ WHAT MAKES THIS WORTH PINNING: "off by default" is a deliberate behaviour CHANGE for every
 * device already in the field — the keys work today and stop working on update. That is the intent
 * (an accidental join is silent, and the transcriber has to notice it and undo it, which costs more
 * than the shortcut is worth now that the buttons are reliable). But it is exactly the kind of
 * intentional regression a later reader "fixes" by flipping the default back, so the polarity is
 * asserted here with its reason.
 *
 * The rules:
 *   1. `=== true`, not `!== false` — absent means OFF, the OPPOSITE of `segmentation`.
 *   2. All FOUR join sites are gated: baseline Backspace, baseline Delete, first-gloss Backspace,
 *      free-translation Backspace. A setting that removes the accident by one key and leaves it on
 *      another has not removed it.
 *   3. A disabled key FALLS THROUGH to normal editing — it is not swallowed, which would read as a
 *      broken keyboard.
 *   4. The join BUTTONS are untouched. They are the route the setting assumes you will use.
 *   5. The strips read it through a FUNCTION, so a mid-session researcher push takes effect.
 *
 * Run: node test/join-keys-setting.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const app = read('../docs/js/app.js');
const strips = read('../docs/js/segment-strips.js');
const panel = read('../docs/js/researcher-panel.js');
const i18n = read('../docs/js/i18n.js');

console.log('\nthe gate exists and its DEFAULT IS OFF');
{
  const fn = (app.match(/function joinKeysEnabled\(\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(/settings\.backspaceJoin === true/.test(fn),
     'reads `=== true` — absent means OFF');
  /* ⚠ THE POLARITY IS THE WHOLE FEATURE. `!== false` would default it ON and quietly restore the
   * accidental joins this exists to stop, while still LOOKING like a working setting in the panel. */
  ok(!/settings\.backspaceJoin !== false/.test(app),
     'and NOT `!== false`, which would default it on and undo the point');
  // segmentation defaults the other way; the two must not be confused for each other.
  ok(/s\.segmentation !== false/.test(panel),
     'segmentation still defaults ON — the two polarities are deliberate and different');
}

console.log('\nall FOUR join sites are gated');
{
  ok(/if \(!\(deps\.joinKeys && deps\.joinKeys\(\)\)\) return;/.test(strips),
     'the baseline strips check it');
  ok((strips.match(/deps\.joinKeys && deps\.joinKeys\(\)/g) || []).length === 2,
     '...at BOTH the Backspace and the Delete branch');
  /* Delete-at-end is the same gesture from the other side and makes the identical accidental join.
   * Gating one and not the other would leave the accident reachable by a different key — the
   * "rule enforced in one place the other path reaches around" drift the backlog warns about. */
  ok(/e\.key === 'Delete'[\s\S]{0,260}?deps\.joinKeys/.test(strips),
     'Delete-at-end-of-line specifically, not just Backspace');
  ok(/if \(!joinKeysEnabled\(\)\) return;[^\n]*\n\s*e\.preventDefault\(\);\s*\n\s*glossJoinLines/.test(app),
     'the first-gloss Backspace checks it');
  ok(/e\.key === 'Backspace' && atStart && i > 0 && joinKeysEnabled\(\)/.test(app),
     'and so does the free-translation Backspace');
}

console.log('\n...and a disabled key falls through to normal editing');
{
  /* A swallowed Backspace reads as a broken keyboard, which is a worse bug than the one being
   * fixed. `return` BEFORE preventDefault is what makes the key just delete a character. */
  const at = strips.indexOf("deps.joinKeys && deps.joinKeys()");
  const seg = strips.slice(at - 120, at + 120);
  ok(/return;/.test(seg) && seg.indexOf('return;') < seg.indexOf('preventDefault'),
     'the guard returns BEFORE preventDefault, so the key still types');
  ok(/if \(!joinKeysEnabled\(\)\) return;   \/\/ researcher-disabled/.test(app),
     'same in the gloss handler, and it says why');
}

console.log('\nthe join BUTTONS are untouched — they are the route this assumes');
{
  /* The setting removes a shortcut, never the capability. If the buttons were gated too, the
   * researcher would be disabling joining altogether, which is not what was asked for. */
  const btn = strips.slice(strips.indexOf('exactly what Backspace calls (mergeAt)') - 400,
                           strips.indexOf('exactly what Backspace calls (mergeAt)') + 900);
  ok(!/joinKeys/.test(btn), 'the join button path never consults the setting');
  ok(/mergeAt\(/.test(btn), '...and still calls the same mergeAt, so joining is fully available');
}

console.log('\nthe strips read it LIVE, not as a snapshot');
{
  /* initStrips runs once per doc open. A captured boolean would keep the old answer until the next
   * open, so a researcher push would appear to do nothing — the exact complaint that made the
   * panel's own settings pushes apply live (changeSettings → applyLiveSettings). */
  ok(/joinKeys: \(\) => joinKeysEnabled\(\)/.test(app), 'a function is passed, not a value');
  ok(/deps\.joinKeys && deps\.joinKeys\(\)/.test(strips), 'and the strips call it each time');
  // An older host that never passes joinKeys must behave as OFF, matching the setting's own default.
  ok(/!\(deps\.joinKeys && /.test(strips), 'an absent joinKeys means OFF, so the two cannot disagree');
}

console.log('\nit is a real setting: in both forms, in the sync snapshot, in both languages');
{
  ok(/\{ k: 'backspaceJoin', type: 'checkbox', note: 'panel\.f\.backspaceJoinNote' \}/.test(panel),
     'the researcher panel offers it');
  ok(/\{ k: 'backspaceJoin', type: 'checkbox', note: 'panel\.f\.backspaceJoinNote' \}/.test(app),
     "and so does the device's own Settings tab, so an unpaired user is not locked out");
  ok(/'segmentation', 'backspaceJoin', 'exportEaf'/.test(app),
     'it rides the settings snapshot the device reports, so the panel shows the truth');

  const block = (lang) => {
    const at = i18n.indexOf(`\n${lang}: {`);
    const rest = i18n.slice(at + 1);
    const nxt = rest.search(/\n[a-z]{2,3}: \{/);
    return nxt < 0 ? i18n.slice(at) : i18n.slice(at, at + 1 + nxt);
  };
  for (const k of ['panel.f.backspaceJoin', 'panel.f.backspaceJoinNote']) {
    const re = new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'm');
    ok(re.test(block('en')) && re.test(block('id')), `${k} is in en AND id`);
  }
  /* The note must say the buttons still work — otherwise "off" reads as "you can no longer join
   * lines", and a researcher would leave it on for a capability they were never losing. */
  const note = (i18n.match(/'panel\.f\.backspaceJoinNote': '([^']*)'/) || [])[1] || '';
  ok(/join button/i.test(note), 'the note says the join buttons still work');
  ok(/[Oo]ff by default/.test(note), '...and states the default, since it changes existing behaviour');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
