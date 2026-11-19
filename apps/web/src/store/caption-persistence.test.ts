import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptionState, PersistedState } from './caption-store.js';
import { createCaptionPersistenceController, mergeSnapshots } from './caption-persistence.js';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void values.set(key, value)),
    removeItem: vi.fn((key: string) => void values.delete(key)),
    clear: vi.fn(() => values.clear()),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    get length() {
      return values.size;
    },
  };
}

function state(segmentId = 's1'): CaptionState {
  return {
    liveTracks: {},
    separateTracks: false,
    maxSegments: 20_000,
    segments: [
      {
        segmentId,
        provider: 'fake-replay',
        source: 'fake_replay',
        mode: 'full_offline',
        status: 'final',
        text: 'kept in memory',
        startMs: 0,
      },
    ],
    livePartial: null,
    liveTranslation: null,
    translations: {},
    sessionStartMs: 1,
    sessionId: 'session-1',
    sessionEndedAt: null,
    sessionMode: 'fake',
    sessionPhase: 'running',
    captionTask: null,
    restoredFromStorage: false,
    applyTranscript: vi.fn(),
    applyTranslation: vi.fn(),
    beginSession: vi.fn(),
    setSessionPhase: vi.fn(),
    setSessionMode: vi.fn(),
    endSession: vi.fn(),
    clear: vi.fn(),
    flushNow: vi.fn(),
    setTranscriptRetention: vi.fn(),
  };
}

function persisted(segmentId: string): PersistedState {
  return {
    v: 4,
    segments: state(segmentId).segments,
    translations: {},
    sessionStartMs: 1,
    sessionId: 'session-1',
    sessionEndedAt: null,
    sessionMode: 'fake',
    sessionPhase: 'running',
    savedAt: '2026-07-29T00:00:00.000Z',
  };
}

const controllers: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});

