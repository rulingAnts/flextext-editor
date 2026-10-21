"""Plan §6.3–§6.5 recipes, as contract tests: what LCM does to segments on a § split, a join, a
one-assignment move (and the two-assignment control), SplitParaAt / MergeParaWithNext with and
without the §, word split/insert, the insertion-point ambiguity, ForceParse by order. Each test
names the verified result it encodes; the recipes module is exercised on top of the raw calls."""
import pytest

from flexshell import segmentation as S
from flexshell.errors import FlexError
from flexshell.lcm_mock import LINE_SEP, SECTION
from flexshell.model import fingerprint_text
from .conftest import first_text


def text_and_para(b, which=0, para=0):
    tg = sorted(b.list_texts(), key=lambda t: t["title"])[which]["guid"]
    t = b.read_text(tg)
    return tg, t["paragraphs"][para]


def guids(p):
    return [s["guid"] for s in p["segments"]]


def analysis_guids(p):
    return [[a["guid"] for a in s["analyses"]] for s in p["segments"]]


def test_fixture_shape_and_invariant(backend):
    tg, p = text_and_para(backend)
    assert len(p["segments"]) == 3, p["contents"]
    assert S.check_invariant(backend, p)
    assert p["segments"][1]["analyses"][-1]["form"] == SECTION, "the § is a phrase-final punct item"


def test_split_phrase_makes_a_hard_line_break_k_keeps_its_guid(backend):
    """Seth, 2026-10-21: a split is a HARD LINE BREAK (Shift+Enter in FLEx), never a §. [verified, VM] LCM makes the
    break its own label segment at k+1 and the new phrase at k+2; k keeps GUID, FT and start time."""
    b = backend
    tg, p = text_and_para(b)
    seg = p["segments"][0]                      # "aaa bbb ccc. "
    h = b.begin_uow("u", "r")
    b.set_free_translation(seg["guid"], "en", "the first")
    b.set_segment_times(seg["guid"], 0, 3000)
    b.commit(h)
    tg, p = text_and_para(b)
    seg = p["segments"][0]
    old_an = analysis_guids(p)
    h = b.begin_uow("u", "r")
    new = S.split_phrase(b, tg, p["guid"], seg["guid"], 0, new_times=((0, 1000), (1000, 3000)))
    b.commit(h)
    tg, p2 = text_and_para(b)
    assert len(p2["segments"]) == 5
    assert p2["segments"][0]["guid"] == seg["guid"] and p2["segments"][2]["guid"] == new
    assert p2["contents"].startswith("aaa " + LINE_SEP + "bbb ccc."), repr(p2["contents"])
    assert SECTION not in p2["contents"][:12], "no § is ever written"
    assert p2["segments"][1]["isLabel"]
    assert p2["segments"][0]["ft"] == {"en": "the first"} and p2["segments"][2]["ft"] == {}
    assert (p2["segments"][0]["beginTime"], p2["segments"][0]["endTime"]) == ("0", "1000")
    assert (p2["segments"][2]["beginTime"], p2["segments"][2]["endTime"]) == ("1000", "3000")
    # the two phrases hold exactly the words the one had, with their analyses
    assert [g for g in analysis_guids(p2)[0] + analysis_guids(p2)[2]] == old_an[0]
    assert S.check_invariant(b, p2)
    # survives ForceParse
    h = b.begin_uow("u", "r")
    b.force_parse(p2["guid"])
    b.commit(h)
    assert guids(text_and_para(b)[1]) == guids(p2)


def test_split_then_join_is_an_exact_round_trip(backend):
    b = backend
    tg, p = text_and_para(b)
    seg = p["segments"][0]
    before = fingerprint_text(b.read_text(tg))
    h = b.begin_uow("u", "r")
    S.split_phrase(b, tg, p["guid"], seg["guid"], 1)
    b.commit(h)
    assert len(text_and_para(b)[1]["segments"]) == 5
    h = b.begin_uow("u", "r")
    S.join_phrases(b, tg, p["guid"], seg["guid"])
    b.commit(h)
    assert fingerprint_text(b.read_text(tg)) == before, "split + join: the same text and the same objects"


