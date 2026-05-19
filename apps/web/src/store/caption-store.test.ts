import type { TranscriptEvent, TranslationEvent } from '@meeting-audio/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCaptionStore } from './caption-store.js';

// In-memory localStorage + minimal window shim. Vitest defaults to node env
// (no DOM); the new session-boundary / migration tests need both a real
// `localStorage.*` surface AND a defined `window` (caption-store guards its
// hydration with `typeof window !== 'undefined'`). Older tests pass
// `persistKey: null` and skip the persistence path entirely.
function installDomShims(): void {
  const g = globalThis as { localStorage?: Storage; window?: unknown };
  if (typeof g.localStorage === 'undefined') {
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k)! : null),
      setItem: (k, v) => { store.set(k, v); },
      removeItem: (k) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: (i) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    };
  }
  if (typeof g.window === 'undefined') {
    g.window = g; // anything truthy is enough — the guard only checks typeof.
  }
}

installDomShims();
beforeEach(() => { localStorage.clear(); });

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

describe('captionStore session boundary', () => {
  it('starts with sessionId=null and sessionEndedAt=null', () => {
    const store = createCaptionStore({ persistKey: null });
    expect(store.getState().sessionId).toBeNull();
    expect(store.getState().sessionEndedAt).toBeNull();
    expect(store.getState().restoredFromStorage).toBe(false);
  });

  it('beginSession assigns sessionId and clears segments/live/translations/sessionStartMs', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 's1', status: 'final', text: 'a', startMs: 0 }));
    api.applyTranscript(transcript({ segmentId: 's2', status: 'partial', text: 'b', startMs: 100 }));
    api.applyTranslation(translation('s1', 'final', '甲'));
    expect(store.getState().segments).toHaveLength(1);
    api.beginSession();
    const post = store.getState();
    expect(post.segments).toHaveLength(0);
    expect(post.livePartial).toBeNull();
    expect(post.liveTranslation).toBeNull();
    expect(post.translations).toEqual({});
    expect(post.sessionStartMs).toBeNull();
    expect(post.sessionId).not.toBeNull();
    expect(post.sessionEndedAt).toBeNull();
  });

  it('beginSession dismisses the restoredFromStorage flag', () => {
    // Simulate hydration via persistKey: write a v3 payload to localStorage,
    // then construct a fresh store reading from that key.
    const key = 'meeting-audio:captions:test-boundary-1';
    localStorage.setItem(
      key,
      JSON.stringify({
        v: 3,
        segments: [{ segmentId: 's1', provider: 'fake', source: 'fake_replay', mode: 'full_offline', status: 'final', text: 'a', startMs: 0 }],
        translations: {},
        sessionStartMs: 0,
        sessionId: null,
        sessionEndedAt: null,
        savedAt: '2026-05-19T00:00:00.000Z',
      }),
    );
    const store = createCaptionStore({ persistKey: key });
    expect(store.getState().restoredFromStorage).toBe(true);
    expect(store.getState().segments).toHaveLength(1);
    store.getState().beginSession();
    expect(store.getState().restoredFromStorage).toBe(false);
    localStorage.removeItem(key);
  });

  it('endSession marks sessionEndedAt without clearing data', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.beginSession();
    api.applyTranscript(transcript({ segmentId: 's1', status: 'final', text: 'a', startMs: 0 }));
    api.endSession();
    const post = store.getState();
    expect(post.sessionEndedAt).not.toBeNull();
    expect(post.segments).toHaveLength(1); // data survives
    expect(post.sessionId).not.toBeNull(); // sessionId stays for export filename
  });

  it('endSession is a no-op when no session has begun', () => {
    const store = createCaptionStore({ persistKey: null });
    store.getState().endSession();
    expect(store.getState().sessionEndedAt).toBeNull();
  });

  it('clear resets sessionId + sessionEndedAt + restoredFromStorage', () => {
    const store = createCaptionStore({ persistKey: null });
    const api = store.getState();
    api.beginSession();
    api.endSession();
    expect(store.getState().sessionId).not.toBeNull();
    api.clear();
    expect(store.getState().sessionId).toBeNull();
    expect(store.getState().sessionEndedAt).toBeNull();
    expect(store.getState().restoredFromStorage).toBe(false);
  });
});

describe('captionStore persistence migration', () => {
  it('reads legacy v2 payload from meeting-audio:captions:v2 when v3 is missing', () => {
    // Write a v2-shaped payload to the legacy key, leave the v3 key empty.
    localStorage.removeItem('meeting-audio:captions:v3');
    localStorage.setItem(
      'meeting-audio:captions:v2',
      JSON.stringify({
        v: 2,
        segments: [{ segmentId: 's1', provider: 'fake', source: 'fake_replay', mode: 'full_offline', status: 'final', text: 'legacy', startMs: 0 }],
        translations: { s1: { sourceSegmentId: 's1', provider: 'fake', status: 'final', sourceText: 'l', targetText: '舊', sourceLanguage: 'en', targetLanguage: 'zh-Hant', updatedAt: '2026-05-19T00:00:00.000Z' } },
        sessionStartMs: 0,
        savedAt: '2026-05-19T00:00:00.000Z',
      }),
    );
    const store = createCaptionStore({});
    expect(store.getState().segments).toHaveLength(1);
    expect(store.getState().segments[0]?.text).toBe('legacy');
    expect(store.getState().translations.s1?.targetText).toBe('舊');
    expect(store.getState().sessionId).toBeNull();
    expect(store.getState().sessionEndedAt).toBeNull();
    expect(store.getState().restoredFromStorage).toBe(true);
    // Cleanup so subsequent tests start with a fresh slate.
    localStorage.removeItem('meeting-audio:captions:v2');
    store.getState().clear();
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
