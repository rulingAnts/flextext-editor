# Plan: the FLEx desktop shell, from a bundled engine to the live one — the path, not the move

Seth, 2026-10-16: *"We want to make sure our desktop shell in the future will be easy to move over to
a true shell loading the PWA code, mainly acting as a bridge between the PWA code and FLEx
endpoints."* — *"it's currently hardcoding the HTML/JavaScript, which is fine for now while
developing, but … the long term design isn't that."* — *"We don't want to do the migration YET, but
we want to prepare the path for that later."*

Status: **preparation only.** Branch `desktop-live-path`, cut from `desktop-flex` at `3023b7f`. Nothing
here changes what the shell serves or how it behaves, except one small fix (§3.7).

## 0. Short answer

- **Today** `desktop/build/stage_engine.py` copies the engine into the shell at build time and
  `server.py` serves that copy from `http://127.0.0.1:8017/`. An engine change reaches a FLEx user
  only through a new shell build.
- **Long term** the shell loads the engine the web already ships, and its own job shrinks to the
  window, the navigation guard, and the bridge to FLEx (LibLCM, through `api.py`).
- **Most of the design already points that way** (§2): one engine seam, a contract checked at
  `hello()`, every FLEx safety check on the Python side, unknown ops refused, media URLs opaque to the
  engine.
- **The one expensive thing is data.** IndexedDB belongs to an *origin*. The shell's origin is
  `http://127.0.0.1:8017`, and check-outs — FLEx texts with work not yet saved back to FLEx (plan
  §4.5) — live there and nowhere else. Any move that changes the page's origin has to carry them.
- **Recommendation for when the move happens: Option C (§4)** — keep the origin, and let the shell's
  own server become a *mirror* of the live Audio Segmenter instead of serving a copy frozen at build
  time. No data to carry, and the guard, CSP and media path stay as they are. That decision is not
  needed now; everything done here keeps both C and the Electron-style Option B open.

## 1. What the "true shell" is

| Job | Today | After the move |
|---|---|---|
| Engine (UI, Matcher, diff into ops) | bundled at build time | the live Audio Segmenter, updated like the web app |
| Window, navigation guard, CSP | shell | shell (unchanged under C) |
| FLEx: open, read, preview, back up, write, verify, undo | shell (`protocol.py`, `lcm_real.py`) | shell — **always**: it needs .NET and the user's own LibLCM |
| Recordings on disk (`/media/<token>`) | shell | shell |
| Archival audio capture | the separate Electron shell | later, one shell (§6) |

The shell is rebuilt when **FLEx-side** code changes. It is not rebuilt for a UI change, a string, a
Segmenter feature, or a sync change — today it must be, for all of them (plan R4).

## 2. What is already right — keep it that way

| Property | Where | Why it matters for the move |
|---|---|---|
| One engine seam; the global is read in one function | `native-flex.js` `bridge()`; `check-native-containment.sh` rule 1c | A different transport later (Electron preload, a sidecar process) is a change to one function. |
| Contract checked at `hello()`; mismatch disables FLEx features and says so | `native-flex.js` `whenFlexReady` | The engine can meet a shell it does not match and stay safe. |
| An unknown op refuses the whole save | `protocol.py` preview, `E_SCOPE` | A newer engine can never get half a save written. **Now pinned** (§3.4). |
| Every check that protects the user's FLEx project is Python-side and re-validates what the page sends | `prechecks.py`, `protocol.py` W1–W10, `diskcheck.py`, copy-only flag | It holds whatever page is in the window — the property that makes loading a page the shell did not build itself acceptable at all. |
| No HTTP endpoint drives FLEx; only `/media/<token>` | `server.py` | Nothing on the local server needs the page to be its own content. |
| The engine uses a recording's `url` as given | `flex-panel.js` `cacheRecording(id, link.url)` | Where recordings are served from is the shell's call alone. **Now pinned** (§3.2). |
| FLEx features shown only when the bridge answers | `isFlexShell()`; `flex-panel.js` is `import()`ed only then | The same Segmenter page can serve web users and the shell. |
| The staged layout equals the live Segmenter's layout | `stage_engine.py`: satellite at `/`, engine at `/flextext-editor/` — as `audio-segmenter.flextext.app` serves it | A mirror of the live site (Option C) is path-for-path what is served today. |
| `native-flex.js` is in every offline-capable `sw.js` SHELL | `docs/sw.js`, recorder, Segmenter, PAT | The v108 rule already holds for the top-level import. |

## 3. What would make the move expensive — and what is done about each now

### 3.1 The origin is the data

