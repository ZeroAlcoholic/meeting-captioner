"""Unit tests for the translation pipeline.

Model loading is guarded — tests mock _load_once and _translate_sync so the
real CTranslate2 model is never required at test time.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from app.pipeline.postprocess import (
    apply_source_glossary,
    load_glossary,
    process,
    restore_placeholders,
)
from app.pipeline.translation import translate


# ── postprocess ───────────────────────────────────────────────────────────────


def test_process_deduplicates_repeated_cjk():
    assert process("你好,你好,你好?") == "你好?"


def test_apply_source_glossary_masks_known_term():
    """Known en term is replaced with a GS* placeholder in the masked text."""
    masked, mappings = apply_source_glossary("The policyholder must pay the premium.")
    assert "policyholder" not in masked.lower()
    assert "premium" not in masked.lower()
    assert len(mappings) == 2
    placeholders = [m[0] for m in mappings]
    zh_terms = [m[1] for m in mappings]
    assert all(p.startswith("GS") for p in placeholders)
    assert "要保人" in zh_terms
    assert "保費" in zh_terms


def test_apply_source_glossary_case_insensitive():
    masked, mappings = apply_source_glossary("POLICYHOLDER signed the policy.")
    assert "POLICYHOLDER" not in masked
    assert any("要保人" in zh for _, zh in mappings)


def test_apply_source_glossary_no_match_returns_empty_mappings():
    masked, mappings = apply_source_glossary("Hello world, how are you?")
    assert masked == "Hello world, how are you?"
    assert mappings == []


def test_restore_placeholders_replaces_correctly():
    mappings = [("GS0", "要保人"), ("GS1", "保費")]
    text = "GS0 必須繳納 GS1"
    restored = restore_placeholders(text, mappings)
    assert restored == "要保人 必須繳納 保費"


def test_restore_placeholders_tolerates_casing():
    """Decoder may lowercase or uppercase the placeholder — match case-insensitively."""
    mappings = [("GS0", "核保")]
    restored = restore_placeholders("gs0 已完成", mappings)
    assert "核保" in restored


def test_restore_placeholders_preserves_surrounding_spaces():
    """Surrounding spaces must be kept — they are word separators in zh output."""
    mappings = [("GS0", "附約")]
    restored = restore_placeholders("購買 GS0 服務", mappings)
    assert restored == "購買 附約 服務"


def test_glossary_term_count():
    """Glossary must have at least 50 terms after expansion."""
    from app.pipeline.postprocess import _GLOSSARY
    assert len(_GLOSSARY) >= 50, f"Only {len(_GLOSSARY)} terms loaded — run load_glossary()"


# ── translation dispatch ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_translate_returns_none_when_model_unavailable():
    with patch("app.pipeline.translation._load_once", return_value=False):
        result = await translate(
            segment_id="seg-1",
            text="Hello world",
            source_language="en",
            target_language="zh-TW",
        )
    assert result is None


@pytest.mark.asyncio
async def test_translate_en_zh_event_schema():
    """en→zh-TW path returns a correctly shaped TranslationEvent."""
    with (
        patch("app.pipeline.translation._load_once", return_value=True),
        patch("app.pipeline.translation._translate_sync", return_value="你好世界"),
    ):
        result = await translate(
            segment_id="seg-1",
            text="Hello world",
            source_language="en",
            target_language="zh-TW",
        )
    assert result is not None
    assert result["kind"] == "translation"
    assert result["provider"] == "offline-mt"
    assert result["sourceLanguage"] == "en"
    assert result["targetLanguage"] == "zh-TW"
    assert result["sourceSegmentId"] == "seg-1"
    assert result["sourceText"] == "Hello world"
    assert "targetText" in result
    assert "updatedAt" in result


@pytest.mark.asyncio
async def test_translate_zh_en_event_schema():
    """zh-TW→en path returns a correctly shaped TranslationEvent."""
    with (
        patch("app.pipeline.translation._load_once", return_value=True),
        patch("app.pipeline.translation._translate_sync", return_value="the policyholder"),
    ):
        result = await translate(
            segment_id="seg-2",
            text="要保人已簽署保單",
            source_language="zh",
            target_language="en",
        )
    assert result is not None
    assert result["sourceLanguage"] == "zh"
    assert result["targetLanguage"] == "en"
    assert result["targetText"] == "the policyholder"


@pytest.mark.asyncio
async def test_translate_en_zh_calls_postprocess():
    """en→zh path applies OpenCC postprocessing (dedup + s2twp)."""
    with (
        patch("app.pipeline.translation._load_once", return_value=True),
        patch(
            "app.pipeline.translation._translate_sync",
            return_value="你好,你好,你好",
        ),
    ):
        result = await translate(
            segment_id="seg-3",
            text="Hello there",
            source_language="en",
            target_language="zh-TW",
        )
    assert result is not None
    # Dedup should collapse the repetition
    assert result["targetText"].count("你好") == 1


@pytest.mark.asyncio
async def test_translate_zh_en_skips_postprocess():
    """zh→en path does NOT apply OpenCC to English output."""
    raw_en = "The insured signed the policy."
    with (
        patch("app.pipeline.translation._load_once", return_value=True),
        patch("app.pipeline.translation._translate_sync", return_value=raw_en),
    ):
        result = await translate(
            segment_id="seg-4",
            text="被保險人已簽署保單",
            source_language="zh",
            target_language="en",
        )
    assert result is not None
    assert result["targetText"] == raw_en


@pytest.mark.asyncio
async def test_translate_returns_none_on_empty_raw_output():
    with (
        patch("app.pipeline.translation._load_once", return_value=True),
        patch("app.pipeline.translation._translate_sync", return_value=""),
    ):
        result = await translate(
            segment_id="seg-5",
            text="Test",
            source_language="en",
            target_language="zh-TW",
        )
    assert result is None
