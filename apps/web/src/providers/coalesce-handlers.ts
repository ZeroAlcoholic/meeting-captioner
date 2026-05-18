import type {
  AudioLevelEvent,
  HealthEvent,
  TranscriptEvent,
  TranslationEvent,
} from '@meeting-audio/contracts';
import { captionStore } from '../store/use-caption-store.js';
import { settingsStore } from '../settings/use-settings-store.js';
import type { CaptionProviderHandlers } from './types.js';

// Live partials arrive at audio-frame rate (10–50 Hz for OpenAI Realtime).
// Coalesce per-character deltas into a single store update every ~50 ms so
// React paints once per frame instead of once per character — the dominant
// source of caption-board jank during fast speech.
//
// Final / revised transcript and final translation events bypass the queue
// (rare, important, must land within the same tick they arrive).
const COALESCE_INTERVAL_MS = 50;

type Scheduler = (cb: () => void) => void;

export interface CoalescingHandlersOptions {
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
): CaptionProviderHandlers & { flushPending: () => void } {
  const schedule = opts.scheduler ?? defaultScheduler;
  let pendingTranscript: TranscriptEvent | null = null;
  let pendingTranslation: TranslationEvent | null = null;
  let scheduled = false;

  function flush(): void {
    scheduled = false;
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
      settingsStore.getState().applyHealth(e);
    },
    onAudioLevel(e: AudioLevelEvent) {
      settingsStore.getState().applyAudioLevel(e);
    },
    flushPending: flush,
  };
}
