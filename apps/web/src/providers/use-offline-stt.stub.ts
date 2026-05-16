import type { ProviderStatus } from './types.js';

/**
 * Online-slim stub for `useOfflineSTT`. Same return shape as the real hook
 * so call sites compile and behave inertly. Tree-shake target: this file
 * pulls ZERO offline-only modules (no OfflineSTTProvider, no opencc-js,
 * no PCM worklet path) so the online bundle ends ~700KB lighter than the
 * full build.
 *
 * The barrel `use-offline-stt.ts` resolves to this file via Vite alias when
 * VITE_DEPLOYMENT_MODE=online.
 */
export function useOfflineSTT(): {
  status: ProviderStatus;
  error: string | null;
  whisperStatus: string | null;
  hasWhisper: boolean;
  start: () => Promise<void>;
  stop: () => void;
} {
  return {
    status: 'idle',
    error: null,
    whisperStatus: 'unavailable',
    hasWhisper: false,
    start: () => Promise.resolve(),
    stop: () => undefined,
  };
}