The shell's IndexedDB, localStorage and the pairing session belong to `http://127.0.0.1:8017`, kept by
WebView2 in `%LOCALAPPDATA%\FlexTextSegmenterFLEx\webview`. Under Option C the origin never changes, so
nothing moves. Under Option B the page's origin becomes `https://audio-segmenter.flextext.app` and
starts empty; the check-outs would have to be carried across. The cheapest way to keep that possible
is to keep the old origin openable: a later shell can serve the last bundled engine at the old origin
**once**, export the records through the bridge, and import them on the new one.

**Done now:** `desktop/tests/test_live_path.py` pins the port and the storage folder, with the reason.
They were already documented as fixed; a test makes "changed in passing" a failure instead of a
stranded corpus. **Not done:** an export/import path. It is only needed under B, and its shape depends
on the record format at the time, so it is built then.

### 3.2 Media URLs

`api.py` spelled `"/media/" + token` in four places: a path on the shell's own server, which is the
page's origin today. **Done now:** one helper, `Api._media_url(path)`, makes every recording URL; a
test fails on a second spelling. A node test fails if the engine ever builds a media URL itself. Under
C nothing changes. Under B this one function changes: a reserved path the shell answers on the live
origin (WebView2 `WebResourceRequested` — same-origin, so no CORS, no local-network permission, range
requests as today), or bytes over the bridge as the Electron shell does (`readChunk`). Which, is a
question for that day and the VM.

### 3.3 The staged-page marker

`isFlexShellPage()` reads `<meta name="flextext-flex-shell">`, which `stage_engine.py` stamps into the
bundled page. A shell that loads the live site gets no stamp, so anything gated on the marker switches
off silently that day. **Done now:** `test/flex-live-path.test.mjs` pins its callers to exactly three,
each a decision that must be made before the bridge exists:

| Caller | Decision | Under C | Under B |
|---|---|---|---|
| `app.js isLocalDev` | the relay worker is production, not a developer's `wrangler dev` | the mirror step stamps the marker exactly as staging does today | not needed: the host is a real one |
| `app.js devResetAllowed` | `?devreset` is refused (§3.7) | same | not needed: a real host is already refused |
| `native-flex.js mirrorConsoleToShell` | the verbose shell console | same | needs another signal (the bridge being present) |

Every FLEx **feature** asks `isFlexShell()` — the bridge answered `hello()` — which works the same
under every option. A new marker caller fails the test with that instruction.

### 3.4 Version skew — the engine will usually be newer than the shell

Today engine and shell are built together, so their contract numbers always match. After the move the
engine moves with the web and installed shells lag behind, sometimes by months on an offline laptop.
`EXPECTED_FLEX_CONTRACT === FLEX_CONTRACT` is an exact-equality check, so **every bump would switch
the FLEx features off on every installed shell until each is reinstalled.**

**Done now:**
- The rule is stated where the numbers live (`native-flex.js` above `EXPECTED_FLEX_CONTRACT`,
  `desktop/flexshell/__init__.py` above `FLEX_CONTRACT`): bump only for a change an older shell
  cannot survive (a changed meaning, a removed method). An **added** method or op is listed in
  `hello().capabilities`, and the engine offers that feature only where it is listed. `hello()`
  already carries `capabilities`, so this needs no change to installed shells.
- `test_w1_a_save_naming_one_op_this_shell_does_not_know_is_refused_whole` pins the property that
  makes skew safe: a valid op followed by one this shell does not know → `E_SCOPE`, no preview issued,
  nothing written, the session still usable. The unknown op comes second on purpose — a loop that
  skipped unknown ops would pass the older test.

**The order, when the bridge grows** (the backend-first rule, applied to the bridge): ship the new
method in a shell build first, additively; then the engine uses it where `hello()` lists it. The
reverse skew — a newly installed shell meeting an older *cached* engine — happens only offline, so a
shell keeps answering a method's old shape for at least one release after the engine stops using it.

### 3.5 Offline

The three FLEx modules are `import()`ed only inside the shell, so no web user downloads them:
`flex-panel.js`, `flex-ops.js`, `printview-tsv.js` — and they are in no `sw.js`. Today the shell's
server serves them. Under C the mirror must fetch them too (the file list is the Segmenter's SHELL
plus these). Under B the Segmenter's service worker must hold them, or the FLEx section is dead
offline — the v108 failure in a new place. **Done now:** the list is computed from the real imports
in `test/flex-live-path.test.mjs`, so it cannot go stale without a test saying so.

### 3.6 Trust — what the protections protect

The user's FLEx project is the thing at stake: years of a community's texts, glosses and analysis.
Every protection for it already sits on the Python side and checks what it is sent, rather than
trusting the page: the copy-only flag, the pre-checks, the preview with the exact intended
post-state, the verified backup, one unit of work, the in-UOW invariants, the disk read-back, and
poisoning on any doubt. **Rule for the move: none of these moves into the engine.** A check written in
the engine protects only while the shell ships the engine itself.

