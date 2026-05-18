"""Segment stabilizer: deduplicates finalized WHL segments, tracks partials."""

from __future__ import annotations

import math
import time

from .events import transcript_event

# Absolute deadline for a single partial segment. WHL's VAD chunks on
# min_silence_duration_ms=500 — a presenter who talks continuously (no >500 ms
# gap) would otherwise keep ONE segment alive indefinitely, never marked
# `completed`, so no `final` is ever emitted. The browser's caption-store
# shows a single unbounded growing partial that visually "freezes". Promoting
# a stuck partial to final at this deadline matches the same fix applied to
# the OpenAI provider's segmentFlushTimer. Dedup with WHL's later
# `completed`=True (if it ever arrives) is handled via `_finalized`.
_MAX_PARTIAL_AGE_SEC = 12.0


class SegmentStabilizer:
    """Tracks WHL segment state across messages; produces normalized TranscriptEvents."""

    def __init__(self, *, uid: str = "session") -> None:
        self._finalized: set[int] = set()
        # WHL restarts segment timestamps at 0 each connection — without a session
        # prefix, a new session's seg-0 collides with the previous session's seg-0
        # in the browser captionStore (overwriting prior content).
        self._uid = uid
        # Wall-clock (monotonic) when each not-yet-completed segment was first
        # observed. Used to enforce the partial-age deadline. Pruned on
        # finalization (either WHL-driven or deadline-driven).
        self._partial_first_seen: dict[int, float] = {}

    def feed(self, segments: list[dict]) -> tuple[list[dict], list[dict]]:
        """Process raw WHL segment list.

        Returns:
            transcript_events: TranscriptEvent dicts to send to browser immediately.
            to_translate: finalized segments queued for MT worker.
        """
        now = time.monotonic()
        transcript_events: list[dict] = []
        to_translate: list[dict] = []

        for seg in segments:
            # WHL returns start/end as strings e.g. "0.000" — convert explicitly
            start_key = math.floor(float(seg["start"]) * 1000)
            if start_key in self._finalized:
                continue
            text = seg["text"].strip()
            if not text:
                continue

            is_completed = bool(seg.get("completed"))
            if not is_completed:
                # Track first-seen for the deadline check, then decide whether
                # to force-promote. If still under the deadline, fall through
                # to the partial-emission block below.
                first_seen = self._partial_first_seen.setdefault(start_key, now)
                if now - first_seen < _MAX_PARTIAL_AGE_SEC:
                    continue

            # WHL marked completed OR we force-promote a stuck partial.
            self._finalized.add(start_key)
            self._partial_first_seen.pop(start_key, None)
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

        # Emit one partial for the last NOT-completed AND not-yet-finalized segment
        # (force-promoted ones are now in `_finalized`, so they're filtered here —
        # critical to avoid a ghost partial overwriting livePartial in the browser
        # store after we already committed the same segmentId as final).
        partial = next(
            (
                s
                for s in reversed(segments)
                if not s.get("completed")
                and math.floor(float(s["start"]) * 1000) not in self._finalized
            ),
            None,
        )
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
