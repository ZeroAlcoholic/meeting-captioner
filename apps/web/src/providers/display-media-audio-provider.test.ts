import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthEvent } from '@meeting-audio/contracts';
import { DisplayMediaAudioProvider } from './display-media-audio-provider.js';

function fakeStream(opts: {
  audioTracks?: Array<{
    stop: ReturnType<typeof vi.fn>;
    addEventListener?: ReturnType<typeof vi.fn>;
    removeEventListener?: ReturnType<typeof vi.fn>;
  }>;
  videoTracks?: Array<{ enabled: boolean; stop: ReturnType<typeof vi.fn> }>;
}): MediaStream {
  const audio = opts.audioTracks ?? [];
  const video = opts.videoTracks ?? [];
  return {
    getAudioTracks: () => audio,
    getVideoTracks: () => video,
    getTracks: () => [...audio, ...video],
  } as unknown as MediaStream;
}

function fakeAudioContextClass(): typeof AudioContext {
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
    resume() {
      return Promise.resolve();
    }
  } as unknown as typeof AudioContext;
}

describe('DisplayMediaAudioProvider', () => {
  let provider: DisplayMediaAudioProvider;
  let events: HealthEvent[];

  beforeEach(() => {
    provider = new DisplayMediaAudioProvider();
    events = [];
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('AudioContext', fakeAudioContextClass());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits requesting_permission → connected on a stream with an audio track', async () => {
    const stream = fakeStream({
      audioTracks: [{ stop: vi.fn(), addEventListener: vi.fn() }],
      videoTracks: [{ enabled: true, stop: vi.fn() }],
    });
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(stream) },
    });

    const result = await provider.acquire((e) => events.push(e));

    expect(events[0]!.state).toBe('requesting_permission');
    expect(events[1]!.state).toBe('connected');
    expect(result).toBe(stream);
    expect(provider.analyser).not.toBeNull();
  });

  it('disables the captured video track to save CPU', async () => {
    const videoTrack = { enabled: true, stop: vi.fn() };
    const stream = fakeStream({
      audioTracks: [{ stop: vi.fn(), addEventListener: vi.fn() }],
      videoTracks: [videoTrack],
    });
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(stream) },
    });

    await provider.acquire((e) => events.push(e));

    expect(videoTrack.enabled).toBe(false);
  });

  it('throws + emits no_audio_track when user picks a window without system audio', async () => {
    const videoTrack = { enabled: true, stop: vi.fn() };
    const stream = fakeStream({
      audioTracks: [],
      videoTracks: [videoTrack],
    });
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(stream) },
    });

    await expect(provider.acquire((e) => events.push(e))).rejects.toThrow(/No audio track/);

    // requesting_permission, then no_audio_track (NOT a 'failed' state which
    // would tag the wrong root cause for the UI's actionable copy).
    expect(events[0]!.state).toBe('requesting_permission');
    expect(events[1]!.state).toBe('no_audio_track');
    expect(events[1]!.message).toMatch(/Share system audio/i);
    // The picked tracks must be torn down — leaking the video capture would
    // leave the user with an indicator running for nothing.
    expect(videoTrack.stop).toHaveBeenCalled();
  });

  it('emits failed when user dismisses the share dialog', async () => {
    const denied = new Error('NotAllowedError');
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: vi.fn().mockRejectedValue(denied) },
    });

    await expect(provider.acquire((e) => events.push(e))).rejects.toThrow('NotAllowedError');
    expect(events[0]!.state).toBe('requesting_permission');
    expect(events[1]!.state).toBe('failed');
    expect(events[1]!.message).toContain('NotAllowedError');
  });

  it('release() stops all tracks (audio + video) and clears analyser', async () => {
    const audioStop = vi.fn();
    const videoStop = vi.fn();
    const stream = fakeStream({
      audioTracks: [{ stop: audioStop, addEventListener: vi.fn(), removeEventListener: vi.fn() }],
      videoTracks: [{ enabled: true, stop: videoStop }],
    });
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(stream) },
    });

    await provider.acquire((e) => events.push(e));
    provider.release();

    expect(audioStop).toHaveBeenCalled();
    expect(videoStop).toHaveBeenCalled();
    expect(provider.analyser).toBeNull();
  });

  it('wires an ended listener on the audio track and surfaces a "stopped" health event', async () => {
    let endedHandler: (() => void) | null = null;
    const audioTrack = {
      stop: vi.fn(),
      addEventListener: vi.fn((event: string, h: () => void) => {
        if (event === 'ended') endedHandler = h;
      }),
      removeEventListener: vi.fn(),
    };
    const stream = fakeStream({
      audioTracks: [audioTrack],
      videoTracks: [{ enabled: true, stop: vi.fn() }],
    });
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(stream) },
    });

    await provider.acquire((e) => events.push(e));
    expect(endedHandler).not.toBeNull();

    // Simulate the user clicking "Stop sharing" in Chrome's screen-share banner.
    endedHandler!();

    const lastEvent = events[events.length - 1]!;
    expect(lastEvent.state).toBe('failed');
    expect(lastEvent.message).toMatch(/System audio capture stopped/i);
  });
});

describe('DisplayMediaAudioProvider resume ownership', () => {
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
    const provider = new DisplayMediaAudioProvider();
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
    const provider = new DisplayMediaAudioProvider();
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
      const provider = new DisplayMediaAudioProvider();
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
    const provider = new DisplayMediaAudioProvider();
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
