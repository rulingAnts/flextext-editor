# PAT: one tree — propositions become lines (PLAN, not built)

**Status: design.** Nothing implemented. Seth's proposal, 2026-08-08.

> *"I think we should not have propositions and segments/language data lines as different
> categories/things in our model. I think it should be one tree that includes both. … Instead of
> creating a proposition and having it supplant the language data line, we depend on the fact that we
> can edit the free translation line. If the user wants to split the free translation line up into
> multiple semantic propositions … what they can do is add a new language data line that has nothing
> but a free translation. And then it goes in our tree just like anything else."*

---

## 1. Why this is right, and why it is overdue

The model has been converging on this for days without anyone saying so out loud.

- **Grouping already treats them as one surface.** `checkInvariants` (paragraph-model.js:106):
  *"No same-line rule any more (Seth, 2026-08-05): propositions and lines share ONE surface, so a
  group may hold a proposition beside a proposition from the next line, or beside a whole line."*
- **A line can already be `implicit`**, "exactly like a proposition" (:205) — because in a
  from-scratch chart *every line IS a proposition*.
- **`splitLine` already exists** (:231), described as *"just editing text"* in a chart whose lines
  are propositions.

⚠ **The file now contradicts itself, which is what the redundant category costs.** The block at
:292 still asserts *"a group may not mix propositions from different lines, nor mix propositions with
lines"* — a rule removed on 2026-08-05 and enforced **nowhere**. Two comments, one file, opposite
claims. Delete the stale one when this lands (§8).

## 2. The model

**There is one kind of unit: a line.** `props` is gone. A line may have any of baseline, words with
glosses, a free translation, a time span, a speaker — and a line that has *only* a free translation
is what used to be a proposition.

⚠ **There is no "parent" and no ownership.** The old model made a proposition belong to the line
owning its audio span (:293). Dropping that dissolves a question rather than answering it: nobody's
free translation goes partial, because a semantic line is a *sibling*, not a refinement. Whatever
relationship exists is whatever the user builds in the tree — which is the entire point.

The user workflow is ordinary editing, and the docs must say so: **edit the free translation line,
and add a free-translation-only line for each further proposition.**

### 2.1 ⚠ Timeless, spelled as NO TIME — not `start === end`

Seth: *"It needs to have 0ms and make zero difference to our audio alignment."*

The requirement is the second half. Implement it as **no span at all**, not a zero-length one:

- `segments.js:23` sets `MIN_SEGMENT_MS = 120` and **demotes anything shorter to `timePending`** — so
  a literal 0 ms span would silently become *"unaligned, needs alignment"* and the segmentation
  editor would nag forever to align a node that can never be aligned.
- A zero-length span still participates in the monotonic clamp and in EAF time-slot sharing: it is a
  boundary, and boundaries can be nudged. A line with **no** span has nothing to nudge, so "zero
  difference to alignment" holds *by construction* rather than by care.

This is the same guarantee today's propositions get from inheriting `spanOf` — kept, by other means.

### 2.2 ⚠ `timePending` and "timeless" are DIFFERENT states — and blank lines are why

Seth: *"our flextext data may already have blank lines from FLEx quirks or from empty EAF annotations
OR gaps between annotations."* Per the segmentation rules those blank lines are **real timed spans
(silence)**. So:

| | baseline | words | time | means |
|---|---|---|---|---|
| imported blank line | empty | none | **has one** | a silence/gap in the recording |
| line awaiting alignment | any | any | `timePending` | *we do not know it yet* |
| **semantic line (new)** | empty | none | **none, permanently** | a proposition |

**Emptiness cannot discriminate** — the first and third are both empty. Without an explicit marker an
imported gap and an authored proposition are the same object, and a round trip could turn silence
into a proposition or swallow one into the other. **One boolean on the line** settles it, and it is
far lighter than the dual model it replaces.

⚠ It must be a *positive* marker on the semantic line, not "absence of time" — because absence of
time is already `timePending`'s territory, and conflating them is exactly the nagging failure in
§2.1.

### 2.3 The rendering rule

**Render on what a line HAS, never on what kind it is.** A line with no baseline and no words draws
as free-translation-only: no baseline row, no gloss row, and centred on the FT rather than on an
empty baseline.

This rule earns its keep twice — it is also what makes an imported blank line render sanely — and it
is the only UI work the whole change strictly requires.

## 3. Identity: carry the guid

Seth: *"our model needs line IDs somehow. Not JUST position IDs ideally."*

**The identity already exists and already survives editing. `.fxpa` simply throws it away.**

### 3.1 What is already true

