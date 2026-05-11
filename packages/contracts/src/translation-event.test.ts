import { describe, expect, it } from 'vitest';
import { TranslationEvent, TranslationStatus } from './translation-event.js';

describe('TranslationEvent', () => {
  const valid = {
    kind: 'translation' as const,
    provider: 'fake-replay',
    mode: 'full_offline' as const,
    sourceSegmentId: 'seg-1',
    status: 'draft' as const,
    sourceText: 'hello world',
    targetText: '你好世界',
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hant',
    updatedAt: '2026-05-11T10:00:00.000Z',
  };

  it('accepts a valid event', () => {
    expect(TranslationEvent.parse(valid)).toEqual(valid);
  });

  it('accepts each defined status', () => {
    for (const status of TranslationStatus.options) {
      expect(TranslationEvent.parse({ ...valid, status })).toMatchObject({ status });
    }
  });

  it('rejects an unknown status', () => {
    expect(() => TranslationEvent.parse({ ...valid, status: 'pending' })).toThrow();
  });

  it('rejects malformed updatedAt', () => {
    expect(() => TranslationEvent.parse({ ...valid, updatedAt: 'yesterday' })).toThrow();
  });

  it('rejects too-short language tag', () => {
    expect(() => TranslationEvent.parse({ ...valid, sourceLanguage: 'e' })).toThrow();
  });
});
