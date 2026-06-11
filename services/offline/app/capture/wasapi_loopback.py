"""Windows WASAPI loopback capture — records speaker/headphone output (Teams, Zoom, browser).

Requires: PyAudioWPatch  (uv add PyAudioWPatch)
Windows only. Guarded by PYAUDIO_AVAILABLE so the service imports cleanly on other platforms.

Flow:
    wasapi callback (PyAudio thread)
        → mono mix + resample to 16 kHz
        → asyncio queue (thread-safe via call_soon_threadsafe)
        → session.push_audio()   (ASR pipeline)
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

import numpy as np

from app.pipeline.events import health_event

if TYPE_CHECKING:
    from app.pipeline.asr import ASRSession

logger = logging.getLogger(__name__)

try:
    import pyaudiowpatch as pyaudio

    PYAUDIO_AVAILABLE = True
except ImportError:
    PYAUDIO_AVAILABLE = False
    pyaudio = None  # type: ignore[assignment]

TARGET_RATE = 16_000   # Hz — matches WHL / AudioWorklet expected rate
CHUNK_FRAMES = 4096    # frames per callback; same chunk size as browser AudioWorklet


def is_available() -> bool:
    return PYAUDIO_AVAILABLE


def _resample(pcm: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """Linear interpolation resample — adequate quality for STT, no extra deps."""
    if src_rate == dst_rate:
        return pcm
    new_len = max(1, round(len(pcm) * dst_rate / src_rate))
    indices = np.linspace(0, len(pcm) - 1, new_len)
    return np.interp(indices, np.arange(len(pcm)), pcm).astype(np.float32)


async def stream_to_session(session: "ASRSession", stop_event: asyncio.Event) -> None:
    """Capture WASAPI loopback and push PCM to ASRSession until stop_event is set.

    Emits health events via session.push_event() so the browser sees audio state.
    """
    if not PYAUDIO_AVAILABLE:
        await session.push_event(
            health_event(
                component="audio",
                state="failed",
                message="System audio unavailable: PyAudioWPatch not installed",
            )
        )
        return

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=200)

    pa = pyaudio.PyAudio()
    try:
        # Locate default speakers and their loopback variant
        try:
            wasapi_info = pa.get_host_api_info_by_type(pyaudio.paWASAPI)
        except OSError:
            await session.push_event(
                health_event(
                    component="audio",
                    state="failed",
                    message="WASAPI host API not available on this system",
                )
            )
            return

        default_speakers = pa.get_device_info_by_index(wasapi_info["defaultOutputDevice"])
        loopback_device: dict | None = None

        # PyAudioWPatch exposes get_loopback_device_info_generator()
        for dev in pa.get_loopback_device_info_generator():  # type: ignore[attr-defined]
            if default_speakers["name"] in dev["name"]:
                loopback_device = dev
                break

        if loopback_device is None:
            await session.push_event(
                health_event(
                    component="audio",
                    state="failed",
                    message=f"No WASAPI loopback found for: {default_speakers['name']}",
                )
            )
            return

        src_rate = int(loopback_device["defaultSampleRate"])
        channels = int(loopback_device["maxInputChannels"])

        logger.info(
            "WASAPI loopback: %s  %d ch @ %d Hz → %d Hz mono",
            loopback_device["name"],
            channels,
            src_rate,
            TARGET_RATE,
        )

        drop_count = [0]  # mutated only from the event loop thread

        def _try_enqueue(pcm_bytes: bytes) -> None:
            """Runs on the event loop thread — safe to mutate asyncio.Queue and drop_count."""
            try:
                queue.put_nowait(pcm_bytes)
            except asyncio.QueueFull:
                drop_count[0] += 1
                if drop_count[0] % 100 == 0:
                    loop.create_task(
                        session.push_event(
                            health_event(
                                component="audio",
                                state="degraded",
                                message=f"WASAPI queue full: {drop_count[0]} frames dropped",
                            )
                        )
                    )

        def _callback(
            in_data: bytes, frame_count: int, time_info: dict, status: int
        ) -> tuple[None, int]:
            pcm = np.frombuffer(in_data, dtype=np.float32).copy()
            if channels > 1:
                pcm = pcm.reshape(-1, channels).mean(axis=1)
            if src_rate != TARGET_RATE:
                pcm = _resample(pcm, src_rate, TARGET_RATE)
            try:
                loop.call_soon_threadsafe(_try_enqueue, pcm.tobytes())
            except RuntimeError:
                pass  # event loop closed during teardown
            return (None, pyaudio.paContinue)

        stream = pa.open(
            format=pyaudio.paFloat32,
            channels=channels,
            rate=src_rate,
            input=True,
            input_device_index=int(loopback_device["index"]),
            frames_per_buffer=CHUNK_FRAMES,
            stream_callback=_callback,
        )
        stream.start_stream()
        await session.push_event(
            health_event(component="audio", state="connected")
        )

        try:
            while not stop_event.is_set():
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=1.0)
                    await session.push_audio(data)
                except asyncio.TimeoutError:
                    continue
        finally:
            stream.stop_stream()
            stream.close()
            await session.push_event(health_event(component="audio", state="stopped"))
    finally:
        pa.terminate()
