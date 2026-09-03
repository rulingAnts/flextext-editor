# Paragraph/phrase structure on export — WHY IT IS FLAT, and what is still open

**Status:** closed as "working as intended", with one genuinely open question at the end.

⚠ **Read this before you decide the flat export is a bug. It is not.** I decided that on
2026-09-03, drafted a fix, and was wrong. Writing it down so the next person does not spend
the same hour.

## The flattening is deliberate

`normalizePhraseLines` promotes every phrase to its own paragraph, minting a fresh guid for
each after the first. That looks like entropy — 1 paragraph in "Rumah Jatuh di Muara Suhu"
becomes 60 on export, 59 guids invented — and it is not.

**Seth, 2026-09-03:** *"The reason we default to every phrase as its own paragraph is so
that you're merging instead of splitting in ELAN, because ELAN won't allow us to make those
splits at higher levels."*

An annotator in ELAN can MERGE adjacent annotations; they cannot split at higher tier
levels. So the export is deliberately maximally split: every join the fieldworker needs is
a merge, and no operation they need is one ELAN refuses. Under that intent the minted guids
are not pollution — **they are required**, because 60 paragraphs cannot share one guid.

## And it is load-bearing for alignment, not only for ELAN ergonomics

`phraseRows` (seg-exports.js) is what every annotation export iterates:

```js
const live = para.segments.length === 1 ? (segs[i] || null) : null;
```

`doc.segments` is indexed per PARAGRAPH. So when a paragraph holds several phrases, a phrase
can only fall back to its OWN imported offsets — our segmentation cannot reach it. Without
the flattening, a freshly-segmented multi-phrase paragraph exports an EAF **with no times at
all**. The flatten is the mechanism that lets a paragraph-indexed alignment attach per phrase.

## Measurements (kept — they were the useful part)

Round trip with no restructuring is clean, so the serializer itself is not lossy:

| | source | re-serialized |
|---|---|---|
| `<paragraph>` / `<phrase>` / `<word>` | 1 / 60 / 458 | 1 / 60 / 458 |
| element types lost | — | **none** |

(+59 `<item>` and +26 KB are our own `segnum` items and indentation: additive.)

After `normalizePhraseLines`: 1 → 60 `<paragraph>`, 59 new guids. As intended, per above.

## Provenance

v322 (307fcea, 2026-08-10), from the "gloss join collapsed ALL segments on the first line"
field bug. 2026-09-03 moved it from the three editor tab-switch paths to the three points
where a foreign flextext BECOMES a stored doc, so line breaks no longer depend on whether a
text happened to be opened. That part stands.

## What is actually still open

Seth's recent FLEx texts encode **phrase breaks = clauses, paragraph breaks = sentences**.
The flat export cannot represent that distinction: a round trip back into FLEx loses which
breaks were sentence breaks.

That is a real loss, but it is the price of the ELAN property above, and the two cannot both
be satisfied by one export shape. The question worth asking one day is whether the
**.flextext** export (which goes back to FLEx, where splitting IS possible) should preserve
the grouping while the **EAF** export stays maximally split — different destinations,
different constraints. That is a bigger design conversation than a bug fix, and nobody has
asked for it.

The drafted mechanism, if it is ever wanted: mark each line with `paraOf` (original guid),
have `serializeFlextext` emit consecutive lines sharing one inside a single `<paragraph>`,
and carry `paraOf` through mgLoad/mgSplitLine/mgJoinLine/mgCommit. A line with no `paraOf`
groups by nothing, so old docs export byte-identically. ⚠ The span index must stay per LINE —
`doc.segments` is 1:1 with lines, not with emitted paragraphs.

## Related, also backlog

**How many audio segments can be drawn before memory is overwhelmed** (Seth, 2026-09-03: "a
problem we're going to have to handle in the near future, but not today"). The guesser
already refuses `> GUESS_MAX_MS`; nothing bounds a hand-cut list. Seth's corpus contains a
159 MB WAV, so this is not hypothetical.
