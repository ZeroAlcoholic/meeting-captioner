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
# the OpenAI provider's segmentFlushTimer.
_MAX_PARTIAL_AGE_SEC = 12.0


class SegmentStabilizer:
    """Tracks WHL segment state across messages; produces normalized TranscriptEvents.

    Sliced-emission model: a single WHL `start_key` can produce MULTIPLE
    finals over its lifetime (versioned via `-v2`, `-v3` suffixes on the
    browser segment_id). Necessary because long continuous speech may be
    force-promoted before WHL itself marks the segment completed — and the
    continuation text after each promotion still has to flow to the user.

    Per `start_key` we remember:
      * `version`     – how many slices we've finalized so far (0 = none yet)
      * `emitted_chars` – cumulative text length already finalized; everything
        past this offset on the next message is the unemitted delta
      * `first_seen`  – monotonic time of THIS slice's first observation,
        used by the partial-age deadline; reset each time we finalize a slice
    """

    def __init__(self, *, uid: str = "session") -> None:
        # WHL restarts segment timestamps at 0 each connection — without a
        # session prefix, a new session's seg-0 collides with the previous
        # session's seg-0 in the browser captionStore.
        self._uid = uid
        self._slices: dict[int, dict] = {}

    def _slice_state(self, start_key: int, now: float) -> dict:
        return self._slices.setdefault(
            start_key, {"version": 0, "emitted_chars": 0, "first_seen": now}
        )

    def _segment_id(self, start_key: int, version: int) -> str:
        # v1 keeps the legacy `-seg-{start_key}` form so older captionStore
        # consumers and tests stay happy. v2+ append `-v{N}` so the browser
        # treats each slice as a distinct caption row.
        suffix = f"-v{version}" if version > 1 else ""
        return f"{self._uid}-seg-{start_key}{suffix}"

    def feed(self, segments: list[dict]) -> tuple[list[dict], list[dict]]:
        """Process raw WHL segment list.

        Returns:
            transcript_events: TranscriptEvent dicts to send to browser immediately.
            to_translate: finalized slices queued for MT worker.
        """
        now = time.monotonic()
        transcript_events: list[dict] = []
        to_translate: list[dict] = []

        for seg in segments:
            # WHL returns start/end as strings e.g. "0.000" — convert explicitly
            start_key = math.floor(float(seg["start"]) * 1000)
            text = seg["text"].strip()
            if not text:
                continue

            slc = self._slice_state(start_key, now)
            # The "unemitted" portion is the text past everything we've already
            # committed as final. If WHL revised the text to be shorter or
            # different, we accept the loss rather than emit a conflicting
            # rewrite (caption history mid-revision is jarring to read).
            unemitted = text[slc["emitted_chars"]:].strip() if slc["emitted_chars"] > 0 else text
            if not unemitted:
                continue

            is_completed = bool(seg.get("completed"))
            age = now - slc["first_seen"]
            should_force = (not is_completed) and (age > _MAX_PARTIAL_AGE_SEC)

            if not is_completed and not should_force:
                # Still partial, still within the age window — handled by the
                # partial-emit block at the end of the loop.
                continue

            # WHL marked completed OR we force-promote a stuck slice.
            next_version = slc["version"] + 1
            slc["version"] = next_version
            slc["emitted_chars"] = len(text)
            slc["first_seen"] = now  # next slice's deadline starts now
            seg_id = self._segment_id(start_key, next_version)
            end_ms = math.floor(float(seg["end"]) * 1000)
            transcript_events.append(
                transcript_event(
                    segment_id=seg_id,
                    status="final",
                    text=unemitted,
                    start_ms=start_key,
                    end_ms=end_ms,
                )
            )
            to_translate.append({"segment_id": seg_id, "text": unemitted})

        # Emit one partial for the latest not-yet-completed segment. If we've
        # already promoted slice(s) for this start_key, show ONLY the delta as
        # the live partial — otherwise the browser would see the full
        # accumulated text re-arriving each tick and the live caption would
        # appear to scroll back to the beginning of the long utterance every
        # time the deadline fires.
        partial = next(
            (s for s in reversed(segments) if not s.get("completed")),
            None,
        )
        if partial:
            text = partial["text"].strip()
            if text:
                partial_start = math.floor(float(partial["start"]) * 1000)
                slc = self._slices.get(partial_start)
                if slc and slc["emitted_chars"] > 0:
                    unemitted = text[slc["emitted_chars"]:].strip()
                    next_version = slc["version"] + 1
                else:
                    unemitted = text
                    next_version = 1
                if unemitted:
                    transcript_events.append(
                        transcript_event(
                            segment_id=self._segment_id(partial_start, next_version),
                            status="partial",
                            text=unemitted,
                            start_ms=partial_start,
                        )
                    )

        return transcript_events, to_translate
