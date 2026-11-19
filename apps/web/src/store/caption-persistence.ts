import { idbClear, idbLoad, idbSave } from './idb-persistence.js';
import { CaptionTask } from '@meeting-audio/contracts';
import type {
  CaptionSegment,
  CaptionState,
  CaptionTranslation,
  SessionMode,
  SessionPhase,
} from './caption-store.js';

export const DEFAULT_PERSIST_KEY = 'meeting-audio:captions:v4';
export const LEGACY_PERSIST_KEYS = [
  'meeting-audio:captions:v3',
  'meeting-audio:captions:v2',
] as const;

const PERSIST_VERSION = 5;
const ACCEPTED_PERSIST_VERSIONS = new Set([2, 3, 4, 5]);
const LS_TAIL_SEGMENTS = 2_000;
const PERSIST_DEBOUNCE_MS = 800;
const PERSIST_MAX_INTERVAL_MS = 5_000;
const IDB_SAVE_MIN_INTERVAL_MS = 8_000;

export interface PersistedState {
  separateTracks?: boolean;
  v: number;
  segments: CaptionSegment[];
  translations: Record<string, CaptionTranslation>;
  sessionStartMs?: number | null;
  sessionId?: string | null;
  sessionEndedAt?: number | null;
  sessionMode?: SessionMode | null;
  sessionPhase?: SessionPhase | null;
  captionTask?: CaptionTask | null;
  archiveGeneration?: string | null;
  savedAt: string;
}

export interface HydratedSnapshot {
  separateTracks?: boolean;
  segments: CaptionSegment[];
  translations: Record<string, CaptionTranslation>;
  sessionStartMs: number | null;
  sessionId: string | null;
  sessionEndedAt: number | null;
  sessionMode: SessionMode | null;
  sessionPhase: SessionPhase | null;
  captionTask?: CaptionTask | null;
  archiveGeneration?: string | null;
  savedAtMs: number;
}

export interface CaptionPersistenceController {
  loadSync(): HydratedSnapshot | null;
  loadAsync(): Promise<HydratedSnapshot | null>;
  save(snapshot: CaptionState): void;
  flush(snapshot: CaptionState): void;
  setEnabled(enabled: boolean, snapshot: CaptionState): Promise<HydratedSnapshot | null>;
  clear(): Promise<void>;
  dispose(): void;
}

export interface CaptionPersistenceOptions {
  enabled: boolean;
  key?: string | null;
  maxSegments?: number;
  captionTask?: CaptionTask;
  storage?: Storage | null;
  indexedDbAvailable?: boolean;
  idbLoad?: () => Promise<PersistedState | null>;
  idbSave?: (value: PersistedState) => Promise<void>;
  idbClear?: () => Promise<void>;
}

export function captionTasksMatch(
  a: CaptionTask | null | undefined,
  b: CaptionTask | null | undefined,
): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null);
  if (a.purpose !== b.purpose) return false;
  if (a.purpose === 'translation' && b.purpose === 'translation') return a.langPair === b.langPair;
  if (a.purpose === 'transcription' && b.purpose === 'transcription') {
    return (
      a.textPolicy === b.textPolicy &&
      [...new Set(a.inputLanguages)].sort().join(',') ===
        [...new Set(b.inputLanguages)].sort().join(',')
    );
  }
  return false;
}

