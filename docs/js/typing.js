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

/* ⚠ UNSET MEANS OFF. Only the literal 'auto' gets the automatic answer; absent, 'off', or anything
 * unrecognised is off. Seth, 2026-09-10, on what this release is actually for:
 *
 *   "The main thing we need for this release is all off by default, because it's not so much that we
 *    definitely want spell-checking as we don't want it when we don't want it."
 *
 *   "We don't want it autocorrecting and tripping up vernacular or really bad Indonesian when a
 *    native speaker is a very slow reader, not-tech-savvy, spelling may be way off, and autocorrect
 *    will make it worse and not better, and especially auto-correcting or auto-completing
 *    vernacular."
 *
 * That is the whole design in two sentences. The value of these dials is not the help they can give;
 * it is that nothing helps uninvited. A person who reads slowly and spells uncertainly cannot audit
 * a silent rewrite, so the default has to be silence and every exception has to be chosen by
 * someone who understands what they are choosing. */
const tri = (v, whenAuto) => (v === ON ? true : v === AUTO ? whenAuto : false);

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

/* ⚠ `auto` MARKS ONLY WHEN THE BROWSER LISTS THE ANALYSIS LANGUAGE — and the history of this one
 * line is worth keeping, because it was got wrong twice in both directions.
 *
 * The rule: a browser ships or fetches dictionaries for the languages the user has configured, and
 * `navigator.languages` reports them. If the analysis language is not among them, marking would be
 * done against some other language — every word of an Indonesian gloss underlined against English,
 * silently, looking like a working feature. That is the same 100%-false-positive noise MARK is
 * switched off for on the vernacular.
 *
 * ⚠ IT DOES WORK. Verified by Seth in Firefox, 2026-09-10: a fresh gloss box with lang="id" is
 * spell-checked in Indonesian. An earlier field of his showed ENGLISH and briefly looked like proof
 * that browsers ignore `lang` — they do not. That field had a REMEMBERED per-field dictionary
 * override from a manual context-menu choice, and Firefox keeps those. A stale override on one
 * field is not a platform limit, and treating it as one nearly threw the feature away.
 *
 * ⚠ AND THE FIELD DEVICES SATISFY IT BY CONSTRUCTION. Seth: "we researchers can [...] configure
 * devices we give to mother-tongue speakers to use their LWC by default in the OS and browser
 * interface. Android devices WILL be configured this way." A tablet set up in Indonesian lists
 * Indonesian, so marking is on and correct there — while a researcher's English Windows machine
 * ("Windows devices not so much") lists no Indonesian and stays quiet.
 *
 * Still a proxy: a language can be accepted without its dictionary being installed. It fails toward
 * silence, and `on` overrides it for a researcher who has set their dictionary themselves.
 *
 * ⚠ AND THE SAME PROXY IS GENUINELY STRONGER IN CHROMIUM THAN IN FIREFOX — Chrome downloads a
 * dictionary automatically when a language is enabled in its settings, whereas Firefox needs a
 * dictionary add-on installed by hand per language. So `navigator.languages` containing `id` almost
 * certainly means Chrome can check Indonesian, and only might mean Firefox can.
 *
 * ⚠ NO PER-BROWSER ALLOW-LIST, AND THIS WAS CONSIDERED TWICE. Chromium fetches a dictionary when a
 * language is enabled in its settings; Firefox needs a per-language add-on installed by hand; Safari
 * is not Chromium at all and uses the macOS system spellchecker; Edge is Chromium but layers
 * Microsoft Editor and Windows language packs on top. Four mechanisms, none of them reportable to a
 * web page.
 *
 * So an engine list would be a guess with a UA string holding it up — brittle against version
 * changes, against Brave and Vivaldi presenting as Chrome, and against every engine's own settings
 * changing under it. And it buys almost nothing now that the dials are OFF by default: `auto` is
 * only ever reached by a researcher who chose it and read the dialog explaining exactly this
 * dependency. The warning carries the caveat; the code stays one rule for every browser. */
