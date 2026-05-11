import type { TranscriptEvent, TranslationEvent } from '@meeting-audio/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeReplayProvider, FakeReplayScript } from './fake-replay-provider.js';

const script: FakeReplayScript = [
  {
    tMs: 100,
    kind: 'transcript',
    provider: 'fake-replay',
    mode: 'full_offline',
    source: 'fake_replay',
    segmentId: 's1',
    status: 'partial',
    text: 'a',
    startMs: 0,
  },
  {
    tMs: 200,
    kind: 'transcript',
    provider: 'fake-replay',
    mode: 'full_offline',
    source: 'fake_replay',
    segmentId: 's1',
    status: 'final',
    text: 'apple',
    startMs: 0,
    endMs: 200,
  },
  {
    tMs: 250,
    kind: 'translation',
    provider: 'fake-replay',
    mode: 'full_offline',
    sourceSegmentId: 's1',
    status: 'final',
    sourceText: 'apple',
    targetText: '蘋果',
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hant',
    updatedAt: '2026-05-11T10:00:00.250Z',
  },
];

describe('FakeReplayProvider', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('dispatches transcript and translation events at the right times', () => {
    const transcripts: TranscriptEvent[] = [];
    const translations: TranslationEvent[] = [];
    const provider = new FakeReplayProvider(script, {
      onTranscript: (e) => transcripts.push(e),
      onTranslation: (e) => translations.push(e),
    });

    provider.start();
    expect(provider.status).toBe('running');

    vi.advanceTimersByTime(150);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]?.text).toBe('a');

    vi.advanceTimersByTime(100);
    expect(transcripts).toHaveLength(2);
    expect(transcripts[1]?.status).toBe('final');

    vi.advanceTimersByTime(50);
    expect(translations).toHaveLength(1);
    expect(translations[0]?.targetText).toBe('蘋果');
  });

  it('strips the tMs field before dispatching', () => {
    const transcripts: TranscriptEvent[] = [];
    const provider = new FakeReplayProvider(script, {
      onTranscript: (e) => transcripts.push(e),
      onTranslation: () => {},
    });
    provider.start();
    vi.advanceTimersByTime(1000);
    for (const e of transcripts) {
      expect((e as unknown as Record<string, unknown>).tMs).toBeUndefined();
    }
  });

  it('stop() clears pending timers and marks status', () => {
    const transcripts: TranscriptEvent[] = [];
    const provider = new FakeReplayProvider(script, {
      onTranscript: (e) => transcripts.push(e),
      onTranslation: () => {},
    });
    provider.start();
    vi.advanceTimersByTime(150);
    provider.stop();
    expect(provider.status).toBe('stopped');
    vi.advanceTimersByTime(1000);
    expect(transcripts).toHaveLength(1);
  });

  it('start() is idempotent — second call while running does nothing', () => {
    const transcripts: TranscriptEvent[] = [];
    const provider = new FakeReplayProvider(script, {
      onTranscript: (e) => transcripts.push(e),
      onTranslation: () => {},
    });
    provider.start();
    provider.start();
    vi.advanceTimersByTime(1000);
    expect(transcripts.filter((e) => e.segmentId === 's1' && e.status === 'partial')).toHaveLength(1);
  });
});

describe('FakeReplayScript schema', () => {
  it('rejects entries with negative tMs', () => {
    expect(() =>
      FakeReplayScript.parse([
        { ...script[0], tMs: -1 },
      ]),
    ).toThrow();
  });
});
