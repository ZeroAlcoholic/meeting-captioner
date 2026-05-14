"""Translation worker: Helsinki-NLP/opus-mt-en-zh via CTranslate2 + OpenCC post-processing.

Install:
    uv add ctranslate2 sentencepiece opencc-python-reimplemented
    python -m app.pipeline.translation --download   # downloads model to models/opus-mt-en-zh-ct2/

If ctranslate2 is not installed the worker silently disables itself and emits nothing.
"""

from __future__ import annotations

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .events import translation_event
from .postprocess import apply_source_glossary, process as postprocess, restore_placeholders

logger = logging.getLogger(__name__)

try:
    import ctranslate2
    import sentencepiece as spm

    CT2_AVAILABLE = True
except ImportError:
    CT2_AVAILABLE = False
    ctranslate2 = None  # type: ignore[assignment]
    spm = None  # type: ignore[assignment]

MODEL_DIR = Path(__file__).parent.parent.parent / "models" / "opus-mt-en-zh-ct2"
SPM_MODEL = MODEL_DIR / "source.spm"

# >>cmn_Hant<< target token requests Traditional Chinese output directly
ZH_HANT_TOKEN = ">>cmn_Hant<<"

_translator: object | None = None
_sp: object | None = None
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mt-worker")


def is_available() -> bool:
    return CT2_AVAILABLE and MODEL_DIR.exists() and SPM_MODEL.exists()


def _load_once() -> bool:
    """Load model into module-level singletons. Returns True if ready."""
    global _translator, _sp
    if _translator is not None:
        return True
    if not is_available():
        return False
    try:
        _translator = ctranslate2.Translator(
            str(MODEL_DIR),
            device="cpu",
            inter_threads=1,
            intra_threads=2,
            compute_type="int8",
        )
        _sp = spm.SentencePieceProcessor()
        _sp.Load(str(SPM_MODEL))
        logger.info("opus-mt-en-zh CTranslate2 model loaded")
        return True
    except Exception:
        logger.exception("Failed to load opus-mt-en-zh model")
        return False


def _translate_sync(source_text: str, target_lang_token: str = ZH_HANT_TOKEN) -> str:
    """Blocking translate call — run in executor to avoid blocking event loop."""
    if _translator is None or _sp is None:
        return ""
    tokens = _sp.EncodeAsPieces(source_text)
    tokens = [target_lang_token] + list(tokens)
    results = _translator.translate_batch([tokens])
    out_tokens = results[0].hypotheses[0]
    text = _sp.DecodePieces(out_tokens)
    # Replace SentencePiece boundary markers (▁) — lstrip only removes from the start,
    # but ▁ can appear mid-text (e.g. "你好▁我叫約翰").
    return text.replace("▁", " ").strip()


async def translate(
    *,
    segment_id: str,
    text: str,
    source_language: str = "en",
    target_language: str = "zh-TW",
) -> dict | None:
    """Async translate one finalized segment. Returns TranslationEvent or None."""
    loop = asyncio.get_running_loop()
    # Load model in executor on first call — avoids blocking the event loop during load
    ok = await loop.run_in_executor(_executor, _load_once)
    if not ok:
        return None
    try:
        masked_text, mappings = apply_source_glossary(text)
        raw = await loop.run_in_executor(_executor, _translate_sync, masked_text)
        if not raw:
            return None
        if mappings:
            raw = restore_placeholders(raw, mappings)
        polished = postprocess(raw)
        return translation_event(
            source_segment_id=segment_id,
            status="final",
            source_text=text,
            target_text=polished,
            source_language=source_language,
            target_language=target_language,
        )
    except Exception:
        logger.exception("Translation error for segment %s", segment_id)
        return None
