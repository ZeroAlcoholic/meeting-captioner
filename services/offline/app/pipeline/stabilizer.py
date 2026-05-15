"""Segment stabilizer: deduplicates finalized WHL segments, tracks partials."""

from __future__ import annotations

import math

from .events import transcript_event


class SegmentStabilizer:
    """Tracks WHL segment state across messages; produces normalized TranscriptEvents."""

    def __init__(self, *, uid: str = "session") -> None:
        self._finalized: set[int] = set()
        # WHL restarts segment timestamps at 0 each connection — without a session
        # prefix, a new session's seg-0 collides with the previous session's seg-0
        # in the browser captionStore (overwriting prior content).
        self._uid = uid

    def feed(self, segments: list[dict]) -> tuple[list[dict], list[dict]]:
        """Process raw WHL segment list.

        Returns:
            transcript_events: TranscriptEvent dicts to send to browser immediately.
            to_translate: finalized segments queued for MT worker.
        """
        transcript_events: list[dict] = []
        to_translate: list[dict] = []

        for seg in segments:
            if not seg.get("completed"):
                continue
            # WHL returns start/end as strings e.g. "0.000" — convert explicitly
            start_key = math.floor(float(seg["start"]) * 1000)
            if start_key in self._finalized:
                continue
            text = seg["text"].strip()
            if not text:
                continue
            self._finalized.add(start_key)
            seg_id = f"{self._uid}-seg-{start_key}"
            end_ms = math.floor(float(seg["end"]) * 1000)
            transcript_events.append(
                transcript_event(
                    segment_id=seg_id,
                    status="final",
                    text=text,
                    start_ms=start_key,
                    end_ms=end_ms,
                )
            )
            to_translate.append({"segment_id": seg_id, "text": text})

        # Emit partial for the last non-completed segment (live preview).
        # Use WHL's actual start time so the segmentId matches when it later gets finalized,
        # allowing the translation lookup in the UI to work correctly.
        partial = next((s for s in reversed(segments) if not s.get("completed")), None)
        if partial:
            text = partial["text"].strip()
            if text:
                partial_start = math.floor(float(partial["start"]) * 1000)
                transcript_events.append(
                    transcript_event(
                        segment_id=f"{self._uid}-seg-{partial_start}",
                        status="partial",
                        text=text,
                        start_ms=partial_start,
                    )
                )

        return transcript_events, to_translate


