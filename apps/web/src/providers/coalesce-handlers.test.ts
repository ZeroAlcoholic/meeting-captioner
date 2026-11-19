import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  it('archives the capture gap interval and epoch once on its bound remote meeting', () => {
    captionStore.getState().beginSession('real');
    const meetingId = captionStore.getState().sessionId;
    const archive = { recordTranscript: vi.fn(), recordTranslation: vi.fn(), recordGap: vi.fn() };
    const handler = createStoreBoundHandlers({ archive, trackId: 'remote', onHealth: vi.fn() });
    const connected: HealthEvent = {
      kind: 'health',
      component: 'audio',
      state: 'connected',
      timestamp: new Date().toISOString(),
    };
    handler.onHealth(connected);
    captionStore.getState().beginSession('real');
    const captureGap = {
      captureEpoch: 'remote-capture-epoch',
      wallClock: { startAt: '2026-10-16T00:00:00.000Z', endAt: '2026-10-16T00:00:10.000Z' },
    };
    handler.onHealth({ ...connected, state: 'degraded', reason: 'capture_stalled', captureGap });
    handler.onHealth(connected);
    handler.finish();
    expect(archive.recordGap).toHaveBeenCalledTimes(1);
    expect(archive.recordGap.mock.calls[0]![0]).toMatchObject({
      meetingId,
      trackId: 'remote',
      ...captureGap,
      alignment: 'estimated',
      state: 'unrecoverable',
    });
  });
  it('keeps each track interruption identity within the same meeting', () => {
    captionStore.getState().beginSession('real');
    const archive = { recordTranscript: vi.fn(), recordTranslation: vi.fn(), recordGap: vi.fn() };
    const mic = createStoreBoundHandlers({ archive, trackId: 'mic' });
    const remote = createStoreBoundHandlers({ archive, trackId: 'remote' });
    const health = (state: 'connected' | 'failed'): HealthEvent => ({
      kind: 'health',
      component: 'audio',
      state,
      timestamp: new Date().toISOString(),
    });
    mic.onHealth(health('connected'));
    remote.onHealth(health('connected'));
    mic.onHealth(health('failed'));
    const localGap = archive.recordGap.mock.calls.at(-1)![0];
    expect(localGap.trackId).toBe('mic');
    const before = archive.recordGap.mock.calls.length;
    remote.onHealth(health('connected'));
    expect(archive.recordGap).toHaveBeenCalledTimes(before);
    remote.onHealth(health('failed'));
    const remoteGap = archive.recordGap.mock.calls.at(-1)![0];
    expect(remoteGap.trackId).toBe('remote');
    expect(remoteGap.meetingId).toBe(localGap.meetingId);
    expect(remoteGap.gapId).not.toBe(localGap.gapId);
    expect(remoteGap.captureEpoch).not.toBe(localGap.captureEpoch);
    mic.finish();
    remote.finish();
  });
  it('independent track handlers retain both latest partials and archive every final', () => {
    const queue: Array<() => void> = [];
    const archive = { recordTranscript: vi.fn(), recordTranslation: vi.fn() };
    const options = {
      archive,
      scheduler: (cb: () => void) => {
        queue.push(cb);
      },
    };
    const mic = createStoreBoundHandlers(options);
    const remote = createStoreBoundHandlers(options);
    const delivered: string[] = [];
    const unsubscribe = captionStore.subscribe((state) => {
      if (state.livePartial) delivered.push(state.livePartial.text);
    });
    try {
      mic.onTranscript(partial('mic-1', 'local first'));
      remote.onTranscript({ ...partial('remote-1', 'remote first'), source: 'browser_system' });
      mic.onTranscript(partial('mic-1', 'local latest'));
      remote.onTranscript({ ...partial('remote-1', 'remote latest'), source: 'browser_system' });
      expect(queue).toHaveLength(2);
      queue.splice(0).forEach((flush) => flush());
      expect(delivered).toEqual(['local latest', 'remote latest']);
      // This proves independent batching, not simultaneous rendering: the
      // existing store still exposes only one livePartial, handled by W11.
      const localFinal = final('mic-1', 'local final');
      const remoteFinal = {
        ...final('remote-1', 'remote final'),
        source: 'browser_system' as const,
      };
      mic.onTranscript(localFinal);
      remote.onTranscript(remoteFinal);
      expect(captionStore.getState().segments.map((segment) => segment.segmentId)).toEqual([
        'mic-1',
        'remote-1',
      ]);
      expect(archive.recordTranscript.mock.calls.map(([event]) => event)).toEqual([
        partial('mic-1', 'local first'),
        { ...partial('remote-1', 'remote first'), source: 'browser_system' },
        partial('mic-1', 'local latest'),
        { ...partial('remote-1', 'remote latest'), source: 'browser_system' },
        localFinal,
        remoteFinal,
      ]);
    } finally {
      unsubscribe();
      mic.finish();
      remote.finish();
    }
  });

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

