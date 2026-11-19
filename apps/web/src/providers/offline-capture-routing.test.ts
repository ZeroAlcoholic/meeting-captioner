import { beforeEach, expect, it, vi } from 'vitest';
const harness = vi.hoisted(() => ({
  settings: {
    langPair: 'en→zh-TW',
    audioSource: 'mic',
    micDistance: 'meeting',
    micDeviceId: 'usb-mic',
  },
  lease: vi.fn(() => ({ acquire: vi.fn(), release: vi.fn(), analyser: null })),
  constructed: vi.fn(),
}));
vi.mock('react', () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
  useCallback: (fn: unknown) => fn,
  useEffect: vi.fn(),
}));
vi.mock('../settings/use-settings-store.js', () => ({
  settingsStore: { getState: () => harness.settings },
}));
vi.mock('../store/use-caption-store.js', () => ({ captionStore: { getState: vi.fn() } }));
vi.mock('./coalesce-handlers.js', () => ({
  createStoreBoundHandlers: () => ({ flushPending: vi.fn() }),
}));
vi.mock('./capture-lease.js', () => ({ leaseCapture: harness.lease }));
vi.mock('./offline/offline-stt-provider.js', () => ({
  OfflineSTTProvider: class {
    status = 'idle';
    constructor(...args: unknown[]) {
      harness.constructed(...args);
    }
    async start() {
      this.status = 'running';
    }
    stop() {
      this.status = 'stopped';
    }
  },
}));
import { useOfflineSTT } from './offline/use-offline-stt.js';
import { useHybridMode } from './hybrid/use-hybrid-mode.js';
beforeEach(() => {
  vi.clearAllMocks();
  harness.settings.audioSource = 'mic';
});
it.each([useOfflineSTT, useHybridMode])(
  'routes browser mic through the shared selected-device lease',
  async (useProvider) => {
    await useProvider().start();
    expect(harness.lease).toHaveBeenCalledWith({
      kind: 'mic',
      micDistance: 'meeting',
      deviceId: 'usb-mic',
    });
    expect(harness.constructed.mock.calls[0]?.[2]).toBe(harness.lease.mock.results[0]?.value);
  },
);
it.each([useOfflineSTT, useHybridMode])(
  'keeps WASAPI system capture outside the browser microphone lease',
  async (useProvider) => {
    harness.settings.audioSource = 'system';
    await useProvider().start();
    expect(harness.lease).not.toHaveBeenCalled();
  },
);
