"""Normalized event factories matching @meeting-audio/contracts schema."""

from datetime import UTC, datetime


def _iso() -> str:
    return datetime.now(UTC).isoformat()


def transcript_event(
    *,
    segment_id: str,
    status: str,
    text: str,
    start_ms: int,
    end_ms: int | None = None,
    confidence: float | None = None,
) -> dict:
    e: dict = {
        "kind": "transcript",
        "provider": "offline-stt",
        "mode": "full_offline",
        "source": "microphone",
        "segmentId": segment_id,
        "status": status,
        "text": text,
        "startMs": start_ms,
    }
    if end_ms is not None:
        e["endMs"] = end_ms
    if confidence is not None:
        e["confidence"] = round(confidence, 4)
    return e


def translation_event(
    *,
    source_segment_id: str,
    status: str,
    source_text: str,
    target_text: str,
    source_language: str,
    target_language: str,
    source_confidence: float | None = None,
) -> dict:
    e: dict = {
        "kind": "translation",
        "provider": "offline-mt",
        "mode": "full_offline",
        "sourceSegmentId": source_segment_id,
        "status": status,
        "sourceText": source_text,
        "targetText": target_text,
        "sourceLanguage": source_language,
        "targetLanguage": target_language,
        "updatedAt": _iso(),
    }
    if source_confidence is not None:
        e["confidence"] = round(source_confidence, 4)
    return e


def health_event(
    *,
    component: str,
    state: str,
    message: str | None = None,
) -> dict:
    e: dict = {
        "kind": "health",
        "component": component,
        "state": state,
        "timestamp": _iso(),
    }
    if message is not None:
        e["message"] = message
    return e
