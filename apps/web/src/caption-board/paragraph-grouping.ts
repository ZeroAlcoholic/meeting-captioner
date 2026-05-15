import type { CaptionSegment, CaptionTranslation } from '../store/caption-store.js';

export interface Paragraph {
  id: string;            // segmentId of the FIRST segment in the paragraph
  text: string;          // merged text for this side
  startMs: number;       // startMs of the first segment
  endMs: number;         // endMs (or startMs) of the last segment
  confLow: boolean;      // true if any constituent segment had confidence < threshold
}

// Sentence terminators per language. ZH includes 「。！？…」, EN includes `.!?…`.
// Comma 「，」 / `,` deliberately excluded — they are mid-sentence and would
// over-fragment paragraphs.
const ZH_END = /[。！？…]\s*$/;
const EN_END = /[.!?…]\s*$/;

// Force a paragraph break if the gap between segments exceeds this (long pause).
const PARAGRAPH_GAP_MS = 1500;
// Hard cap so a runaway speaker without punctuation doesn't form a screen-spanning blob.
const PARAGRAPH_MAX_CHARS = 240;
// Threshold below which a segment counts as low-confidence for visual dim.
const CONF_LOW_THRESHOLD = 0.6;

function isCjk(ch: string | undefined): boolean {
  if (!ch) return false;
  // Match the same range used by CaptionBoard previously: U+4E00–U+9FFF (CJK Unified).
  return /[一-鿿]/.test(ch);
}

/**
 * Pieces of punctuation that already imply their own boundary — when a piece
 * starts with one of these, no separator is added before it.
 */
const NO_LEADING_SEP = /^[，。、！？.!?\-—…]/;

/**
 * Decide the separator to insert between two adjacent merged pieces.
 * - CJK ↔ CJK: U+2009 thin space (soft visual breath, no injected punctuation)
 * - Otherwise: regular space (Latin word boundary)
 */
function chooseSeparator(left: string, right: string): string {
  const leftLast = left[left.length - 1];
  const rightFirst = right[0];
  if (isCjk(leftLast) && isCjk(rightFirst)) return ' ';
  return ' ';
}

export type SideAccessor = (s: CaptionSegment, t?: CaptionTranslation) => string;

export type SidePunctuation = 'zh' | 'en';

interface GroupOptions {
  segments: CaptionSegment[];
  translations: Record<string, CaptionTranslation>;
  /** Which physical language this side renders — chooses the punctuation regex. */
  side: SidePunctuation;
  /** How to extract this side's text from a segment + its translation. */
  accessor: SideAccessor;
}

/**
 * Group segments into paragraphs FOR ONE SIDE, using that side's own punctuation.
 *
 * Two sides (ZH stream and EN stream) call this independently with different
 * accessors and different sentence-end regexes, so paragraph boundaries can
 * diverge — exactly what's wanted when source and translation use different
 * punctuation rhythms.
 */
export function groupParagraphsForSide(opts: GroupOptions): Paragraph[] {
  const endRe = opts.side === 'zh' ? ZH_END : EN_END;
  const out: Paragraph[] = [];

  for (const seg of opts.segments) {
    const tr = opts.translations[seg.segmentId];
    const piece = opts.accessor(seg, tr).trim();
    if (!piece) continue;

    const segEnd = seg.endMs ?? seg.startMs;
    const segConfLow = seg.confidence !== undefined && seg.confidence < CONF_LOW_THRESHOLD;
    const last = out[out.length - 1];

    // Real gap = current segment start − previous paragraph END.
    const gap = last ? seg.startMs - last.endMs : 0;
    const merge =
      last !== undefined &&
      !endRe.test(last.text) &&
      gap < PARAGRAPH_GAP_MS &&
      last.text.length + piece.length < PARAGRAPH_MAX_CHARS;

    if (merge && last) {
      const sep = NO_LEADING_SEP.test(piece) ? '' : chooseSeparator(last.text, piece);
      last.text = last.text + sep + piece;
      last.endMs = segEnd;
      if (segConfLow) last.confLow = true;
    } else {
      out.push({
        id: seg.segmentId,
        text: piece,
        startMs: seg.startMs,
        endMs: segEnd,
        confLow: segConfLow,
      });
    }
  }
  return out;
}

/**
 * Format an absolute startMs into a `M:SS` label relative to sessionStartMs.
 * Returns `0:00` if sessionStartMs is null (first paragraph of the session).
 */
export function formatElapsedFromStart(startMs: number, sessionStartMs: number | null): string {
  if (sessionStartMs === null) return '0:00';
  // startMs in our store is wall-clock Date.now() at event time, so subtract directly.
  const elapsedMs = Math.max(0, startMs - sessionStartMs);
  const totalSec = Math.floor(elapsedMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
