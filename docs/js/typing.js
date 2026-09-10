/* typing.js — WHAT THE KEYBOARD IS ALLOWED TO DO TO A FIELD, FOR EVERY APP IN THE SUITE.
 *
 * ⚠ AUTOCORRECT ON A MINORITY LANGUAGE IS DATA CORRUPTION. Seth, 2026-09-10: "When we're working
 * with minority languages, autocorrect will REALLY screw things up for us with non-tech-savvy users
 * working in a language the device doesn't know because there's no spelling dictionary for it. It'll
 * autocorrect words to English or MAYBE the LWC."
 *
 * Fayu has no dictionary on any device and never will, so on a vernacular field EVERY suggestion a
 * keyboard offers is wrong by construction. The rewrite is silent, it lands in a language the typist
 * may not read, and the wrong word is what gets archived.
 *
 * THREE SEPARATE THINGS, and conflating them is what makes this hard to reason about:
 *
 *   REPLACE  — the keyboard silently swaps the word as you type past it. Never wanted, anywhere in
 *              this suite. Seth: "That would almost certainly guess wrong 90% of the time, be way
 *              off, and go unnoticed by the native speaker."
 *   SUGGEST  — a strip of candidate words is offered; the typist chooses or ignores. Wanted on the
 *              analysis language, where a Fayu speaker writing Indonesian genuinely needs the help.
 *   MARK     — misspelled words get a red squiggle. Nothing is rewritten. Seth: "Just to remind the
 *              Fayu people that in Indonesian 'fedahu' isn't a word and get them thinking about
 *              alternate ways it might be spelled correctly."
 *
 * ⚠ THE WEB PLATFORM CANNOT SEPARATE THESE ON ANDROID, and that single fact decides the defaults
 * below. On a desktop browser `spellcheck` draws squiggles and does nothing else — there is no
 * autocorrect to speak of, so MARK is free of REPLACE. On Android `spellcheck` is the only lever we
 * have: false sets TYPE_TEXT_FLAG_NO_SUGGESTIONS on the input connection and Gboard goes quiet;
 * true hands the field back to Gboard, which marks AND suggests AND replaces as one bundle. There is
 * no attribute that says "mark but never replace."
 *
 * So MARK resolves per platform: squiggles where squiggles cost nothing, silence where asking for
 * them would drag REPLACE in with them. Android gets the honest answer rather than the nice one.
 *
 * ⚠ THE FULL ANSWER IS NATIVE, AND IT IS ALREADY REACHABLE. Android's EditorInfo carries
 * TYPE_TEXT_FLAG_AUTO_CORRECT and TYPE_TEXT_FLAG_NO_SUGGESTIONS as SEPARATE bits, so the Capacitor
 * shell can do exactly what the web cannot: leave the suggestion strip visible while forbidding the
 * automatic swap — "offering them choices, but not automatically correcting", precisely. That is
 * issue #62, and it is the only route to Seth's stated ideal on the devices that matter most. */

import { isAndroid } from './external-link.js';

/* Marked on the field itself so the sweep below can find it without knowing which app drew it.
 * `vern` is the language being documented; `anal` is the language it is being documented IN. */
export const VERN = 'vern';
export const ANAL = 'anal';
const KINDS = new Set([VERN, ANAL]);

/* ─── THE RESEARCHER'S THREE DIALS, EACH on / off / auto ─────────────────────
 *
 * Seth, 2026-09-10: "we need an 'on/off/auto' (where auto makes the best choice for the above
 * constraints based on the UA/platform) for spellcheck/autocorrect/autocomplete."
 *
 * ⚠ THEY GOVERN THE ANALYSIS LANGUAGE ONLY. The vernacular is not a setting and must never become
 * one — Seth, same day: "For baseline, we don't even want autocomplete suggestions even, we don't
 * want spellcheck, and we DEFINITELY don't want autocorrect ever." resolveTyping() returns the
 * all-off answer for VERN before it so much as looks at a preference.
 *
 * What `auto` decides, per dial, and why each differs:
 *
 *   spellcheck  → on where the platform can mark WITHOUT replacing, off where it cannot. The one
 *                 dial whose `auto` does real work today: desktop gets the squiggle that tells a
 *                 Fayu speaker "fedahu" is not an Indonesian word, Android stays silent.
 *   autocomplete→ on where the platform can offer choices without taking them. On desktop that is
 *                 the browser's own saved-values dropdown, which never rewrites anything — genuinely
 *                 "offering them choices, but not automatically correcting". Off on Android, where
 *                 the strip and the swap are one feature. Issue #62 is what makes this `auto` mean
 *                 yes on Android too.
 *   autocorrect → OFF, on every platform, always. There is no device on which silently rewriting a
 *                 gloss is the better default, so `auto` never enables it. `on` remains available
 *                 for a researcher whose analysis language the device knows well and who has read
 *                 what the tooltip says, which is the whole point of having the dial.
 */
