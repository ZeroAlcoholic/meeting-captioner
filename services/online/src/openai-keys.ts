import { config } from './config.js';

// ── OpenAI key failover ─────────────────────────────────────────────────────
//
// Two keys can be configured in the system env:
//   OPENAI_API_KEY        — PRIMARY, always preferred (may be endpoint/network
//                           restricted by org policy, e.g. a corporate
//                           service-account key behind an IP allowlist)
//   OPENAI_API_KEY_AUDIO  — alternate private key for calls the primary is
//                           not permitted to make
//
// Two DIFFERENT rejections have to be handled, and only the first one is
// visible to this process:
//
//   1. MINT-STAGE rejection — POST /v1/realtime/translations/client_secrets
//      returns 401/403. Seen here directly; retried once with the alternate.
//
//   2. CALL-STAGE rejection — the mint SUCCEEDS, but the ephemeral token it
//      produced is rejected one hop later, when the BROWSER posts its SDP to
//      /v1/realtime/translations/calls. Measured signature on a corporate
//      network (2026-08-20): mint 200 with the sk-svcacct key, then
//      `401 ip_not_authorized — "Your IP is not authorized to make this
//      request."` at the calls endpoint, while an ek minted from the sk-proj
//      key returns 201 over the same connection from the same machine. The
//      allowlist covers the realtime media endpoint, not the mint endpoint,
//      so nothing this process can observe on its own reveals the problem.
//      The browser reports it back via `rejectedSlot` on the next /session.
//
// PREFERENCE ORDER IS DELIBERATE: the primary key is always tried first, so a
// laptop that moves back inside the allowed network range goes straight back
// to using it. A demotion is therefore time-boxed rather than permanent —
// after DEMOTION_TTL_MS the primary is probed again (one extra round trip,
// once, and only if the alternate is still working from the fallback path).
//
// 429 / 5xx / network errors never trigger a switch: they are not permission
// failures and the alternate key would not help.

export type OpenAIKeySlot = 'primary' | 'audio';

interface KeyEntry {
  slot: OpenAIKeySlot;
  key: string;
}

/**
 * How long a slot stays demoted after a proven rejection. Long enough that a
 * single meeting never re-probes a key known to be blocked here; short enough
 * that moving to another network (or the policy changing) recovers the
 * preferred key without a restart.
 */
export const DEMOTION_TTL_MS = 30 * 60 * 1000;

interface Demotion {
  slot: OpenAIKeySlot;
  atMs: number;
  reason: string;
}

let demotion: Demotion | null = null;

function now(): number {
  return Date.now();
}

/** Drop an expired demotion so the primary key is preferred again. */
function pruneDemotion(nowMs = now()): void {
  if (demotion !== null && nowMs - demotion.atMs > DEMOTION_TTL_MS) {
    demotion = null;
  }
}

function configuredKeys(): KeyEntry[] {
  const keys: KeyEntry[] = [];
  if (config.OPENAI_API_KEY) keys.push({ slot: 'primary', key: config.OPENAI_API_KEY });
  if (config.OPENAI_API_KEY_AUDIO) keys.push({ slot: 'audio', key: config.OPENAI_API_KEY_AUDIO });
  return keys;
}

export function hasAnyOpenAIKey(): boolean {
  return configuredKeys().length > 0;
}

/**
 * The slot the next mint will use: the primary unless it is currently
 * demoted by a proven rejection. Diagnostics only — the mint path resolves
 * this itself.
 */
export function activeOpenAIKeySlot(): OpenAIKeySlot {
  pruneDemotion();
  const keys = configuredKeys();
  const preferred = keys.find((k) => k.slot !== demotion?.slot) ?? keys[0];
  return preferred?.slot ?? 'primary';
}

/** Current demotion state, for /session/info diagnostics. */
export function openAIKeyDemotion(): { slot: OpenAIKeySlot; reason: string; ageMs: number } | null {
  pruneDemotion();
  return demotion === null
    ? null
    : { slot: demotion.slot, reason: demotion.reason, ageMs: now() - demotion.atMs };
}

/**
 * Record that `slot` was rejected for a permission reason, so the next mint
 * prefers the other key. Ignored when no alternate key is configured — a
 * single-key deployment has nothing to fall back to and must keep using the
 * only key it has (the caller still gets a token; it just fails the same way,
 * which is the honest outcome).
 */
export function demoteOpenAIKeySlot(slot: OpenAIKeySlot, reason: string, log?: WarnLogger): void {
  const keys = configuredKeys();
  if (!keys.some((k) => k.slot !== slot)) return;
  const alreadyDemoted = demotion?.slot === slot;
  demotion = { slot, atMs: now(), reason };
  if (!alreadyDemoted) {
    log?.warn(
      { demoted_slot: slot, reason, ttl_ms: DEMOTION_TTL_MS },
      'OpenAI key slot demoted after a proven rejection — preferring the alternate key',
    );
  }
}

export function _resetOpenAIKeysForTests(): void {
  demotion = null;
}

const AUTH_REJECT_STATUSES = new Set([401, 403]);

type WarnLogger = { warn: (obj: Record<string, unknown>, msg?: string) => void };

export interface KeyedFetchResult {
  res: Response;
  /** Which key slot produced the returned response (for diagnostics). */
  slot: OpenAIKeySlot;
}

/**
 * Run an upstream OpenAI request with the preferred key; on 401/403 retry once
 * with the alternate key (if configured) and demote the rejected slot when the
 * retry succeeds. Network errors / timeouts from `makeRequest` propagate to the
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
  pruneDemotion();
  const active = keys.find((k) => k.slot !== demotion?.slot) ?? first;

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
    demoteOpenAIKeySlot(active.slot, `mint rejected with ${res.status}`, log);
  }
  return { res: retry, slot: alternate.slot };
}
