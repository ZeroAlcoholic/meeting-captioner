import type { TranscriptEvent, TranslationEvent } from '@meeting-audio/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { idbClear, idbLoad, idbSave } from './idb-persistence.js';

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
}

export interface CreateCaptionStoreOptions {
  maxSegments?: number;
  /** localStorage key for autosave. Pass null to disable persistence (e.g. tests). */
  persistKey?: string | null;
}

// Buffer cap. IndexedDB is the primary durable store (async, multi-MB headroom),
// so a single long session can hold far more than the old localStorage-bound
// 3000. At ~200 bytes/segment, 20000 ≈ 4 MB JSON — comfortable for IDB and ~11
// hours of meeting at typical conversational pace. localStorage only ever holds
// a bounded TAIL (see LS_TAIL_SEGMENTS) as the synchronous crash-safety net,
// because IndexedDB cannot be written synchronously on pagehide.
const DEFAULT_MAX_SEGMENTS = 20000;
// Newest-N segments mirrored into localStorage for the synchronous emergency
// flush + instant first paint. ~2000 × ~200 B ≈ 400 KB, safely under the 5 MB
// localStorage quota even with translations. The full history lives in IDB.
const LS_TAIL_SEGMENTS = 2000;
const PERSIST_DEBOUNCE_MS = 800;
const PERSIST_VERSION = 4;
const DEFAULT_PERSIST_KEY = 'meeting-audio:captions:v4';
// Legacy keys we still attempt to read for backward-compat. The current
// writer only ever writes to DEFAULT_PERSIST_KEY; once the user re-saves
// after migration the legacy entry can be deleted.
const LEGACY_PERSIST_KEYS = ['meeting-audio:captions:v3', 'meeting-audio:captions:v2'] as const;
const ACCEPTED_PERSIST_VERSIONS = new Set([2, 3, 4]);

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
  /** ms epoch parsed from `savedAt` — used to pick the newer of IDB vs localStorage. */
  savedAtMs: number;
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
    // Older payloads (v2/v3) had no phase. Treat them as 'ended' so a reload of
    // pre-upgrade data shows the restored chip (export/clear) but does NOT pop a
    // misleading "continue" prompt for a session that may have ended long ago —
    // legacy data has no reliable signal that it was genuinely still live.
    sessionPhase: parsed.sessionPhase ?? 'ended',
    savedAtMs: Number.isFinite(savedAtMs) ? savedAtMs : 0,
  };
}

function decodePersisted(raw: string): HydratedSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as PersistedState;
    // v2/v3 ⇢ v4: missing session fields default to null. The restoredFromStorage
    // flag (set by the caller) is what makes the chip appear, so legacy data
    // lands in the same "you have restored captions" UX as current data.
    if (!ACCEPTED_PERSIST_VERSIONS.has(parsed.v)) return null;
    return snapshotFromPersisted(parsed);
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

/**
 * Build the on-disk snapshot from live store state.
 *
 * When `includeLive` is true (the crash-safety / flushNow path) the in-flight
 * `livePartial` is appended as a provisional segment and its `liveTranslation`
 * folded into the translations map, keyed by the partial's id — so a sentence
 * that was still being spoken when the page went away survives the reload.
 * The debounced writer passes `false`: persisting the 20 Hz partial stream on
 * every tick is exactly the churn the live/final store split exists to avoid.
 */
