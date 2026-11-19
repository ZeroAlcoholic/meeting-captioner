import { afterEach, expect, it, vi } from 'vitest';
import { createCaptureAudioRetention } from './capture-audio-retention.js';
import { RecoveryTimeoutError } from './recovery-attempt.js';

const state = vi.hoisted(() => ({
  rate: 16000,
  source: { connect: vi.fn(), disconnect: vi.fn() },
  resume: vi.fn(async (_signal: AbortSignal) => {}),
  ensure: vi.fn(async () => {}),
}));
vi.mock('./audio-engine.js', () => ({
  getCaptureContext: () => ({
    sampleRate: state.rate,
    createMediaStreamSource: () => state.source,
    destination: {},
  }),
  ensureCaptureWorklet: () => state.ensure(),
  resumeCaptureContext: (signal: AbortSignal) => state.resume(signal),
}));
class Worklet {
  static current: Worklet;
  port = { onmessage: null as ((event: { data: unknown }) => void) | null, close: vi.fn() };
  constructor(readonly context: AudioContext) {
    Worklet.current = this;
  }
  connect() {}
  disconnect = vi.fn();
  push(pcm: Float32Array) {
    this.port.onmessage?.({ data: pcm.buffer as ArrayBuffer });
  }
  pushTimed(pcm: Float32Array, startFrame: number) {
    this.port.onmessage?.({ data: { type: 'pcm', startFrame, pcm: pcm.buffer } });
  }
}

it.each([16000, 48000])(
  'maps only aligned native-clock ranges to retained PCM at %s Hz',
  async (rate) => {
    state.rate = rate;
    vi.stubGlobal('AudioWorkletNode', Worklet);
    const capture = await createCaptureAudioRetention(
      {} as MediaStream,
      'mic',
      new AbortController().signal,
    );
    const node = Worklet.current;
    const count = (1024 * rate) / 16000;
    node.pushTimed(
      Float32Array.from({ length: count }, (_, i) => i / count),
      1000,
    );
    const range = capture.rangeForNativeFrames(
      node.context,
      1000 + (512 * rate) / 16000,
      1000 + count,
    );
    expect(range).toMatchObject({ trackId: 'mic', from: 512, to: 1024 });
    const retained = capture.buffer.read(capture.buffer.retainedRange!).frames[0]!.pcm;
    expect(capture.buffer.read(range!).frames[0]!.pcm).toEqual(retained.slice(512));
    expect(capture.rangeForNativeFrames({} as AudioContext, 1000, 1000 + count)).toBeNull();
    expect(capture.rangeForNativeFrames(node.context, 999, 1000 + count)).toBeNull();
    expect(capture.rangeForNativeFrames(node.context, 1000, 1001 + count)).toBeNull();
    if (rate === 48000)
      expect(capture.rangeForNativeFrames(node.context, 1001, 1000 + count)).toBeNull();
    capture.dispose();
    expect(capture.rangeForNativeFrames(node.context, 1000, 1000 + count)).toBeNull();
  },
);

it('retains audio but refuses precise alignment after missing native frames or legacy packets', async () => {
  vi.stubGlobal('AudioWorkletNode', Worklet);
  const capture = await createCaptureAudioRetention(
    {} as MediaStream,
    'mic',
    new AbortController().signal,
  );
  const node = Worklet.current;
  node.pushTimed(new Float32Array(512).fill(0.25), 1000);
  expect(capture.rangeForNativeFrames(node.context, 1000, 1512)).not.toBeNull();
  node.pushTimed(new Float32Array(512).fill(0.5), 2000);
  expect(capture.buffer.retainedRange).toMatchObject({ from: 0, to: 1024 });
  expect(capture.rangeForNativeFrames(node.context, 1000, 1512)).toBeNull();
  capture.dispose();
  const legacy = await createCaptureAudioRetention(
    {} as MediaStream,
    'mic',
    new AbortController().signal,
  );
  Worklet.current.push(new Float32Array(512));
  expect(legacy.buffer.retainedRange).toMatchObject({ from: 0, to: 512 });
  expect(legacy.rangeForNativeFrames(Worklet.current.context, 0, 512)).toBeNull();
  legacy.dispose();
});

it('does not assume an exact clock ratio when the resampler rounds native frame consumption', async () => {
  state.rate = 44100;
  vi.stubGlobal('AudioWorkletNode', Worklet);
  const capture = await createCaptureAudioRetention(
    {} as MediaStream,
    'mic',
    new AbortController().signal,
  );
  const node = Worklet.current;
  // The existing resampler consumes ceil(512 * 44100 / 16000) = 1412 per frame,
  // so five output frames consumed 7060 native samples, not the ideal 7056.
  node.pushTimed(new Float32Array(7060).fill(0.25), 1000);
  expect(capture.buffer.retainedRange).toMatchObject({ from: 0, to: 2560 });
  expect(capture.rangeForNativeFrames(node.context, 1000, 8056)).toBeNull();
  capture.dispose();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
  state.rate = 16000;
  state.ensure.mockReset().mockResolvedValue(undefined);
});

