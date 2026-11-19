import { describe, expect, it } from 'vitest';
import { TranscriptEvent, TranscriptStatus } from './transcript-event.js';

describe('TranscriptEvent', () => {
  const valid = {
    kind: 'transcript' as const,
    provider: 'fake-replay',
    mode: 'full_offline' as const,
    source: 'fake_replay' as const,
    segmentId: 'seg-1',
    status: 'partial' as const,
    text: 'hello',
    startMs: 0,
  };

  it('accepts a minimal valid event', () => {
    expect(TranscriptEvent.parse(valid)).toEqual(valid);
  });

  it('accepts all optional fields', () => {
    const full = { ...valid, endMs: 1000, confidence: 0.85, revisionOf: 'seg-0' };
    expect(TranscriptEvent.parse(full)).toEqual(full);
  });

  it('preserves validated input PCM provenance without treating it as word timing', () => {
    const inputAudioRange = {
      trackId: 'mic',
      captureEpoch: 'capture-1',
      from: 512,
      to: 1024,
      sampleRate: 16000,
    };
    expect(TranscriptEvent.parse({ ...valid, inputAudioRange })).toMatchObject({ inputAudioRange });
    for (const bad of [{ to: 512 }, { from: -1 }, { sampleRate: 48000 }, { captureEpoch: '' }])
      expect(
        TranscriptEvent.safeParse({ ...valid, inputAudioRange: { ...inputAudioRange, ...bad } })
          .success,
      ).toBe(false);
  });

  it('preserves optional text and timing provenance', () => {
    const event = {
      ...valid,
      rawText: '会议 API',
      text: '會議 API',
      textNormalization: 'opencc-cn-tw-v1',
      timingBasis: 'capture-estimated',
    };
    expect(TranscriptEvent.parse(event)).toEqual(event);
  });

  it('rejects unsupported provenance values', () => {
    expect(TranscriptEvent.safeParse({ ...valid, rawText: 123 }).success).toBe(false);
    expect(TranscriptEvent.safeParse({ ...valid, textNormalization: 'llm-rewrite' }).success).toBe(
      false,
    );
    expect(TranscriptEvent.safeParse({ ...valid, timingBasis: 'word-aligned' }).success).toBe(
      false,
    );
  });

  it('preserves a bounded-segment continuation link', () => {
    expect(TranscriptEvent.parse({ ...valid, continuationOf: 'seg-0' })).toHaveProperty(
      'continuationOf',
      'seg-0',
    );
    expect(() => TranscriptEvent.parse({ ...valid, continuationOf: '' })).toThrow();
  });

  it('accepts each defined status', () => {
    for (const status of TranscriptStatus.options) {
      expect(TranscriptEvent.parse({ ...valid, status })).toMatchObject({ status });
    }
  });

  it('rejects an unknown status', () => {
    expect(() => TranscriptEvent.parse({ ...valid, status: 'bogus' })).toThrow();
  });

  it('rejects negative startMs', () => {
    expect(() => TranscriptEvent.parse({ ...valid, startMs: -1 })).toThrow();
  });

  it('rejects confidence out of [0, 1]', () => {
    expect(() => TranscriptEvent.parse({ ...valid, confidence: 1.5 })).toThrow();
    expect(() => TranscriptEvent.parse({ ...valid, confidence: -0.1 })).toThrow();
  });

  it('rejects empty segmentId', () => {
    expect(() => TranscriptEvent.parse({ ...valid, segmentId: '' })).toThrow();
  });

  it('rejects wrong kind', () => {
    expect(() => TranscriptEvent.parse({ ...valid, kind: 'translation' })).toThrow();
  });
});
