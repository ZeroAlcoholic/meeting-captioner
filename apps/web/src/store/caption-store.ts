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
  confidence?: number;
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
  /**
   * UUID assigned when `beginSession()` is called. Null when no session has
   * been started in this tab yet (e.g. fresh load showing restored data).
   * The pair (sessionId, sessionEndedAt) gives downstream consumers a stable
   * way to distinguish "active session" from "historical record".
   */
  sessionId: string | null;
  /**
   * Wall-clock ms at which `endSession()` was called. Non-null means the
   * session is closed; null means either no session ever started OR an
   * active session is in flight. Persisted, so a graceful Stop survives a
   * reload as "ended" while a tab-close in the middle of a meeting comes
   * back as "still open" — useful signal for future analytics, not used by
   * the current restored-chip UI.
   */
  sessionEndedAt: number | null;
  /**
   * EPHEMERAL — never persisted. True only at construction when hydration
   * actually loaded data from storage, and stays true until the user
   * starts a new session in this tab. Drives the "📂 Restored N segments"
   * chip without conflating it with the normal stop-then-still-see-data
   * case (where the user just clicked Stop and obviously knows the data
   * is theirs).
   */
  restoredFromStorage: boolean;
  applyTranscript: (event: TranscriptEvent) => void;
  applyTranslation: (event: TranslationEvent) => void;
  /**
   * Begin a fresh session. Clears all in-memory state (segments / live /
   * translations / sessionStartMs), assigns a new sessionId, resets
   * sessionEndedAt to null, and clears the restoredFromStorage flag so the
   * "this is old data" chip dismisses. Called by App.tsx whenever the user
   * clicks Start (fake/real/offline) — without this, post-Start transcript
   * events would append into the previous session's history with timestamps
   * anchored to the old sessionStartMs.
   */
  beginSession: () => void;
  /**
   * Mark the active session as ended without clearing its data. Called by
   * App.tsx on Stop. The data remains visible (and persisted) so the user
   * can still export it after stopping.
   */
  endSession: () => void;
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
const PERSIST_VERSION = 3;
const DEFAULT_PERSIST_KEY = 'meeting-audio:captions:v3';
// Legacy keys we still attempt to read for backward-compat. The current
// writer only ever writes to DEFAULT_PERSIST_KEY; once the user re-saves
// after migration the legacy entry can be deleted.
const LEGACY_PERSIST_KEYS = ['meeting-audio:captions:v2'] as const;

interface PersistedState {
  v: number;
  segments: CaptionSegment[];
  translations: Record<string, CaptionTranslation>;
  sessionStartMs?: number | null;
  sessionId?: string | null;
  sessionEndedAt?: number | null;
  savedAt: string;
}

interface HydratedSnapshot {
  segments: CaptionSegment[];
  translations: Record<string, CaptionTranslation>;
  sessionStartMs: number | null;
  sessionId: string | null;
  sessionEndedAt: number | null;
}

function decodePersisted(raw: string): HydratedSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as PersistedState;
    // v2 ⇢ v3: missing sessionId / sessionEndedAt default to null. The
    // restoredFromStorage flag (set by the caller) is what makes the chip
    // appear, so v2 data lands in the same "you have restored captions"
    // UX as v3 data that was persisted without a clean Stop.
    if (parsed.v !== 2 && parsed.v !== PERSIST_VERSION) return null;
    return {
      segments: parsed.segments ?? [],
      translations: parsed.translations ?? {},
      sessionStartMs: parsed.sessionStartMs ?? null,
      sessionId: parsed.sessionId ?? null,
      sessionEndedAt: parsed.sessionEndedAt ?? null,
    };
  } catch {
    return null;
  }
}

