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

### 3.2 Receipts are the evidence; a person is an index over them

⚠ **REVISED 2026-09-08 on Seth's proposal, and it is a better model than the one this section first
carried.** The original had a person-level ConsentRecord as the authority and the per-text receipt as
a snapshot of it, which needed a precedence rule to stop the two disagreeing — the exact failure the
design exists to prevent. Seth's inversion removes the problem instead of managing it:

> *"keep the existing per-text consent system for the native-speaker side (optional), and then have
> the consent collector be a consent MANAGER where researchers can see existing consent responses and
> associate them with people names… and each speaker can have many or multiple consent
> receipts/response packages associated and saved with it."*

**The receipt is a fact about an event.** Someone was asked something, on a date, and answered. It is
already self-contained, already exported, already immutable in practice. It stays exactly as it is.

**A person is an index over receipts.** `Person → [receiptId…]`, built by association, not by capture.

**Per-text state is derived** from "does every speaker on this text have a covering receipt", and
nothing needs to be reconciled because nothing is duplicated.

```
Person  { id, name, code?, flexPersonGuid?, createdAt }
Receipt { …exactly today's consentReceipt…,               // unchanged, still per text
          personId?,                                      // ← the ONLY addition: nullable
          scope: 'thisText' | 'listed' | 'allMyRecordings',
          coversTextIds[] }                               // groupConsent already does this
Association { receiptId, personId, by, at, note? }        // logged, reversible — §3.5
```

Three things this buys, each of which was a named risk in the earlier draft:

1. **The migration stops being frightening.** §6's device-side reconciliation of free-text
   `consentSpeaker` strings, driven offline by a barely-literate user, is gone. Association happens
   in the researcher's manager, where the whole picture already is.
2. **"No second-class consent record" holds by construction.** The retrofit plan's requirement — a
   retrofitted and a natively-recorded text must be indistinguishable downstream — is satisfied
   because the receipt never changed. No precedence rule, no stale-snapshot state.
3. **Many receipts per person is what actually happens.** A speaker consents in 2024 for three
   stories, again in 2026 for eleven more, and withdraws one in between. An ordered list of receipts
   records that history; a single record with a scope flattens it and loses the middle.

#### The four states, unchanged in meaning

*consented / no record / excluded by speaker / held by researcher* — as the keeper plan and the
checklist define them. Now computed as: every speaker on the text has at least one receipt whose
scope covers it, none of that person's later receipts excludes it, and no researcher hold applies.

#### ⚠ A text can have more than one speaker, and today's model assumes it does not

Our own EAF importer exists because ELAN puts a speaker on each tier and *"a conversation (several
speaker tiers) is COLLAPSED into one time-ordered line list with speaker attributes"*. So
multi-speaker texts are already first-class in the data. **A text is consented only when EVERY
speaker on it is covered** — one speaker's yes does not clear a conversation. The per-text receipt
model cannot express that today, and the person index is what makes it expressible.

#### "Optional" needs one clarification

Seth: *"keep the existing per-text consent system for the native-speaker side (optional)"*.
⚠ Read as: **the PERSON step is optional on the device, not consent itself.** Consent capture stays
exactly as configured by the researcher today. What becomes optional is whether the coworker also
says *who* — because that is the part the manager can supply later, and the part that would otherwise
put a roster on every phone (§3.5). If it were consent itself that became optional, a coworker could
record with none at all, which is a step backwards from where the suite already is.

### 3.3 Where a person's name may and may not live

⚠ This is the rule to write down **before** the code, exactly as `d1-minimization-invariants.test.mjs`
already does for a table that does not exist yet. A person's name is at least as revealing as a text
title, and the minimisation argument refuses titles in D1.

⚠ **A person's NAME and a person's ID are different questions.** The name is what the table below
governs. The id is designed in §3.4, and it may sit in D1 — provided it is built the right way.

| may hold a person's name | may **not** |
|---|---|
| the device's own IndexedDB | any D1 column, in any form, including hashed (§3.4) |
| the E2EE inventory report (ciphertext to the server) | the crowd config (**plaintext in D1 by construction**) |
| Drive, inside the researcher's own folders | the source manifest (boolean-only, test-enforced, and immutable) |
| the bundle's `consent/` files | any provenance stamp (BACKLOG: *"nothing identifying a PERSON… a hard line"*) |

