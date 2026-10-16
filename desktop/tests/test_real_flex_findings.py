"""What the first saves to a REAL FLEx project taught (2026-10-16), pinned on the mock — where the mock
had agreed with the shell's mistaken picture of LCM, it now models LCM as its source says.

1. W5 counted LCM's UndoableActionCount, the CHANGES in FLEx's history (ending a task adds DateModified
   changes of its own), as if it were the history ITEMS: every real save of one change "made two items"
   and the project was closed unsaved. The port's undo_item_count is the items (lcm_real reads
   UndoableSequenceCount; test_lcm_real_lib pins that); here, a wrong count closes the project and says
   exactly what was counted.
2. The first approval ever recorded in a project creates the user agent's two CmAgentEvaluation objects
   (CmAgent.SetEvaluation). The disk check must expect them, measured at the write.
3. The FLEx-error watch listened to the ROOT logger: any ERROR anywhere in the process closed the project.
   It listens to pyflexicon's loggers only, and the shell's own console lines never count.
Made-up fixtures."""
import copy
import logging
import types

import pytest

from flexshell import model
from flexshell.errors import FlexError
from flexshell.lcm_mock import DEFAULT_USER_AGENT, MockLcm
from flexshell.protocol import Session


@pytest.fixture
def world(tmp_path):
    projects = tmp_path / "Projects"
    projects.mkdir()
    MockLcm.create_project(str(projects), "copy-real", texts=[{"title": "real", "paragraphs": ["aaa bbb aaa", "ccc ddd"]}])
    (projects / "copy-real" / "flextext-disposable-copy.txt").write_text("x")
    port = MockLcm(str(projects))
    s = Session(port, "copy-real", write=True, copy_only=True, marker_ok=True)
    tg = port.list_texts()[0]["guid"]
    opened = s.open_text(tg)
    return {"port": port, "s": s, "tg": tg, "doc": opened["doc"], "rev": opened["baseRev"], "projects": str(projects)}


def gloss_save(w, line, index, text):
    """Preview a gloss on one word (the engine's way: the post-state promises every other word as it was)."""
    doc = copy.deepcopy(w["doc"])
    ln = doc["paragraphs"][line]
    seg = ln["segments"][0]
    seg["words"][index]["gls"] = text
    out = model.post_state_of(doc, {ln["paraOf"]})
    for ph in out[ln["paraOf"]]:
        ph["words"][index]["analysisGuid"] = None   # glossed anew: LCM's to assign
    op = {"op": "gloss.set", "paraGuid": ln["paraOf"], "segGuid": seg["attrs"]["guid"], "index": index, "forms": {"en": text}}
    return w["s"].preview(w["tg"], w["rev"], [op], out)


def evaluations_on_disk(port):
    from flexshell import diskcheck
    return {g: rt for g, rt in diskcheck.load_rt(port.fwdata_path()).items() if rt["cls"] == "CmAgentEvaluation"}


# ---- 2. the first approval in a project ----------------------------------------------------------------
def test_the_first_approval_creates_the_agents_two_evaluations_and_the_save_passes_the_disk_check(world):
    w, s, port = world, world["s"], world["port"]
    assert port.user_agent() == {"guid": DEFAULT_USER_AGENT, "missingEvaluations": 2}, "a new project has none"
    assert evaluations_on_disk(port) == {}
    pv = gloss_save(w, 0, 0, "first")
    r = s.save(pv["previewToken"])
    assert r["disk"]["ok"] and r["disk"]["changed"].get("CmAgentEvaluation") == 2
    on_disk = evaluations_on_disk(port)
    assert len(on_disk) == 2 and {rt["owner"] for rt in on_disk.values()} == {DEFAULT_USER_AGENT}, "owned by the agent"
    assert port.user_agent()["missingEvaluations"] == 0
    t = port.read_text(w["tg"])
    a = t["paragraphs"][0]["segments"][0]["analyses"][0]
    assert a["kind"] == "gloss" and port.is_approved(a["analysisGuid"]), "approved, as FLEx does"
    # undo removes them with the save (the same check, the deltas negated); redo brings them back
    s.undo_save()
    assert evaluations_on_disk(port) == {} and port.user_agent()["missingEvaluations"] == 2
    s.redo_save()
    assert len(evaluations_on_disk(port)) == 2


