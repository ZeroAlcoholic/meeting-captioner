import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthEvent } from '@meeting-audio/contracts';
import { MicrophoneAudioProvider } from './microphone-audio-provider.js';

function fakeStream(): MediaStream {
  return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
}

function fakeAudioContext(_stream: MediaStream): typeof AudioContext {
  return class {
    state: AudioContextState = 'running';
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
  it('pins an explicitly selected microphone with exact deviceId and never retries default', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('unplugged', 'NotFoundError'));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const selected = new MicrophoneAudioProvider('meeting', 'usb-mic');
    await expect(selected.acquire(() => {})).rejects.toThrow('unplugged');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0]?.[0].audio.deviceId).toEqual({ exact: 'usb-mic' });
  });
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

describe('MicrophoneAudioProvider resume ownership', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  function setup(resume: () => Promise<void>) {
    const stop = vi.fn();
    const track = { stop, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
      getVideoTracks: () => [],
    } as unknown as MediaStream;
    const context = {
      state: 'suspended',
      resume,
      close: vi.fn().mockResolvedValue(undefined),
      createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
      createAnalyser: () => ({ fftSize: 2048, disconnect() {} }),
    };
    vi.stubGlobal('AudioContext', vi.fn().mockReturnValue(context));
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
        getDisplayMedia: vi.fn().mockResolvedValue(stream),
      },
    });
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    return { stop, context };
  }

  it('does not report connected until resume actually completes', async () => {
    let resume!: () => void;
    const native = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const { context } = setup(() => native);
    const provider = new MicrophoneAudioProvider();
    const events: HealthEvent[] = [];
    let finished = false;
    const starting = provider
      .acquire((event) => events.push(event))
      .then(() => {
        finished = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    const finishedBeforeResume = finished;
    const connectedBeforeResume = events.some((event) => event.state === 'connected');
    context.state = 'running';
    resume();
    await starting;
    expect(events.at(-1)?.state).toBe('connected');
    provider.release();
    expect(finishedBeforeResume).toBe(false);
    expect(connectedBeforeResume).toBe(false);
  });

  it('releases tracks and reports failure when native resume rejects', async () => {
    const { stop } = setup(() => Promise.reject(new Error('resume denied')));
    const provider = new MicrophoneAudioProvider();
    const events: HealthEvent[] = [];
    await expect(provider.acquire((event) => events.push(event))).rejects.toThrow('resume denied');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(provider.analyser).toBeNull();
    expect(events.at(-1)?.state).toBe('failed');
    expect(events.some((event) => event.state === 'connected')).toBe(false);
  });

  it.each([false, true])(
    'visibility resume failure respects released ownership: %s',
    async (released) => {
      vi.useFakeTimers();
      let rejectResume!: (error: Error) => void;
      const native = new Promise<void>((_resolve, reject) => {
        rejectResume = reject;
      });
      const { context, stop } = setup(() => native);
      context.state = 'running';
      const provider = new MicrophoneAudioProvider();
      const events: HealthEvent[] = [];
      await provider.acquire((event) => events.push(event));
      context.state = 'suspended';
      const visibility = vi
        .mocked(document.addEventListener)
        .mock.calls.find((call) => call[0] === 'visibilitychange')?.[1] as EventListener;
      visibility(new Event('visibilitychange'));
      if (released) provider.release();
      rejectResume(new Error('visibility resume denied'));
      await vi.advanceTimersByTimeAsync(0);
      expect(events.filter((event) => event.state === 'failed')).toHaveLength(released ? 0 : 1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('release cancels a pending resume and suppresses late connected', async () => {
    vi.useFakeTimers();
    let resume!: () => void;
    const native = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const { context, stop } = setup(() => native);
    const provider = new MicrophoneAudioProvider();
    const events: HealthEvent[] = [];
    let finished = false;
    const starting = provider
      .acquire((event) => events.push(event))
      .then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
    await vi.advanceTimersByTimeAsync(1);
    provider.release();
    await vi.advanceTimersByTimeAsync(1);
    expect(finished).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    context.state = 'running';
    resume();
    await starting;
    expect(events.some((event) => event.state === 'connected')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