⚠ Four pressures will push against this, each looking like an improvement in the moment: a pushed
roster has to reach the device; a panel Consent card wants an index; crowd `signature` mode **already**
sends a typed name to the worker and makes it a Drive folder name; and the manifest is the obvious
place to declare who consented. **Add the guard test before the feature.**

### 3.4 Tracking speakers in D1 — the id, and what it costs

Seth, 2026-09-08: *"We need to track speakers in the D1 database, at least by guid. But ideally in a
way which can protect their identity as best as possible. Or at least have an option to do that."*

**⚠ RULE ONE: THE ID IS RANDOM, NEVER DERIVED FROM THE NAME.** The suite's existing precedent for a
revealing field is `titleHash` — an **unsalted** SHA-256 truncated to 16 hex characters
(`app.js:4227`). For a title that is arguable. **For a person's name it is not protection at all.**
The set of human names in one language community is small and enumerable, so anyone holding a dump
hashes a candidate list and matches every row in seconds. A name hash *looks* like a safeguard and
is not one, and it is exactly the construction someone would reach for by analogy with `titleHash`
without stopping to think about the difference in entropy. Use `crypto.randomUUID()`. There is
nothing to guess, so there is nothing to brute-force.

**RULE TWO: the name rides E2EE, exactly where the title already rides.** `reported_blob` is
ciphertext under Ki and the full title is already inside it, precisely because only the researcher
can open it. A person's display name goes in the same envelope. The Worker and D1 see the id and
never the name.

**RULE THREE: the id is scoped per project.** One D1 serves many researchers and many projects. A
single global person id would let a dump link the same speaker across two unrelated projects — a
correlation nobody consented to and nobody needs. Mint the id per project; the device's own roster
holds the mapping if the same human appears in two.

**RULE FOUR: the crowd recorder never gets a person id.** An anonymous contribution must not become
linkable, and the four existing anonymisation mechanisms stay exactly as they are.
⚠ **And there is a live leak to fix while we are here:** crowd `signature` mode already sends a typed
name to the Worker in plaintext (`app.js:9991`) and makes it the leading component of a Drive folder
name (`worker/src/v1.js:1788-1808`). That is real today, independent of this feature, and it will be
cited as precedent the moment someone argues for a name column. Close it or document it deliberately.

#### What a plaintext id still costs, stated plainly

A random id is not invisibility. A dump still shows **shape**: *this speaker has fourteen texts, on
that device, uploaded across these dates.* That is a social graph with the names filed off — much
less than a name, but not nothing, and it is the honest price of server-side person queries. Say so
in the settings text rather than implying the id makes a speaker untraceable.

#### The option: two privacy modes, per project

| | **Indexed** (what Seth asked for) | **Strict** (the option) |
|---|---|---|
| D1 holds | `person_id` as a plaintext column | nothing — no person row, no column |
| the name | E2EE in `reported_blob` | E2EE in `reported_blob` |
| the panel answers "show me this person's texts" | by query | by decrypting inventories client-side |
| a dump reveals | which texts share a speaker | that speakers exist |
| cost | the shape above | no server-side person query or index |

⚠ **Strict is genuinely usable at this corpus's size** — 97 texts and a few dozen people decrypt in
well under a second — so it should be a real setting, not a token one. Recommend Indexed as the
default because it is what the panel's Consent card wants, and Strict for a project where the
community's exposure matters more than the panel's speed.

#### Shape, following `drive_object` (the newest table, and the right precedent)

```sql
CREATE TABLE IF NOT EXISTS person (
  person_id  TEXT PRIMARY KEY,   -- random UUID, minted per project. NEVER derived from a name.
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);                               -- no name, no hash of a name, no demographics, ever.
CREATE INDEX IF NOT EXISTS person_project ON person(project_id);
```

The link from text to person lives on the text row when Phase C builds it, or in the E2EE inventory
until then. ⚠ Note that `project_id` on a text row is *already refused* by
`d1-minimization-invariants.test.mjs` — so the person link must not become a back door to the
grouping that rule exists to prevent. Check the two rules together before writing either table.

#### The guard test, written before the table

Extend `test/d1-minimization-invariants.test.mjs`, in the same deliberately-live-before-the-table
style it already uses for `text`:

1. no column on any table named `name`, `full_name`, `speaker`, `speaker_name`, `person_name`, or
   ending `_name_hash`;
