/**
 * Phone build only: the in-browser stand-in for services/online's token
 * routes. The static site has no server, so the short-lived session credential
 * is minted here, straight from the provider, with the key the user saved on
 * this device (device-keys.ts).
 *
 * It answers the SAME paths with the SAME response shapes as the server
 * (services/online/src/routes/session.ts and gemini.ts), so the realtime
 * providers run unmodified. Only the translation path is brokered; the
 * pure-transcription routes are intentionally absent from the phone build.
 *
 * Never logs or echoes a key, and never forwards an upstream error body (it can
 * carry tenant details) — only the status and Retry-After.
 */
import { getDeviceKeys } from './device-keys.js';

const OPENAI_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/translations/client_secrets';
const GEMINI_AUTH_TOKENS_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
/** Kept identical to the server allowlist (services/online/src/config.ts). */
const GEMINI_LIVE_MODEL = 'models/gemini-3.5-live-translate-preview';
const UPSTREAM_TIMEOUT_MS = 10_000;
/** OpenAI translation sessions cap near 30 min; renew earlier (server default). */
const SESSION_RENEW_MS = 25 * 60 * 1000;
const GEMINI_NEW_SESSION_WINDOW_MS = 2 * 60 * 1000;
const GEMINI_TOKEN_TTL_MS = 30 * 60 * 1000;

const LANG_OUTPUT: Record<string, string> = { 'en→zh-TW': 'zh', 'zh-TW→en': 'en' };
const MIC_DISTANCES = ['meeting', 'close', 'far', 'off'];

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function retryAfter(upstream: Response): Record<string, string> {
  const value = upstream.headers.get('Retry-After');
  return value && (/^\d+$/.test(value) || Number.isFinite(Date.parse(value)))
    ? { 'Retry-After': value }
    : {};
}

/** Caller abort and our own deadline both cancel the upstream request. */
async function upstream(
  url: string,
  init: RequestInit,
  callerSignal: AbortSignal | null | undefined,
): Promise<Response | 'timeout'> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onAbort();
  callerSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) return 'timeout';
    throw error; // caller abort or network failure: same as a real fetch
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onAbort);
  }
}

function sessionInfo(): Response {
  const keys = getDeviceKeys();
  const hasApiKey = Boolean(keys.openai);
  const hasGeminiKey = Boolean(keys.gemini);
  return json(200, {
    hasApiKey,
    hasGeminiKey,
    availableProviders: [...(hasApiKey ? ['openai'] : []), ...(hasGeminiKey ? ['gemini'] : [])],
    taskCapabilities: [
      { provider: 'openai', purpose: 'translation', configured: hasApiKey, verified: false },
      { provider: 'gemini', purpose: 'translation', configured: hasGeminiKey, verified: false },
    ],
    sessionRenewalRecommendedMs: SESSION_RENEW_MS,
    supportedLangPairs: Object.keys(LANG_OUTPUT),
  });
}

async function mintOpenAI(init: RequestInit | undefined): Promise<Response> {
  const apiKey = getDeviceKeys().openai;
  if (!apiKey) return json(503, { error: 'OpenAI key is not saved on this device' });

  let body: Record<string, unknown> = {};
  try {
    if (typeof init?.body === 'string' && init.body) body = JSON.parse(init.body);
  } catch {
    return json(400, { error: 'Invalid request body' });
  }
  const langPair = body['langPair'] ?? 'en→zh-TW';
  const micDistance = body['micDistance'] ?? 'close';
  const includeSource = body['includeSourceTranscript'] ?? true;
  if (
    typeof langPair !== 'string' ||
    !(langPair in LANG_OUTPUT) ||
    typeof micDistance !== 'string' ||
    !MIC_DISTANCES.includes(micDistance) ||
    typeof includeSource !== 'boolean'
  )
    return json(400, { error: 'Invalid request body' });

  // Same session shape as the server route; see the notes there for why
  // 'meeting' maps to far_field and why no input language is sent.
  const audioInput: Record<string, unknown> = {};
  if (micDistance === 'close') audioInput['noise_reduction'] = { type: 'near_field' };
  else if (micDistance !== 'off') audioInput['noise_reduction'] = { type: 'far_field' };
  if (includeSource) audioInput['transcription'] = { model: 'gpt-realtime-whisper' };

  const res = await upstream(
    OPENAI_CLIENT_SECRETS_URL,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: {
          model: 'gpt-realtime-translate',
          audio: { input: audioInput, output: { language: LANG_OUTPUT[langPair] } },
        },
      }),
    },
    init?.signal,
  );
  if (res === 'timeout') return json(504, { error: 'OpenAI session bring-up timed out' });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const error =
      res.status === 401
        ? 'Upstream rejected the API key'
        : res.status === 429
          ? 'Upstream rate-limited; retry shortly'
          : `Upstream returned ${res.status}`;
    return json(res.status, { error }, retryAfter(res));
  }
  const data = (await res.json()) as { value?: unknown; expires_at?: unknown };
  if (typeof data.value !== 'string' || !data.value)
    return json(502, { error: 'Invalid session credential response' });
  return json(200, {
    client_secret: {
      value: data.value,
      ...(typeof data.expires_at === 'number' ? { expires_at: data.expires_at } : {}),
    },
    session_renewal_recommended_ms: SESSION_RENEW_MS,
    // No key_slot: a single device key has no alternate to fail over to.
  });
}

async function mintGemini(init: RequestInit | undefined): Promise<Response> {
  const apiKey = getDeviceKeys().gemini;
  if (!apiKey) return json(503, { error: 'Gemini key is not saved on this device' });
  const now = Date.now();
  const res = await upstream(
    GEMINI_AUTH_TOKENS_URL,
    {
      method: 'POST',
      // Header, not ?key=: keeps the key out of URLs, history and referrers.
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      // Unconstrained single-use token, as on the server: locking the setup in
      // the token made the Live socket close with 1011 (see routes/gemini.ts).
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(now + GEMINI_TOKEN_TTL_MS).toISOString(),
        newSessionExpireTime: new Date(now + GEMINI_NEW_SESSION_WINDOW_MS).toISOString(),
      }),
    },
    init?.signal,
  );
  if (res === 'timeout') return json(504, { error: 'Gemini token mint timed out' });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const error =
      res.status === 401 || res.status === 403
        ? 'Upstream rejected the Gemini API key'
        : res.status === 429
          ? 'Gemini rate-limited; retry shortly'
          : `Gemini returned ${res.status}`;
    return json(
      res.status < 500 ? res.status : 502,
      { error },
      res.status === 429 ? retryAfter(res) : {},
    );
  }
  const data = (await res.json()) as { name?: unknown };
  if (typeof data.name !== 'string' || !data.name)
    return json(502, { error: 'Gemini token response missing name' });
  return json(200, { token: data.name, model: GEMINI_LIVE_MODEL });
}

/** Drop-in for `fetch` on the service paths; anything else is a 404, never the network. */
export const deviceBrokerFetch: typeof fetch = async (input, init) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(href, 'https://device.invalid').pathname.replace(/\/+$/, '');
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'GET' && path.endsWith('/session/info')) return sessionInfo();
  if (method === 'POST' && path.endsWith('/session/gemini')) return mintGemini(init);
  if (method === 'POST' && path.endsWith('/session')) return mintOpenAI(init);
  return json(404, { error: 'Not available in the phone build' });
};
