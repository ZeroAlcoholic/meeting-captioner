import { useSyncExternalStore } from 'react';
import { createCaptionStore, type CaptionState, type CaptionStore } from './caption-store.js';

export const captionStore: CaptionStore = createCaptionStore();

// Dev-only debug handle: lets manual/browser-driven checks drive the store
// (e.g. fill the history pane to exercise auto-scroll) without a live backend.
// Tree-shaken out of production builds via the import.meta.env.DEV guard.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __captionStore: CaptionStore }).__captionStore = captionStore;
}

export function useCaptionStore<T>(selector: (state: CaptionState) => T): T {
  return useSyncExternalStore(
    captionStore.subscribe,
    () => selector(captionStore.getState()),
    () => selector(captionStore.getState()),
  );
}