export const AUTO = 'auto', ON = 'on', OFF = 'off';

let prefs = () => ({});

/** Host app supplies { correct, complete, spell }, each 'auto' | 'on' | 'off'. */
export function setTypingPrefs(fn) { prefs = typeof fn === 'function' ? fn : () => ({}); }

const tri = (v, whenAuto) => (v === ON ? true : v === OFF ? false : whenAuto);

/* ─── THE PLATFORM SEAM ───────────────────────────────────────────────────────
 *
 * ⚠ CALLERS STATE WHAT THEY WANT; THIS MODULE OWNS WHAT THE PLATFORM CAN GIVE. General design
 * principle, Seth, 2026-09-10: "make design decisions that are forward-compatible with that
 * direction — for
 * example modularized functions and libraries that handle a certain action or property and then take
 * that and translate it to the specific platform code and functionality while the main PWA code
 * can't tell the difference. This is so that in general we don't have to update the native shell
 * often."
 *
 * So the shell declares what it CAN DO, once, and every policy decision stays here in JS where it
 * ships with the engine. Rebuilding and reinstalling the APK on a field device is expensive and
 * slow — both bundled engines already sat ~500 releases stale (#61) — so nothing that we might want
 * to change our minds about belongs inside it.
 *
 * ⚠ THE SEAM IS FOR WHAT NATIVE DOES BETTER, NOT FOR PLATFORM DETECTION IN GENERAL — Seth, same
 * day: "a UA sniff for things that a browser can handle, I think is fine... But things that can do
 * better with native, there's where we want the capability seams." Hence the browser's own answer
 * below IS a UA test, and that is fine: it is the browser-level truth, and it lives in here rather
 * than at eleven call sites. What the seam adds is the native override.
 *
 * The web's answers are the default, and they are the pessimistic ones. A native shell that can do
 * better installs a truer set (see #62) and no caller changes: applyTyping still just asks.
 *
 * `dialsAreIndependent` is the question that actually distinguishes native from web: Android gives
 * a web page ONE lever for all three behaviours, and native gives it three. */
const WEB_CAPS = {
  get markWithoutReplacing() { return !isAndroid(); },
  get suggestWithoutReplacing() { return !isAndroid(); },
  get dialsAreIndependent() { return !isAndroid(); },
};
let caps = WEB_CAPS;

/** A native shell declares its real capabilities here. Omitted keys fall back to the web's answer. */
export function setTypingPlatform(p) {
  caps = p ? { ...WEB_CAPS, ...p } : WEB_CAPS;
}

/* Can this platform MARK misspellings without also permitting a silent replacement? On the web,
 * desktop yes — `spellcheck` draws squiggles and there is no autocorrect to speak of; Android no,
 * because `spellcheck` is the only lever and true hands Gboard mark AND suggest AND replace. */
export function canMarkWithoutReplacing() { return !!caps.markWithoutReplacing; }

/* Can it OFFER choices without taking them? Same answer on the web today, different reason — and
 * the two diverge the moment the native shell lands, which is why they are separate questions. */
export function canSuggestWithoutReplacing() { return !!caps.suggestWithoutReplacing; }

/** What the three dials come to for this field class, on this device, right now. */
export function resolveTyping(kind) {
  // ⚠ NOT NEGOTIABLE, AND DELIBERATELY BEFORE THE PREFERENCE LOOKUP.
  if (kind !== ANAL) return { correct: false, complete: false, spell: false };
  const p = prefs() || {};
  return {
    correct: tri(p.correct, false),
    complete: tri(p.complete, canSuggestWithoutReplacing()),
    spell: tri(p.spell, canMarkWithoutReplacing()),
  };
}

/* Attributes that suppress SUGGEST and REPLACE. Carried by every field this module touches, in both
 * classes: the analysis field gets its help from the spellchecker, never from the rewriter.
 *
 *   autocomplete="off"          — the browser's own saved-value dropdown. ⚠ NOT the keyboard's word
 *                                 suggestions, which is the thing people mean by "autocomplete" —
 *                                 that one rides on `spellcheck` on Android. Both are off here.
 *   autocapitalize="none"       — stops a capital being invented at the start of a line
 *   autocorrect="off"           — Safari/iOS, and now standardised; inert elsewhere, free to carry
 *   writingsuggestions="false"  — the 2024 attribute for browser-offered writing suggestions
 *   data-gramm* / data-enable-grammarly — Grammarly, which no attribute above reaches: it is an
 *                                 extension reading the DOM, not a browser feature. */
/* ⚠ WRITE ONLY WHAT IS NOT ALREADY THERE. Setting an attribute to the value it already has still
 * queues a mutation record — which, with an observer watching these same attributes, was an infinite
 * loop that pinned the main thread (v653 on staging: "this page is slowing down Firefox", and audio
 * and waveforms starved along with everything else). The observer no longer watches attributes at
 * all, and these guards mean applyTyping is genuinely free on the re-renders that call it per row. */
