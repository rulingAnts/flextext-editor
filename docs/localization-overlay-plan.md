# In-app localization editing — design (PLAN ONLY, not built)

Seth, 2026-08-07: *"The gold standard would be a way for [an experienced Indonesian translator] to
click a link and suggest translation fixes in place while he's using the app, and to have those
immediately changed and effective on production right away… a localization table in D1… delegate
users as authorized localization admins… one or more per language… and use hashes for their e-mail
address, or match the Google OAuth account… possibly adding optional (buried) Google OAuth login."*

This is the design. Nothing here is implemented.

---

## The one decision everything else follows from: OVERLAY, NOT SOURCE

**`docs/js/i18n.js` stays the source of truth and stays precached. D1 holds only OVERRIDES.**

The instinct is to move the strings into D1 and serve them. That would break the thing this suite
exists for. The engine is precached by four service workers and the app has to come up **fully
usable on a device that has never had network since install** — a field worker in a village opens it
and every label is there. Strings fetched at runtime cannot give that; a bundled file with a cached
overlay can.

So resolution order in `t()` becomes:

```
overlay[lang][key]  →  S[lang][key]  →  S.en[key]  →  key
```

Three consequences worth stating, because each kills a tempting shortcut:

- **The overlay is never required.** Empty overlay = today's behaviour, exactly. Network down, D1
  down, worker down, user never signed in: the app is unchanged. This is what makes the feature
  safe to ship at all.
- **An overlay can never unlock a language.** `LANG_COMPLETE` keeps computing from the BUNDLED
  dictionaries only. Otherwise a half-finished remote edit could put a broken language in the picker
  on every device at once, and the gating rule Seth asked for would be decorative.
- **Overrides eventually come home.** The overlay is a fast path for fixes, not a parallel
  translation system. A periodic job (or a person) folds accepted overrides back into `i18n.js`, and
  `--apply` in `tools/i18n-todo.mjs` already refuses to clobber, so the merge is mechanical.

---

## ⚠ THE SECURITY PROBLEM THAT MUST BE SOLVED FIRST

`applyI18n()` today does:

```js
for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
```

The comment above it says *"trusted static strings only"* — true today, because every string ships
in the repo. **The moment a string can come from D1, `data-i18n-html` is a stored-XSS sink**, and
the attacker is an account we deliberately handed edit rights to, on a page that holds unpublished
field data and (in the panel) researcher credentials.

Non-negotiable, and cheap:

1. **Overlay values NEVER reach `innerHTML`.** `t()` gains an internal flag for "this value came
   from the overlay"; `data-i18n-html` falls back to the BUNDLED string when an override exists.
   The handful of keys that genuinely need markup are the ones least likely to need a field fix.
2. Server-side, reject any override containing `<`, or matching `javascript:` / `on\w+=`.
3. Better still, retire `data-i18n-html`: replace the ~dozen sites with explicit element
   construction so no i18n path touches `innerHTML` at all. Larger change, permanently safer.

---

## Schema (D1)

```sql
CREATE TABLE l10n_override (
  lang        TEXT NOT NULL,          -- 'id', 'tpi' — matches i18n.js block names (2-3 letters)
  key         TEXT NOT NULL,          -- 'tabs.texts'
  value       TEXT NOT NULL,
  base_en     TEXT NOT NULL,          -- the English AT THE TIME OF EDIT — see "drift" below
  author      TEXT NOT NULL,          -- l10n_admin.subject_hash
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (lang, key)
);

CREATE TABLE l10n_history (           -- append-only; the undo button and the audit trail
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lang TEXT NOT NULL, key TEXT NOT NULL,
  value TEXT,                          -- NULL = the override was withdrawn
  author TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE l10n_admin (
  subject_hash TEXT PRIMARY KEY,       -- sha256(google_sub)  ⚠ sub, NOT email — see below
  lang         TEXT NOT NULL,          -- one row per (person, language); several rows = several langs
  label        TEXT,                   -- 'Pak Budi' — for the operator's own list, not shown to users
  added_by     TEXT NOT NULL, added_at INTEGER NOT NULL, revoked_at INTEGER
);

CREATE TABLE l10n_revision (rev INTEGER NOT NULL);   -- single row, bumped on every write
```

**⚠ Hash the OAuth `sub`, not the email.** Seth suggested either. `sub` is Google's stable,
immutable per-account identifier; **an email address can be changed or reassigned by a Workspace
admin**, so an email-keyed grant can silently transfer to a different human. The `sub` never moves.
Hashing it keeps the table useless if leaked while remaining exactly matchable at sign-in.

---

## Worker endpoints

