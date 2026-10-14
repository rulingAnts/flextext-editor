# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the FlexText Segmenter for FLEx (plan §12.1): --onedir, the staged engine
# beside the executable, pythonnet's runtime config, no LibLCM (loaded from FLEx's install folder).
import os

HERE = os.path.dirname(os.path.abspath(SPEC))
DESKTOP = os.path.join(HERE, "..")

a = Analysis(
    [os.path.join(DESKTOP, "flexshell", "__main__.py")],
    pathex=[DESKTOP],
    binaries=[],
    datas=[(os.path.join(HERE, "engine"), "engine")],
    hiddenimports=["clr_loader", "pythonnet", "webview.platforms.edgechromium", "flexshell.lcm_real", "flexshell.webview_hooks"],
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "numpy", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="FlexTextSegmenterFLEx",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    icon=None,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="FlexTextSegmenterFLEx")
