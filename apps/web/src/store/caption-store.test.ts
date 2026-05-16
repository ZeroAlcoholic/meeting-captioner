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

describe('captionStore.applyTranscript (partial → livePartial)', () => {
  it('partial does NOT enter segments[]; lands in livePartial', () => {
    const store = createCaptionStore({ persistKey: null });
    store.getState().applyTranscript(transcript({ segmentId: 's1', status: 'partial', text: 'a', startMs: 0 }));
    expect(store.getState().segments).toHaveLength(0);
    expect(store.getState().livePartial?.text).toBe('a');
    expect(store.getState().livePartial?.status).toBe('partial');
  });

  it('revised stays in livePartial too', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 's1', status: 'partial', text: 'hel', startMs: 0 }));
    api.applyTranscript(transcript({ segmentId: 's1', status: 'revised', text: 'hello', startMs: 0 }));
    expect(store.getState().segments).toHaveLength(0);
    expect(store.getState().livePartial?.text).toBe('hello');
    expect(store.getState().livePartial?.status).toBe('revised');
  });

  it('segments[] reference is stable across partial deltas (key perf invariant)', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 'finalized', status: 'final', text: 'done', startMs: 0 }));
    const before = store.getState().segments;
    // Many partials in a row — segments[] ref must not change.
    for (let i = 0; i < 20; i++) {
      api.applyTranscript(transcript({ segmentId: 's1', status: 'partial', text: 'x'.repeat(i + 1), startMs: 100 }));
    }
    expect(store.getState().segments).toBe(before);
  });

  it('final commits to segments[] and clears matching livePartial', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 's1', status: 'partial', text: 'hel', startMs: 0 }));
    api.applyTranscript(transcript({ segmentId: 's1', status: 'final', text: 'hello.', startMs: 0, endMs: 500 }));
    expect(store.getState().livePartial).toBeNull();
    expect(store.getState().segments).toHaveLength(1);
    expect(store.getState().segments[0]?.status).toBe('final');
    expect(store.getState().segments[0]?.text).toBe('hello.');
    expect(store.getState().segments[0]?.endMs).toBe(500);
  });

  it('keeps insertion order by startMs even with out-of-order arrival', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 'a', status: 'final', text: 'first', startMs: 0 }));
    api.applyTranscript(transcript({ segmentId: 'c', status: 'final', text: 'third', startMs: 2000 }));
    api.applyTranscript(transcript({ segmentId: 'b', status: 'final', text: 'second', startMs: 1000 }));
    expect(store.getState().segments.map((s) => s.segmentId)).toEqual(['a', 'b', 'c']);
  });

  it('supersedes the previous segment when revisionOf is set on the final', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 's1', status: 'final', text: 'wrong', startMs: 0 }));
    api.applyTranscript(transcript({ segmentId: 's2', status: 'final', text: 'right', startMs: 0, revisionOf: 's1' }));
    const segs = store.getState().segments;
    expect(segs).toHaveLength(1);
    expect(segs[0]?.segmentId).toBe('s2');
    expect(segs[0]?.text).toBe('right');
  });

  it('clears livePartial when a final supersedes its segmentId', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 's1', status: 'partial', text: 'tentative', startMs: 0 }));
    api.applyTranscript(transcript({ segmentId: 's2', status: 'final', text: 'right', startMs: 0, revisionOf: 's1' }));
    expect(store.getState().livePartial).toBeNull();
    expect(store.getState().segments.map((s) => s.segmentId)).toEqual(['s2']);
  });

  it('drops oldest finalized segments when exceeding maxSegments', () => {
    const store = createCaptionStore({ maxSegments: 3, persistKey: null });
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
  it('routes drafts for the live partial into liveTranslation (off the history map)', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 's1', status: 'partial', text: 'live', startMs: 0 }));
    const translationsBefore = store.getState().translations;
    api.applyTranslation(translation('s1', 'draft', '草稿'));
    expect(store.getState().liveTranslation?.targetText).toBe('草稿');
    expect(store.getState().translations).toBe(translationsBefore); // ref stable
    expect(store.getState().translations['s1']).toBeUndefined();
  });

  it('routes orphan translations (no matching livePartial) into the history map', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranslation(translation('s1', 'draft', '草稿'));
    expect(store.getState().translations['s1']?.targetText).toBe('草稿');
    expect(store.getState().liveTranslation).toBeNull();
  });

  it('overwrites previous translation as it refines (history map case)', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranslation(translation('s1', 'draft', '草稿'));
    api.applyTranslation(translation('s1', 'final', '完稿'));
    expect(store.getState().translations['s1']?.status).toBe('final');
    expect(store.getState().translations['s1']?.targetText).toBe('完稿');
  });

  it('promotes a pre-arrived translation into liveTranslation when its transcript partial later lands', () => {
    // Robustness: defend against the rare case where a translation event
    // arrives before its transcript partial. Without the promote-on-partial
    // logic, the translation would be orphaned in translations[] and the
    // live caption area would silently miss it.
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranslation(translation('s1', 'draft', '預先到達'));
    // No livePartial yet → routed into translations[].
    expect(store.getState().translations['s1']?.targetText).toBe('預先到達');
    api.applyTranscript(transcript({ segmentId: 's1', status: 'partial', text: 'pre-arrival', startMs: 0 }));
    // After partial lands, the prior translation should be promoted.
    expect(store.getState().liveTranslation?.targetText).toBe('預先到達');
    expect(store.getState().translations['s1']).toBeUndefined();
  });

  it('finalizing a transcript promotes the liveTranslation into the history map', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 's1', status: 'partial', text: 'live', startMs: 0 }));
    api.applyTranslation(translation('s1', 'draft', '草稿'));
    expect(store.getState().liveTranslation?.targetText).toBe('草稿');
    api.applyTranscript(transcript({ segmentId: 's1', status: 'final', text: 'final.', startMs: 0, endMs: 100 }));
    expect(store.getState().liveTranslation).toBeNull();
    expect(store.getState().translations['s1']?.targetText).toBe('草稿');
  });
});

describe('captionStore.clear', () => {
  it('removes all segments, translations, and livePartial', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 's1', status: 'final', text: 'a', startMs: 0 }));
    api.applyTranscript(transcript({ segmentId: 's2', status: 'partial', text: 'b', startMs: 1000 }));
    api.applyTranslation(translation('s1', 'final', '甲'));
    api.clear();
    expect(store.getState().segments).toEqual([]);
    expect(store.getState().translations).toEqual({});
    expect(store.getState().livePartial).toBeNull();
  });
});

describe('captionStore.sessionStartMs', () => {
  it('is null until the first transcript event', () => {
    const store = createCaptionStore({ persistKey: null });
    expect(store.getState().sessionStartMs).toBeNull();
  });

  it('is set on the first transcript event (even a partial) and pinned across subsequent events', async () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 's1', status: 'partial', text: 'a', startMs: 0 }));
    const first = store.getState().sessionStartMs;
    expect(first).not.toBeNull();
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
