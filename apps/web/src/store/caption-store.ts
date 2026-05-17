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
  /**
   * Finalized segments only. Append-grade list that paragraph grouping
   * iterates. Reference is STABLE while a partial is in flight — that is the
   * key invariant that keeps the history paragraphs / scrollback from
   * recomputing on every per-character delta.
   */
  segments: CaptionSegment[];
  /**
   * The currently-in-flight (partial/revised) segment, if any. Updated on
   * every partial delta — so only components that subscribe to this field
   * re-render on the live hot path.
   */
  livePartial: CaptionSegment | null;
  /**
   * Translation in flight for the current livePartial. Kept OUT of the
   * `translations` map so a 20 Hz draft stream does not bump the translations
   * reference and force HistoryStream to recompute paragraph grouping.
   * Promoted into `translations` when the matching transcript finalizes.
   */
  liveTranslation: CaptionTranslation | null;
  /** Translations of finalized segments only. */
  translations: Record<string, CaptionTranslation>;
  /**
   * Wall-clock time (Date.now ms) of the FIRST transcript event in this
   * session. Drives history time-gutter labels. Pinned across events; reset
   * on clear().
   */
  sessionStartMs: number | null;
  applyTranscript: (event: TranscriptEvent) => void;
  applyTranslation: (event: TranslationEvent) => void;
  clear: () => void;
}

export interface CreateCaptionStoreOptions {
  maxSegments?: number;
  /** localStorage key for autosave. Pass null to disable persistence (e.g. tests). */
  persistKey?: string | null;
}

// Buffer cap. Sized for a long business meeting: at ~2-3 s per segment
// (typical conversational pace) a 90-minute meeting produces ~1800-2700
// segments. 3000 gives ~100 minutes of headroom before the oldest
// segment is pruned from scrollback / persisted state. Storage cost is
// bounded — at ~200 bytes per JSON segment the on-disk persisted state
// peaks around 600 KB, well within the 5-10 MB localStorage quota.
const DEFAULT_MAX_SEGMENTS = 3000;
const PERSIST_DEBOUNCE_MS = 800;
const PERSIST_VERSION = 2;

interface PersistedState {
  v: number;
  segments: CaptionSegment[];
  translations: Record<string, CaptionTranslation>;
  sessionStartMs?: number | null;
  savedAt: string;
}

function loadPersisted(key: string): {
  segments: CaptionSegment[];
  translations: Record<string, CaptionTranslation>;
  sessionStartMs: number | null;
} | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed.v !== PERSIST_VERSION) return null;
    return {
      segments: parsed.segments ?? [],
      translations: parsed.translations ?? {},
      sessionStartMs: parsed.sessionStartMs ?? null,
    };
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
          sessionStartMs: state.sessionStartMs,
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

/**
 * Insert/replace `next` keyed by segmentId, ordered by startMs. Drops the
 * oldest entries when the buffer exceeds maxSegments.
 *
 * Returns the same array reference (with no rewrite) when neither `next` nor
 * `supersedeId` change the visible state — that lets React skip work via
 * reference equality.
 */
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
  const persistKey = options.persistKey === null ? null : options.persistKey ?? 'meeting-audio:captions:v2';

  // Hydrate from localStorage on construction so a page reload preserves the meeting.
  const hydrated =
    persistKey && typeof window !== 'undefined' && typeof localStorage !== 'undefined'
      ? loadPersisted(persistKey)
      : null;

  const store = createStore<CaptionState>((set) => ({
    maxSegments,
    segments: hydrated?.segments ?? [],
    livePartial: null,
    liveTranslation: null,
    translations: hydrated?.translations ?? {},
    sessionStartMs: hydrated?.sessionStartMs ?? null,

    applyTranscript: (event) =>
      set((state) => {
        const sessionStartMs = state.sessionStartMs ?? Date.now();

        // Partials and revisions are in-flight ─ they update livePartial only.
        // segments[] reference does NOT change, so the history scrollback and
        // its paragraph grouping skip re-render entirely.
        if (event.status !== 'final') {
          const nextLive = eventToSegment(event);
          // If the live segment id matches the current liveTranslation, keep
          // it. Otherwise check whether a translation arrived BEFORE its
          // transcript and is sitting in `translations[segId]` — if so,
          // promote it to liveTranslation and remove it from history so
          // LiveCaption picks it up. Without this the early-translation
          // would be stranded forever.
          let liveTranslation = state.liveTranslation;
          let translations = state.translations;
          if (liveTranslation && liveTranslation.sourceSegmentId !== nextLive.segmentId) {
            liveTranslation = null;
          }
          if (!liveTranslation && translations[nextLive.segmentId]) {
            liveTranslation = translations[nextLive.segmentId]!;
            const { [nextLive.segmentId]: _removed, ...rest } = translations;
            translations = rest;
          }
          const out: Partial<CaptionState> = {
            livePartial: nextLive,
            liveTranslation,
            sessionStartMs,
          };
          if (translations !== state.translations) out.translations = translations;
          return out;
        }

        // Final: commit to segments[]. Clear livePartial if it tracked this id
        // (or was the one being superseded). Promote any live translation for
        // this segment into the finalized translations map.
        const segments = upsertSorted(
          state.segments,
          eventToSegment(event),
          event.revisionOf,
          state.maxSegments,
        );

        const live = state.livePartial;
        const liveClears =
          live !== null &&
          (live.segmentId === event.segmentId || live.segmentId === event.revisionOf);

        let translations = state.translations;
        let liveTranslation = state.liveTranslation;
        if (
          liveTranslation &&
          (liveTranslation.sourceSegmentId === event.segmentId ||
            liveTranslation.sourceSegmentId === event.revisionOf)
        ) {
          // Re-key under the final segment id (in case of revisionOf supersession).
          const promoted: CaptionTranslation = {
            ...liveTranslation,
            sourceSegmentId: event.segmentId,
          };
          translations = { ...translations, [event.segmentId]: promoted };
          liveTranslation = null;
        }

        // Prune translations whose source segments dropped out of the buffer.
        // Long-running sessions hit the maxSegments cap; dropped segments
        // leave their translations behind. The old "<" comparison missed the
        // common case where both are 500 but a segment was just dropped —
        // so we now prune whenever the cap is at-or-above maxSegments.
        const tCount = Object.keys(translations).length;
        if (tCount > segments.length || segments.length >= state.maxSegments) {
          const liveIds = new Set(segments.map((s) => s.segmentId));
          const next: Record<string, CaptionTranslation> = {};
          for (const id of liveIds) {
            const t = translations[id];
            if (t) next[id] = t;
          }
          // Only swap if we actually shrank — keeps reference stable for
          // HistoryStream when nothing changed.
          if (Object.keys(next).length !== tCount) {
            translations = next;
          }
        }

        return {
          segments,
          translations,
          livePartial: liveClears ? null : live,
          liveTranslation,
          sessionStartMs,
        };
      }),

    applyTranslation: (event) =>
      set((state) => {
        // If this translation matches the live partial, keep it OFF the main
        // translations map so HistoryStream does not re-render at draft rate.
        if (
          state.livePartial &&
          state.livePartial.segmentId === event.sourceSegmentId
        ) {
          return { liveTranslation: eventToTranslation(event) };
        }
        return {
          translations: {
            ...state.translations,
            [event.sourceSegmentId]: eventToTranslation(event),
          },
        };
      }),

    clear: () => {
      set({
        segments: [],
        livePartial: null,
        liveTranslation: null,
        translations: {},
        sessionStartMs: null,
      });
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
