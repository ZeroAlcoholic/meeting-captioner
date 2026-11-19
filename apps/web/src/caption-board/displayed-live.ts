import type { CaptionSegment, CaptionTranslation } from '../store/caption-store.js';

export interface DisplayedLive {
  target: string;
  source: string;
  status: 'partial' | 'final' | 'paused';
}

// Storage remains split at its hard deadline. Only the visible continuation
// includes context, bounded independently of history size and never recursive.
const CONTINUATION_DISPLAY_LIMIT = 160;

function withContext(previous: string, current: string): string {
  const text = (
    previous.slice(-CONTINUATION_DISPLAY_LIMIT) + current.slice(-CONTINUATION_DISPLAY_LIMIT)
  ).slice(-CONTINUATION_DISPLAY_LIMIT);
  // Avoid displaying half of a surrogate pair at the bounded window's start.
  return /^[\uDC00-\uDFFF]/.test(text) ? text.slice(1) : text;
}

export function computeDisplayed(
  live: CaptionSegment | null,
  lastFinal: CaptionSegment | undefined,
  liveTranslation: CaptionTranslation | undefined,
  lastFinalTranslation: CaptionTranslation | undefined,
  previousFinal?: CaptionSegment,
  previousFinalTranslation?: CaptionTranslation,
): DisplayedLive | null {
  const current = live ?? lastFinal;
  if (!current) return null;
  const translation = live ? liveTranslation : lastFinalTranslation;
  const previous = live ? lastFinal : previousFinal;
  const previousTranslation = live ? lastFinalTranslation : previousFinalTranslation;
  const continues =
    previous !== undefined &&
    current.continuationOf === previous.segmentId &&
    current.provider === previous.provider &&
    current.mode === previous.mode &&
    current.source === previous.source;
  const sameLanguages =
    !translation ||
    !previousTranslation ||
    (translation.sourceLanguage === previousTranslation.sourceLanguage &&
      translation.targetLanguage === previousTranslation.targetLanguage);
  return {
    source: continues ? withContext(previous.text, current.text) : current.text,
    target:
      continues && sameLanguages
        ? withContext(previousTranslation?.targetText ?? '', translation?.targetText ?? '')
        : (translation?.targetText ?? ''),
    status: live ? 'partial' : 'final',
  };
}
