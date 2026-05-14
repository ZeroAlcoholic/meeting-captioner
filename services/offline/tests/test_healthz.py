"""Tests for the offline service /healthz endpoint."""

from unittest.mock import patch

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
    with patch("app.main._whisper_status", "ready"):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/healthz")
    body = response.json()
    assert body["ok"] is True
    assert body["whisper_status"] == "ready"


async def test_healthz_ok_false_when_loading() -> None:
    with patch("app.main._whisper_status", "loading"):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/healthz")
    body = response.json()
    assert body["ok"] is False
    assert body["whisper_status"] == "loading"


async def test_healthz_ok_false_when_unavailable() -> None:
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

    # Translation component
    assert comps["translation"]["engine"] == "opus-mt-en-zh-ct2"
    assert comps["translation"]["status"] in ("ready", "model_not_downloaded")
    assert isinstance(comps["translation"]["glossary_terms"], int)

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
    """Glossary term count in healthz must be positive when glossary.tsv is present."""
    with patch("app.main._whisper_status", "ready"):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/healthz")
    body = response.json()
    # glossary.tsv has 16 insurance terms — count must be > 0
    assert body["components"]["translation"]["glossary_terms"] > 0
