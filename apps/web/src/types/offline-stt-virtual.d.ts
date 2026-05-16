/**
 * Type declaration for the virtual module `@meeting-audio/offline-stt`,
 * resolved at build time by the Vite alias in `vite.config.ts`. Both the
 * real implementation and the stub share this exact shape, so this single
 * declaration is correct for either build target.
 */
declare module '@meeting-audio/offline-stt' {
  import type { ProviderStatus } from '../providers/types.js';
  export function useOfflineSTT(): {
    status: ProviderStatus;
    error: string | null;
    whisperStatus: string | null;
    hasWhisper: boolean;
    start: () => Promise<void>;
    stop: () => void;
  };
}
