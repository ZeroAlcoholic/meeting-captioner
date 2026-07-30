"""FastAPI entrypoint for the offline service.

Architecture (Phase B): WhisperLiveKit runs as an **independent process** on port 9090.
This service probes the port every 5 s and reflects status in /healthz.
Start both processes via services/offline/start.bat (Windows) or start.sh (Linux/macOS).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import websockets

# Must be set before importing anything that uses OpenMP/MKL (faster-whisper, onnxruntime).
# 8 = physical core count on Ryzen AI 7 350; adjust if running on different hardware.
os.environ.setdefault("OMP_NUM_THREADS", "8")

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.capture import wasapi_loopback as _wasapi
from app.pipeline import translation as _mt
from app.pipeline.asr import WHL_MODEL, WHL_WS_URL, ASRSession
from app.pipeline.postprocess import _GLOSSARY

_WHL_HOST = "127.0.0.1"
_WHL_PORT = 9090
_WHL_PROBE_INTERVAL = 5.0    # seconds between liveness probes
_WHL_PROBE_TIMEOUT = 1.5     # seconds per TCP probe attempt
_MODEL_PROBE_TIMEOUT = 120.0  # WHL model loading can take ~2 min on first download

logger = logging.getLogger(__name__)

# Module-level status — mutated only by _whl_probe_loop (background task).
# Tests may patch these directly.
_whisper_status: str = "probing"
_whisper_error: str | None = None
# Set to True the first time any ASRSession receives SERVER_READY from WHL.
# Distinguishes "process up, model loading" from "model fully ready".
_whl_model_ready: bool = False


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
            except TimeoutError:
                pass
        finally:
            writer.close()
            await writer.wait_closed()
        return True
    except Exception:
        return False


async def _run_model_ready_probe() -> None:
    """Open a throw-away WHL WebSocket and wait for SERVER_READY.

    Called as a background task whenever WHL becomes TCP-reachable (on service
    start or after a WHL restart).  Uses the same wire protocol as ASRSession
    but closes the connection immediately after the ready signal — no audio is
    exchanged.  Sets _whl_model_ready = True on success; leaves it False on
    timeout or connection error (probe loop retries on the next cycle if WHL is
    still reachable).
    """
    global _whl_model_ready
    try:
        async with asyncio.timeout(_MODEL_PROBE_TIMEOUT):
            async with websockets.connect(
                WHL_WS_URL, open_timeout=_WHL_PROBE_TIMEOUT
            ) as ws:
                await ws.send(
                    json.dumps({
                        "uid": "__readiness_probe__",
                        "language": "en",
                        "task": "transcribe",
                        "model": WHL_MODEL,
                        "use_vad": False,
                    })
                )
                async for raw in ws:
                    if isinstance(raw, bytes):
                        continue
                    try:
                        if json.loads(raw).get("message") == "SERVER_READY":
                            _whl_model_ready = True
                            return
                    except json.JSONDecodeError:
                        pass
    except (TimeoutError, asyncio.CancelledError):
        pass
    except Exception:
        logger.debug("WHL readiness probe failed", exc_info=True)


async def _whl_probe_loop() -> None:
    """Background task: probe WHL port and update module-level status every 5 s.

    Tracks reachability transitions so _whl_model_ready is always consistent:
    - unreachable → reachable: reset flag; spawn WS readiness probe (fixes P1)
    - reachable → unreachable: reset flag; cancel pending probe   (fixes P2)

    P1: first-boot deadlock — WHL loads its model before any user session opens,
        so _whl_model_ready was stuck at False forever.
    P2: stale-ready after WHL restart — flag was True from the prior WHL process
        but the new process hasn't finished loading the model yet.
    """
    global _whisper_status, _whisper_error, _whl_model_ready
    _was_reachable: bool = False
    _model_probe_task: asyncio.Task | None = None
    try:
        while True:
            try:
                reachable = await _probe_whl_once()
            except Exception as exc:
                reachable = False
                _whisper_error = str(exc)

            if reachable:
                if not _was_reachable:
                    # WHL just became reachable (first probe or after a restart).
                    # Reset model-ready so the new process must confirm via
                    # SERVER_READY before we report 'ready' to the UI.
                    _whl_model_ready = False
                    if _model_probe_task is None or _model_probe_task.done():
                        _model_probe_task = asyncio.create_task(
                            _run_model_ready_probe()
                        )
                _whisper_status = "ready"
                _whisper_error = None
            else:
                if _was_reachable:
                    # WHL just went away — invalidate the model-ready flag so a
                    # restarted WHL instance doesn't inherit a stale True.
                    _whl_model_ready = False
                    if _model_probe_task is not None and not _model_probe_task.done():
                        _model_probe_task.cancel()
                        _model_probe_task = None
                _whisper_status = "unavailable"
                _whisper_error = (
                    f"WhisperLiveKit not reachable on port {_WHL_PORT} — "
                    "start it separately (see start.bat / start.sh)"
                )

            _was_reachable = reachable
            await asyncio.sleep(_WHL_PROBE_INTERVAL)
    finally:
        if _model_probe_task is not None and not _model_probe_task.done():
            _model_probe_task.cancel()
            try:
                await _model_probe_task
            except (asyncio.CancelledError, Exception):
                pass


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

# Allow comma-separated origins via env var so production deployments can add
# their own origin without touching source. Defaults to the two dev-server ports.
_CORS_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "OFFLINE_CORS_ORIGIN", "http://localhost:5173,http://localhost:5174"
    ).split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/healthz")
async def healthz() -> dict[str, object]:
    mt_ok = _mt.is_available()
    whl_process_up = _whisper_status == "ready"
    # Distinguish "process running, model loading" from "model fully ready".
    # _whl_model_ready is set the first time any session receives SERVER_READY.
    if whl_process_up and _whl_model_ready:
        asr_component_status = "ready"
    elif whl_process_up:
        asr_component_status = "model_loading"
    else:
        asr_component_status = _whisper_status
    asr_ok = asr_component_status == "ready"
    return {
        # Top-level summary — both ASR and translation must be ready
        "ok": asr_ok and mt_ok,
        "service": "offline",
        "version": __version__,
        "timestamp": datetime.now(UTC).isoformat(),
        # Legacy flat fields kept for browser compatibility
        "whisper_status": asr_component_status,
        "whisper_error": _whisper_error,
        # Structured component breakdown — used by UI health panel
        "components": {
            "asr": {
                "engine": "whisperlivekit",
                "model": WHL_MODEL,
                "status": asr_component_status,
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
    # hybrid_privacy mode: browser requests STT-only; handles translation itself
    # via the online service. False skips CT2 translation for this session.
    translate_enabled: bool = bool(control.get("translate", True))

    def _mark_model_ready() -> None:
        global _whl_model_ready
        _whl_model_ready = True

    session = ASRSession(
        lang_pair=lang_pair,
        on_model_ready=_mark_model_ready,
        translate_enabled=translate_enabled,
    )

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
