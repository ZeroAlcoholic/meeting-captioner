import { z } from 'zod';

export const ProviderId = z.string().min(1);
export type ProviderId = z.infer<typeof ProviderId>;

export const Mode = z.enum(['online_full', 'hybrid_privacy', 'full_offline']);
export type Mode = z.infer<typeof Mode>;

export const AudioSourceKind = z.enum([
  'microphone',
  'browser_tab',
  'browser_system',
  'windows_loopback',
  'fake_replay',
]);
export type AudioSourceKind = z.infer<typeof AudioSourceKind>;

export const SegmentId = z.string().min(1);
export type SegmentId = z.infer<typeof SegmentId>;

export const Iso8601 = z.string().datetime({ offset: true });
export type Iso8601 = z.infer<typeof Iso8601>;
