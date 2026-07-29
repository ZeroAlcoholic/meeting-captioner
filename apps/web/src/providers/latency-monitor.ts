// ─── Passive latency monitor (background, zero hot-path cost) ─────────────────
//
// Records caption-latency telemetry for whatever REAL session is running so we
// have ground-truth numbers next time — without a visible HUD and without
// affecting performance. The hot path does only: one Date.now() + a Map op +
// (on finalize) one bounded-array push. All statistics are computed lazily on
// read (summary/export), never on the event path.
//
// IMPORTANT (honesty): these are ARRIVAL-based proxies, not microphone-truth.
//   - ttfcMs        : transport 'connecting' → first translation event (session bring-up felt latency).
//   - lagMs/segment : segment's first observed event → its first translation event
//                     (how fast a translation shows once a segment starts streaming).
//   - durMs/segment : segment's first event → its finalization.
// True "spoken word → on-screen" latency needs an external clap/marker test with
// a real key; this monitor gives the repeatable in-app numbers to compare
// backends/configs and spot regressions. NEVER fed by mocks — it observes the
// live event stream only.

import type { TranscriptEvent, TranslationEvent, HealthEvent } from '@meeting-audio/contracts';

export interface LatencySample {
  provider: string;
  /** First-translation arrival − first-event arrival, ms. */
  lagMs: number;
  /** First-event arrival − finalization, ms. */
  durMs: number;
  /** Wall-clock ms when the segment finalized. */
  atMs: number;
}

export interface ProviderSummary {
  provider: string;
  samples: number;
  ttfcMs: number | null;
  lagP50: number | null;
  lagP95: number | null;
  durP50: number | null;
}

const SAMPLE_CAP = 2_000; // ring buffer; ~ hours of meeting, bounded memory
const PENDING_CAP = 500; // in-flight (un-finalized) segments tracked at once
const PERSIST_THROTTLE_MS = 15_000;
const PERSIST_KEY = 'meeting-audio:latency:v1';
const PERSIST_HISTORY_CAP = 50; // last N session summaries kept on disk

interface SegmentTiming {
  provider: string;
  firstEventMs: number;
  firstTranslationMs: number | null;
}

interface PersistedSessionSummary {
  endedAt: string;
  byProvider: ProviderSummary[];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? null;
}

export class LatencyMonitor {
  private sessionStartMs = 0;
  private sessionProvider: string | null = null;
  private ttfcMs: number | null = null;
  private readonly pending = new Map<string, SegmentTiming>();
  private samples: LatencySample[] = [];
  private lastPersistMs = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Transport 'connecting' marks a fresh bring-up — restart the TTFC clock. */
  recordHealth(ev: HealthEvent): void {
    if (ev.component === 'transport' && ev.state === 'connecting') {
      this.sessionStartMs = this.now();
      this.sessionProvider = null;
      this.ttfcMs = null;
      this.pending.clear();
    }
  }

  recordTranscript(ev: TranscriptEvent): void {
    this.touchSegment(ev.segmentId, ev.provider);
  }

  recordTranslation(ev: TranslationEvent): void {
    const t = this.now();
    const seg = this.touchSegment(ev.sourceSegmentId, ev.provider);
    if (seg.firstTranslationMs === null) {
      seg.firstTranslationMs = t;
      if (this.ttfcMs === null && this.sessionStartMs > 0) {
        this.ttfcMs = t - this.sessionStartMs;
      }
    }
    if (ev.status === 'final') {
      this.finalizeSegment(ev.sourceSegmentId, t);
    }
  }

  private touchSegment(segmentId: string, provider: string): SegmentTiming {
    let seg = this.pending.get(segmentId);
    if (!seg) {
      seg = { provider, firstEventMs: this.now(), firstTranslationMs: null };
      this.pending.set(segmentId, seg);
      this.sessionProvider ??= provider;
      // Bound the in-flight map: drop the oldest-inserted entry if a flood of
      // never-finalized segments accumulates (Map preserves insertion order).
      if (this.pending.size > PENDING_CAP) {
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.pending.delete(oldest);
      }
    }
    return seg;
  }

