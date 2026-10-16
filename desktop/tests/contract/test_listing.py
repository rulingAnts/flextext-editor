"""The text listing the shell sorts and filters by (plan §11.1): FLEx's own dates and genres, on any
project — and a save stamps the text it changed, which "Recently changed in FLEx" relies on."""


def test_the_listing_carries_flex_dates_and_genres(backend):
    texts = backend.list_texts()
    assert texts
    for t in texts:
        assert t["created"] is None or (isinstance(t["created"], int) and t["created"] > 0), t["created"]
        assert t["modified"] is None or (isinstance(t["modified"], int) and t["modified"] > 0), t["modified"]
        assert isinstance(t["genres"], list) and all(set(g) == {"guid", "name"} for g in t["genres"])


def test_a_save_stamps_the_text_it_changed(backend):
    t = sorted(backend.list_texts(), key=lambda x: x["title"])[0]
    seg = backend.read_text(t["guid"])["paragraphs"][0]["segments"][0]
    h = backend.begin_uow("listing", "listing")
    backend.set_free_translation(seg["guid"], backend.writing_systems()["anal"][0]["id"], "stamped")
    backend.commit(h)
    backend.save()
    after = next(x for x in backend.list_texts() if x["guid"] == t["guid"])
    assert after["modified"] is not None and (t["modified"] is None or after["modified"] >= t["modified"])
