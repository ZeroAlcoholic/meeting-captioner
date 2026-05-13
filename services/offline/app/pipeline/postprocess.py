"""Post-processing: OpenCC s2twp + glossary substitution + number normalization."""

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
    """Collapse repeated short phrases common in opus-mt degeneration (e.g. 你好,你好,你好)."""
    # Match a CJK phrase (2-12 chars) that immediately repeats, separated by punctuation or comma
    # e.g. "你好,你好,你好?" → "你好?"
    pattern = r'([一-鿿㐀-䶿]{2,12})(?:[,，、]\1)+'
    deduped = re.sub(pattern, r'\1', text)
    return deduped


def process(text: str) -> str:
    """Deduplicate repeated phrases then apply OpenCC s2twp → Traditional Chinese."""
    text = _dedup_repeated_phrases(text)
    if OPENCC_AVAILABLE and _converter is not None:
        text = _converter.convert(text)
    return text


def apply_source_glossary(source_text: str) -> tuple[str, list[tuple[str, str]]]:
    """Replace known English terms in source with placeholder tags before MT.

    Returns (modified_source, [(placeholder, zh_term), ...]).
    The caller must restore placeholders in the MT output after translation.
    Note: SentencePiece may corrupt placeholders — this is best-effort only.
    """
    result = source_text
    mappings: list[tuple[str, str]] = []
    for i, (en_term, zh_term) in enumerate(_GLOSSARY.items()):
        pattern = r"\b" + re.escape(en_term) + r"\b"
        if re.search(pattern, source_text, re.IGNORECASE):
            placeholder = f"TERM{i}ZH"  # short, SentencePiece-friendly
            result = re.sub(pattern, placeholder, result, flags=re.IGNORECASE)
            mappings.append((placeholder, zh_term))
    return result, mappings


def restore_placeholders(text: str, mappings: list[tuple[str, str]]) -> str:
    """Replace TERMN placeholders with correct Chinese terms after MT."""
    for placeholder, zh_term in mappings:
        text = re.sub(re.escape(placeholder), zh_term, text, flags=re.IGNORECASE)
    return text


# Load glossary at import time (non-fatal if file missing)
load_glossary()