it('archives retiring tails without painting them into a newer meeting', () => {
  const task = { purpose: 'translation' as const, langPair: 'en→zh-TW' as const };
  captionStore.getState().beginSession('real', task);
  const archive = { recordTranscript: vi.fn(), recordTranslation: vi.fn() };
  const queue: Array<() => void> = [];
  const handlers = createStoreBoundHandlers({ archive, scheduler: (flush) => queue.push(flush) });
  handlers.onTranscript(partial('old-pending', 'old pending'));
  handlers.onTranslation(draft('old-pending', '舊待定'));
  captionStore.getState().beginSession('gemini', task);
  handlers.onTranscript(final('old-final', 'old final'));
  handlers.onTranslation({ ...draft('old-final', '舊定稿'), status: 'final' });
  queue.forEach((flush) => flush());
  expect(archive.recordTranscript).toHaveBeenCalledTimes(2);
  expect(archive.recordTranslation).toHaveBeenCalledTimes(2);
  expect(captionStore.getState().segments).toEqual([]);
  expect(captionStore.getState().translations).toEqual({});
  expect(captionStore.getState().livePartial).toBeNull();
  expect(captionStore.getState().liveTranslation).toBeNull();
});

afterEach(() => vi.useRealTimers());
it('archives an estimated interruption until both audio and content-ready transport recover', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
  captionStore.getState().beginSession('gemini', { purpose: 'translation', langPair: 'en→zh-TW' });
  const meetingId = captionStore.getState().sessionId;
  const archive = { recordTranscript: vi.fn(), recordTranslation: vi.fn(), recordGap: vi.fn() };
  const h = createStoreBoundHandlers({ archive });
  const health = (component: HealthEvent['component'], state: HealthEvent['state']) =>
    h.onHealth({ kind: 'health', component, state, timestamp: new Date().toISOString() });
  health('transport', 'failed'); // No capture or content yet: not an audio-loss claim.
  expect(archive.recordGap).not.toHaveBeenCalled();
  health('audio', 'connected');
  health('transport', 'reconnecting');
  expect(archive.recordGap).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1000);
  health('audio', 'failed');
  health('transport', 'connected');
  vi.advanceTimersByTime(2000);
  health('audio', 'connected');
  const gap = archive.recordGap.mock.calls.at(-1)![0];
  expect(gap).toMatchObject({
    meetingId,
    alignment: 'estimated',
    state: 'unrecoverable',
    wallClock: { startAt: '2026-10-16T00:00:00.000Z', endAt: '2026-10-16T00:00:03.000Z' },
  });
  expect(gap).not.toHaveProperty('startSample');
  expect(new Set(archive.recordGap.mock.calls.map(([g]) => g.gapId)).size).toBe(1);
  const count = archive.recordGap.mock.calls.length;
  vi.advanceTimersByTime(5000);
  h.flushPending();
  expect(archive.recordGap).toHaveBeenCalledTimes(count);
});
it('checkpoints an unresolved interruption on Stop into its original meeting', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
  captionStore.getState().beginSession('gemini', { purpose: 'translation', langPair: 'en→zh-TW' });
  const meetingId = captionStore.getState().sessionId;
  const archive = { recordTranscript: vi.fn(), recordTranslation: vi.fn(), recordGap: vi.fn() };
  const h = createStoreBoundHandlers({ archive });
  h.onTranscript(final('before', 'content'));
  h.onHealth({
    kind: 'health',
    component: 'transport',
    state: 'reconnecting',
    timestamp: new Date().toISOString(),
  });
  captionStore.getState().beginSession('real', { purpose: 'translation', langPair: 'en→zh-TW' });
  vi.advanceTimersByTime(3000);
  h.flushPending();
  expect(archive.recordGap.mock.calls.at(-1)?.[0]).toMatchObject({
    meetingId,
    wallClock: { endAt: '2026-10-16T00:00:03.000Z' },
  });
  expect(captionStore.getState().segments).toEqual([]);
});

it('finishes an outgoing owner once without extending its gap on later cleanup', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
  captionStore.getState().beginSession('gemini', { purpose: 'translation', langPair: 'en→zh-TW' });
  const archive = { recordTranscript: vi.fn(), recordTranslation: vi.fn(), recordGap: vi.fn() };
  const h = createStoreBoundHandlers({ archive });
  h.onTranscript(final('before', 'before'));
  const failure: HealthEvent = {
    kind: 'health',
    component: 'transport',
    state: 'reconnecting',
    timestamp: new Date().toISOString(),
  };
  h.onHealth(failure);
  vi.advanceTimersByTime(3000);
  h.finish();
  const count = archive.recordGap.mock.calls.length;
  vi.advanceTimersByTime(30000);
  h.onTranscript(final('tail', 'retiring tail'));
  h.onHealth(failure);
  h.finish();
  expect(archive.recordGap).toHaveBeenCalledTimes(count);
  expect(archive.recordGap.mock.calls.at(-1)?.[0].wallClock.endAt).toBe('2026-10-16T00:00:03.000Z');
  expect(archive.recordTranscript).toHaveBeenLastCalledWith(final('tail', 'retiring tail'));
});

it('records an audio failure after provider cleanup emits stopped, until the owner finishes', () => {
  captionStore.getState().beginSession('gemini', { purpose: 'translation', langPair: 'en→zh-TW' });
  const archive = { recordTranscript: vi.fn(), recordTranslation: vi.fn(), recordGap: vi.fn() };
  const h = createStoreBoundHandlers({ archive });
  h.onTranscript(final('before', 'before'));
  // Online hooks stop the broken provider before publishing its original audio failure.
  h.onHealth({
    kind: 'health',
    component: 'audio',
    state: 'stopped',
    timestamp: new Date().toISOString(),
  });
  h.onHealth({
    kind: 'health',
    component: 'audio',
    state: 'failed',
    reason: 'track_ended',
    timestamp: new Date().toISOString(),
  });
  expect(archive.recordGap).toHaveBeenCalledTimes(1);
  h.finish();
});
