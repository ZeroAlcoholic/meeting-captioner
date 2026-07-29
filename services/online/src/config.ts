import { z } from 'zod';

// ── Configuration policy ───────────────────────────────────────────────────
//
// `OPENAI_API_KEY` and every other config knob are read ONLY from the
// system / user environment (cmd `setx`, PowerShell `$env:`, POSIX
// `export`). The slim distribution explicitly does NOT support `.env`
// files — keeping secrets out of the filesystem avoids accidental
// commits, archival, backup-to-cloud, and copy-paste leaks.
//
// If a future deployment ever wants a `.env`, the user has to opt in
// explicitly and load it themselves (e.g. `node --env-file=.env ...`
// from Node 20.6+). The bundled server itself is hard-locked to
// `process.env` and nothing else.

const ConfigSchema = z.object({
  ONLINE_PORT: z.coerce.number().int().positive().default(8787),
  /**
   * Bind host. Defaults to 127.0.0.1 (loopback only) — the slim distribution
   * carries no authentication, and the OpenAI API key lives in this process,
   * so we must not expose /session to the LAN by default. Override to
   * 0.0.0.0 only if you understand the implication.
   */
  ONLINE_HOST: z.string().default('127.0.0.1'),
  ONLINE_CORS_ORIGIN: z.string().default('http://localhost:5173'),
  OPENAI_API_KEY: z.string().optional(),
  /**
   * Alternate private OpenAI key. The primary OPENAI_API_KEY may be
   * endpoint/domain-restricted (scoped service-account policy); when an
   * upstream call is rejected with 401/403 the server retries once with
   * this key and sticks to whichever works (see openai-keys.ts). Optional —
   * single-key deployments are unaffected.
   */
  OPENAI_API_KEY_AUDIO: z.string().optional(),
  /**
   * Google Gemini Developer API key (AI Studio). When set, the server can mint
   * short-lived ephemeral tokens for the browser to open a Gemini Live API
   * WebSocket directly (the raw key never reaches the browser). This enables
   * Gemini as a second online realtime backend selectable in the UI.
   */
  GEMINI_API_KEY: z.string().optional(),
  /**
   * Gemini Live model id — ALLOWLISTED to the latest dedicated live-translation
   * model only (continuous streaming, purpose-built translation via
   * translationConfig, Traditional-Chinese output). Arbitrary overrides are
   * rejected at startup: older/native-audio models are NOT an equivalent
   * capability and silently degrading to them violates the latest-model
   * mandate. Extend this enum deliberately when Google ships a successor.
   * The `models/` prefix is added by the token route.
   */
  GEMINI_LIVE_MODEL: z
    .enum(['gemini-3.5-live-translate-preview'])
    .default('gemini-3.5-live-translate-preview'),
  // Hard cap on the upstream OpenAI client_secrets fetch. Above this we 504 the caller
  // rather than letting the browser hang on a stalled WebRTC bring-up.
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Token-bucket cap on POST /session per remote IP. Single-process only;
  // a multi-instance deployment must front this with a shared store.
  SESSION_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(30),
  // OpenAI Realtime translation sessions cap around 30 min. We tell the client
  // to renew earlier so users never hit the silent freeze.
  SESSION_RENEW_MS: z.coerce.number().int().positive().default(25 * 60 * 1000),
  /**
   * Optional path (absolute or relative to cwd) to a built `apps/web/dist`
   * directory. When set, the server serves the web app as static files at
   * `/` so the slim distribution can run from a single process. Leave unset
   * during dev — Vite handles the SPA at :5173.
   */
  WEB_DIST_PATH: z.string().optional(),
});

export const config = ConfigSchema.parse(process.env);
export type Config = z.infer<typeof ConfigSchema>;

// Startup diagnostic — printed once so end users can confirm at a glance
// whether the system env carries an OPENAI_API_KEY, without ever logging
// the key value itself.
const keyLen = config.OPENAI_API_KEY?.length ?? 0;
// eslint-disable-next-line no-console
console.log(
  `[config] OPENAI_API_KEY: ${
    keyLen > 0
      ? `set in system env (${keyLen} chars)`
      : 'MISSING — set OPENAI_API_KEY in your user/system env, then restart'
  }`,
);
const audioKeyLen = config.OPENAI_API_KEY_AUDIO?.length ?? 0;
// eslint-disable-next-line no-console
console.log(
  `[config] OPENAI_API_KEY_AUDIO: ${
    audioKeyLen > 0
      ? `set in system env (${audioKeyLen} chars) — auth-failure failover enabled`
      : 'not set — no alternate key failover'
  }`,
);
const geminiKeyLen = config.GEMINI_API_KEY?.length ?? 0;
// eslint-disable-next-line no-console
console.log(
  `[config] GEMINI_API_KEY: ${
    geminiKeyLen > 0
      ? `set in system env (${geminiKeyLen} chars) — Gemini backend available, model=${config.GEMINI_LIVE_MODEL}`
      : 'not set — Gemini backend disabled'
  }`,
);
