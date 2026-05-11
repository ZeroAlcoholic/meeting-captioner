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
