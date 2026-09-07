# Person-based consent, and a wider question set

> **Status: PLAN, not started.** Written 2026-09-07 at Seth's request — *"get our updated, person-based
> consent system in our app suite (for interoperability with corpus keeper/checklist, lameta, and
> FLEx) revamped. Also if the specific questions and prompts and responses we allow the researcher to
> set need more available options to cover the range of things academic and humanitarian
> organizations and archives often require, we should make a plan for that."*
>
> The per-person decision itself was already taken on 2026-09-06 and lives in
> `corpus-keeper/plans/corpus-keeper.md` §"Changes to the FLExText suite". **This document does not
> re-decide it.** It is the suite's side: what exists today, what the outside world actually
> requires, the model, the question bank, and the order to build it in.

---

## 0. The two answers, up front

**Yes, the question set needs widening — but not by adding fields to a form.** The suite asks one
question today. Archives, funders and ethics regimes between them ask about forty different things,
and *no two of them ask the same set*. The fix is a **researcher-configurable question bank** with
sensible defaults, not a longer fixed form. §4.

**And the revamp is bigger than "attach consent to a person".** The current record does not evidence
what an archive means by consent at all. §1.

⚠ **The requirement that actually binds this project is SIL's, and it is the strictest of the six:**
consent "in a form and language that the subject understands", recorded oral signature explicitly
permitted, permanently archived, and the participant told of their right to limit access. A single
free-text prompt plus a tick box reading *"Yes — I have permission"* does not obviously meet it. That
is the same conclusion §1 reaches from our code, and the one Indonesia's PDP Art. 22 reaches from the
law.

---

## 1. What we have today, stated honestly

**The tick box says "Yes — I have permission."** (`docs/index.html:401`, `consent.yes`.) The settings
call it *"a written reminder shown to the coworker"*. So what a receipt evidences is **a field
worker's attestation that permission exists** — not the speaker's own informed consent. The optional
recorded assent and typed signature are the only parts that come from the speaker, and both are off
by default. This is the single largest gap, and no amount of person-modelling fixes it on its own.

**Consent is per text, and there is no person anywhere in the suite.** Verified: no person, people,
participant or contributor structure exists in `docs/js/`, `worker/src/`, or D1. A doc carries
`consentSpeaker` (free-text string), `consentReceipt`, `consentClip`, `consentPromptClip`.

**Three unconnected notions of "speaker", joined by nothing:**

| notion | where | fate |
|---|---|---|
| `consentSpeaker` | doc record; written only by the Consent Collector's row input | **never leaves the device** — not in any export, upload, manifest or inventory |
| `receipt.signatureName` | inside a receipt, only when the signature confirmation is on | exported; in crowd mode reaches the worker in plaintext |
| `seg.speaker` | per phrase, written by the EAF/SFM/CSV importers | **dropped** by `serializeFlextext` |

**One question, no structure.** One free-text prompt, optional prompt audio, one blanket yes as any of
tick / recorded / signature. No purpose, no media distinction, no audience, no attribution choice, no
expiry, no withdrawal, no minor or guardian, no witness, no script version.

**What already works and must be kept.** The receipt is additive by design and both renderers tolerate
absent fields. The prompt audio is *frozen per text* so the question and the answer stay paired — that
instinct is exactly right and §4.4 generalises it. The Consent Collector's group-ask (one person, many
texts) is already the correct shape. The manifest records **that** consent exists and never what it
says, and a test enforces it (`test/source-manifest.test.mjs:62-70`). Crowd receipts are
person-free by four separate mechanisms, and must stay so.

---

## 2. What the outside world actually requires

Researched from primary sources 2026-09-07. Full findings in the session transcript; the load-bearing
conclusions:

**There is no cross-archive consent standard.** DELAMAN's *Minimal Checklist*, the nearest thing to a
shared baseline, has one access item and says nothing about consent. The archives differ at the root:

