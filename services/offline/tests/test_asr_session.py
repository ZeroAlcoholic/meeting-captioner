"""Unit tests for ASRSession — filter logic and direction routing.

These tests do NOT start a real WHL connection; they exercise _do_translate()
directly via AsyncMock so no network or model is required.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

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
