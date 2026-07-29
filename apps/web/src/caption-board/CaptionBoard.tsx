import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore } from '../settings/use-settings-store.js';
import { useCaptionStore, captionStore } from '../store/use-caption-store.js';
import type { CaptionSegment, CaptionTranslation } from '../store/caption-store.js';
import type { LangPair } from '../settings/settings-store.js';
import {
  formatElapsedFromStart,
  groupParagraphsForSide,
  tailSegments,
  HISTORY_RENDER_SEGMENTS,
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
  // Mirror autoPin into a ref so the ResizeObserver callback (created once,
  // never re-subscribed) reads the live value instead of a stale closure.
  const autoPinRef = useRef(true);
  autoPinRef.current = autoPin;

  // The last finalized segment is rendered by LiveCaption ONLY while no
  // partial is in flight (computeDisplayed shows the live partial otherwise).
  // So the exclusion must be conditional:
  //   - no live partial → LiveCaption shows the last final BIG → history must
  //     exclude it (double-display was the P3.6 → P3.7 regression);
  //   - live partial in flight → LiveCaption shows the NEW utterance → the
  //     just-finished sentence must stay IN history, otherwise it vanishes
  //     from the entire board for the 1–3 s the next sentence streams (the
  //     dominant pattern on the continuous Gemini translate path).
  const hasLive = useCaptionStore((s) => s.livePartial !== null);
  const historySegments = useMemo(() => {
    // Exclude the last final only when LiveCaption is already showing it big
    // (no partial in flight) — see the note above.
    const base = hasLive || segments.length === 0 ? segments : segments.slice(0, -1);
    // Cap the RENDERED tail so DOM + paragraph-grouping cost stay flat on a
    // multi-hour meeting. The store keeps the full history; Export reads it.
    return tailSegments(base, HISTORY_RENDER_SEGMENTS);
  }, [segments, hasLive]);

  const isZhTarget = langPair === 'en→zh-TW';

  // Target-side accessors fall back to the SOURCE text when no translation
  // exists for a segment (CLAUDE.md: "translation fails → keep source
  // transcript"). Without the fallback, untranslated finals — every sentence
  // in Gemini's echo-silent case, or any MT failure — are skipped entirely
  // and become invisible when the source column is toggled off.
  const zhParagraphs = useMemo(
    () =>
      groupParagraphsForSide({
        segments: historySegments,
        translations,
        side: 'zh',
        accessor: (s, t) => (isZhTarget ? t?.targetText || s.text : s.text),
      }),
    [historySegments, translations, isZhTarget],
  );
  const enParagraphs = useMemo(
    () =>
      groupParagraphsForSide({
        segments: historySegments,
        translations,
        side: 'en',
        accessor: (s, t) => (isZhTarget ? s.text : t?.targetText || s.text),
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
      // Update the ref SYNCHRONOUSLY (not just via the render-time mirror) so a
      // ResizeObserver callback that fires in the same frame — before React
      // commits this setAutoPin — reads the fresh intent and does not yank the
      // view back to the bottom while the user is scrolling up.
      autoPinRef.current = nowPinned;
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

  // Re-pin on ANY size change of the history pane or its content — not just
  // when paragraph arrays change. The board is `grid-template-rows: 1fr auto`,
  // so when the big live caption below wraps to extra lines the history pane
  // (1fr) shrinks; the just-finalized small line that was sitting at the
  // bottom then scrolls out of view. That resize fires no scroll event and
  // no paragraph-array change, so the layout-effect above never caught it —
  // the "剛講過的話不會自動拉到最底" bug. A ResizeObserver on the scroll
  // container catches both its own height changes and content reflow.
  useEffect(() => {
    const el = historyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      if (autoPinRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    // Also observe the content column so late-arriving translations (which
    // grow content height without resizing the container) re-pin too.
    const firstCol = el.firstElementChild;
    if (firstCol) ro.observe(firstCol);
    return () => ro.disconnect();
  }, []);

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

/**
 * Map the live transport+audio health onto a staged startup cue, so the empty
 * board never reads as "frozen / dead air" during the unavoidable few seconds
 * between Start and the first caption (mic grant → token → WebRTC/WS handshake →
 * the model hearing its first phrase). CLAUDE.md mandates a visible state for
 * each of these — a bare "Waiting for captions…" hid them all.
 */
type StartupPhase = 'idle' | 'permission' | 'connecting' | 'listening';
function startupCue(
  transport: string,
  audio: string,
): { phase: StartupPhase; label: string; sub?: string } {
  if (audio === 'requesting_permission') {
    return { phase: 'permission', label: '請允許麥克風存取…', sub: '瀏覽器正在詢問權限' };
  }
  if (transport === 'connecting' || audio === 'connecting') {
    return { phase: 'connecting', label: '連線中…', sub: '正在建立即時翻譯連線' };
  }
  if (transport === 'connected') {
    // Connected but no caption yet → the model is waiting for the first phrase.
    return { phase: 'listening', label: '正在聆聽…', sub: '開始說話即會出現字幕' };
  }
  return { phase: 'idle', label: 'Waiting for captions…' };
}

const LiveCaption = memo(function LiveCaption({ frozen, langPair }: LiveCaptionProps) {
  const live = useCaptionStore((s) => s.livePartial);
  const lastFinal = useCaptionStore((s) => s.segments.at(-1));
  const bilingual = useSettingsStore((s) => s.includeSourceTranscript);
  // Health drives the staged startup cue rendered in the empty state below.
  const transportState = useSettingsStore((s) => s.health.transport.state);
  const audioState = useSettingsStore((s) => s.health.audio.state);
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
  const liveDisplayed = computeDisplayed(live, lastFinal, liveTranslation, lastFinalTranslation);

  if (frozen && frozenSnapshotRef.current === null && liveDisplayed) {
    frozenSnapshotRef.current = { ...liveDisplayed, status: 'paused' };
  } else if (!frozen && frozenSnapshotRef.current !== null) {
    frozenSnapshotRef.current = null;
  }

  const displayed: DisplayedLive | null = frozen ? frozenSnapshotRef.current : liveDisplayed;

  // Auto-pin the live area to the bottom whenever its text grows, so the most
  // recent words of a long in-flight utterance always stay visible — the older
  // lines scroll off the top but remain reachable via the scrollbar (usable
  // while frozen, when no new deltas fight the scroll). Skipped when frozen so a
  // paused long caption can be scrolled up freely.
  const currentRef = useRef<HTMLDivElement>(null);
  const liveKey = displayed ? `${displayed.target} ${displayed.source}` : '';
  useLayoutEffect(() => {
    if (frozen) return;
    const el = currentRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [liveKey, frozen]);

  if (!displayed) {
    const cue = startupCue(transportState, audioState);
    return (
      <div
        className={styles.empty}
        data-lang-pair={langPair}
        data-testid="caption-empty"
        data-phase={cue.phase}
      >
        <div className={styles.startupCue}>
          {cue.phase !== 'idle' && <span className={styles.startupSpinner} aria-hidden="true" />}
          <p className={styles.startupLabel}>{cue.label}</p>
          {cue.sub && <p className={styles.startupSub}>{cue.sub}</p>}
        </div>
      </div>
    );
  }

  const isPartial = displayed.status === 'partial';

  return (
    <div
      ref={currentRef}
      className={styles.current}
      data-testid="caption-current"
      data-status={displayed.status}
    >
      <div className={styles.target} data-testid="caption-target" data-status={displayed.status}>
        {displayed.target ? (
          displayed.target
        ) : isPartial && displayed.source ? (
          // Translation trails the source stream — ~2–3 s on Gemini Live
          // Translate, where the caption text is structurally paced by the
          // model's translated-audio generation (no server-side knob exists to
          // shorten it; verified against the official docs 2026-07-02). A bare
          // 翻譯中… label left the big area dead for that whole window every
          // sentence, which read as "the system is slow". Show the source text
          // that HAS arrived, dimmed and tagged, and swap in the translation
          // the instant its first draft delta lands.
          <>
            <span className={styles.pendingSource} data-testid="pending-source">
              {displayed.source}
            </span>
            <span className={styles.translatingHint}>翻譯中…</span>
          </>
        ) : isPartial ? (
          // Nothing at all has arrived for this utterance yet — a bare
          // 5rem ellipsis read as "nothing is happening". Label the state.
          <span className={styles.translatingHint}>翻譯中…</span>
        ) : (
          // Finalized with no translation (MT failure / speaker already in
          // target language): degrade to the source text, never a blank.
          displayed.source || '…'
        )}
      </div>
      {bilingual && (
        <div className={styles.source} data-testid="caption-source" data-status={displayed.status}>
          {displayed.source}
          {isPartial && <span className={styles.cursor} aria-hidden="true" />}
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

// ─── ReconnectingIndicator ───────────────────────────────────────────────────
// Subscribes to transport health state. Shows a visible amber pill while
// the provider is in the middle of a renewal (state='reconnecting' for the
// 1-2 s gap during normal 25-min refresh) or an auto-retry backoff
// (state='failed' with retry timer pending). The speaker sees that the
// system is auto-healing instead of staring at a frozen caption area.

const ReconnectingIndicator = memo(function ReconnectingIndicator() {
  const transportState = useSettingsStore((s) => s.health.transport.state);
  const transportMessage = useSettingsStore((s) => s.health.transport.message);

  if (transportState !== 'reconnecting' && transportState !== 'failed') {
    return null;
  }
  const label = transportState === 'reconnecting' ? 'Reconnecting…' : 'Auto-recovering';
  return (
    <div
      className={styles.reconnectPill}
      data-state={transportState}
      role="status"
      aria-live="polite"
      title={transportMessage ?? label}
      data-testid="reconnect-pill"
    >
      <span className={styles.reconnectSpinner} aria-hidden="true" />
      <span>{label}</span>
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

  // Wheel delegation: forward wheel events that land OUTSIDE the history
  // pane (typically over the big live caption area, the empty placeholder,
  // or the top action chrome) into the history scroll container. Without
  // this, a user trying to glance at the previous paragraph has to
  // physically aim the cursor at the narrow history strip — a real source
  // of "scrolling feels broken" friction on long meetings.
  //
  // Events that originate inside the history pane are left untouched so
  // the browser's native smooth-scroll handles them with its full
  // momentum / trackpad semantics.
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    function onWheel(this: void, e: WheelEvent): void {
      const history = board?.querySelector('[data-testid="caption-history"]') as HTMLElement | null;
      if (!history) return;
      if (history.contains(e.target as Node)) return; // native scroll handles it
      // Translate the wheel deltaMode into pixels. Most mice/trackpads use
      // pixel mode (0); legacy line (1) and page (2) modes need scaling.
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= history.clientHeight;
      // Only consume the event if history actually has room to scroll in
      // that direction — otherwise let the wheel bubble normally (lets
      // ancestor scrollers, browser back-gesture, etc. behave naturally).
      const canScroll =
        (dy > 0 && history.scrollTop + history.clientHeight < history.scrollHeight) ||
        (dy < 0 && history.scrollTop > 0);
      if (!canScroll) return;
      e.preventDefault();
      history.scrollBy({ top: dy, behavior: 'auto' });
    }
    board.addEventListener('wheel', onWheel, { passive: false });
    return () => board.removeEventListener('wheel', onWheel);
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

      <ReconnectingIndicator />

      <HistoryStream langPair={langPair} />

      <LiveCaption frozen={frozen} langPair={langPair} />
    </div>
  );
}
