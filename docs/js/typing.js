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

/* MARK — the one policy dial, and the two classes land on opposite sides of it.
 *
 * ⚠ ON THE ANALYSIS LANGUAGE, MARKING IS THE WHOLE POINT. Seth's own examples are the argument:
 * "fedahu" for *perahu*, "tudu" for *turun* — a Fayu speaker writing Indonesian by ear, and Fayu has
 * neither /p/ nor /r/ to hear them with. Those are real Indonesian words spelled wrong, the device
 * HAS an Indonesian dictionary, and a squiggle says exactly the useful thing: "that isn't a word in
 * this language" — Seth: "get them thinking about alternate ways it might be spelled correctly."
 * Nothing is rewritten, so the typist stays the author.
 *
 * ⚠ ON THE VERNACULAR THE SAME SWITCH PRODUCES ONLY NOISE, which is why it is off. In a Fayu field
 * "fedahu" is not a misspelling of anything — it is simply a Fayu word, and Fayu is in no dictionary
 * on earth. The checker would fall back to whatever <html lang> says and underline EVERY word, 100%
 * false positives, which teaches people to ignore squiggles in the one field where a squiggle could
 * still have meant something. Flip this to true if a vernacular ever gains a real dictionary. */
const MARK = { [VERN]: false, [ANAL]: true };

/* Can this platform mark without also replacing? Desktop yes; Android no — see the header. */
export function canMarkWithoutReplacing() { return !isAndroid(); }

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
function noRewrite(el) {
  el.setAttribute('autocomplete', 'off');
  el.setAttribute('autocapitalize', 'none');
  el.setAttribute('autocorrect', 'off');
  el.setAttribute('writingsuggestions', 'false');
  el.setAttribute('data-gramm', 'false');
  el.setAttribute('data-gramm_editor', 'false');
  el.setAttribute('data-enable-grammarly', 'false');
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
  noRewrite(el);
  const mark = MARK[kind] && canMarkWithoutReplacing();
  el.spellcheck = mark;
  if (mark && kind === ANAL) {
    const tag = analLangTag();
    if (tag) el.setAttribute('lang', tag);
  } else if (kind === VERN) {
    el.removeAttribute('lang');
  }
  el.dataset.typing = kind;
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
    for (const r of recs) {
      if (r.type === 'attributes') { sweep(r.target); continue; }
      for (const n of r.addedNodes) sweep(n);
    }
  });
  /* `spellcheck` is watched too: a stray el.spellcheck = true anywhere in the suite gets corrected
   * rather than quietly winning. */
  mo.observe(target, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['data-typing', 'spellcheck'],
  });
  return () => mo.disconnect();
}
