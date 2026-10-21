"""Build the portable, single-file fxdiag executable with PyInstaller.

    python tools/fxdiag/packaging/build_exe.py --out dist [--node path/to/node(.exe)] [--name fxdiag-0.1.0-windows-x64]

Run from anywhere inside the repository, with fxdiag's dependencies (and pyinstaller) installed in the
current Python. Used by .github/workflows/build-fxdiag.yml on windows-latest; it also runs on Linux and
macOS, which is how the packaging is checked before a Windows build is spent on it.

What goes in:
  - the fxdiag package (from tools/fxdiag, not an installed copy, so the build is of THIS checkout);
  - the engine serializer, staged exactly as setup.py stages it for a wheel: docs/js/flextext.js and
    segments.js, serialize.mjs, ENGINE_VERSION — so `--flextext` uses the suite's own writer;
  - with --node, a Node.js binary at <bundle>/node/, so `--flextext` works on a laptop with no Node
    installed (flexexport.bundled_node); its LICENSE beside it when one is found next to the binary;
  - THIRD-PARTY.txt and the README;
  - the Chromium and Firefox readers' submodules, and pywebview (+ pythonnet on Windows) when installed.

One file, console subsystem: a double-click opens the window (and a console that shows what it is
doing); every command works from a terminal. Unsigned: SmartScreen warns on first run.
"""

import argparse
import importlib.util
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG_ROOT = HERE.parent                      # tools/fxdiag
REPO = PKG_ROOT.parent.parent               # the repository root
SEP = os.pathsep                            # PyInstaller's --add-data separator is ';' on Windows, ':' elsewhere


def stage_engine(dst):
    """dst/engine/{serialize.mjs, js/flextext.js, js/segments.js, ENGINE_VERSION}."""
    src_js = REPO / "docs" / "js"
    if not (src_js / "flextext.js").is_file():
        raise SystemExit("docs/js/flextext.js not found — run from a full checkout of the repository")
    eng = dst / "engine"
    (eng / "js").mkdir(parents=True)
    shutil.copy2(PKG_ROOT / "fxdiag" / "engine" / "serialize.mjs", eng / "serialize.mjs")
    for name in ("flextext.js", "segments.js"):
        shutil.copy2(src_js / name, eng / "js" / name)
    m = re.search(r"ENGINE_VERSION\s*=\s*'([^']+)'", (src_js / "i18n.js").read_text(encoding="utf-8"))
    (eng / "ENGINE_VERSION").write_text((m.group(1) if m else "unknown") + "\n", encoding="utf-8")
    return eng


def stage_node(dst, node):
    node = Path(node).resolve()
    if not node.is_file():
        raise SystemExit("--node %s: not a file" % node)
    d = dst / "node"
    d.mkdir(parents=True)
    shutil.copy2(node, d / node.name)
    for lic in (node.parent / "LICENSE", node.parent.parent / "LICENSE"):
        if lic.is_file():
            shutil.copy2(lic, d / "LICENSE")
            break
    return d


def has(mod):
    return importlib.util.find_spec(mod) is not None


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="dist")
    ap.add_argument("--node", help="a Node.js binary to bundle")
    ap.add_argument("--name", default="fxdiag")
    a = ap.parse_args(argv)
    import PyInstaller.__main__ as pyi

    work = Path(tempfile.mkdtemp(prefix="fxdiag-build-"))
    eng = stage_engine(work)
    args = [str(HERE / "fxdiag_entry.py"), "--onefile", "--console", "--noconfirm", "--clean",
            "--name", a.name, "--distpath", str(Path(a.out).resolve()), "--workpath", str(work / "pyi"), "--specpath", str(work),
            "--paths", str(PKG_ROOT),
            "--add-data", "%s%sfxdiag/engine" % (eng, SEP),
            "--add-data", "%s%s." % (PKG_ROOT / "THIRD-PARTY.txt", SEP),
            "--add-data", "%s%s." % (PKG_ROOT / "README.md", SEP),
            "--collect-submodules", "fxdiag",
            "--collect-submodules", "ccl_chromium_reader",
            "--hidden-import", "ccl_simplesnappy.ccl_simplesnappy",
            "--collect-submodules", "mozidbedit"]
    if a.node:
        args += ["--add-data", "%s%snode" % (stage_node(work, a.node), SEP)]
    if has("webview"):
        args += ["--collect-all", "webview"]
        if sys.platform == "win32":
            for m in ("clr_loader", "pythonnet"):
                if has(m):
                    args += ["--collect-all", m]
            args += ["--hidden-import", "clr"]
    else:
        print("build_exe: pywebview is not installed — building without the window (console only)")
    print("build_exe: pyinstaller " + " ".join(args))
    pyi.run(args)
    exe = Path(a.out).resolve() / (a.name + (".exe" if sys.platform == "win32" else ""))
    if not exe.is_file():
        raise SystemExit("PyInstaller produced no %s" % exe)
    print("built: %s (%.1f MB)" % (exe, exe.stat().st_size / 1e6))
    shutil.rmtree(work, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
