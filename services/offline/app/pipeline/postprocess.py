"""Post-processing: OpenCC s2twp + glossary substitution + deduplication."""

from __future__ import annotations

import csv
import re
from pathlib import Path

try:
    import opencc

    _converter = opencc.OpenCC("s2twp")
    OPENCC_AVAILABLE = True
except ImportError:
    OPENCC_AVAILABLE = False
    _converter = None


_GLOSSARY: dict[str, str] = {}
_GLOSSARY_PATH = Path(__file__).parent.parent.parent / "data" / "glossary.tsv"


def load_glossary(path: Path = _GLOSSARY_PATH) -> None:
    """Load TSV glossary: en<tab>zh-TW[<tab>domain]. Thread-safe for reads after load."""
    _GLOSSARY.clear()
    if not path.exists():
        return
    with path.open(encoding="utf-8") as f:
        reader = csv.reader(f, delimiter="\t")
        for row in reader:
            if len(row) >= 2 and not row[0].startswith("#"):
                _GLOSSARY[row[0].strip().lower()] = row[1].strip()


def _dedup_repeated_phrases(text: str) -> str:
    """Collapse repeated CJK phrases — opus-mt degeneration artifact (你好,你好,你好 → 你好)."""
    pattern = r'([一-鿿㐀-䶿]{2,12})(?:[,，、]\1)+'
    return re.sub(pattern, r'\1', text)


def process(text: str) -> str:
    """Deduplicate then apply OpenCC s2twp (Simplified → Traditional Chinese / Taiwan)."""
    text = _dedup_repeated_phrases(text)
    if OPENCC_AVAILABLE and _converter is not None:
        text = _converter.convert(text)
    return text


def to_traditional(text: str) -> str:
    """Apply OpenCC s2twp without dedup — for normalizing Whisper's zh transcripts.
    Whisper may emit Simplified Chinese even when initial_prompt is Traditional;
    convert at the boundary so the UI consistently shows Traditional."""
    if OPENCC_AVAILABLE and _converter is not None:
        return _converter.convert(text)
    return text


# Placeholder format: GS0 … GS9 (6 chars max, all-caps alphanumeric).
# Shorter than the previous TERM{i}ZH — SentencePiece still may split these,
# but restoration via regex is more reliable on short tokens.
_PH_PREFIX = "GS"


def apply_source_glossary(source_text: str) -> tuple[str, list[tuple[str, str]]]:
    """Mask known English terms in source with short placeholder tokens before MT.

    Returns (masked_source, [(placeholder, zh_term), ...]).
    Caller must pass mappings to restore_placeholders() after translation.
    Note: SentencePiece may split placeholders — use restore_placeholders() with
    case-insensitive regex, which handles partial matches.
    """
    result = source_text
    mappings: list[tuple[str, str]] = []
    for i, (en_term, zh_term) in enumerate(_GLOSSARY.items()):
        pattern = r"\b" + re.escape(en_term) + r"\b"
        if re.search(pattern, source_text, re.IGNORECASE):
            placeholder = f"{_PH_PREFIX}{i}"
            result = re.sub(pattern, placeholder, result, flags=re.IGNORECASE)
            mappings.append((placeholder, zh_term))
    return result, mappings


def restore_placeholders(text: str, mappings: list[tuple[str, str]]) -> str:
    """Replace GS* placeholders with canonical zh-TW terms after MT.

    Case-insensitive to tolerate minor SentencePiece casing changes.
    Surrounding whitespace is preserved — do not strip it here because
    the spaces act as word separators in the zh output.
    """
    for placeholder, zh_term in mappings:
        text = re.sub(re.escape(placeholder), zh_term, text, flags=re.IGNORECASE)
    return text


# Load glossary at import time (non-fatal if file missing).
load_glossary()
