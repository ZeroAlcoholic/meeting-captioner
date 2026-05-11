import { z } from 'zod';
import { Iso8601, Mode, ProviderId, SegmentId } from './common.js';

export const TranslationStatus = z.enum(['draft', 'refined', 'final']);
export type TranslationStatus = z.infer<typeof TranslationStatus>;

export const LanguageTag = z.string().min(2).max(35);
export type LanguageTag = z.infer<typeof LanguageTag>;

export const TranslationEvent = z.object({
  kind: z.literal('translation'),
  provider: ProviderId,
  mode: Mode,
  sourceSegmentId: SegmentId,
  status: TranslationStatus,
  sourceText: z.string(),
  targetText: z.string(),
  sourceLanguage: LanguageTag,
  targetLanguage: LanguageTag,
  updatedAt: Iso8601,
});

export type TranslationEvent = z.infer<typeof TranslationEvent>;