function loadPersisted(key: string): HydratedSnapshot | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const decoded = decodePersisted(raw);
      if (decoded) return decoded;
    }
    // Try legacy keys (only when reading the current default key — caller-
    // supplied custom keys don't get the migration fallback, since they're
    // typically test-only).
    if (key === DEFAULT_PERSIST_KEY) {
      for (const legacy of LEGACY_PERSIST_KEYS) {
        const legacyRaw = localStorage.getItem(legacy);
        if (!legacyRaw) continue;
        const decoded = decodePersisted(legacyRaw);
        if (decoded) return decoded;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function makeSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for ancient runtimes / jsdom edge cases. Not cryptographically
  // strong, but sessionId only needs to be unique within this tab's
  // lifetime + persist round-trip.
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Persisted-state writer. Optimizations vs the naive "write on every store
 * change" baseline:
 *
 *   1. Skip when nothing the snapshot cares about changed.  partial-delta
 *      updates only mutate `livePartial` / `liveTranslation`, neither of
 *      which is persisted — so they should never trigger a write. The
 *      previous version churned localStorage at the partial-delta rate
 *      (up to ~20 Hz), and for long meetings the JSON.stringify cost on
 *      a 3000-segment buffer was ~5-20 ms on the main thread per tick.
 *
 *   2. Bound starvation. The debounce keeps resetting while events flow,
 *      so a speaker who never pauses for 800 ms would never persist. Hard
 *      cap at PERSIST_MAX_INTERVAL_MS so the user's history is durable
 *      even mid-monologue.
 */
function makeDebouncedSaver(key: string): (state: CaptionState) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSegmentsRef: CaptionSegment[] | null = null;
  let lastTranslationsRef: Record<string, CaptionTranslation> | null = null;
  let lastSessionStartMs: number | null | undefined = undefined; // sentinel "never seen"
  let lastSessionId: string | null | undefined = undefined;
  let lastSessionEndedAt: number | null | undefined = undefined;
  let lastFlushAt = 0;
  const PERSIST_MAX_INTERVAL_MS = 5_000;

  return (state) => {
    // Reference-equality early-exit: if neither persisted slice changed,
    // there is nothing new to write. partial-delta updates flow through
    // here all day long and they should all return immediately.
    const segmentsChanged = state.segments !== lastSegmentsRef;
    const translationsChanged = state.translations !== lastTranslationsRef;
    const sessionStartChanged = state.sessionStartMs !== lastSessionStartMs;
    const sessionIdChanged = state.sessionId !== lastSessionId;
    const sessionEndedAtChanged = state.sessionEndedAt !== lastSessionEndedAt;
    if (
      !segmentsChanged &&
      !translationsChanged &&
      !sessionStartChanged &&
      !sessionIdChanged &&
      !sessionEndedAtChanged
    ) {
      return;
    }
    lastSegmentsRef = state.segments;
    lastTranslationsRef = state.translations;
    lastSessionStartMs = state.sessionStartMs;
    lastSessionId = state.sessionId;
    lastSessionEndedAt = state.sessionEndedAt;

    const doFlush = () => {
      timer = null;
      lastFlushAt = Date.now();
      try {
        const payload: PersistedState = {
          v: PERSIST_VERSION,
          segments: state.segments,
          translations: state.translations,
          sessionStartMs: state.sessionStartMs,
          sessionId: state.sessionId,
          sessionEndedAt: state.sessionEndedAt,
          savedAt: new Date().toISOString(),
        };
        localStorage.setItem(key, JSON.stringify(payload));
      } catch {
        // QuotaExceeded or unavailable storage — fail silently, in-memory keeps working.
      }
    };

    // Max-interval guard: if it has been a long time since the last
    // flush, write NOW rather than letting the debounce keep extending.
    const sinceLastFlush = Date.now() - lastFlushAt;
    if (lastFlushAt > 0 && sinceLastFlush >= PERSIST_MAX_INTERVAL_MS) {
      if (timer !== null) clearTimeout(timer);
      doFlush();
      return;
    }

    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(doFlush, PERSIST_DEBOUNCE_MS);
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
  const t: CaptionTranslation = {
    sourceSegmentId: event.sourceSegmentId,
    provider: event.provider,
    status: event.status,
    sourceText: event.sourceText,
    targetText: event.targetText,
    sourceLanguage: event.sourceLanguage,
    targetLanguage: event.targetLanguage,
    updatedAt: event.updatedAt,
  };
  if (event.confidence !== undefined) t.confidence = event.confidence;
  return t;
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
  const persistKey = options.persistKey === null ? null : options.persistKey ?? DEFAULT_PERSIST_KEY;

  // Hydrate from localStorage on construction so a page reload preserves the meeting.
  const hydrated =
    persistKey && typeof window !== 'undefined' && typeof localStorage !== 'undefined'
      ? loadPersisted(persistKey)
      : null;
  // restoredFromStorage flips true only when the hydration actually carried
  // segments — an empty/missing persist payload should not surface the
  // restored chip on first run.
  const restoredFromStorage = (hydrated?.segments?.length ?? 0) > 0;

  const store = createStore<CaptionState>((set) => ({
    maxSegments,
    segments: hydrated?.segments ?? [],
    livePartial: null,
    liveTranslation: null,
    translations: hydrated?.translations ?? {},
    sessionStartMs: hydrated?.sessionStartMs ?? null,
    sessionId: hydrated?.sessionId ?? null,
    sessionEndedAt: hydrated?.sessionEndedAt ?? null,
    restoredFromStorage,

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
        // leave their translations behind. Check against the OLD buffer length
        // (state.segments) so we only run when the buffer was already full —
        // avoiding an unnecessary O(n) pass when we're merely filling up.
        const tCount = Object.keys(translations).length;
        if (tCount > segments.length || state.segments.length >= state.maxSegments) {
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

    beginSession: () =>
      set({
        segments: [],
        livePartial: null,
        liveTranslation: null,
        translations: {},
        sessionStartMs: null,
        sessionId: makeSessionId(),
        sessionEndedAt: null,
        restoredFromStorage: false,
      }),

    endSession: () =>
      set((state) => {
        // Only mark when we actually have a session in flight. If beginSession
        // was never called (e.g. user clicks Stop without ever clicking Start
        // — shouldn't happen via UI but defensively safe) the timestamp would
        // be misleading, so guard against it.
        if (state.sessionId === null) return {};
        return { sessionEndedAt: Date.now() };
      }),

    clear: () => {
      set({
        segments: [],
        livePartial: null,
        liveTranslation: null,
        translations: {},
        sessionStartMs: null,
        sessionId: null,
        sessionEndedAt: null,
        restoredFromStorage: false,
      });
      if (persistKey && typeof localStorage !== 'undefined') {
        try {
          localStorage.removeItem(persistKey);
          // Also evict legacy keys so the next mount doesn't resurrect them
          // via the v2-fallback path inside loadPersisted().
          for (const legacy of LEGACY_PERSIST_KEYS) {
            localStorage.removeItem(legacy);
          }
        } catch { /* noop */ }
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
