import type {
  AudioLevelEvent,
  HealthEvent,
  TranscriptEvent,
  TranslationEvent,
} from '@meeting-audio/contracts';
import type { MeetingArchiveClient } from '../store/meeting-archive-client.js';
import { captionStore } from '../store/use-caption-store.js';
import { settingsStore } from '../settings/use-settings-store.js';
import { latencyMonitor } from './latency-monitor.js';
import type { CaptionProviderHandlers } from './types.js';

// Live partials arrive at audio-frame rate (10–50 Hz for OpenAI Realtime, plus
// per-character whisper source deltas). Coalesce them into a single store update
// every ~33 ms (≈30 fps) so React paints a few times per second of speech
// instead of once per character — the dominant source of caption-board jank
// during fast speech.
//
// 33 ms (was 50 ms): this interval is the fixed display-batching delay on the
// PRIMARY translated-caption path, so it sits directly on the realtime
// translation latency budget. The live/final store split makes a partial-rate
// update re-render only the memo'd LiveCaption (never HistoryStream/persistence),
// so tightening to 30 fps trims worst-case display latency ~17 ms with
// negligible render cost. We stay on setTimeout (NOT rAF) deliberately so the
// caption keeps updating when the tab/monitor is in the background — see flush().
//
// Final / revised transcript and final translation events bypass the queue
// (rare, important, must land within the same tick they arrive).
const COALESCE_INTERVAL_MS = 33;

type Scheduler = (cb: () => void) => void;

/** Capture survives provider replacement; its normalized loss belongs to the meeting archive. */
export function applyCaptureHealth(
  event: HealthEvent,
  archive: Pick<MeetingArchiveClient, 'recordRetentionGap'>,
): void {
  settingsStore.getState().applyHealth(event);
  archive.recordRetentionGap(event, captionStore.getState().sessionId);
}

export interface CoalescingHandlersOptions {
  /** Dual-source owners supply a stable identity; single-source callers retain their current source. */
  trackId?: 'mic' | 'remote';
  /** A second track reports health/level to its own UI rather than overwriting the primary track. */
  onHealth?: (event: HealthEvent) => void;
  onAudioLevel?: (event: AudioLevelEvent) => void;
  /** Meeting owner supplies the local archive; persistence receives events before display batching. */
  archive?: Pick<MeetingArchiveClient, 'recordTranscript' | 'recordTranslation'> &
    Partial<Pick<MeetingArchiveClient, 'recordGap'>>;
  /** Override for tests. Defaults to setTimeout-based pacing. */
  scheduler?: Scheduler;
  /** Override for tests. Defaults to clearTimeout for the matched scheduler. */
  cancel?: (handle: unknown) => void;
}

const defaultScheduler: Scheduler = (cb) => {
  // Use setTimeout (not rAF) so the live area updates even when the tab is
  // hidden or the system is busy — captioning is the primary task.
  setTimeout(cb, COALESCE_INTERVAL_MS);
};

/**
 * Build provider handlers that bind events to the global caption + settings
 * stores, throttling per-character partial-delta noise.
 *
 * Returned handlers are safe to pass to any CaptionProvider. They keep their
 * own queue state across calls and survive provider stop/start cycles.
 */