def test_join_across_a_hard_line_break_is_one_phrase(backend):
    """Joining always makes ONE phrase, one baseline line: the break goes, the next phrase merges into k (FT joined
    with a space [verified, VM]), k's end time becomes the joined phrase's end."""
    b = backend
    tg, p = text_and_para(b, para=1)                      # "hhh iii jjj"
    seg = p["segments"][0]
    h = b.begin_uow("u", "r")
    second = S.split_phrase(b, tg, p["guid"], seg["guid"], 1, new_times=((1000, 2000), (2000, 3000)))
    b.set_free_translation(seg["guid"], "en", "first")
    b.set_free_translation(second, "en", "second")
    b.commit(h)
    tg, p = text_and_para(b, para=1)
    assert p["contents"] == "hhh iii " + LINE_SEP + "jjj", repr(p["contents"])
    h = b.begin_uow("u", "r")
    S.join_phrases(b, tg, p["guid"], seg["guid"])
    b.commit(h)
    tg, p2 = text_and_para(b, para=1)
    assert p2["contents"] == "hhh iii jjj" and guids(p2) == [seg["guid"]]
    s = p2["segments"][0]
    assert s["ft"] == {"en": "first second"} and (s["beginTime"], s["endTime"]) == ("1000", "3000")
    assert S.check_invariant(b, p2)


def test_join_across_a_break_with_no_space_puts_one_in(backend):
    """A break between two letters (29 of the team's 399): removing it alone would glue the words; a space goes in."""
    b = backend
    tg, p = text_and_para(b, para=1)
    h = b.begin_uow("u", "r")
    b.set_contents(p["guid"], "hhh" + LINE_SEP + "iii jjj")
    b.commit(h)
    tg, p = text_and_para(b, para=1)
    assert len(p["segments"]) == 3
    h = b.begin_uow("u", "r")
    S.join_phrases(b, tg, p["guid"], p["segments"][0]["guid"])
    b.commit(h)
    assert text_and_para(b, para=1)[1]["contents"] == "hhh iii jjj"


def test_join_merges_ft_moves_notes_and_drops_the_second_guid(backend):
    """A § already in the text (FLEx's own importer writes them) is still joined: the § goes."""
    b = backend
    tg, p = text_and_para(b)
    k, nxt = p["segments"][1], p["segments"][2]       # "ddd eee § " | "fff ggg."
    h = b.begin_uow("u", "r")
    b.set_free_translation(k["guid"], "en", "left")
    b.set_free_translation(nxt["guid"], "en", "right")
    b.set_segment_times(k["guid"], 100, 200)
    b.set_segment_times(nxt["guid"], 200, 300)
    b.commit(h)
    h = b.begin_uow("u", "r")
    S.join_phrases(b, tg, p["guid"], k["guid"])
    b.commit(h)
    tg, p2 = text_and_para(b)
    assert guids(p2) == [p["segments"][0]["guid"], k["guid"]]
    s = p2["segments"][1]
    assert s["ft"] == {"en": "left right"}
    assert (s["beginTime"], s["endTime"]) == ("100", "300")
    assert SECTION not in p2["contents"]
    assert [a["form"] for a in s["analyses"]] == ["ddd", "eee", "fff", "ggg", "."]
    assert S.check_invariant(b, p2)


def test_join_at_real_punctuation_is_refused(backend):
    b = backend
    tg, p = text_and_para(b)
    h = b.begin_uow("u", "r")
    with pytest.raises(FlexError) as ei:
        S.join_phrases(b, tg, p["guid"], p["segments"][0]["guid"])   # ends in "."
    assert ei.value.code == "E_SCOPE"
    b.rollback(h)


def test_move_boundary_replaces_a_section_with_a_hard_line_break(backend):
    """ONE assignment takes the old § out and puts a hard line break in at the new place: both phrases keep their
    GUIDs, FTs and times [verified for a §, and for a break, on the VM]."""
    b = backend
    tg, p = text_and_para(b, which=1)                   # "kkk lll § mmm nnn § ooo ppp § qqq rrr § sss ttt"
    k, nxt = p["segments"][0], p["segments"][1]
    h = b.begin_uow("u", "r")
    b.set_free_translation(k["guid"], "en", "A")
    b.set_free_translation(nxt["guid"], "en", "B")
    b.set_segment_times(k["guid"], 0, 1000)
    b.set_segment_times(nxt["guid"], 1000, 2000)
    b.commit(h)
    tg, p = text_and_para(b, which=1)
    an_before = analysis_guids(p)
    h = b.begin_uow("u", "r")
    S.move_boundary(b, tg, p["guid"], k["guid"], 0)     # "kkk ↵lll mmm nnn § …"
    b.commit(h)
    tg, p2 = text_and_para(b, which=1)
    assert p2["contents"].startswith("kkk " + LINE_SEP + "lll mmm nnn " + SECTION), repr(p2["contents"])
    g2 = guids(p2)
    assert g2[0] == k["guid"] and p2["segments"][1]["isLabel"] and g2[2:] == guids(p)[1:]
    assert p2["segments"][0]["ft"] == {"en": "A"} and p2["segments"][2]["ft"] == {"en": "B"}
    assert (p2["segments"][2]["beginTime"], p2["segments"][2]["endTime"]) == ("1000", "2000")
    assert [a["form"] for a in p2["segments"][0]["analyses"]] == ["kkk"]
    assert [a["form"] for a in p2["segments"][2]["analyses"]] == ["lll", "mmm", "nnn", SECTION]
    # analyses restored: lll kept its GUID although it sat inside the diff span
    assert p2["segments"][2]["analyses"][0]["guid"] == an_before[0][1]
    assert S.check_invariant(b, p2)
    h = b.begin_uow("u", "r")
    b.force_parse(p2["guid"])
    b.commit(h)
    assert analysis_guids(text_and_para(b, which=1)[1]) == analysis_guids(p2), "ForceParse then changes nothing"


