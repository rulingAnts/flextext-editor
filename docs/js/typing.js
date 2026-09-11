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

/* ─────────────────────────────────────────────────────────────────────────────
 * WHAT A WRITING-SYSTEM CODE SAYS ABOUT ITS LANGUAGE (issue #68)
 *
 * A FLEx writing-system code IS a BCP-47 tag: language[-extlang][-script][-region][-variant…]
 * [-extension…][-x-private…]. Seth's own exported texts carry `fau`, `id`, `en` and
 * `fau-fonipa-x-etic` (read 2026-09-11). So the language is always recoverable from the code, and
 * one parse serves both things that need it: the name shown under a code box, and the tag a
 * spellchecker is given.
 *
 * ⚠ THE NAME IS A CHECK, NEVER A FILL. Seth, 2026-09-11: "We don't want to make it easy for the user
 * to skip noticing and checking their writing system code. By offering something that looks
 * automatic but actually isn't." So the code stays typed by hand, nothing is suggested or filled in
 * from the name, and a name appears only for a code FLEx could have written exactly as typed:
 *   - well-formed BCP-47                         `iau_tmu` is not, so it gets no name
 *   - in the case FLEx writes: language, variants and extensions lower, script Title, region UPPER.
 *     `FAU` gets no name, because FLEx matches codes case-sensitively and `fau` is a different code.
 *   - no extended-language form                  `zh-yue`: FLEx writes `yue`
 * Private-use subtags keep whatever case they have: real FLEx data carries `ert-x-MTT`.
 * ───────────────────────────────────────────────────────────────────────────── */
const WS_TAG = /^([a-z]{2,3})((?:-[a-z]{3}){0,3})(-[a-z]{4})?(-(?:[a-z]{2}|\d{3}))?((?:-(?:[a-z\d]{5,8}|\d[a-z\d]{3}))*)((?:-[a-wyz\d](?:-[a-z\d]{2,8})+)*)(-x(?:-[a-z\d]{1,8})+)?$/i;
const isLower = (s) => s === s.toLowerCase();
const subtagsOf = (group) => (group ? group.slice(1).split('-') : []);

/** A writing-system code split into its BCP-47 subtags, or null when it is not a well-formed tag. */
export function parseWsCode(code) {
  const m = WS_TAG.exec(String(code == null ? '' : code).trim());
  if (!m) return null;
  const script = m[3] ? m[3].slice(1) : '';
  const region = m[4] ? m[4].slice(1) : '';
  const tag = {
    language: m[1], extlang: subtagsOf(m[2]), script, region,
    variants: subtagsOf(m[5]), extensions: subtagsOf(m[6]),
    privateUse: m[7] ? m[7].slice(3).split('-') : [],
  };
  tag.canonicalCase = isLower(tag.language) && tag.extlang.every(isLower)
    && (!script || script === script[0].toUpperCase() + script.slice(1).toLowerCase())
    && region === region.toUpperCase()
    && tag.variants.every(isLower) && tag.extensions.every(isLower);
  return tag;
}

/** The language a writing-system code names, or '' (see the rules above). `names` is the table
 *  loadLanguageNames() resolves to. */
export function languageNameIn(names, code) {
  const tag = parseWsCode(code);
  if (!tag || !tag.canonicalCase || tag.extlang.length || !names || typeof names !== 'object') return '';
  return Object.prototype.hasOwnProperty.call(names, tag.language) ? String(names[tag.language]) : '';
}

/* The tag a spellchecker is given for the analysis writing system, or '' for none.
 *
 * ⚠ ONLY THE STANDARD SPELLING OF A REAL LANGUAGE. A variant subtag says the text is written some
 * other way (`id-fonipa` is Indonesian in IPA, and an Indonesian dictionary would flag every word),
 * a private-use subtag means something only the project knows (`fau-x-etic`), and `qaa`–`qtz` is the
 * range for languages with no code at all. Each of those gets no tag, which leaves `auto` declining
 * to mark (v659) rather than marking against the wrong dictionary. Script and region are kept:
 * `sr-Latn` and `en-GB` really are different dictionaries. The same parse and case rule as the name,
 * so a code that shows no name is never quietly spell-checked either. */