| archive | what the binding document actually asks for |
|---|---|
| **PARADISEC** | a rights warranty plus *the depositor's understanding of community attitudes*. **No individual consent evidence, no consent forms.** |
| **TLA / DoBeS** | the depositor *declares* informed consent was obtained; forms stay with the depositor. Deposit submission must include a blank consent form **"or describe any alternative consent procedures"**. |
| **ELAR** | publishes no consent requirement. lameta (which ELAR co-maintains) bundles consent files as a `ConsentDocuments` session at access `S` — ⚠ that shows intent, but whether the files actually reach ELAR is **not publicly documented**. Strongly indicated, not established. |
| **AILLA** | consent is the depositor's responsibility for everyone who participated; has an explicit state for material restricted *because consent could not be obtained*. Consent documents are deposited and then **deliberately kept dark** — retained by AILLA, never added to the repository. |
| **SIL (REAP)** | ⚠ **the strictest of the six, and the one that actually binds this project.** Consent recorded "on paper or other appropriate media", permanently archived with SIL, **"in a form and language that the subject understands"**, with participants told of their right to limit access. A digitally recorded **"oral signature"** is explicitly permitted, with an English transcription. Group or leader consent is an accepted fallback. |

**Consent evidence splits five ways.** Deposited but kept dark (AILLA) · deposited inside the package
(SIL/SayMore) · deposited openly as a catalogued item, including 48 kHz recordings of spoken consent
(Kaipuleohone, by depositor practice) · tracked locally, transfer undocumented (ELAR) · blank template
only, executed forms never collected (TLA) · not required at all (PARADISEC).

⚠ **Therefore: do not model one archive.** A fixed question set copied from any of them is wrong for
the other three. This is the argument for a configurable bank, and it is not a preference.

**Access tiers converge loosely; three shapes cover everything.** Open / registered / by-request, plus
a time limit that auto-opens. The checklist's Public / Restricted / Closed maps cleanly. Everything
travels as one of two LDaC values, `ldac:OpenAccess` or `ldac:AuthorizedAccess`.

⚠ **Embargo is not a universal field, and a single `embargo_until` will silently mislead half the
targets.** AILLA has a dedicated date **capped at 5 years**; Kaipuleohone has a real lift-date; TLA a
per-rule expiry; PARADISEC only *prose*; **ELAR and SIL/REAP have no embargo mechanism at all.** Model
it as *supported / date / prose / unsupported* per target.

⚠ **AILLA's current tiers are `PUBLIC` / `LOGIN REQUIRED` / `EMBARGOED` / `RESTRICTED`**, set per Set;
the Level 1 / Password / Time Limit / Depositor-control scheme is retired — and is still what lameta
ships. **Two of lameta's archive vocabularies (AILLA and TLA) are stale today.** That is the evidence
for §5's rule: derive the archive code, never store it. Also AILLA-specific: public materials must
meet **WCAG 2.1 AA**, and **all metadata is public even when the media are restricted.**

**Withdrawal is not deletion, anywhere, and only one archive tells a speaker how to ask.** PARADISEC's
takedown principle explicitly invites speakers with a connection to a recording to make contact; SIL
curators can hide from view; Kaipuleohone's tombstone vocabulary is **author-centred, not
speaker-centred**; ELAR and AILLA publish nothing. The Language
Archive's own trust-seal assessment states it has *no policy to deaccession*. CIOMS, coming from
health research, expects destruction — and that is the one requirement archives decline, using the
GDPR archiving carve-out. ⚠ **A consent script that promises deletion promises what no archive will
honour.** Promise what is deliverable: *you can ask us to close this to the public at any time*.

**Oral consent is squarely legitimate, and better supported than we assumed.** EDPB 05/2020 ¶77/¶79
accepts a recorded oral statement, and ¶109 accepts one as *explicit* consent. Indonesia's PDP Law
Art. 22 allows recorded, non-written consent. CIOMS G9 requires it be documented and certified by the
person obtaining it *or* a witness. Helsinki ¶26 requires formal witnessing. ELAR's own guidance says
audio consent *"may be a better method than written consent"*.
⚠ **But the information must precede the yes** (EDPB ¶77) — for spoken assent the explanation has to
be *on the recording, before the answer*. Our frozen-prompt design already satisfies this; keep it.