def test_move_boundary_moves_a_hard_line_break(backend):
    b = backend
    tg, p = text_and_para(b, para=1)                      # "hhh iii jjj"
    seg = p["segments"][0]
    h = b.begin_uow("u", "r")
    second = S.split_phrase(b, tg, p["guid"], seg["guid"], 0, new_times=((1000, 2000), (2000, 3000)))
    b.set_free_translation(second, "en", "second")
    b.commit(h)
    tg, p = text_and_para(b, para=1)
    assert p["contents"] == "hhh " + LINE_SEP + "iii jjj"
    an = analysis_guids(p)
    h = b.begin_uow("u", "r")
    S.move_boundary(b, tg, p["guid"], seg["guid"], 1)     # "hhh iii ↵jjj"
    b.commit(h)
    tg, p2 = text_and_para(b, para=1)
    assert p2["contents"] == "hhh iii " + LINE_SEP + "jjj", repr(p2["contents"])
    assert guids(p2)[0] == seg["guid"] and guids(p2)[2] == second and p2["segments"][1]["isLabel"]
    assert p2["segments"][2]["ft"] == {"en": "second"} and p2["segments"][2]["beginTime"] == "2000"
    assert analysis_guids(p2)[0] == an[0] + [an[2][0]], "iii moved with its analysis"
    assert S.check_invariant(b, p2)


def test_control_two_assignments_lose_the_second_segment(backend):
    """[verified] the control: removing the § and inserting the new one as TWO assignments merges
    then re-splits — the second segment's GUID and times are gone."""
    b = backend
    if not hasattr(b, "inject"):
        pytest.skip("destructive control, mock only")
    tg, p = text_and_para(b, which=1)
    k, nxt = p["segments"][0], p["segments"][1]
    h = b.begin_uow("u", "r")
    b.set_segment_times(nxt["guid"], 1000, 2000)
    old = p["contents"]
    a = old.index(SECTION)
    b.set_contents(p["guid"], old[:a - 1] + old[a + 1:])              # remove " §"
    mid = b.read_text(tg)["paragraphs"][0]["contents"]
    cut = mid.index(" lll")
    b.set_contents(p["guid"], mid[:cut] + " " + SECTION + mid[cut:])  # insert "§" earlier
    b.commit(h)
    tg, p2 = text_and_para(b, which=1)
    assert len(p2["segments"]) == len(p["segments"])
    assert p2["segments"][1]["guid"] != nxt["guid"] and p2["segments"][1]["beginTime"] is None


def test_split_para_at_boundary_moves_whole_segments(backend):
    b = backend
    tg, p = text_and_para(b)
    s1 = p["segments"][1]
    h = b.begin_uow("u", "r")
    b.set_free_translation(s1["guid"], "en", "moves whole")
    b.set_segment_times(s1["guid"], 5, 6)
    b.commit(h)
    tg, p = text_and_para(b)
    st_count = len(b.read_text(tg)["paragraphs"])
    h = b.begin_uow("u", "r")
    newp = S.phrase_to_paragraph(b, tg, p["guid"], p["segments"][0]["guid"])
    b.commit(h)
    t = b.read_text(tg)
    assert len(t["paragraphs"]) == st_count + 1
    p1, p2 = t["paragraphs"][0], t["paragraphs"][1]
    assert p2["guid"] == newp
    assert guids(p1) == [p["segments"][0]["guid"]] and guids(p2) == guids(p)[1:]
    assert p2["segments"][0]["ft"] == {"en": "moves whole"} and p2["segments"][0]["beginTime"] == "5"
    assert p1["contents"].rstrip().endswith(".")       # ended in real punctuation: nothing removed
    assert S.check_invariant(b, p1) and S.check_invariant(b, p2)


