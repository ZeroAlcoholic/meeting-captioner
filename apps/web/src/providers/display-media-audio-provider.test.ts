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
