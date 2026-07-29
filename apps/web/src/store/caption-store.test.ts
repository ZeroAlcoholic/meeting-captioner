import type { TranscriptEvent, TranslationEvent } from '@meeting-audio/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createCaptionStore,
  mergeSnapshots,
  tailPayload,
  type HydratedSnapshot,
  type PersistedState,
} from './caption-store.js';

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

  it('stores confidence from a translation event with confidence field', () => {
    const store = createCaptionStore({ persistKey: null });
    store.getState().applyTranslation({
      ...translation('s1', 'final', '保費'),
      confidence: 0.82,
    });
    expect(store.getState().translations['s1']?.confidence).toBeCloseTo(0.82);
  });

  it('stores undefined confidence when translation event has no confidence field', () => {
    const store = createCaptionStore({ persistKey: null });
    store.getState().applyTranslation(translation('s1', 'final', '保費'));
    expect(store.getState().translations['s1']?.confidence).toBeUndefined();
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
  it('does not hydrate retained transcript data without explicit opt-in', () => {
    localStorage.setItem(
      'meeting-audio:captions:v4',
      JSON.stringify({
        v: 4,
        segments: [
          {
            segmentId: 'old',
            provider: 'fake',
            source: 'fake_replay',
            mode: 'full_offline',
            status: 'final',
            text: 'must not hydrate',
            startMs: 0,
          },
        ],
        translations: {},
        savedAt: '2026-07-29T00:00:00.000Z',
      }),
    );

    const store = createCaptionStore();

    expect(store.getState().segments).toEqual([]);
    expect(localStorage.getItem('meeting-audio:captions:v4')).toBeNull();
  });

  it('enables and disables retention without clearing in-memory captions', async () => {
    const store = createCaptionStore();
    store.getState().applyTranscript(
      transcript({ segmentId: 'current', status: 'final', text: 'still visible', startMs: 0 }),
    );

    await store.getState().setTranscriptRetention(true);
    expect(localStorage.getItem('meeting-audio:captions:v4')).not.toBeNull();

    await store.getState().setTranscriptRetention(false);
    expect(localStorage.getItem('meeting-audio:captions:v4')).toBeNull();
    expect(store.getState().segments.map((segment) => segment.segmentId)).toEqual(['current']);
  });

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
    const store = createCaptionStore({ persistenceEnabled: true });
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

describe('captionStore: legacy phase migration (no spurious crash-continue)', () => {
  it('legacy v3 payload without sessionPhase hydrates as ended even when sessionEndedAt is null', () => {
    // Pre-v4 data has no phase. It must NOT be treated as resumable — a reload
    // of old data should show the restored chip, never a "continue last meeting"
    // prompt pointing at a long-dead session.
    const key = 'meeting-audio:captions:test-legacy-phase';
    localStorage.setItem(
      key,
      JSON.stringify({
        v: 3,
        segments: [{ segmentId: 's1', provider: 'fake', source: 'fake_replay', mode: 'full_offline', status: 'final', text: 'a', startMs: 0 }],
        translations: {},
        sessionStartMs: 0,
        sessionId: 'old-id',
        sessionEndedAt: null, // was persisted while "open" — but still not resumable
        savedAt: '2026-05-01T00:00:00.000Z',
      }),
    );
    const store = createCaptionStore({ persistKey: key });
    expect(store.getState().sessionPhase).toBe('ended');
    store.getState().clear();
  });
});

describe('captionStore: provider switch without transcript loss', () => {
  it('segments survive a provider restart that does NOT call beginSession (audio-source switch path)', () => {
    // CLAUDE.md: "Mode switching must preserve existing transcript history
    // unless the user explicitly clears it." The App.tsx auto-restart path
    // (audio source / toggle change mid-session) skips beginSession() so the
    // existing history is preserved — this test guards that contract at the
    // store level.
    const store = createCaptionStore({ persistKey: null });
    store.getState().beginSession();
    store.getState().applyTranscript(
      transcript({ segmentId: 's1', status: 'final', text: 'before switch', startMs: 0 }),
    );
    // Provider restarts without calling beginSession() — new provider feeds
    // events into the same store instance.
    store.getState().applyTranscript(
      transcript({ segmentId: 's2', status: 'final', text: 'after switch', startMs: 1000 }),
    );
    const segs = store.getState().segments;
    expect(segs).toHaveLength(2);
    expect(segs[0]?.text).toBe('before switch');
    expect(segs[1]?.text).toBe('after switch');
  });

  it('beginSession clears history (explicit new session — not a provider restart)', () => {
    const store = createCaptionStore({ persistKey: null });
    store.getState().applyTranscript(
      transcript({ segmentId: 's1', status: 'final', text: 'old session', startMs: 0 }),
    );
    store.getState().beginSession();
    expect(store.getState().segments).toHaveLength(0);
  });
});

describe('captionStore: translation failure isolation', () => {
  it('orphan translation (no matching segment) does not throw or corrupt transcript history', () => {
    // CLAUDE.md: "translation failure must never stop captions". If a
    // translation event arrives for a segmentId that doesn't exist in the
    // store (e.g., the segment was already pruned or the event is stale),
    // the call must be a no-op for the caption history.
    const store = createCaptionStore({ persistKey: null });
    store.getState().applyTranscript(
      transcript({ segmentId: 's1', status: 'final', text: 'caption intact', startMs: 0 }),
    );
    expect(() => {
      store.getState().applyTranslation(translation('nonexistent-seg', 'final', ''));
    }).not.toThrow();
    expect(store.getState().segments).toHaveLength(1);
    expect(store.getState().segments[0]?.text).toBe('caption intact');
  });

  it('empty-text translation does not corrupt the liveTranslation slot', () => {
    const store = createCaptionStore({ persistKey: null });
    store.getState().applyTranscript(
      transcript({ segmentId: 's1', status: 'partial', text: 'live', startMs: 0 }),
    );
    store.getState().applyTranslation(translation('s1', 'draft', ''));
    // liveTranslation should be set (even empty text is a valid draft)
    expect(store.getState().liveTranslation).not.toBeNull();
    // Transcript is still in livePartial, not corrupted.
    expect(store.getState().livePartial?.text).toBe('live');
  });
});

describe('captionStore: long-running memory stability', () => {
  it('segment count stays bounded under sustained load', () => {
    // Guard: over a 90-minute meeting the ring buffer must never grow
    // past maxSegments regardless of how many events arrive. 500 segments
    // is well above the 3000-segment default but we test with a small cap
    // to keep the test fast and the intent clear.
    const maxSegments = 100;
    const store = createCaptionStore({ maxSegments, persistKey: null });
    const burst = 500;
    for (let i = 0; i < burst; i++) {
      store.getState().applyTranscript(
        transcript({ segmentId: `s${i}`, status: 'final', text: `w${i}`, startMs: i * 100 }),
      );
    }
    const segs = store.getState().segments;
    expect(segs.length).toBe(maxSegments);
    // The retained window must be the NEWEST maxSegments, not the oldest.
    expect(segs[0]?.segmentId).toBe(`s${burst - maxSegments}`);
    expect(segs[segs.length - 1]?.segmentId).toBe(`s${burst - 1}`);
  });

  it('translation map is pruned in sync with the segment ring buffer (no orphan entries)', () => {
    // If translations[] grows without bound alongside segments[], it becomes
    // a separate memory leak. Guard that pruning removes the translation entry
    // when its segment is evicted from the ring buffer.
    const maxSegments = 3;
    const store = createCaptionStore({ maxSegments, persistKey: null });
    for (let i = 0; i < 5; i++) {
      store.getState().applyTranscript(
        transcript({ segmentId: `s${i}`, status: 'final', text: `t${i}`, startMs: i * 100 }),
      );
      store.getState().applyTranslation(translation(`s${i}`, 'final', `譯${i}`));
    }
    // s0 and s1 were evicted from segments[].
    expect(store.getState().segments).toHaveLength(3);
    expect(store.getState().translations['s0']).toBeUndefined();
    expect(store.getState().translations['s1']).toBeUndefined();
    // s4 (newest) must still be accessible.
    expect(store.getState().translations['s4']?.targetText).toBe('譯4');
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

describe('captionStore.flushNow — interruption durability', () => {
  it('writes synchronously and FOLDS the in-flight livePartial + liveTranslation onto disk', () => {
    // The whole point: the debounced writer NEVER persists livePartial (it would
    // churn localStorage at 20 Hz). flushNow is the crash-safety path that must
    // capture the sentence still being spoken when the page goes away.
    const key = 'meeting-audio:captions:test-flush-1';
    localStorage.removeItem(key);
    const store = createCaptionStore({ persistKey: key });
    const api = store.getState();
    api.beginSession();
    api.applyTranscript(transcript({ segmentId: 'f1', status: 'final', text: 'finalized', startMs: 0 }));
    // In-flight utterance — partial transcript + draft translation, never finalized.
    api.applyTranscript(transcript({ segmentId: 'p2', status: 'partial', text: 'still talking', startMs: 1000 }));
    api.applyTranslation(translation('p2', 'draft', '還在說'));

    api.flushNow(); // synchronous — no debounce wait

    const raw = localStorage.getItem(key);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    const ids = parsed.segments.map((s: { segmentId: string }) => s.segmentId);
    expect(ids).toContain('f1'); // finalized segment
    expect(ids).toContain('p2'); // in-flight utterance folded in
    expect(parsed.translations['p2']?.targetText).toBe('還在說');
    store.getState().clear();
  });

  it('does not duplicate a finalized utterance (no stale livePartial double-write)', () => {
    const key = 'meeting-audio:captions:test-flush-2';
    localStorage.removeItem(key);
    const store = createCaptionStore({ persistKey: key });
    const api = store.getState();
    api.applyTranscript(transcript({ segmentId: 's2', status: 'partial', text: 'x', startMs: 100 }));
    api.applyTranscript(transcript({ segmentId: 's2', status: 'final', text: 'x final', startMs: 100 }));
    expect(store.getState().livePartial).toBeNull();

    api.flushNow();

    const parsed = JSON.parse(localStorage.getItem(key)!);
    const ids = parsed.segments.map((s: { segmentId: string }) => s.segmentId);
    expect(ids.filter((i: string) => i === 's2')).toHaveLength(1);
    store.getState().clear();
  });

  it('is a no-op (no throw) when persistence is disabled', () => {
    const store = createCaptionStore({ persistKey: null });
    store.getState().applyTranscript(transcript({ segmentId: 's1', status: 'partial', text: 'a', startMs: 0 }));
    expect(() => store.getState().flushNow()).not.toThrow();
  });
});

describe('captionStore: session lifecycle (crash-continue foundation)', () => {
  it('beginSession(mode) records the mode and phase=running', () => {
    const store = createCaptionStore({ persistKey: null });
    store.getState().beginSession('gemini');
    expect(store.getState().sessionMode).toBe('gemini');
    expect(store.getState().sessionPhase).toBe('running');
  });

  it('setSessionPhase flips running ⇄ paused and is a no-op without a session', () => {
    const store = createCaptionStore({ persistKey: null });
    store.getState().setSessionPhase('paused'); // no session yet
    expect(store.getState().sessionPhase).toBeNull();
    store.getState().beginSession('real');
    store.getState().setSessionPhase('paused');
    expect(store.getState().sessionPhase).toBe('paused');
    store.getState().setSessionPhase('running');
    expect(store.getState().sessionPhase).toBe('running');
  });

  it('setSessionMode switches the backend without clearing the transcript (cross-model failover), no-op without a session', () => {
    const store = createCaptionStore({ persistKey: null });
    store.getState().setSessionMode('real'); // no session yet → no-op
    expect(store.getState().sessionMode).toBeNull();

    store.getState().beginSession('gemini');
    store.getState().applyTranscript({
      kind: 'transcript', provider: 'gemini-live', mode: 'online_full', source: 'microphone',
      segmentId: 'g1', status: 'final', text: 'kept across failover', startMs: 1,
    });
    expect(store.getState().sessionMode).toBe('gemini');

    // Failover to OpenAI: mode follows, transcript preserved.
    store.getState().setSessionMode('real');
    expect(store.getState().sessionMode).toBe('real');
    expect(store.getState().segments).toHaveLength(1);
    expect(store.getState().segments[0]!.text).toBe('kept across failover');
  });

  it('endSession sets phase=ended (and sessionEndedAt)', () => {
    const store = createCaptionStore({ persistKey: null });
    store.getState().beginSession('offline');
    store.getState().endSession();
    expect(store.getState().sessionPhase).toBe('ended');
    expect(store.getState().sessionEndedAt).not.toBeNull();
  });

  it('persists sessionMode + sessionPhase so a reload can offer to continue', () => {
    const key = 'meeting-audio:captions:test-lifecycle';
    localStorage.removeItem(key);
    const store = createCaptionStore({ persistKey: key });
    store.getState().beginSession('gemini');
    store.getState().applyTranscript(transcript({ segmentId: 's1', status: 'final', text: 'a', startMs: 0 }));
    store.getState().setSessionPhase('paused');
    store.getState().flushNow();
    const parsed = JSON.parse(localStorage.getItem(key)!) as PersistedState;
    expect(parsed.sessionMode).toBe('gemini');
    expect(parsed.sessionPhase).toBe('paused');
    store.getState().clear();
  });
});

describe('captionStore: localStorage tail bounding (IDB holds the full history)', () => {
  it('flushNow writes at most LS_TAIL_SEGMENTS (2000) newest segments to localStorage', () => {
    const key = 'meeting-audio:captions:test-tail';
    localStorage.removeItem(key);
    const store = createCaptionStore({ persistKey: key });
    store.getState().beginSession('fake');
    for (let i = 0; i < 2100; i++) {
      store.getState().applyTranscript(
        transcript({ segmentId: `s${i}`, status: 'final', text: `w${i}`, startMs: i * 100 }),
      );
    }
    store.getState().flushNow();
    const parsed = JSON.parse(localStorage.getItem(key)!) as PersistedState;
    expect(parsed.segments.length).toBe(2000); // bounded tail
    // The retained window is the NEWEST 2000 (s100..s2099).
    expect(parsed.segments[0]!.segmentId).toBe('s100');
    expect(parsed.segments[parsed.segments.length - 1]!.segmentId).toBe('s2099');
    store.getState().clear();
  });
});

describe('mergeSnapshots — IDB(full) + localStorage(tail) union on crash recovery', () => {
  const snap = (over: Partial<HydratedSnapshot>): HydratedSnapshot => ({
    segments: [],
    translations: {},
    sessionStartMs: 0,
    sessionId: null,
    sessionEndedAt: null,
    sessionMode: null,
    sessionPhase: 'ended',
    savedAtMs: 0,
    ...over,
  });
  const seg = (id: string, startMs: number) => ({
    segmentId: id, provider: 'fake', source: 'fake_replay' as const,
    mode: 'full_offline' as const, status: 'final' as const, text: id, startMs,
  });

  it('unions a fresher localStorage tail (with the in-flight final) onto the fuller IDB base', () => {
    // IDB: full history captured at the last debounce (s0..s2), older savedAt.
    const idb = snap({
      segments: [seg('s0', 0), seg('s1', 100), seg('s2', 200)],
      savedAtMs: 1000, sessionPhase: 'running', sessionMode: 'gemini',
    });
    // localStorage: the synchronous flushNow net, newer savedAt, holds the tail
    // PLUS the post-debounce in-flight final s3 that never reached IDB.
    const ls = snap({
      segments: [seg('s2', 200), seg('s3', 300)],
      savedAtMs: 2000, sessionPhase: 'paused', sessionMode: 'gemini',
    });
    const merged = mergeSnapshots(ls, idb, 20000);
    expect(merged.segments.map((s) => s.segmentId)).toEqual(['s0', 's1', 's2', 's3']);
    // Newer base (ls) supplies the scalar session fields.
    expect(merged.sessionPhase).toBe('paused');
  });

  it('caps the merged result to maxSegments (newest kept)', () => {
    const a = snap({ segments: [seg('a', 0), seg('b', 100)], savedAtMs: 1 });
    const b = snap({ segments: [seg('c', 200), seg('d', 300)], savedAtMs: 2 });
    const merged = mergeSnapshots(a, b, 3);
    expect(merged.segments.map((s) => s.segmentId)).toEqual(['b', 'c', 'd']);
  });
});

describe('tailPayload', () => {
  it('returns the same payload when under the tail size', () => {
    const full: PersistedState = {
      v: 4, segments: [{ segmentId: 's0', provider: 'f', source: 'fake_replay', mode: 'full_offline', status: 'final', text: 'a', startMs: 0 }],
      translations: {}, savedAt: '2026-06-11T00:00:00.000Z',
    };
    expect(tailPayload(full, 2000)).toBe(full);
  });
});

describe('captionStore: emergency flush on page exit', () => {
  it('registers pagehide / visibilitychange handlers that fold in-flight data to disk', () => {
    // Simulate a DOM environment with event APIs (the default node test env has
    // none) so we can capture the handlers the store registers and fire them.
    const g = globalThis as unknown as {
      window?: unknown;
      document?: unknown;
    };
    const prevWindow = g.window;
    const prevDocument = g.document;
    const captured: Record<string, Array<() => void>> = {};
    const make = (ns: string) => (type: string, cb: () => void) => {
      (captured[`${ns}:${type}`] ||= []).push(cb);
    };
    g.window = { addEventListener: make('win') };
    g.document = { addEventListener: make('doc'), visibilityState: 'hidden' };
    try {
      const key = 'meeting-audio:captions:test-pagehide';
      localStorage.removeItem(key);
      const store = createCaptionStore({ persistKey: key });
      // Only an in-flight partial exists — the debounced writer would persist
      // nothing (segments[] ref unchanged), so disk is still empty here.
      store
        .getState()
        .applyTranscript(transcript({ segmentId: 'p1', status: 'partial', text: 'mid sentence', startMs: 0 }));
      expect(localStorage.getItem(key)).toBeNull();

      const visHandlers = captured['doc:visibilitychange'];
      expect(visHandlers?.length).toBeGreaterThan(0);
      expect(captured['win:pagehide']?.length).toBeGreaterThan(0);

      visHandlers![0]!(); // tab hidden → emergency flush

      const raw = localStorage.getItem(key);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.segments.map((s: { segmentId: string }) => s.segmentId)).toContain('p1');
      store.getState().clear();
    } finally {
      g.window = prevWindow;
      g.document = prevDocument;
    }
  });
});
