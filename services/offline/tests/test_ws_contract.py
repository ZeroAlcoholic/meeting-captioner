"""WebSocket protocol contract tests.

Verifies the cross-layer message contract between the browser-side
OfflineSTTProvider and the offline service — message shapes, event schemas,
and lifecycle health sequence.

These are distinct from test_ws_pipeline.py (which focuses on functional
behaviour) in that they validate the *protocol fields* the browser expects.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app

# ── Shared mock infrastructure (minimal copy — avoids import coupling) ────────

SERVER_READY = json.dumps({"uid": "x", "message": "SERVER_READY"})

_FINAL_SEG = json.dumps({
    "uid": "x",
    "segments": [
        {"start": 0.5, "end": 2.0, "text": "The policyholder must sign.", "completed": True},
    ],
})


class _MockWhlWs:
    def __init__(self, messages: list[str | bytes]) -> None:
        self._messages = messages
        self.sent: list = []

    async def send(self, data) -> None:
        self.sent.append(data)

    async def close(self) -> None:
        pass

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for msg in self._messages:
            yield msg


class _MockConnect:
    def __init__(self, messages: list[str | bytes]) -> None:
        self._ws = _MockWhlWs(messages)

    async def __aenter__(self):
        return self._ws

    async def __aexit__(self, *args):
        pass


def _mock_connect(messages: list[str | bytes]):
    def _connect(*args, **kwargs):
        return _MockConnect(messages)
    return _connect


def _read_until_closed(ws_client) -> list[dict]:
    received = []
    try:
        while True:
            received.append(ws_client.receive_json())
    except Exception:
        pass
    return received


# ── Contract tests ─────────────────────────────────────────────────────────────


def test_translate_false_emits_no_translation_events():
    """Browser sends translate:false → service must emit NO translation events.

    This is the Hybrid Privacy contract: offline service does STT only.
    Even if CT2 is installed, translate_enabled=False short-circuits _do_translate().
    """
    with patch("app.pipeline.asr.websockets.connect", _mock_connect([SERVER_READY, _FINAL_SEG])):
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "start", "langPair": "en→zh-TW", "translate": False})
                received = _read_until_closed(ws)

    translations = [e for e in received if e.get("kind") == "translation"]
    assert translations == [], f"Expected no translation events, got: {translations}"


def test_translate_true_routes_through_mt_when_model_available():
    """Browser sends translate:true → _do_translate is called (mocked MT returns event).

    CT2 is not installed in test environment, so we mock mt.translate to return
    a valid TranslationEvent dict. This verifies the routing, not the model output.
    """
    fake_translation = {
        "kind": "translation",
        "provider": "offline-mt",
        "mode": "full_offline",
        "sourceSegmentId": "dummy",
        "status": "final",
        "sourceText": "The policyholder must sign.",
        "targetText": "要保人必須簽署。",
        "sourceLanguage": "en",
        "targetLanguage": "zh-TW",
        "updatedAt": "2026-05-24T00:00:00.000000+00:00",
    }

    with patch("app.pipeline.asr.websockets.connect", _mock_connect([SERVER_READY, _FINAL_SEG])):
        with patch("app.pipeline.asr.mt.translate", AsyncMock(return_value=fake_translation)):
            with TestClient(app) as client:
                with client.websocket_connect("/ws") as ws:
                    ws.send_json({"type": "start", "langPair": "en→zh-TW", "translate": True})
                    received = _read_until_closed(ws)

    translations = [e for e in received if e.get("kind") == "translation"]
    assert len(translations) == 1
    t = translations[0]
    assert t["sourceText"] == "The policyholder must sign."
    assert t["targetText"] == "要保人必須簽署。"


def test_all_emitted_events_are_valid_json_with_kind():
    """Every event the service sends must be a JSON object with a 'kind' field.

    This is the fundamental browser-parse contract: OfflineSTTProvider calls
    JSON.parse() on every text frame and dispatches on event.kind.
    """
    with patch("app.pipeline.asr.websockets.connect", _mock_connect([SERVER_READY, _FINAL_SEG])):
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "start", "langPair": "en→zh-TW", "translate": False})
                received = _read_until_closed(ws)

    assert len(received) > 0, "Service emitted no events"
    for event in received:
        assert isinstance(event, dict), f"Event is not a dict: {event!r}"
        assert "kind" in event, f"Event missing 'kind': {event}"
        assert event["kind"] in {"transcript", "translation", "health"}, \
            f"Unknown kind: {event['kind']}"


def test_health_sequence_connecting_connected_stopped():
    """Lifecycle health events must appear in order: connecting → connected → stopped.

    This sequence is what the browser's health display depends on.
    """
    with patch("app.pipeline.asr.websockets.connect", _mock_connect([SERVER_READY])):
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "start", "langPair": "en→zh-TW"})
                received = _read_until_closed(ws)

    health_states = [e["state"] for e in received if e.get("kind") == "health"]
    assert "connecting" in health_states, f"Missing 'connecting' in {health_states}"
    assert "connected" in health_states, f"Missing 'connected' in {health_states}"
    assert "stopped" in health_states, f"Missing 'stopped' in {health_states}"
    # Order: connecting must precede connected, connected must precede stopped
    assert health_states.index("connecting") < health_states.index("connected")
    assert health_states.index("connected") < health_states.index("stopped")


def test_final_transcript_event_schema():
    """Final transcript events must include all fields the browser contract requires.

    Required: kind, segmentId, status, text, startMs, endMs.
    Optional but present when available: confidence.
    """
    seg_with_logprob = json.dumps({
        "uid": "x",
        "segments": [{
            "start": 0.5,
            "end": 2.0,
            "text": "Hello world.",
            "completed": True,
            "avg_logprob": -0.25,    # exp(-0.25) ≈ 0.78 → confidence should be set
        }],
    })

    with patch("app.pipeline.asr.websockets.connect", _mock_connect([SERVER_READY, seg_with_logprob])):
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "start", "langPair": "en→zh-TW", "translate": False})
                received = _read_until_closed(ws)

    finals = [e for e in received if e.get("kind") == "transcript" and e.get("status") == "final"]
    assert len(finals) >= 1
    f = finals[0]
    for field in ("segmentId", "status", "text", "startMs", "endMs"):
        assert field in f, f"Final transcript missing '{field}': {f}"
    assert f["status"] == "final"
    assert f["endMs"] == 2000
    # confidence must be present and in [0, 1] when avg_logprob was provided
    assert "confidence" in f, f"Final transcript missing 'confidence': {f}"
    assert 0.0 <= f["confidence"] <= 1.0
    assert f["confidence"] == pytest.approx(0.7788, abs=0.001)  # exp(-0.25)
