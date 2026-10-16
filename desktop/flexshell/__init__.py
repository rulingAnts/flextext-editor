"""FlexText Segmenter for FLEx — the Windows pywebview shell (plans/flex-desktop-segmenter.md).

Everything in this package imports on Linux without pywebview or pythonnet installed: the two
Windows-only dependencies are imported lazily, inside the functions that need them (app.py,
webview_hooks.py, lcm_real.py, fwfind.py, clipboard.py). The test suite in desktop/tests runs
against lcm_mock on any platform.

Label convention carried from the plan into code comments:
  [verified]   shown on real FieldWorks 9.3.12 / SIL.LCModel 11.0.0.55180 on a disposable copy
  [source]     read in liblcm / FieldWorks source, not run
  [unverified] still needs a VM run (desktop/README.md lists every one)
"""

SHELL_VERSION = "0.1.0-dev"
# The bridge contract native-flex.js expects (EXPECTED_FLEX_CONTRACT there). Bump both together —
# and only for a change an older shell cannot survive: an ADDED method or op goes into hello()'s
# `capabilities` instead (native-flex.js explains why; plans/flex-shell-live-path.md §3.4).
FLEX_CONTRACT = 1
