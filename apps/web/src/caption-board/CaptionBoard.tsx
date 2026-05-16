import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSettingsStore } from '../settings/use-settings-store.js';
import { useCaptionStore, captionStore } from '../store/use-caption-store.js';
import type { CaptionSegment, CaptionTranslation } from '../store/caption-store.js';
import type { LangPair } from '../settings/settings-store.js';
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
  const anchorMs = segments[0]?.startMs ?? 0;

  const en = groupParagraphsForSide({
    segments,
    translations,
    side: 'en',
    accessor: (s, t) => {
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

// ─── HistoryStream ───────────────────────────────────────────────────────────
// Subscribes ONLY to finalized segments + translations. Its store snapshot
// changes once per finalized segment (≈ once per spoken sentence) — never on
// per-character partial deltas. Result: paragraph grouping is recomputed at
// sentence rate, not at 30+ Hz.

interface HistoryStreamProps {
  langPair: LangPair;
}

const HistoryStream = memo(function HistoryStream({ langPair }: HistoryStreamProps) {
  const segments = useCaptionStore((s) => s.segments);
  const translations = useCaptionStore((s) => s.translations);
  const bilingual = useSettingsStore((s) => s.includeSourceTranscript);
  const historyRef = useRef<HTMLDivElement>(null);

  // Scroll state lives here — parent shell doesn't need to know about it.
  const [autoPin, setAutoPin] = useState(true);
  const [pendingNew, setPendingNew] = useState(0);
  const segmentsAtPauseRef = useRef<number>(0);

  // The last finalized segment is always rendered by LiveCaption (either as
  // the live area's static content when no partial is in flight, or as the
  // stable underlay while a fresh partial waits for its translation). So
  // history must EXCLUDE it — otherwise the same line appears twice on the
  // board, which was the P3.6 → P3.7 regression caught during the
  // browser-level verification pass.
  const historySegments = useMemo(
    () => (segments.length > 0 ? segments.slice(0, -1) : segments),
    [segments],
  );

  const isZhTarget = langPair === 'en→zh-TW';

  const zhParagraphs = useMemo(
    () =>
      groupParagraphsForSide({
        segments: historySegments,
        translations,
        side: 'zh',
        accessor: (s, t) =>
          isZhTarget ? t?.targetText ?? '' : s.text,
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
          isZhTarget ? s.text : t?.targetText ?? '',
      }),
    [historySegments, translations, isZhTarget],
  );

  const primaryParagraphs = isZhTarget ? zhParagraphs : enParagraphs;
  const secondaryParagraphs = isZhTarget ? enParagraphs : zhParagraphs;
  const primarySide: 'zh' | 'en' = isZhTarget ? 'zh' : 'en';
  const secondarySide: 'zh' | 'en' = isZhTarget ? 'en' : 'zh';

  const anchorMs = segments[0]?.startMs ?? 0;

  useEffect(() => {
    const el = historyRef.current;
    if (!el) return;
    const onScroll = () => {
      const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nowPinned = fromBottom < 32;
      setAutoPin((wasPinned) => {
        if (wasPinned && !nowPinned) {
          segmentsAtPauseRef.current = segments.length;
          setPendingNew(0);
        } else if (!wasPinned && nowPinned) {
          setPendingNew(0);
        }
        return nowPinned;
      });
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [segments.length]);

  useEffect(() => {
    if (autoPin) return;
    const delta = segments.length - segmentsAtPauseRef.current;
    if (delta > 0) setPendingNew(delta);
  }, [segments.length, autoPin]);

  // Pin to bottom when finalized paragraphs arrive. Runs at sentence rate,
  // not at partial-delta rate — that is the key perf win.
  useLayoutEffect(() => {
    if (!autoPin) return;
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [primaryParagraphs, secondaryParagraphs, autoPin]);

  function jumpToLatest(): void {
    const el = historyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAutoPin(true);
    setPendingNew(0);
  }

  return (
    <>
      <div
        ref={historyRef}
        className={styles.history}
        data-testid="caption-history"
        data-bilingual={bilingual || undefined}
      >
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
        {bilingual && (
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
        )}
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
    </>
  );
});

// ─── LiveCaption ─────────────────────────────────────────────────────────────
// Subscribes only to livePartial (and its translation). When a partial-delta
// arrives this is the ONLY component in the tree that re-renders.

interface LiveCaptionProps {
  frozen: boolean;
  langPair: LangPair;
}

interface DisplayedLive {
  target: string;
  source: string;
  /** 'partial' = current utterance in flight; 'final' = last finalized; 'paused' = Space-freeze snapshot. */
  status: 'partial' | 'final' | 'paused';
}

function computeDisplayed(
  live: CaptionSegment | null,
  lastFinal: CaptionSegment | undefined,
  liveTranslation: CaptionTranslation | undefined,
  lastFinalTranslation: CaptionTranslation | undefined,
): DisplayedLive | null {
  if (!live && !lastFinal) return null;

  // Active utterance: the user expects to see what is being said RIGHT NOW
  // in the big text — not the previous final in big text and the current
  // partial as a tiny hint below it. Source updates char-by-char (throttled
  // to 20 Hz by the coalescing handler). Target updates as soon as the
  // first translation draft chunk lands; until then it's a placeholder.
  if (live) {
    return {
      source: live.text,
      target: liveTranslation?.targetText ?? '',
      status: 'partial',
    };
  }

  // Idle (no in-flight partial): show the most recent finalized utterance.
  return {
    source: lastFinal!.text,
    target: lastFinalTranslation?.targetText ?? '',
    status: 'final',
  };
}

const LiveCaption = memo(function LiveCaption({ frozen, langPair }: LiveCaptionProps) {
  const live = useCaptionStore((s) => s.livePartial);
  const lastFinal = useCaptionStore((s) => s.segments.at(-1));
  const bilingual = useSettingsStore((s) => s.includeSourceTranscript);
  // Live translation is kept in its own slot — see CaptionState.liveTranslation.
  const liveTranslation = useCaptionStore((s): CaptionTranslation | undefined =>
    s.liveTranslation && live && s.liveTranslation.sourceSegmentId === live.segmentId
      ? s.liveTranslation
      : undefined,
  );
  const lastFinalTranslation = useCaptionStore((s) =>
    lastFinal ? s.translations[lastFinal.segmentId] : undefined,
  );

  const frozenSnapshotRef = useRef<DisplayedLive | null>(null);
  const liveDisplayed = computeDisplayed(
    live,
    lastFinal,
    liveTranslation,
    lastFinalTranslation,
  );

  if (frozen && frozenSnapshotRef.current === null && liveDisplayed) {
    frozenSnapshotRef.current = { ...liveDisplayed, status: 'paused' };
  } else if (!frozen && frozenSnapshotRef.current !== null) {
    frozenSnapshotRef.current = null;
  }

  const displayed: DisplayedLive | null = frozen
    ? frozenSnapshotRef.current
    : liveDisplayed;

  if (!displayed) {
    return (
      <div className={styles.empty} data-lang-pair={langPair} data-testid="caption-empty">
        <p>Waiting for captions…</p>
      </div>
    );
  }

  const isPartial = displayed.status === 'partial';

  return (
    <div className={styles.current} data-testid="caption-current" data-status={displayed.status}>
      <div
        className={styles.target}
        data-testid="caption-target"
        data-status={displayed.status}
      >
        {displayed.target || '…'}
      </div>
      {bilingual && (
        <div className={styles.source} data-testid="caption-source" data-status={displayed.status}>
          {displayed.source}
          {isPartial && (
            <span className={styles.cursor} aria-hidden="true" />
          )}
        </div>
      )}
      {frozen && (
        <span className={styles.pausedBadge} data-testid="paused-badge">
          ⏸ paused · press space to resume
        </span>
      )}
    </div>
  );
});

// ─── CaptionBoard (shell) ────────────────────────────────────────────────────

export function CaptionBoard() {
  const langPair = useSettingsStore((s) => s.langPair);
  const boardRef = useRef<HTMLDivElement>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const confirmingClearRef = useRef(false);
  const confirmTimeoutRef = useRef<number | null>(null);

  const [frozen, setFrozen] = useState(false);
  const [forceShowChrome, setForceShowChrome] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

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

  useEffect(() => {
    return () => {
      if (confirmTimeoutRef.current !== null) window.clearTimeout(confirmTimeoutRef.current);
    };
  }, []);

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

  useEffect(() => {
    function onFsChange(): void {
      setIsFullscreen(document.fullscreenElement === boardRef.current);
    }
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

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

      <HistoryStream langPair={langPair} />

      <LiveCaption frozen={frozen} langPair={langPair} />
    </div>
  );
}
