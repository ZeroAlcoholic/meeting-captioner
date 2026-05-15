"""Thin shim — use download_models.py instead.

    uv run python scripts/download_models.py zh-en
"""
from scripts.download_models import main
main(["zh-en"])
