"""Contract tests run against ANY FlexPort. On Linux: lcm_mock. On the VM: `FLEXSHELL_BACKEND=real
FLEXSHELL_PROJECT=<copy>` runs the same files against lcm_real on a disposable COPY (desktop/vm/
run_conformance.py sets both). A mismatch between the two is a bug in the mock or in lcm_real."""
import os
import shutil
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


FIXTURE_TITLES = {t["title"] for t in TEXTS}
_PRISTINE = {}


def _real_fixture_flextext(path, vern):
    """A made-up .flextext holding TEXTS' titles and one placeholder word per paragraph, in the copy's own default
    vernacular writing system. FLEx's importer makes the Text/StText/StTxtPara objects; the fixture's baseline is
    then assigned and FLEx's own parser segments it, which is what the mock's create_project models."""
    from xml.sax.saxutils import escape
    out = ['<?xml version="1.0" encoding="utf-8"?>', '<document version="2">']
    for t in TEXTS:
        out.append('<interlinear-text><item type="title" lang="en">%s</item><paragraphs>' % escape(t["title"]))
        for _ in t["paragraphs"]:
            out.append('<paragraph><phrases><phrase><words><word><item type="txt" lang="%s">aaa</item></word>'
                       '</words></phrase></phrases></paragraph>' % escape(vern))
        out.append('</paragraphs><languages><language lang="%s" vernacular="true"/><language lang="en"/>'
                   '</languages></interlinear-text>' % escape(vern))
    out.append('</document>')
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(out))


def _real_pristine(tmp_path_factory):
    """Once per run: give the copy the fixture texts (if it has none yet) and keep that .fwdata as the file every
    test starts from — on the mock each test gets a fresh project, and a test that saves must not leave its
    writes for the next one. Never runs outside a marked disposable copy (the fixture below checks first)."""
    if "fw" in _PRISTINE:
        return _PRISTINE
    from flexshell.lcm_real import RealLcm
    name = os.path.basename(REAL_PROJECT.rstrip("\\/"))
    fw = os.path.join(REAL_PROJECT, name + ".fwdata")
    b = RealLcm(os.path.dirname(REAL_PROJECT))
    b.open(name, write=True)
    b.stop_save_timer()
    try:
        if not FIXTURE_TITLES <= {t["title"] for t in b.list_texts()}:
            vern = [w["id"] for w in b.writing_systems()["vern"] if w["isDefault"]][0]
            src = tmp_path_factory.mktemp("fixture") / "contract-fixture.flextext"
            _real_fixture_flextext(str(src), vern)
            h = b.begin_uow("Undo contract fixture", "Redo contract fixture")
            try:
                new = b.import_flextext(str(src))
                by_title = {t["title"]: t["guid"] for t in b.list_texts() if t["guid"] in new}
                for spec in TEXTS:
                    paras = b.read_text(by_title[spec["title"]])["paragraphs"]
                    assert len(paras) == len(spec["paragraphs"]), "the importer made the fixture's paragraphs"
                    for para, contents in zip(paras, spec["paragraphs"]):
                        b.set_contents(para["guid"], contents)
                        b.force_parse(para["guid"])
                b.commit(h)
            except BaseException:
                b.rollback(h)
                raise
            b.save()
            b.complete_all_commits()
    finally:
        b.close_without_save()
    keep = tmp_path_factory.mktemp("pristine") / "pristine.fwdata"
    shutil.copy2(fw, keep)
    _PRISTINE.update(fw=fw, keep=str(keep))
    return _PRISTINE


@pytest.fixture
def backend(tmp_path, tmp_path_factory):
    if BACKEND == "real":
        from flexshell.lcm_real import RealLcm
        from flexshell import copyonly
        assert REAL_PROJECT, "FLEXSHELL_PROJECT must name the disposable copy"
        name = os.path.basename(REAL_PROJECT.rstrip("\\/"))
        assert copyonly.project_is_disposable_copy(REAL_PROJECT, name), "refusing: not a marked disposable copy"
        pristine = _real_pristine(tmp_path_factory)
        shutil.copy2(pristine["keep"], pristine["fw"])   # every test starts from the same file, as on the mock
        b = RealLcm(os.path.dirname(REAL_PROJECT))
        b.open(name, write=True)
        b.stop_save_timer()
        every = b.list_texts
        b.list_texts = lambda: [t for t in every() if t["title"] in FIXTURE_TITLES]   # the fixture texts, never real ones
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