def test_a_later_approval_creates_nothing_more(world):
    w, s, port = world, world["s"], world["port"]
    s.save(gloss_save(w, 0, 0, "first")["previewToken"])
    first = set(evaluations_on_disk(port))
    w2 = dict(w, doc=s.open_text(w["tg"])["doc"], rev=s.texts[w["tg"]]["baseRev"])
    r = s.save(gloss_save(w2, 1, 0, "second")["previewToken"])
    assert r["disk"]["ok"] and "CmAgentEvaluation" not in r["disk"]["changed"]
    assert set(evaluations_on_disk(port)) == first


def test_evaluations_a_write_cannot_explain_are_refused():
    """Measured inside the unit of work: only an approval may make them, at most two, never fewer after."""
    s = object.__new__(Session)
    after = {"guid": "agent", "missingEvaluations": 0}
    s.port = types.SimpleNamespace(user_agent=lambda: after)
    assert s._evaluations_made({"guid": "agent", "missingEvaluations": 2}, True) == 2
    assert s._evaluations_made({"guid": "agent", "missingEvaluations": 0}, True) == 0
    assert s._evaluations_made({"guid": "agent", "missingEvaluations": 0}, False) == 0
    with pytest.raises(FlexError) as ei:
        s._evaluations_made({"guid": "agent", "missingEvaluations": 2}, False)   # made with no approval in the save
    assert ei.value.code == "E_INVARIANT"
    after.update(missingEvaluations=2)
    with pytest.raises(FlexError):
        s._evaluations_made({"guid": "agent", "missingEvaluations": 0}, True)    # removed
    after.update(guid="another", missingEvaluations=0)
    with pytest.raises(FlexError):
        s._evaluations_made({"guid": "agent", "missingEvaluations": 2}, True)    # someone else's


# ---- 1. W5: one save, one history item ------------------------------------------------------------------
def test_a_commit_that_does_not_make_exactly_one_history_item_closes_the_project_and_says_what_it_counted(world, monkeypatch):
    w, s, port = world, world["s"], world["port"]
    before = port.read_text(w["tg"])
    pv = gloss_save(w, 0, 0, "never lands")
    monkeypatch.setattr(port, "undo_item_count", lambda: 7)   # as UndoableActionCount read: the same before and after
    with pytest.raises(FlexError) as ei:
        s.save(pv["previewToken"])
    e = ei.value
    assert e.code == "E_INVARIANT" and e.detail["closed"] is True
    assert e.detail["itemsBefore"] == 7 and e.detail["itemsAfter"] == 7 and e.detail["undoText"] == e.detail["expected"]
    assert "items 7 → 7" in e.message
    # closed WITHOUT saving: the project file holds nothing of the save
    assert ("close_without_save",) in port.calls and ("close_project",) not in port.calls
    fresh = MockLcm(world["projects"])
    fresh.open("copy-real", write=False)
    assert fresh.read_text(w["tg"]) == before
    # every later call says the project was closed, and carries what closed it
    with pytest.raises(FlexError) as later:
        s.open_text(w["tg"])
    assert later.value.code == "E_POISONED" and later.value.detail["closed"] is True
    assert later.value.detail["cause"]["code"] == "E_INVARIANT" and "items 7 → 7" in later.value.detail["cause"]["message"]


# ---- 3. the FLEx-error watch ----------------------------------------------------------------------------
def test_the_shells_own_error_lines_never_close_a_project_and_flexs_do(world):
    s = world["s"]
    for name in ("flexshell", "flexshell.page", "flexshell.bridge", "flexshell.save"):
        s.log.handle(logging.LogRecord(name, logging.ERROR, __file__, 0, "a console line", None, None))
    assert s.poisoned is None, "a line the shell printed is a report, not FLEx failing to save"
    s.log.handle(logging.LogRecord("flexicon.code.headless_ui", logging.ERROR, __file__, 0, "ConflictingSave", None, None))
    assert s.poisoned is not None and s.poisoned.code == "E_SAVE_FAILED" and "ConflictingSave" in s.poisoned.message
    assert s.poisoned.detail["closed"] is True
