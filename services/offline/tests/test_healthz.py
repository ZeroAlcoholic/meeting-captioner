"""Tests for the offline service /healthz endpoint."""

import asyncio
import json
from unittest.mock import AsyncMock, patch

from httpx import ASGITransport, AsyncClient

from app.main import app


async def test_healthz_returns_200_with_shape() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/healthz")
    assert response.status_code == 200
    body = response.json()
    assert body["service"] == "offline"
    assert "timestamp" in body
    assert "whisper_status" in body
    assert isinstance(body["ok"], bool)


async def test_healthz_ok_true_when_ready() -> None:
    # Both conditions required: WHL process reachable AND model confirmed ready.
    with patch("app.main._whisper_status", "ready"), patch("app.main._whl_model_ready", True):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/healthz")
    body = response.json()
    assert body["ok"] is True
    assert body["whisper_status"] == "ready"
    assert body["components"]["asr"]["status"] == "ready"


async def test_healthz_model_loading_when_process_up_but_not_ready() -> None:
    # WHL process is reachable (probe succeeded) but SERVER_READY not yet received.
    # healthz must surface model_loading so the UI can show a spinner rather than
    # "unavailable" — the user needs to wait, not restart the service.
    with patch("app.main._whisper_status", "ready"), patch("app.main._whl_model_ready", False):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/healthz")
    body = response.json()
    assert body["ok"] is False
    assert body["whisper_status"] == "model_loading"
    assert body["components"]["asr"]["status"] == "model_loading"


async def test_healthz_ok_false_when_unavailable() -> None:
    with patch("app.main._whisper_status", "unavailable"):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/healthz")
    body = response.json()
    assert body["ok"] is False
    assert body["whisper_status"] == "unavailable"


async def test_healthz_exposes_error_when_unavailable() -> None:
    with (
        patch("app.main._whisper_status", "unavailable"),
        patch("app.main._whisper_error", "WhisperLiveKit not reachable on port 9090"),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/healthz")
    body = response.json()
    assert body["ok"] is False
    assert body["whisper_error"] is not None


async def test_healthz_components_structure() -> None:
    """New: /healthz must expose structured components breakdown."""
    with patch("app.main._whisper_status", "ready"):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/healthz")
    body = response.json()
    comps = body["components"]

    # ASR component
    assert comps["asr"]["engine"] == "whisperlivekit"
    assert "model" in comps["asr"]
    assert "status" in comps["asr"]
    assert "port" in comps["asr"]

    # Translation component — bidirectional
    mt = comps["translation"]
    assert mt["en_zh"]["engine"] == "opus-mt-en-zh-ct2"
    assert mt["en_zh"]["status"] in ("ready", "model_not_downloaded")
    assert mt["zh_en"]["engine"] == "opus-mt-zh-en-ct2"
    assert mt["zh_en"]["status"] in ("ready", "model_not_downloaded")
    assert isinstance(mt["glossary_terms"], int)

    # Audio component
    assert comps["audio"]["mic"] == "available"
    assert "system_loopback" in comps["audio"]


async def test_healthz_asr_model_name_matches_env() -> None:
    """ASR model reported in healthz must match WHL_MODEL constant."""
    from app.pipeline.asr import WHL_MODEL

    with patch("app.main._whisper_status", "ready"):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/healthz")
    body = response.json()
    assert body["components"]["asr"]["model"] == WHL_MODEL


async def test_healthz_glossary_terms_count() -> None:
    """Glossary term count in healthz must be ≥ 50 after P4 expansion."""
    with patch("app.main._whisper_status", "ready"):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/healthz")
    body = response.json()
    assert body["components"]["translation"]["glossary_terms"] >= 50


# ─── P1/P2 readiness-probe tests ─────────────────────────────────────────────


class _FakeWhlWs:
    """Minimal WebSocket double: async context manager + async iterator."""

    def __init__(self, messages: list[str]) -> None:
        self._iter = iter(messages)
        self.sent: list[str] = []

    async def send(self, msg: str) -> None:
        self.sent.append(msg)

    def __aiter__(self):
        return self

    async def __anext__(self) -> str:
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration from None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


async def test_run_model_ready_probe_sets_flag_on_server_ready() -> None:
    """P1: _run_model_ready_probe sets _whl_model_ready without a user session."""
    import app.main as main_mod

    main_mod._whl_model_ready = False
    fake_ws = _FakeWhlWs([json.dumps({"message": "SERVER_READY"})])

    with patch("app.main.websockets.connect", return_value=fake_ws):
        await main_mod._run_model_ready_probe()

    assert main_mod._whl_model_ready is True


async def test_run_model_ready_probe_connection_error_leaves_flag_false() -> None:
    """_run_model_ready_probe must not set the flag when WHL refuses the connection."""
    import app.main as main_mod

    main_mod._whl_model_ready = False

    with patch("app.main.websockets.connect", side_effect=OSError("connection refused")):
        await main_mod._run_model_ready_probe()

    assert main_mod._whl_model_ready is False


async def test_run_model_ready_probe_no_server_ready_leaves_flag_false() -> None:
    """Flag stays False when WHL closes the WS before emitting SERVER_READY."""
    import app.main as main_mod

    main_mod._whl_model_ready = False
    # WHL closes without sending SERVER_READY (e.g., still booting)
    fake_ws = _FakeWhlWs([json.dumps({"message": "WAIT"})])

    with patch("app.main.websockets.connect", return_value=fake_ws):
        await main_mod._run_model_ready_probe()

    assert main_mod._whl_model_ready is False


async def test_probe_loop_spawns_model_probe_when_whl_comes_up() -> None:
    """P1: probe loop must fire _run_model_ready_probe on first reachable probe."""
    import app.main as main_mod

    main_mod._whl_model_ready = False
    probe_called = asyncio.Event()

    async def mock_model_probe() -> None:
        probe_called.set()
        main_mod._whl_model_ready = True

    with (
        patch("app.main._probe_whl_once", AsyncMock(return_value=True)),
        patch("app.main._WHL_PROBE_INTERVAL", 0.01),
        patch("app.main._run_model_ready_probe", mock_model_probe),
    ):
        task = asyncio.create_task(main_mod._whl_probe_loop())
        await asyncio.wait_for(probe_called.wait(), timeout=2.0)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    assert main_mod._whl_model_ready is True


async def test_probe_loop_resets_flag_when_whl_restarts() -> None:
    """P2: flag is cleared the moment WHL becomes unreachable after being ready."""
    import app.main as main_mod

    main_mod._whl_model_ready = False

    # Sequence: up (model probe runs → flag=True), up, down (flag must reset)
    results = [True, True, False]
    idx = 0

    async def fake_probe() -> bool:
        nonlocal idx
        r = results[min(idx, len(results) - 1)]
        idx += 1
        return r

    async def mock_model_probe() -> None:
        main_mod._whl_model_ready = True

    with (
        patch("app.main._probe_whl_once", fake_probe),
        patch("app.main._WHL_PROBE_INTERVAL", 0.01),
        patch("app.main._run_model_ready_probe", mock_model_probe),
    ):
        task = asyncio.create_task(main_mod._whl_probe_loop())
        # Wait long enough for 3 cycles (3 × 0.01 s) plus model probe task
        await asyncio.sleep(0.12)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    assert main_mod._whl_model_ready is False
