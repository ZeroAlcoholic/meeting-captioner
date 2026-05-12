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
        patch("app.main._whisper_error", "whisper-live not installed"),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/healthz")
    body = response.json()
    assert body["ok"] is False
    assert body["whisper_error"] is not None
