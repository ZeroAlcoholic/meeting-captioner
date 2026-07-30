import type { TranscriptEvent, TranslationEvent } from '@meeting-audio/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  createCaptionPersistenceController,
  DEFAULT_PERSIST_KEY,
  type HydratedSnapshot,
} from './caption-persistence.js';

export { mergeSnapshots, tailPayload } from './caption-persistence.js';
export type { HydratedSnapshot, PersistedState } from './caption-persistence.js';

/**
 * Which capture configuration produced this session. Persisted so a reload
 * after a crash / accidental tab-close can offer to CONTINUE the same meeting
 * on the same backend, instead of forcing the operator to start over.
 */
export type SessionMode = 'fake' | 'real' | 'gemini' | 'offline' | 'hybrid';

/**
 * Session lifecycle phase. `running`/`paused` mean the meeting was still live
 * (or intentionally paused) the last time state was persisted — i.e. a reload
 * in either phase is a candidate for "continue". `ended` means the operator
 * pressed Stop, so a reload just shows the restored log (export / clear).
 */
export type SessionPhase = 'running' | 'paused' | 'ended';

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
   * Which capture configuration this session is running (or last ran). Persisted
   * so a reload can resume the same backend. Null when no session has started.
   */
  sessionMode: SessionMode | null;
  /**
   * Lifecycle phase of the current/last session. Persisted. `running`/`paused`
   * on hydration ⇒ the meeting was interrupted and can be CONTINUED; `ended` ⇒
   * cleanly stopped. Null when no session has started.
   */
  sessionPhase: SessionPhase | null;
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
   * anchored to the old sessionStartMs. Pass the capture `mode` so a later
   * reload can offer to continue this exact backend.
   */
  beginSession: (mode?: SessionMode) => void;
  /**
   * Update the lifecycle phase (running ⇄ paused, or → ended) without touching
   * the transcript. Persisted, so a reload can tell an interrupted/paused
   * meeting (resumable) from a cleanly-stopped one. No-op if no session begun.
   */
  setSessionPhase: (phase: SessionPhase) => void;
  /**
   * Update which capture/backend the CURRENT session is running on, WITHOUT
   * clearing the transcript. Used by cross-model failover: the operator switches
   * OpenAI⇄Gemini mid-meeting (no `beginSession`, history preserved), and the
   * persisted `sessionMode` must follow so a later crash-Continue resumes the
   * backend actually in use — not the one the session originally started on.
   * No-op if no session has begun.
   */
  setSessionMode: (mode: SessionMode) => void;
  /**
   * Mark the active session as ended without clearing its data. Called by
   * App.tsx on Stop. The data remains visible (and persisted) so the user
   * can still export it after stopping. Also sets sessionPhase = 'ended'.
   */
  endSession: () => void;
  clear: () => void;
  /**
   * Synchronously write the current snapshot to localStorage RIGHT NOW,
   * bypassing the debounce — and, unlike the debounced writer, FOLD the
   * in-flight `livePartial` / `liveTranslation` into the persisted segments so
   * a mid-sentence interruption isn't lost.
   *
   * This is the durability backstop for interruption states the debounced
   * saver cannot cover:
   *   - a hard crash / OS kill / accidental tab-close inside the debounce
   *     window (up to PERSIST_MAX_INTERVAL_MS of finalized segments at risk);
   *   - an utterance that was still partial (never finalized) when the page
   *     went away — that text lives only in `livePartial`, which the debounced
   *     writer intentionally never persists.
   *
   * Called automatically on `pagehide` / `visibilitychange→hidden`, and
   * explicitly by the app on graceful Stop / Pause so the last spoken line is
   * durable the instant capture ends. No-op when persistence is disabled.
   */
  flushNow: () => void;
  /** Enable or disable local transcript retention without changing in-memory captions. */
  setTranscriptRetention: (enabled: boolean) => Promise<void>;
}

export interface CreateCaptionStoreOptions {
  maxSegments?: number;
  /** localStorage key for autosave. Pass null to disable persistence. */
  persistKey?: string | null;
  /** Defaults off unless a custom persistKey explicitly opts in. */
  persistenceEnabled?: boolean;
}

// Buffer cap. IndexedDB is the primary durable store (async, multi-MB headroom),
// so a single long session can hold far more than the old localStorage-bound
// 3000. At ~200 bytes/segment, 20000 ≈ 4 MB JSON — comfortable for IDB and ~11
// hours of meeting at typical conversational pace. localStorage only ever holds
// a bounded TAIL (see LS_TAIL_SEGMENTS) as the synchronous crash-safety net,
// because IndexedDB cannot be written synchronously on pagehide.
const DEFAULT_MAX_SEGMENTS = 20000;
// Keys whose page-exit listeners are already registered. Prevents stacking a
// fresh pagehide/visibilitychange listener every time a store is (re)created for
// the same key — e.g. under Vite HMR or repeated construction in tests — which
// would leak listeners and let a stale store's flush run on tab-hide.
const lifecycleBoundKeys = new Set<string>();

function makeSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for ancient runtimes / jsdom edge cases. Not cryptographically
  // strong, but sessionId only needs to be unique within this tab's
  // lifetime + persist round-trip.
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

/** Apply a hydrated snapshot (e.g. merged IDB+localStorage) onto the store. */
function applyHydratedSnapshot(store: CaptionStore, snap: HydratedSnapshot): void {
  store.setState({
    segments: snap.segments,
    translations: snap.translations,
    sessionStartMs: snap.sessionStartMs,
    sessionId: snap.sessionId,
    sessionEndedAt: snap.sessionEndedAt,
    sessionMode: snap.sessionMode,
    sessionPhase: snap.sessionPhase,
    restoredFromStorage: snap.segments.length > 0,
  });
}

