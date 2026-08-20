import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  OPENAI_API_KEY: undefined as string | undefined,
  OPENAI_API_KEY_AUDIO: undefined as string | undefined,
}));

vi.mock('./config.js', () => ({
  config: new Proxy(mockConfig, {
    get: (target, prop) => target[prop as keyof typeof target],
  }),
}));

import {
  DEMOTION_TTL_MS,
  _resetOpenAIKeysForTests,
  activeOpenAIKeySlot,
  demoteOpenAIKeySlot,
  fetchWithOpenAIKeyFailover,
  hasAnyOpenAIKey,
  openAIKeyDemotion,
} from './openai-keys.js';

function resp(status: number): Response {
  return new Response('{}', { status });
}

beforeEach(() => {
  _resetOpenAIKeysForTests();
  mockConfig.OPENAI_API_KEY = undefined;
  mockConfig.OPENAI_API_KEY_AUDIO = undefined;
});

afterEach(() => vi.restoreAllMocks());

describe('hasAnyOpenAIKey', () => {
  it('is false with no keys, true with either key', () => {
    expect(hasAnyOpenAIKey()).toBe(false);
    mockConfig.OPENAI_API_KEY_AUDIO = 'sk-audio';
    expect(hasAnyOpenAIKey()).toBe(true);
    mockConfig.OPENAI_API_KEY_AUDIO = undefined;
    mockConfig.OPENAI_API_KEY = 'sk-primary';
    expect(hasAnyOpenAIKey()).toBe(true);
  });
});

describe('fetchWithOpenAIKeyFailover', () => {
  it('throws when no key is configured', async () => {
    await expect(fetchWithOpenAIKeyFailover(async () => resp(200))).rejects.toThrow(
      'No OpenAI API key configured',
    );
  });

  it('uses the primary key and does not retry on success', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-primary';
    mockConfig.OPENAI_API_KEY_AUDIO = 'sk-audio';
    const makeRequest = vi.fn(async () => resp(200));
    const { res, slot } = await fetchWithOpenAIKeyFailover(makeRequest);
    expect(res.status).toBe(200);
    expect(slot).toBe('primary');
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(makeRequest).toHaveBeenCalledWith('sk-primary');
  });

  it('retries with the audio key on 403 and sticks to it after success', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-primary';
    mockConfig.OPENAI_API_KEY_AUDIO = 'sk-audio';
    const makeRequest = vi.fn(async (key: string) =>
      key === 'sk-primary' ? resp(403) : resp(200),
    );
    const first = await fetchWithOpenAIKeyFailover(makeRequest);
    expect(first.res.status).toBe(200);
    expect(first.slot).toBe('audio');
    expect(makeRequest).toHaveBeenCalledTimes(2);
    expect(activeOpenAIKeySlot()).toBe('audio');

    // Sticky: the next call goes straight to the audio key — no failing
    // primary round-trip.
    makeRequest.mockClear();
    const second = await fetchWithOpenAIKeyFailover(makeRequest);
    expect(second.slot).toBe('audio');
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(makeRequest).toHaveBeenCalledWith('sk-audio');
  });

  it('retries on 401 but does not stick when the alternate also fails', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-primary';
    mockConfig.OPENAI_API_KEY_AUDIO = 'sk-audio';
    const makeRequest = vi.fn(async () => resp(401));
    const { res, slot } = await fetchWithOpenAIKeyFailover(makeRequest);
    expect(res.status).toBe(401);
    expect(slot).toBe('audio');
    expect(makeRequest).toHaveBeenCalledTimes(2);
    expect(activeOpenAIKeySlot()).toBe('primary');
  });

  it('does not switch keys on 429 (not a permission failure)', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-primary';
    mockConfig.OPENAI_API_KEY_AUDIO = 'sk-audio';
    const makeRequest = vi.fn(async () => resp(429));
    const { res, slot } = await fetchWithOpenAIKeyFailover(makeRequest);
    expect(res.status).toBe(429);
    expect(slot).toBe('primary');
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(activeOpenAIKeySlot()).toBe('primary');
  });

  it('does not retry a 403 when only one key is configured', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-primary';
    const makeRequest = vi.fn(async () => resp(403));
    const { res, slot } = await fetchWithOpenAIKeyFailover(makeRequest);
    expect(res.status).toBe(403);
    expect(slot).toBe('primary');
    expect(makeRequest).toHaveBeenCalledTimes(1);
  });

  it('uses the audio key directly when it is the only key configured', async () => {
    mockConfig.OPENAI_API_KEY_AUDIO = 'sk-audio';
    const makeRequest = vi.fn(async () => resp(200));
    const { slot } = await fetchWithOpenAIKeyFailover(makeRequest);
    expect(slot).toBe('audio');
    expect(makeRequest).toHaveBeenCalledWith('sk-audio');
  });

  it('fails back to the primary key when the sticky audio key starts failing', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-primary';
    mockConfig.OPENAI_API_KEY_AUDIO = 'sk-audio';
    // First call: primary 403 → audio ok → sticky audio.
    await fetchWithOpenAIKeyFailover(async (key) => (key === 'sk-primary' ? resp(403) : resp(200)));
    expect(activeOpenAIKeySlot()).toBe('audio');
    // Later the audio key is revoked → 401 → retried with primary, which now works.
    const makeRequest = vi.fn(async (key: string) => (key === 'sk-audio' ? resp(401) : resp(200)));
    const { res, slot } = await fetchWithOpenAIKeyFailover(makeRequest);
    expect(res.status).toBe(200);
    expect(slot).toBe('primary');
    expect(activeOpenAIKeySlot()).toBe('primary');
  });
});

