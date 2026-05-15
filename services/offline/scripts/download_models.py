"""Download and convert Helsinki-NLP opus-mt models to CTranslate2 int8.

Handles both translation directions.  Run from services/offline:

    uv run python scripts/download_models.py           # both models
    uv run python scripts/download_models.py en-zh     # en→zh-TW only
    uv run python scripts/download_models.py zh-en     # zh-TW→en only

Requires ctranslate2 (already in pyproject.toml).
Models are downloaded from HuggingFace Hub on first run (~80–120 MB each after int8 quant).
"""

from __future__ import annotations

import sys
from pathlib import Path

MODELS_DIR = Path(__file__).parent.parent / "models"

TARGETS = {
    "en-zh": {
        "hf_id": "Helsinki-NLP/opus-mt-en-zh",
        "out_dir": MODELS_DIR / "opus-mt-en-zh-ct2",
        "description": "en → zh-TW (Traditional Chinese)",
    },
    "zh-en": {
        "hf_id": "Helsinki-NLP/opus-mt-zh-en",
        "out_dir": MODELS_DIR / "opus-mt-zh-en-ct2",
        "description": "zh-TW → en",
    },
}


def _patch_ct2_marian_compat() -> None:
    """ctranslate2 passes dtype= to MarianMTModel.from_pretrained() which some
    transformers versions forward to __init__() — but Marian doesn't accept it.
    Strip the kwarg before the call to unblock conversion.
    """
    import ctranslate2.converters.transformers as _ct2

    _orig = _ct2.TransformersConverter.load_model

    def _load_without_dtype(self, model_class, model_name_or_path, **kwargs):
        kwargs.pop("dtype", None)
        return model_class.from_pretrained(model_name_or_path, **kwargs)

    _ct2.TransformersConverter.load_model = _load_without_dtype  # type: ignore[method-assign]


def _convert(hf_id: str, out_dir: Path, description: str) -> None:
    import ctranslate2

    if out_dir.exists() and any(out_dir.iterdir()):
        print(f"  [{description}] already exists at {out_dir} — skipping.")
        print("  Pass --force to overwrite.")
        return

    _patch_ct2_marian_compat()

    print(f"  [{description}] downloading and converting {hf_id} ...")
    out_dir.mkdir(parents=True, exist_ok=True)
    # copy_files explicitly requests the SentencePiece tokenizer files alongside
    # the converted model — CT2 does not auto-copy them for Marian models.
    converter = ctranslate2.converters.TransformersConverter(
        hf_id, copy_files=["source.spm", "target.spm"]
    )
    converter.convert(str(out_dir), quantization="int8", force=True)
    print(f"  [{description}] done → {out_dir}")


def main(args: list[str]) -> None:
    try:
        import ctranslate2  # noqa: F401
    except ImportError:
        print("ERROR: ctranslate2 not installed. Run: uv add ctranslate2")
        raise SystemExit(1)

    force = "--force" in args
    keys = [a for a in args if a in TARGETS]
    if not keys:
        keys = list(TARGETS.keys())

    for key in keys:
        cfg = TARGETS[key]
        out_dir: Path = cfg["out_dir"]
        if force and out_dir.exists():
            import shutil
            shutil.rmtree(out_dir)
        _convert(cfg["hf_id"], out_dir, cfg["description"])

    print("\nAll done.")


if __name__ == "__main__":
    main(sys.argv[1:])