function snapshotFromPersisted(parsed: PersistedState): HydratedSnapshot | null {
  if (!ACCEPTED_PERSIST_VERSIONS.has(parsed.v)) return null;
  let captionTask: CaptionTask | null;
  if (parsed.captionTask === undefined || (parsed.v < 5 && parsed.captionTask === null)) {
    // Untagged history came from the translation UI. Preserve it under that
    // purpose; missing language evidence uses that UI's historical default.
    const languageEvidence = Object.values(parsed.translations ?? {}).find((t) => t.targetLanguage);
    captionTask = {
      purpose: 'translation',
      langPair: languageEvidence?.targetLanguage.toLowerCase().startsWith('en')
        ? 'zh-TW→en'
        : 'en→zh-TW',
    };
  } else if (parsed.captionTask === null) captionTask = null;
  else {
    const task = CaptionTask.safeParse(parsed.captionTask);
    if (!task.success) return null;
    captionTask = task.data;
  }
  const savedAtMs = parsed.savedAt ? Date.parse(parsed.savedAt) : NaN;
  return {
    segments: parsed.segments ?? [],
    separateTracks: parsed.separateTracks === true,
    translations: parsed.translations ?? {},
    sessionStartMs: parsed.sessionStartMs ?? null,
    sessionId: parsed.sessionId ?? null,
    sessionEndedAt: parsed.sessionEndedAt ?? null,
    sessionMode: parsed.sessionMode ?? null,
    // v2/v3 did not record a lifecycle phase. Treat migrated history as ended
    // so it can be exported without presenting an unsafe Continue action.
    sessionPhase: parsed.sessionPhase ?? 'ended',
    captionTask,
    archiveGeneration: parsed.archiveGeneration ?? null,
    savedAtMs: Number.isFinite(savedAtMs) ? savedAtMs : 0,
  };
}

function decodePersisted(raw: string): HydratedSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as PersistedState;
    if (!ACCEPTED_PERSIST_VERSIONS.has(parsed.v)) return null;
    return snapshotFromPersisted(parsed);
  } catch {
    return null;
  }
}

function buildPersistPayload(state: CaptionState, includeLive: boolean): PersistedState {
  let segments = state.segments;
  let translations = state.translations;
  const liveTracks = Object.values(state.liveTracks ?? {});
  // Legacy callers may supply only the single-live compatibility fields.
  if (!liveTracks.length && state.livePartial)
    liveTracks.push({ partial: state.livePartial, translation: state.liveTranslation });
  for (const track of includeLive ? liveTracks : []) {
    const live = track.partial;
    if (!segments.some((segment) => segment.segmentId === live.segmentId)) {
      segments = [...segments, live];
    }
    if (track.translation) {
      translations = {
        ...translations,
        [live.segmentId]: { ...track.translation, sourceSegmentId: live.segmentId },
      };
    }
  }
  return {
    v: PERSIST_VERSION,
    separateTracks: state.separateTracks,
    segments,
    translations,
    sessionStartMs: state.sessionStartMs,
    sessionId: state.sessionId,
    sessionEndedAt: state.sessionEndedAt,
    sessionMode: state.sessionMode,
    sessionPhase: state.sessionPhase,
    captionTask: state.captionTask,
    archiveGeneration: state.archiveGeneration ?? null,
    savedAt: new Date().toISOString(),
  };
}

export function tailPayload(full: PersistedState, tail: number): PersistedState {
  if (full.segments.length <= tail) return full;
  const segments = full.segments.slice(full.segments.length - tail);
  const keep = new Set(segments.map((segment) => segment.segmentId));
  const translations: Record<string, CaptionTranslation> = {};
  for (const id of keep) {
    const translation = full.translations[id];
    if (translation) translations[id] = translation;
  }
  return { ...full, segments, translations };
}

