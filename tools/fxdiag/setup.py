"""Build hook: stage the engine's SERIALIZER into the wheel, so `fxdiag --flextext` writes .flextext
files with the suite's own writer (docs/js/flextext.js + its one import, segments.js) and never a
Python re-implementation that would drift from it (CLAUDE.md: engine code lives in docs/js, once).
pip clones the whole repository and builds in tools/fxdiag/, so ../../docs/js is at hand; a bare
sdist without it builds without an engine and `--flextext` says so at run time."""
import os
import re
import shutil

from setuptools import setup
from setuptools.command.build_py import build_py as _build_py

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE_FILES = ("flextext.js", "segments.js")


class build_py(_build_py):
    def run(self):
        super().run()
        src = os.path.join(HERE, "..", "..", "docs", "js")
        if not os.path.isfile(os.path.join(src, "flextext.js")):
            self.announce("fxdiag: no ../../docs/js beside tools/fxdiag - building without the engine serializer", level=3)
            return
        out = os.path.join(self.build_lib, "fxdiag", "engine", "js")
        os.makedirs(out, exist_ok=True)
        for name in ENGINE_FILES:
            shutil.copy2(os.path.join(src, name), os.path.join(out, name))
        m = re.search(r"ENGINE_VERSION\s*=\s*'([^']+)'", open(os.path.join(src, "i18n.js"), encoding="utf-8").read())
        with open(os.path.join(self.build_lib, "fxdiag", "engine", "ENGINE_VERSION"), "w", encoding="utf-8") as f:
            f.write((m.group(1) if m else "unknown") + "\n")


setup(cmdclass={"build_py": build_py})
