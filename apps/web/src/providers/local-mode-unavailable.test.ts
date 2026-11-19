import { afterEach, expect, it, vi } from 'vitest';
import { useHybridMode, useOfflineSTT } from './local-mode-unavailable.js';

afterEach(() => vi.unstubAllGlobals());

it.each([useOfflineSTT, useHybridMode])(
  'unavailable local capabilities refuse Start without side effects',
  async (useMode) => {
    const network = vi.fn(() => {
      throw new Error('Unexpected network access');
    });
    const capture = vi.fn(() => {
      throw new Error('Unexpected capture');
    });
    vi.stubGlobal('fetch', network);
    vi.stubGlobal('WebSocket', network);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: capture } });
    const capability = useMode();
    expect(capability.hasWhisper).toBe(false);
    expect(capability.whisperStatus).toBe('unavailable');
    await expect(capability.start()).rejects.toThrow('未包含地端處理');
    capability.stop();
    expect(network).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  },
);
