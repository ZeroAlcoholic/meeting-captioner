import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AudioLevelEvent,
  HealthEvent,
  TranscriptEvent,
  TranslationEvent,
} from '@meeting-audio/contracts';
import { createStoreBoundHandlers } from './coalesce-handlers.js';
import { captionStore } from '../store/use-caption-store.js';
import { settingsStore } from '../settings/use-settings-store.js';

function partial(id: string, text: string, startMs = 0): TranscriptEvent {
  return {
    kind: 'transcript',
    provider: 'openai-realtime',
    mode: 'online_full',
    source: 'microphone',
    segmentId: id,
    status: 'partial',
    text,
    startMs,
  };
}

function final(id: string, text: string, startMs = 0): TranscriptEvent {
  return {
    kind: 'transcript',
    provider: 'openai-realtime',
    mode: 'online_full',
    source: 'microphone',
    segmentId: id,
    status: 'final',
    text,
    startMs,
    endMs: startMs + 100,
  };
}

function draft(sourceId: string, target: string): TranslationEvent {
  return {
    kind: 'translation',
    provider: 'openai-realtime',
    mode: 'online_full',
    sourceSegmentId: sourceId,
    status: 'draft',
    sourceText: 'src',
    targetText: target,
    sourceLanguage: 'en',
    targetLanguage: 'zh-TW',
    updatedAt: '2026-05-16T00:00:00.000Z',
  };
}

beforeEach(() => {
  captionStore.getState().clear();
});

describe('createStoreBoundHandlers — partial throttling', () => {
  it('queues partials and flushes once per scheduler tick', () => {
    const queue: Array<() => void> = [];
    const handlers = createStoreBoundHandlers({
      scheduler: (cb) => {
        queue.push(cb);
      },
    });

    handlers.onTranscript(partial('s1', 'h'));
    handlers.onTranscript(partial('s1', 'he'));
    handlers.onTranscript(partial('s1', 'hel'));
    handlers.onTranscript(partial('s1', 'hell'));
    handlers.onTranscript(partial('s1', 'hello'));

    // No store update yet — all queued.
    expect(captionStore.getState().livePartial).toBeNull();
    expect(queue.length).toBeGreaterThan(0);

    queue.forEach((fn) => fn());

    // Only the LATEST partial reached the store.
    expect(captionStore.getState().livePartial?.text).toBe('hello');
  });

  it('finals bypass the queue and flush immediately', () => {
    const queue: Array<() => void> = [];
    const handlers = createStoreBoundHandlers({
      scheduler: (cb) => {
        queue.push(cb);
      },
    });

    handlers.onTranscript(partial('s1', 'hello'));
    handlers.onTranscript(final('s1', 'hello.'));

    // Final landed before the scheduler fired.
    expect(captionStore.getState().segments).toHaveLength(1);
    expect(captionStore.getState().segments[0]?.text).toBe('hello.');

    // Pending partial for the same id was dropped — so flushing afterwards
    // does NOT resurrect a stale partial on top of the final.
    queue.forEach((fn) => fn());
    expect(captionStore.getState().livePartial).toBeNull();
    expect(captionStore.getState().segments[0]?.text).toBe('hello.');
  });

  it('draft translations are throttled; final translations bypass', () => {
    const queue: Array<() => void> = [];
    const handlers = createStoreBoundHandlers({
      scheduler: (cb) => {
        queue.push(cb);
      },
    });

    handlers.onTranslation(draft('s1', '你'));
    handlers.onTranslation(draft('s1', '你好'));
    expect(captionStore.getState().translations['s1']).toBeUndefined();
    queue.forEach((fn) => fn());
    expect(captionStore.getState().translations['s1']?.targetText).toBe('你好');

    handlers.onTranslation({ ...draft('s1', '你好,世界'), status: 'final' });
    expect(captionStore.getState().translations['s1']?.targetText).toBe('你好,世界');
    expect(captionStore.getState().translations['s1']?.status).toBe('final');
  });

  it('out-of-order: final(A) does NOT clear queued partial(B) for different segment', () => {
    // Regression guard (Codex review): an earlier defense-in-depth change
    // unconditionally cleared `pendingTranscript` on ANY final. In an
    // out-of-order arrival (final A is delivered AFTER partial B is already
    // queued — possible during async translation handler refactors or
    // network jitter), that defense would drop the legitimate B partial
    // and the live caption area would go blank until the next coalesce
    // tick (~50 ms gap of frozen UI). The segmentId match check ensures
    // only the SAME-segment partial is cleared.
    const queue: Array<() => void> = [];
    const handlers = createStoreBoundHandlers({
      scheduler: (cb) => {
        queue.push(cb);
      },
    });

    // Partial B is queued first.
    handlers.onTranscript(partial('s-B', 'next utterance'));
    // Then final A arrives out-of-order (different segment).
    handlers.onTranscript(final('s-A', 'previous utterance.'));

    // Final A committed straight to segments. Pending B is preserved.
    expect(captionStore.getState().segments).toHaveLength(1);
    expect(captionStore.getState().segments[0]?.segmentId).toBe('s-A');

    // Flush the queue — partial B reaches livePartial as expected.
    queue.forEach((fn) => fn());
    expect(captionStore.getState().livePartial?.segmentId).toBe('s-B');
    expect(captionStore.getState().livePartial?.text).toBe('next utterance');
  });

  it('out-of-order: final translation for A does NOT clear pending draft for B', () => {
    const queue: Array<() => void> = [];
    const handlers = createStoreBoundHandlers({
      scheduler: (cb) => {
        queue.push(cb);
      },
    });

    // First a transcript-partial for B (so the store routes B's draft to
    // liveTranslation, not into translations[]).
    handlers.onTranscript(partial('s-B', 'B src'));
    handlers.onTranslation(draft('s-B', 'B 翻譯草稿'));

    // Now final-translation for a DIFFERENT segment arrives.
    handlers.onTranslation({ ...draft('s-A', 'A 最終翻譯'), status: 'final' });

    // Both arrived; pending B should survive.
    queue.forEach((fn) => fn());
    expect(captionStore.getState().translations['s-A']?.targetText).toBe('A 最終翻譯');
    expect(captionStore.getState().liveTranslation?.sourceSegmentId).toBe('s-B');
    expect(captionStore.getState().liveTranslation?.targetText).toBe('B 翻譯草稿');
  });

  it('forwards health and audio-level synchronously', () => {
    const handlers = createStoreBoundHandlers({ scheduler: () => {} });
    const health: HealthEvent = {
      kind: 'health',
      component: 'transport',
      state: 'connected',
      timestamp: '2026-05-16T00:00:00.000Z',
    };
    const level: AudioLevelEvent = {
      kind: 'audio_level',
      source: 'microphone',
      rmsDb: -30,
      peakDb: -10,
      timestamp: '2026-05-16T00:00:00.000Z',
    };
    handlers.onHealth(health);
    handlers.onAudioLevel(level);
    expect(settingsStore.getState().health.transport.state).toBe('connected');
    expect(settingsStore.getState().audioLevel?.rmsDb).toBe(-30);
  });
});
