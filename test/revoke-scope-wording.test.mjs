/* THE TWO REVOKE CONTROLS MUST NAME THEIR SCOPE, AND AGREE WITH THEIR OWN DIALOGS (issue #17).
 *
 * WHY: a researcher could not tell "Revoke this install" from "Revoke device", and said so —
 * "both sound like they would unlink the device". He was right that the labels did not distinguish
 * them, and his own guess at the difference (one lets you reuse the invite link, the other deletes
 * from the account) was wrong, which is the clearest possible evidence the wording was not carrying
 * the model. The real difference is SCOPE: one app copy, versus the device and every copy of it.
 *
 * ⚠ THE SHARPER BUG UNDERNEATH: the button said "Revoke this install" while the confirm dialog it
 * opened began "Unlink this device?" — two verbs and two nouns for one act, inside one interaction.
 * Someone who understood the model perfectly would still have been confused by that. This test
 * exists mainly to keep those two strings speaking the same language, because they live ~2 lines
 * apart in i18n.js and are the easiest pair in the file to edit singly.
 *
 * Deliberately NOT asserting exact marketing copy — only the properties that carry the meaning:
 * the pair is distinguishable, each names its scope, and a control agrees with its own dialog.
 *
 * Run: node test/revoke-scope-wording.test.mjs
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const src = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');

/* Every value for a key, in document order: [en, id]. */
const valuesOf = (key) => [...src.matchAll(new RegExp(`'${key.replace('.', '\\.')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g'))]
  .map((m) => m[1]);

test('revoke labels distinguish one install from the whole device', () => {
  const langs = ['en', 'id'];
  const keys = ['panel.inst.revoke', 'panel.inst.revokeInstall',
                'panel.inst.confirmRevoke', 'panel.inst.confirmRevokeInstall'];

  console.log('\nall four strings exist in both languages');
  const V = {};
  for (const k of keys) {
    V[k] = valuesOf(k);
    ok(V[k].length === 2, `${k} present twice (en + id) — got ${V[k].length}`);
  }
  if (fail) { console.log(`\nFAILED (${fail})\n`); throw new Error(`${fail} check(s) failed`); }

  for (let i = 0; i < 2; i++) {
    const L = langs[i];
    const dev = V['panel.inst.revoke'][i];
    const ins = V['panel.inst.revokeInstall'][i];
    const devC = V['panel.inst.confirmRevoke'][i];
    const insC = V['panel.inst.confirmRevokeInstall'][i];

    console.log(`\n[${L}] the two labels are not interchangeable`);
    ok(dev !== ins, `they differ: “${dev}” vs “${ins}”`);
    /* ⚠ THE LABELS MUST NAME RE-HOME vs RETIRE, not scope. An earlier fix of #17 asserted the
     * device label mentions "all installs" — encoding a model that cannot occur, since claiming an
     * invite revokes every prior install (worker "single-live-device, §D.4"). The difference that
     * is real, and that a researcher has to see on the button, is whether the DEVICE SURVIVES. */
    /* ⚠ THE LABELS ARE SHORT ON PURPOSE NOW — they sit in a segmented control with icons, on the
     * device's one action row (Seth, 2026-09-01). So the meaning lives in the TOOLTIP and the
     * dialog, and that is where it is asserted. A label test would have passed while the tooltips
     * said nothing. */
    const insTip = valuesOf('panel.inst.revokeInstallTip')[i];
    const devTip = valuesOf('panel.inst.revokeTip')[i];
    ok(insTip && devTip, 'both halves carry a tooltip');
    const reHome = /somewhere else|tempat lain/i.test(insTip);
    ok(reHome, reHome
      ? `the Unlink tooltip says the device survives and moves`
      : `⚠ the Unlink tooltip does not say the device survives — “${insTip}”`);
    ok(/STAYS|TETAP/.test(devTip),
       `the Delete tooltip says the data survives: “${devTip}”`);
    /* Each dialog must point at the other control, so whichever one a researcher opens by mistake
     * tells them where the thing they actually wanted lives. */
    ok(/Unlink|Putuskan/.test(devC), 'the delete dialog points at Unlink as the alternative');
    /* ⚠ Matched against the LIVE button text, not a literal — the hazard button has been renamed
     * once already ("Wipe device" → "Erase Data and Reset Device"), and a dialog that points at a
     * button by a name it no longer has is worse than one that points nowhere. */
    ok(insC.includes(valuesOf('panel.wipe.btn')[i]),
       'the unlink dialog points at the hazard button BY ITS CURRENT NAME');

    console.log(`[${L}] each control agrees with the dialog it opens`);
    /* The button's leading verb must reappear in its own confirm. This is the exact mismatch that
     * shipped: button "Revoke this install", dialog "Unlink this device?". */
    const verb = (s) => (s.trim().split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z]/g, '');
    const iv = verb(ins);
    ok(iv.length > 2 && insC.toLowerCase().includes(iv),
       iv.length > 2 && insC.toLowerCase().includes(iv)
         ? `install button “${iv}…” and its dialog use the same verb`
         : `⚠ button starts “${iv}” but its dialog does not use that word — the v550 mismatch is back`);
    const dv = verb(dev);
    ok(dv.length > 2 && devC.toLowerCase().includes(dv),
       `device button “${dv}…” and its dialog use the same verb`);

    console.log(`[${L}] no hardware noun — an install is not necessarily a phone`);
    /* ⚠ Seth, 2026-09-01: "don't say phone, because it might not be a phone." An install is a
     * browser profile, an Android APK, a tablet or the Electron desktop build; naming one makes the
     * sentence wrong for the rest, and "device" is already taken by the identity these act on. */
    for (const [what, str] of [['device label', dev], ['install label', ins],
                               ['delete dialog', devC], ['unlink dialog', insC],
                               ['delete tooltip', valuesOf('panel.inst.revokeTip')[i]],
                               ['unlink tooltip', valuesOf('panel.inst.revokeInstallTip')[i]],
                               ['erase tooltip', valuesOf('panel.wipe.tip')[i]]]) {
      const bad = /\b(phone|handset|ponsel)\b/i.test(str);
      ok(!bad, bad ? `⚠ ${what} names hardware: “${str.slice(0, 60)}…”`
                   : `${what} names no hardware`);
    }

    console.log(`[${L}] Delete and Wipe are told apart by what happens to the DATA`);
    /* ⚠ THIS IS THE SAFETY-CRITICAL PAIR, not the one the issue was opened about (Seth, 2026-09-01:
     * "'Wipe Device' vs 'Delete this device' can also be confusing"). Picking Delete when you meant
     * Wipe leaves a device that is lost or out of trusted hands still holding the whole corpus, so
     * both labels must state the data's fate rather than name the act. In Indonesian the collision
     * was 'Hapus' vs 'Hapus Total', which is why the delete verb there is a different root. */
    const wipeBtn = valuesOf('panel.wipe.btn')[i];
    ok(wipeBtn && wipeBtn !== dev, `Wipe (“${wipeBtn}”) and Delete (“${dev}”) are not near-synonyms`);
    const wipeTip = valuesOf('panel.wipe.tip')[i];
    ok(/erase|reset|hapus|setel ulang/i.test(wipeBtn),
       `the hazard button names destruction on its face: “${wipeBtn}”`);
    ok(wipeTip && /irreversible|tidak dapat dibatalkan/i.test(wipeTip),
       `and its tooltip says it cannot be undone`);
    ok(devC.includes(valuesOf('panel.wipe.btn')[i]),
       'the Delete dialog points at the hazard button BY ITS CURRENT NAME');

    console.log(`[${L}] the install dialog still warns that local data stays`);
    /* Non-negotiable regardless of wording: unlinking strands texts and audio on the device. */
    ok(/STAY|TETAP/.test(insC), 'the "data stays on the device" warning survives the rewording');
  }

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) throw new Error(`${fail} check(s) failed`);
});
