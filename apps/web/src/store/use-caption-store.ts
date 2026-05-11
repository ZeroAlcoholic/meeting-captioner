import { useSyncExternalStore } from 'react';
import { createCaptionStore, type CaptionState, type CaptionStore } from './caption-store.js';

export const captionStore: CaptionStore = createCaptionStore();

export function useCaptionStore<T>(selector: (state: CaptionState) => T): T {
  return useSyncExternalStore(
    captionStore.subscribe,
    () => selector(captionStore.getState()),
    () => selector(captionStore.getState()),
  );
}
