# Flextext Recorder — repo guide for Claude / LLMs

This repo ships the **Flextext Recorder** PWA (<https://rulingants.github.io/text-recorder/>):
a stripped-down, **recording-only** app for native-speaker coworkers gathering
audio on a phone (record → send). It is a **thin companion** to the **Flextext
Editor**, which is the **main project** — a separate, independent Git repo at
`rulingAnts/flextext-editor` (local: `/Users/Seth/GIT/flextext editor/`).

## The one thing to understand: this is a SHELL, not a fork

`index.html` here is a thin shell. It loads the **editor's engine** cross-path
over the same GitHub Pages origin — `/flextext-editor/js/app.js` +
`/flextext-editor/css/app.css` — and sets `window.__MODE='record'` so that
shared engine renders the record-only UI.

**⇒ All recording / consent / storage / upload logic lives in the EDITOR repo,
not here.** To change behavior, edit the editor repo's `js/`. Do **not** copy
engine code into this repo. This repo holds ONLY:

- `index.html` — the shell (sets `window.__MODE='record'`)
- `recorder.webmanifest` — manifest with a distinct `id`/`scope` so it installs
  as its own app, separate from the editor
- `sw.js` — its own service worker (a SW can't reach above its own folder on
  GitHub Pages, so each app serves its own)
- `icons/` — the recorder's app icons

## Why a separate repo (don't merge them into the editor)

Two PWAs on one origin must have **non-overlapping scopes** or the browser treats
them as one app (installing one makes the other report "already installed"). The
editor owns `/flextext-editor/` (root scope); this recorder lives at the disjoint
sibling path `/text-recorder/`. A separate repo keeps the editor at
`/flextext-editor/` **untouched** — relocating the editor would change its PWA
`id` and **orphan every installed copy in the field**.

## ⚠ VERSION COUPLING

`sw.js` here **precaches the editor's engine files by path** (`/flextext-editor/js/*.js`,
`css/app.css`). Those files have their own lifecycle in the editor repo.
**Whenever the editor engine changes in a way this recorder should pick up, bump
`VERSION` in `sw.js` here** — otherwise installed recorders keep serving a
**stale cached engine** offline. In practice the cadence is simply **every editor
engine deploy → recorder `sw.js` bump**: the two versions have marched together
(editor engine/sw v97+ ↔ recorder sw v46+, all silently auto-updating).

### ⚠ Also keep the SHELL precache list in sync with `app.js`'s import graph
Bumping `VERSION` is **not enough on its own**. The editor's `js/app.js` is loaded
here as a `type="module"`, so the browser resolves **every static `import` at the
top of `app.js` at load time — even in record mode** (the record UI doesn't *use*
the researcher panel, but the module graph still pulls it in). So whenever
`app.js` gains/loses a top-level `import`, the `SHELL` array in `sw.js` must be
updated to match, or a recorder that updates then goes **offline mid-load** throws
on the missing import and is **dead offline**. The graph currently spans the
recording stack (`record-pcm.js`, `audio-capture-worklet.js`, `flac.js`, the
`vendor/` codecs) and the connectivity engine (`crypto.js`, `sync.js`,
`researcher.js`, `researcher-panel.js`) — all are in `SHELL`. If `app.js` gains or
loses a top-level module, mirror it in `SHELL` here in the same change.

### ⚠ Consent modal markup — stamped in THREE shells, KEEP IN SYNC
The consent modal (`#consent-modal`: recorded-response → typed signature → yes/no
**radio** choices, one submit) is static markup stamped **identically** into all
three shells that record: the editor's `index.html`, this repo's `index.html`, and
the **crowd recorder's** (`/Users/Seth/GIT/crowd-recorder/index.html`). The shared
engine only wires behavior onto that markup — if it changes in one shell it must
change in **all three**, or the engine's selectors silently miss.

## ⚠ DEPLOY ORDER — editor first, always

GitHub Pages serves this repo's root at <https://rulingants.github.io/text-recorder/>.
When a change spans both repos:

1. Deploy the **editor's `productionWeb` FIRST**; confirm `/flextext-editor/` is live.
2. **Then** bump this `sw.js` `VERSION` (if not already) and `git push` this repo.

Reason: this recorder's SW precaches whatever editor engine is live **at install
time**. Pushing this repo first would cache the OLD editor engine.

## Branches / deploy

Single `main` branch, deployed straight to Pages (root) — no dev/prod split like
the editor, so this repo is effectively always "production." Test engine changes
on the **editor** repo's dev server first; this shell itself rarely changes. Per
the editor's release rule, do not push without the maintainer's OK.

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
