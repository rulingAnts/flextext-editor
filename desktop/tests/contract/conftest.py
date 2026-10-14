"""Contract tests run against ANY FlexPort. On Linux: lcm_mock. On the VM: `FLEXSHELL_BACKEND=real
FLEXSHELL_PROJECT=<copy>` runs the same files against lcm_real on a disposable COPY (desktop/vm/
run_conformance.py sets both). A mismatch between the two is a bug in the mock or in lcm_real."""
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from flexshell.lcm_mock import MockLcm  # noqa: E402

BACKEND = os.environ.get("FLEXSHELL_BACKEND", "mock")
REAL_PROJECT = os.environ.get("FLEXSHELL_PROJECT")

TEXTS = [
    {"title": "fixture one", "paragraphs": ["aaa bbb ccc. ddd eee \u00a7 fff ggg.", "hhh iii jjj"]},
    {"title": "fixture two", "paragraphs": ["kkk lll \u00a7 mmm nnn \u00a7 ooo ppp \u00a7 qqq rrr \u00a7 sss ttt"]},
]


@pytest.fixture
def backend(tmp_path):
    if BACKEND == "real":
        from flexshell.lcm_real import RealLcm
        from flexshell import copyonly
        assert REAL_PROJECT, "FLEXSHELL_PROJECT must name the disposable copy"
        name = os.path.basename(REAL_PROJECT.rstrip("\\/"))
        assert copyonly.project_is_disposable_copy(REAL_PROJECT, name), "refusing: not a marked disposable copy"
        b = RealLcm(os.path.dirname(REAL_PROJECT))
        b.open(name, write=True)
        b.stop_save_timer()
        yield b
        if b._open:
            b.close_without_save()
        return
    projects = tmp_path / "Projects"
    projects.mkdir()
    MockLcm.create_project(str(projects), "copy-a", texts=TEXTS)
    (projects / "copy-a" / "flextext-disposable-copy.txt").write_text("x")
    b = MockLcm(str(projects))
    b.open("copy-a", write=True)
    b.stop_save_timer()
    yield b
    if b._open:
        b.close_without_save()


def first_text(b):
    return sorted(b.list_texts(), key=lambda t: t["title"])[0]
