import type { HealthEvent, TranscriptEvent, TranslationEvent } from '@meeting-audio/contracts';
import { describe, expect, it } from 'vitest';
import { LatencyMonitor } from './latency-monitor.js';

// Drives the recorder with an injected clock — pure logic, no backend, no mock
// of any provider/model (forbidden); it only verifies the timing math.

function health(state: HealthEvent['state']): HealthEvent {
  return { kind: 'health', component: 'transport', state, timestamp: '2026-06-14T00:00:00.000Z' };
}
function transcript(
  provider: string,
  segmentId: string,
  status: TranscriptEvent['status'],
): TranscriptEvent {
  return {
    kind: 'transcript',
    provider,
    mode: 'online_full',
    source: 'microphone',
    segmentId,
    status,
    text: 'x',
    startMs: 0,
  };
}
function translation(
  provider: string,
  sourceSegmentId: string,
  status: TranslationEvent['status'],
): TranslationEvent {
  return {
    kind: 'translation',
    provider,
    mode: 'online_full',
    sourceSegmentId,
    status,
    sourceText: 'x',
    targetText: 'y',
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hant',
    updatedAt: '2026-06-14T00:00:00.000Z',
  };
}

describe('LatencyMonitor', () => {
  it('computes TTFC from transport connecting → first translation', () => {
    let now = 1_000;
    const m = new LatencyMonitor(() => now);
    m.recordHealth(health('connecting')); // sessionStart = 1000
    now = 1_300;
    m.recordTranslation(translation('openai-realtime', 's1', 'draft')); // +300
    const s = m.summary();
    expect(s).toHaveLength(1);
    expect(s[0]!.ttfcMs).toBe(300);
  });

  it('records per-segment lag (first event → first translation) on finalize', () => {
    let now = 0;
    const m = new LatencyMonitor(() => now);
    m.recordHealth(health('connecting'));
    now = 100;
    m.recordTranscript(transcript('openai-realtime', 's1', 'partial')); // firstEvent = 100
    now = 700;
    m.recordTranslation(translation('openai-realtime', 's1', 'draft')); // firstTranslation = 700 → lag 600
    now = 900;
    m.recordTranslation(translation('openai-realtime', 's1', 'final')); // finalize, dur = 800
    const s = m.summary();
    expect(s[0]!.lagP50).toBe(600);
    expect(s[0]!.durP50).toBe(800);
    expect(s[0]!.samples).toBe(1);
  });

  it('separates samples per provider for OpenAI-vs-Gemini comparison', () => {
    let now = 0;
    const m = new LatencyMonitor(() => now);
    for (const p of ['openai-realtime', 'gemini-live']) {
      now += 100;
      m.recordTranscript(transcript(p, `${p}-1`, 'partial'));
      now += 200;
      m.recordTranslation(translation(p, `${p}-1`, 'final'));
    }
    const s = m.summary();
    expect(s.map((x) => x.provider).sort()).toEqual(['gemini-live', 'openai-realtime']);
    expect(s.every((x) => x.samples === 1)).toBe(true);
  });

  it('a new bring-up (connecting) resets the TTFC clock', () => {
    let now = 0;
    const m = new LatencyMonitor(() => now);
    m.recordHealth(health('connecting'));
    now = 200;
    m.recordTranslation(translation('gemini-live', 's1', 'draft')); // ttfc 200
    now = 5_000;
    m.recordHealth(health('connecting')); // reset
    now = 5_120;
    m.recordTranslation(translation('gemini-live', 's2', 'draft')); // ttfc now 120
    expect(m.summary()[0]!.ttfcMs).toBe(120);
  });

  it('a provider switch attributes TTFC to the new provider', () => {
    let now = 0;
    const m = new LatencyMonitor(() => now);
    m.recordHealth(health('connecting'));
    now = 300;
    m.recordTranslation(translation('gemini-live', 'g1', 'draft'));
    now = 500;
    m.recordTranslation(translation('gemini-live', 'g1', 'final'));

    now = 10_000;
    m.recordHealth(health('connecting'));
    now = 10_180;
    m.recordTranslation(translation('openai-realtime', 'o1', 'draft'));

    const byProvider = new Map(m.summary().map((summary) => [summary.provider, summary]));
    expect(byProvider.get('gemini-live')!.ttfcMs).toBeNull();
    expect(byProvider.get('openai-realtime')!.ttfcMs).toBe(180);
  });

  it('export returns raw samples; reset clears everything', () => {
    let now = 0;
    const m = new LatencyMonitor(() => now);
    m.recordHealth(health('connecting'));
    now = 50;
    m.recordTranscript(transcript('openai-realtime', 's1', 'partial'));
    now = 90;
    m.recordTranslation(translation('openai-realtime', 's1', 'final'));
    expect(m.export().samples).toHaveLength(1);
    m.reset();
    expect(m.export().samples).toHaveLength(0);
    expect(m.summary()).toHaveLength(0);
  });
});