export function spellcheckTagFor(code) {
  const tag = parseWsCode(code);
  if (!tag || !tag.canonicalCase || tag.extlang.length || tag.variants.length
    || tag.extensions.length || tag.privateUse.length || /^q[a-t][a-z]$/.test(tag.language)) return '';
  const plain = [tag.language, tag.script, tag.region].filter(Boolean).join('-');
  try { return Intl.getCanonicalLocales(plain)[0] || plain; } catch { return plain; }
}

/* The name table (~177 KB, ~62 KB gzipped; built from SIL's langtags.json by
 * tools/build-langtags-names.mjs) is fetched only when a settings form shows a code box: never at
 * startup, and deliberately in NO service worker's precache. It is a check beside a field, not
 * something any app needs in order to work, so field devices do not download it on every update.
 * Each worker caches it the first time it is fetched; a form opened offline before then simply
 * shows no name, which sends the reader to FLEx — the right place to look anyway. */
let namesLoad = null;
export function loadLanguageNames() {
  if (!namesLoad) {
    namesLoad = import('./vendor/langtags-names.js')
      .then((m) => (m && m.default && typeof m.default === 'object' ? m.default : null))
      .catch(() => { namesLoad = null; return null; });   // offline and never cached: try again next time
  }
  return namesLoad;
}

/** The settings fields that hold a writing-system code, and so get a language name under their box.
 *  Both settings renderers draw the line from this list, and syncLanguageNames paints from it. */
export const WS_CODE_FIELDS = ['vernLang', 'analLang'];

/** Paint the language name under each code box in `root`: the `[data-langname="<field>"]` line names
 *  the language of the input whose `attr` is <field>, and `label(name)` words it in the UI language.
 *  Writes ONLY that line, never the code box; hidden whenever there is no name.
 *  ⚠ One lookup per known field, never a sweep of the form: see "no live monitoring" in
 *  test/no-autocorrect-vernacular.test.mjs for what sweeps in this module have cost. */
export function syncLanguageNames(root, attr, label) {
  if (!root || typeof root.querySelector !== 'function') return Promise.resolve();
  const pairs = WS_CODE_FIELDS
    .map((k) => [root.querySelector(`[data-langname="${k}"]`), root.querySelector(`[${attr}="${k}"]`)])
    .filter(([line]) => line);
  if (!pairs.length) return Promise.resolve();
  return loadLanguageNames().then((names) => {
    let showing = 0;
    for (const [line, input] of pairs) {
      const name = input ? languageNameIn(names, input.value) : '';
      const text = name ? (typeof label === 'function' ? label(name) : name) : '';
      if (line.textContent !== text) line.textContent = text;
      line.hidden = !text;
      if (text) showing++;
    }
    /* ⚠ A NAME NEVER STANDS ALONE. Seth, 2026-09-11: "if people see something come up, they'll
     * assume it matches and is good to go." So the guess warning under the code boxes shows the
     * moment any name does, and goes with the last one. */
    const warning = root.querySelector('[data-langwarn]');
    if (warning) warning.hidden = !showing;
  });
}

/** Keep the names live while someone types: one delegated listener, on a form built per render. */
export function wireLanguageNames(root, attr, label) {
  if (!root || typeof root.addEventListener !== 'function') return;
  root.addEventListener('input', (e) => {
    const k = e.target && typeof e.target.getAttribute === 'function' ? e.target.getAttribute(attr) : null;
    if (WS_CODE_FIELDS.includes(k)) syncLanguageNames(root, attr, label);
  });
}

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

