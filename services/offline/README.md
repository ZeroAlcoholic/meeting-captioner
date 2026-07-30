# services/offline

Local STT/MT service. WhisperLiveKit performs streaming speech recognition and
FastAPI normalizes transcript, translation, audio, and health events for the web
client.

## Runtime topology

Both processes bind to loopback only:

- WhisperLiveKit: `127.0.0.1:9090`
- FastAPI: `127.0.0.1:8000`

Use `start.bat` on Windows or `start.sh` from a Unix-compatible shell to start
both processes without development reload. Both launchers use `run_whl.py`, so
they share the same single-model and connection-duration policy.

## Development

```text
cd services/offline
uv sync
uv run python run_whl.py
```

In a second terminal:

```text
cd services/offline
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

## Interfaces

- `GET /healthz` — component health and model readiness
- `WS /ws` — normalized audio, transcript, translation, and health event stream

## Verification

```text
uv run pytest
uv run ruff check .
```
