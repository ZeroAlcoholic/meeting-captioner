import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore } from '../settings/use-settings-store.js';
import { useCaptionStore } from '../store/use-caption-store.js';
import { captionStore } from '../store/use-caption-store.js';
import {
  formatElapsedFromStart,
  groupParagraphsForSide,
  type Paragraph,
} from './paragraph-grouping.js';
import styles from './CaptionBoard.module.css';

// ─── Export ──────────────────────────────────────────────────────────────────
function downloadTranscript(): void {
  const { segments, translations, sessionStartMs } = captionStore.getState();
  if (segments.length === 0) return;
  // Anchor for elapsed-time labels: the FIRST (smallest startMs) segment.
  // We can't use sessionStartMs (which is Date.now() at first event) because
  // providers emit startMs in their own time origin (fake replay = relative).
  const anchorMs = segments[0]?.startMs ?? 0;

  // Group EN and ZH independently — same as on-screen.
  const en = groupParagraphsForSide({
    segments,
    translations,
    side: 'en',
    accessor: (s, t) => {
      // Pick the EN side: if a translation exists with English target, use it;
      // otherwise the segment text is presumed English (standard mic→en path).
      if (t && t.targetLanguage.startsWith('en')) return t.targetText;
      if (t && t.sourceLanguage.startsWith('en')) return t.sourceText;
      return s.text;
    },
  });
  const zh = groupParagraphsForSide({
    segments,
    translations,
    side: 'zh',
    accessor: (s, t) => {
      if (t && t.targetLanguage.startsWith('zh')) return t.targetText;
      if (t && t.sourceLanguage.startsWith('zh')) return t.sourceText;
      return s.text;
    },
  });

  const lines: string[] = [];
  lines.push(`# Meeting transcript`);
  if (sessionStartMs !== null) {
    lines.push(`# Session started: ${new Date(sessionStartMs).toISOString()}`);
  }
  lines.push('');

  // Interleave by start time so the export reads chronologically.
  const merged: Array<{ side: 'en' | 'zh'; p: Paragraph }> = [
    ...en.map((p) => ({ side: 'en' as const, p })),
    ...zh.map((p) => ({ side: 'zh' as const, p })),
  ].sort((a, b) => a.p.startMs - b.p.startMs);

  for (const { side, p } of merged) {
    const ts = formatElapsedFromStart(p.startMs, anchorMs);
    const tag = side === 'zh' ? '[zh]' : '[en]';
    lines.push(`${ts} ${tag} ${p.text}`);
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `meeting-transcript-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Pick the live segment by latest startMs. We can't blindly use `segments.at(-1)`
 * because `upsertSorted` inserts revised segments by startMs, so a late revision
 * with an earlier startMs could push the wrong one to the end of the array.
 *
 * Returns the segment whose startMs is greatest. If multiple segments share the
 * max startMs (rare, partial+final at same instant), prefer the more recent
 * status (partial > revised > final reflects "most recently emitted").
 */
function pickLiveSegment<T extends { segmentId: string; startMs: number; status: string }>(
  segments: readonly T[],
): T | undefined {
  if (segments.length === 0) return undefined;
  let best = segments[0]!;
  for (let i = 1; i < segments.length; i++) {
    const s = segments[i]!;
    if (s.startMs > best.startMs) best = s;
  }
  return best;
}

// ─── Component ───────────────────────────────────────────────────────────────
export function CaptionBoard() {
  const segments = useCaptionStore((s) => s.segments);
  const translations = useCaptionStore((s) => s.translations);
  const langPair = useSettingsStore((s) => s.langPair);

  // Elapsed-time anchor for history labels — derived from the first (oldest)
  // segment in the buffer. Robust against providers that emit relative-time
  // startMs (fake replay) vs wall-clock startMs (OpenAI Realtime).
  const anchorMs = segments[0]?.startMs ?? 0;

  const boardRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  // autoPin pauses when user manually scrolls up; resumes when they scroll back to bottom.
  const [autoPin, setAutoPin] = useState(true);
  // Count of new finalized segments arriving while scroll is paused (powers the pill).
  const [pendingNew, setPendingNew] = useState(0);
  // Snapshot of how many segments existed when the user paused scrolling.
  const segmentsAtPauseRef = useRef<number>(0);
  const [confirmingClear, setConfirmingClear] = useState(false);
  // Mirror in a ref so a rapid second click within the same render cycle reads
  // the LATEST value (React batches state updates; reading from the closure
  // would incorrectly see false on the second synchronous click).
  const confirmingClearRef = useRef(false);
  const confirmTimeoutRef = useRef<number | null>(null);

  // ─── Hotkey-driven UI state ───
  // Space: freeze the live-caption area on whatever was on screen at the
  // moment of pressing — useful for "wait, what did they just say?" moments.
  // History keeps receiving new segments; only the live area is paused.
  const [frozen, setFrozen] = useState(false);
  // `.`: force-show the auto-hidden Export/Clear chrome without needing a hover
  // (helps for projector/touch use where mouse hover isn't available).
  const [forceShowChrome, setForceShowChrome] = useState(false);
  // `f`: fullscreen the board element. Tracked from fullscreenchange so the
  // state stays in sync when the user exits via Esc.
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Snapshot of what was on the live caption area at the moment we froze.
  // Read while `frozen === true`; ignored otherwise.
  const frozenSnapshotRef = useRef<{
    target: string;
    source: string;
    showHint: boolean;
    hintText: string;
  } | null>(null);

  // Live segment = the most recent partial/revised/final by startMs.
  const liveSegment = pickLiveSegment(segments);
  const historySegments = useMemo(
    () => (liveSegment ? segments.filter((s) => s.segmentId !== liveSegment.segmentId) : segments),
    [segments, liveSegment],
  );

  const isZhTarget = langPair === 'en→zh-TW';

  // Independent paragraph streams. Accessors map seg.text/translation.target to
  // each side's actual language, regardless of which side is "source" vs "target".
  const zhParagraphs = useMemo(
    () =>
      groupParagraphsForSide({
        segments: historySegments,
        translations,
        side: 'zh',
        accessor: (s, t) =>
          isZhTarget ? t?.targetText ?? '' : s.text /* zh-TW→en: source IS the Chinese */,
      }),
    [historySegments, translations, isZhTarget],
  );
  const enParagraphs = useMemo(
    () =>
      groupParagraphsForSide({
        segments: historySegments,
        translations,
        side: 'en',
        accessor: (s, t) =>
          isZhTarget ? s.text /* en→zh-TW: source IS the English */ : t?.targetText ?? '',
      }),
    [historySegments, translations, isZhTarget],
  );

  // Primary side = translation target (the bigger column on the left).
  const primaryParagraphs = isZhTarget ? zhParagraphs : enParagraphs;
  const secondaryParagraphs = isZhTarget ? enParagraphs : zhParagraphs;
  const primarySide: 'zh' | 'en' = isZhTarget ? 'zh' : 'en';
  const secondarySide: 'zh' | 'en' = isZhTarget ? 'en' : 'zh';

  // ─── Scroll bookkeeping ───
  useEffect(() => {
    const el = historyRef.current;
    if (!el) return;
    const onScroll = () => {
      const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nowPinned = fromBottom < 32;
      setAutoPin((wasPinned) => {
        if (wasPinned && !nowPinned) {
          // user just scrolled up — snapshot baseline for "new since pause"
          segmentsAtPauseRef.current = segments.length;
          setPendingNew(0);
        } else if (!wasPinned && nowPinned) {
          // resumed at bottom — clear pending count
          setPendingNew(0);
        }
        return nowPinned;
      });
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [segments.length]);

  // Track new segments while paused.
  useEffect(() => {
    if (autoPin) return;
    const delta = segments.length - segmentsAtPauseRef.current;
    if (delta > 0) setPendingNew(delta);
  }, [segments.length, autoPin]);

  useLayoutEffect(() => {
    if (!autoPin) return;
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [primaryParagraphs, secondaryParagraphs, autoPin]);

  // ─── Clear with inline confirm (no native confirm() dialog) ───
  function onClearClick(): void {
    if (!confirmingClearRef.current) {
      confirmingClearRef.current = true;
      setConfirmingClear(true);
      if (confirmTimeoutRef.current !== null) window.clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = window.setTimeout(() => {
        confirmingClearRef.current = false;
        setConfirmingClear(false);
        confirmTimeoutRef.current = null;
      }, 3000);
      return;
    }
    if (confirmTimeoutRef.current !== null) {
      window.clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }
    captionStore.getState().clear();
    confirmingClearRef.current = false;
    setConfirmingClear(false);
  }

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (confirmTimeoutRef.current !== null) window.clearTimeout(confirmTimeoutRef.current);
    };
  }, []);

  function jumpToLatest(): void {
    const el = historyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAutoPin(true);
    setPendingNew(0);
  }

  // ─── Hotkey listener (document-scoped, ignores form inputs) ───
  // Bindings:
  //   f       — toggle fullscreen on the board element
  //   Space   — toggle freeze of the live caption area (history keeps flowing)
  //   .       — toggle persistent visibility of Export/Clear chrome
  // Form inputs (input/textarea/select/contentEditable) are exempted so typing
  // in the settings panel doesn't trigger meeting-control hotkeys.
  useEffect(() => {
    function isTypingTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (t.isContentEditable) return true;
      return false;
    }
    function onKey(e: KeyboardEvent): void {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        const el = boardRef.current;
        if (!el) return;
        if (document.fullscreenElement === el) {
          void document.exitFullscreen?.();
        } else {
          void el.requestFullscreen?.();
        }
      } else if (e.key === ' ') {
        e.preventDefault();
        setFrozen((prev) => !prev);
      } else if (e.key === '.') {
        e.preventDefault();
        setForceShowChrome((prev) => !prev);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Track real fullscreen state — including exit-via-Esc which doesn't
  // route through our keydown handler.
  useEffect(() => {
    function onFsChange(): void {
      setIsFullscreen(document.fullscreenElement === boardRef.current);
    }
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // ─── Live caption: freeze on previous final while a new partial is in progress ───
  const lastFinalSegment = useMemo(
    () => historySegments.at(-1),
    [historySegments],
  );

  const liveIsPartial = !!liveSegment && liveSegment.status !== 'final';
  // When a partial is mid-flight, the new translation hasn't arrived yet.
  // Freeze BOTH target and source on the previous final so they stay in sync,
  // and surface the partial as a small "translating · …" hint underneath.
  // When the live segment itself is final (e.g., short utterance that finalized
  // before any partial), show its own translation.
  const displayedLiveTarget =
    liveIsPartial && lastFinalSegment
      ? translations[lastFinalSegment.segmentId]?.targetText
      : liveSegment
        ? translations[liveSegment.segmentId]?.targetText
        : undefined;
  const displayedLiveSource =
    liveIsPartial && lastFinalSegment
      ? lastFinalSegment.text
      : liveSegment?.text;

  if (!liveSegment) {
    return (
      <div className={styles.empty} data-lang-pair={langPair} data-testid="caption-empty">
        <p>Waiting for captions…</p>
      </div>
    );
  }

  const partialPreview =
    liveIsPartial && liveSegment.text.length > 56
      ? liveSegment.text.slice(0, 54) + '…'
      : liveSegment?.text ?? '';

  // Freeze snapshot bookkeeping: when `frozen` flips on, capture exactly what
  // is currently on the live area. When it flips off, drop the snapshot so
  // the live area resumes tracking the latest segment. Snapshots use refs to
  // avoid an extra render cycle and to remain stable while frozen is true.
  if (frozen && frozenSnapshotRef.current === null) {
    frozenSnapshotRef.current = {
      target: displayedLiveTarget ?? '…',
      source: displayedLiveSource ?? '',
      showHint: liveIsPartial && !!lastFinalSegment,
      hintText: partialPreview,
    };
  } else if (!frozen && frozenSnapshotRef.current !== null) {
    frozenSnapshotRef.current = null;
  }
  const renderedTarget = frozen
    ? frozenSnapshotRef.current?.target ?? '…'
    : displayedLiveTarget ?? '…';
  const renderedSource = frozen
    ? frozenSnapshotRef.current?.source ?? ''
    : displayedLiveSource ?? '';
  const renderedShowHint = frozen
    ? frozenSnapshotRef.current?.showHint ?? false
    : liveIsPartial && !!lastFinalSegment;
  const renderedHintText = frozen
    ? frozenSnapshotRef.current?.hintText ?? ''
    : partialPreview;

  return (
    <div
      ref={boardRef}
      className={styles.board}
      data-lang-pair={langPair}
      data-frozen={frozen || undefined}
      data-force-chrome={forceShowChrome || undefined}
      data-fullscreen={isFullscreen || undefined}
    >
      <div className={styles.boardActions}>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={downloadTranscript}
          title="Download full transcript as .txt"
          data-testid="export-transcript"
        >
          ⬇ Export
        </button>
        <button
          type="button"
          className={`${styles.actionBtn} ${confirmingClear ? styles.actionBtnDanger : ''}`}
          onClick={onClearClick}
          title={confirmingClear ? 'Click again within 3s to confirm' : 'Clear all captions'}
          data-testid="clear-transcript"
          data-confirming={confirmingClear || undefined}
        >
          {confirmingClear ? '✕ Confirm clear' : '✕ Clear'}
        </button>
      </div>

      <div ref={historyRef} className={styles.history} data-testid="caption-history">
        <div className={styles.historyCol} data-side={primarySide} data-role="primary">
          {primaryParagraphs.map((p) => (
            <div key={`p-${p.id}`} className={styles.historyRow}>
              <span className={styles.historyTime}>
                {formatElapsedFromStart(p.startMs, anchorMs)}
              </span>
              <p
                className={`${styles.historyText} ${styles.historyTextPrimary}`}
                data-conf={p.confLow ? 'low' : 'high'}
              >
                {p.text}
              </p>
            </div>
          ))}
        </div>
        <div className={styles.historyCol} data-side={secondarySide} data-role="secondary">
          {secondaryParagraphs.map((p) => (
            <div key={`s-${p.id}`} className={styles.historyRow}>
              <span className={styles.historyTime}>
                {formatElapsedFromStart(p.startMs, anchorMs)}
              </span>
              <p
                className={`${styles.historyText} ${styles.historyTextSecondary}`}
                data-conf={p.confLow ? 'low' : 'high'}
              >
                {p.text}
              </p>
            </div>
          ))}
        </div>
      </div>

      {!autoPin && pendingNew > 0 && (
        <button
          type="button"
          className={styles.pill}
          onClick={jumpToLatest}
          data-testid="jump-to-latest"
        >
          ↓ {pendingNew} new
        </button>
      )}

      <div
        className={styles.current}
        data-testid="caption-current"
        data-status={liveSegment.status}
      >
        <div
          className={styles.target}
          data-testid="caption-target"
          data-status={frozen ? 'paused' : liveIsPartial ? 'frozen' : 'final'}
        >
          {renderedTarget}
        </div>
        <div className={styles.source} data-testid="caption-source">
          {renderedSource}
          {!frozen && liveIsPartial && !lastFinalSegment && (
            <span className={styles.cursor} aria-hidden="true" />
          )}
        </div>
        {renderedShowHint && (
          <span className={styles.translatingHint} data-testid="translating-hint">
            translating · {renderedHintText}
          </span>
        )}
        {frozen && (
          <span className={styles.pausedBadge} data-testid="paused-badge">
            ⏸ paused · press space to resume
          </span>
        )}
      </div>
    </div>
  );
}
