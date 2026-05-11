import type { AudioLevelEvent, HealthEvent, TranscriptEvent, TranslationEvent } from '@meeting-audio/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeReplayProvider, FakeReplayScript } from './fake-replay-provider.js';

const transcriptEntry = {
  tMs: 100,
  kind: 'transcript',
  provider: 'fake-replay',
  mode: 'full_offline',
  source: 'fake_replay',
  segmentId: 's1',
  status: 'partial',
  text: 'a',
  startMs: 0,
} as const;

const translationEntry = {
  tMs: 250,
  kind: 'translation',
  provider: 'fake-replay',
  mode: 'full_offline',
  sourceSegmentId: 's1',
  status: 'final',
  sourceText: 'a',
  targetText: '甲',
  sourceLanguage: 'en',
  targetLanguage: 'zh-Hant',
  updatedAt: '2026-05-11T10:00:00.250Z',
} as const;

const healthEntry = {
  tMs: 50,
  kind: 'health',
  component: 'transport',
  state: 'connecting',
  message: 'connecting',
  timestamp: '2026-05-11T10:00:00.050Z',
} as const;

const audioLevelEntry = {
  tMs: 150,
  kind: 'audio_level',
  source: 'fake_replay',
  rmsDb: -22,
  peakDb: -12,
  timestamp: '2026-05-11T10:00:00.150Z',
} as const;

const script: FakeReplayScript = [healthEntry, transcriptEntry, audioLevelEntry, translationEntry];

function makeProvider() {
  const transcripts: TranscriptEvent[] = [];
  const translations: TranslationEvent[] = [];
  const healths: HealthEvent[] = [];
  const levels: AudioLevelEvent[] = [];
  const provider = new FakeReplayProvider(script, {
    onTranscript: (e) => transcripts.push(e),
    onTranslation: (e) => translations.push(e),
    onHealth: (e) => healths.push(e),
    onAudioLevel: (e) => levels.push(e),
  });
  return { provider, transcripts, translations, healths, levels };
}

describe('FakeReplayProvider — multi-event dispatch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('dispatches health, transcript, audio_level, translation in their scheduled order', () => {
    const { provider, transcripts, translations, healths, levels } = makeProvider();
    provider.start();

    vi.advanceTimersByTime(60);
    expect(healths).toHaveLength(1);
    expect(healths[0]?.component).toBe('transport');
    expect(transcripts).toHaveLength(0);

    vi.advanceTimersByTime(50);
    expect(transcripts).toHaveLength(1);

    vi.advanceTimersByTime(50);
    expect(levels).toHaveLength(1);
    expect(levels[0]?.rmsDb).toBe(-22);

    vi.advanceTimersByTime(100);
    expect(translations).toHaveLength(1);
    expect(translations[0]?.targetText).toBe('甲');
  });

  it('strips tMs from every dispatched event', () => {
    const { provider, transcripts, translations, healths, levels } = makeProvider();
    provider.start();
    vi.advanceTimersByTime(1000);
    for (const e of [...transcripts, ...translations, ...healths, ...levels] as ReadonlyArray<Record<string, unknown>>) {
      expect(e.tMs).toBeUndefined();
    }
  });

  it('stop() halts pending dispatches', () => {
    const { provider, transcripts } = makeProvider();
    provider.start();
    vi.advanceTimersByTime(60);
    provider.stop();
    vi.advanceTimersByTime(1000);
    expect(transcripts).toHaveLength(0);
    expect(provider.status).toBe('stopped');
  });
});

describe('FakeReplayScript schema', () => {
  it('rejects entries with negative tMs', () => {
    expect(() => FakeReplayScript.parse([{ ...healthEntry, tMs: -1 }])).toThrow();
  });

  it('rejects unknown kind', () => {
    expect(() =>
      FakeReplayScript.parse([{ tMs: 0, kind: 'mystery' }]),
    ).toThrow();
  });
});
