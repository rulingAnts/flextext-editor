"""Runs desktop/tests/e2e/flex_media.e2e.mjs: the find-the-recording flow end to end in headless
Chromium against the real Api, the mock FLEx backend, the real local server and the staged engine.
Skipped where node, Playwright or a Chromium is not available (it needs no FLEx and no Windows)."""
import json
import os
import shutil
import subprocess

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))


def _have_playwright():
    node = shutil.which("node")
    if not node:
        return False
    r = subprocess.run([node, "-e", "for (const m of ['playwright','playwright-core']) { try { require(m); process.exit(0); } catch {} } process.exit(1)"],
                       capture_output=True, timeout=30)
    return r.returncode == 0


@pytest.mark.skipif(not _have_playwright(), reason="node + Playwright not available")
def test_find_the_recording_end_to_end(tmp_path):
    from e2e import harness
    info, stop = harness.start(tmp_path)
    try:
        env = dict(os.environ)
        r = subprocess.run(["node", os.path.join(HERE, "e2e", "flex_media.e2e.mjs"), json.dumps(info)],
                           capture_output=True, text=True, timeout=240, env=env)
    finally:
        stop()
    print(r.stdout)
    print(r.stderr)
    if r.returncode == 77:
        pytest.skip("no playwright module")
    assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]
