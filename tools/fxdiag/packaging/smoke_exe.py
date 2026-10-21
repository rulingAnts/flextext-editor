"""Prove a BUILT fxdiag executable works — the file that ships, not the source it came from.

    python tools/fxdiag/packaging/smoke_exe.py <exe> [--gui]

Runs the executable with Node REMOVED from PATH, so `.flextext` export can only succeed through the
Node bundled inside it, against the real Chromium fixture (tests/fixtures/profile-fixture.zip, made-up
records): doctor, scan, a full report (texts as .flextext files + the recording + raw storage), and a
USB package built from that report. --gui instead opens the WINDOW with FXDIAG_GUI_SMOKE set and checks
that the page scanned and listed the fixture's origin (gui.py _smoke). Exit 0 = every check passed.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

FIXTURE = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "profile-fixture.zip"


def env_without_node():
    env = dict(os.environ)
    keep = []
    for d in env.get("PATH", "").split(os.pathsep):
        if d and not any((Path(d) / n).is_file() for n in ("node", "node.exe")):
            keep.append(d)
    env["PATH"] = os.pathsep.join(keep)
    env.pop("FXDIAG_NODE", None)
    return env


def run(exe, *args, env=None, timeout=300):
    p = subprocess.run([str(exe), *map(str, args)], capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, timeout=timeout)
    print("$ fxdiag %s  (rc=%d)\n%s%s" % (" ".join(map(str, args)), p.returncode, p.stdout[-3000:], p.stderr[-2000:]))
    return p


def check(cond, what):
    print(("  ok    " if cond else "  FAIL  ") + what)
    if not cond:
        raise SystemExit(1)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    gui = "--gui" in argv
    exe = Path([a for a in argv if a != "--gui"][0]).resolve()
    check(exe.is_file(), "the executable exists: %s (%.1f MB)" % (exe, exe.stat().st_size / 1e6 if exe.is_file() else 0))
    work = Path(tempfile.mkdtemp(prefix="fxdiag-smoke-"))
    ud = work / "User Data"
    with zipfile.ZipFile(FIXTURE) as z:
        z.extractall(ud)
    env = env_without_node()
    check(shutil.which("node", path=env["PATH"]) is None, "no Node on PATH for these runs (only the bundled one can work)")

    if gui:
        out = work / "gui.json"
        genv = dict(env, FXDIAG_GUI_SMOKE=str(out))
        p = subprocess.run([str(exe), "gui", "--user-data-dir", str(ud)], capture_output=True, text=True, errors="replace", env=genv, timeout=180)
        print(p.stdout[-2000:], p.stderr[-2000:])
        check(out.is_file(), "the window opened and reported back (rc=%d)" % p.returncode)
        r = json.loads(out.read_text(encoding="utf-8"))
        print("  window: renderer=%s, shows: %r" % (r.get("renderer"), (r.get("stores") or "")[:300]))
        check("rulingants.github.io" in (r.get("stores") or ""), "the window's scan lists the fixture's origin")
        return 0

    d = run(exe, "doctor", env=env)
    check(d.returncode == 0, "doctor: everything the build needs is present")
    check("(bundled)" in d.stdout, "doctor: the bundled Node is the one in use")
    s = run(exe, "scan", "--user-data-dir", ud, env=env)
    check(s.returncode == 0 and "https://rulingants.github.io" in s.stdout, "scan finds the fixture profile's suite origin")
    rep = work / "report.zip"
    r = run(exe, "report", "--user-data-dir", ud, "--flextext", "--with-audio", "--texts", "all", "--raw", "--out", rep, env=env)
    check(r.returncode == 0 and rep.is_file(), "report written")
    with zipfile.ZipFile(rep) as z:
        names = z.namelist()
        fx = sorted(n.rsplit("/", 1)[1] for n in names if n.endswith(".flextext"))
        check(fx == ["Fixture text one.flextext", "Fixture text two.flextext"], "both texts exported as .flextext: %s" % fx)
        xml = z.read(next(n for n in names if n.endswith("Fixture text one.flextext"))).decode("utf-8")
        check(xml.startswith("<?xml") and "lorem" in xml and "begin-time-offset" in xml and "Fixture text one.wav" in xml,
              "the .flextext is the engine's own writing: words, times, the recording named")
        wav = [n for n in names if n.startswith("export/") and n.endswith(".wav")]
        check(len(wav) == 1 and len(z.read(wav[0])) == 3000, "the recording travels beside it, byte for byte")
        check(any(n.startswith("raw/") for n in names) and not any("Local Storage" in n for n in names if n.startswith("raw/")),
              "raw storage included, and never the profile-wide Local Storage")
        summ = json.loads(z.read("report.json"))
        check(summ["engineSerializer"] not in ("", "unknown"), "the report names the engine serializer: %s" % summ["engineSerializer"])
        man = z.read(next(n for n in names if n.startswith("storage-"))).decode("utf-8")
        check("made-up-token" not in man and "lorem" not in man, "the manifest carries no words and no credential")
    pkg = work / "pkg"
    k = run(exe, "pack", rep, "--out", pkg, "--assign", "vern=xx", "--device", "smoke", env=env)
    check(k.returncode == 0, "pack ran")
    check(sorted(p.name for p in pkg.iterdir()) == ["Fixture text one.flextext", "Fixture text one.wav", "Fixture text two.flextext",
                                                     "MANIFEST.json", "README.txt", "assign.html"], "the USB package holds texts, recording, manifest, link, steps")
    shutil.rmtree(work, ignore_errors=True)
    print("SMOKE PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