/* ============================================================================================
 * TIDY: what a typist's field is allowed to contain.
 *
 * ⚠ ONE TABLE, because these rules arrived one at a time and were starting to hide each other.
 * Seth, 2026-09-10: "There might be a way to simplify and combine some of these rules..." Right —
 * there are only ever TWO KINDS OF FIELD and TWO MOMENTS, and every rule is a cell in that grid:
 *
 *                  while typing (input)                    on the way out (blur)
 *   vern      undo the keyboard's period,          collapse runs, trim each line's edges,
 *   (baseline  collapse space runs,                 settle periods (2 -> 1, 3+ -> ...)
 *    text)     collapse , ; : ! ? runs
 *             — periods LEFT ALONE
 *
 *   free      the same, PLUS punctuation           the same, plus that
 *   (transl.)  pulled tight against the word
 *
 *   gloss     only Leipzig-approved punctuation,   the same, plus strip trailing punctuation
 *             runs of the same char -> one
 *
 * ⚠ vern AND free ARE SEPARATE ROWS ON PURPOSE. They are the same kind of box and NOT the same kind
 * of content: the baseline is vernacular, and vernacular is never corrected. Only the free
 * translation, being prose in the analysis language, gets typographic tidying.
 *
 * Everything below is either a primitive (pure, one job, testable alone) or the table. The reason
 * a rule sits in one column and not the other is written at the primitive, because in every case
 * so far putting it in the wrong column made something UNTYPEABLE.
 *
 * WHY THIS IS ALL GATED. Seth: "to help less tech-savvy/illiterate users (though the researcher
 * should be able to disable this)". A run of spaces or a doubled comma is invisible on screen and
 * never intended — but only the caller knows whether the researcher asked for the help, and its
 * default depends on whether the device is paired. See singleSpaceEnabled in app.js.
 *
 * WHAT IS NEVER TOUCHED, ANYWHERE. flextext.js: WORD_CHAR = /[\p{L}\p{M}\p{N}'’ʼ‘\-_=ʔ]/u. The
 * apostrophe family and ʔ write a GLOTTAL STOP; - _ = mark MORPHEME AND CLITIC BOUNDARIES. A
 * doubled or trailing one may be exactly what a language or a glossing convention wants, and we do
 * not know every orthography — rewriting them would be the silent vernacular edit this whole area
 * exists to refuse. The one exception is a character the RESEARCHER has declared to be the gloss
 * separator: two of those in a row is an accident by definition. That is why `sep` is passed in
 * per call and never assumed.
 * ============================================================================================ */

const RUN_SAFE = ',;:!?';   // never legitimately repeated, and never word-internal

/* ⚠ NEWLINES ARE NEVER TOUCHED BY ANY OF THIS. The legacy baseline box carries a transcription's
 * PARAGRAPHS as newlines, and on a time-aligned doc a BLANK line is a real timed span of silence,
 * 1:1 with doc.segments — filtering those once truncated a field recording by half a minute (see
 * applyBaseline). So every regex here is [ \t] or a single punctuation class, and the blur pass
 * splits and rejoins on '\n' so the LINE COUNT is preserved exactly. */
const collapseSpaceRuns = (v) => v.replace(/[ \t]{2,}/g, ' ');
const trimLineEdges = (v) => v.split('\n').map((l) => l.replace(/^[ \t]+|[ \t]+$/g, '')).join('\n');
/* ⚠ NO SPACE BETWEEN A WORD AND ITS PUNCTUATION (Seth, 2026-09-10): "We also don't want a space
 * between a word and a period or comma." A full-line box is prose, and "the man ." is a typing slip
 * in every language this app's analysis languages are drawn from — English and Indonesian both set
 * punctuation tight against the word.
 *
 * ⚠ FRENCH IS THE KNOWN EXCEPTION and is not currently a concern: French typography puts a thin
 * space before ; : ! and ?. If an analysis language ever needs that, this is the rule to make
 * conditional — which is why it names its characters here rather than hiding behind \p{P}.
 *
 * Runs before the space collapse would also work, but after is cheaper and identical: any run of
 * spaces has already become one by the time this sees it. */
const tightenPunct = (v) => v.replace(/[ \t]+([.,;:!?])/g, '$1');

const collapseRuns = (chars) => (v) => {
  let out = v;
  for (const ch of chars) out = out.replace(new RegExp(`\\${ch}{2,}`, 'g'), ch);
  return out;
};

