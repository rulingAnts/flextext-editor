# Typing policy — what a keyboard may do to a field

**Status:** the engine-wide half shipped 2026-09-10 (`docs/js/typing.js`). The researcher-facing
language picker is still to be built — see *Still to build* at the end.

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

## Still to build

**The researcher-facing analysis-language picker.** Seth, 2026-09-10:

> "our 'analysis language' selection needs to be smarter than just a writing system code. A writing
> system code and also an ISO code lookup that gives us a language name that it can pass to a device
> and then autocorrect, autocomplete, and spell check toggles for analysis language that the
> researcher can toggle on and off (also clarifying that this depends on device capabilities)"

⚠ **A FLEx writing-system code is not a BCP-47 language tag.** `fau-x-iyarike` is a perfectly good
writing system and is meaningless to a spellchecker, and aiming a dictionary at the wrong language is
worse than aiming it at none. Today `app.js` screens the code and passes through only a plain 2–3
letter tag, falling back to the device language. The picker needs to pair the writing system with a
real ISO lookup yielding a language name, plus an `auto` option, plus copy saying plainly that
whether any of it takes effect depends on the device.

**The native route — the only way to Seth's actual ideal.** See issue #62.

> "Maybe offering them choices, but not automatically correcting."

The web cannot express that. Android can: `TYPE_TEXT_FLAG_AUTO_CORRECT` and
`TYPE_TEXT_FLAG_NO_SUGGESTIONS` are separate bits on `EditorInfo`, so the Capacitor shell can leave
the suggestion strip visible while forbidding the automatic swap — exactly "offer choices, never
replace", on the devices where it matters most.
