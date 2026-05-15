"""Smoke test: verify both translation directions produce non-empty output.

Same code path as the WebSocket pipeline — no mocks. Run after model conversion:
    .venv\\Scripts\\python.exe scripts\\smoke_translate.py
Exit 0 = both directions work, 1 = something is broken.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from app.pipeline import translation as mt


async def _check(direction: str, source_lang: str, target_lang: str, text: str) -> bool:
    if not mt.is_available(source_lang):
        print(f"  [{direction}] FAIL — model not available")
        return False
    ev = await mt.translate(
        segment_id=f"smoke-{direction}",
        text=text,
        source_language=source_lang,
        target_language=target_lang,
    )
    if ev is None or not ev.get("targetText", "").strip():
        print(f"  [{direction}] FAIL — empty output (event={ev})")
        return False
    print(f"  [{direction}] OK — {text!r} -> {ev['targetText']!r}")
    return True


async def main() -> int:
    results = [
        await _check(
            "en->zh-TW", "en", "zh-TW",
            "Hello, this is a test of the translation system.",
        ),
        await _check(
            "zh-TW->en", "zh", "en",
            "您好，這是翻譯系統的測試。",
        ),
    ]
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