**One genuine standard exists for the record itself: ISO/IEC TS 27560:2023**, *Consent record
information structure* (built on the Kantara Consent Receipt). It gives us a lifecycle —
*Requested → Given → Renewed → Withdrawn / Expired / Invalidated* — and a field list. We should borrow
its shape rather than invent one.

**Two gaps we can be ahead of, rather than behind.** No archive publishes what metadata should
accompany a **recorded oral consent** — which is precisely our situation. And none states who may
authorise access after a **speaker** dies; the funder-level answer (ELDP, PARADISEC) is a nominated
delegate for the *depositor*, not the speaker. §4.3 Q23 and Q35 are where we answer both.

**GDPR probably does not bind the capture** (Art. 3: Papuan speakers in Papua are not in the Union);
it reaches us through a European host archive, funder or collaborator. Indonesia's PDP Law does bind
it, sorts sensitivity differently (biometric and children are sensitive; ethnic origin is not a
category), and Art. 21 requires the consent text to state purpose, data types, **retention period**
and rights. ⚠ Do not over-engineer for GDPR, but keep the record capable of satisfying it, because
the deposit target decides which regime applies.

---

## 3. The model

### 3.1 Person

A new entity. Minimum:

```
Person { id, name, code?, flexPersonGuid?, createdAt, note? }
```

⚠ **The id is not the name.** lameta learned this the hard way: its `code` field silently overrides
`name` as the reference id everywhere, so a rename is a re-identification. Ours is a stable opaque id
from the start; the name is a label.

Stored per project, on the device. Pushable from the panel as a roster (from FLEx People via the
keeper), and **always typeable offline as a new name** — a field worker with no signal must never be
blocked. That is the keeper plan's own provision, and DEVELOPERS.md's offline rule.

### 3.2 Consent record