export function mergeSnapshots(
  a: HydratedSnapshot,
  b: HydratedSnapshot,
  maxSegments: number,
): HydratedSnapshot {
  const base = a.savedAtMs >= b.savedAtMs ? a : b;
  const other = base === a ? b : a;
  if (
    base.sessionId !== other.sessionId ||
    (base.archiveGeneration ?? null) !== (other.archiveGeneration ?? null) ||
    !captionTasksMatch(base.captionTask, other.captionTask)
  ) {
    const segments = base.segments.slice(-maxSegments);
    const keep = new Set(segments.map((segment) => segment.segmentId));
    return {
      ...base,
      segments,
      translations: Object.fromEntries(
        Object.entries(base.translations).filter(([id]) => keep.has(id)),
      ),
    };
  }
  const byId = new Map<string, CaptionSegment>();
  for (const segment of base.segments) byId.set(segment.segmentId, segment);
  for (const segment of other.segments) {
    if (!byId.has(segment.segmentId)) byId.set(segment.segmentId, segment);
  }
  let segments = Array.from(byId.values()).sort((left, right) => left.startMs - right.startMs);
  if (segments.length > maxSegments) segments = segments.slice(segments.length - maxSegments);
  const keep = new Set(segments.map((segment) => segment.segmentId));
  const translations: Record<string, CaptionTranslation> = {};
  for (const [id, translation] of Object.entries({
    ...other.translations,
    ...base.translations,
  })) {
    if (keep.has(id)) translations[id] = translation;
  }
  return {
    segments,
    translations,
    sessionStartMs: base.sessionStartMs,
    separateTracks: base.separateTracks === true,
    sessionId: base.sessionId,
    sessionEndedAt: base.sessionEndedAt,
    sessionMode: base.sessionMode,
    sessionPhase: base.sessionPhase,
    captionTask: base.captionTask ?? null,
    archiveGeneration: base.archiveGeneration ?? null,
    savedAtMs: Math.max(a.savedAtMs, b.savedAtMs),
  };
}

let persistWriteWarned = false;

/**
 * Run `fn` when the browser is not busy, falling back to a macrotask where
 * requestIdleCallback is missing (Safari, and jsdom under test). Deliberately a
 * local copy rather than a shared utility — it is a six-line browser-API shim,
 * and a utils layer that exists to hold two of these earns nothing. The twin
 * lives in providers/latency-monitor.ts.
 */
function whenIdle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => void })
    .requestIdleCallback;
  if (typeof ric === 'function') {
    ric(fn);
    return;
  }
  setTimeout(fn, 0);
}

