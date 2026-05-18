"""Unit tests for SegmentStabilizer."""

from unittest.mock import patch

from app.pipeline.stabilizer import SegmentStabilizer


def test_partial_segment_emits_partial_event():
    s = SegmentStabilizer()
    events, to_translate = s.feed([{"start": 0.0, "end": 1.0, "text": "Hello", "completed": False}])
    assert len(events) == 1
    assert events[0]["status"] == "partial"
    assert events[0]["text"] == "Hello"
    assert to_translate == []


def test_completed_segment_emits_final_event():
    s = SegmentStabilizer()
    events, to_translate = s.feed(
        [{"start": 0.0, "end": 2.0, "text": "Hello world.", "completed": True}]
    )
    finals = [e for e in events if e["status"] == "final"]
    assert len(finals) == 1
    assert finals[0]["text"] == "Hello world."
    assert finals[0]["endMs"] == 2000
    assert len(to_translate) == 1
    assert to_translate[0]["text"] == "Hello world."


def test_completed_segment_not_re_emitted():
    s = SegmentStabilizer()
    seg = {"start": 0.0, "end": 2.0, "text": "Once only.", "completed": True}
    _, _ = s.feed([seg])
    events2, to_translate2 = s.feed([seg])
    finals = [e for e in events2 if e["status"] == "final"]
    assert finals == []
    assert to_translate2 == []


def test_mixed_completed_and_partial():
    s = SegmentStabilizer()
    events, to_translate = s.feed(
        [
            {"start": 0.0, "end": 2.0, "text": "Done.", "completed": True},
            {"start": 2.1, "end": 3.0, "text": "In progress", "completed": False},
        ]
    )
    statuses = [e["status"] for e in events]
    assert "final" in statuses
    assert "partial" in statuses
    assert len(to_translate) == 1


def test_empty_text_segments_are_skipped():
    s = SegmentStabilizer()
    events, to_translate = s.feed(
        [{"start": 0.0, "end": 1.0, "text": "   ", "completed": True}]
    )
    finals = [e for e in events if e["status"] == "final"]
    assert finals == []
    assert to_translate == []


def test_multiple_finals_in_one_message():
    s = SegmentStabilizer()
    events, to_translate = s.feed(
        [
            {"start": 0.0, "end": 1.0, "text": "First.", "completed": True},
            {"start": 1.5, "end": 2.5, "text": "Second.", "completed": True},
        ]
    )
    finals = [e for e in events if e["status"] == "final"]
    assert len(finals) == 2
    assert len(to_translate) == 2


def test_stuck_partial_force_promoted_after_deadline():
    """Continuous speech that WHL never marks `completed` must still finalize.

    Regression guard: WHL's VAD chunks on min_silence_duration_ms=500. A
    presenter speaking continuously (no >500ms gap) leaves the segment
    `completed`=False forever — the caption-store sees no finals, history
    stays blank, and LiveCaption shows a single unbounded growing partial
    that visually freezes. The stabilizer's 12s deadline must force-promote
    a stuck partial to final.
    """
    s = SegmentStabilizer()
    seg = {"start": 0.0, "end": 0.5, "text": "Talking continuously", "completed": False}

    # t=0: first sighting → emits as partial, no final yet.
    with patch("app.pipeline.stabilizer.time.monotonic", return_value=0.0):
        events, to_translate = s.feed([seg])
    assert [e["status"] for e in events] == ["partial"]
    assert to_translate == []

    # t=5: still partial, still under the 12s deadline.
    with patch("app.pipeline.stabilizer.time.monotonic", return_value=5.0):
        events, to_translate = s.feed([{**seg, "text": "Talking continuously more"}])
    assert [e["status"] for e in events] == ["partial"]
    assert to_translate == []

    # t=13: deadline crossed → force-promote to final + queue translation.
    with patch("app.pipeline.stabilizer.time.monotonic", return_value=13.0):
        events, to_translate = s.feed(
            [{**seg, "text": "Talking continuously even more"}]
        )
    finals = [e for e in events if e["status"] == "final"]
    partials = [e for e in events if e["status"] == "partial"]
    assert len(finals) == 1, "deadline must force a final"
    assert finals[0]["text"] == "Talking continuously even more"
    assert partials == [], "must NOT also emit a partial for the just-promoted segment (would ghost-rewrite livePartial)"
    assert len(to_translate) == 1


def test_force_promoted_segment_is_not_re_emitted_when_whl_finally_completes():
    """If WHL later marks the same segment completed=True, we must not double-emit."""
    s = SegmentStabilizer()
    seg = {"start": 0.0, "end": 0.5, "text": "x", "completed": False}

    with patch("app.pipeline.stabilizer.time.monotonic", return_value=0.0):
        s.feed([seg])
    with patch("app.pipeline.stabilizer.time.monotonic", return_value=13.0):
        events1, _ = s.feed([seg])
    assert any(e["status"] == "final" for e in events1)

    # WHL later marks it completed — must NOT emit a second final for same start_key.
    completed_seg = {**seg, "end": 14.0, "text": "x extended", "completed": True}
    events2, to_translate2 = s.feed([completed_seg])
    assert [e for e in events2 if e["status"] == "final"] == []
    assert to_translate2 == []


def test_transcript_event_shape():
    s = SegmentStabilizer()
    events, _ = s.feed(
        [{"start": 1.0, "end": 2.0, "text": "Check shape.", "completed": True}]
    )
    ev = next(e for e in events if e["status"] == "final")
    assert ev["kind"] == "transcript"
    assert ev["provider"] == "offline-stt"
    assert ev["mode"] == "full_offline"
    assert ev["source"] == "microphone"
    assert "segmentId" in ev
    assert "startMs" in ev
    assert "endMs" in ev