def test_split_para_after_a_section_removes_the_trailing_marker(backend):
    b = backend
    tg, p = text_and_para(b, which=1)
    h = b.begin_uow("u", "r")
    newp = S.phrase_to_paragraph(b, tg, p["guid"], p["segments"][1]["guid"])
    b.commit(h)
    t = b.read_text(tg)
    p1 = t["paragraphs"][0]
    assert p1["contents"] == "kkk lll " + SECTION + " mmm nnn", repr(p1["contents"])
    assert guids(p1) == guids(p)[:2] and guids(t["paragraphs"][1]) == guids(p)[2:]


def test_control_split_para_mid_segment_duplicates_the_ft(backend):
    b = backend
    if not hasattr(b, "inject"):
        pytest.skip("destructive control, mock only")
    tg, p = text_and_para(b)
    s0 = p["segments"][0]
    h = b.begin_uow("u", "r")
    b.set_free_translation(s0["guid"], "en", "dup")
    b.set_segment_times(s0["guid"], 1, 2)
    b.split_para_at(p["guid"], 4)       # inside "aaa bbb ccc."
    b.commit(h)
    t = b.read_text(tg)
    assert t["paragraphs"][1]["segments"][0]["ft"] == {"en": "dup"} and t["paragraphs"][1]["segments"][0]["beginTime"] is None


def test_paragraph_toggle_on_at_a_hard_line_break_takes_the_break_out(backend):
    """The paragraph toggle ON where two phrases are parted by a hard line break: a paragraph boundary takes its place
    [verified, VM 2026-10-21: SplitParaAt at the next phrase, then the trailing break deleted]."""
    b = backend
    tg, p = text_and_para(b, para=1)                      # "hhh iii jjj"
    seg = p["segments"][0]
    h = b.begin_uow("u", "r")
    second = S.split_phrase(b, tg, p["guid"], seg["guid"], 1, new_times=((1000, 2000), (2000, 3000)))
    b.set_free_translation(second, "en", "second")
    b.commit(h)
    tg, p = text_and_para(b, para=1)
    n_paras = len(b.read_text(tg)["paragraphs"])
    h = b.begin_uow("u", "r")
    newp = S.phrase_to_paragraph(b, tg, p["guid"], seg["guid"])
    b.commit(h)
    t = b.read_text(tg)
    assert len(t["paragraphs"]) == n_paras + 1
    p1, p2 = t["paragraphs"][1], t["paragraphs"][2]
    assert p2["guid"] == newp
    assert p1["contents"] == "hhh iii" and guids(p1) == [seg["guid"]], repr(p1["contents"])
    assert p2["contents"] == "jjj" and guids(p2) == [second]
    assert p2["segments"][0]["ft"] == {"en": "second"} and p2["segments"][0]["beginTime"] == "2000"
    assert S.check_invariant(b, p1) and S.check_invariant(b, p2)


def test_paragraph_toggle_off_keeps_every_segment_with_a_hard_line_break_between(backend):
    """The paragraph toggle OFF: separate phrases, ONE paragraph — a hard line break at P's end (after a space, as
    FLEx's Shift+Enter leaves it), then MergeParaWithNext [verified, VM 2026-10-21]; P ends in "." here, and the break
    is still written: every phrase the app shows is its own line in FLEx's Baseline."""
    b = backend
    t = b.read_text(first_text(b)["guid"])
    tg = t["guid"]
    p, q = t["paragraphs"][0], t["paragraphs"][1]
    h = b.begin_uow("u", "r")
    b.set_free_translation(q["segments"][0]["guid"], "en", "q keeps this")
    b.set_segment_times(q["segments"][0]["guid"], 7, 8)
    b.commit(h)
    h = b.begin_uow("u", "r")
    S.paragraph_to_phrase(b, tg, p["guid"])
    b.commit(h)
    t2 = b.read_text(tg)
    assert len(t2["paragraphs"]) == 1
    m = t2["paragraphs"][0]
    assert m["contents"] == p["contents"] + " " + LINE_SEP + q["contents"], repr(m["contents"])
    g = guids(m)
    assert g[:len(p["segments"])] == guids(p) and g[len(p["segments"]) + 1:] == guids(q)
    assert m["segments"][len(p["segments"])]["isLabel"]
    s = m["segments"][-1]
    assert s["ft"] == {"en": "q keeps this"} and s["beginTime"] == "7"
    assert S.check_invariant(b, m)


