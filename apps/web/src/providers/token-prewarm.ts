// ─── Warm ephemeral-token cache ──────────────────────────────────────────────
//
// Pre-mints a backend session token while the app is idle so a subsequent Start
// can skip the token round-trip. SAFE BY CONSTRUCTION: a token is handed out only
// when it exactly matches the request key AND is still fresh AND not near expiry;
// any doubt → `consume()` returns null and the caller fetches a fresh one (i.e.
// the worst case is exactly today's behaviour). Single-use: consuming clears the
// cache, so reconnects / renewals always mint fresh (correct for single-use /
// short-expiry tokens like Gemini's uses:1).
//
// Why pre-mint at all: after the shared audio engine + parallel mic/token work,
// the token fetch became the long pole on a WARM start (mic + context already
// hot). This hides that remaining ~150-250 ms behind idle time.

export class WarmTokenCache<T> {
  private entry: { value: T; mintedAt: number; key: string; expiresAtMs: number | null } | null =
    null;
  private inFlight = false;

  constructor(
    /** Max age of a pre-minted token before it's considered stale. */
    private readonly freshTtlMs = 45_000,
    /** Refuse to hand out a token within this margin of its hard expiry. */
    private readonly expirySafetyMs = 120_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private isFresh(
    entry: { mintedAt: number; expiresAtMs: number | null },
    nowMs: number,
  ): boolean {
    if (nowMs - entry.mintedAt > this.freshTtlMs) return false;
    if (entry.expiresAtMs !== null && entry.expiresAtMs - nowMs < this.expirySafetyMs) return false;
    return true;
  }

  /**
   * Best-effort pre-mint for `key` if there is no fresh cached entry already.
   * Never throws (pre-warm failures are silent — Start will fetch fresh). A mint
   * already in flight short-circuits, so repeated triggers don't pile up.
   */
  async prewarm(
    key: string,
    mint: () => Promise<T>,
    expiresAtMs: (value: T) => number | null,
  ): Promise<void> {
    if (this.inFlight) return;
    const nowMs = this.now();
    if (this.entry && this.entry.key === key && this.isFresh(this.entry, nowMs)) return;
    this.inFlight = true;
    try {
      const value = await mint();
      this.entry = { value, mintedAt: this.now(), key, expiresAtMs: expiresAtMs(value) };
    } catch {
      /* pre-mint is best-effort */
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Single-use take: returns the warm value iff it matches `key` and is fresh +
   * not near expiry, clearing the cache. Returns null otherwise (caller fetches).
   */
  consume(key: string): T | null {
    const e = this.entry;
    if (e && e.key === key && this.isFresh(e, this.now())) {
      this.entry = null;
      return e.value;
    }
    return null;
  }

  /** Whether a fresh, matching entry is currently available (no side effects). */
  has(key: string): boolean {
    const e = this.entry;
    return !!e && e.key === key && this.isFresh(e, this.now());
  }

  clear(): void {
    this.entry = null;
  }
}
