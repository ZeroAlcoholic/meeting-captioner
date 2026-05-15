"""WhisperLiveKit launcher — single shared model + extended connection cap.

WHL's `python -m whisper_live.server` is import-only (no __main__ block).
This script invokes TranscriptionServer().run() with both:
  * faster_whisper_custom_model_path  → resolved local snapshot directory
  * single_model=True                 → all browser sessions share one in-memory model

WHL silently ignores single_model when given a non-custom model name (e.g.
"distil-large-v3"), forcing a fresh ~1.5 GB load per browser session. By passing
the resolved local path, single_model takes effect: first session pays the load
cost (~5–10 s on warm cache), subsequent sessions reuse the same model instance.

Model files are fetched once via huggingface_hub.snapshot_download — idempotent,
returns the local path, no extra download if already cached.

WHL's ClientManager hard-codes max_connection_time=600 (10 min), which silently
kills browser sessions at exactly 10 min mid-meeting. We patch the manager
instance after construction to extend that cap (env: WHL_MAX_CONN_TIME, default
3600 s = 1 h). This stays compatible with WHL upstream — no fork required.
"""
import os

from huggingface_hub import snapshot_download
from whisper_live.server import TranscriptionServer

MODEL = os.environ.get("WHL_MODEL", "distil-large-v3")
MAX_CONN_TIME = int(os.environ.get("WHL_MAX_CONN_TIME", "3600"))  # seconds

_REPO_MAP = {
    "tiny":              "Systran/faster-whisper-tiny",
    "tiny.en":           "Systran/faster-whisper-tiny.en",
    "base":              "Systran/faster-whisper-base",
    "base.en":           "Systran/faster-whisper-base.en",
    "small":             "Systran/faster-whisper-small",
    "small.en":          "Systran/faster-whisper-small.en",
    "medium":            "Systran/faster-whisper-medium",
    "medium.en":         "Systran/faster-whisper-medium.en",
    "large-v2":          "Systran/faster-whisper-large-v2",
    "large-v3":          "Systran/faster-whisper-large-v3",
    "distil-large-v3":   "Systran/faster-distil-whisper-large-v3",
    "large-v3-turbo":    "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "turbo":             "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
}

repo_id = _REPO_MAP.get(MODEL, MODEL)
print(f"[run_whl] Resolving local path for {repo_id} (download if not cached)...", flush=True)
local_path = snapshot_download(repo_id)
print(f"[run_whl] Model at {local_path}", flush=True)
print(f"[run_whl] max_connection_time = {MAX_CONN_TIME}s", flush=True)
print(f"[run_whl] Starting server on :9090 with single_model=True (one shared instance)", flush=True)

TranscriptionServer().run(
    host="0.0.0.0",
    port=9090,
    backend="faster_whisper",
    faster_whisper_custom_model_path=local_path,
    single_model=True,
    max_connection_time=MAX_CONN_TIME,
)
