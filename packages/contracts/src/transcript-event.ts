import { z } from 'zod';
import { AudioSourceKind, Mode, ProviderId, SegmentId } from './common.js';

export const TranscriptStatus = z.enum(['partial', 'revised', 'final']);
export type TranscriptStatus = z.infer<typeof TranscriptStatus>;

export const TranscriptEvent = z.object({
  kind: z.literal('transcript'),
  provider: ProviderId,
  mode: Mode,
  source: AudioSourceKind,
  segmentId: SegmentId,
  status: TranscriptStatus,
  text: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative().optional(),
  confidence: z.number().min(0).max(1).optional(),
  revisionOf: SegmentId.optional(),
});

export type TranscriptEvent = z.infer<typeof TranscriptEvent>;
