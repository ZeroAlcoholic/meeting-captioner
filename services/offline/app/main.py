"""FastAPI entrypoint for the offline service."""

import threading
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI

from app import __version__

try:
    from whisper_live.server import TranscriptionServer as _TranscriptionServer

    _WHISPER_LIVE_AVAILABLE = True
except ImportError:
    _WHISPER_LIVE_AVAILABLE = False
    _TranscriptionServer = None  # type: ignore[assignment,misc]

_whisper_status: str = "unavailable" if not _WHISPER_LIVE_AVAILABLE else "starting"
_whisper_error: str | None = None if _WHISPER_LIVE_AVAILABLE else "whisper-live not installed"


def _run_whisper_server() -> None:
    global _whisper_status, _whisper_error
    try:
        _whisper_status = "loading"
        server = _TranscriptionServer()
        _whisper_status = "ready"
        # Blocking — exits only if the server crashes
        server.run(
            "0.0.0.0",
            port=9090,
            backend="faster_whisper",
            model="small",
            language="en",
            task="transcribe",
        )
        _whisper_status = "stopped"
    except Exception as exc:
        _whisper_status = "failed"
        _whisper_error = str(exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if _WHISPER_LIVE_AVAILABLE:
        thread = threading.Thread(target=_run_whisper_server, daemon=True, name="whisper-live")
        thread.start()
    yield
    # daemon thread exits with the process — no explicit cleanup needed


app = FastAPI(
    title="meeting-audio offline service",
    version=__version__,
    description="Local STT/MT bridge — P3: WhisperLiveKit offline STT.",
    lifespan=lifespan,
)


@app.get("/healthz")
async def healthz() -> dict[str, object]:
    return {
        "ok": _whisper_status == "ready",
        "service": "offline",
        "version": __version__,
        "whisper_status": _whisper_status,
        "whisper_error": _whisper_error,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
