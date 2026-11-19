import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTranscriptionAudio } from './transcription-audio.js';

const state = vi.hoisted(() => ({
  rate: 16000,
  model: {
    process: vi.fn(async (_frame: Float32Array) => ({ isSpeech: 0.9, notSpeech: 0.1 })),
    release: vi.fn(async () => {}),
    reset_state: vi.fn(),
  },
  source: { connect: vi.fn(), disconnect: vi.fn() },
}));
vi.mock('./audio-engine.js', () => ({
  getCaptureContext: () => ({
    state: 'running',
    sampleRate: state.rate,
    createMediaStreamSource: () => state.source,
    destination: {},
  }),
  ensureCaptureWorklet: async () => {},
  resumeCaptureContext: async () => {},
}));
vi.mock('./transcription-vad.js', () => ({
  createTranscriptionVad: async () => state.model,
}));

class Worklet {
  static current: Worklet;
  tail = new Float32Array(0);
  port = {
    onmessage: null as
      | ((event: {
          data: ArrayBuffer | { type: string; startFrame?: number; pcm?: ArrayBuffer };
        }) => void)
      | null,
    close: vi.fn(),
    postMessage: vi.fn((_message: unknown) => {
      if (this.tail.length) this.port.onmessage?.({ data: this.tail.buffer });
      this.port.onmessage?.({ data: { type: 'flushed' } });
    }),
  };
  constructor() {
    Worklet.current = this;
  }
  connect() {}
  disconnect() {}
  push(frame: Float32Array) {
    this.port.onmessage?.({ data: frame.buffer as ArrayBuffer });
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  state.rate = 16000;
});
describe('native audio adapter boundaries (model mocked)', () => {
  it('rechecks the same source interval after VAD when the retention port arrives later', async () => {
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const range = { trackId: 'mic', captureEpoch: 'capture-1', from: 512, to: 1024 };
    const map = vi.fn<() => typeof range | null>().mockReturnValueOnce(null).mockReturnValue(range);
    const onFrame = vi.fn();
    const audio = await createTranscriptionAudio(
      {} as MediaStream,
      { onFrame, onError: vi.fn() },
      new AbortController().signal,
      map,
    );
    Worklet.current.port.onmessage?.({
      data: { type: 'pcm', startFrame: 1000, pcm: new Float32Array(512).buffer },
    });
    await audio.pause();
    expect(map).toHaveBeenCalledTimes(2);
    expect(map.mock.calls[0]).toEqual(map.mock.calls[1]);
    expect(onFrame.mock.calls[0]?.[3]).toEqual(range);
    audio.dispose();
  });
  it('does not claim model-padding samples as an exact captured range', async () => {
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const map = vi.fn();
    const onFrame = vi.fn();
    const audio = await createTranscriptionAudio(
      {} as MediaStream,
      { onFrame, onError: vi.fn() },
      new AbortController().signal,
      map,
    );
    Worklet.current.port.onmessage?.({
      data: { type: 'pcm', startFrame: 1000, pcm: new Float32Array(384).buffer },
    });
    await audio.pause();
    expect(onFrame.mock.calls[0]?.[0]).toHaveLength(384);
    expect(onFrame.mock.calls[0]?.[3]).toBeNull();
    expect(map).not.toHaveBeenCalled();
    audio.dispose();
  });
  it.each([16000, 48000])('carries native-clock provenance through VAD at %s Hz', async (rate) => {
    state.rate = rate;
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const onFrame = vi.fn();
    const range = { trackId: 'mic', captureEpoch: 'capture-1', from: 1024, to: 1536 };
    const map = vi.fn(() => range);
    const audio = await createTranscriptionAudio(
      {} as MediaStream,
      { onFrame, onError: vi.fn() },
      new AbortController().signal,
      map,
    );
    const pcm = new Float32Array((512 * rate) / 16000);
    Worklet.current.port.onmessage?.({ data: { type: 'pcm', startFrame: 4000, pcm: pcm.buffer } });
    await audio.pause();
    expect(map).toHaveBeenCalledWith(expect.anything(), 4000, 4000 + pcm.length);
    expect(onFrame).toHaveBeenCalledWith(expect.any(Float32Array), 0.9, expect.any(Number), range);
    audio.dispose();
  });
  it('monitors actual PCM before VAD and disposes on Pause', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const onHealth = vi.fn();
    const audio = await createTranscriptionAudio(
      { getAudioTracks: () => [] } as unknown as MediaStream,
      { onFrame: vi.fn(), onError: vi.fn(), onHealth },
      new AbortController().signal,
    );
    vi.advanceTimersByTime(2000);
    expect(onHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: 'capture_stalled' }),
    );
    Worklet.current.push(new Float32Array(512));
    expect(onHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: 'capture_resumed' }),
    );
    await audio.pause();
    onHealth.mockClear();
    vi.advanceTimersByTime(3000);
    expect(onHealth).not.toHaveBeenCalled();
    audio.dispose();
    vi.useRealTimers();
  });
  it('rejects a capture rate outside the mature resampler supported range', async () => {
    state.rate = 8000;
    await expect(
      createTranscriptionAudio(
        {} as MediaStream,
        { onFrame: vi.fn(), onError: vi.fn() },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/sample rate/);
  });
  it('drains worklet plus resampler residual without sending model padding as captured audio', async () => {
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const callbacks = { onFrame: vi.fn(), onError: vi.fn() };
    const audio = await createTranscriptionAudio(
      {} as MediaStream,
      callbacks,
      new AbortController().signal,
    );
    Worklet.current.push(new Float32Array(256).fill(0.2));
    Worklet.current.tail = new Float32Array(128).fill(0.3);
    await audio.pause();
    expect(state.source.disconnect).toHaveBeenCalled();
    expect(state.model.process.mock.calls[0]?.[0]).toHaveLength(512);
    expect(callbacks.onFrame.mock.calls[0]?.[0]).toHaveLength(384);
    expect(callbacks.onError).not.toHaveBeenCalled();
    audio.dispose();
  });
  it('uses actual48kHz capture rate for16kHz model frames', async () => {
    state.rate = 48000;
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const callbacks = { onFrame: vi.fn(), onError: vi.fn() };
    const audio = await createTranscriptionAudio(
      {} as MediaStream,
      callbacks,
      new AbortController().signal,
    );
    Worklet.current.push(new Float32Array(1536).fill(0.3));
    await audio.pause();
    expect(callbacks.onFrame).toHaveBeenCalledTimes(1);
    expect(callbacks.onFrame.mock.calls[0]?.[0]).toHaveLength(512);
    audio.dispose();
  });
  it('fails visibly at bounded inference backlog instead of dropping silently', async () => {
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const callbacks = { onFrame: vi.fn(), onError: vi.fn() };
    const audio = await createTranscriptionAudio(
      {} as MediaStream,
      callbacks,
      new AbortController().signal,
    );
    for (let i = 0; i < 65; i++) Worklet.current.push(new Float32Array(512));
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('audio gap') }),
    );
    await audio.pause();
    expect(callbacks.onFrame).not.toHaveBeenCalled();
    audio.dispose();
  });
});
