"""WebSocket /ws endpoint tests — WHL mocked via patch on websockets.connect."""

import json
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app

# ── WHL WebSocket mock ────────────────────────────────────────────────────────


class _MockWhlWs:
    """Async-iterable fake WHL WebSocket that yields pre-set messages then closes."""

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
    """Async context manager returned by the patched websockets.connect()."""

    def __init__(self, messages: list[str | bytes]) -> None:
        self._ws = _MockWhlWs(messages)

    async def __aenter__(self):
        return self._ws

    async def __aexit__(self, *args):
        pass


def _mock_connect(messages: list[str | bytes]):
    """Factory: return a replacement for websockets.connect that yields given messages."""

    def _connect(*args, **kwargs):
        return _MockConnect(messages)

    return _connect


def _read_until_closed(ws_client) -> list[dict]:
    """Drain browser WebSocket events until connection closes."""
    received = []
    try:
        while True:
            received.append(ws_client.receive_json())
    except Exception:
        pass
    return received


SERVER_READY = json.dumps({"uid": "x", "message": "SERVER_READY"})


# ── Tests ──────────────────────────────────────────────────────────────────────


def test_healthz_unaffected():
    with TestClient(app) as client:
        r = client.get("/healthz")
    assert r.status_code == 200


def test_ws_emits_connecting_then_connected():
    with patch("app.pipeline.asr.websockets.connect", _mock_connect([SERVER_READY])):
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "start", "langPair": "en→zh-TW"})
                received = _read_until_closed(ws)

    states = [e["state"] for e in received if e.get("kind") == "health"]
    assert "connecting" in states
    assert "connected" in states


def test_ws_emits_partial_transcript():
    seg = json.dumps(
        {"uid": "x", "segments": [{"start": 0.0, "end": 1.0, "text": "Hello", "completed": False}]}
    )
    with patch("app.pipeline.asr.websockets.connect", _mock_connect([SERVER_READY, seg])):
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "start", "langPair": "en→zh-TW"})
                received = _read_until_closed(ws)

    transcripts = [e for e in received if e.get("kind") == "transcript"]
    assert any(t["status"] == "partial" and t["text"] == "Hello" for t in transcripts)


def test_ws_emits_final_transcript():
    seg = json.dumps(
        {
            "uid": "x",
            "segments": [{"start": 0.5, "end": 2.0, "text": "Final text.", "completed": True}],
        }
    )
    with patch("app.pipeline.asr.websockets.connect", _mock_connect([SERVER_READY, seg])):
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "start", "langPair": "en→zh-TW"})
                received = _read_until_closed(ws)

    finals = [e for e in received if e.get("kind") == "transcript" and e["status"] == "final"]
    assert len(finals) == 1
    assert finals[0]["text"] == "Final text."
    assert finals[0]["endMs"] == 2000


def test_ws_deduplicates_final_segments():
    seg = json.dumps(
        {
            "uid": "x",
            "segments": [{"start": 0.0, "end": 1.5, "text": "Once only.", "completed": True}],
        }
    )
    with patch("app.pipeline.asr.websockets.connect", _mock_connect([SERVER_READY, seg, seg])):
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "start", "langPair": "en→zh-TW"})
                received = _read_until_closed(ws)

    finals = [e for e in received if e.get("kind") == "transcript" and e["status"] == "final"]
    assert len(finals) == 1


def test_ws_zh_tw_en_lang_pair_sends_zh_to_whl():
    """langPair zh-TW→en must send language='zh' in WHL config."""
    sent_configs: list[dict] = []

    class _CapturingWhlWs(_MockWhlWs):
        async def send(self, data) -> None:
            try:
                sent_configs.append(json.loads(data))
            except Exception:
                pass
            await super().send(data)

    class _CapturingConnect:
        async def __aenter__(self):
            return _CapturingWhlWs([SERVER_READY])

        async def __aexit__(self, *args):
            pass

    with patch("app.pipeline.asr.websockets.connect", lambda *a, **kw: _CapturingConnect()):
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "start", "langPair": "zh-TW→en"})
                _read_until_closed(ws)

    whl_config = next((c for c in sent_configs if "language" in c), None)
    assert whl_config is not None
    assert whl_config["language"] == "zh"


def test_ws_whl_unavailable_emits_failed_health():
    def _connect_fail(*args, **kwargs):
        class _Fail:
            async def __aenter__(self):
                raise OSError("Connection refused")

            async def __aexit__(self, *args):
                pass

        return _Fail()

    with patch("app.pipeline.asr.websockets.connect", _connect_fail):
        with TestClient(app) as client:
            with client.websocket_connect("/ws") as ws:
                ws.send_json({"type": "start", "langPair": "en→zh-TW"})
                received = _read_until_closed(ws)

    health = [e for e in received if e.get("kind") == "health"]
    states = [e["state"] for e in health]
    assert "failed" in states or "api_error" in states
