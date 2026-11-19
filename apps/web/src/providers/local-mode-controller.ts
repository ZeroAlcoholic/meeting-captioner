import type { ProviderStatus } from './types.js';

/** Stable UI capability; implementation dependencies stay behind build aliases. */
export interface LocalModeController {
  status: ProviderStatus;
  error: string | null;
  whisperStatus: string | null;
  hasWhisper: boolean;
  start(): Promise<void>;
  stop(): void;
}
