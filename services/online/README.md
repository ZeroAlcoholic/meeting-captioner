# services/online

Fastify-based bridge for online providers (OpenAI Realtime in P2+).

## P0 endpoints
- `GET /healthz` — liveness check
- `POST /session` — stub (P2 will return OpenAI Realtime client secrets here)

## Dev
```
pnpm -F @meeting-audio/online dev
# default port 8787 (override via ONLINE_PORT in .env)
```

## Why this exists in P0
Even though no real OpenAI integration is wired up yet, the service
exists from day one so the renderer is forced to talk through a server
boundary — never directly to OpenAI. This makes "API key server-side
only" a structural guarantee, not a future cleanup.
