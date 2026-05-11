import { useSyncExternalStore } from 'react';
import { createSettingsStore, type SettingsState, type SettingsStore } from './settings-store.js';

export const settingsStore: SettingsStore = createSettingsStore();

export function useSettingsStore<T>(selector: (state: SettingsState) => T): T {
  return useSyncExternalStore(
    settingsStore.subscribe,
    () => selector(settingsStore.getState()),
    () => selector(settingsStore.getState()),
  );
}
