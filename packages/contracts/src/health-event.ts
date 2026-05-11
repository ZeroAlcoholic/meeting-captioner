import { z } from 'zod';
import { Iso8601 } from './common.js';

export const HealthState = z.enum([
  'idle',
  'requesting_permission',
  'connecting',
  'connected',
  'reconnecting',
  'degraded',
  'failed',
  'stopped',
  'no_audio_track',
  'silence_detected',
  'model_loading',
  'offline_engine_unavailable',
  'api_error',
]);
export type HealthState = z.infer<typeof HealthState>;

export const HealthComponent = z.enum([
  'audio',
  'stt',
  'translation',
  'summary',
  'transport',
  'ui',
]);
export type HealthComponent = z.infer<typeof HealthComponent>;

export const HealthEvent = z.object({
  kind: z.literal('health'),
  component: HealthComponent,
  state: HealthState,
  message: z.string().optional(),
  timestamp: Iso8601,
});

export type HealthEvent = z.infer<typeof HealthEvent>;
