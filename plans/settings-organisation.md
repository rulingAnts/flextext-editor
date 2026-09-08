# Device settings: the audit, and the reorganisation it produced

Seth, 2026-09-09: *"do an audit of the device settings layout and organization. We added a lot of
settings and switches haphazardly. We should reimagine the tabs, groups, labels, etc to be
intuitive, easy to find, user-friendly, and the documentation to go with it."*

Then, after approving the proposal: *"I'd also like this new layout to apply to project default
settings and to unpaired device settings (though pay careful attention to which settings are
specific to unpaired devices and which settings are only applicable to paired devices)."*

**Shipped in v641.** This file is the audit that led to it and the record of what was decided.

---

## 1. What was wrong

Six flat tabs held 49 settings, and two of them held 61% of everything:

| old tab | count | what was actually in it |
|---|---|---|
| `languages` | 3 | writing systems |
| `segmentation` ("Tasks") | 18 | the mode, three tab toggles, two glossing options, keyboard behaviour, five editing permissions, and **four export formats** |
| `recording` | 7 | format and the mic chain |
| `consent` | 4 | consent |
| `sending` | 5 | sending — plus the Recorder's welcome heading, which is not about sending |
| `other` | 12 | device permissions, two Segmenter-only permissions, appearance, input behaviour, workflow |

Neither big name predicted its contents, and **a single question took two tabs to answer**:

- *What may this coworker change?* → five switches under "Tasks", five under "Other".
- *How does typing behave?* → Enter, the gloss landing box and the Cut landing under "Tasks"; the
  Space bar under "Other".

"Other" is what a group is called when nobody decided.

## 2. What shipped — 4 macro-tabs over 9 collapsible sections

Seth: *"Eight tabs might be too many. But we can change it from tabs to collapsible sections. With
maybe a small number of macro-tabs if any of those collapsible settings make sense grouped together
on one tab."* And: *"we want only one expanded at a time. If another is expanded, then others
collapse."*

| macro-tab | sections | n |
|---|---|---|
| **This device** | Languages (3) · Appearance (5) | 8 |
| **The coworker's job** | Tasks (5) · What the coworker may change (11) · Typing & keys (4) | 20 |
| **Recording & consent** | Recording (8) · Consent (4) | 12 |
| **Sending** | How work leaves (5) · What goes in the bundle (5) | 10 |

50 fields (49 + the one this audit found missing, below). Largest section 11 instead of 18; no
section called "Other". A closed section shows its name **and a one-line blurb of what is inside**,
so nine shut rows are scannable in a way six bare tab labels never were.

Moves worth naming:
- The four export formats **and** `segTimeNotes` left "Tasks" for **What goes in the bundle** —
  Seth: *"let's move the save/export settings to the sending tab (even though they're audio
  segmentation specific)."* They sit beside "How work leaves" rather than inside it: *which buttons
  may send* and *what is in the parcel* are different questions.
- `recordWelcome` left "Sending" for **Recording**, where it always belonged.
- `doneEnabled` left "Other" for **How work leaves** — marking a text done auto-uploads it.
- **Tasks** is now only the five step switches, which is the only way the name is true of all of it.

Section **ids** were renamed along with the labels. `segmentation` had been *showing* as "Tasks"
since v638 while still holding the exports, and an id that lies about its contents is exactly how
the old shape stayed invisible to the people maintaining it.

## 3. Scope — which settings mean something on which surface

Three surfaces render this table. **Two of them are the same form**: the researcher panel's
per-device settings and its project-default template both come from one `GROUPS` table through one
modal, so they cannot drift. Only the unpaired device's own Settings tab is separate code
(`SETUP_GROUPS` in `app.js`), and `device-setup.test.mjs` holds the two in lockstep.

So the scope that can actually diverge is two axes, and both are now written down in
`test/settings-layout.test.mjs`:

**Paired only — inert on a device working alone (10).** Shown there anyway, greyed, each with its
reason on tap. Nothing is hidden: a setting that vanishes when you pair a device is a setting nobody
can find twice.

| why | settings |
|---|---|
| the engine gate short-circuits (`!Sync.hasSession() \|\| settings.X === true` — a lone worker always has it, so a switch could only lie) | `allowDelete`, `deleteAllEnabled`, `allowAudioRemove`, `allowAudioSwap`, `allowBlankLines`, `allowTextEdit` |
| waits on an upload that cannot happen with no researcher Drive behind it | `autoDel`, `autoBackup`, `autoBackupMins`, `doneEnabled` |

