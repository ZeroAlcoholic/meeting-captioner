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
    assert partials == [], (
        "must NOT also emit a partial for the just-promoted segment "
        "(would ghost-rewrite livePartial)"
    )
    assert len(to_translate) == 1


def test_force_promoted_then_whl_completed_emits_continuation_slice():
    """Codex review regression: continuous speech that gets force-promoted at
    12s MUST NOT lose the text WHL adds afterward. We emit the post-cutoff
    delta as a second slice (-v2) so the user sees every word.
    """
    s = SegmentStabilizer()

    # t=0: WHL emits partial "Hello world"
    with patch("app.pipeline.stabilizer.time.monotonic", return_value=0.0):
        s.feed([{"start": 0.0, "end": 0.5, "text": "Hello world", "completed": False}])

    # t=13: deadline crossed, partial promoted to final (slice v1).
    with patch("app.pipeline.stabilizer.time.monotonic", return_value=13.0):
        events1, to_translate1 = s.feed(
            [
                {
                    "start": 0.0,
                    "end": 13.0,
                    "text": "Hello world this is the first half",
                    "completed": False,
                }
            ],
        )
    finals_v1 = [e for e in events1 if e["status"] == "final"]
    assert len(finals_v1) == 1
    assert finals_v1[0]["segmentId"].endswith("-seg-0")  # v1 = legacy id
    assert finals_v1[0]["text"] == "Hello world this is the first half"
    assert to_translate1[0]["text"] == "Hello world this is the first half"

    # t=20: WHL FINALLY marks the segment completed with extended text.
    # Without the slice model the appended "and now the second half" would
    # be silently dropped — that's the Codex-flagged bug.
    completed_seg = {"start": 0.0, "end": 20.0,
                     "text": "Hello world this is the first half and now the second half",
                     "completed": True}
    with patch("app.pipeline.stabilizer.time.monotonic", return_value=20.0):
        events2, to_translate2 = s.feed([completed_seg])
    finals_v2 = [e for e in events2 if e["status"] == "final"]
    assert len(finals_v2) == 1
    # v2 suffix flags it as a continuation in the browser captionStore.
    assert finals_v2[0]["segmentId"].endswith("-seg-0-v2")
    # Only the delta (post-cutoff text) is emitted as the new slice.
    assert finals_v2[0]["text"].strip() == "and now the second half"
    assert to_translate2[0]["text"].strip() == "and now the second half"


def test_multiple_force_promotes_emit_v2_v3_v4_slices():
    """Very long monologue (>24s continuous) should chain force-promotes
    without losing any text — each slice gets its own version suffix."""
    s = SegmentStabilizer()
    base = {"start": 0.0, "end": 30.0, "completed": False}

    # t=0
    with patch("app.pipeline.stabilizer.time.monotonic", return_value=0.0):
        s.feed([{**base, "text": "first slice content here"}])
    # t=13 — first force-promote (v1)
    with patch("app.pipeline.stabilizer.time.monotonic", return_value=13.0):
        events1, _ = s.feed([{**base, "text": "first slice content here"}])
    finals1 = [e for e in events1 if e["status"] == "final"]
    assert len(finals1) == 1
    assert finals1[0]["segmentId"].endswith("-seg-0")  # v1

    # t=26 — second force-promote (v2). WHL extended the text further.
    extended = "first slice content here second slice content also here"
    with patch("app.pipeline.stabilizer.time.monotonic", return_value=26.0):
        events2, _ = s.feed([{**base, "text": extended}])
    finals2 = [e for e in events2 if e["status"] == "final"]
    assert len(finals2) == 1
    assert finals2[0]["segmentId"].endswith("-seg-0-v2")
    assert finals2[0]["text"].strip() == "second slice content also here"


def test_partial_after_force_promote_shows_only_delta():
    """Live caption (partial) for a force-promoted segment shows the
    unemitted suffix only — otherwise the user would see the live area
    jump back to the start of the long utterance every render."""
    s = SegmentStabilizer()
    base = {"start": 0.0, "end": 13.0, "completed": False}

    # First slice emitted as final.
    with patch("app.pipeline.stabilizer.time.monotonic", return_value=0.0):
        s.feed([{**base, "text": "promoted first chunk"}])
    with patch("app.pipeline.stabilizer.time.monotonic", return_value=13.0):
        s.feed([{**base, "text": "promoted first chunk"}])

    # WHL still hasn't completed. New partial arrives with extended text but
    # still under the next deadline — should appear as a -v2 partial with
    # ONLY the delta text.
    with patch("app.pipeline.stabilizer.time.monotonic", return_value=15.0):
        events, _ = s.feed(
            [{**base, "text": "promoted first chunk plus new live words"}],
        )
    partials = [e for e in events if e["status"] == "partial"]
    assert len(partials) == 1
    assert partials[0]["segmentId"].endswith("-seg-0-v2")
    assert partials[0]["text"].strip() == "plus new live words"


def test_whl_revision_shorter_text_is_accepted_loss_not_duplicate():
    """If WHL revises a segment to be shorter/different after we've already
    emitted, we accept the loss rather than emit conflicting text. Mid-meeting
    history rewrites are more jarring than missing a revision."""
    s = SegmentStabilizer()
    base = {"start": 0.0, "end": 13.0, "completed": False}

    with patch("app.pipeline.stabilizer.time.monotonic", return_value=0.0):
        s.feed([{**base, "text": "the original transcription"}])
    with patch("app.pipeline.stabilizer.time.monotonic", return_value=13.0):
        s.feed([{**base, "text": "the original transcription"}])

    # WHL revises to a shorter completed version.
    revised = {"start": 0.0, "end": 14.0, "text": "the original", "completed": True}
    with patch("app.pipeline.stabilizer.time.monotonic", return_value=14.0):
        events, to_translate = s.feed([revised])
    assert [e for e in events if e["status"] == "final"] == []
    assert to_translate == []


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
