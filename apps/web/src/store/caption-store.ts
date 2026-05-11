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
  segments: CaptionSegment[];
  translations: Record<string, CaptionTranslation>;
  applyTranscript: (event: TranscriptEvent) => void;
  applyTranslation: (event: TranslationEvent) => void;
  clear: () => void;
}

export interface CreateCaptionStoreOptions {
  maxSegments?: number;
}

const DEFAULT_MAX_SEGMENTS = 500;

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

  return createStore<CaptionState>((set) => ({
    maxSegments,
    segments: [],
    translations: {},

    applyTranscript: (event) =>
      set((state) => ({
        segments: upsertSorted(
          state.segments,
          eventToSegment(event),
          event.revisionOf,
          state.maxSegments,
        ),
      })),

    applyTranslation: (event) =>
      set((state) => ({
        translations: {
          ...state.translations,
          [event.sourceSegmentId]: eventToTranslation(event),
        },
      })),

    clear: () => set({ segments: [], translations: {} }),
  }));
}
