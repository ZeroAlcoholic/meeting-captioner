import type { LocalModeController } from './local-mode-controller.js';

/** Explicitly unavailable in online distributions; never contacts local services. */
function useUnavailableLocalMode(): LocalModeController {
  return {
    status: 'idle',
    error: null,
    whisperStatus: 'unavailable',
    hasWhisper: false,
    start: () => Promise.reject(new Error('此版本未包含地端處理，請使用完整版本繼續原會議。')),
    stop: () => undefined,
  };
}

export { useUnavailableLocalMode as useOfflineSTT, useUnavailableLocalMode as useHybridMode };
