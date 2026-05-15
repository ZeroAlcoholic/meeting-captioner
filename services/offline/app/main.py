"""FastAPI entrypoint for the offline service.

Architecture (Phase B): WhisperLiveKit runs as an **independent process** on port 9090.
This service probes the port every 5 s and reflects status in /healthz.
Start both processes via services/offline/start.bat (Windows) or start.sh (Linux/macOS).
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from datetime import UTC, datetime

# Must be set before importing anything that uses OpenMP/MKL (faster-whisper, onnxruntime).
# 8 = physical core count on Ryzen AI 7 350; adjust if running on different hardware.
os.environ.setdefault("OMP_NUM_THREADS", "8")

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.capture import wasapi_loopback as _wasapi
from app.pipeline import translation as _mt
from app.pipeline.asr import ASRSession, WHL_MODEL
from app.pipeline.postprocess import _GLOSSARY

_WHL_HOST = "127.0.0.1"
_WHL_PORT = 9090
_WHL_PROBE_INTERVAL = 5.0   # seconds between liveness probes
_WHL_PROBE_TIMEOUT = 1.5    # seconds per probe attempt

# Module-level status — mutated only by _whl_probe_loop (background task).
# Tests may patch these directly.
_whisper_status: str = "probing"
_whisper_error: str | None = None


async def _probe_whl_once() -> bool:
    """Liveness check for WHL on :9090.

    WHL is a WebSocket-only server; opening then immediately closing a raw TCP
    connection makes it log 'InvalidMessage: did not receive a valid HTTP request'
    on every probe (~360 errors / 30 min). Sending a minimal HTTP/1.0 GET before
    close lets WHL's HTTP parser see a complete request and reply quietly.
    We still treat any successful connect as 'reachable'.
    """
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(_WHL_HOST, _WHL_PORT),
            timeout=_WHL_PROBE_TIMEOUT,
        )
        try:
            writer.write(b"GET / HTTP/1.0\r\n\r\n")
            await writer.drain()
            try:
                await asyncio.wait_for(reader.read(64), timeout=0.2)
            except asyncio.TimeoutError:
                pass
        finally:
            writer.close()
            await writer.wait_closed()
        return True
    except Exception:
        return False


async def _whl_probe_loop() -> None:
    """Background task: probe WHL port and update module-level status every 5 s."""
    global _whisper_status, _whisper_error
    while True:
        try:
            reachable = await _probe_whl_once()
            if reachable:
                _whisper_status = "ready"
                _whisper_error = None
            else:
                _whisper_status = "unavailable"
                _whisper_error = (
                    f"WhisperLiveKit not reachable on port {_WHL_PORT} — "
                    "start it separately (see start.bat / start.sh)"
                )
        except Exception as exc:
            _whisper_status = "unavailable"
            _whisper_error = str(exc)
        await asyncio.sleep(_WHL_PROBE_INTERVAL)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_whl_probe_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title="meeting-audio offline service",
    version=__version__,
    description="Local STT/MT bridge — WhisperLiveKit (external) + CTranslate2 translation.",
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
    mt_ok = _mt.is_available()
    asr_ok = _whisper_status == "ready"
    return {
        # Top-level summary — both ASR and translation must be ready
        "ok": asr_ok and mt_ok,
        "service": "offline",
        "version": __version__,
        "timestamp": datetime.now(UTC).isoformat(),
        # Legacy flat fields kept for browser compatibility
        "whisper_status": _whisper_status,
        "whisper_error": _whisper_error,
        # Structured component breakdown — used by UI health panel
        "components": {
            "asr": {
                "engine": "whisperlivekit",
                "model": WHL_MODEL,
                "status": _whisper_status,
                "port": _WHL_PORT,
                "error": _whisper_error,
            },
            "translation": {
                "en_zh": {
                    "engine": "opus-mt-en-zh-ct2",
                    "status": "ready" if mt_ok else "model_not_downloaded",
                },
                "zh_en": {
                    "engine": "opus-mt-zh-en-ct2",
                    "status": "ready" if _mt.is_available("zh") else "model_not_downloaded",
                },
                "glossary_terms": len(_GLOSSARY),
            },
            "audio": {
                "mic": "available",
                "system_loopback": "not_implemented",
            },
        },
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
    source: str = control.get("source", "mic")  # "mic" | "system"
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

    # WASAPI loopback task — only when source='system'
    wasapi_stop = asyncio.Event()
    wasapi_task: asyncio.Task | None = None
    if source == "system":
        wasapi_task = asyncio.create_task(_wasapi.stream_to_session(session, wasapi_stop))

    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg["type"] == "websocket.receive":
                # Only forward browser PCM when source='mic'
                if msg.get("bytes") and source == "mic":
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
        wasapi_stop.set()
        if wasapi_task is not None:
            wasapi_task.cancel()
            try:
                await wasapi_task
            except (asyncio.CancelledError, Exception):
                pass
        await session.close()
        asr_task.cancel()
        send_task.cancel()
        try:
            await asr_task
        except asyncio.CancelledError:
            pass
