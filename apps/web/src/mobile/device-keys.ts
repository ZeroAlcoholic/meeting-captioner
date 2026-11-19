/**
 * Phone build only: the user's own API keys, kept in this browser's
 * localStorage. They are never bundled, committed, logged or sent anywhere
 * except the matching provider's token endpoint (see device-broker.ts).
 *
 * This is the one deliberate exception to "keys stay server-side": the static
 * phone site has no server. See docs/DECISIONS.md (D-MOBILE-1).
 */
export type DeviceKeyProvider = 'gemini' | 'openai';
export type DeviceKeys = Partial<Record<DeviceKeyProvider, string>>;

const STORAGE_KEY = 'meeting-captioner.device-keys.v1';
const listeners = new Set<() => void>();
let cache: DeviceKeys | null = null;

function load(): DeviceKeys {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object') return {};
    const out: DeviceKeys = {};
    for (const provider of ['gemini', 'openai'] as const) {
      const key = (value as Record<string, unknown>)[provider];
      if (typeof key === 'string' && key.trim()) out[provider] = key.trim();
    }
    return out;
  } catch {
    // Private mode / blocked storage: behave as "no key saved".
    return {};
  }
}

/** Stable reference between changes, so it can back useSyncExternalStore. */
export function getDeviceKeys(): DeviceKeys {
  cache ??= load();
  return cache;
}

/** An empty value removes that provider's key. Returns false if storage refused. */
export function setDeviceKey(provider: DeviceKeyProvider, value: string): boolean {
  const next: DeviceKeys = { ...getDeviceKeys() };
  const trimmed = value.trim();
  if (trimmed) next[provider] = trimmed;
  else delete next[provider];
  let stored = true;
  try {
    if (Object.keys(next).length) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    stored = false; // still usable for this visit, just not remembered
  }
  cache = next;
  listeners.forEach((listener) => listener());
  return stored;
}

export function subscribeDeviceKeys(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For display only: never reveal more than the last four characters. */
export function maskKey(key: string): string {
  return key.length <= 8 ? '••••' : `••••${key.slice(-4)}`;
}

/** Test seam. */
export function __resetDeviceKeysForTests(): void {
  cache = null;
  listeners.clear();
}