// ── Call-stage rejection (reported by the browser) ───────────────────────────
//
// The mint succeeds but the ephemeral token it produced is rejected at the SDP
// exchange (measured: 401 ip_not_authorized from an org IP allowlist that
// covers the realtime call endpoint but not the mint endpoint). Nothing in
// this process can see that, so the browser names the slot back to us.

describe('demoteOpenAIKeySlot (downstream rejection)', () => {
  it('makes the next mint use the alternate key without touching the primary', async () => {
    mockConfig.OPENAI_API_KEY = 'sk-primary';
    mockConfig.OPENAI_API_KEY_AUDIO = 'sk-audio';
    expect(activeOpenAIKeySlot()).toBe('primary');

    demoteOpenAIKeySlot('primary', 'rejected at the SDP exchange');

    expect(activeOpenAIKeySlot()).toBe('audio');
    const makeRequest = vi.fn(async () => resp(200));
    const { slot } = await fetchWithOpenAIKeyFailover(makeRequest);
    expect(slot).toBe('audio');
    expect(makeRequest).toHaveBeenCalledOnce();
    expect(makeRequest).toHaveBeenCalledWith('sk-audio');
  });

  it('reports the demotion (slot + reason) for diagnostics, never key material', () => {
    mockConfig.OPENAI_API_KEY = 'sk-primary';
    mockConfig.OPENAI_API_KEY_AUDIO = 'sk-audio';
    expect(openAIKeyDemotion()).toBeNull();

    demoteOpenAIKeySlot('primary', 'ip_not_authorized at the SDP exchange');

    const demoted = openAIKeyDemotion();
    expect(demoted?.slot).toBe('primary');
    expect(demoted?.reason).toContain('ip_not_authorized');
    expect(JSON.stringify(demoted)).not.toContain('sk-');
  });

  it('is ignored when there is no alternate key to fall back to', () => {
    mockConfig.OPENAI_API_KEY = 'sk-primary';
    demoteOpenAIKeySlot('primary', 'rejected at the SDP exchange');
    // One key means the honest outcome is to keep using it, not to mint nothing.
    expect(activeOpenAIKeySlot()).toBe('primary');
    expect(openAIKeyDemotion()).toBeNull();
  });

  it('expires after the TTL so the preferred key is tried again on a new network', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-20T09:00:00Z'));
      mockConfig.OPENAI_API_KEY = 'sk-primary';
      mockConfig.OPENAI_API_KEY_AUDIO = 'sk-audio';
      demoteOpenAIKeySlot('primary', 'rejected at the SDP exchange');
      expect(activeOpenAIKeySlot()).toBe('audio');

      vi.advanceTimersByTime(DEMOTION_TTL_MS - 1000);
      expect(activeOpenAIKeySlot()).toBe('audio');

      vi.advanceTimersByTime(2000);
      expect(activeOpenAIKeySlot()).toBe('primary');
      expect(openAIKeyDemotion()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a mint-stage failover also demotes, and the demotion also expires', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-20T09:00:00Z'));
      mockConfig.OPENAI_API_KEY = 'sk-primary';
      mockConfig.OPENAI_API_KEY_AUDIO = 'sk-audio';
      const makeRequest = vi.fn().mockResolvedValueOnce(resp(401)).mockResolvedValueOnce(resp(200));
      await fetchWithOpenAIKeyFailover(makeRequest);
      expect(activeOpenAIKeySlot()).toBe('audio');

      vi.advanceTimersByTime(DEMOTION_TTL_MS + 1000);
      expect(activeOpenAIKeySlot()).toBe('primary');
    } finally {
      vi.useRealTimers();
    }
  });
});
