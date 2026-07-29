import { idbClear, idbLoad, idbSave } from './idb-persistence.js';
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

const PERSIST_VERSION = 4;
const ACCEPTED_PERSIST_VERSIONS = new Set([2, 3, 4]);
const LS_TAIL_SEGMENTS = 2_000;
const PERSIST_DEBOUNCE_MS = 800;
const PERSIST_MAX_INTERVAL_MS = 5_000;
const IDB_SAVE_MIN_INTERVAL_MS = 8_000;

export interface PersistedState {
  v: number;
  segments: CaptionSegment[];
  translations: Record<string, CaptionTranslation>;
  sessionStartMs?: number | null;
  sessionId?: string | null;
  sessionEndedAt?: number | null;
  sessionMode?: SessionMode | null;
  sessionPhase?: SessionPhase | null;
  savedAt: string;
}

export interface HydratedSnapshot {
  segments: CaptionSegment[];
  translations: Record<string, CaptionTranslation>;
  sessionStartMs: number | null;
  sessionId: string | null;
  sessionEndedAt: number | null;
  sessionMode: SessionMode | null;
  sessionPhase: SessionPhase | null;
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
  storage?: Storage | null;
  indexedDbAvailable?: boolean;
  idbLoad?: () => Promise<PersistedState | null>;
  idbSave?: (value: PersistedState) => Promise<void>;
  idbClear?: () => Promise<void>;
}

function snapshotFromPersisted(parsed: PersistedState): HydratedSnapshot {
  const savedAtMs = parsed.savedAt ? Date.parse(parsed.savedAt) : NaN;
  return {
    segments: parsed.segments ?? [],
    translations: parsed.translations ?? {},
    sessionStartMs: parsed.sessionStartMs ?? null,
    sessionId: parsed.sessionId ?? null,
    sessionEndedAt: parsed.sessionEndedAt ?? null,
    sessionMode: parsed.sessionMode ?? null,
    // v2/v3 did not record a lifecycle phase. Treat migrated history as ended
    // so it can be exported without presenting an unsafe Continue action.
    sessionPhase: parsed.sessionPhase ?? 'ended',
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
  if (includeLive && state.livePartial) {
    const live = state.livePartial;
    if (!segments.some((segment) => segment.segmentId === live.segmentId)) {
      segments = [...segments, live];
    }
    if (state.liveTranslation) {
      translations = {
        ...translations,
        [live.segmentId]: { ...state.liveTranslation, sourceSegmentId: live.segmentId },
      };
    }
  }
  return {
    v: PERSIST_VERSION,
    segments,
    translations,
    sessionStartMs: state.sessionStartMs,
    sessionId: state.sessionId,
    sessionEndedAt: state.sessionEndedAt,
    sessionMode: state.sessionMode,
    sessionPhase: state.sessionPhase,
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
    sessionStartMs: base.sessionStartMs ?? other.sessionStartMs,
    sessionId: base.sessionId ?? other.sessionId,
    sessionEndedAt: base.sessionEndedAt ?? other.sessionEndedAt,
    sessionMode: base.sessionMode ?? other.sessionMode,
    sessionPhase: base.sessionPhase ?? other.sessionPhase,
    savedAtMs: Math.max(a.savedAtMs, b.savedAtMs),
  };
}

let persistWriteWarned = false;

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
        if (decoded) return decoded;
      }
      if (key === DEFAULT_PERSIST_KEY) {
        for (const legacy of LEGACY_PERSIST_KEYS) {
          const legacyRaw = storage.getItem(legacy);
          if (!legacyRaw) continue;
          const decoded = decodePersisted(legacyRaw);
          if (decoded) return decoded;
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
          return localSnapshot
            ? mergeSnapshots(localSnapshot, idbSnapshot, maxSegments)
            : idbSnapshot;
        })
        .catch(() => loadSync());
    }
    return initialLoad;
  };

  const flush = (snapshot: CaptionState): void => {
    if (!enabled || disposed || !storage || !key) return;
    const full = buildPersistPayload(snapshot, true);
    writeSnapshot(storage, key, tailPayload(full, LS_TAIL_SEGMENTS));
  };

  const persist = (snapshot: CaptionState, forceIdb: boolean): Promise<void> => {
    if (!enabled || disposed || !storage || !key) return idbChain;
    const full = buildPersistPayload(snapshot, false);
    writeSnapshot(storage, key, tailPayload(full, LS_TAIL_SEGMENTS));
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
      snapshot.sessionPhase !== lastSessionPhase;
    if (!changed) return;
    lastSegmentsRef = snapshot.segments;
    lastTranslationsRef = snapshot.translations;
    lastSessionStartMs = snapshot.sessionStartMs;
    lastSessionId = snapshot.sessionId;
    lastSessionEndedAt = snapshot.sessionEndedAt;
    lastSessionMode = snapshot.sessionMode;
    lastSessionPhase = snapshot.sessionPhase;

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
    await persist(snapshot, true);
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
