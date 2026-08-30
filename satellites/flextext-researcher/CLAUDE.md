# Flextext Researcher — repo guide for Claude / LLMs

This repo ships the **Flextext Researcher** PWA (<https://rulingants.github.io/flextext-researcher/>):
the **researcher console** — set up and manage coworkers' devices, mint invite
links, approve installs, push tasks/settings, and review decrypted inventory. It is
the researcher's own tool (not a field-worker app). It is a **thin companion** to the
**Flextext Editor**, which is the **main project** — a separate, independent Git repo
at `rulingAnts/flextext-editor` (local: `/Users/Seth/GIT/flextext editor/`).

## ⚠ On GitHub Pages this app is RETIRING (2026-08-17)

`https://rulingants.github.io/flextext-researcher/` now **redirects to
<https://research.flextext.app/>**, and its service worker is a kill switch there: it unregisters
itself, drops its own caches, and navigates any open window across on the first launch after the
update, so the handover is invisible to the user. Query string and fragment ride along (an OAuth
return arrives as `#gauth=…`).

**Both files are HOSTNAME-GATED, and that is load-bearing.** `apps/researcher/build.sh` copies this
whole folder into the Cloudflare deployment, so the same `index.html` and `sw.js` also serve
`research.flextext.app`. Unconditional versions would make that site redirect to itself forever and
lose its offline support. On any non-`rulingants.github.io` host both guards are inert.

⚠ **The kill switch deletes ONLY `flextext-researcher-*` caches.** Three PWAs share one origin and
one CacheStorage on Pages; the broad "delete everything that is not mine" filter used by
`paragraph-analysis/shell.js` would wipe the EDITOR's and RECORDER's caches and brick a field device
offline. It also never touches localStorage or IndexedDB, which are per-origin and therefore shared.
`test/researcher-legacy-redirect.test.mjs` executes both guards under each hostname and asserts the
sibling caches survive.

The Cloudflare app is unaffected and remains the real researcher console; everything below still
describes it.

## The one thing to understand: this is a SHELL, not a fork

`index.html` here is a thin shell. It loads the **editor's engine** cross-path over
the same GitHub Pages origin — `/flextext-editor/js/app.js` +
`/flextext-editor/css/app.css` — and sets `window.__MODE='researcher'` so that
shared engine boots straight into the researcher panel (`setupResearcherMode`).

**⇒ All researcher / connectivity / panel logic lives in the EDITOR repo, not
here.** To change behavior, edit the editor repo's `js/` (mainly `researcher.js`,
`researcher-panel.js`, and the `RESEARCHER_MODE` branch in `app.js`). Do **not**
copy engine code into this repo. This repo holds ONLY:

- `index.html` — the shell (sets `window.__MODE='researcher'`; carries
  `#view-researcher`, `#toast`, and the install/webkit banners)
- `researcher.webmanifest` — manifest with a distinct `id`/`scope` so it installs
  as its own app, separate from the editor and recorder
- `sw.js` — its own service worker (a SW can't reach above its own folder on
  GitHub Pages, so each app serves its own)
- `icons/` — the researcher's app icons (a recolored editor mark, teal `#0f766e`)

## Why a separate repo (don't merge it into the editor)

Two PWAs on one origin must have **non-overlapping scopes** or the browser treats
them as one app (installing one makes the other report "already installed"). The
editor owns `/flextext-editor/` (root scope); the recorder owns `/text-recorder/`;
this console lives at the disjoint sibling path `/flextext-researcher/`. A separate
repo keeps the editor at `/flextext-editor/` **untouched** — relocating the editor
would change its PWA `id` and **orphan every installed copy in the field**.

## ⚠ THIS APP IS DELIBERATELY NOT OFFLINE-CACHED (Seth, 2026-08-31)

`sw.js` here **caches nothing**. The panel is an online console — auth is Google OIDC, every read
is a worker poll, every act is a worker call, and the panel persists no decrypted state — so a
precached shell could only ever render a sign-in it cannot complete, while costing the deploy-order
outage surface, an entire-engine re-download on every bump, and stale panels running against a
newer worker. The worker now: intercepts NAVIGATIONS ONLY (network-first, with a branded bilingual
offline page INLINED in the worker as the only no-network answer), skipWaits + claims + deletes
every `flextext-researcher-*` cache on activate (the takeover from the old precaching worker), and
leaves every other request to the browser.

- **VERSION/ENGINE stay in `sw.js` as inert constants** so `bump-version.sh` and
  `test/version-sync.test.mjs` keep working unchanged — and a bump is still what makes the file
  byte-different so installed copies fetch the new worker. Nothing caches by them.
