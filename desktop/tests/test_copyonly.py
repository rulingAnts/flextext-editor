"""Copy-only builds fail closed (plan §12.3)."""
import json

import pytest

from flexshell import copyonly
from flexshell.errors import FlexError


def test_no_stamp_means_copy_only(tmp_path):
    assert copyonly.is_copy_only(None) is True
    assert copyonly.is_copy_only(str(tmp_path)) is True


@pytest.mark.parametrize("content", ['{"copyOnlyLifted": "true"}', '{"copyOnlyLifted": 1}', 'true', '{"copyOnlyLifted": true, "x": 1}', 'not json', '{}'])
def test_anything_but_the_exact_stamp_is_copy_only(tmp_path, content):
    (tmp_path / copyonly.STAMP_FILE).write_text(content, encoding="utf-8")
    assert copyonly.is_copy_only(str(tmp_path)) is True


def test_the_exact_stamp_lifts_it(tmp_path):
    (tmp_path / copyonly.STAMP_FILE).write_text(json.dumps({"copyOnlyLifted": True}), encoding="utf-8")
    assert copyonly.is_copy_only(str(tmp_path)) is False


def test_marker_file_allows_a_copy(tmp_path):
    proj = tmp_path / "Proj-copy"
    proj.mkdir()
    with pytest.raises(FlexError) as ei:
        copyonly.check_write_allowed(str(proj), "Proj-copy", copy_only=True)
    assert ei.value.code == "E_COPY_ONLY"
    (proj / copyonly.MARKER_FILE).write_text("disposable", encoding="utf-8")
    copyonly.check_write_allowed(str(proj), "Proj-copy", copy_only=True)   # no raise


def test_protected_name_beats_the_marker(tmp_path):
    proj = tmp_path / "Prod"
    proj.mkdir()
    (proj / copyonly.MARKER_FILE).write_text("x", encoding="utf-8")
    assert copyonly.project_is_disposable_copy(str(proj), "Prod", protected={"Prod"}) is False


def test_release_build_writes_anywhere(tmp_path):
    copyonly.check_write_allowed(str(tmp_path), "Any", copy_only=False)