Every phrase carries `attrs.guid`:

| where | what |
|---|---|
| `flextext.js:85` | `attrs: opts.attrs ?? { guid: newGuid() }` — authored phrases get one |
| `flextext.js:273` | `if (!seg.attrs.guid) seg.attrs.guid = newGuid();` — heals anything missing |
| `flextext.js:14` | `newGuid()` = `crypto.randomUUID()` |
| `flextext.js:421` | `pAttrs` serializes **every** `seg.attrs` entry onto `<phrase>` — it goes out in the XML |
| import | phrase attributes are read back into `seg.attrs`, which is why the `:273` check is meaningful rather than always-true |

⚠ **Correcting a common belief:** guids are *not* FLEx-only. FLEx-sourced text keeps its guids, but
editor-authored text is **minted** one and anything arriving without one is **healed**. They persist
in IndexedDB and survive a `.flextext` round trip.

**And they survive editing.** `reconcileBaseline` — the funnel every line edit goes through:

- **Pass 1 (LCS, exact text match)** reuses the *old segment object* wholesale (`exact.baseline =
  ns.text`). Guid untouched.
- **Pass 2 (ordered fuzzy pairing)** builds a new segment but passes `attrs: old.attrs` forward.
  Guid carried.
- **No `old`** → `makeSegment` mints fresh. Correct: it *is* a new line.

Which means the split/join identity questions are **already answered by shipped code**, not by this
design:

| edit | identity |
|---|---|
| split `"A B"` → `"A"`, `"B"` | first half **keeps** the guid; second mints a new one |
| join `"A"` + `"B"` → `"A B"` | first guid **survives**; the second is **dropped** |
| insert a line | fresh guid |

### 3.2 What to change

`buildFxpa` (seg-exports.js) mints `id: 'L' + (i + 1)` and discards `t.attrs.guid`, which is sitting
right there. Carry both:

- **`id: "L3"`** — stays. The tree's short, readable reference key, stable within a document, and the
  only identity a from-scratch chart can have.
- **`guid`** — new. Durable identity of the underlying phrase, stable across exports, edits, and a
  FLEx round trip.

⚠ **A stale comment to fix in the same commit.** `buildFxpa`'s header claims *"lines carry STABLE ids
(L1..Ln, minted here) … so the grouping survives later bottom-level edits."* True **inside** one PAT
session; false **across** an export — `L3` today is not `L3` tomorrow. That sentence is why the
staleness bug (BACKLOG, "The exported `.fxpa` can go stale") was not noticed earlier.

### 3.3 ⚠ The limit of a guid — write this down before someone assumes otherwise

A **healed** guid is minted at heal time, on that device. If the same text exists independently on
two devices — a researcher assigns it to two workers — each heals to a **different** guid.

So a guid identifies *"this phrase, in this device's lineage of this text"*, **not** *"this phrase,
universally."* Sufficient for the PAT flow (one editor, one export, one lineage). **Not** sufficient
for reconciling two analyses of the same text done on two devices. Do not build that on guids without
solving this first.

### 3.4 PAT-authored lines mint their own guid

Including the semantic lines of §2 and every line of a from-scratch chart — so they are first-class
rather than a guid-less subclass. `crypto.randomUUID()` is already imported territory.

## 4. ⚠ Data flow is ONE-WAY — and that closes several questions

Seth, 2026-08-08: *"We're moving away from editor able to read fxpa back. We don't actually want
that. We don't want PAT to export to FLEx or Editor. EAF maybe, in the future. So fxpa only imports
in PAT. It's PAT's save that can open in other PAT instances, or the same one."*

```
Editor ──.fxpa──▶ PAT ──PAT save──▶ PAT (same or another instance)
                   └──.eaf──▶ ELAN   (future, partial — §5)
```

Consequences, all simplifying:

- **No provenance field.** Nothing merges back, so there is no need to tell text-lines from
  PAT-authored lines. Seth: *"We don't need to worry about the provenance question if we're doing
  one-way flow, which we are."*
- **PAT's durable artifact is its own save**, not the `.fxpa`. The `.fxpa` is an import envelope.
- **The editor's transfer format is `.fxed`** (see `fxed-format-spec.md`), which can also export
  `.fxpa`. Different jobs; do not merge them.

⚠ **This CANCELS an active backlog item:** *"Read and edit .fxpa in the FlexText Editor without
breaking the analysis"* (`BACKLOG.md:19`), currently marked *"Next up after the current settings
work."* Close it with this reasoning rather than delete it, so it is not re-proposed.

## 5. ELAN export: exclude free-translation-only lines, and warn honestly