  private finalizeSegment(segmentId: string, atMs: number): void {
    const seg = this.pending.get(segmentId);
    if (!seg) return;
    this.pending.delete(segmentId);
    const sample: LatencySample = {
      provider: seg.provider,
      lagMs: seg.firstTranslationMs !== null ? seg.firstTranslationMs - seg.firstEventMs : -1,
      durMs: atMs - seg.firstEventMs,
      atMs,
    };
    this.samples.push(sample);
    if (this.samples.length > SAMPLE_CAP) this.samples.shift();
    this.maybePersist(atMs);
  }

  /** Lazily-computed per-provider summary (no hot-path cost). */
  summary(): ProviderSummary[] {
    const byProvider = new Map<string, LatencySample[]>();
    for (const s of this.samples) {
      const arr = byProvider.get(s.provider) ?? [];
      arr.push(s);
      byProvider.set(s.provider, arr);
    }
    // Ensure the active session's provider always appears — so TTFC is visible
    // even before any segment has finalized (draft-only window after bring-up).
    if (this.sessionProvider !== null && !byProvider.has(this.sessionProvider)) {
      byProvider.set(this.sessionProvider, []);
    }
    const out: ProviderSummary[] = [];
    for (const [provider, arr] of byProvider) {
      const lags = arr.map((s) => s.lagMs).filter((x) => x >= 0).sort((a, b) => a - b);
      const durs = arr.map((s) => s.durMs).sort((a, b) => a - b);
      out.push({
        provider,
        samples: arr.length,
        ttfcMs: provider === this.sessionProvider ? this.ttfcMs : null,
        lagP50: percentile(lags, 50),
        lagP95: percentile(lags, 95),
        durP50: percentile(durs, 50),
      });
    }
    return out;
  }

  /** Full raw export (for offline analysis). */
  export(): { sessionProvider: string | null; ttfcMs: number | null; samples: LatencySample[] } {
    return { sessionProvider: this.sessionProvider, ttfcMs: this.ttfcMs, samples: [...this.samples] };
  }

  /** Persisted rolling history of past session summaries (survives reloads). */
  history(): PersistedSessionSummary[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      return raw ? (JSON.parse(raw) as PersistedSessionSummary[]) : [];
    } catch {
      return [];
    }
  }

  /** Write a compact summary to localStorage. Throttled; also call on page exit. */
  persistNow(): void {
    if (typeof localStorage === 'undefined') return;
    const byProvider = this.summary();
    if (byProvider.length === 0) return;
    try {
      const prior = this.history();
      // Replace the most recent entry if it's THIS session (same start), else append.
      const entry: PersistedSessionSummary = { endedAt: new Date(this.now()).toISOString(), byProvider };
      const next = [...prior, entry].slice(-PERSIST_HISTORY_CAP);
      localStorage.setItem(PERSIST_KEY, JSON.stringify(next));
    } catch {
      /* persistence is best-effort — never block captioning */
    }
  }

  private maybePersist(nowMs: number): void {
    if (nowMs - this.lastPersistMs < PERSIST_THROTTLE_MS) return;
    this.lastPersistMs = nowMs;
    this.persistNow();
    // Surface a one-line summary into the console log so a field session leaves
    // a forensic trail even without opening the export.
    const s = this.summary();
    console.info(
      '[latency]',
      s
        .map((p) => `${p.provider}: ttfc=${p.ttfcMs ?? '–'}ms lagP50=${p.lagP50 ?? '–'}ms lagP95=${p.lagP95 ?? '–'}ms n=${p.samples}`)
        .join(' | '),
    );
  }

  /** Test hook. */
  reset(): void {
    this.sessionStartMs = 0;
    this.sessionProvider = null;
    this.ttfcMs = null;
    this.pending.clear();
    this.samples = [];
    this.lastPersistMs = 0;
  }
}

// Process-wide singleton observed by createStoreBoundHandlers.
export const latencyMonitor = new LatencyMonitor();

// Expose for manual retrieval/export from DevTools (background, no UI).
if (typeof window !== 'undefined') {
  (window as unknown as { __latency: LatencyMonitor }).__latency = latencyMonitor;
  // Flush a final summary on tab exit so the session's numbers are recorded.
  const flush = (): void => latencyMonitor.persistNow();
  if (typeof window.addEventListener === 'function') window.addEventListener('pagehide', flush);
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
}
