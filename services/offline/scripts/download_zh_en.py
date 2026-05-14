"""Download and convert Helsinki-NLP/opus-mt-zh-en to CTranslate2 int8 format.

Usage (from services/offline):
    uv run python scripts/download_zh_en.py

Requires ctranslate2 (already in pyproject.toml).
Output: models/opus-mt-zh-en-ct2/
"""

from pathlib import Path

MODEL_ID = "Helsinki-NLP/opus-mt-zh-en"
OUTPUT_DIR = Path(__file__).parent.parent / "models" / "opus-mt-zh-en-ct2"


def main() -> None:
    try:
        import ctranslate2
    except ImportError:
        print("ERROR: ctranslate2 not installed. Run: uv add ctranslate2")
        raise SystemExit(1)

    print(f"Downloading {MODEL_ID} and converting to CTranslate2 int8...")
    print(f"Output → {OUTPUT_DIR}")
    converter = ctranslate2.converters.OpusMTConverter(MODEL_ID)
    converter.convert(str(OUTPUT_DIR), quantization="int8", force=True)
    print("Done.")


if __name__ == "__main__":
    main()
