import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTranscriptionVad } from './transcription-vad.js';

class WorkerDouble {
  static current: WorkerDouble;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  messages: Array<{ type: string; frame?: Float32Array }> = [];
  constructor() {
    WorkerDouble.current = this;
  }
  postMessage(message: { type: string; frame?: Float32Array }, transfer: Transferable[] = []) {
    this.messages.push(structuredClone(message, { transfer }));
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}
beforeEach(() => {
  vi.stubGlobal('Worker', WorkerDouble);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function ready(signal = new AbortController().signal) {
  const opening = createTranscriptionVad(signal);
  WorkerDouble.current.reply({ type: 'ready' });
  return opening;
}
describe('VAD worker ownership', () => {
  it('transfers a copy, preserving captured PCM, and supports consecutive inference', async () => {
    const model = await ready();
    const frame = new Float32Array(512).fill(0.25);
    for (const probability of [0.8, 0.1]) {
      const result = model.process(frame);
      expect(WorkerDouble.current.messages.at(-1)?.frame).toEqual(frame);
      expect(frame.byteLength).toBe(2048);
      WorkerDouble.current.reply({ type: 'result', isSpeech: probability });
      await expect(result).resolves.toEqual({ isSpeech: probability });
    }
    await model.release();
    await model.release();
    expect(WorkerDouble.current.terminate).toHaveBeenCalledTimes(1);
  });
  it('cancels initialization and rejects late ready', async () => {
    const controller = new AbortController();
    const opening = createTranscriptionVad(controller.signal);
    const late = WorkerDouble.current.onmessage!;
    controller.abort();
    late({ data: { type: 'ready' } } as MessageEvent);
    await expect(opening).rejects.toThrow(/cancelled/);
    expect(WorkerDouble.current.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels inference without accepting a late probability', async () => {
    const controller = new AbortController();
    const model = await ready(controller.signal);
    const result = model.process(new Float32Array(512));
    const late = WorkerDouble.current.onmessage!;
    controller.abort();
    late({ data: { type: 'result', isSpeech: 1 } } as MessageEvent);
    await expect(result).rejects.toThrow(/cancelled/);
    await expect(model.process(new Float32Array(512))).rejects.toThrow(/disposed/);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not create a worker for an already cancelled request', async () => {
    const constructor = vi.fn();
    vi.stubGlobal('Worker', constructor);
    const controller = new AbortController();
    controller.abort();
    await expect(createTranscriptionVad(controller.signal)).rejects.toThrow();
    expect(constructor).not.toHaveBeenCalled();
  });
  it('bounds initialization and terminates the owner on timeout', async () => {
    const check = expect(createTranscriptionVad(new AbortController().signal)).rejects.toThrow(
      /timed out/,
    );
    await vi.advanceTimersByTimeAsync(15000);
    await check;
    expect(WorkerDouble.current.terminate).toHaveBeenCalledTimes(1);
  });
  it('bounds inference even when the worker stops replying', async () => {
    const model = await ready();
    const check = expect(model.process(new Float32Array(512))).rejects.toThrow(/audio gap/);
    await vi.advanceTimersByTimeAsync(2000);
    await check;
    expect(WorkerDouble.current.terminate).toHaveBeenCalledTimes(1);
  });
  it('rejects concurrent calls without overwriting the pending result', async () => {
    const model = await ready();
    const first = model.process(new Float32Array(512));
    await expect(model.process(new Float32Array(512))).rejects.toThrow(/Concurrent/);
    WorkerDouble.current.reply({ type: 'result', isSpeech: 0.4 });
    await expect(first).resolves.toEqual({ isSpeech: 0.4 });
    await model.release();
  });
  it.each([NaN, -0.1, 1.1, undefined])('rejects invalid model probability %s', async (isSpeech) => {
    const model = await ready();
    const result = model.process(new Float32Array(512));
    WorkerDouble.current.reply({ type: 'result', isSpeech });
    await expect(result).rejects.toThrow(/Invalid/);
    expect(WorkerDouble.current.terminate).toHaveBeenCalledTimes(1);
  });
  it.each(['onerror', 'onmessageerror'] as const)(
    'settles pending inference on %s',
    async (event) => {
      const model = await ready();
      const result = model.process(new Float32Array(512));
      WorkerDouble.current[event]!();
      await expect(result).rejects.toThrow(/failed/);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