export function createStoreBoundHandlers(
  opts: CoalescingHandlersOptions = {},
): CaptionProviderHandlers & { flushPending: () => void; finish: () => void } {
  const schedule = opts.scheduler ?? defaultScheduler;
  const meetingId = captionStore.getState().sessionId;
  const ownsDisplay = () => !opts.archive || captionStore.getState().sessionId === meetingId;
  const trackId = opts.trackId ?? settingsStore.getState().audioSource;
  // Wall-clock uncertainty only. This ID is deliberately not a capture sample epoch.
  const uncertainEpoch = `unconfirmed:${crypto.randomUUID()}`;
  let active = false;
  let finished = false;
  const interrupted = new Set<HealthEvent['component']>();
  let gap: { id: string; start: number; reportedEnd: number | null } | null = null;
  function checkpointInterruption(): void {
    if (!gap || !meetingId || !opts.archive?.recordGap) return;
    const end = Math.max(gap.start, Date.now());
    if (gap.reportedEnd === end) return;
    gap.reportedEnd = end;
    opts.archive.recordGap({
      gapId: gap.id,
      meetingId,
      trackId,
      captureEpoch: uncertainEpoch,
      wallClock: { startAt: new Date(gap.start).toISOString(), endAt: new Date(end).toISOString() },
      alignment: 'estimated',
      state: 'unrecoverable',
      cause: '連線或送音中斷；此區間未補送，字幕完整性未確認',
    });
  }
  function observeHealth(event: HealthEvent): void {
    if (
      finished ||
      !opts.archive?.recordGap ||
      !meetingId ||
      !['audio', 'transport'].includes(event.component)
    )
      return;
    if (event.captureGap) {
      opts.archive.recordGap({
        gapId: crypto.randomUUID(),
        meetingId,
        trackId,
        ...event.captureGap,
        alignment: 'estimated',
        state: 'unrecoverable',
        cause: '疑似休眠或排程中斷；此期間收音完整性未確認',
      });
      return;
    }
    if (event.component === 'audio' && event.state === 'connected') active = true;
    if (
      active &&
      ['reconnecting', 'failed', 'api_error', 'no_audio_track', 'degraded'].includes(event.state)
    ) {
      interrupted.add(event.component);
      gap ??= { id: crypto.randomUUID(), start: Date.now(), reportedEnd: null };
      checkpointInterruption();
    } else if (event.state === 'connected') {
      // Translation hooks emit transport connected only after effective content.
      interrupted.delete(event.component);
      if (interrupted.size === 0) {
        checkpointInterruption();
        gap = null;
      }
    }
    // A provider may emit stopped while cleaning up a fault. Only its meeting
    // owner calls finish(); a transport status must not end this accounting.
  }
  let pendingTranscript: TranscriptEvent | null = null;
  let pendingTranslation: TranslationEvent | null = null;
  let scheduled = false;

  function flush(): void {
    scheduled = false;
    if (!ownsDisplay()) {
      pendingTranscript = null;
      pendingTranslation = null;
      return;
    }
    if (pendingTranscript) {
      captionStore.getState().applyTranscript(pendingTranscript);
      pendingTranscript = null;
    }
    if (pendingTranslation) {
      captionStore.getState().applyTranslation(pendingTranslation);
      pendingTranslation = null;
    }
  }

  function ensureScheduled(): void {
    if (scheduled) return;
    scheduled = true;
    schedule(flush);
  }

  return {
    onTranscript(e: TranscriptEvent) {
      if (e.text.trim()) active = true;
      opts.archive?.recordTranscript(e);
      if (!ownsDisplay()) return;
      // Passive latency telemetry — record TRUE arrival time before coalescing.
      // One Map op; stats are computed lazily on read (see latency-monitor).
      latencyMonitor.recordTranscript(e);
      // Only `final` bypasses the queue. `partial` and `revised` are both
      // in-flight and contribute to the same 20 Hz throttle.
      if (e.status === 'final') {
        // Drop in-flight partial ONLY when it's for the same segment as
        // the final — that partial is fully subsumed by the final's text
        // and would ghost-rewrite livePartial if flushed afterward. A
        // pending partial for a DIFFERENT segment (e.g. final-A arrived
        // out-of-order while partial-B is already queued) must be kept;
        // dropping it would lose a fresh live caption for the next
        // utterance for one full coalesce tick (~50 ms).
        if (pendingTranscript && pendingTranscript.segmentId === e.segmentId) {
          pendingTranscript = null;
        }
        captionStore.getState().applyTranscript(e);
        return;
      }
      pendingTranscript = e; // overwrite — only the most recent partial matters
      ensureScheduled();
    },
    onTranslation(e: TranslationEvent) {
      if (e.targetText.trim()) active = true;
      opts.archive?.recordTranslation(e);
      if (!ownsDisplay()) return;
      latencyMonitor.recordTranslation(e); // arrival-accurate, pre-coalesce
      // `final` translations bypass — `draft` and `refined` are throttled.
      // Same per-segment match rule as transcripts above.
      if (e.status === 'final') {
        if (pendingTranslation && pendingTranslation.sourceSegmentId === e.sourceSegmentId) {
          pendingTranslation = null;
        }
        captionStore.getState().applyTranslation(e);
        return;
      }
      pendingTranslation = e;
      ensureScheduled();
    },
    onHealth(e: HealthEvent) {
      observeHealth(e);
      latencyMonitor.recordHealth(e); // marks bring-up start for TTFC
      (opts.onHealth ?? settingsStore.getState().applyHealth)(e);
    },
    onAudioLevel(e: AudioLevelEvent) {
      (opts.onAudioLevel ?? settingsStore.getState().applyAudioLevel)(e);
    },
    flushPending() {
      flush();
      checkpointInterruption();
    },
    finish() {
      flush();
      checkpointInterruption();
      gap = null;
      interrupted.clear();
      finished = true;
    },
  };
}
