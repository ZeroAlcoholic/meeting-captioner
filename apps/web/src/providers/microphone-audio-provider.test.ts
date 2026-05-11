import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthEvent } from '@meeting-audio/contracts';
import { MicrophoneAudioProvider } from './microphone-audio-provider.js';

function fakeStream(): MediaStream {
  return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
}

function fakeAudioContext(_stream: MediaStream): typeof AudioContext {
  return class {
    createMediaStreamSource() {
      return { connect() {} };
    }
    createAnalyser() {
      return { fftSize: 2048, connect() {} } as unknown as AnalyserNode;
    }
    close() {
      return Promise.resolve();
    }
  } as unknown as typeof AudioContext;
}

describe('MicrophoneAudioProvider', () => {
  let provider: MicrophoneAudioProvider;
  let events: HealthEvent[];

  beforeEach(() => {
    provider = new MicrophoneAudioProvider();
    events = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits requesting_permission then connected on success', async () => {
    const stream = fakeStream();
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    vi.stubGlobal('AudioContext', fakeAudioContext(stream));

    const result = await provider.acquire((e) => events.push(e));

    expect(events[0]!.state).toBe('requesting_permission');
    expect(events[1]!.state).toBe('connected');
    expect(events).toHaveLength(2);
    expect(result).toBe(stream);
    expect(provider.analyser).not.toBeNull();
  });

  it('emits requesting_permission then failed when getUserMedia rejects', async () => {
    const permissionError = new Error('NotAllowedError');
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(permissionError) },
    });

    await expect(provider.acquire((e) => events.push(e))).rejects.toThrow('NotAllowedError');
    expect(events[0]!.state).toBe('requesting_permission');
    expect(events[1]!.state).toBe('failed');
    expect(events[1]!.message).toContain('NotAllowedError');
  });

  it('release() stops all tracks and clears analyser', async () => {
    const stopFn = vi.fn();
    const stream = { getTracks: () => [{ stop: stopFn }] } as unknown as MediaStream;
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    vi.stubGlobal('AudioContext', fakeAudioContext(stream));

    await provider.acquire((e) => events.push(e));
    provider.release();

    expect(stopFn).toHaveBeenCalled();
    expect(provider.analyser).toBeNull();
  });
});
