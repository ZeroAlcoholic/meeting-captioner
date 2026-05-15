import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore } from '../settings/use-settings-store.js';
import { useCaptionStore } from '../store/use-caption-store.js';
import { captionStore } from '../store/use-caption-store.js';
import type { CaptionSegment, CaptionTranslation } from '../store/caption-store.js';
import styles from './CaptionBoard.module.css';

// Sentence terminators that mark a paragraph boundary. Whisper emits these at
// natural breath / punctuation pauses. Anything not ending in one of these
// continues the current paragraph (subject to time-gap and length caps).
const SENTENCE_END = /[.!?。？！…]\s*$/;
// Force a new paragraph if the gap between segments exceeds this (long pause).
const PARAGRAPH_GAP_MS = 1500;
// Hard cap so a runaway speaker without punctuation doesn't form a screen-spanning blob.
const PARAGRAPH_MAX_CHARS = 240;

interface Paragraph {
  id: string;
  source: string;
  target: string;
  startMs: number;
  endMs: number;
}

function groupIntoParagraphs(
  segments: CaptionSegment[],
  translations: Record<string, CaptionTranslation>,
): Paragraph[] {
  const out: Paragraph[] = [];
  for (const seg of segments) {
    const tr = translations[seg.segmentId]?.targetText ?? '';
    const segEnd = seg.endMs ?? seg.startMs;
    const last = out.at(-1);
    // Real gap = current segment start − previous paragraph END.
    const gap = last ? seg.startMs - last.endMs : 0;
    const merge =
      last !== undefined &&
      !SENTENCE_END.test(last.source) &&
      gap < PARAGRAPH_GAP_MS &&
      last.source.length + seg.text.length < PARAGRAPH_MAX_CHARS;
    if (merge && last) {
      // Preserve a space for Latin joins, none between CJK glyphs.
      const sep = /[一-鿿]$/.test(last.source) && /^[一-鿿]/.test(seg.text) ? '' : ' ';
      last.source = last.source + sep + seg.text;
      const trSep = /[一-鿿]$/.test(last.target) && /^[一-鿿]/.test(tr) ? '' : ' ';
      last.target = (last.target ? last.target + trSep : '') + tr;
      last.endMs = segEnd;
    } else {
      out.push({ id: seg.segmentId, source: seg.text, target: tr, startMs: seg.startMs, endMs: segEnd });
    }
  }
  return out;
}

function downloadTranscript(): void {
  const { segments, translations } = captionStore.getState();
  if (segments.length === 0) return;

  const paragraphs = groupIntoParagraphs(segments, translations);
  const lines: string[] = [];
  for (const p of paragraphs) {
    const ts = new Date(p.startMs > 1e12 ? p.startMs : Date.now() - (segments.at(-1)!.startMs - p.startMs))
      .toISOString().replace('T', ' ').slice(0, 19);
    lines.push(`[${ts}]`);
    if (p.target) lines.push(`  → ${p.target}`);
    lines.push(`    ${p.source}`);
    lines.push('');
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

function clearTranscript(): void {
  if (confirm('清空所有字幕？此操作無法復原（請先 Export 保留）')) {
    captionStore.getState().clear();
  }
}

export function CaptionBoard() {
  const segments = useCaptionStore((s) => s.segments);
  const translations = useCaptionStore((s) => s.translations);
  const langPair = useSettingsStore((s) => s.langPair);

  const historyRef = useRef<HTMLDivElement>(null);
  // autoPin pauses when user manually scrolls up; resumes when they scroll back to bottom.
  const [autoPin, setAutoPin] = useState(true);

  const current = segments.at(-1);
  const historySegments = segments.slice(0, -1);
  const paragraphs = useMemo(
    () => groupIntoParagraphs(historySegments, translations),
    [historySegments, translations],
  );

  useEffect(() => {
    const el = historyRef.current;
    if (!el) return;
    const onScroll = () => {
      const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setAutoPin(fromBottom < 32);
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    if (!autoPin) return;
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [paragraphs, autoPin]);

  if (!current) {
    return (
      <div className={styles.empty} data-lang-pair={langPair} data-testid="caption-empty">
        <p>Waiting for captions…</p>
      </div>
    );
  }

  // Live caption: keep showing the most recent translation while a partial
  // segment is in progress (no translation event yet for the partial id).
  const currentTranslation =
    translations[current.segmentId] ??
    translations[historySegments.at(-1)?.segmentId ?? ''];

  return (
    <div className={styles.board} data-lang-pair={langPair}>
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
          className={styles.actionBtn}
          onClick={clearTranscript}
          title="Clear all captions (cannot be undone)"
          data-testid="clear-transcript"
        >
          ✕ Clear
        </button>
      </div>

      <div ref={historyRef} className={styles.history} data-testid="caption-history">
        {paragraphs.map((p) => (
          <div key={p.id} className={styles.historyRow}>
            <span className={styles.historyTarget}>{p.target || '—'}</span>
            <span className={styles.historySource}>{p.source}</span>
          </div>
        ))}
      </div>

      <div
        className={styles.current}
        data-testid="caption-current"
        data-status={current.status}
      >
        <div
          className={styles.target}
          data-testid="caption-target"
          data-status={currentTranslation?.status ?? 'pending'}
        >
          {currentTranslation?.targetText ?? '…'}
        </div>
        <div className={styles.source} data-testid="caption-source">
          {current.text}
          {current.status !== 'final' && <span className={styles.cursor}>▍</span>}
        </div>
      </div>
    </div>
  );
}
