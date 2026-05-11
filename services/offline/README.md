# services/offline

Python 3.11 + FastAPI bridge for local STT/MT engines.

## P0 endpoints
- `GET /healthz` — liveness check

## Dev
```
cd services/offline
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

## Tests
```
uv run pytest
```

## Lint
```
uv run ruff check .
```

## Why this exists in P0
Same reason as `services/online`: forcing the service boundary to exist
from day one so future WhisperLiveKit / faster-whisper / Argos / WASAPI
loopback work plugs in without restructuring the architecture.

## Coming in later phases
- P3 — WhisperLiveKit spike + OfflineSTTProvider
- P3 — Windows WASAPI loopback (PyAudioWPatch)
- P4 — Argos Translate
