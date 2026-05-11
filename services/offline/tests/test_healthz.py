"""Smoke tests for the offline service P0 stub."""

from httpx import ASGITransport, AsyncClient

from app.main import app


async def test_healthz_returns_ok() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/healthz")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["service"] == "offline"
    assert "timestamp" in body