/* ⚠ PERIODS CANNOT BE SETTLED WHILE TYPING, or an ellipsis becomes untypeable. Walk it: the typist
 * wants "Yes..." — the second period makes a run of two, a 2->1 rule fires and EATS it, the third
 * makes two again, eaten again, and they never get past one dot however many times they press the
 * key. So a full-line box leaves periods alone until blur, where the whole run is finally visible:
 * two was a slip, three or more was meant. A GLOSS has no ellipsis to protect — a period there
 * separates parts of one label (1SG.SUBJ) — so it settles on every keystroke. */
const settlePeriods = (v) => v.replace(/\.{2,}/g, (m) => (m.length === 2 ? '.' : '...'));

/* ⚠ A GLOSS ADMITS ONLY LEIPZIG-APPROVED PUNCTUATION. Seth, 2026-09-10, after a screenshot of a
 * gloss reading "mau,.bilang" — "two different punctuation marks in a row" — and then the general
 * rule: "when , and . go together . (or word-breaking character the researcher put) should win. I
 * think in glosses, we only want leipzig-approved punctuation allowed in gloss boxes."
 *
 * That is a better rule than "no two in a row", and simpler: a comma has no job in a gloss at all,
 * so the question is not what to do when it sits next to a separator but what it is doing there in
 * the first place. Anything outside the approved set BECOMES THE SEPARATOR — not deleted, because
 * the typist who wrote "mau,bilang" wanted a break between two glosses, and deleting would fuse
 * them into "maubilang". Seth's pair then falls out for free: the comma becomes a period, the
 * period beside it makes a run, and the run reduces to one. The separator wins because it is the
 * only thing left.
 *
 * THE APPROVED SET, with the rule each character comes from (Leipzig Glossing Rules):
 *     -   Rule 2    affix boundary                    =   Rule 2    clitic boundary
 *     .   Rule 4A   one form, several gloss parts     :   Rule 4B   same, boundary not segmentable
 *     \   Rule 4C   morphophonological change         >   Rule 4D   person hierarchy (1>3)
 *     <>  Rule 9    infix                             ~   Rule 10   reduplication
 *     []            covert or inherent category       Ø             zero morpheme
 * plus two in wide use outside the rules: _ for a multi-word gloss (and one of our separator
 * options) and + for a compound. Letters, digits and combining marks are always fine, as are the
 * apostrophe family and ʔ — those write a GLOTTAL STOP and are word characters in flextext.js.
 *
 * ⚠⚠ AND A PAIR OF TWO APPROVED CHARACTERS IS NEVER REDUCED. "PST-.SUBJ" keeps both: the hyphen is
 * the morpheme's category and the period separates gloss parts, so they are two marks doing two
 * jobs, not a slip. Only a run of the SAME character reduces, and even then not `-` or `=` unless
 * the researcher declared it the separator — a doubled hyphen may be exactly what a convention
 * wants. This is the same line Seth endorsed for the trailing strip: leave the Leipzig characters
 * open, because eating one deletes analysis invisibly.
 *
 * ⚠⚠⚠ NONE OF THIS APPLIES TO A FULL-LINE BOX, where the text is ordinary prose in the analysis
 * language: "apples, oranges, etc., and pears" is a period against a comma and is CORRECT, and
 * "?!" is deliberate. Commas there are not accidents. */