function setAttr(el, k, v) { if (el.getAttribute(k) !== v) el.setAttribute(k, v); }
function dropAttr(el, k) { if (el.hasAttribute(k)) el.removeAttribute(k); }

function grammarlyOff(el) {
  setAttr(el, 'data-gramm', 'false');
  setAttr(el, 'data-gramm_editor', 'false');
  setAttr(el, 'data-enable-grammarly', 'false');
}

/* The language a spellchecker should judge this field in. Honoured by desktop browsers, which pick a
 * dictionary from it. ⚠ On Android it does NOT choose Gboard's language — Gboard corrects in
 * whatever the user enabled in the keyboard's own settings, and no web attribute overrides that.
 * Vernacular fields deliberately carry no lang: there is no dictionary to point at, and naming a
 * wrong one is worse than naming none. */
let analLangTag = () => '';

/** The researcher's analysis-language choice, as a BCP-47 tag. Set once by the host app. */
export function setAnalysisLang(fn) { analLangTag = typeof fn === 'function' ? fn : () => ''; }

/** Apply this suite's typing policy to one field. Idempotent; safe to call on every render. */
export function applyTyping(el, kind) {
  if (!el || !KINDS.has(kind)) return el;
  const r = resolveTyping(kind);

  setAttr(el, 'autocapitalize', 'none');   // always: a capital is never ours to invent
  grammarlyOff(el);                        // always: it rewrites, and it is an extension

  setAttr(el, 'autocomplete', r.complete ? 'on' : 'off');
  setAttr(el, 'writingsuggestions', r.complete ? 'true' : 'false');
  if (r.correct) dropAttr(el, 'autocorrect');
  else setAttr(el, 'autocorrect', 'off');

  /* ⚠ WHERE THE DIALS ARE NOT INDEPENDENT, `spellcheck` IS THE ONLY LEVER, so anything the
   * researcher asked for needs it raised — and raising it hands the keyboard all three at once.
   * That is the platform's doing, not ours; each dial's tooltip says so in plain language before
   * anyone turns one on, because a setting that silently does nothing is worse. Where the platform
   * does separate them, every dial gets exactly what it asked for and nothing more. */
  const spell = caps.dialsAreIndependent ? r.spell : (r.spell || r.complete || r.correct);
  if (el.spellcheck !== spell) el.spellcheck = spell;

  // A dictionary is worth naming only when something will actually consult one.
  const tag = spell && kind === ANAL ? analLangTag() : '';
  if (tag) setAttr(el, 'lang', tag);
  else dropAttr(el, 'lang');

  if (el.dataset.typing !== kind) el.dataset.typing = kind;
  return el;
}

/* ⚠ THE SWEEP EXISTS BECAUSE ONE MISSED FIELD IS A CORRUPTED TEXT. Fields are drawn by six apps and
 * a dozen render paths, several of which rebuild rows as the user scrolls; a policy applied only at
 * the call sites is one new `createElement` away from a hole. So the same shape that closed the
 * offsite-link hole closes this one: sweep what is here, observe what arrives.
 *
 * ⚠ AND IT MUST RUN BEFORE FIRST FOCUS, not after — the IME reads a field's attributes when it
 * attaches to it, so a field hardened after the keyboard is already up has offered a round of
 * suggestions before we said a word. That is why marked-up fields carry the attributes in the HTML
 * too, and why this observes rather than polls. */
export function enforceTyping(root = document) {
  const sweep = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (node.dataset && KINDS.has(node.dataset.typing)) applyTyping(node, node.dataset.typing);
    if (!node.querySelectorAll) return;
    for (const el of node.querySelectorAll('[data-typing]')) {
      if (KINDS.has(el.dataset.typing)) applyTyping(el, el.dataset.typing);
    }
  };
  sweep(root.documentElement || root);
  const target = root.body || root.documentElement || root;
  if (!target || typeof MutationObserver !== 'function') return () => {};
  const mo = new MutationObserver((recs) => {
    for (const r of recs) for (const n of r.addedNodes) sweep(n);
  });
  /* ⚠ childList ONLY — NEVER attributes. Watching `data-typing` and `spellcheck` here meant every
   * applyTyping() write woke the observer, which called applyTyping() again: an infinite loop that
   * saturated the main thread. It shipped to staging as v653 and made every app crawl.
   *
   * The thing it was guarding — a stray `el.spellcheck = true` somewhere else in the suite — was
   * never asked for, and is already covered by the test that no module outside this one touches
   * typing attributes. Not worth re-earning at this price. */
  mo.observe(target, { childList: true, subtree: true });
  return () => mo.disconnect();
}
