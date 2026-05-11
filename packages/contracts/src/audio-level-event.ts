import { z } from 'zod';
import { AudioSourceKind, Iso8601 } from './common.js';

export const AudioLevelEvent = z.object({
  kind: z.literal('audio_level'),
  source: AudioSourceKind,
  rmsDb: z.number(),
  peakDb: z.number(),
  timestamp: Iso8601,
});

export type AudioLevelEvent = z.infer<typeof AudioLevelEvent>;
