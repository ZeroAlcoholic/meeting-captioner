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
        // Drop ANY in-flight partial — defense in depth. The provider's
        // newSegment() runs AFTER flushSegment(), so in practice a queued
        // partial's segmentId always matches the final's. But if that
        // invariant ever breaks (provider refactor, deadline-triggered
        // flush, race with .completed event), a queued partial for the
        // just-finalized segment would land after the final and ghost-
        // rewrite livePartial. Cheaper to drop the partial unconditionally
        // — its content is fully subsumed by the final's text.
        pendingTranscript = null;
        captionStore.getState().applyTranscript(e);
        return;
      }
      pendingTranscript = e; // overwrite — only the most recent partial matters
      ensureScheduled();
    },
    onTranslation(e: TranslationEvent) {
      // `final` translations bypass — `draft` and `refined` are throttled.
      // Same defense as transcripts: a queued draft for the just-finalized
      // segment would otherwise land after the final and overwrite the
      // committed translations[] entry with stale draft text.
      if (e.status === 'final') {
        pendingTranslation = null;
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
