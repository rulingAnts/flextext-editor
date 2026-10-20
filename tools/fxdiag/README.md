# fxdiag — FlexText storage, read from the disk

A small tool for a computer (Windows, Mac, Linux) that finds every browser profile holding FlexText
storage — Chrome, Edge, Brave, Chromium, Vivaldi, the Flextext Desktop (Electron) shell, the FLEx
shell's WebView2 folder — and writes **one zip** with what a problem report needs: a manifest of the
texts on the device (ids, titles, dates, sizes, upload state, which have a recording), the device's
settings, which suite apps are installed, and, **only if ticked**, the full text records and their
recordings. Same file shape as the in-app problem report's private leg (`plans/BACKLOG.md`, the
widened #98), so one reader serves both.

It never talks to a running browser: the LevelDB folders are **copied** first and the copy is parsed
(`snapshot.py`), LOCK files left alone. It cannot read an Android phone — that storage is sandboxed —
so for a field device the in-app report is the route; this tool is for laptops, the Electron shell,
and the FLEx shell.

## Install (needs Python 3.11+ and git on PATH)

```powershell
py -3.13 -m pip install "flextext-fxdiag[gui] @ git+https://github.com/rulingAnts/flextext-editor.git@desktop-flex#subdirectory=tools/fxdiag"
fxdiag                 # the window
fxdiag scan            # console: what is on this disk
fxdiag report --texts all --with-audio --out report.zip
```

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

Blind spots, also written into every report: Cache Storage (the installed service-worker shell) is
not read; sessionStorage, cookies, history are not read; a browser writing during the copy may have
written since; files the OS refused to copy are listed under `copyProblems`.

## Tests

```sh
pip install -e ".[test]" && pytest tools/fxdiag/tests -q
```

The fixture is a real Chromium profile written by headless Chromium (`tests/make_profile.mjs`) with
made-up records at the suite's production origin, so the on-disk encodings are genuine.
