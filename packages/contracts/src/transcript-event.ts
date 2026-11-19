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
  /** Original ASR output before display normalization; not human ground truth. */
  rawText: z.string().optional(),
  /**
   * How `text` was derived from `rawText`. `v1` was glyph conversion only and
   * still appears in archived meetings; `v2` also converts the wording to
   * Taiwanese and applies the project glossary.
   */
  textNormalization: z.enum(['opencc-cn-tw-v1', 'opencc-cn-twp-v2']).optional(),
  timingBasis: z.literal('capture-estimated').optional(),
  /** Local input PCM associated with this item, not word timing or a raw provider sample ACK. */
  inputAudioRange: z
    .object({
      trackId: z.string().min(1),
      captureEpoch: z.string().min(1),
      from: z.number().int().nonnegative().safe(),
      to: z.number().int().nonnegative().safe(),
      sampleRate: z.literal(16000),
    })
    .strict()
    .refine((range) => range.to > range.from)
    .optional(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative().optional(),
  confidence: z.number().min(0).max(1).optional(),
  revisionOf: SegmentId.optional(),
  /** Previous storage segment when a hard duration limit split continuous speech. */
  continuationOf: SegmentId.optional(),
});

export type TranscriptEvent = z.infer<typeof TranscriptEvent>;