function browserListsLanguage(tag) {
  if (!tag) return false;
  const base = String(tag).toLowerCase().split('-')[0];
  const langs = (typeof navigator !== 'undefined'
    && (navigator.languages || (navigator.language ? [navigator.language] : []))) || [];
  return langs.some((l) => String(l).toLowerCase().split('-')[0] === base);
}

/** What the three dials come to for this field class, on this device, right now. */
export function resolveTyping(kind) {
  // ⚠ NOT NEGOTIABLE, AND DELIBERATELY BEFORE THE PREFERENCE LOOKUP.
  if (kind !== ANAL) return { correct: false, complete: false, spell: false };
  const p = prefs() || {};
  return {
    correct: tri(p.correct, false),
    complete: tri(p.complete, canSuggestWithoutReplacing()),
    spell: tri(p.spell, canMarkWithoutReplacing() && browserListsLanguage(analLangTag())),
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

/* ─── ENFORCEMENT: STATIC FIRST, THEN ONE FIELD AT A TIME ─────────────────────
 *
 * Seth, 2026-09-10, after v653–v655 each cost real performance: "Seems like though it shouldn't be
 * necessary for us to be live-monitoring and changing fields as we go. Seems like we should be able
 * to make that almost static to the browser." He is right, and there are two facts that make it so.
 *
 * ⚠ FACT ONE: THESE ATTRIBUTES INHERIT. `spellcheck`, `autocorrect`, `autocapitalize` and
 * `writingsuggestions` are inherited from any ancestor that sets them — verified in-browser, three
 * levels deep, on both <input> and contenteditable. So each app's <body> carries the safe vernacular
 * policy in its MARKUP, and every field in every app is born with it: no script, no observer, no
 * per-field writes, and it is in force from parse time — before any script runs and before any IME
 * can attach. That is as static as the platform allows, and it is the whole vernacular guarantee.
 *
 * ⚠ FACT TWO: ONLY THE FOCUSED FIELD CAN BE REWRITTEN. A keyboard rewrites what is being typed in.
 * So the researcher's analysis-language policy is applied to ONE field, when it is touched, instead
 * of to every field on every render. Empty gloss boxes nobody has touched have nothing to correct
 * and nothing to underline, so this loses exactly nothing.
 *
 * What that replaces, and why each had to go:
 *   - a MutationObserver on attributes — an infinite loop, because applyTyping wrote the attributes
 *     it was watching (v653: "this page is slowing down Firefox")
 *   - a synchronous childList sweep — a querySelectorAll inside every insertion, ~12ms a time on an
 *     M3 (v654)
 *   - a rAF-deferred sweep — rAF does not run in a hidden tab, so the queue grew while the tab was
 *     backgrounded and burst on return, freezing the UI on tab switch (v655)
 *   - applyTyping at every call site — 88ms per 602 fields on an M3, and these apps run on Android
 *     tablets several times slower
 * ⚠ AND SETTING spellcheck=true ON HUNDREDS OF FIELDS IS ITSELF THE COST, not just the writes:
 * Firefox spellchecks eagerly where Chrome is lazy, which is why this was far worse in Firefox. At
 * most ONE field is ever spellchecked now.
 *
 * pointerdown fires BEFORE focus — that is the touch path, which is the Android path. focusin
 * catches Tab and programmatic focus (the gloss "move to next" walk). Both are capture-phase and
 * delegated once, so no per-field listeners either. */

const SEL_ANAL = '.free-input, .gloss-input, .mg-g, .mg-ft';
const SEL_VERN = '#baseline-text, .word-txt, .seg-text, .mg-w, .pa-pastebox, #consent-name';
const SEL_ANY = `${SEL_ANAL}, ${SEL_VERN}, [data-typing]`;

/** Which language a field is in, from what the DOM already carries. No writes, no bookkeeping. */
export function kindOf(el) {
  if (!el || el.nodeType !== 1 || typeof el.matches !== 'function') return null;
  const explicit = el.dataset && el.dataset.typing;
  if (KINDS.has(explicit)) return explicit;
  if (el.matches(SEL_ANAL)) return ANAL;
  if (el.matches(SEL_VERN)) return VERN;
  return null;
}

/* The resolved policy, as a short string. Stamped on the element as a JS PROPERTY — not an
 * attribute, so it is not a DOM mutation, costs no reflow, and cannot be observed into a loop.
 * Re-touching a settled field is one string compare; a settings push changes the signature, so the
 * next touch re-applies without any invalidation plumbing. */
function policySig(kind) {
  const r = resolveTyping(kind);
  const tag = r.spell && kind === ANAL ? analLangTag() : '';
  return `${kind}|${+r.spell}${+r.complete}${+r.correct}|${tag}`;
}

export function enforceTyping(root = document) {
  const doc = root.ownerDocument || root;
  if (!doc || typeof doc.addEventListener !== 'function') return () => {};

  const touch = (node) => {
    const el = node && typeof node.closest === 'function' ? node.closest(SEL_ANY) : null;
    if (!el) return;
    const kind = kindOf(el);
    if (!kind) return;
    const sig = policySig(kind);
    if (el.__typing === sig) return;
    applyTyping(el, kind);
    el.__typing = sig;
  };
  const on = (e) => touch(e.target);

  doc.addEventListener('pointerdown', on, true);
  doc.addEventListener('focusin', on, true);
  return () => {
    doc.removeEventListener('pointerdown', on, true);
    doc.removeEventListener('focusin', on, true);
  };
}

/* ─── THE ANDROID COUPLING, MADE VISIBLE ──────────────────────────────────────
 *
 * Seth, 2026-09-10: "If our three spelling related settings really ride as one for Android, make
 * sure that if one of them is 'on', then the other two have a small exclamation point icon tip
 * warning the researcher that this cannot be turned off on Android if one of the other two settings
 * is on."
 *
 * ⚠ NOT CONDITIONAL ON THE CURRENT DEVICE, deliberately. A researcher configures a tablet from a
 * laptop, so asking canMarkWithoutReplacing() here would hide the warning in exactly the place it
 * is needed — the panel, on a desktop, setting up an Android device. The warning states which
 * platform it is about, and shows wherever these dials are edited.
 *
 * Lives here rather than in either renderer because the fact it encodes is this module's: on Android
 * `spellcheck` is the only lever, so raising it for one dial raises it for all three. Both settings
 * surfaces import this, so the rule cannot drift between them. */
export const TYPING_DIALS = ['analSpellcheck', 'analAutocomplete', 'analAutocorrect'];

/** Show the ⚠ on every dial that is not itself 'on', whenever any of them is. */
export function syncTypingWarnings(box, attr) {
  if (!box || typeof box.querySelector !== 'function') return;
  const val = (k) => {
    const el = box.querySelector(`[${attr}="${k}"]`);
    return el ? el.value : null;
  };
  const vals = TYPING_DIALS.map(val);
  const anyOn = vals.some((v) => v === ON);
  TYPING_DIALS.forEach((k, i) => {
    const dot = box.querySelector(`[data-infofor="warn-${k}"]`);
    if (!dot) return;
    const show = anyOn && vals[i] !== ON && vals[i] !== null;
    dot.hidden = !show;
    /* ⚠ THE FIELD GLOWS TOO, and the same yellow appears on the warning dialog. Seth, 2026-09-10:
     * "highlight orange or subtle yellow glow to the fields that are affected on Android by choosing
     * one of them" — and the dialog carries it as well so nobody has to wonder "why are those fields
     * yellow". Icon, field and dialog share one colour on purpose. */
    const field = typeof dot.closest === 'function' ? dot.closest('.rp-field') : null;
    if (field && field.classList) field.classList.toggle('typing-bundled', show);
    if (!show) {
      const note = box.querySelector(`[data-infonote="warn-${k}"]`);
      if (note) note.hidden = true;
      dot.setAttribute('aria-expanded', 'false');
    }
  });
}

/* ⚠ ONE SPACE BETWEEN WORDS (Seth, 2026-09-10): "prevent them from typing multiple spaces in the
 * baseline or free translation. Only allow one space between words." The audience is the reason —
 * "to help less tech-savvy/illiterate users": a run of spaces is invisible on screen, never
 * intended, and a typist who cannot read back what they typed has no way to notice it.
 *
 * ⚠⚠ NEWLINES ARE NEVER TOUCHED, and that is not a detail. The legacy baseline box carries a
 * transcription's PARAGRAPHS as newlines (getBaselineParagraphs(doc).join('\n')), and for a
 * time-aligned doc a BLANK line is a real timed span of silence, 1:1 with doc.segments — filtering
 * those once truncated a field recording by half a minute (see applyBaseline). So these collapse
 * runs of SPACES and TABS only, and tidySpaces splits and rejoins on '\n' so the line COUNT is
 * preserved exactly. A \s-based regex here would silently merge paragraphs.
 *
 * Both are pure so the caret arithmetic can be tested without a DOM — the same reason #43's
 * geometry was pulled out of its closure. */

// While typing: collapse runs, and move the caret back by however many characters were removed
// BEFORE it, because rewriting .value otherwise throws the cursor to the end of the field.
export function collapseSpaces(value, caret = null) {
  const src = value == null ? '' : String(value);
  const out = src.replace(/[ \t]{2,}/g, ' ');
  if (out === src || caret == null) return { value: out, caret, changed: out !== src };
  // The head is collapsed by the same rule, so its new length IS the new caret position.
  const head = src.slice(0, caret).replace(/[ \t]{2,}/g, ' ');
  return { value: out, caret: head.length, changed: true };
}

// On the way out: collapse runs AND drop leading/trailing spaces on each line. A leading space is
// not "between words" at all, so trimming is the same rule applied at the edges; per-line rather
// than a whole-value trim so a multi-paragraph baseline is tidied line by line. applyBaseline
// already trims each line before reconciling, so this changes what the typist SEES to match what
// the document was always going to store.
export function tidySpaces(value) {
  return (value == null ? '' : String(value))
    .split('\n')
    .map((l) => l.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/g, ''))
    .join('\n');
}

/* ⚠⚠ CAP CONSECUTIVE BLANK LINES — AND ONLY EVER ON A DOC THAT CARRIES NO TIME ALIGNMENT.
 *
 * Seth, 2026-09-10: "for legacy baseline, multiple line breaks is OK (at least two), but not
 * multiple spaces… Maybe limit line breaks to max 2 in a row between text lines if this behavior is
 * enabled." Right for a classic transcription, where a blank line is a paragraph separator and
 * applyBaseline discards empties at reconcile anyway, so capping is cosmetic.
 *
 * ⚠ IT IS DATA LOSS ON AN ALIGNED DOC. There, every blank baseline line is a real timed span of
 * SILENCE, 1:1 with doc.segments. Dropping them is a corruption already suffered and fixed once
 * (2026-08-16): 53 lines with 23 blanks became 30, the spans then paired positionally against the
 * first 30 — silences included — and the recording "ended" half a minute early. It was reproduced
 * from Seth's own field file. So the CALLER must gate this on doc truth, never on a setting, and
 * this function is deliberately not applied anywhere the alignment is unknown.
 *
 * `max` counts NEWLINES in a row, so the default 2 leaves at most one blank line between two lines
 * of text — "at least two" line breaks, as asked. */
export function capBlankLines(value, max = 2) {
  const src = value == null ? '' : String(value);
  if (max < 1) return src;
  return src.replace(new RegExp(`\\n{${max + 1},}`, 'g'), '\n'.repeat(max));
}
