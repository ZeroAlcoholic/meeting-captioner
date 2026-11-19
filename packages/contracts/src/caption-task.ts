import { z } from 'zod';

/** The requested caption purpose, independent of online/offline deployment mode. */
export const CaptionTask = z.discriminatedUnion('purpose', [
  z
    .object({
      purpose: z.literal('transcription'),
      inputLanguages: z
        .array(z.enum(['zh-tw', 'en']))
        .min(1)
        .max(2),
      textPolicy: z.literal('zh-TW-preserve-original'),
    })
    .strict(),
  z
    .object({
      purpose: z.literal('translation'),
      langPair: z.enum(['en→zh-TW', 'zh-TW→en']),
    })
    .strict(),
]);

export type CaptionTask = z.infer<typeof CaptionTask>;
