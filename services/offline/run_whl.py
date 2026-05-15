"""WhisperLiveKit launcher — single-model + pre-warmed cache.

WHL's `python -m whisper_live.server` is import-only (no __main__ block).
This script invokes TranscriptionServer().run() explicitly with single_model=True
so all browser sessions share one model instance instead of loading per-client.

The WhisperModel(...) call below pre-caches the model files in
~/.cache/huggingface/hub before opening port 9090, so the first browser session
doesn't trigger a 1.5 GB download while its 30 s WS handshake ticks down.
The instance is intentionally discarded; WHL will instantiate its own from
the now-warm cache.
"""
import os

from faster_whisper import WhisperModel
from whisper_live.server import TranscriptionServer

MODEL = os.environ.get("WHL_MODEL", "distil-large-v3")

print(f"[run_whl] Pre-caching {MODEL} (one-time download if not already in cache)...", flush=True)
WhisperModel(MODEL, device="cpu", compute_type="int8")
print(f"[run_whl] Model ready. Starting server on :9090.", flush=True)

TranscriptionServer().run(
    host="0.0.0.0",
    port=9090,
    backend="faster_whisper",
    single_model=True,
)
