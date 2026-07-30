"""Unit tests for ASRSession — filter logic and direction routing.

These tests do NOT start a real WHL connection; they exercise _do_translate()
directly via AsyncMock so no network or model is required.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.pipeline.asr import ASRSession


def _make_seg(text: str, seg_id: str = "seg-500") -> dict:
    return {"segment_id": seg_id, "text": text}


# ── min-words / min-chars filter ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_do_translate_skips_empty_en_segment():
    """Empty/whitespace-only English segments must not call mt.translate.

    Policy: MIN_WORDS_TO_TRANSLATE = 1 in meeting context — single-word
    affirmations like "Yes"/"OK" carry meaning and DO translate. Only true
    empty / whitespace tokens are skipped.
    """
    session = ASRSession(lang_pair="en→zh-TW")
    mock = AsyncMock(return_value=None)
    with patch("app.pipeline.asr.mt.translate", mock):
        await session._do_translate(_make_seg(""))
        await session._do_translate(_make_seg("   "))
    mock.assert_not_called()


@pytest.mark.asyncio
async def test_do_translate_passes_single_word_en_affirmation():
    """Single-word affirmations carry meaning in meetings — must translate."""
    session = ASRSession(lang_pair="en→zh-TW")
    mock = AsyncMock(return_value=None)
    with patch("app.pipeline.asr.mt.translate", mock):
        await session._do_translate(_make_seg("Okay"))
        await session._do_translate(_make_seg("Yes"))
    assert mock.call_count == 2


@pytest.mark.asyncio
async def test_do_translate_passes_long_enough_en_segment():
    """English segment with ≥ MIN_WORDS_TO_TRANSLATE words must call mt.translate."""
    session = ASRSession(lang_pair="en→zh-TW")
    mock = AsyncMock(return_value=None)
    with patch("app.pipeline.asr.mt.translate", mock):
        await session._do_translate(_make_seg("Hello world, how are you?"))
    mock.assert_called_once()
    call_kwargs = mock.call_args.kwargs
    assert call_kwargs["source_language"] == "en"
    assert call_kwargs["target_language"] == "zh-TW"


@pytest.mark.asyncio
async def test_do_translate_skips_single_cjk_filler():
    """Single-CJK-char fillers ("嗯", "呃") are noise — must not translate.

    Policy: MIN_ZH_CHARS = 2. ≥2 CJK chars ("好的", "對對對") DO translate.
    """
    session = ASRSession(lang_pair="zh-TW→en")
    mock = AsyncMock(return_value=None)
    with patch("app.pipeline.asr.mt.translate", mock):
        await session._do_translate(_make_seg("嗯"))   # 1 CJK char → skip
        await session._do_translate(_make_seg("呃"))   # 1 CJK char → skip
    mock.assert_not_called()


@pytest.mark.asyncio
async def test_do_translate_passes_short_zh_affirmation():
    """≥2-CJK-char affirmations carry meaning — must translate."""
    session = ASRSession(lang_pair="zh-TW→en")
    mock = AsyncMock(return_value=None)
    with patch("app.pipeline.asr.mt.translate", mock):
        await session._do_translate(_make_seg("好的"))    # 2 CJK chars
        await session._do_translate(_make_seg("對對對"))  # 3 CJK chars
    assert mock.call_count == 2


@pytest.mark.asyncio
async def test_do_translate_passes_long_enough_zh_segment():
    """Chinese segment with ≥ MIN_ZH_CHARS CJK characters must call mt.translate."""
    session = ASRSession(lang_pair="zh-TW→en")
    mock = AsyncMock(return_value=None)
    with patch("app.pipeline.asr.mt.translate", mock):
        await session._do_translate(_make_seg("要保人已簽署保單"))
    mock.assert_called_once()
    call_kwargs = mock.call_args.kwargs
    assert call_kwargs["source_language"] == "zh"
    assert call_kwargs["target_language"] == "en"


# ── translate_enabled flag ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_translate_disabled_skips_mt_entirely():
    """When translate_enabled=False, _do_translate must never be called.

    hybrid_privacy mode sends translate=false in the WS start message so the
    offline service does STT only. The browser handles MT via the online service.
    """
    session = ASRSession(lang_pair="en→zh-TW", translate_enabled=False)
    mock = AsyncMock(return_value=None)
    with patch("app.pipeline.asr.mt.translate", mock):
        await session._do_translate(_make_seg("Hello world, how are you?"))
        await session._do_translate(_make_seg("The policyholder must sign the form."))
    mock.assert_not_called()


@pytest.mark.asyncio
async def test_translate_enabled_true_still_calls_mt():
    """translate_enabled=True (default) must still call mt.translate normally."""
    session = ASRSession(lang_pair="en→zh-TW", translate_enabled=True)
    mock = AsyncMock(return_value=None)
    with patch("app.pipeline.asr.mt.translate", mock):
        await session._do_translate(_make_seg("Hello world, how are you?"))
    mock.assert_called_once()


# ── on_model_ready callback ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_on_model_ready_callback_fires_on_server_ready() -> None:
    """on_model_ready must be called exactly once when SERVER_READY arrives.

    This callback is how main.py learns the model is loaded without polling.
    The session must NOT fire it for other message types.
    """
    import asyncio

    callback = MagicMock()
    session = ASRSession(lang_pair="en→zh-TW", on_model_ready=callback)

    # Fake WebSocket that yields two messages then ends iteration.
    # _recv_loop does `async for raw in ws:` — StopAsyncIteration terminates it.
    class _FakeWS:
        _msgs = [
            '{"message": "SERVER_READY"}',
            '{"message": "WAIT"}',  # should NOT trigger callback again
        ]
        _idx = 0

        def __aiter__(self):
            return self

        async def __anext__(self) -> str:
            if self._idx >= len(self._msgs):
                raise StopAsyncIteration
            msg = self._msgs[self._idx]
            self._idx += 1
            return msg

    recv_task = asyncio.create_task(session._recv_loop(_FakeWS()))  # type: ignore[arg-type]
    await asyncio.wait_for(recv_task, timeout=2.0)

    callback.assert_called_once()


@pytest.mark.asyncio
async def test_on_model_ready_callback_not_required() -> None:
    """ASRSession must work normally when no callback is passed."""
    session = ASRSession(lang_pair="en→zh-TW")  # on_model_ready defaults to None
    assert session._on_model_ready is None
    # Callback-less session accepts _do_translate without error.
    mock = AsyncMock(return_value=None)
    with patch("app.pipeline.asr.mt.translate", mock):
        await session._do_translate(_make_seg("Hello world"))
    mock.assert_called_once()


# ── direction routing ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_do_translate_en_zh_routes_correctly():
    session = ASRSession(lang_pair="en→zh-TW")
    mock = AsyncMock(return_value=None)
    with patch("app.pipeline.asr.mt.translate", mock):
        await session._do_translate(_make_seg("The policyholder must pay the premium now."))
    call_kwargs = mock.call_args.kwargs
    assert call_kwargs["source_language"] == "en"
    assert call_kwargs["target_language"] == "zh-TW"


@pytest.mark.asyncio
async def test_do_translate_zh_en_routes_correctly():
    session = ASRSession(lang_pair="zh-TW→en")
    mock = AsyncMock(return_value=None)
    with patch("app.pipeline.asr.mt.translate", mock):
        await session._do_translate(_make_seg("要保人已簽署完成所有保單文件"))
    call_kwargs = mock.call_args.kwargs
    assert call_kwargs["source_language"] == "zh"
    assert call_kwargs["target_language"] == "en"


# ── confidence propagation ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_do_translate_passes_confidence_to_mt():
    """source_confidence from WHL avg_logprob must reach mt.translate."""
    seg = {"segment_id": "seg-1", "text": "Hello world, how are you?", "confidence": 0.82}
    session = ASRSession(lang_pair="en→zh-TW")
    mock = AsyncMock(return_value=None)
    with patch("app.pipeline.asr.mt.translate", mock):
        await session._do_translate(seg)
    call_kwargs = mock.call_args.kwargs
    assert call_kwargs["source_confidence"] == pytest.approx(0.82)


@pytest.mark.asyncio
async def test_do_translate_passes_none_confidence_when_absent():
    """When seg has no confidence key, source_confidence=None reaches mt.translate."""
    session = ASRSession(lang_pair="en→zh-TW")
    mock = AsyncMock(return_value=None)
    with patch("app.pipeline.asr.mt.translate", mock):
        await session._do_translate(_make_seg("Hello world, how are you?"))
    call_kwargs = mock.call_args.kwargs
    assert call_kwargs["source_confidence"] is None


# ── translation dispatcher integration ───────────────────────────────────────


def test_translate_disabled_does_not_create_dispatcher() -> None:
    session = ASRSession(lang_pair="en→zh-TW", translate_enabled=False)

    assert session._translation_dispatcher is None


@pytest.mark.asyncio
async def test_recv_loop_reports_degraded_health_when_translation_is_dropped() -> None:
    session = ASRSession(lang_pair="en→zh-TW")
    session._stabilizer.feed = MagicMock(
        return_value=([], [_make_seg("newest", seg_id="seg-new")])
    )

    class _DroppingDispatcher:
        def enqueue(self, seg: dict) -> int:
            assert seg["segment_id"] == "seg-new"
            return 1

    session._translation_dispatcher = _DroppingDispatcher()  # type: ignore[assignment]

    class _FakeWS:
        def __aiter__(self):
            self._done = False
            return self

        async def __anext__(self) -> str:
            if self._done:
                raise StopAsyncIteration
            self._done = True
            return '{"segments": [{"text": "newest"}]}'

    await session._recv_loop(_FakeWS())  # type: ignore[arg-type]

    event = session._event_q.get_nowait()
    assert event["kind"] == "health"
    assert event["component"] == "translation"
    assert event["state"] == "degraded"
    assert "dropped" in event["message"]


@pytest.mark.asyncio
async def test_closed_session_does_not_emit_late_translation_result() -> None:
    session = ASRSession(lang_pair="en→zh-TW")
    session._closed = True
    translation = {"kind": "translation", "sourceSegmentId": "seg-500"}

    with patch("app.pipeline.asr.mt.translate", AsyncMock(return_value=translation)):
        await session._do_translate(_make_seg("Hello world"))

    assert session._event_q.empty()
