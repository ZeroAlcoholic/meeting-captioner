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
    // visibility-handler attaches to document; stub a minimal one for node env.
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
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

  it('default (meeting) profile disables AGC, NS and EC so a switched speaker is not gated', async () => {
    const stream = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.stubGlobal('AudioContext', fakeAudioContext(stream));

    // No constructor arg → 'meeting' default.
    await new MicrophoneAudioProvider().acquire((e) => events.push(e));

    const [arg] = getUserMedia.mock.calls[0] as [MediaStreamConstraints];
    expect(arg.audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  it('close profile keeps AGC/NS/EC on (single near speaker)', async () => {
    const stream = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.stubGlobal('AudioContext', fakeAudioContext(stream));

    await new MicrophoneAudioProvider('close').acquire((e) => events.push(e));

    const [arg] = getUserMedia.mock.calls[0] as [MediaStreamConstraints];
    expect(arg.audio).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
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