def test_paragraph_toggle_off_then_join_is_one_phrase(backend):
    """The Matcher's ⤴ across a paragraph: the toggle off, then the join that takes the break out again."""
    b = backend
    t = b.read_text(sorted(b.list_texts(), key=lambda x: x["title"])[1]["guid"])
    tg, p = t["guid"], t["paragraphs"][0]                 # "kkk lll § mmm nnn § ooo ppp § qqq rrr § sss ttt"
    h = b.begin_uow("u", "r")
    b.split_para_at(p["guid"], p["segments"][-1]["begin"])   # make a Q: "sss ttt"
    c = b.read_text(tg)["paragraphs"][0]["contents"]
    b.set_contents(p["guid"], c[:c.rindex(SECTION)].rstrip())   # P now ends "qqq rrr" — no mark of its own
    b.commit(h)
    t = b.read_text(tg)
    P, Q = t["paragraphs"]
    last = P["segments"][-1]
    h = b.begin_uow("u", "r")
    b.set_segment_times(last["guid"], 100, 200)
    b.set_segment_times(Q["segments"][0]["guid"], 200, 300)
    b.commit(h)
    h = b.begin_uow("u", "r")
    S.paragraph_to_phrase(b, tg, P["guid"])
    S.join_phrases(b, tg, P["guid"], last["guid"])
    b.commit(h)
    t2 = b.read_text(tg)
    assert len(t2["paragraphs"]) == 1
    m = t2["paragraphs"][0]
    assert m["contents"].endswith("qqq rrr sss ttt"), repr(m["contents"])
    assert guids(m) == guids(P) and (m["segments"][-1]["beginTime"], m["segments"][-1]["endTime"]) == ("100", "300")
    assert LINE_SEP not in m["contents"] and S.check_invariant(b, m)


def test_control_merge_without_section_merges_the_edge_segments(backend):
    b = backend
    if not hasattr(b, "inject"):
        pytest.skip("destructive control, mock only")
    t = b.read_text(sorted(b.list_texts(), key=lambda x: x["title"])[1]["guid"])
    tg, p = t["guid"], t["paragraphs"][0]
    h = b.begin_uow("u", "r")
    b.split_para_at(p["guid"], p["segments"][-1]["begin"])
    b.commit(h)
    t = b.read_text(tg)
    p, q = t["paragraphs"]
    h = b.begin_uow("u", "r")
    b.set_segment_times(q["segments"][0]["guid"], 9, 10)
    b.set_free_translation(p["segments"][-1]["guid"], "en", "P")
    b.set_free_translation(q["segments"][0]["guid"], "en", "Q")
    # strip P's trailing "§ " first so there is NO EOS at the join
    c = p["contents"]
    b.set_contents(p["guid"], c[:c.rindex(SECTION) - 1])
    b.merge_para_with_next(p["guid"])
    b.commit(h)
    t2 = b.read_text(tg)
    last = t2["paragraphs"][0]["segments"][-1]
    assert last["ft"] == {"en": "P Q"} and last["beginTime"] is None, "the second's times deleted, FTs concatenated"
    assert q["segments"][0]["guid"] not in guids(t2["paragraphs"][0])


def test_word_split_only_touches_that_word(backend):
    b = backend
    tg, p = text_and_para(b)
    seg = p["segments"][0]
    before = analysis_guids(p)
    counts = b.counts()
    h = b.begin_uow("u", "r")
    a, c = S.split_word(b, tg, p["guid"], seg["guid"], 1, 2)          # "bbb" → "bb b"
    b.commit(h)
    tg, p2 = text_and_para(b)
    assert p2["contents"].startswith("aaa bb b ccc.")
    an = p2["segments"][0]["analyses"]
    assert [x["form"] for x in an] == ["aaa", "bb", "b", "ccc", "."]
    assert an[0]["guid"] == before[0][0] and an[3]["guid"] == before[0][2] and an[4]["guid"] == before[0][3]
    assert an[1]["kind"] == "wordform" and an[2]["kind"] == "wordform"
    assert guids(p2) == guids(p) and S.check_invariant(b, p2)
    after = b.counts()
    assert after["WfiWordform"] - counts["WfiWordform"] in (1, 2) and after["Segment"] == counts["Segment"]
    assert b.undo() == "kuresSuccess"
    assert b.counts() == counts, "undo restores all counts, no orphan wordforms"