describe('caption persistence opt-in controller', () => {
  it('flushes both live tracks and translations without changing the in-memory history', () => {
    const storage = memoryStorage();
    const controller = createCaptionPersistenceController({
      enabled: true,
      storage,
      indexedDbAvailable: false,
    });
    controllers.push(controller);
    const snapshot = state();
    snapshot.separateTracks = true;
    const history = snapshot.segments;
    for (const key of ['mic', 'remote'] as const) {
      snapshot.liveTracks[key] = {
        partial: {
          ...history[0]!,
          segmentId: key,
          source: key === 'mic' ? 'microphone' : 'browser_system',
          status: 'partial',
          text: key,
        },
        translation: {
          sourceSegmentId: key,
          provider: 'test',
          status: 'draft',
          sourceText: key,
          targetText: key + '譯文',
          sourceLanguage: 'en',
          targetLanguage: 'zh-TW',
          updatedAt: new Date().toISOString(),
        },
      };
    }
    controller.flush(snapshot);
    const saved = controller.loadSync()!;
    expect(saved.separateTracks).toBe(true);
    expect(saved.segments.map((segment) => segment.segmentId)).toEqual(['s1', 'mic', 'remote']);
    expect(saved.translations.mic?.targetText).toBe('mic譯文');
    expect(saved.translations.remote?.targetText).toBe('remote譯文');
    expect(snapshot.segments).toBe(history);
    expect(snapshot.segments).toHaveLength(1);
  });

  it('persists archive identity and never merges snapshots from different restores', () => {
    const storage = memoryStorage();
    const controller = createCaptionPersistenceController({
      enabled: true,
      storage,
      indexedDbAvailable: false,
    });
    controllers.push(controller);
    const generation = crypto.randomUUID();
    controller.flush({ ...state('current'), archiveGeneration: generation });
    const current = controller.loadSync()!;
    expect(current.archiveGeneration).toBe(generation);
    controller.flush({ ...state('old'), archiveGeneration: null });
    const old = controller.loadSync()!;
    const merged = mergeSnapshots({ ...old, savedAtMs: 1 }, { ...current, savedAtMs: 2 }, 100);
    expect(merged.archiveGeneration).toBe(generation);
    expect(merged.segments.map((segment) => segment.segmentId)).toEqual(['current']);
  });
  it.each([2, 3, 4])(
    'migrates v%s without purpose as ended legacy translation, preserving history',
    (v) => {
      const record = { ...persisted('legacy'), v, sessionPhase: undefined };
      const storage = memoryStorage({ 'meeting-audio:captions:v4': JSON.stringify(record) });
      const controller = createCaptionPersistenceController({
        enabled: true,
        storage,
        indexedDbAvailable: false,
      });
      controllers.push(controller);
      expect(controller.loadSync()).toMatchObject({
        sessionPhase: 'ended',
        captionTask: { purpose: 'translation', langPair: 'en→zh-TW' },
        segments: [{ segmentId: 'legacy' }],
      });
      expect(storage.removeItem).not.toHaveBeenCalled();
    },
  );
  it('never unions snapshots from different meetings or caption purposes', async () => {
    const storage = memoryStorage({
      'meeting-audio:captions:v4': JSON.stringify({
        ...persisted('pure'),
        captionTask: {
          purpose: 'transcription',
          inputLanguages: ['zh-tw', 'en'],
          textPolicy: 'zh-TW-preserve-original',
        },
        savedAt: '2026-10-08T01:00:00.000Z',
      }),
    });
    const controller = createCaptionPersistenceController({
      enabled: true,
      storage,
      indexedDbAvailable: true,
      idbLoad: async () => ({
        ...persisted('old-translation'),
        captionTask: { purpose: 'translation', langPair: 'en→zh-TW' },
      }),
    });
    controllers.push(controller);
    const recovered = await controller.loadAsync();
    expect(recovered?.segments.map((s) => s.segmentId)).toEqual(['pure']);
    expect(recovered?.captionTask?.purpose).toBe('transcription');
    const other = {
      ...recovered!,
      sessionId: 'another-meeting',
      segments: state('other').segments,
      savedAtMs: recovered!.savedAtMs - 1,
    };
    expect(mergeSnapshots(recovered!, other, 20_000).segments.map((s) => s.segmentId)).toEqual([
      'pure',
    ]);
    const stopped = { ...recovered!, sessionPhase: 'ended' as const, sessionEndedAt: 1000 };
    const resumed = {
      ...recovered!,
      sessionPhase: 'running' as const,
      sessionEndedAt: null,
      savedAtMs: recovered!.savedAtMs + 1,
    };
    expect(mergeSnapshots(resumed, stopped, 20_000)).toMatchObject({
      sessionPhase: 'running',
      sessionEndedAt: null,
    });
  });
  it('disabled construction purges transcript keys without loading or saving them', async () => {
    const storage = memoryStorage({
      'meeting-audio:captions:v4': JSON.stringify(persisted('current')),
      'meeting-audio:captions:v3': JSON.stringify(persisted('legacy')),
    });
    const idbLoad = vi.fn(async () => persisted('idb'));
    const idbSave = vi.fn(async () => undefined);
    const idbClear = vi.fn(async () => undefined);
    const controller = createCaptionPersistenceController({
      enabled: false,
      storage,
      indexedDbAvailable: true,
      idbLoad,
      idbSave,
      idbClear,
    });
    controllers.push(controller);

    await controller.setEnabled(false, state());

    expect(storage.getItem('meeting-audio:captions:v4')).toBeNull();
    expect(storage.getItem('meeting-audio:captions:v3')).toBeNull();
    expect(idbLoad).not.toHaveBeenCalled();
    expect(idbSave).not.toHaveBeenCalled();
    expect(idbClear).toHaveBeenCalled();
  });

  it('enabling writes the complete current snapshot to both storage tiers', async () => {
    const storage = memoryStorage();
    let idbRecord: PersistedState | null = null;
    const controller = createCaptionPersistenceController({
      enabled: false,
      storage,
      indexedDbAvailable: true,
      idbLoad: vi.fn(async () => idbRecord),
      idbSave: vi.fn(async (value) => {
        idbRecord = value;
      }),
      idbClear: vi.fn(async () => {
        idbRecord = null;
      }),
    });
    controllers.push(controller);

    await controller.setEnabled(true, state('enabled'));

    const local = JSON.parse(storage.getItem('meeting-audio:captions:v4')!) as PersistedState;
    expect(local.segments.map((segment) => segment.segmentId)).toEqual(['enabled']);
    const savedRecord = idbRecord as PersistedState | null;
    expect(savedRecord?.segments.map((segment) => segment.segmentId)).toEqual(['enabled']);
  });

  it('disable serializes after an older in-flight save so data cannot be resurrected', async () => {
    const storage = memoryStorage();
    let idbRecord: PersistedState | null = null;
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const idbSave = vi.fn(async (value: PersistedState) => {
      idbRecord = value;
      await saveGate;
    });
    const idbClear = vi.fn(async () => {
      idbRecord = null;
    });
    const controller = createCaptionPersistenceController({
      enabled: false,
      storage,
      indexedDbAvailable: true,
      idbLoad: vi.fn(async () => null),
      idbSave,
      idbClear,
    });
    controllers.push(controller);

    const currentState = state('still-in-memory');
    const enabling = controller.setEnabled(true, state('older-save'));
    await vi.waitFor(() => expect(idbSave).toHaveBeenCalledTimes(1));
    const disabling = controller.setEnabled(false, currentState);
    releaseSave();
    await Promise.all([enabling, disabling]);

    expect(idbRecord).toBeNull();
    expect(storage.getItem('meeting-audio:captions:v4')).toBeNull();
    expect(currentState.segments.map((segment) => segment.segmentId)).toEqual(['still-in-memory']);
    expect(idbClear.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      idbSave.mock.invocationCallOrder.at(-1)!,
    );
  });

  it('a write still waiting for idle time cannot resurrect a cleared transcript', async () => {
    // The routine local write is deferred to idle. If Clear lands in that
    // window, the queued callback would run afterwards and put the deleted
    // meeting straight back — so it survives the next reload. That is a broken
    // privacy promise, not a stale cache.
    // Hold the idle callbacks by hand. Fake timers alone cannot express this:
    // the debounce and the idle write are both timers, and advancing past one
    // runs the other, closing the very window the bug lives in.
    const idleQueue: Array<() => void> = [];
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => void idleQueue.push(cb));
    vi.useFakeTimers();

    const storage = memoryStorage();
    const controller = createCaptionPersistenceController({
      enabled: true,
      storage,
      indexedDbAvailable: false,
    });
    controllers.push(controller);

    controller.save(state('secret'));
    // Fire the debounce so a write is queued for idle — and stop there.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(idleQueue).toHaveLength(1);

    await controller.clear();
    expect(storage.getItem('meeting-audio:captions:v4')).toBeNull();

    // The queued write now runs, exactly as it would after the user cleared.
    for (const run of idleQueue) run();
    expect(storage.getItem('meeting-audio:captions:v4')).toBeNull();

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