Per person, not per text. Shape (ISO 27560's skeleton, our fields):

```
ConsentRecord {
  id, personId, state,                        // Requested|Given|Renewed|Withdrawn|Expired|Invalidated
  supersedes?,                                // the record this replaces — never overwrite, always chain
  scope: 'all' | 'listed', textIds[],         // corpus-keeper's model
  exclusions: [{ textId, date, howExpressed }],
  answers: { <questionId>: <answer> },        // §4
  script: { id, version, lang, renderedText, promptAudioKey },   // what was actually asked
  evidence: { types[], clipKey?, signatureName?, mark?, witness?, collectedBy },
  audit: { timestamp, timezone, deviceId, app, interfaceLang, ipAddress?, approxLocation? }
}
```

**A text is consented** when its speaker has a record, the text is in scope, not excluded, and not
held by the researcher. Four named states — *consented / no record / excluded by speaker / held by
researcher* — exactly as the keeper plan and the checklist define them.

⚠ **The per-text outcome is derived, never stored** (keeper plan) — *and yet* every text must still
carry a self-contained receipt copy, because `consent-retrofit-and-segmentation-apps.md:19-21`
requires that a retrofitted and a natively-recorded text be indistinguishable downstream. These
reconcile only with an explicit precedence rule, and getting it wrong produces the exact failure the
design exists to prevent — a text that reads consented in one tool and withheld in another. **The
rule: the person record is authoritative; the per-text receipt is a snapshot carrying the record id
and its version. On any disagreement the record wins, and the tool says the snapshot is stale.**

### 3.3 Where a person's name may and may not live

⚠ This is the rule to write down **before** the code, exactly as `d1-minimization-invariants.test.mjs`
already does for a table that does not exist yet. A person's name is at least as revealing as a text
title, and the minimisation argument refuses titles in D1.

| may hold a person's name | may **not** |
|---|---|
| the device's own IndexedDB | any D1 column |
| the E2EE inventory report (ciphertext to the server) | the crowd config (**plaintext in D1 by construction**) |
| Drive, inside the researcher's own folders | the source manifest (boolean-only, test-enforced, and immutable) |
| the bundle's `consent/` files | any provenance stamp (BACKLOG: *"nothing identifying a PERSON… a hard line"*) |

⚠ Four pressures will push against this, each looking like an improvement in the moment: a pushed
roster has to reach the device; a panel Consent card wants an index; crowd `signature` mode **already**
sends a typed name to the worker and makes it a Drive folder name; and the manifest is the obvious
place to declare who consented. **Add the guard test before the feature.**

---

## 4. The question bank

### 4.1 Shape

A **bank of question types** the researcher switches on, orders and words, not a fixed form. Each
question carries: `id`, answer shape (`bool | one-of | many-of | text | date | person-ref | duration`),
the researcher's own wording, optional recorded audio of that wording, and whether it is required.
Default profile: a short set that is defensible everywhere (§4.5). Named profiles per archive can come
later; the bank is what makes them possible.

⚠ **Every question must be answerable by someone who cannot read, has never seen the internet, and is
being asked through an interpreter.** That is the whole audience for the recorder and the collector.
A question that cannot be asked aloud in one breath does not belong in the default profile.

### 4.2 Groups

**A. Identity and attribution.** May we name you as a contributor? Name, pseudonym, or anonymous —
and if pseudonym, which? Your role in this recording. May your contact details be shown to users?

⚠ **Role vocabularies never match:** 15 (SIL RAMP) / 21 (IMDI) / 22 (PARADISEC) / 24 (OLAC and LDaC) /
28 (Kaipuleohone) / 31 (AILLA). Store our own answer and project it — the same rule as access codes.
⚠ **Anonymity is modelled three incompatible ways.** IMDI/TLA has a real `Anonymized` boolean. **AILLA
has no flag but a procedure** — an "Anonymous" person record, roles prefixed `anonymous:`, the person
dropped from Contributors, filenames scrubbed, audible self-introductions edited out. ELAR/lameta and
SIL have neither, only a `code` substituting for the name. Anonymity is *work*, not a checkbox: the
answer we capture has to drive a procedure, not merely set a flag.

**B. Media.** Audio, video, photograph, transcript and translation are **separate permissions**.
Seyfeddinipur et al. are explicit that restrictions attach differently by format; a speaker may be
happy for the transcript and not the recording.

**C. Purpose.** Research and analysis; archiving with a long-term repository (with *what an archive
is* explained — Bowern's form literally parenthesises "(explain archive)"); academic publication;
teaching; publication on the public web; community and translation work; reuse for a purpose not
foreseen; commercial use (DOBES treats this as a **community** decision, not an individual one);
derivative works; and — not in any source, but ours to decide — machine-learning use, which under
GDPR changes the data's legal character the moment it is used to identify a speaker.

**D. Audience — a ladder, not a tier code.** *Nobody / only the researcher / named individuals /
family / the community / community and researchers / registered users / everyone.* Robinson's ladder
is answerable without literacy and maps onto every archive tier. Two questions ride with it: **must
they ask first?** and ⚠ **who do they ask?** — a *name*, not a flag. ELAR's `S`, AILLA's Level 4 and
PARADISEC's nominated contact all need that name, and **no metadata standard has a field for it.**

**E. Time.** Open now, or closed until a date (AILLA Level 3's auto-open is the pattern). A **review
date** — when should this be asked again (LDaC has `ldac:reviewDate`; EDPB ¶110 expects refreshing).
Retention of the consent record itself (PDP Art. 21 requires stating it).

**F. Withdrawal.** The right to stop at any time without a reason is always true and always stated.
What withdrawal will actually do is a **choice among deliverable outcomes** — close to the public,
embargo, take down — ⚠ **never "delete"**. And the route for asking, recorded as a contact.

**G. Capacity and authority.** ⚠ **Not one of the six archives publishes any rule on minors, assent
or guardians** — a guardian field puts us ahead of all of them, with nothing to map onto.
Is the speaker a minor (PDP Art. 25 makes children's data sensitive)?
Guardian identity and relationship. Community-level agreement, and from whom. ⚠ **CIOMS G9: a
community leader's permission never substitutes for individual consent** — so these are *two records*,
not one field. Succession: who decides about this material if the depositor is gone.

**H. Evidence of the act.** How consent was expressed (tick / spoken / drawn mark / written — all four
recognised by EDPB, UNHCR and PDP). Who explained it and who collected it. Witness, if used. The
language of the explanation. The **exact information given, versioned and snapshotted**. Timestamp and
lifecycle state. And a free-text *"anything else you want to restrict"*, which is where Bowern's own
form ends.

⚠ **Not a fingerprint.** ICRC §3.2.7 warns that taking a fingerprint solely to confirm consent may
itself be biometric collection. A drawn mark or a cross is safe; a thumbprint is not a neutral
substitute for a signature, whatever clinical practice does.

### 4.3 The two questions no standard has a home for

Q23 *who do they ask?* and Q35 *who decides if you are gone?* are the two the archives most need and
least specify. Both are `person-ref`. Capturing them well is where this system can be genuinely ahead
of the field rather than merely compliant.

### 4.4 Snapshot the question, not a pointer to it

⚠ EDPB ¶108 is explicit that showing a correct *current* configuration is not enough — you must retain
the information **as presented at the time**. We already freeze the prompt audio per text for exactly
this reason. Generalise it: version the script, store the rendered wording, store the language, keep
the audio. A receipt that points at today's settings proves nothing about what was asked last year.

### 4.5 The default profile

Short enough to ask aloud, defensible at every archive surveyed: attribution choice (name / pseudonym
/ anonymous) · media covered · archiving and publication purposes · the audience ladder with *who do
they ask* · closed-until date if any · withdrawal route · how consent was expressed · the script's
language and version. Everything else ships **off**, available to switch on.

---

## 5. Interoperability

**lameta.** Its entire consent model is a filename convention: a file whose path contains `Consent`
in `People/<Name>/`, surfaced as a computed boolean. There is **no consent field, no date, no scope,
no access on a Person**. So:
- write `consent/<Name>_Consent.wav` + `<Name>_Consent.json` in the bundle — the names lameta expects,
  so the keeper's Receive step files them without renaming (already in the keeper plan);
- carry the structured record into IMDI as `<Key Name="…">` pairs inside the Actor — the *only*
  extension point, and the one lameta already uses for custom Person fields;
- ⚠ know what does not survive: lameta's RO-Crate export **drops all custom Person fields** on purpose,
  and **hardcodes `Anonymized` to `false`**. Anonymity and structured consent do not travel that path
  today. Do not design as if they do.
- ⚠ **lameta's shipped archive vocabularies go stale** — both its AILLA and its TLA tier lists are
  currently behind those archives' own published schemes. Treat lameta as a transport, never as the
  authority on an archive's tiers.
- copy, don't invent: **IMDI's `Anonyms` pattern** — the pseudonym-to-real-name key as a separate
  resource with *its own access block* — is the right way to hold a pseudonym mapping.

**FLEx.** Verified against real exports: there is **no speaker attribute and no person element** in
flextext v3 as FLEx emits it. Seth's own 97 archived texts carry only a title. The repo's
`TextCorpus.flextext` does carry `<item type="source">` with values mixing speaker initials and
notebook references (`Kologwoi Suhu`, `SJ1.129-131`) — so **export settings differ, and re-exporting
from FLEx with source/researcher enabled may recover attribution FLEx already knows**. Worth checking
before hand-building a roster.
The keeper plan's move stands: write the `speaker="…"` phrase attribute on export; FLEx's *import*
turns names into `CmPerson`, which is what makes lameta participants derive rather than get retyped.
⚠ FLEx `CmPerson` has no consent field and no custom fields on people — **FLEx is not asked to hold
any of this.**

**Corpus checklist.** Already has the `consent` step, the `png-consent` rule (*"Written signature or
recorded oral agreement. An SIL International requirement for archiving."*), an `access` facet of
Public / Restricted / Closed, and `consentHold` — which is **read-only in the shipped app**: every
occurrence is a read or an import, there is no setter. The four states in §3.2 are what the checklist
should display; the hold is the researcher's narrowing power and needs a UI.
⚠ Its export is **not redacted** (only the Report is), by its own admission. A person-based system
makes that gap sharper, not softer.

**Corpus keeper.** This plan is its suite-side half. Nothing here contradicts it; §3.2's precedence
rule and §4 are the parts it left open.

---

## 6. Migration — and the one thing that cannot be recovered

⚠ **Every speaker name typed into the Consent Collector exists only in that phone's IndexedDB.**
`consentSpeaker` is in no export, no upload, no manifest, no inventory, and not even in
`uploadContentSig` — so editing it does not mark the text as changed. There is no server copy to
migrate from. The reconciliation has to run **on each device, offline, driven by a barely-literate
user**, and if a device is wiped first the mapping is gone.

Consequences for the plan:
1. **Ship a device-side reconciliation before anything depends on person ids** — a screen that lists
   the distinct `consentSpeaker` strings and offers "these are the same person" plus "this is
   <roster person>". Free-text matching is unnormalised today: `Kologwoi` and `kologwoi ` are two
   people.
2. **Make `consentSpeaker` survivable first.** Getting it into the E2EE inventory is a small change and
   turns an unrecoverable loss into a recoverable one. Do it in phase 1 even though nothing consumes
   it yet.
3. Keep `consentClip` per text for backward compatibility (keeper plan says so explicitly).

---

## 7. Order of work

**Phase 1 — stop the bleeding, add nothing.** `consentSpeaker` into the E2EE inventory so it can no
longer be lost. The D1/manifest guard test from §3.3, written before any person code. Retire or
harvest `corpus-manager/PLAN.md` (838 lines specifying an *incompatible* audience-tier model; it holds
the only written treatment of researcher-side tiers, and corpus-keeper supersedes it on nearly every
other point).

**Phase 2 — the Person entity and the roster.** Person store, panel-pushable roster, offline typing,
the device-side reconciliation screen. The Consent Collector's grouping key changes from a trimmed
string to a person id — everything else in its group-ask flow is already right.

**Phase 3 — the consent record.** The lifecycle, scope, exclusions, supersession chain. Receipt gains
`personId`, `personName`, `flexPersonGuid`, `scope`, `recordId`, `scriptVersion` — all additive, the
way `responseTypes` was. The four states surface in the panel and the checklist.

**Phase 4 — the question bank.** Bank, default profile, per-question wording and audio, the snapshot
discipline of §4.4. This is the phase that answers Seth's second question and it is deliberately last:
it is worth little until there is a person to attach the answers to.

**Phase 5 — interop out.** `consent/<Name>_Consent.*` in bundles; IMDI `Key` pairs; the `speaker`
phrase attribute on flextext export; the access-tier projection (speaker's answer → archive code →
LDaC value, derived not stored).

**Not in scope, deliberately:** re-consenting the existing 97 texts. That is fieldwork, not software,
and the software's job is to make it possible and to record it faithfully when it happens.

---

## 8. Decisions Seth needs to make

1. **Does the tick box change?** Today it says *"Yes — I have permission"* (a worker's attestation).
   Archive-grade consent is the speaker's own. Options: keep both as separate evidence types; retire
   the attestation; or make the attestation valid only when paired with a recorded assent. **This is
   the biggest single call in the plan** and everything in §4.2-H depends on it.
2. **The default withdrawal promise.** "Close to the public on request" is deliverable. Anything
   stronger is not. Confirm the wording.
3. **Legacy material with no consent.** The field genuinely has not converged — Seyfeddinipur et al.
   (28 authors) say publish by default with disclosure and honour takedown; Musgrave & Thieberger ask
   whether restrictions should persist until someone with authority lifts them. Our default matters
   for 97 texts.
4. **Machine-learning use** as a question — nobody else asks it yet; do we?
5. **Retire or harvest `corpus-manager/PLAN.md`.**
