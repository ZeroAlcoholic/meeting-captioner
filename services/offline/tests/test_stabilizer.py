"""Unit tests for SegmentStabilizer."""

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
