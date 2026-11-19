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

export const RecoveryFailure = z
  .object({
    layer: z.enum(['audio', 'transport', 'provider']),
    kind: z.enum([
      'network',
      'auth',
      'rate-limit',
      'unsupported',
      'stalled',
      'permission',
      'ended',
    ]),
    provider: z.enum(['openai', 'gemini']),
    purpose: z.enum(['translation', 'transcription']),
    attemptId: z.string().min(1),
    retryNotBeforeMs: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type RecoveryFailure = z.infer<typeof RecoveryFailure>;

/** Estimated wall-clock interval only; no claim about missing captured samples. */
export const CaptureGap = z
  .object({
    captureEpoch: z.string().min(1),
    wallClock: z
      .object({ startAt: Iso8601, endAt: Iso8601 })
      .strict()
      .refine((v) => Date.parse(v.endAt) >= Date.parse(v.startAt)),
  })
  .strict();

export const HealthEvent = z.object({
  kind: z.literal('health'),
  component: HealthComponent,
  state: HealthState,
  message: z.string().optional(),
  captureGap: CaptureGap.optional(),
  /** Captured PCM evicted while no provider held the source; not an upstream ACK claim. */
  retentionGap: z
    .object({
      gapId: z.string().uuid(),
      trackId: z.string().min(1),
      captureEpoch: z.string().min(1),
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      sampleRate: z.literal(16000),
    })
    .strict()
    .refine((range) => range.to > range.from)
    .optional(),
  recoveryFailure: RecoveryFailure.optional(),
  reason: z
    .enum([
      'capture_stalled',
      'track_muted',
      'context_suspended',
      'context_closed',
      'track_ended',
      'capture_resumed',
    ])
    .optional(),
  timestamp: Iso8601,
});

export type HealthEvent = z.infer<typeof HealthEvent>;