def test_insert_word_handles_the_insertion_point_ambiguity_and_the_duplicate_shift(backend):
    b = backend
    tg, p = text_and_para(b)
    seg = p["segments"][0]                                   # aaa bbb ccc.
    before = analysis_guids(p)[0]
    # after "aaa": LCM reports the diff one character later; the recipe computes it LCM's way
    h = b.begin_uow("u", "r")
    S.insert_word(b, tg, p["guid"], seg["guid"], 1, "xyz")
    b.commit(h)
    tg, p2 = text_and_para(b)
    an = p2["segments"][0]["analyses"]
    assert [x["form"] for x in an] == ["aaa", "xyz", "bbb", "ccc", "."]
    assert [x["guid"] for x in an if x["form"] != "xyz"] == before
    # a copy of a word next to itself: the existing analysis must stay on the ORIGINAL (second) copy
    h = b.begin_uow("u", "r")
    b.set_free_translation(seg["guid"], "en", "x")   # noop content
    b.commit(h)
    tg, p3 = text_and_para(b)
    g_bbb = p3["segments"][0]["analyses"][2]["guid"]
    h = b.begin_uow("u", "r")
    S.insert_word(b, tg, p["guid"], seg["guid"], 2, "bbb")   # before the existing bbb
    b.commit(h)
    tg, p4 = text_and_para(b)
    an = p4["segments"][0]["analyses"]
    assert [x["form"] for x in an] == ["aaa", "xyz", "bbb", "bbb", "ccc", "."]
    assert an[3]["guid"] == g_bbb, "the analysis stays with the original copy, not the first"


def test_force_parse_realigns_by_order_a_boundary_without_punctuation_does_not_survive(backend):
    """[verified] consequence: a segment created at a word gap with no punctuation slides onto the
    next segment's text and the last is deleted with its FT. Mock-only (it needs a raw segment object
    inserted behind LCM's back, which the recipes never do)."""
    b = backend
    if not hasattr(b, "inject"):
        pytest.skip("mock only")
    tg, p = text_and_para(b, which=1)
    h = b.begin_uow("u", "r")
    for i, s in enumerate(p["segments"]):
        b.set_free_translation(s["guid"], "en", "FT%d" % i)
    para = b.store[p["guid"]]
    s0 = b.store[p["segments"][0]["guid"]]
    fake = b._new_segment(p["guid"], 4, s0["EndOffset"])      # a boundary at the gap "kkk |lll"
    fake["FreeTranslation"] = {"en": "FAKE"}
    s0["EndOffset"] = 4
    para["Segments"].insert(1, fake.guid)
    assert not S.check_invariant(b, b.read_text(tg)["paragraphs"][0]), "fragile"
    b.force_parse(p["guid"])
    b.commit(h)
    p2 = b.read_text(tg)["paragraphs"][0]
    assert len(p2["segments"]) == len(p["segments"])
    assert [s["ft"]["en"] for s in p2["segments"]] == ["FT0", "FAKE", "FT1", "FT2", "FT3"], "everything slid one place; FT4 was deleted"
    # and the shell refuses to edit a fragile paragraph
    h = b.begin_uow("u", "r")
    para["Segments"].insert(1, b._new_segment(p["guid"], 4, 8).guid)
    with pytest.raises(FlexError) as ei:
        S.split_phrase(b, tg, p["guid"], p["segments"][0]["guid"], 0)
    assert ei.value.code == "E_FRAGILE_PARAGRAPH"
    b.rollback(h)


def test_word_split_offset_and_scope_errors(backend):
    b = backend
    tg, p = text_and_para(b)
    seg = p["segments"][0]
    h = b.begin_uow("u", "r")
    for args, code in (((1, 0), "E_SCOPE"), ((1, 3), "E_SCOPE"), ((4, 1), "E_SCOPE"), ((9, 1), "E_SCOPE")):
        with pytest.raises(FlexError) as ei:
            S.split_word(b, tg, p["guid"], seg["guid"], *args)
        assert ei.value.code == code
    with pytest.raises(FlexError) as ei:
        S.insert_word(b, tg, p["guid"], seg["guid"], 0, "two words")
    assert ei.value.code == "E_SCOPE"
    b.rollback(h)
