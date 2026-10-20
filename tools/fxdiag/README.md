# fxdiag — FlexText storage, read from the disk

A small tool for a computer (Windows, Mac, Linux) that finds every browser profile holding FlexText
storage — Chrome, Edge, Brave, Chromium, Vivaldi, the Flextext Desktop (Electron) shell, the FLEx
shell's WebView2 folder — and writes **one zip** with what a problem report needs: a manifest of the
texts on the device (ids, titles, dates, sizes, upload state, which have a recording), the device's
settings, which suite apps are installed, and, **only if ticked**: the texts as **`.flextext` files**
beside their **recordings** (written by the engine's own serializer, so FLEx or another device can open
them), the full text **records** as JSON, and the suite origins' **raw browser storage** (their IndexedDB
folders, byte for byte, for re-reading later). Same file shape as the in-app problem report's private
leg (`plans/BACKLOG.md`, the widened #98), so one reader serves both.

**It reads only the FlexText suite's storage.** Origins are filtered by host (the suite's domains, its
Cloudflare account's Workers, GitHub Pages, localhost), databases and keys by their `flextext` prefix.
Nothing from any other site is opened, copied or listed — the profile-wide Local Storage LevelDB is never
included raw for that reason (it holds every site's keys). `fxdiag/suite.py` is where the tool knows what
the suite is, and `test/fxdiag-suite-sync.test.mjs` (repo root) fails when an app, host, database or key
appears in `docs/js` that it would not recognise — see CLAUDE.md, "fxdiag follows the suite's storage".

**Where it is offered:** the researcher panel's Feedback window ("Diagnostic tool for computers"), and
nowhere else — a coworker's device shows no off-site links, and a phone cannot run it.

It never talks to a running browser: the LevelDB folders are **copied** first and the copy is parsed
(`snapshot.py`), LOCK files left alone. It cannot read an Android phone — that storage is sandboxed —
so for a field device the in-app report is the route; this tool is for laptops, the Electron shell,
and the FLEx shell.

## Install (needs Python 3.11+ and git on PATH)

```powershell
py -3.13 -m pip install "flextext-fxdiag[gui] @ git+https://github.com/rulingAnts/flextext-editor.git@desktop-flex#subdirectory=tools/fxdiag"
fxdiag                 # the window
fxdiag scan            # console: what is on this disk
fxdiag report --flextext --with-audio --out report.zip   # texts as .flextext files + recordings
fxdiag report --texts all --raw --out report.zip         # raw records + the suite origins' IndexedDB folders
```

`--flextext` runs the engine's serializer in **Node.js** (nodejs.org); without Node the report still
holds the JSON records and says what to install. 
`git` is needed at install time because the LevelDB/IndexedDB decoder, CCL Solutions Group's
`ccl_chromium_reader` (MIT), is not on PyPI. Nothing needs the network when it runs. Without the
`[gui]` extra there is no window, only the console commands.

**From a thumb drive:** `py -3.13 -m venv X:\fxdiag && X:\fxdiag\Scripts\pip install "…"` (as above)
on a machine that has Python; then `X:\fxdiag\Scripts\fxdiag` on any machine with the same Python
version. Point it at a copied profile folder with `--user-data-dir` if the browser is not on that
machine. `--all-users` looks under every account's folder.

## What is in the zip

| file | holds |
|---|---|
| `report.json` / `README.txt` | tool version, when, OS, what was asked, per-store counts, copy problems, the blind spots |
| `storage-<app>-<profile>.json` | per suite origin: databases → stores → counts; the `media` manifest; per-text manifest rows; localStorage (settings parsed; credential-named keys as *present + length*, never the value); installed web apps |
| `texts/…/<id>.json` | the full `docs` record — only with `--texts` |
| `media/…/<key>.wav` | the recording — only with `--with-audio` |
| `export/…/<title>.flextext`, `<title>.wav` | the text as a file FLEx can open, its recording beside it (the `media-files` block names it) — only with `--flextext` (+ `--with-audio`) |
| `raw/…/IndexedDB/<origin folder>/…` | the suite origins' IndexedDB folders as copied — only with `--raw`; never Local Storage |

Blind spots, also written into every report: Cache Storage (the installed service-worker shell) is
not read; sessionStorage, cookies, history are not read; a browser writing during the copy may have
written since; files the OS refused to copy are listed under `copyProblems`.

## Tests

```sh
pip install -e ".[test]" && pytest tools/fxdiag/tests -q
```

The fixture is a real Chromium profile written by headless Chromium (`tests/make_profile.mjs`) with
made-up records at the suite's production origin, so the on-disk encodings are genuine.
