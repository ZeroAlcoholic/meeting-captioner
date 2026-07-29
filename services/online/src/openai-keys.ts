import { config } from './config.js';

// ── OpenAI key failover ─────────────────────────────────────────────────────
//
// Two keys can be configured in the system env:
//   OPENAI_API_KEY        — primary (may be endpoint/domain-restricted by
//                           org policy, e.g. a scoped service-account key)
//   OPENAI_API_KEY_AUDIO  — alternate private key for calls the primary is
//                           not permitted to make
//
// A 401/403 from upstream is the signature of the restricted key hitting an
// out-of-scope endpoint, so the call is retried once with the other key.
// A successful retry makes the switch sticky — later calls go straight to
// the working key instead of paying the failing round-trip every time.
// 429 / 5xx / network errors never trigger a switch: they are not
// permission failures and the alternate key would not help.

export type OpenAIKeySlot = 'primary' | 'audio';

interface KeyEntry {
  slot: OpenAIKeySlot;
  key: string;
}

let activeSlot: OpenAIKeySlot = 'primary';

function configuredKeys(): KeyEntry[] {
  const keys: KeyEntry[] = [];
  if (config.OPENAI_API_KEY) keys.push({ slot: 'primary', key: config.OPENAI_API_KEY });
  if (config.OPENAI_API_KEY_AUDIO) keys.push({ slot: 'audio', key: config.OPENAI_API_KEY_AUDIO });
  return keys;
}

export function hasAnyOpenAIKey(): boolean {
  return configuredKeys().length > 0;
}

export function activeOpenAIKeySlot(): OpenAIKeySlot {
  return activeSlot;
}

export function _resetOpenAIKeysForTests(): void {
  activeSlot = 'primary';
}

const AUTH_REJECT_STATUSES = new Set([401, 403]);

type WarnLogger = { warn: (obj: Record<string, unknown>, msg?: string) => void };

export interface KeyedFetchResult {
  res: Response;
  /** Which key slot produced the returned response (for diagnostics). */
  slot: OpenAIKeySlot;
}

/**
 * Run an upstream OpenAI request with the active key; on 401/403 retry once
 * with the alternate key (if configured) and stick to it when the retry
 * succeeds. Network errors / timeouts from `makeRequest` propagate to the
 * caller unchanged — existing route error handling stays authoritative.
 */
export async function fetchWithOpenAIKeyFailover(
  makeRequest: (apiKey: string) => Promise<Response>,
  log?: WarnLogger,
): Promise<KeyedFetchResult> {
  const keys = configuredKeys();
  const [first] = keys;
  if (!first) {
    throw new Error('No OpenAI API key configured');
  }
  const active = keys.find((k) => k.slot === activeSlot) ?? first;

  const res = await makeRequest(active.key);
  if (!AUTH_REJECT_STATUSES.has(res.status)) {
    return { res, slot: active.slot };
  }

  const alternate = keys.find((k) => k.slot !== active.slot);
  if (!alternate) {
    return { res, slot: active.slot };
  }

  log?.warn(
    { rejected_slot: active.slot, upstream_status: res.status, retry_slot: alternate.slot },
    'OpenAI key rejected upstream (auth/permission) — retrying with alternate key',
  );
  const retry = await makeRequest(alternate.key);
  if (retry.ok) {
    activeSlot = alternate.slot;
    log?.warn(
      { active_slot: alternate.slot },
      'Alternate OpenAI key accepted — switched active key for subsequent calls',
    );
  }
  return { res: retry, slot: alternate.slot };
}