Plus one option rather than a whole field: `sendOptions`' **Upload**.

**Unpaired only (2).** `consentAudioFile` — a picked file where the panel pushes a Drive URL; the
only field either surface has that the other lacks. And `appLang`, which is live in the panel (the
researcher pushes a language) and greyed on the device, for a UI reason rather than a pairing one:
the toolbar's own selector is the live control there, and a second one could only disagree with it.

**Per device, never a template (1).** The consent prompt's **upload button**. The audio streams into
one device's own Drive folder and mints a URL for that device, so template mode drops the button and
`validateDeviceSettings` drops the rule that would demand a URL — without which, ticking audio
consent in a template failed validation naming a field the form could not fill: a loop with no exit.
Everything else is meaningful in a template exactly as on a device, because a template *is* the
settings a new device is born with, not a different kind of object.

**Not scope, but adjacent:** the Audio Segmenter shows a much shorter Settings tab
(`SEGMENTER_SETUP_KEYS`), which after filtering has no Recording and no Consent section at all — so
"Recording & consent" is dropped entirely rather than rendered as a tab with nothing under it. No
special case; an empty tab is simply one whose sections all filtered away.

## 4. Traps found while counting

- **A gate with no switch.** `allowAudioSwapOn()` has gated the Segmenter's "swap the recording"
  button since it was written, but the setting had **no field on either surface** — so on a managed
  device it read `settings.allowAudioSwap === true` against a value nothing could ever set, and the
  button was unreachable on every paired device in the field. A gate with no switch is a feature
  that only works by accident, alone. **Fixed in v641**: it is now a switch in *What the coworker may
  change*, with the standalone caveat and both languages.
- **`archivalDefaults` is not a setting** — `type: 'action'`, a button that fills six fields. It read
  as a switch in the flat list. Relabelled **"Use archival settings"** so the row announces itself.
- **`autoDel` is displayed, `autoDelUploaded` is stored.** Deliberate and commented, but anyone
  adding `autoDel` to a pushed-settings allowlist would silently push nothing. Guarded by
  `test/settings-key-aliases.test.mjs`.
- **`consentMode` / `consentResp` are deprecated but still honoured** so devices enrolled before the
  multi-select keep their consent settings. Now carries a **review-after date (2027-09-01)** rather
  than an open-ended "do not clean up".
- **`consentAudioFile` and `consentAudioUrl`** are two keys for one idea. Correct — the device picks
  a file, the panel holds the URL, and a pushed URL always wins — but the names hide it; both the
  spec comment and the scope test now say so.
- **`panel.val.fieldAtTab` → `panel.val.fieldAtSec`.** The validation banner names where a problem
  is; it now names a *section*, so the key name and the prose say section.

## 5. Where it lives

- `researcher-panel.js` — `GROUPS` (9 sections) + `SET_TABS` (4 macro-tabs), `groupHtml` /
  `tabPanelHtml`, `wireSettingsTabs` / `showSettingsTab` / `showSettingsSection`, `TAB_OF_SEC`.
- `app.js` — `SETUP_GROUPS` + `SETUP_TABS`, `setupGroupHtml` / `setupTabPanelHtml`, `setupTabsFor`,
  `wireSetupTabs` / `showSetupTab`, `SETUP_TAB_OF_SEC`.
- `app.css` — `.rp-sec`, its summary and caret, `.rp-fs-plain`, `.rp-tabpanel`.
- `i18n.js` — `panel.tab.<id>` ×4, `panel.grp.<id>` ×9, `panel.grpNote.<id>` ×9, EN + ID.
- Tests — `device-setup.test.mjs` (the section table, the tab cover, EN+ID for every label and
  blurb), `settings-layout.test.mjs` (the scope map, the accordion, the validation targets).

## 6. Still open

- **The Segmenter's shorter list.** It now shows three macro-tabs and four sections. Worth a look on
  the device to confirm that reads as deliberate rather than truncated.
- **Contradictory / deprecated settings.** Seth, 2026-09-08: *"At some point we'll want an audit to
  detect and fix contradictory settings in researcher panel (contradictory or irrelevant/
  deprecated)."* This audit found no dead settings, but it did not look for combinations that
  contradict each other (e.g. word glossing off while the gloss landing box is "gloss").