it('retries one timed-out module wait before creating a single retention graph', async () => {
  vi.stubGlobal('AudioWorkletNode', Worklet);
  state.ensure.mockRejectedValueOnce(new RecoveryTimeoutError('AudioWorklet loading timed out'));
  const retry = vi.fn();
  const signal = new AbortController();
  const capture = await createCaptureAudioRetention(
    { getAudioTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream,
    'mic',
    signal.signal,
    undefined,
    retry,
  );
  expect(state.ensure).toHaveBeenCalledTimes(2);
  expect(retry).toHaveBeenCalledOnce();
  expect(state.source.connect).toHaveBeenCalledOnce();
  capture.dispose();
});

it('does not retry indefinitely or retry permanent initialization errors', async () => {
  vi.stubGlobal('AudioWorkletNode', Worklet);
  state.ensure.mockRejectedValue(new RecoveryTimeoutError('AudioWorklet loading timed out'));
  await expect(
    createCaptureAudioRetention(
      { getAudioTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream,
      'mic',
      new AbortController().signal,
    ),
  ).rejects.toThrow('timed out');
  expect(state.ensure).toHaveBeenCalledTimes(2);
  expect(state.source.connect).not.toHaveBeenCalled();
  state.ensure.mockReset().mockRejectedValue(new Error('Unsupported worklet'));
  await expect(
    createCaptureAudioRetention(
      { getAudioTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream,
      'mic',
      new AbortController().signal,
    ),
  ).rejects.toThrow('Unsupported');
  expect(state.ensure).toHaveBeenCalledOnce();
});

it('Stop during retry notification cancels initialization before another wait or graph', async () => {
  vi.stubGlobal('AudioWorkletNode', Worklet);
  const signal = new AbortController();
  state.ensure.mockRejectedValueOnce(new RecoveryTimeoutError('AudioWorklet loading timed out'));
  await expect(
    createCaptureAudioRetention(
      { getAudioTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream,
      'mic',
      signal.signal,
      undefined,
      () => signal.abort(),
    ),
  ).rejects.toThrow();
  expect(state.ensure).toHaveBeenCalledOnce();
  expect(state.source.connect).not.toHaveBeenCalled();
});

it('does not invent samples during a wall-clock pause with no worklet frames', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('AudioWorkletNode', Worklet);
  const signal = new AbortController();
  const capture = await createCaptureAudioRetention({} as MediaStream, 'mic', signal.signal);
  Worklet.current.push(new Float32Array(512).fill(0.25));
  const before = capture.buffer.retainedRange;
  vi.advanceTimersByTime(120_000);
  expect(capture.buffer.retainedRange).toEqual(before);
  Worklet.current.push(new Float32Array(512).fill(0.5));
  expect(capture.buffer.retainedRange).toMatchObject({ from: 0, to: 1024 });
  expect(capture.buffer.read(capture.buffer.retainedRange!).frames[0]!.pcm).toEqual(
    Float32Array.from({ length: 1024 }, (_, i) => (i < 512 ? 0.25 : 0.5)),
  );
  signal.abort();
});

it('retains exact PCM before any provider consumer and clears on cancellation', async () => {
  vi.stubGlobal('AudioWorkletNode', Worklet);
  const signal = new AbortController();
  const capture = await createCaptureAudioRetention({} as MediaStream, 'mic', signal.signal);
  const pcm = Float32Array.from({ length: 1024 }, (_, i) => i / 1024);
  Worklet.current.push(pcm);
  const range = capture.buffer.retainedRange!;
  expect(range).toMatchObject({ trackId: 'mic', from: 0, to: 1024 });
  expect(capture.buffer.read(range).frames[0]!.pcm).toEqual(pcm);
  signal.abort();
  expect(capture.buffer.retainedRange).toBeNull();
  expect(Worklet.current.port.close).toHaveBeenCalledOnce();
  expect(state.source.disconnect).toHaveBeenCalledOnce();
  Worklet.current.push(pcm);
  expect(capture.buffer.retainedRange).toBeNull();
  capture.dispose();
  expect(Worklet.current.port.close).toHaveBeenCalledOnce();
});

it('does not reconnect a late resume after cancellation', async () => {
  vi.stubGlobal('AudioWorkletNode', Worklet);
  let finish!: () => void;
  state.resume.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const signal = new AbortController();
  const creating = createCaptureAudioRetention({} as MediaStream, 'mic', signal.signal);
  const rejected = expect(creating).rejects.toThrow();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const node = Worklet.current;
  signal.abort();
  finish();
  await rejected;
  expect(node.port.onmessage).toBeNull();
  expect(node.disconnect).toHaveBeenCalledOnce();
});