Seth: *"free translation lines with no language data should just not be included in the export (and
warn the user about that)."*

Correct by construction: no time means no aligned annotation, so there is nothing honest to emit.

⚠ **The warning must name the damage, not the count.** A group containing an excluded line still
exports — now missing a member — so a tier meant to represent that group *misrepresents* it.
"3 lines omitted" reads as trimming; **"2 groups exported incomplete"** is what actually happened.

⚠ **Name the tension in the docs before anyone treats EAF as an archive path.** Free-translation-only
lines are precisely the semantic propositions PAT exists to produce. An EAF that drops them carries
the interlinear text and the groupings *over* it, but not the analysis's own contribution. That may
be fine — ELAN is for time-aligned data — but it makes EAF **a partial view by design, not a round
trip.**

## 6. Migration: into the existing repair path, keyed off `version`

Seth: *"we add this to our validation/repair/fix code that already exists to fix old fxpa to be
compliant with new models."* Right seam — `checkInvariants` + `repairDocument`.

**A whole repair step deletes itself.** `repairDocument:1233` opens with *"A line whose propositions
stand in for it must not ALSO be named by a group"* — a step that exists **only** because
propositions supplant their line. Under one tree it has nothing to do. That is a good sign: this is a
simplification, not a translation layer.

**The conversion:** each `prop` becomes a free-translation-only line (§2), inserted immediately after
its source line, in prop order.

### ⚠ Four things it must get right

1. **Insertion order.** Adjacency is what guarantees no crossing brackets (:108). Insert out of order
   and previously-valid trees become invalid.
2. **THREE reference sites, not one.** `g.children`, `g.heads` (an **array** — plural), and the
   **keys of `g.labels`**. Labels are the one that gets missed: a missed key does not error, it
   silently drops a role.
3. **Idempotence.** Repair runs on every load; the second pass must be a no-op.
4. **Key it off `version`, not off sniffing for `props`.** `version: 1` is already a promise. Bump to
   **2** so the migration is explicit and an older PAT refuses a newer file cleanly instead of
   half-reading it.

⚠ **Keep `isPropId` / `lineOfPropId` (:346–347) as migration-only helpers** even after the model
drops propositions — they are how an old file gets read at all. Label them so nobody tidies them
away.

⚠ **`orderKey`'s `li * 1000 + pi` scheme (:387–396) goes away**, replaced by plain line position.
That arithmetic exists solely to interleave two unit types.

## 7. Order of work

1. **Migration + `version: 2`** in `repairDocument`, with tests over real old `.fxpa` fixtures. Pure
   and node-testable; do this alone and first.
2. **The timeless flag** and its distinction from `timePending`, with tests covering the blank-line
   collision (§2.2).
3. **Rendering rule** — FT-only lines in the chart and line UI.
4. **Carry `guid` in `buildFxpa`**, plus the stale-comment fix (§3.2). Independent of 1–3.
5. **Drop `props`** from the model once 1–3 ship and no live file needs it.
6. EAF exclusion + warning — only when PAT→EAF is actually built.

⚠ Step 1 is where the risk is, and it is the one step that can corrupt existing user analyses. Do not
start at step 3 because it is the visible one.

## 8. Corrections to make when this lands

- **paragraph-model.js:292–295** — delete the assertion that a group may not mix propositions across
  lines or with lines. That rule was removed 2026-08-05 and is enforced nowhere; :106 is the truth.
- **seg-exports.js `buildFxpa` header** — the "STABLE ids … survives later bottom-level edits" claim
  is true only within a session (§3.2).
- **BACKLOG.md:19** — close "Read and edit .fxpa in the FlexText Editor" as cancelled (§4).
- **BACKLOG.md** — the `.fxpa`-goes-stale entry can point here: guid-carrying is the real fix, and
  the v319 `source.lineCount` stamp demotes to a fallback for guid-less files.

## 9. Open questions

1. **Does re-importing a corrected text into an EXISTING PAT analysis need to work?** If yes, guid
   matching is the mechanism and §3 is load-bearing. If no — the text is frozen at import and a
   correction means starting over — guids are cheap hygiene worth doing anyway. Not yet decided.
2. **A join drops a guid** (§3.1). If PAT has grouped or labelled the dropped line, what becomes of
   that node? The only identity case shipped code does *not* already answer.
3. **`attrs` is passed by reference in `reconcileBaseline` pass 2**, and `attrs` also holds imported
   `begin/end-time-offset`. Confirm a fuzzy-paired split cannot carry a stale offset onto the wrong
   half. Suspected pre-existing, unrelated to this plan, but found while tracing it.