function writeSnapshot(storage: Storage, key: string, payload: PersistedState): void {
  try {
    storage.setItem(key, JSON.stringify(payload));
  } catch (error) {
    if (persistWriteWarned) return;
    persistWriteWarned = true;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[caption-store] transcript autosave failed (${reason}). The meeting ` +
        `stays in memory but will NOT survive a reload — export to a file to keep it.`,
    );
  }
}

export function createCaptionPersistenceController(
  options: CaptionPersistenceOptions,
): CaptionPersistenceController {
  const key = options.key === null ? null : (options.key ?? DEFAULT_PERSIST_KEY);
  const maxSegments = options.maxSegments ?? 20_000;
  const storage =
    options.storage !== undefined
      ? options.storage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;
  const indexedDbAvailable = options.indexedDbAvailable ?? typeof indexedDB !== 'undefined';
  const loadIdb = options.idbLoad ?? (() => idbLoad<PersistedState>());
  const saveIdb = options.idbSave ?? idbSave;
  const clearIdb = options.idbClear ?? idbClear;

  let enabled = options.enabled && key !== null;
  let disposed = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSegmentsRef: CaptionSegment[] | null = null;
  let lastTranslationsRef: Record<string, CaptionTranslation> | null = null;
  let lastSessionStartMs: number | null | undefined;
  let lastSessionId: string | null | undefined;
  let lastSessionEndedAt: number | null | undefined;
  let lastSessionMode: SessionMode | null | undefined;
  let lastSessionPhase: SessionPhase | null | undefined;
  let lastCaptionTask: CaptionTask | null | undefined;
  let lastArchiveGeneration: string | null | undefined;
  let lastFlushAt = 0;
  let lastIdbSaveAt = 0;
  let idbChain: Promise<void> = Promise.resolve();
  let initialLoad: Promise<HydratedSnapshot | null> | null = null;

  const cancelTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const purgeLocal = () => {
    if (!storage || !key) return;
    try {
      storage.removeItem(key);
      if (key === DEFAULT_PERSIST_KEY) {
        for (const legacy of LEGACY_PERSIST_KEYS) storage.removeItem(legacy);
      }
    } catch {
      // Storage may be unavailable. In-memory captions remain unaffected.
    }
  };

  const queueClear = (): Promise<void> => {
    if (!indexedDbAvailable || key !== DEFAULT_PERSIST_KEY) return idbChain;
    idbChain = idbChain.then(clearIdb).catch(() => {});
    return idbChain;
  };

  const queueSave = (full: PersistedState, force: boolean): Promise<void> => {
    if (!indexedDbAvailable || key !== DEFAULT_PERSIST_KEY) return idbChain;
    const now = Date.now();
    if (!force && lastIdbSaveAt !== 0 && now - lastIdbSaveAt < IDB_SAVE_MIN_INTERVAL_MS) {
      return idbChain;
    }
    lastIdbSaveAt = now;
    const writeGeneration = generation;
    idbChain = idbChain
      .then(async () => {
        if (initialLoad) await initialLoad;
        if (disposed || !enabled || writeGeneration !== generation) return;
        await saveIdb(full);
      })
      .catch(() => {});
    return idbChain;
  };

  const loadSync = (): HydratedSnapshot | null => {
    if (!enabled || !storage || !key) return null;
    try {
      const raw = storage.getItem(key);
      if (raw) {
        const decoded = decodePersisted(raw);
        if (
          decoded &&
          (!options.captionTask || captionTasksMatch(decoded.captionTask, options.captionTask))
        )
          return decoded;
      }
      if (key === DEFAULT_PERSIST_KEY) {
        for (const legacy of LEGACY_PERSIST_KEYS) {
          const legacyRaw = storage.getItem(legacy);
          if (!legacyRaw) continue;
          const decoded = decodePersisted(legacyRaw);
          if (
            decoded &&
            (!options.captionTask || captionTasksMatch(decoded.captionTask, options.captionTask))
          )
            return decoded;
        }
      }
    } catch {
      // Treat unavailable or invalid storage as empty.
    }
    return null;
  };

  const loadAsync = (): Promise<HydratedSnapshot | null> => {
    if (!enabled || !indexedDbAvailable || key !== DEFAULT_PERSIST_KEY) {
      return Promise.resolve(loadSync());
    }
    if (!initialLoad) {
      initialLoad = loadIdb()
        .then((record) => {
          if (!record || !enabled) return loadSync();
          const idbSnapshot = snapshotFromPersisted(record);
          const localSnapshot = loadSync();
          if (
            !idbSnapshot ||
            (options.captionTask &&
              !captionTasksMatch(idbSnapshot.captionTask, options.captionTask))
          )
            return localSnapshot;
          return localSnapshot
            ? mergeSnapshots(localSnapshot, idbSnapshot, maxSegments)
            : idbSnapshot;
        })
        .catch(() => loadSync());
    }
    return initialLoad;
  };

  // A local-storage write waiting for idle time. Only the newest snapshot is
  // worth writing, so a later one simply replaces it.
  let pendingLocalWrite: PersistedState | null = null;
  let localWriteScheduled = false;

  const cancelPendingLocalWrite = (): void => {
    pendingLocalWrite = null;
  };

  const scheduleLocalWrite = (payload: PersistedState): void => {
    pendingLocalWrite = payload;
    if (localWriteScheduled) return;
    localWriteScheduled = true;
    whenIdle(() => {
      localWriteScheduled = false;
      const payloadToWrite = pendingLocalWrite;
      pendingLocalWrite = null;
      if (!payloadToWrite || !enabled || disposed || !storage || !key) return;
      writeSnapshot(storage, key, payloadToWrite);
    });
  };

  /**
   * The durable write. Stays SYNCHRONOUS on purpose: its whole reason to exist
   * is to beat a tab close, and deferring it would defeat that exactly when it
   * matters. Any deferred write is dropped first — this snapshot is newer and
   * includes the live line, so letting the older one land afterwards would
   * overwrite the final transcript with a staler copy.
   */
  const flush = (snapshot: CaptionState): void => {
    if (!enabled || disposed || !storage || !key) return;
    cancelPendingLocalWrite();
    const full = buildPersistPayload(snapshot, true);
    writeSnapshot(storage, key, tailPayload(full, LS_TAIL_SEGMENTS));
  };

  /**
   * The routine write, debounced during a meeting. localStorage writes are
   * synchronous and block the main thread, and this one runs while someone is
   * talking, so the write itself goes to idle time. The IndexedDB half was
   * already async.
   */
  const persist = (
    snapshot: CaptionState,
    forceIdb: boolean,
    localWrite: 'idle' | 'now' = 'idle',
  ): Promise<void> => {
    if (!enabled || disposed || !storage || !key) return idbChain;
    const full = buildPersistPayload(snapshot, false);
    const payload = tailPayload(full, LS_TAIL_SEGMENTS);
    if (localWrite === 'now') {
      pendingLocalWrite = null;
      writeSnapshot(storage, key, payload);
    } else {
      scheduleLocalWrite(payload);
    }
    return queueSave(full, forceIdb);
  };

  const save = (snapshot: CaptionState): void => {
    if (!enabled || disposed) return;
    const changed =
      snapshot.segments !== lastSegmentsRef ||
      snapshot.translations !== lastTranslationsRef ||
      snapshot.sessionStartMs !== lastSessionStartMs ||
      snapshot.sessionId !== lastSessionId ||
      snapshot.sessionEndedAt !== lastSessionEndedAt ||
      snapshot.sessionMode !== lastSessionMode ||
      snapshot.sessionPhase !== lastSessionPhase ||
      snapshot.captionTask !== lastCaptionTask ||
      snapshot.archiveGeneration !== lastArchiveGeneration;
    if (!changed) return;
    lastSegmentsRef = snapshot.segments;
    lastTranslationsRef = snapshot.translations;
    lastSessionStartMs = snapshot.sessionStartMs;
    lastSessionId = snapshot.sessionId;
    lastSessionEndedAt = snapshot.sessionEndedAt;
    lastSessionMode = snapshot.sessionMode;
    lastSessionPhase = snapshot.sessionPhase;
    lastCaptionTask = snapshot.captionTask;
    lastArchiveGeneration = snapshot.archiveGeneration;

    const doFlush = () => {
      timer = null;
      lastFlushAt = Date.now();
      void persist(snapshot, false);
    };
    const sinceLastFlush = Date.now() - lastFlushAt;
    if (lastFlushAt > 0 && sinceLastFlush >= PERSIST_MAX_INTERVAL_MS) {
      cancelTimer();
      doFlush();
      return;
    }
    cancelTimer();
    timer = setTimeout(doFlush, PERSIST_DEBOUNCE_MS);
  };

  const clear = async (): Promise<void> => {
    generation += 1;
    cancelTimer();
    // Drop any write still waiting for idle time BEFORE purging. Otherwise its
    // callback runs after the purge and writes the deleted transcript straight
    // back — the meeting the user just erased reappears on the next reload,
    // which is a broken privacy promise, not merely a stale cache.
    cancelPendingLocalWrite();
    purgeLocal();
    await queueClear();
  };

  const setEnabled = async (
    nextEnabled: boolean,
    snapshot: CaptionState,
  ): Promise<HydratedSnapshot | null> => {
    if (!nextEnabled || key === null) {
      enabled = false;
      await clear();
      return null;
    }
    if (enabled) return null;
    generation += 1;
    enabled = true;
    initialLoad = null;
    // Opting in writes immediately, not at the next idle moment. The user just
    // asked for their transcript to be kept; a crash in the seconds after that
    // must not be the thing that proves the setting did nothing.
    await persist(snapshot, true, 'now');
    return null;
  };

  if (!enabled) {
    purgeLocal();
    void queueClear();
  }

  return {
    loadSync,
    loadAsync,
    save,
    flush,
    setEnabled,
    clear,
    dispose: () => {
      disposed = true;
      cancelTimer();
    },
  };
}
