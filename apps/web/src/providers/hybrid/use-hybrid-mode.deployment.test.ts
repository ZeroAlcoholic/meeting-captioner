import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  onlineOnly: true,
  effects: [] as Array<() => void | (() => void)>,
}));
vi.mock('react', () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
}));
vi.mock('../../deployment.js', () => ({
  get IS_ONLINE_ONLY() {
    return harness.onlineOnly;
  },
}));
vi.mock('../../settings/use-settings-store.js', () => ({ settingsStore: { getState: vi.fn() } }));
vi.mock('../../store/use-caption-store.js', () => ({ captionStore: { getState: vi.fn() } }));
import { useHybridMode } from './use-hybrid-mode.js';

beforeEach(() => {
  harness.effects.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([true, false])(
  'only full builds probe the offline service (onlineOnly=%s)',
  (onlineOnly) => {
    harness.onlineOnly = onlineOnly;
    useHybridMode();
    const cleanup = harness.effects.map((effect) => effect());
    if (onlineOnly) expect(fetch).not.toHaveBeenCalled();
    else expect(fetch).toHaveBeenCalledWith('http://localhost:8000/healthz');
    for (const stop of cleanup) stop?.();
  },
);
