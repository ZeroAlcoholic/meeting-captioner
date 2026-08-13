import { describe, expect, it, vi } from 'vitest';
import { WarmTokenCache } from './token-prewarm.js';

describe('WarmTokenCache — standby refresh', () => {
  it('re-mints an entry older than the caller cares about, before it goes stale', async () => {
    // A standby token must be usable at any moment. Refreshing only once the
    // entry has ALREADY expired leaves a window where the failover it exists
    // for still pays for a round-trip: with a 45 s freshness and a 30 s tick,
    // the tick was a no-op, the token died at 45 s, and nothing replaced it
    // until 60 s.
    let clock = 0;
    const cache = new WarmTokenCache<string>(45_000, 0, () => clock);
    const mint = vi.fn(async () => `token-${clock}`);

    await cache.prewarm('k', mint, () => null, 30_000);
    expect(mint).toHaveBeenCalledTimes(1);

    // Still young: nothing to do.
    clock = 20_000;
    await cache.prewarm('k', mint, () => null, 30_000);
    expect(mint).toHaveBeenCalledTimes(1);

    // Past the caller's threshold but still technically fresh — this is the
    // moment that used to be skipped.
    clock = 30_000;
    await cache.prewarm('k', mint, () => null, 30_000);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(cache.consume('k')).toBe('token-30000');
  });

  it('without the threshold, a still-fresh entry is left alone', async () => {
    let clock = 0;
    const cache = new WarmTokenCache<string>(45_000, 0, () => clock);
    const mint = vi.fn(async () => 'token');

    await cache.prewarm('k', mint, () => null);
    clock = 30_000;
    await cache.prewarm('k', mint, () => null);

    expect(mint).toHaveBeenCalledTimes(1);
  });
});

describe('WarmTokenCache', () => {
  it('pre-mints once and hands the token to a matching consume (single-use)', async () => {
    const cache = new WarmTokenCache<string>();
    const mint = vi.fn().mockResolvedValue('tok-1');

    await cache.prewarm('k', mint, () => null);
    expect(mint).toHaveBeenCalledTimes(1);

    expect(cache.consume('k')).toBe('tok-1');
    // Single-use: a second consume gets nothing.
    expect(cache.consume('k')).toBeNull();
  });

  it('does not re-mint while a fresh entry for the same key exists', async () => {
    const cache = new WarmTokenCache<string>();
    const mint = vi.fn().mockResolvedValue('tok');
    await cache.prewarm('k', mint, () => null);
    await cache.prewarm('k', mint, () => null);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('refuses a token whose key does not match (caller fetches fresh)', async () => {
    const cache = new WarmTokenCache<string>();
    await cache.prewarm('k1', vi.fn().mockResolvedValue('tok'), () => null);
    expect(cache.consume('k2')).toBeNull();
    // The non-matching consume must NOT evict the entry — it's still available
    // for the right key.
    expect(cache.consume('k1')).toBe('tok');
  });

  it('treats a token older than the freshness TTL as stale', async () => {
    let now = 1_000_000;
    const cache = new WarmTokenCache<string>(45_000, 120_000, () => now);
    await cache.prewarm('k', vi.fn().mockResolvedValue('tok'), () => null);
    now += 46_000; // > 45 s TTL
    expect(cache.consume('k')).toBeNull();
  });

  it('refuses a token within the safety margin of its hard expiry', async () => {
    let now = 1_000_000;
    const cache = new WarmTokenCache<string>(45_000, 120_000, () => now);
    // Expires 60 s from now → inside the 120 s safety margin.
    await cache.prewarm('k', vi.fn().mockResolvedValue('tok'), () => now + 60_000);
    expect(cache.has('k')).toBe(false);
    expect(cache.consume('k')).toBeNull();
  });

  it('accepts a token comfortably before expiry', async () => {
    let now = 1_000_000;
    const cache = new WarmTokenCache<string>(45_000, 120_000, () => now);
    await cache.prewarm('k', vi.fn().mockResolvedValue('tok'), () => now + 600_000);
    expect(cache.has('k')).toBe(true);
    expect(cache.consume('k')).toBe('tok');
  });

  it('swallows mint failures (best-effort) and leaves the cache empty', async () => {
    const cache = new WarmTokenCache<string>();
    await cache.prewarm('k', vi.fn().mockRejectedValue(new Error('boom')), () => null);
    expect(cache.consume('k')).toBeNull();
  });

  it('a second prewarm after consume re-mints', async () => {
    const cache = new WarmTokenCache<string>();
    const mint = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b');
    await cache.prewarm('k', mint, () => null);
    expect(cache.consume('k')).toBe('a');
    await cache.prewarm('k', mint, () => null);
    expect(cache.consume('k')).toBe('b');
    expect(mint).toHaveBeenCalledTimes(2);
  });
});
