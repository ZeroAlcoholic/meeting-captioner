import type { TranscriptEvent, TranslationEvent } from '@meeting-audio/contracts';
import { describe, expect, it } from 'vitest';
import { createCaptionStore } from './caption-store.js';

const baseTranscript = {
  kind: 'transcript' as const,
  provider: 'fake-replay',
  mode: 'full_offline' as const,
  source: 'fake_replay' as const,
};

function transcript(overrides: Partial<TranscriptEvent> & Pick<TranscriptEvent, 'segmentId' | 'status' | 'text' | 'startMs'>): TranscriptEvent {
  return { ...baseTranscript, ...overrides } as TranscriptEvent;
}

function translation(sourceSegmentId: string, status: TranslationEvent['status'], targetText: string): TranslationEvent {
  return {
    kind: 'translation',
    provider: 'fake-replay',
    mode: 'full_offline',
    sourceSegmentId,
    status,
    sourceText: 'src',
    targetText,
    sourceLanguage: 'en',
    targetLanguage: 'zh-Hant',
    updatedAt: '2026-05-11T10:00:00.000Z',
  };
}

describe('captionStore.applyTranscript', () => {
  it('appends a new segment', () => {
    const store = createCaptionStore({ persistKey: null });
    store.getState().applyTranscript(transcript({ segmentId: 's1', status: 'partial', text: 'a', startMs: 0 }));
    expect(store.getState().segments).toHaveLength(1);
    expect(store.getState().segments[0]?.text).toBe('a');
  });

  it('updates the same segmentId in place across partial → revised → final', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 's1', status: 'partial', text: 'hel', startMs: 0 }));
    api.applyTranscript(transcript({ segmentId: 's1', status: 'revised', text: 'hello', startMs: 0 }));
    api.applyTranscript(transcript({ segmentId: 's1', status: 'final', text: 'hello.', startMs: 0, endMs: 500 }));
    const segs = store.getState().segments;
    expect(segs).toHaveLength(1);
    expect(segs[0]?.status).toBe('final');
    expect(segs[0]?.text).toBe('hello.');
    expect(segs[0]?.endMs).toBe(500);
  });

  it('keeps insertion order by startMs even with out-of-order arrival', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 'a', status: 'final', text: 'first', startMs: 0 }));
    api.applyTranscript(transcript({ segmentId: 'c', status: 'final', text: 'third', startMs: 2000 }));
    api.applyTranscript(transcript({ segmentId: 'b', status: 'final', text: 'second', startMs: 1000 }));
    expect(store.getState().segments.map((s) => s.segmentId)).toEqual(['a', 'b', 'c']);
  });

  it('supersedes the previous segment when revisionOf is set', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 's1', status: 'partial', text: 'wrong', startMs: 0 }));
    api.applyTranscript(transcript({ segmentId: 's2', status: 'final', text: 'right', startMs: 0, revisionOf: 's1' }));
    const segs = store.getState().segments;
    expect(segs).toHaveLength(1);
    expect(segs[0]?.segmentId).toBe('s2');
    expect(segs[0]?.text).toBe('right');
  });

  it('drops oldest segments when exceeding maxSegments', () => {
    const store = createCaptionStore({ maxSegments: 3 });
    const api = store.getState();
    for (let i = 0; i < 5; i++) {
      api.applyTranscript(transcript({ segmentId: `s${i}`, status: 'final', text: `t${i}`, startMs: i * 100 }));
    }
    const segs = store.getState().segments;
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => s.segmentId)).toEqual(['s2', 's3', 's4']);
  });
});

describe('captionStore.applyTranslation', () => {
  it('stores translation keyed by sourceSegmentId', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranslation(translation('s1', 'draft', '草稿'));
    expect(store.getState().translations['s1']?.targetText).toBe('草稿');
  });

  it('overwrites previous translation as it refines', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranslation(translation('s1', 'draft', '草稿'));
    api.applyTranslation(translation('s1', 'final', '完稿'));
    expect(store.getState().translations['s1']?.status).toBe('final');
    expect(store.getState().translations['s1']?.targetText).toBe('完稿');
  });
});

describe('captionStore.clear', () => {
  it('removes all segments and translations', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 's1', status: 'final', text: 'a', startMs: 0 }));
    api.applyTranslation(translation('s1', 'final', '甲'));
    api.clear();
    expect(store.getState().segments).toEqual([]);
    expect(store.getState().translations).toEqual({});
  });
});

describe('captionStore.sessionStartMs', () => {
  it('is null until the first transcript event', () => {
    const store = createCaptionStore({ persistKey: null });
    expect(store.getState().sessionStartMs).toBeNull();
  });

  it('is set on the first transcript event and pinned across subsequent events', async () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 's1', status: 'partial', text: 'a', startMs: 0 }));
    const first = store.getState().sessionStartMs;
    expect(first).not.toBeNull();
    // Second event must not overwrite the anchor — all history times resolve from one origin.
    await new Promise((r) => setTimeout(r, 5));
    api.applyTranscript(transcript({ segmentId: 's2', status: 'final', text: 'b', startMs: 100 }));
    expect(store.getState().sessionStartMs).toBe(first);
  });

  it('is reset to null on clear', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 's1', status: 'final', text: 'a', startMs: 0 }));
    expect(store.getState().sessionStartMs).not.toBeNull();
    api.clear();
    expect(store.getState().sessionStartMs).toBeNull();
  });
});
