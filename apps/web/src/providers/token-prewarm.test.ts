import { describe, expect, it, vi } from 'vitest';
import { WarmTokenCache } from './token-prewarm.js';

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
