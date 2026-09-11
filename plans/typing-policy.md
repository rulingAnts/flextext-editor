# Typing policy — what a keyboard may do to a field

**Status:** the engine-wide half shipped 2026-09-10 (`docs/js/typing.js`). The picker was dropped:
v679 (#68) reads the language from the FLEx writing-system code itself and shows its name under the
code box. See *Built in v679* near the end.

## Why this exists

> "When we're working with minority languages, autocorrect will REALLY screw things up for us with
> non-tech-savvy users working in a language the device doesn't know because there's no spelling
> dictionary for it. It'll autocorrect words to English or MAYBE the LWC." — Seth, 2026-09-10

This is data corruption, not an annoyance. The rewrite is silent, it lands in a language the typist
may not read, and the wrong word is what gets archived. Fayu is in no dictionary on any device and
never will be, so on a vernacular field **every** correction a keyboard offers is wrong by
construction.

It is not hypothetical. Verified on the production Android WebAPK, before this change: the baseline
box "is still attempting autocorrect. Or at least OFFERING autocorrect" — with `spellcheck="false"`
already set. One attribute was not enough.

## Three things, and conflating them is what makes this hard

| | what it does | wanted? |
|---|---|---|
| **REPLACE** | the keyboard silently swaps the word as you type past it | **never, anywhere** |
| **SUGGEST** | a strip of candidates is offered; the typist chooses or ignores | analysis language only |
| **MARK** | misspelled words get a squiggle; nothing is rewritten | analysis language only |

Seth on REPLACE: *"That would almost certainly guess wrong 90% of the time, be way off, and go
unnoticed by the native speaker."* The "go unnoticed" is the whole problem — a wrong gloss the
author never saw is worse than a blank one.

## Two field classes

Marked in the DOM as `data-typing="vern"` / `data-typing="anal"`.

**`vern` — the language being documented.** Baseline textarea, the editable baseline word, segmenter
row inputs, the mini-gloss word, the PAT paste box, and consent name fields (a Fayu personal name is
exactly the word a keyboard rewrites). All three behaviours off, unconditionally.

> "For baseline, we don't even want autocomplete suggestions even, we don't want spellcheck, and we
> DEFINITELY don't want autocorrect ever." — Seth, 2026-09-10

MARK is off here for a reason worth writing down: in a Fayu field `fedahu` is not a misspelling of
anything, it is simply a Fayu word. With no Fayu dictionary the checker falls back to whatever
`<html lang>` says and underlines **every** word — 100% false positives, which teaches people to
ignore squiggles in the one field where a squiggle could still have meant something.

**`anal` — the language it is being documented *in*.** Word glosses, free translations, the
mini-gloss gloss. REPLACE still never; MARK on, because here it earns its place:

> "Just to remind the Fayu people that in Indonesian 'fedahu' isn't a word and get them thinking
> about alternate ways it might be spelled correctly." — Seth, 2026-09-10

Seth's examples are the argument. `fedahu` for *perahu*, `tudu` for *turun* — a Fayu speaker writing
Indonesian by ear, and Fayu has neither /p/ nor /r/ to hear them with. Those are real Indonesian
words spelled wrong, the device **has** an Indonesian dictionary, and a squiggle says exactly the
useful thing without touching the text.

## ⚠ The web platform cannot separate these on Android

This one fact decides the defaults.

- **Desktop** — `spellcheck` draws squiggles and does nothing else. There is no autocorrect to speak
  of, so MARK is free of REPLACE.
- **Android** — `spellcheck` is the only lever. `false` sets `TYPE_TEXT_FLAG_NO_SUGGESTIONS` on the
  input connection and Gboard goes quiet; `true` hands the field back to Gboard, which marks *and*
  suggests *and* replaces as one bundle. There is no attribute that says "mark but never replace."

So MARK resolves per platform (`canMarkWithoutReplacing()`): squiggles where squiggles cost nothing,
silence where asking for them would drag REPLACE in with them. Android gets the honest answer rather
than the nice one — meaning the Indonesian squiggles above are a desktop benefit today.

Also worth knowing: the attribute named `autocomplete` is the browser's own saved-value dropdown, and
is **not** the keyboard's word suggestions — that rides on `spellcheck` on Android. Both are off on
every field this module touches.

## Why it is engine-wide, not per-call-site

> "This is an engine wide change we're implementing. For all our apps." — Seth, 2026-09-10

All seven apps load `docs/js/app.js`, so `enforceTyping(document)` at **module scope** reaches every
one of them. ⚠ Module scope, not `setup()` — `setup()` returns early for CROWD, PARAGRAPH,
RESEARCHER, RECORD and CONSENT, five of the seven; that trap already caught the refresh button and
the offsite links.

A `MutationObserver` sweeps fields that arrive later, because rows are rebuilt as the user scrolls
and a policy applied only at call sites is one new `createElement` away from a hole. It watches
`spellcheck` too, so a stray `el.spellcheck = true` anywhere in the suite loses rather than quietly
winning. Marked-up fields also carry the attributes in the HTML: the IME reads them when it attaches,
so a field hardened after first focus has already offered a round of suggestions.

## Built in v679 (#68): no picker; the code names the language

Seth, 2026-09-11: *"What we want is the user to manually enter the writing system code, and then if
it matches a language that langtags.json recognizes, then display that language name after the ws
code box."* And the rule that shapes it: *"We don't want to make it easy for the user to skip
noticing and checking their writing system code. By offering something that looks automatic but
actually isn't."*

- **FLEx writing-system codes ARE BCP-47** (#68, correcting the "not a BCP-47 language tag" claim in
  the history below). `parseWsCode` in `typing.js` splits one; the language is its first subtag.
- **The name** comes from SIL's langtags.json, trimmed by `tools/build-langtags-names.mjs` to one name
  per language subtag: `docs/js/vendor/langtags-names.js`, 8,105 subtags, about 62 KB gzipped, MIT.
  It loads only when a settings form shows a code box and is in no service worker's precache.
  `ldml.api.sil.org` sends no CORS header, so a page could not fetch the live file anyway.
- **A check, never a fill.** The code stays typed by hand; nothing is suggested or filled from the
  name. A name shows only for a code FLEx could have written exactly as typed: well-formed, in
  canonical case (`FAU` shows nothing), no extended-language form, and a subtag BCP-47 actually uses
  (`ind` shows nothing, because FLEx writes `id`).
- **The spellcheck tag** comes from the same parse (`spellcheckTagFor`): language, script and region
  only; nothing for a variant (`id-fonipa`), private use (`fau-x-etic`), `qaa`–`qtz`, or a wrong case.

## Still to build

**Spelling dials go inert when the analysis language cannot be identified** (Seth, 2026-09-10, in
#68): push all three dials off, keep the researcher's stored choice, and say so beside the dials.
⚠ Re-decide what "identified" means first. The 2026-09-10 plan used `Intl.DisplayNames`, where "no
name" roughly meant "no dictionary exists" because CLDR only names widely written languages. The
langtags table names almost every language, Fayu included, so "has a name" no longer implies a
dictionary could exist, and it must not become the test for the dials.

### History: the picker design v679 replaced

**The researcher-facing analysis-language picker.** Seth, 2026-09-10:

> "our 'analysis language' selection needs to be smarter than just a writing system code. A writing
> system code and also an ISO code lookup that gives us a language name that it can pass to a device
> and then autocorrect, autocomplete, and spell check toggles for analysis language that the
> researcher can toggle on and off (also clarifying that this depends on device capabilities)"

**Which code system, settled (2026-09-10, issue #68).** BCP-47 is what browsers and spelling
dictionaries match on — and it is not a rival to ISO 639-3, because a BCP-47 tag's primary subtag
*is* an ISO 639 code, shortest-available: 639-1 where a two-letter code exists, otherwise 639-3.

| language | 639-3 | BCP-47 |
|---|---|---|
| Fayu | `fau` | `fau` |
| Indonesian | `ind` | `id` |

Only the ~180 languages with a 639-1 code diverge, and those are exactly the LWCs used as analysis
languages — every minority language being documented has no 639-1 code, so its 639-3 code already
*is* its BCP-47 tag. So: **show** Ethnologue name + 639-3 (what a linguist recognises), **store**
639-3 as identity, **derive and store** the BCP-47 tag from a ~180-entry table, **send** only the
tag to the device. ⚠ Derive in the PANEL, so the code table never ships to a field device — these
install over poor connections and must work offline.

Three stored values per language, each with one job: the FLEx writing-system code (the export), the
639-3 code (identity), the BCP-47 tag (the only one a device sees).

⚠ **THE PICKER MUST NEVER PREFILL, SUGGEST OR VALIDATE THE FLEx WRITING-SYSTEM CODE.** Data flows
one way: picker → 639-3 → BCP-47 → the device, and never back into the WS code. Seth, 2026-09-10,
revising an earlier suggestion of his own: *"really we want the user checking what's in FLEx and
matching that, not trusting our language picker to get it right and then finding out the hard way
that it doesn't work."*

A WS code that does not match FLEx yields an export FLEx refuses or misreads, discovered late —
after a coworker has spent a day transcribing. An entire separate tool exists to clean up mangled
writing-system codes, which is evidence enough of the cost. A helpful-looking suggestion makes it
worse rather than better: it swaps "the researcher copied this from FLEx", which is verifiable, for
"the researcher accepted our guess", which silently is not. The two fields should not even LOOK
coupled — placing them adjacent so one appears to fill the other is the same trap, quieter.

**Scope: the analysis language first.** That is where the picker earns anything — a real dictionary
exists and today's behaviour is demonstrably wrong. For the vernacular it is optional and low-value:
no browser will ever hold a Fayu dictionary, so it buys only font selection, hyphenation and
screen-reader behaviour, while putting a language-guessing control beside the one field that must
match an external system exactly. If it is added, keep it visibly separate and make plain that it
does not affect the export.

⚠ **A FLEx writing-system code is not a BCP-47 language tag.** `fau-x-iyarike` is a perfectly good
writing system and is meaningless to a spellchecker, and aiming a dictionary at the wrong language is
worse than aiming it at none. Fayu's own code is the proof: `iau_tmu` has an underscore and an unregistered subtag, so it is not a
tag at all — under the design above it becomes `iau-x-tmu` for the device while the FLEx code stays
`iau_tmu` for the export. Today `app.js` screens the code, and anything that is not a usable tag
yields NO tag: `auto` then declines to mark rather than guessing a language (v659). The picker needs to pair the writing system with a
real ISO lookup yielding a language name, plus an `auto` option, plus copy saying plainly that
whether any of it takes effect depends on the device.

**The native route — the only way to Seth's actual ideal.** See issue #62.

> "Maybe offering them choices, but not automatically correcting."

The web cannot express that. Android can: `TYPE_TEXT_FLAG_AUTO_CORRECT` and
`TYPE_TEXT_FLAG_NO_SUGGESTIONS` are separate bits on `EditorInfo`, so the Capacitor shell can leave
the suggestion strip visible while forbidding the automatic swap — exactly "offer choices, never
replace", on the devices where it matters most.