2. no person id column on `crowd_recorder` or `crowd_submission`;
3. the id minting call is `crypto.randomUUID`, pinned by source — the assertion that stops a future
   `sha256(name)` from looking like an improvement;
4. `person` carries no demographic column (birth year, gender, ethnicity, contact — all of which the
   archives ask for and all of which belong in the researcher's own files, not here).

#### Anonymity is a procedure, not a flag

AILLA has no anonymity boolean; it has a **procedure** — an "Anonymous" person record, roles prefixed
`anonymous:`, the person dropped from the contributor list, filenames scrubbed, audible
self-introductions edited out. So a speaker who chooses anonymity should not merely set a bit: their
id should not appear where it can be correlated, and the pseudonym-to-name key belongs in a separately
access-controlled place — **IMDI's `Anonyms` pattern**, which is the right model to copy.

---

### 3.5 The five-way constraint, and why it is not actually a conflict

Seth, 2026-09-08: *"we want native speaking coworkers to be able to collect, record, and document
consent, and we need researchers to be able to easily keep track of consent by speaker, we need both
researchers to be able to see the names and consent and stories associated with them, we need it to
be compatible with lameta, and we want to protect their identities in D1 data and client devices to
minimize exposure."*

**⚠ FIRST, WHAT THE THREAT ACTUALLY IS — because the wrong answer here makes the whole design
theatre.** The coworker is not the threat. They are in the village, they know the speaker, they are
holding the microphone. Hiding a name from the person conducting the interview protects nobody and
breaks the work. **The threat is aggregation**: one place where every speaker, every story and every
consent decision joins up in the clear, and one loss that hands over a whole community's register
rather than one worker's fortnight.

So the principle is not *hide names*. It is: **a name exists at the two ends of the pipeline and
nowhere in the middle, and neither end holds more of them than its job requires.**

| who | holds | why that is the minimum |
|---|---|---|
| **coworker's device** | the names of the speakers **that device itself recorded** | they cannot ask a person for consent without knowing who they are asking |
| **transport (worker, D1)** | a random per-project UUID and nothing else | §3.4 |
| **researcher's panel** | every name, decrypted under their own key | they are the ones keeping track by speaker |
| **the lameta bundle** | names, as `People/<Name>/` | produced on the researcher's machine, at the end |

Every constraint Seth listed is satisfied by that table, and none of them collide. The apparent
conflict comes entirely from one assumption worth dropping — see below.

#### The assumption to drop: pushing the project roster to devices

The keeper plan says the collector offers *"a person chosen from a list the researcher pushed to the
device"*. ⚠ **That is the single biggest exposure in the whole design, and it buys very little.** It
puts every speaker in the project on every phone — so a phone lost in one village exposes the people
of every other village the project works in, none of whom that coworker has ever met.

Instead: **the device mints a person locally when the coworker types a new name, and uploads the
UUID with the name E2EE.** The researcher's panel then sees *"Kologwoi Suhu — new person"* and either
accepts it or merges it into an existing record. Reconciliation happens where the whole picture
already is. A researcher may still push a **shortlist** for a specific assignment ("these four
people, for this village"), which is the useful part of the pushed roster without the rest of it.

Cost: duplicates until a researcher merges them. That is a chore for one person with the full view,
not a corpus-wide standing exposure. It is the right trade.

#### Device-side protection is scope, not encryption

⚠ **Encrypting the name field on the device while the recording sits beside it in the clear would be
theatre.** On a field phone the audio *is* the identity: anyone who knows the speaker recognises the
voice, and the consent clip is literally a recording of them saying their name. Claiming "names are
encrypted at rest" would be a security claim that is 90% false, which
`drive-as-truth.md:539-541` already forbids in as many words.

What actually reduces what a lost phone gives up, in order of effect:
1. **Scope** — the device holds only its own speakers (above). This is the whole of the protection.
2. **Remote wipe**, which already exists and must include the person store and the person-keyed
   consent media from the first commit, not as a follow-up.
3. **Getting `consentSpeaker` off the device-only island** (§6) so a wipe is recoverable rather than
   a loss.

#### Two researchers seeing the same names: already solved, no new plumbing

`member_key.wrapped_ki` is the per-instance key Ki **RSA-wrapped to each grantee researcher's public
key and opaque to the worker**. A second researcher on the project already receives Ki without the
server ever holding it, and already decrypts the inventory that carries titles. Person names ride in
that same envelope. ⚠ **Do not invent a second sharing mechanism for people** — the caps model in
`project_member` (`see: all | [instanceId…]`) is also already the right place to say which researcher
may see which devices' speakers.

#### The in-house precedent that settles §3.4's rule one

The schema already distinguishes the two cases, and got it right:

- `researcher.email_sha256` — **`HMAC(SERVER_HMAC_KEY, email)`**, commented *"enumeration-safe"*.
- `titleHash` — a **plain, unsalted** SHA-256.

An email is enumerable, so it gets an HMAC under a server-held key; a title is not, so a plain hash
is fine. **A person's name is enumerable** — more so than an email, since the candidate list is one
village. It therefore falls on the `email_sha256` side of a line this codebase already drew. §3.4's
rule stands on the project's own reasoning, not on an outside argument: **random UUID, or nothing.**

#### Merging two people is a rights-bearing operation

Merging person records merges their consent records — scopes, exclusions and all. It must be
explicit, researcher-side, logged with who did it and when, and **reversible**, for the same reason
exclusions are added rather than deleted (§3.2): the history is the evidence. A silent
de-duplication that quietly widens one person's consent to another person's texts is the worst bug
this system could have.

#### What this costs, honestly

A dump of D1 still shows shape (§3.4). A lost phone still gives up the speakers that phone worked
with, and their recordings. A researcher's laptop holds everything, because that is the job — and it
is therefore the thing worth protecting with disk encryption and a screen lock, which is a policy
sentence in the deployment notes, not a feature.

---

### 3.6 The Consent Manager, and an assignable collector

Seth's second proposal, and it changes what the Consent Collector *is*:

> *"have the consent collector/manager app be something we CAN assign to native speaker colleagues.
> And that app would have a list of speakers and texts from those speakers that the researcher needs
> consent for that the user can then collect and record."*

**Two faces of one app, decided by who is signed in — the suite already works this way.**

**Face 1 — the researcher's manager.** Its main view is *an inbox of receipts with no person yet*,
because that is the daily reality: consent arrives from devices attached to texts, and someone has to
say who gave it. Association is one click, reversible, and logged. Beside it: a person's card showing
their receipts in date order and the four states across their texts, which is the "keep track of
consent by speaker" Seth asked for. Exclusions and holds are entered here, never on a device.

**Face 2 — an assigned worklist.** A researcher assigns *"these people, these texts, please collect
consent"* to a colleague's device. ⚠ **This is the right answer to a question the whole plan has been
circling: who should do the asking.** A native-speaking colleague usually should — same language,
same community, already trusted, and able to explain what an archive is in terms that land. SIL's own
requirement is consent *"in a form and language that the subject understands"*, and a colleague
asking in Fayu satisfies that far better than a form asking in Indonesian.

**The worklist is the scoped roster §3.5 argued for, arriving by a better route.** It carries only
the people that assignment needs, it is per-assignment rather than project-wide, and ⚠ **it must be
removable when the assignment closes** — the same discipline as the pushed roster, but bounded by a
task rather than standing forever. That resolves decision 6 in Seth's favour without the exposure:
not "no roster ever", but "a roster the size of one job".

#### What the assigned collector must not become

⚠ It must not display **other people's** consent decisions. A worklist says *ask these people about
these texts*; it does not say *and here is what everyone else in the project already answered*. The
`project_member.caps` model (`see: all | [instanceId…]`) is where that boundary is already expressed
for researchers, and the device side needs the same idea.

### 3.7 Speaker folders in the project

Seth: *"We might need speaker folders in our project folder system somehow."* Yes — and lameta has
already chosen the layout for us:

```
<Project>/People/<Name>/<Name>_Consent.<ext>
```

That is precisely what lameta detects (a file whose path contains `Consent` in the person's folder),
so writing it means the keeper's Receive step files it with no renaming. With many receipts per
person (§3.2) the folder holds a series — `<Name>_Consent_2026-09-08.wav` and its `.json` twin — and
lameta still sees a consented person because its check is a substring, not a filename match.

Three things to get right:

1. ⚠ **A folder name is a name in the clear — and that is fine here, because this is the
   researcher's own Drive.** The constraint in §3.3 was about D1 and about devices. Being explicit
   about the difference is what stops someone "fixing" this later, or citing it as precedent for a
   name column.
2. ⚠ **This is a new tree, not a change to the text manifest.** The manifest is immutable by design
   and boolean-only about consent by test; person folders must not touch it. They are discovered by
   listing `People/`, the same way lameta discovers them.
3. **A person folder is where a receipt with no text can live** — the Consent Collector can already
   import a recording with no text, and a person may give consent covering work not yet recorded.

---

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

⚠ **REVISED 2026-09-08.** §3.2's inversion removes the frightening half of this section: there is no
longer a device-side reconciliation driven by a barely-literate user offline. Association happens in
the researcher's manager. What remains below is still true and still worth doing, but it is now a
convenience rather than a rescue.

⚠ **Every speaker name typed into the Consent Collector exists only in that phone's IndexedDB.**
`consentSpeaker` is in no export, no upload, no manifest, no inventory, and not even in
`uploadContentSig` — so editing it does not mark the text as changed. There is no server copy to
migrate from. The reconciliation has to run **on each device, offline, driven by a barely-literate
user**, and if a device is wiped first the mapping is gone.

Consequences for the plan:
1. **The researcher's manager does the reconciliation**, not the device (§3.6). `consentSpeaker`
   becomes a *hint* shown beside an unassociated receipt — "the coworker typed: Kologwoi" — which is
   exactly what a human needs to associate it correctly, and needs no normalisation, no matching
   heuristic and no offline UI. Free-text matching was never going to work anyway: `Kologwoi` and
   `kologwoi ` are two strings and one person.
2. **Make `consentSpeaker` survivable first.** Getting it into the E2EE inventory is a small change and
   turns an unrecoverable loss into a recoverable one. Do it in phase 1 even though nothing consumes
   it yet.
3. Keep `consentClip` per text for backward compatibility (keeper plan says so explicitly).

---

## 7. Order of work

**Phase 1 — stop the bleeding, add nothing.** `consentSpeaker` into the E2EE inventory so it can no
longer be lost. The D1/manifest guard tests from §3.3 **and §3.4**, written before any person code —
including the assertion that the person id is minted by `crypto.randomUUID` and never derived from a
name. Close or document the crowd signature-name leak (§3.4 rule four). Retire or
harvest `corpus-manager/PLAN.md` (838 lines specifying an *incompatible* audience-tier model; it holds
the only written treatment of researcher-side tiers, and corpus-keeper supersedes it on nearly every
other point).

**Phase 2 — the manager, and nothing on the device.** Person store and the association inbox in the
researcher's panel (§3.6 face 1); `consentSpeaker` surfaced as a hint beside each unassociated
receipt; association logged and reversible; the D1 `person` table and the Indexed/Strict setting
(§3.4), with the name E2EE from the first commit. **The capture side does not change at all in this
phase** — which is what makes it shippable without touching a field device. The D1 `person` table and the Indexed/Strict project setting
(§3.4); the name rides E2EE from the first commit, never as a column to be removed later. The Consent Collector's grouping key changes from a trimmed
string to a person id — everything else in its group-ask flow is already right.

**Phase 3 — scope, exclusions, and the four states.** Receipt gains `personId`, `scope`,
`coversTextIds` and `scriptVersion` — all additive, the way `responseTypes` was. Exclusions and holds
in the manager. The four states surface in the panel and the checklist, computed per §3.2 — including
the multi-speaker rule, which is where a conversation stops counting as consented on one person's yes.

**Phase 3b — the assignable collector** (§3.6 face 2): the worklist, its removal when the assignment
closes, and the boundary that keeps one colleague from seeing another's answers. Speaker folders
(§3.7) land here, since this is the first phase that produces receipts not tied to a text.

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
6. **The pushed roster: resolved, pending your nod.** §3.6's worklist is the middle path — not a
   project-wide roster on every phone, and not nothing, but a roster the size of one assignment that
   goes away when the job is done. This still narrows the keeper plan's line, so confirm it.
7. **The default privacy mode** (§3.4): Indexed gives the panel a fast Consent card and lets a dump
   show which texts share a speaker; Strict keeps D1 person-free and makes the panel decrypt
   client-side, which is fast enough at this corpus's size. Recommendation is Indexed by default,
   Strict available per project — but the default is a community-exposure call, not a technical one.