const GLOSS_ALLOWED = /[\p{L}\p{M}\p{N}'’ʼ‘ʔØ\-=.:\\><~\[\]_+]/u;
const glossAllowedOnly = (sep) => (v) => {
  const to = sep || '.';
  let out = '';
  for (const ch of v) out += GLOSS_ALLOWED.test(ch) ? ch : to;
  return out;
};
// Runs of the SAME character. `-` and `=` only when declared the separator (see above).
const glossRuns = (sep) => collapseRuns('.:_' + (sep && !'.:_'.includes(sep) ? sep : ''));

/* ⚠ A GLOSS DOES NOT END IN PUNCTUATION (Seth) — the everyday case being a trailing separator:
 * typing "PST " leaves "PST." with nothing after it.
 *
 * ⚠⚠ BUT NOT THE HYPHEN OR EQUALS SIGN, and that is linguistics, not caution. Leipzig glossing
 * marks affixes and clitics with exactly those, positionally:
 *     PST-  a PREFIX gloss     -PST  a SUFFIX      CLT=  proclitic     =CLT  enclitic
 * A trailing hyphen is the morpheme's category, not a slip; stripping it would delete real analysis
 * one invisible character at a time. Nor the apostrophe family or ʔ, which can legitimately end a
 * form. Hence sentence punctuation plus the underscore, which marks no convention this engine knows.
 *
 * ⚠⚠⚠ AND BLUR ONLY. On input this makes a separator untypeable: the moment a space became "PST."
 * the period would be stripped as trailing, so "PST.SUBJ" could never be assembled. */
const stripTrailing = (v) => v.replace(/[.,;:!?_]+$/, '');

/* ⚠⚠ THE KEYBOARD'S OWN "DOUBLE SPACE MAKES A PERIOD", UNDONE — the one rule here that is not
 * about tidying our own input but about reverting someone else's edit.
 *
 * Seth, 2026-09-10: "If I type space three times in the free translation it puts a period before
 * the last word. That looks like a failure of order of operations in your punctuation/space
 * guards..." The order was fine — our rules alone turn three spaces into one and insert nothing.
 * The period is GBOARD'S (and iOS's, and macOS's): pressing space when the field already ends in a
 * space replaces that space with ". ". The typist gets a sentence break in the middle of a clause,
 * and our space collapse then tidies away the leftover gap, which makes the stray period look
 * deliberate rather than obviously wrong.
 *
 * The substitution has an exact signature, which is what makes undoing it safe: the value BEFORE
 * this keystroke ended in a space, and the value after is that same text with the final space
 * replaced by ". ". Nothing a person can type produces that transition — typing a period leaves the
 * previous value ending in a letter, not a space. So a match is the keyboard, and we put the space
 * back; the space collapse in the same pass then reduces it to one, which is what pressing space a
 * third time should have done.
 *
 * ⚠ This needs the PREVIOUS value, so the caller keeps it per field. Without `prev` the rule simply
 * does not fire — it never guesses. */
export function undoKeyboardPeriod(value, prev) {
  if (!prev || typeof prev !== 'string' || !/[ \t]$/.test(prev)) return value;
  const stem = prev.slice(0, -1);
  for (const dot of ['. ', '.']) {          // Gboard writes ". "; some IMEs commit the "." first
    if (value === stem + dot) return prev;
  }
  return value;
}

/* The two kinds of field, and what each does at each moment. Reading this table IS reading the
 * policy; the primitives above only say how. */
const TIDY = {
  /* ⚠ THE BASELINE IS VERNACULAR, AND VERNACULAR IS NOT CORRECTED. This row exists separately from
   * `free` for that reason alone — the two look identical as boxes and are not the same content.
   * Seth, scoping the tighten rule: "In the free translation, I mean." So the baseline gets only
   * what he asked for everywhere — one space between words, and no doubled punctuation ("Periods,
   * commas, etc, should also not double anywhere") — and NOT the space-before-punctuation rule,
   * because "word ." may be how an orthography sets punctuation and we do not know every
   * orthography. This is the same line that keeps autocorrect off vernacular entirely. */
  vern: {
    input: [collapseSpaceRuns, collapseRuns(RUN_SAFE)],
    blur: [collapseSpaceRuns, trimLineEdges, collapseRuns(RUN_SAFE), settlePeriods],
  },
  /* The free translation is prose in the ANALYSIS language, so ordinary typographic tidying is
   * safe here and only here. */
  free: {
    input: [collapseSpaceRuns, tightenPunct, collapseRuns(RUN_SAFE)],
    blur: [collapseSpaceRuns, tightenPunct, trimLineEdges, collapseRuns(RUN_SAFE), settlePeriods],
  },
  gloss: {
    /* A gloss never has its SPACES collapsed: a space there has already become the separator. The
     * punctuation rules are added per call in tidyField, since both need `sep`: anything outside
     * the Leipzig-approved set becomes the separator, then runs of the same character reduce. */
    input: [],
    blur: [stripTrailing],
  },
};

/* ⚠ A SPACE IS NEVER AN OPTION (Seth: "just don't allow space"). A gloss is one label for one word;
 * a space in it would make the word count disagree with the baseline, which is the whole reason the
 * space becomes a separator to begin with. */
export const GLOSS_BREAKS = { period: '.', underscore: '_', hyphen: '-' };
export function glossBreakChar(pref) { return GLOSS_BREAKS[pref] || GLOSS_BREAKS.period; }

/* THE ONE ENTRY POINT.
 *   kind    'line' (baseline, free translation) or 'gloss'
 *   moment  'input' or 'blur'
 *   sep     the gloss separator, so a run of it collapses — and ONLY because the researcher
 *           declared it (see the header note on what is never touched)
 *   prev    the field's value before this keystroke, for undoKeyboardPeriod
 *   caret   returns the caret moved back by whatever was removed BEFORE it; rewriting .value
 *           otherwise throws the cursor to the end, which mid-sentence is worse than the slip was
 */
export function tidyField(value, { kind = 'line', moment = 'input', sep = null, prev = null } = {}, caret = null) {
  // ⚠ An unknown kind falls back to `vern`, the row that rewrites the LEAST — a mistake there tidies
  // too little rather than correcting vernacular text nobody asked us to touch.
  const steps = (TIDY[kind] || TIDY.vern)[moment] || [];
  /* ⚠ BEFORE the column's steps, so the trailing strip on blur sees the already-reduced text:
   * "mau,." must become "mau." and then "mau", not have its final character removed while the
   * comma survives. */
  const glossPunct = kind === 'gloss' ? [glossAllowedOnly(sep), glossRuns(sep)] : [];
  const run = (v) => {
    /* ⚠ LINE BOXES ONLY. In a gloss a period may BE the separator, so an undo there could delete a
     * character the typist meant. It happens to be unreachable — a space in a gloss becomes the
     * separator on the same keystroke, so `prev` never ends in one — but "unreachable" is a fact
     * about today's code and this is a fact about the rule. */
    let out = kind !== 'gloss' && moment === 'input' ? undoKeyboardPeriod(v, prev) : v;
    for (const step of [...glossPunct, ...steps]) out = step(out);
    return out;
  };
  const src = value == null ? '' : String(value);
  const out = run(src);
  if (out === src) return { value: out, caret, changed: false };
  if (caret == null) return { value: out, caret, changed: true };
  // Apply the same rules to the text BEFORE the caret; its new length is the new caret position.
  return { value: out, caret: run(src.slice(0, caret)).length, changed: true };
}

/* ⚠⚠ CAP CONSECUTIVE BLANK LINES — AND ONLY EVER ON A DOC THAT CARRIES NO TIME ALIGNMENT.
 *
 * Deliberately OUTSIDE the table, because it is the one rule whose safety depends on the DOCUMENT
 * rather than on the field or the moment. Seth: "for legacy baseline, multiple line breaks is OK
 * (at least two), but not multiple spaces… limit line breaks to max 2 in a row." Right for a
 * classic transcription, where a blank line is a paragraph separator and applyBaseline discards
 * empties at reconcile anyway.
 *
 * ⚠ IT IS DATA LOSS ON AN ALIGNED DOC. There every blank baseline line is a real timed span of
 * SILENCE, 1:1 with doc.segments. Dropping them is a corruption already suffered and fixed once
 * (2026-08-16): 53 lines with 23 blanks became 30, the spans then paired positionally against the
 * first 30 — silences included — and the recording "ended" half a minute early, reproduced from
 * Seth's own field file. So the CALLER gates this on doc truth, never on a setting, and it is not
 * in the table precisely so nobody can wire it in by picking a cell.
 *
 * `max` counts NEWLINES in a row, so the default 2 leaves at most one blank line between two lines
 * of text — "at least two" line breaks, as asked. */
export function capBlankLines(value, max = 2) {
  const src = value == null ? '' : String(value);
  if (max < 1) return src;
  return src.replace(new RegExp(`\\n{${max + 1},}`, 'g'), '\n'.repeat(max));
}
