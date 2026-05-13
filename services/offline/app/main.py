"""FastAPI entrypoint for the offline service."""

import asyncio
import os
import threading
from contextlib import asynccontextmanager
from datetime import UTC, datetime

# Must be set before importing anything that uses OpenMP/MKL (faster-whisper, onnxruntime).
# 8 = physical core count on Ryzen AI 7 350; adjust if running on different hardware.
os.environ.setdefault("OMP_NUM_THREADS", "8")

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.pipeline.asr import ASRSession

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
        # Blocking — exits only if the server crashes.
        # language=None: each client specifies its own language in the WS config message.
        # model/language/task are specified per-client in the WebSocket config message
        server.run("0.0.0.0", port=9090, backend="faster_whisper")
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
    description="Local STT/MT bridge — P3: WhisperLive + translation pipeline.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/healthz")
async def healthz() -> dict[str, object]:
    return {
        "ok": _whisper_status == "ready",
        "service": "offline",
        "version": __version__,
        "whisper_status": _whisper_status,
        "whisper_error": _whisper_error,
        "timestamp": datetime.now(UTC).isoformat(),
    }


@app.websocket("/ws")
async def ws_pipeline(ws: WebSocket) -> None:
    """Browser ↔ STT/MT pipeline WebSocket.

    Browser protocol:
      1. Send JSON: { "type": "start", "langPair": "en→zh-TW" }
      2. Send binary frames: raw Float32 LE PCM, 16 kHz, mono
      3. Receive JSON: TranscriptEvent | TranslationEvent | HealthEvent
      4. Send JSON: { "type": "stop" }  (or just close)
    """
    await ws.accept()

    # Step 1: read start message
    try:
        control = await asyncio.wait_for(ws.receive_json(), timeout=10.0)
    except TimeoutError:
        await ws.close(code=1002, reason="start message timeout")
        return

    lang_pair: str = control.get("langPair", "en→zh-TW")
    session = ASRSession(lang_pair=lang_pair)

    # Start background task: connect to WHL + produce events
    asr_task = asyncio.create_task(session.run())

    # Send events to browser; close connection when session ends
    async def forward_events() -> None:
        while True:
            event = await session.next_event()
            if event is None:
                break
            try:
                await ws.send_json(event)
            except Exception:
                break
        try:
            await ws.close()
        except Exception:
            pass

    send_task = asyncio.create_task(forward_events())

    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg["type"] == "websocket.receive":
                if msg.get("bytes"):
                    await session.push_audio(msg["bytes"])
                elif msg.get("text"):
                    try:
                        ctrl = __import__("json").loads(msg["text"])
                        if ctrl.get("type") == "stop":
                            break
                    except Exception:
                        pass
    except WebSocketDisconnect:
        pass
    finally:
        await session.close()
        asr_task.cancel()
        send_task.cancel()
        try:
            await asr_task
        except asyncio.CancelledError:
            pass