- **There is NO SHELL to keep in sync any more.** A new top-level `import` in the editor's
  `app.js` is a SHELL entry for the editor, recorder and paragraph apps — NOT here.
- The offline "Utilities toolbox" (audio converter etc.) is consequently unavailable offline in
  THIS app — by design; the same tools remain offline-capable in the editor.
- ⚠ The kill-switch rules below still hold exactly (one file serves both estates; scoped cache
  filter protects the paired editor on Pages). `test/researcher-legacy-redirect.test.mjs` executes
  both hostnames and now also pins the non-caching behaviour on the Cloudflare side.

### Historical note

Until 2026-08-31 this worker precached the editor's whole engine by path (the fieldworker model),
with the SHELL sized by app.js's import graph. That model remains correct for the recorder and
paragraph apps; it was retired here because everything the panel does needs the network anyway.

## ⚠ DEPLOY ORDER — editor first, always

GitHub Pages serves this repo's root at <https://rulingants.github.io/flextext-researcher/>.
When a change spans both repos:

1. Deploy the **editor's `productionWeb` FIRST**; confirm `/flextext-editor/` is live.
2. **Then** bump this `sw.js` `VERSION` (if not already) and `git push` this repo.

Reason: this SW precaches whatever editor engine is live **at install time**.
Pushing this repo first would cache the OLD editor engine. (Same rule the recorder
follows; the three apps share one engine.)

## Auth / OAuth note

Sign-in is Google (OIDC), handled by the shared engine + the `flextext-r2-worker`
Cloudflare Worker. The worker allow-lists the **origin** `rulingants.github.io`
for the OAuth return, so this app's `…/flextext-researcher/` return path already
works with no worker change. The session token is stored per the "stay signed in"
choice (sessionStorage by default = lock-on-exit; localStorage when opted in).

## Branches / deploy

Single `main` branch, deployed straight to Pages (root) — no dev/prod split like
the editor, so this repo is effectively always "production." Test engine changes on
the **editor** repo's dev server first (`?mode=researcher` on localhost boots this
same panel); this shell itself rarely changes. Per the editor's release rule, do
not push without the maintainer's OK.

---

## ⚠️ GitHub costs — ask before anything billable (firm policy, 2026-07-07)

**Claude: never trigger anything that can incur GitHub charges without Seth's explicit
approval AND a stated cost estimate first.**

- FREE, always: Actions on **public** repos with **standard** GitHub-hosted runners;
  self-hosted runners; GitHub Pages.
- METERED (free monthly quota, then paid): Actions in **private** repos (2,000 min/mo;
  **Windows counts 2×, macOS 10×**); Codespaces; Packages; Git LFS.
- **ALWAYS billable, even on public repos: larger / GPU runners** (anything beyond the
  standard `ubuntu-latest` / `windows-latest` / `macos-latest` tiers).
- Safety valve: with **no payment method on file, GitHub blocks usage at the quota and
  cannot bill** — keep it that way, or set stop-usage budgets.

So WITHOUT Seth's explicit OK (and cost), do **not**: add or change `.github/workflows/**`;
use a non-standard `runs-on:`; add a `schedule:` (cron) trigger; create Codespaces; use
Git LFS; publish private Packages; or change the plan / budgets. The local
`.git/hooks/pre-push` blocks workflow pushes (override `ALLOW_WORKFLOW_PUSH=1`) and
production-branch pushes (`ALLOW_MAIN_PUSH=1`) — set those flags only after Seth approves
that specific push.

## 🚨 NEVER push this repo before the editor is LIVE

This app's `sw.js` precaches engine files from the editor **by path**. If you push while those
files aren't live yet, `precacheAll()` throws inside `install`'s `waitUntil` and **the service
worker fails to install**: existing installs stick on the old worker, and **new installs get no
precached shell at all — offline support silently gone.**

That is not hypothetical. It happened 2026-07-20: editor v108 added `js/native-audio.js`, this
repo was pushed while that editor commit was still on `main`, and `/flextext-editor/js/native-audio.js`
404'd in production.

**Enforcement:** `./check-editor-shell.sh` verifies every `/flextext-editor/...` SHELL path returns
200 on the live site, and it is wired into `.git/hooks/pre-push` so a premature push is blocked.
Hooks are **not** versioned by git — **reinstall the hook after any re-clone** (the script is
committed; the hook just calls it). Override only with cause: `ALLOW_STALE_SHELL=1 git push ...`.

**Correct order:** editor `main` → editor `productionWeb` (Seth's sign-off) → confirm live (curl the
new path → 200) → *then* bump this repo's `sw.js` VERSION and push.
