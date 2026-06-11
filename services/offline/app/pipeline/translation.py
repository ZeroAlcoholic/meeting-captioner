"""Translation: bidirectional en↔zh-TW via CTranslate2 + OpenCC post-processing.

en→zh-TW  Helsinki-NLP/opus-mt-en-zh  →  models/opus-mt-en-zh-ct2  (already present)
zh-TW→en  Helsinki-NLP/opus-mt-zh-en  →  models/opus-mt-zh-en-ct2  (download separately)

Download zh→en model (one-time):
    uv run python scripts/download_zh_en.py
"""

from __future__ import annotations

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .events import translation_event
from .postprocess import apply_source_glossary, process as postprocess_zh, restore_placeholders

logger = logging.getLogger(__name__)

try:
    import ctranslate2
    import sentencepiece as spm

    CT2_AVAILABLE = True
except ImportError:
    CT2_AVAILABLE = False
    ctranslate2 = None  # type: ignore[assignment]
    spm = None  # type: ignore[assignment]

_MODELS_DIR = Path(__file__).parent.parent.parent / "models"
_EN_ZH_DIR = _MODELS_DIR / "opus-mt-en-zh-ct2"
_ZH_EN_DIR = _MODELS_DIR / "opus-mt-zh-en-ct2"

# Helsinki opus-mt-en-zh uses a shared vocabulary; the >>lang<< token selects target script.
ZH_HANT_TOKEN = ">>cmn_Hant<<"

# Per-direction model singletons.  Keyed by "en" or "zh".
_translators: dict[str, object] = {}
_src_sps: dict[str, object] = {}   # SentencePiece for source encoding
_tgt_sps: dict[str, object] = {}   # SentencePiece for target decoding (may equal _src_sps[d])

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mt-worker")


def _model_dir(direction: str) -> Path:
    return _EN_ZH_DIR if direction == "en" else _ZH_EN_DIR


def is_available(source_language: str = "en") -> bool:
    """True if the model for this source language is installed and CT2 is importable."""
    d = "en" if source_language == "en" else "zh"
    mdir = _model_dir(d)
    return CT2_AVAILABLE and mdir.exists() and (mdir / "source.spm").exists()


def _load_once(direction: str) -> bool:
    """Lazy-load model for *direction*. Thread-safe for reads after first load."""
    if direction in _translators:
        return True
    mdir = _model_dir(direction)
    if not is_available(direction):
        return False
    try:
        _translators[direction] = ctranslate2.Translator(
            str(mdir),
            device="cpu",
            inter_threads=1,
            intra_threads=2,
            compute_type="int8",
        )
        src_sp = spm.SentencePieceProcessor()
        src_sp.Load(str(mdir / "source.spm"))
        _src_sps[direction] = src_sp

        # Some opus-mt models (e.g. zh-en) ship separate source/target SPMs after CT2
        # conversion.  Fall back to source SPM when only a shared vocabulary is present.
        tgt_spm_path = mdir / "target.spm"
        if tgt_spm_path.exists():
            tgt_sp = spm.SentencePieceProcessor()
            tgt_sp.Load(str(tgt_spm_path))
            _tgt_sps[direction] = tgt_sp
        else:
            _tgt_sps[direction] = src_sp

        logger.info("MT model loaded: %s", mdir.name)
        return True
    except Exception:
        logger.exception("Failed to load MT model (direction=%s)", direction)
        return False


def _translate_sync(source_text: str, direction: str) -> str:
    """Blocking translate — must run inside the single MT executor thread."""
    translator = _translators.get(direction)
    src_sp = _src_sps.get(direction)
    tgt_sp = _tgt_sps.get(direction)
    if translator is None or src_sp is None or tgt_sp is None:
        return ""
    tokens = list(src_sp.EncodeAsPieces(source_text))
    if direction == "en":
        # Prepend target-language token to steer decoder toward Traditional Chinese.
        tokens = [ZH_HANT_TOKEN] + tokens
    results = translator.translate_batch([tokens])
    out_tokens = results[0].hypotheses[0]
    text = tgt_sp.DecodePieces(out_tokens)
    return text.replace("▁", " ").strip()


_TRANSLATE_TIMEOUT_S = 5.0


async def _run_in_executor_with_timeout(loop, fn, *args):
    """Run a blocking translation step under a hard timeout.

    The MT executor is single-threaded; if a call hangs (CT2 deadlock or pathological
    input) the entire pipeline blocks forever. wait_for guarantees the executor slot
    is released within _TRANSLATE_TIMEOUT_S — caller treats timeout as None (skip).
    """
    return await asyncio.wait_for(
        loop.run_in_executor(_executor, fn, *args), timeout=_TRANSLATE_TIMEOUT_S
    )


async def translate(
    *,
    segment_id: str,
    text: str,
    source_language: str = "en",
    target_language: str = "zh-TW",
    source_confidence: float | None = None,
) -> dict | None:
    """Translate one finalized segment asynchronously. Returns TranslationEvent or None."""
    direction = "en" if source_language == "en" else "zh"
    loop = asyncio.get_running_loop()
    try:
        ok = await _run_in_executor_with_timeout(loop, _load_once, direction)
    except asyncio.TimeoutError:
        logger.error("MT model load timed out (direction=%s)", direction)
        return None
    if not ok:
        return None
    try:
        if direction == "en":
            # Mask glossary terms before MT so the model preserves them as placeholders,
            # then restore correct zh-TW terms in the raw output before OpenCC.
            masked_text, mappings = apply_source_glossary(text)
            raw = await _run_in_executor_with_timeout(loop, _translate_sync, masked_text, direction)
            if not raw:
                return None
            if mappings:
                raw = restore_placeholders(raw, mappings)
            polished = postprocess_zh(raw)
        else:
            # zh→en: translate directly. English output needs no OpenCC conversion.
            raw = await _run_in_executor_with_timeout(loop, _translate_sync, text, direction)
            if not raw:
                return None
            polished = raw

        return translation_event(
            source_segment_id=segment_id,
            status="final",
            source_text=text,
            target_text=polished,
            source_language=source_language,
            target_language=target_language,
            source_confidence=source_confidence,
        )
    except asyncio.TimeoutError:
        logger.error("Translation timed out (>%.1fs) for segment %s", _TRANSLATE_TIMEOUT_S, segment_id)
        return None
    except Exception:
        logger.exception("Translation error for segment %s", segment_id)
        return None
