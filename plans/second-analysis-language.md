# A second analysis writing system — editable, switchable, off by default (#41)

> Seth, 2026-10-05: *"We will need to implement the second editable layer (with backward compatibility)
> eventually … the option to allow multiple vernacular languages in flextext editor as well with device
> settings to enable/disable the user's ability to see that (a secondary analysis writing system toggle
> switch that is off by default in the UI and the device settings (both unpaired and researcher) can show
> or hide it). By default devices only have two writing systems (vernacular and analysis), but we may want
> the option to add a secondary analysis writing system that can also be handled in our suite/UI/data."*
> Earlier (#41, 2026-09-04): LWC→English glossing and free translation in the Editor, then straight to
> morpheme breaks in FLEx.

**Status: PLAN ONLY — not built.** Written 2026-10-05 after the display-only picker shipped in the Audio
Segmenter (v704, `analysisRows` in `flextext.js`). Everything below was checked against the code that day.
**2026-10-07: phase 0 added** — the browser-DB storage model (#104), agreed by Seth as the first step of this work.

## 1. What the suite does today (the facts the plan stands on)

- **One editable gloss per word, one editable free translation per line.** `w.gls` / `w.glsLang` and
  `seg.free` / `seg.freeLang` (`flextext.js` `makeSegment` ~88, `parseWord` ~391–407). At import,
  `pickByLang(items, prefs.analLang)` (~347) chooses the `<item type="gls">` in the device's analysis
  language; a `lang` of `''` means "the document's analysis language".
- **Every other analysis language already round-trips.** Non-chosen `gls` items are kept verbatim as
  strings — `w.preservedXML`, `seg.preItemsXML` / `seg.postItemsXML` — and re-emitted by
  `serializeFlextext` (~590–640) around the editable ones. `wordGlosses(w)`, `phraseFrees(seg)` and
  `analysisLangs(doc)` (~1140–1195) read them back; the ELAN export already writes one tier per language
  (`seg-exports.js` ~140–175, 2026-09-05) and lameta uses `analysisLangs` (`lameta.js` ~359).
- **The device knows two writing systems.** `vernLang` / `analLang` (+ `vernName/Font`, `analName/Font`)
  in both settings surfaces (`app.js` SETUP_GROUPS ~6914, `researcher-panel.js` GROUPS ~720),
  validated as required (`validateDeviceSettings`), reported in the inventory snapshot (~5276), and
  the typing dials (`typing.js`: `SEL_ANAL = '.free-input, .gloss-input, .mg-g, .mg-ft'`,
  `analLangTag()`, `WS_CODE_FIELDS = ['vernLang', 'analLang']`) assume ONE analysis language.
- **The UI assumes one analysis row.** Gloss tab: one `.gloss-input` per word (~4587) and one
  `.free-input` per line (~4401); the Segmenter's matcher: `.mg-g` under `.mg-w`, `.mg-ft` per line
  (`mgWordStack`, `mgDraw`); the PAT and the listening page draw `w.gls` / `l.free`; `.fxpa` carries one
  `gls` and one `free` per line (`paragraph-ui.js` ~439).
- **Edits that move text between lines copy the single gloss/free.** `mergeWords`, `breakPhrase`,
  `glossSplitAt` (`app.js` ~1835–1872: `L.free = free.slice(0, at)`…), `flextext.js` ~1001/1013
  (`merged.glsLang = …`, `nw.gls = w.gls`).

## 2. The shape

### 2.0 Phase 0 — the browser DB keeps FLEx data as fields, not XML fragments (#104; Seth, 2026-10-07: "I agree")
The Editor's IndexedDB (`flextext-editor` v2, `docs/js/db.js`) stores a parsed doc model, but everything the editor
does not model rides inside it as verbatim XML strings — per word `preservedXML` (morphemes, POS, **other-language
glosses**), per phrase `preItemsXML` / `postItemsXML` (notes, literal and **other-language free translations**), per
text `metaItemsXML`, `objectsXML`, `mediaXML` (`flextext.js` `serializeEl`). A second analysis language lives exactly
in those strings, so this plan would otherwise be string surgery. Phase 0:
- Replace the fragment strings with a **lossless structured node tree** (`{ t, a, c, x }`: tag, attributes,
  children, text) in the same places; the serializer still writes byte-identical `.flextext`.
- A **`schemaVersion`** on every doc record and a **lazy migration** on read (old records stay readable; a record is
  rewritten in the new shape on its next save) — no bulk rewrite of devices in the field.
- **Proof before switching on:** export every text in the Fayu corpus and the FLEx test corpus before and after
  migration and require identical `.flextext`; check every other reader of the model at its boundary (sync/inventory,
  `.fxpa`, the segment exports, lameta).
- Nothing visible changes. Its payoff is that §2.1's `gls2` / `free2` (and §2.1b's exact-language rule) become field
  edits; it also unblocks #103 (EAF/SFM/USFM import), #96 (speakers) and #97 (gaps).

### 2.1 Model: a second editable slot, not a generalised map (backward compatibility first)
- Words gain `gls2` / `gls2Lang`; segments gain `free2` / `free2Lang`. Chosen at parse by
  `pickByLang(items, prefs.analLang2)` when the device HAS a second analysis language; otherwise
  those items stay in the preserved XML exactly as today. Serialising writes `gls2`/`free2` as one
  more `<item type="gls" lang=…>` each, in the same position the preserved copy had.
- **Why two slots and not `glosses: {lang: text}`:** every edit site (merge, split, reconcile, undo
  snapshots, `.fxpa`, sync blobs, the IndexedDB records of ~700 shipped versions) reads `w.gls`. Two
  named slots leave all of that untouched and testable one site at a time; a map would be a rewrite of
  the model with no second-language UI to show for it until the end.
- **Backward compatibility, concretely:** a text edited on a device with `analLang2` serialises extra
  `gls` items; an older device (or one without `analLang2`) imports them into preserved XML and
  re-emits them untouched — exactly the v~600 behaviour that already protects FLEx's other languages.
  The one trap: if BOTH slots point at the same language (analLang2 === analLang), or `analLang2`
  equals a language that is also in preserved XML on a text imported earlier, we would write a
  language twice. `pickByLang` must move the chosen item OUT of the preserved list (it does for the
  primary), and settings validation refuses `analLang2 === analLang` or `=== vernLang`.

### 2.1b Texts that lack the second language — and every other mismatch (Seth, 2026-10-05)

> *"it's not just devices without a second language, but also TEXTs without a second language that
> our app with this feature needs to be able to handle. So like the project (and device settings) may
> specify two analysis languages, but if a particular text only has one, that needs to not break our
> app when it imports."*

The device's two languages and the text's languages are independent facts, and every combination
must import, edit, save and export without a special case the coworker can see:

| Device has | Text has | What happens |
|---|---|---|
| en only (today) | en | today, unchanged |
| en only | en + id | id rides as preserved XML (today, unchanged); the Segmenter's v704 picker shows it read-only |
| en + id | en only | **the case Seth named.** `pickByLang(items, 'id')` finds nothing → `gls2 = ''`, `gls2Lang = ''` (empty, meaning "the device's second language"), exactly as a word with no gloss at all is `gls = ''` today. The Gloss tab shows an EMPTY second row under each word and an empty second free line — that is the layer waiting to be filled, not an error. Nothing is written for it until someone types (serialise `gls2` only when non-empty, the same `if (w.gls)` rule as today), so a text that is only looked at round-trips byte-for-byte. |
| en + id | en + id | both slots editable; nothing rides |
| en + id | en + fr | fr rides as preserved XML; the id slot is empty and editable; the picker shows fr read-only. **The one rule that matters:** a slot is filled only by an exact language match — never "the next language we find" — or an fr gloss would be edited as if it were id and written back under the wrong code. |
| en + id | id only (no en at all) | the primary slot is empty (today's behaviour for a text with no glosses), the second is filled. The Baseline/Gloss tabs already cope with an untranslated text. |
| en + id | en + id, but only SOME words/lines have id | per item: words that have it show it, words that lack it show the empty row. There is no line-level "has a second language" flag to get out of step. |
| en + id | three or more languages | the two slots as above; the rest rides. `analysisLangs` lists them all; the picker shows them read-only. |

Two consequences for the build: (1) `pickByLang` must MOVE a chosen item out of the preserved list
and must never choose a different language than asked (the "exact match" rule above) — the test for
phase 1 runs every row of this table over real corpus files (the corpus has texts with 0, 1 and 2
analysis languages); (2) the UI's empty second row needs its own placeholder text ("gloss in id…"), so
a coworker on a one-language text sees what the row is for rather than a blank.

### 2.2 Settings: three keys, both surfaces, off by default
- `analLang2`, `anal2Name`, `anal2Font` beside the existing `analLang` trio in the *This device ▸
  Languages* section (unpaired Settings tab and the researcher panel's per-device + project-default
  forms, the same GROUPS table). Blank = no second language (today's device).
- `showAnal2` (checkbox, default OFF): whether the coworker SEES and edits the second layer. The
  researcher can set the language on a device and keep the layer hidden until the coworker is ready —
  the same "pare back, then grow" rule as every other affordance (plans: granular UI gating). With
  `analLang2` blank the switch is inert and greyed with the reason (never removed).
- Validation (`validateDeviceSettings` + `validateDeviceSetup`): `analLang2` ≠ `analLang` ≠ `vernLang`,
  same code rules as the others (`research.wsCase`). Inventory snapshot and `SEGMENTER_SETUP_KEYS` gain
  the keys; `typing.js` gets a second tag source (`anal2LangTag`) and the spellcheck dial applies per
  field by `data-lang`.

### 2.3 UI, by app
- **Editor, Gloss tab:** under each word a second `.gloss-input` row (`data-lang=analLang2`), under
  each line a second `.free-input`; Enter/landing rules (`glossLanding`, `freeEnterNext`) treat the
  second row as the next stop after the first. Hidden entirely when `showAnal2` is off. Baseline and
  Cut tabs: nothing changes.
- **Audio Segmenter:** the matcher's `.mg-g` / `.mg-ft` get an editable second row when `showAnal2`
  is on (today's `mg-g-alt` read-only rows remain for every OTHER language). The v704 picker keeps
  working: primary, second, others, all.
- **PAT and listening page:** show both rows when present (read-only, as they are today).
- **Exports:** `.flextext` (above); ELAN already has per-language tiers; `.fxpa` gains `gls2`/`free2`
  (readers ignore unknown keys); SayMore keeps its two documented tiers.

### 2.4 Multiple VERNACULAR writing systems (later, sketched only)
Seth's note: "the option to allow multiple vernacular languages". A word's `txt` item is the baseline
in ONE vernacular WS (`w.txt` / `w.txtLang`; a second orthography would be another `<item type="txt"
lang=…>` per word and per phrase). The same two-slot pattern applies (`txt2` / `txt2Lang`, `vernLang2`),
but the Baseline tab is a free-typing surface whose words are tokenised from one string — a second
orthography needs its own typing line per segment and a rule for keeping the two in step
(word-for-word? free?). That is a design conversation of its own; nothing in §2.1–2.3 forecloses it.

## 3. Work, in order, with estimates

| Phase | What | Effort (a Claude session ≈ a few focused hours + Seth's staging check) |
|---|---|---|
| 0 | Browser DB: fragments → lossless node tree, `schemaVersion`, lazy migration, corpus round-trip proof (#104) | 1–1½ sessions |
| 1 | Model: `gls2`/`free2` in makeSegment/parseWord/pickByLang/serialize; merge/split/reconcile/undo carry them; `wordGlosses`/`phraseFrees` know the slot; the §2.1b table run over real corpus files (0, 1, 2 languages; a two-language device importing a one-language text and saving it unchanged) | 1 session |
| 2 | Settings: the four keys on both surfaces, validation, snapshot, segmenter keys, typing tags; release note | 1 session |
| 3 | Gloss tab: second gloss row + second free line, landing/Enter rules, gating by `showAnal2`; phone layout | 1–2 sessions |
| 4 | Segmenter editable second row; PAT + listening page display; `.fxpa` fields | 1 session |
| 5 | Docs (README settings tables, in-app help EN/ID), smoke-test lines, release | ½ session |

**Total: about 5½–7½ sessions** of building (phase 0 included), spread over a week or two of calendar time so each phase
gets a staging check (phases 0 and 1 are invisible on their own; phases 0–2 ship together behind the OFF
switch, so nothing changes for anyone until a researcher turns it on). Risks that could stretch it: the Gloss
tab's split/landing logic (plans/split-tiers.md) has many pinned rules; the `.fxpa` and PAT readers
in the field; and the double-write trap in §2.1, which needs a corpus-wide dry run before release.

## 4. Open questions for Seth
1. Is the second language always a *second analysis* language (LWC + English), or should the slot be
   able to hold a second *vernacular* orthography too (§2.4)? The answer decides whether `txt2` is in
   phase 1 or a separate plan.
2. On the Gloss tab, does the second row sit under each word (interlinear, as FLEx shows it) or as a
   second free-translation line only? Both are cheap; the per-word row is where the typing rules bite.
3. Should the researcher be able to lock the FIRST layer once the second is on (e.g. English glosses
   done by the coworker, LWC by the researcher)? Nothing in the plan needs it; it is one more permission.
