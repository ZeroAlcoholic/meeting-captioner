import type { TranscriptEvent, TranslationEvent } from '@meeting-audio/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';

export interface CaptionSegment {
  segmentId: string;
  provider: string;
  source: TranscriptEvent['source'];
  mode: TranscriptEvent['mode'];
  status: TranscriptEvent['status'];
  text: string;
  startMs: number;
  endMs?: number;
  confidence?: number;
}

export interface CaptionTranslation {
  sourceSegmentId: string;
  provider: string;
  status: TranslationEvent['status'];
  sourceText: string;
  targetText: string;
  sourceLanguage: string;
  targetLanguage: string;
  updatedAt: string;
}

export interface CaptionState {
  maxSegments: number;
  segments: CaptionSegment[];
  translations: Record<string, CaptionTranslation>;
  applyTranscript: (event: TranscriptEvent) => void;
  applyTranslation: (event: TranslationEvent) => void;
  clear: () => void;
}

export interface CreateCaptionStoreOptions {
  maxSegments?: number;
  /** localStorage key for autosave. Pass null to disable persistence (e.g. tests). */
  persistKey?: string | null;
}

const DEFAULT_MAX_SEGMENTS = 500;
const PERSIST_DEBOUNCE_MS = 800;
const PERSIST_VERSION = 1;

interface PersistedState {
  v: number;
  segments: CaptionSegment[];
  translations: Record<string, CaptionTranslation>;
  savedAt: string;
}

function loadPersisted(key: string): { segments: CaptionSegment[]; translations: Record<string, CaptionTranslation> } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed.v !== PERSIST_VERSION) return null;
    return { segments: parsed.segments ?? [], translations: parsed.translations ?? {} };
  } catch {
    return null;
  }
}

function makeDebouncedSaver(key: string): (state: CaptionState) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (state) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        const payload: PersistedState = {
          v: PERSIST_VERSION,
          segments: state.segments,
          translations: state.translations,
          savedAt: new Date().toISOString(),
        };
        localStorage.setItem(key, JSON.stringify(payload));
      } catch {
        // QuotaExceeded or unavailable storage — fail silently, in-memory keeps working.
      }
    }, PERSIST_DEBOUNCE_MS);
  };
}

function eventToSegment(event: TranscriptEvent): CaptionSegment {
  const segment: CaptionSegment = {
    segmentId: event.segmentId,
    provider: event.provider,
    source: event.source,
    mode: event.mode,
    status: event.status,
    text: event.text,
    startMs: event.startMs,
  };
  if (event.endMs !== undefined) segment.endMs = event.endMs;
  if (event.confidence !== undefined) segment.confidence = event.confidence;
  return segment;
}

function eventToTranslation(event: TranslationEvent): CaptionTranslation {
  return {
    sourceSegmentId: event.sourceSegmentId,
    provider: event.provider,
    status: event.status,
    sourceText: event.sourceText,
    targetText: event.targetText,
    sourceLanguage: event.sourceLanguage,
    targetLanguage: event.targetLanguage,
    updatedAt: event.updatedAt,
  };
}

function upsertSorted(
  segments: CaptionSegment[],
  next: CaptionSegment,
  supersedeId: string | undefined,
  maxSegments: number,
): CaptionSegment[] {
  const filtered = segments.filter(
    (s) => s.segmentId !== next.segmentId && s.segmentId !== supersedeId,
  );
  let insertAt = filtered.length;
  for (let i = filtered.length - 1; i >= 0; i--) {
    const seg = filtered[i];
    if (seg !== undefined && seg.startMs <= next.startMs) {
      insertAt = i + 1;
      break;
    }
    if (i === 0) insertAt = 0;
  }
  const placed = [...filtered.slice(0, insertAt), next, ...filtered.slice(insertAt)];
  return placed.length > maxSegments ? placed.slice(placed.length - maxSegments) : placed;
}

export type CaptionStore = StoreApi<CaptionState>;

export function createCaptionStore(options: CreateCaptionStoreOptions = {}): CaptionStore {
  const maxSegments = options.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  const persistKey = options.persistKey === null ? null : options.persistKey ?? 'meeting-audio:captions:v1';

  // Hydrate from localStorage on construction so a page reload preserves the meeting.
  const hydrated =
    persistKey && typeof window !== 'undefined' && typeof localStorage !== 'undefined'
      ? loadPersisted(persistKey)
      : null;

  const store = createStore<CaptionState>((set) => ({
    maxSegments,
    segments: hydrated?.segments ?? [],
    translations: hydrated?.translations ?? {},

    applyTranscript: (event) =>
      set((state) => {
        const segments = upsertSorted(
          state.segments,
          eventToSegment(event),
          event.revisionOf,
          state.maxSegments,
        );
        // Prune translations whose source segments dropped out of the buffer.
        // Without this, translations grows unbounded (memory leak in long sessions).
        if (segments.length < Object.keys(state.translations).length) {
          const liveIds = new Set(segments.map((s) => s.segmentId));
          const next: Record<string, CaptionTranslation> = {};
          for (const id of liveIds) {
            const t = state.translations[id];
            if (t) next[id] = t;
          }
          return { segments, translations: next };
        }
        return { segments };
      }),

    applyTranslation: (event) =>
      set((state) => ({
        translations: {
          ...state.translations,
          [event.sourceSegmentId]: eventToTranslation(event),
        },
      })),

    clear: () => {
      set({ segments: [], translations: {} });
      // Clear is intentional and immediate — wipe the persisted copy too.
      if (persistKey && typeof localStorage !== 'undefined') {
        try { localStorage.removeItem(persistKey); } catch { /* noop */ }
      }
    },
  }));

  // Subscribe AFTER hydration so we don't immediately overwrite with empty state.
  if (persistKey && typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    const save = makeDebouncedSaver(persistKey);
    store.subscribe((state) => save(state));
  }

  return store;
}