What the shell loads must be what the site publishes:
- **Option C:** mirror only from the pinned production origin over HTTPS (staging only in a build that
  says so on its console line, as today's dev builds do); fetch the whole set, verify it against a
  manifest of per-file hashes, swap atomically, keep the last good set, and never serve a partial one.
- **Option B:** the navigation guard pins the exact production origin, as it pins `127.0.0.1:8017`
  today.

### 3.7 Found in passing, fixed: `?devreset` inside the shell

`devResetAllowed()` admits every `isDevHost()` address, and the shell's `127.0.0.1` is one, so a
`?devreset` link reaching the shell would have wiped its origin — check-outs included — with no
confirmation. `isLocalDev()` had already been taught that the shell is not a developer's machine
(plan §2.4 item 7); `devResetAllowed()` had not. It now refuses on the shell page.
`test/devreset-scope.test.mjs` proves both halves: refused in the shell, still honoured on a
developer's `127.0.0.1`. A navigation to it was unlikely — the engine makes no such link and the user
has no address bar — but the cost of the fix is one line.

## 4. The three ways to make the move (for later)

| | **A. Bundle (today)** | **B. Load the live origin** (as the Electron shell does) | **C. Mirror at the same origin** |
|---|---|---|---|
| Engine updates without reinstalling | no | yes | yes |
| Origin, and with it the user's data | `127.0.0.1:8017` | changes → check-outs must be carried (§3.1) | `127.0.0.1:8017`, unchanged |
| Navigation guard | as is | rewritten for one HTTPS origin | as is |
| CSP | `server.py` | the site's (Cloudflare) headers | `server.py`, as is |
| Recordings | `/media/<token>` | one function changes (§3.2) | as is |
| Offline first run | works | needs the network once | works (the bundled engine is the first mirror) |
| Offline afterwards | works | service worker, plus the three FLEx modules (§3.5) | the mirror |
| Service worker | none | the site's | none — the mirror is the cache |
| New moving parts | — | data carry-over, guard, media path | fetch, verify, atomic swap, rollback |

**Why C.** It turns the move from a migration into an update mechanism. Everything the shell already
proved on the VM — the guard, the CSP with hashed inline scripts, the media route, the fixed origin —
stays exactly as proven, and nobody's check-outs move. The mirror step *is* `stage_engine.py` run on
fetched files instead of the repository, with the same marker and the same off-origin scan. B is the
Electron model and is fine for an app with nothing local worth keeping; this one keeps unsaved FLEx
work locally by design.

**C, in the order it would be built:**
1. The site publishes `engine-files.json` (path, size, SHA-256 per file) for the Segmenter, generated
   at build time. Additive: web users never fetch it.
2. A shell build that, when online, fetches that manifest from the production origin and, if the
   engine version is newer, downloads the set into a new folder, verifies every hash, runs the
   off-origin scan, stamps the marker, and swaps on the **next** start — never under an open text.
   The bundled engine stays as the first mirror, so a first run with no network still works.
3. The previous set is kept; if the new engine's contract does not match this shell, or it fails to
   boot, the shell falls back to it and says so on its console line.
4. `stage_engine.py` keeps building the bundled fallback; it no longer decides what most users run.

## 5. Electron (plan R7)

Two Windows shells today: Electron (archival capture, loads the live editor) and this one (FLEx). The
long-term single shell can go either way — this shell gains the capture contract (`native-audio.js`
is already "two transports, one contract"; pywebview would be a third), or Electron runs this Python
as a sidecar process speaking the same JSON. Both stay cheap while the two seams stay separate files
and the bridge stays JSON in, JSON out, async, `{ok, result | error}` — which it is. Not decided here.

## 6. Decisions for Seth

None needed now. When the move is scheduled:
1. **C or B** — recommendation C (§4).
2. Whether the site may publish `engine-files.json` (C, step 1) — additive, invisible to web users.

## 7. What changed on this branch

| Change | Test that fails without it |
|---|---|
| `Api._media_url()` makes every recording URL | `desktop/tests/test_live_path.py::test_media_urls_are_made_in_one_place` |
| port and storage folder pinned, with the reason | `test_live_path.py::test_the_shells_origin_and_data_folder_never_change` |
| an unknown op refuses the whole save | `desktop/tests/test_protocol.py::test_w1_a_save_naming_one_op_this_shell_does_not_know_is_refused_whole` |
| the contract rule beside both numbers | `test/flex-live-path.test.mjs` (contract rule) |
| the engine never builds a media URL | `test/flex-live-path.test.mjs` |
| the staged-page marker has exactly three callers | `test/flex-live-path.test.mjs` |
| the FLEx modules outside the Segmenter's SHELL are the three named | `test/flex-live-path.test.mjs` |
| `?devreset` refused inside the shell | `test/devreset-scope.test.mjs` |

Each was checked by breaking the property and watching its test fail.
