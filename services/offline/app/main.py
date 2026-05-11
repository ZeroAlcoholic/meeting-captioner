"""FastAPI entrypoint for the offline service."""

from datetime import datetime, timezone

from fastapi import FastAPI

from app import __version__

app = FastAPI(
    title="meeting-audio offline service",
    version=__version__,
    description="Local STT/MT bridge. P0 stub: /healthz only.",
)


@app.get("/healthz")
async def healthz() -> dict[str, object]:
    return {
        "ok": True,
        "service": "offline",
        "version": __version__,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
