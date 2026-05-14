"""ASR session: connects to WhisperLive WebSocket, normalizes transcript events."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid

import websockets

from . import translation as mt
from .events import health_event
from .stabilizer import SegmentStabilizer

logger = logging.getLogger(__name__)

WHL_WS_URL = "ws://localhost:9090/"
WHL_MODEL = os.environ.get("WHL_MODEL", "distil-large-v3")
WHL_CONNECT_TIMEOUT = 30.0

MIN_WORDS_TO_TRANSLATE = 3

# Language-aware prompts prime Whisper's decoder for domain vocabulary.
# VAD threshold 0.3 catches softer/distant speech; shorter silence avoids cutting words.
_INITIAL_PROMPTS: dict[str, str] = {
    "en": (
        "This is a business meeting. The speaker discusses project plans, budgets, timelines, "
        "and action items. Terms include policyholder, underwriting, premium, claim, beneficiary."
    ),
    "zh": (
        "這是一場商務會議。講者討論專案計畫、預算、時程與行動項目。"
        "術語包含要保人、核保、保費、理賠、受益人、附約、健康告知。"
    ),
}
_VAD_PARAMETERS = {
    "threshold": 0.3,
    "min_speech_duration_ms": 200,
    "min_silence_duration_ms": 300,
}

LANG_PAIR_TO_STT: dict[str, str] = {
    "en→zh-TW": "en",
    "zh-TW→en": "zh",
}


class ASRSession:
    """Manages one browser client session: WHL connection + segment stabilization."""

    def __init__(self, lang_pair: str = "en→zh-TW") -> None:
        self._language = LANG_PAIR_TO_STT.get(lang_pair, "en")
        self._uid = f"browser-{uuid.uuid4().hex[:8]}"
        self._stabilizer = SegmentStabilizer()
        self._ready = asyncio.Event()
        self._closed = False
        # Audio forwarded from browser → WHL; large buffer covers model-loading delay (~30s)
        self._audio_q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=500)
        # Events produced for browser (large buffer — browser reads them promptly)
        self._event_q: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=1000)

    # ── Public API ────────────────────────────────────────────────────────────

    async def run(self) -> None:
        """Connect to WHL and process until closed. Call as an asyncio task."""
        await self._put(health_event(component="transport", state="connecting"))
        try:
            async with websockets.connect(
                WHL_WS_URL, open_timeout=WHL_CONNECT_TIMEOUT
            ) as ws:
                await ws.send(
                    json.dumps(
                        {
                            "uid": self._uid,
                            "language": self._language,
                            "task": "transcribe",
                            "model": WHL_MODEL,
                            "use_vad": True,
                            "initial_prompt": _INITIAL_PROMPTS.get(self._language, _INITIAL_PROMPTS["en"]),
                            "vad_parameters": _VAD_PARAMETERS,
                        }
                    )
                )
                recv_task = asyncio.create_task(self._recv_loop(ws))
                audio_task = asyncio.create_task(self._audio_forward_loop(ws))
                # Stop both when either finishes (WHL closed → stop audio forwarding)
                done, pending = await asyncio.wait(
                    [recv_task, audio_task],
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass
                # Re-raise any exception from completed tasks
                for task in done:
                    task.result()
        except TimeoutError:
            await self._put(
                health_event(
                    component="transport",
                    state="api_error",
                    message="WhisperLive connection timed out",
                )
            )
        except OSError as exc:
            if not self._closed:
                await self._put(
                    health_event(
                        component="transport",
                        state="failed",
                        message=f"Cannot reach WhisperLive (port 9090): {exc}",
                    )
                )
        except Exception as exc:
            if not self._closed:
                logger.exception("ASR session error")
                await self._put(
                    health_event(component="transport", state="failed", message=str(exc))
                )
        finally:
            self._ready.clear()
            await self._put(health_event(component="transport", state="stopped"))
            await self._put(health_event(component="audio", state="stopped"))
            await self._put(None)  # sentinel — tells consumer loop to exit

    async def push_audio(self, data: bytes) -> None:
        """Enqueue PCM audio from browser. Buffers even before WHL is ready; drops if full."""
        if not self._closed:
            try:
                self._audio_q.put_nowait(data)
            except asyncio.QueueFull:
                pass

    async def next_event(self) -> dict | None:
        """Return next event for browser, or None (sentinel = session ended)."""
        return await self._event_q.get()

    async def close(self) -> None:
        self._closed = True
        # Drain audio queue so _audio_forward_loop unblocks
        while not self._audio_q.empty():
            self._audio_q.get_nowait()

    # ── Internal ──────────────────────────────────────────────────────────────

    async def _recv_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        async for raw in ws:
            if self._closed:
                break
            if isinstance(raw, bytes):
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if msg.get("message") == "SERVER_READY":
                self._ready.set()
                await self._put(health_event(component="transport", state="connected"))
                continue

            if segs := msg.get("segments"):
                try:
                    transcript_events, to_translate = self._stabilizer.feed(segs)
                except Exception:
                    logger.exception("Stabilizer error on segments: %s", segs[:2])
                    continue
                for ev in transcript_events:
                    await self._put(ev)
                # Fire-and-forget translation so recv_loop never blocks on CTranslate2
                for seg in to_translate:
                    asyncio.create_task(self._do_translate(seg))

    async def _do_translate(self, seg: dict) -> None:
        """Fire-and-forget translation task — runs outside recv_loop."""
        text = seg["text"].strip()
        if len(text.split()) < MIN_WORDS_TO_TRANSLATE:
            return
        try:
            translation_ev = await mt.translate(
                segment_id=seg["segment_id"],
                text=text,
                source_language=self._language,
                target_language="zh-TW" if self._language == "en" else "en",
            )
            if translation_ev is not None:
                await self._put(translation_ev)
        except Exception:
            logger.exception("Translation failed for segment %s", seg["segment_id"])

    async def _audio_forward_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        # WHL ignores audio received before SERVER_READY — wait first so buffered
        # audio captured during model-load is flushed to WHL after it's ready.
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=WHL_CONNECT_TIMEOUT)
        except asyncio.TimeoutError:
            return
        while not self._closed:
            try:
                data = await asyncio.wait_for(self._audio_q.get(), timeout=1.0)
                await ws.send(data)
            except TimeoutError:
                continue
            except Exception:
                break

    async def _put(self, event: dict | None) -> None:
        await self._event_q.put(event)
