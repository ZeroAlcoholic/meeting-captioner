import { z } from 'zod';
import { AudioLevelEvent } from './audio-level-event.js';
import { HealthEvent } from './health-event.js';
import { TranscriptEvent } from './transcript-event.js';
import { TranslationEvent } from './translation-event.js';

export * from './common.js';
export * from './transcript-event.js';
export * from './translation-event.js';
export * from './health-event.js';
export * from './audio-level-event.js';

export const NormalizedEvent = z.discriminatedUnion('kind', [
  TranscriptEvent,
  TranslationEvent,
  HealthEvent,
  AudioLevelEvent,
]);
export type NormalizedEvent = z.infer<typeof NormalizedEvent>;