function buildPersistPayload(state: CaptionState, includeLive: boolean): PersistedState {
  let segments = state.segments;
  let translations = state.translations;
  if (includeLive && state.livePartial) {
    const live = state.livePartial;
    // Dedupe defensively: if the partial already landed in segments[] (race
    // with a finalize), don't double it.
    if (!segments.some((s) => s.segmentId === live.segmentId)) {
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

/**
 * Bound a payload to its newest-N segments for the localStorage tier. The full
 * history lives in IndexedDB; localStorage is only the synchronous crash net,
 * which must stay well under the ~5 MB quota. Translations are pruned to the
 * retained segment ids so the tail stays self-consistent.
 */
export function tailPayload(full: PersistedState, tail: number): PersistedState {
  if (full.segments.length <= tail) return full;
  const segments = full.segments.slice(full.segments.length - tail);
  const keep = new Set(segments.map((s) => s.segmentId));
  const translations: Record<string, CaptionTranslation> = {};
  for (const id of keep) {
    const t = full.translations[id];
    if (t) translations[id] = t;
  }
  return { ...full, segments, translations };
}

/**
 * Merge two persisted snapshots (e.g. localStorage tail + IndexedDB full) into
 * one. The newer `savedAtMs` wins as the base for the session-scalar fields and
 * ordering; any segments the OTHER snapshot has but the base lacks are unioned
 * in (the crash case: the sync localStorage flush captured the final/in-flight
 * line AFTER IDB's last debounced write). Segments are re-sorted by startMs and
 * capped to maxSegments.
 */
export function mergeSnapshots(
  a: HydratedSnapshot,
  b: HydratedSnapshot,
  maxSegments: number,
): HydratedSnapshot {
  const base = a.savedAtMs >= b.savedAtMs ? a : b;
  const other = base === a ? b : a;
  const byId = new Map<string, CaptionSegment>();
  for (const s of base.segments) byId.set(s.segmentId, s);
  for (const s of other.segments) if (!byId.has(s.segmentId)) byId.set(s.segmentId, s);
  let segments = Array.from(byId.values()).sort((x, y) => x.startMs - y.startMs);
  if (segments.length > maxSegments) segments = segments.slice(segments.length - maxSegments);
  const keep = new Set(segments.map((s) => s.segmentId));
  const translations: Record<string, CaptionTranslation> = {};
  for (const [id, t] of Object.entries({ ...other.translations, ...base.translations })) {
    if (keep.has(id)) translations[id] = t;
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

// Keys whose page-exit listeners are already registered. Prevents stacking a
// fresh pagehide/visibilitychange listener every time a store is (re)created for
// the same key — e.g. under Vite HMR or repeated construction in tests — which
// would leak listeners and let a stale store's flush run on tab-hide.
const lifecycleBoundKeys = new Set<string>();

let persistWriteWarned = false;
/**
 * Synchronous localStorage write of the crash-safety TAIL. The full history is
 * written to IndexedDB separately (async). `payload` is expected to already be
 * tail-bounded by the caller via tailPayload().
 */
function writeSnapshot(key: string, payload: PersistedState): void {
  try {
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (err) {
    // QuotaExceeded or unavailable storage — in-memory keeps working, so this
    // never blocks captions. But a silently-failing autosave means a crash
    // would lose the meeting with no warning, which violates "no silent
    // failures" — surface it once (subsequent writes stay quiet to avoid log
    // spam at the debounce / partial rate).
    if (!persistWriteWarned) {
      persistWriteWarned = true;
      const reason = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(
        `[caption-store] transcript autosave failed (${reason}). The meeting ` +
          `stays in memory but will NOT survive a reload — export to a file to keep it.`,
      );
    }
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
function makeDebouncedSaver(
  key: string,
  scheduleIdbSave: (full: PersistedState) => void,
): (state: CaptionState) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSegmentsRef: CaptionSegment[] | null = null;
  let lastTranslationsRef: Record<string, CaptionTranslation> | null = null;
  let lastSessionStartMs: number | null | undefined = undefined; // sentinel "never seen"
  let lastSessionId: string | null | undefined = undefined;
  let lastSessionEndedAt: number | null | undefined = undefined;
  let lastSessionMode: SessionMode | null | undefined = undefined;
  let lastSessionPhase: SessionPhase | null | undefined = undefined;
  let lastFlushAt = 0;
  const PERSIST_MAX_INTERVAL_MS = 5_000;

  return (state) => {
    // Reference-equality early-exit: if no persisted slice changed, there is
    // nothing new to write. partial-delta updates flow through here all day
    // long and they should all return immediately.
    const changed =
      state.segments !== lastSegmentsRef ||
      state.translations !== lastTranslationsRef ||
      state.sessionStartMs !== lastSessionStartMs ||
      state.sessionId !== lastSessionId ||
      state.sessionEndedAt !== lastSessionEndedAt ||
      state.sessionMode !== lastSessionMode ||
      state.sessionPhase !== lastSessionPhase;
    if (!changed) return;
    lastSegmentsRef = state.segments;
    lastTranslationsRef = state.translations;
    lastSessionStartMs = state.sessionStartMs;
    lastSessionId = state.sessionId;
    lastSessionEndedAt = state.sessionEndedAt;
    lastSessionMode = state.sessionMode;
    lastSessionPhase = state.sessionPhase;

    const doFlush = () => {
      timer = null;
      lastFlushAt = Date.now();
      const full = buildPersistPayload(state, false);
      // Full history → IndexedDB (async, multi-MB headroom; gated + throttled +
      // serialized by scheduleIdbSave). Bounded tail → localStorage (sync crash
      // net + fast first paint).
      scheduleIdbSave(full);
      writeSnapshot(key, tailPayload(full, LS_TAIL_SEGMENTS));
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

  // Set true the moment the user starts/clears/continues a session in THIS tab
  // (beginSession, clear, setSessionPhase, or the first transcript event). The
  // async IndexedDB hydration below must NOT clobber a session that has already
  // become live before the IDB read resolves.
  let sessionTouched = false;

  // ── IndexedDB write gating ────────────────────────────────────────────────
  // `idbHydrated` is false only while the initial async idbLoad is in flight for
  // the default-key store. Until it resolves we must NOT write the (possibly
  // localStorage-tail-only) in-memory state back to IDB, or we'd overwrite the
  // full history we're about to merge in. A freshly-touched session is exempt —
  // overwriting old data with a new session is intended.
  let idbHydrated = !(persistKey === DEFAULT_PERSIST_KEY && typeof indexedDB !== 'undefined');
  let lastIdbSaveAt = 0;
  // Serialize every IDB mutation through one promise chain so clear()'s delete
  // can never race (and lose to) a still-in-flight save — and overlapping
  // transactions don't interleave.
  let idbChain: Promise<void> = Promise.resolve();
  // Coarser cadence than the localStorage tail: the sync LS tail is the
  // crash net, so the full-history IDB write can be throttled to bound the
  // structured-clone cost on long meetings.
  const IDB_SAVE_MIN_INTERVAL_MS = 8_000;

  const scheduleIdbSave = (full: PersistedState): void => {
    if (!persistKey) return;
    if (!idbHydrated && !sessionTouched) return; // don't clobber un-hydrated full history
    const now = Date.now();
    if (lastIdbSaveAt !== 0 && now - lastIdbSaveAt < IDB_SAVE_MIN_INTERVAL_MS) return;
    lastIdbSaveAt = now;
    idbChain = idbChain.then(() => idbSave(full)).catch(() => {});
  };
  const scheduleIdbClear = (): void => {
    idbChain = idbChain.then(() => idbClear()).catch(() => {});
  };

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
          ...(phase === 'ended' && state.sessionEndedAt === null ? { sessionEndedAt: Date.now() } : {}),
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
      if (persistKey && typeof localStorage !== 'undefined') {
        try {
          localStorage.removeItem(persistKey);
          // Also evict legacy keys so the next mount doesn't resurrect them
          // via the legacy-fallback path inside loadPersisted().
          for (const legacy of LEGACY_PERSIST_KEYS) {
            localStorage.removeItem(legacy);
          }
        } catch { /* noop */ }
      }
      // Full history lives in IndexedDB — evict it too. Routed through the same
      // serialized chain as saves so a still-in-flight idbSave (e.g. from a
      // Stop→flushNow a moment earlier) can't commit AFTER this delete and
      // resurrect the cleared meeting.
      scheduleIdbClear();
    },

    flushNow: () => {
      if (!persistKey || typeof localStorage === 'undefined') return;
      const full = buildPersistPayload(get(), true);
      // Sync tail → localStorage ONLY. This path fires on every pagehide AND
      // visibilitychange→hidden (i.e. every tab switch), so it must stay cheap
      // and must NOT idbSave: an IDB write here would (a) re-clone the full
      // history on every tab switch, and (b) during the pre-hydration window
      // overwrite the full IDB history with the localStorage-tail-only state.
      // The periodic debounced saver owns IDB; the LS tail (incl. the in-flight
      // line) is merged back over IDB on the next load.
      writeSnapshot(persistKey, tailPayload(full, LS_TAIL_SEGMENTS));
    },
  }));

  // Async IndexedDB hydration. localStorage gave us an instant (tail) snapshot
  // above; IDB holds the FULL history, which may be larger and/or newer. Merge
  // it in once it resolves — UNLESS the user already started/cleared a session
  // in this tab (sessionTouched), in which case a late hydrate must not clobber
  // the live session.
  if (persistKey === DEFAULT_PERSIST_KEY && typeof indexedDB !== 'undefined') {
    void idbLoad<PersistedState>().then((record) => {
      // Whatever the outcome, the initial read has settled: open the IDB-write
      // gate so the debounced saver can persist from here on.
      idbHydrated = true;
      if (!record || sessionTouched) return;
      const idb = snapshotFromPersisted(record);
      if (idb.segments.length === 0) return;
      const current = store.getState();
      // Re-derive a snapshot from the (already-hydrated) localStorage state so
      // the merge keeps any in-flight tail the sync flush captured. Its savedAt
      // is the construction-time localStorage timestamp.
      const lsSnap: HydratedSnapshot = {
        segments: current.segments,
        translations: current.translations,
        sessionStartMs: current.sessionStartMs,
        sessionId: current.sessionId,
        sessionEndedAt: current.sessionEndedAt,
        sessionMode: current.sessionMode,
        sessionPhase: current.sessionPhase,
        savedAtMs: hydrated?.savedAtMs ?? 0,
      };
      const merged = mergeSnapshots(lsSnap, idb, maxSegments);
      // Guard again — the IDB read is async; bail if a session began meanwhile.
      if (sessionTouched) return;
      applyHydratedSnapshot(store, merged);
    });
  }

  // Subscribe AFTER hydration so we don't immediately overwrite with empty state.
  if (persistKey && typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    const save = makeDebouncedSaver(persistKey, scheduleIdbSave);
    store.subscribe((state) => save(state));

    // Emergency synchronous flush before the page goes away. The debounced
    // saver can leave up to PERSIST_MAX_INTERVAL_MS of finalized segments — and
    // the entire in-flight utterance — unwritten; flushNow() folds both onto
    // disk in one synchronous setItem. `pagehide` is the reliable unload signal
    // (fires on real navigation away AND bfcache freeze); `visibilitychange→
    // hidden` covers mobile / tab-discard cases where pagehide may not fire.
    if (!lifecycleBoundKeys.has(persistKey)) {
      lifecycleBoundKeys.add(persistKey);
      const flushOnExit = () => {
        try { store.getState().flushNow(); } catch { /* never block teardown */ }
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
  }

  return store;
}