| | |
|---|---|
| `GET /v1/l10n/:lang?rev=N` | 304 when `rev` is current; else `{rev, overrides:{key:value}}`. Public, cacheable, no auth — these strings are on screen for everyone anyway. |
| `POST /v1/l10n/:lang` | `{key, value}`. Requires a valid Google ID token whose hashed `sub` has a live `l10n_admin` row **for that lang**. Validates, writes both tables, bumps `rev`. |
| `DELETE /v1/l10n/:lang/:key` | Withdraw an override; the bundled string returns. |
| `GET /v1/l10n/:lang/history?key=` | For the revert UI. |

Server-side validation on every write — each rejects a real failure, not a hypothetical one:

- key must exist in the shipped English dictionary (no inventing keys);
- **placeholder parity**: the `{vars}` in the value must be exactly the set in the English. A
  translation that drops `{name}` renders "Saving  to this device…"; one that invents `{size}`
  prints it literally. This is the single most common real translation bug;
- no `<`, no `javascript:`, no `on\w+=` (see the XSS section);
- length ≤ ~4× the English, so a paste accident cannot blow up a layout for everyone.

---

## Client

- On load, and at most hourly, `GET /v1/l10n/<lang>?rev=<cached>`. Store `{rev, overrides}` in
  IndexedDB. **Non-blocking**: the UI paints from the bundle immediately and repaints if an overlay
  arrives. A failed fetch is a no-op, not an error the user sees.
- `t()` consults the overlay first (with the `innerHTML` exception above).
- The satellites share the engine and already talk to the worker cross-origin, so they inherit this
  for free — same overlay, same cache.

## The editing UX

A **"Suggest a fix"** toggle, reachable from the language menu, visible only after sign-in as an
admin for the current language. With it on, every translated string on screen gets a click target;
clicking opens a small editor showing the English source, the current translation, and the key.

⚠ **The hard part is not the editor, it is knowing which key produced which pixels.** Static markup
already carries `data-i18n` / `-ph` / `-title`, so those are free. But most strings are interpolated
into template literals inside `app.js` and `researcher-panel.js` — the DOM keeps no record of where
they came from. Options, cheapest first:

1. **Static-markup keys only** (`[data-i18n*]`). Maybe a third of the visible surface, ~zero work,
   and genuinely useful — it covers tabs, buttons and headings.
2. **Key-echo mode**: with the toggle on, `t()` wraps its return in `⁨key⁩` invisible
   delimiters, and a click handler recovers the key from the text node. No call-site changes; a bit
   grubby, and breaks any string used in a `value=` or compared with `===`.
3. **Instrument `t()` call sites** to emit `data-i18n-key` on the element they build. Correct,
   complete, and touches hundreds of lines.

Recommend **1 now, 3 incrementally** — start where the translator will actually look first (the
chrome), and grow coverage as specific complaints arrive. 2 is a trap: it would be discovered in
production by a string that stopped comparing equal.

## Google OAuth — buried, and only for this

The app has **no login today, and that is a feature**: a coworker taps a link and works. Adding a
sign-in must not change that for anyone who is not an admin.

- Entry point: a small "Translator sign-in" item at the bottom of the language menu. Not on the
  first screen, not in onboarding, not a banner.
- **Google Identity Services token flow only** — an ID token to identify a translator. It must NOT
  request Drive scopes; that is the researcher upload path and must stay separate, or a translator
  grant becomes a data grant.
- Signed out is the permanent default. Nothing about the field workflow consults it.

---

## Staging and rollback

`rev` is global, so **one bad edit is one `DELETE` away from gone for everyone** — no deploy, no
Pages rebuild. That is the real argument for immediate-live: the blast radius is small *because* the
undo is instant. Worth adding anyway:

- the panel's admin modal lists recent overrides with a one-click revert (reads `l10n_history`);
- an override diff visible in the panel, so Seth can see what changed without querying D1.

⚠ **Drift.** `base_en` records the English as it was when the override was written. When the English
later changes, the override is probably stale — the UI should keep using it (a slightly old
translation beats an English one) but flag it in the admin list. Without this the overrides quietly
rot as the app evolves, and nobody finds out.

---

## Rough order of work

1. XSS fix (`data-i18n-html` never takes an overlay value) — **before any of the rest**.
2. D1 migration + `GET` endpoint + client overlay fetch/cache. Ship with an empty table: zero
   visible change, and the risky plumbing is proven in production before anyone can write to it.
3. Admin table, OAuth sign-in, `POST`/`DELETE` with validation.
4. Editing UI, static-markup keys only.
5. Panel admin view: admins per language, recent overrides, revert.
6. Fold-back job: overrides → `i18n.js` → the overrides are deleted, and the bundle is true again.

Steps 1–2 are independently useful and carry no new risk. Step 3 is where the security review
belongs — it is the first point at which an outside human can change what every device displays.

⚠ **RELEASE ORDER** (`notes/RELEASE-RUNBOOK.md`): this touches the Worker and D1, so the deployed
client must never be ahead of the backend — D1 migrate → worker deploy → smoke test → editor
`productionWeb` → recorder → Turnstile.