export function createCaptionStore(options: CreateCaptionStoreOptions = {}): CaptionStore {
  const maxSegments = options.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  const persistenceKey =
    options.persistKey === null ? null : (options.persistKey ?? DEFAULT_PERSIST_KEY);
  const persistenceEnabled =
    options.persistenceEnabled ?? (options.persistKey !== undefined && options.persistKey !== null);
  const persistence = createCaptionPersistenceController({
    enabled: persistenceEnabled,
    key: persistenceKey,
    maxSegments,
  });
  const hydrated = persistence.loadSync();

  // restoredFromStorage flips true only when the hydration actually carried
  // segments — an empty/missing persist payload should not surface the
  // restored chip on first run.
  const restoredFromStorage = (hydrated?.segments?.length ?? 0) > 0;

  // Set true the moment the user starts/clears/continues a session in THIS tab
  // (beginSession, clear, setSessionPhase, or the first transcript event). The
  // async IndexedDB hydration below must NOT clobber a session that has already
  // become live before the IDB read resolves.
  let sessionTouched = false;

  const store = createStore<CaptionState>((set, get) => ({
    maxSegments,
    segments: hydrated?.segments ?? [],
    livePartial: null,
    liveTranslation: null,
    translations: hydrated?.translations ?? {},
    sessionStartMs: hydrated?.sessionStartMs ?? null,
    sessionId: hydrated?.sessionId ?? null,
    sessionEndedAt: hydrated?.sessionEndedAt ?? null,
    sessionMode: hydrated?.sessionMode ?? null,
    sessionPhase: hydrated?.sessionPhase ?? null,
    restoredFromStorage,

    applyTranscript: (event) =>
      set((state) => {
        // A real transcript event means a live session is in progress (covers
        // the Continue/Resume path, which doesn't call beginSession) — block any
        // still-pending async IDB hydrate from clobbering it.
        sessionTouched = true;
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
        if (state.livePartial && state.livePartial.segmentId === event.sourceSegmentId) {
          return { liveTranslation: eventToTranslation(event) };
        }
        return {
          translations: {
            ...state.translations,
            [event.sourceSegmentId]: eventToTranslation(event),
          },
        };
      }),

    beginSession: (mode) => {
      sessionTouched = true;
      set({
        segments: [],
        livePartial: null,
        liveTranslation: null,
        translations: {},
        sessionStartMs: null,
        sessionId: makeSessionId(),
        sessionEndedAt: null,
        sessionMode: mode ?? null,
        sessionPhase: 'running',
        restoredFromStorage: false,
      });
    },

    setSessionPhase: (phase) =>
      set((state) => {
        // Pause/Resume/Continue all flow through here — mark the session live so
        // a late async IDB hydrate can't revert the phase or resurrect the chip.
        sessionTouched = true;
        if (state.sessionId === null) return {};
        if (state.sessionPhase === phase) return {};
        return {
          sessionPhase: phase,
          ...(phase === 'ended' && state.sessionEndedAt === null
            ? { sessionEndedAt: Date.now() }
            : {}),
        };
      }),

    setSessionMode: (mode) =>
      set((state) => {
        // Mark the session live so a late async IDB hydrate can't revert it.
        sessionTouched = true;
        if (state.sessionId === null) return {};
        if (state.sessionMode === mode) return {};
        return { sessionMode: mode };
      }),

    endSession: () =>
      set((state) => {
        // Only mark when we actually have a session in flight. If beginSession
        // was never called (e.g. user clicks Stop without ever clicking Start
        // — shouldn't happen via UI but defensively safe) the timestamp would
        // be misleading, so guard against it.
        if (state.sessionId === null) return {};
        return { sessionEndedAt: Date.now(), sessionPhase: 'ended' };
      }),

    clear: () => {
      sessionTouched = true;
      set({
        segments: [],
        livePartial: null,
        liveTranslation: null,
        translations: {},
        sessionStartMs: null,
        sessionId: null,
        sessionEndedAt: null,
        sessionMode: null,
        sessionPhase: null,
        restoredFromStorage: false,
      });
      // Storage cleanup is serialized after any older save, so cleared data
      // cannot be resurrected by an in-flight IndexedDB transaction.
      void persistence.clear();
    },

    flushNow: () => {
      persistence.flush(get());
    },

    setTranscriptRetention: async (enabled) => {
      await persistence.setEnabled(enabled, get());
    },
  }));

  // Async IndexedDB hydration. localStorage gave us an instant (tail) snapshot
  // above; IDB holds the FULL history, which may be larger and/or newer. Merge
  // it in once it resolves — UNLESS the user already started/cleared a session
  // in this tab (sessionTouched), in which case a late hydrate must not clobber
  // the live session.
  void persistence.loadAsync().then((record) => {
    if (!record || sessionTouched || record.segments.length === 0) return;
    applyHydratedSnapshot(store, record);
  });

  store.subscribe((state) => persistence.save(state));

  // Emergency synchronous flush before the page goes away. The controller is
  // a no-op while retention is disabled, so listeners can remain stable across
  // opt-in transitions.
  if (persistenceKey && typeof window !== 'undefined' && !lifecycleBoundKeys.has(persistenceKey)) {
    lifecycleBoundKeys.add(persistenceKey);
    const flushOnExit = () => {
      try {
        store.getState().flushNow();
      } catch {
        // Never block teardown.
      }
    };
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', flushOnExit);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushOnExit();
      });
    }
  }

  return store;
}
