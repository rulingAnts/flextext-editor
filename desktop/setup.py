"""Build hook: stage the engine into the wheel (see pyproject.toml).

pip clones the whole repository and builds in desktop/, so ../docs and ../satellites are at hand;
build/stage_engine.py copies them into flexshell/engine inside the build tree and FAILS on any
off-origin subresource. A checkout without docs/ (a bare sdist) builds without an engine and the
app says so at start (engine_root()). Pure Python; no bash anywhere.
"""
import os
import sys

from setuptools import setup
from setuptools.command.build_py import build_py as _build_py

HERE = os.path.dirname(os.path.abspath(__file__))


class build_py(_build_py):
    def run(self):
        super().run()
        sys.path.insert(0, os.path.join(HERE, "build"))
        import stage_engine
        docs = os.path.join(HERE, "..", "docs")
        if not os.path.isfile(os.path.join(docs, "index.html")):
            self.announce("stage_engine: no ../docs beside desktop/ — building without a staged engine", level=3)
            return
        out = os.path.join(self.build_lib, "flexshell", "engine")
        stage_engine.stage(out, "audio-segmenter", docs)


setup(cmdclass={"build_py": build_py})
