"""Genres and FLEx dates through the bridge, as the text list sorts and filters by them (plan §11.1).
Made-up fixtures."""
from flexshell.api import Api
from flexshell.lcm_mock import MockBackendFactory, MockLcm


def test_genres_and_dates_reach_the_page(tmp_path):
    projects = tmp_path / "Projects"
    projects.mkdir()
    MockLcm.create_project(str(projects), "list-proj", texts=[
        {"title": "one", "paragraphs": ["aaa"], "genres": ["Narrative"], "created": "2024-01-02 03:04:05.000"},
        {"title": "two", "paragraphs": ["bbb"], "genres": ["Narrative", "Procedural"]},
        {"title": "three", "paragraphs": ["ccc"]},
    ])
    api = Api(MockBackendFactory(str(projects)), state_dir=str(tmp_path / "state"))
    try:
        assert api.open_project("list-proj", "read")["ok"]
        by = {t["title"]: t for t in api.list_texts()["result"]}
        assert [g["name"] for g in by["one"]["genres"]] == ["Narrative"]
        assert [g["name"] for g in by["two"]["genres"]] == ["Narrative", "Procedural"]
        assert by["one"]["genres"][0]["guid"] == by["two"]["genres"][0]["guid"], "one genre, one guid: FLEx's list"
        assert by["three"]["genres"] == []
        assert by["one"]["created"] == 1704164645000, "FLEx's date, as epoch milliseconds"
        assert by["two"]["created"] > by["one"]["created"] and by["two"]["modified"] >= by["two"]["created"]
    finally:
        api._worker.stop()
