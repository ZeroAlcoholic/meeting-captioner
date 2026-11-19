/** One model/worker owner; the audio adapter already serializes its bounded queue. */
export async function createTranscriptionVad(signal: AbortSignal) {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./transcription-vad.worker.ts', import.meta.url), {
    type: 'module',
  });
  let disposed = false;
  let pending: {
    type: 'ready' | 'result';
    resolve(value: number): void;
    reject(error: Error): void;
  } | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const dispose = (error = new Error('VAD worker disposed')) => {
    if (disposed) return;
    disposed = true;
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    const current = pending;
    pending = null;
    current?.reject(error);
  };
  const abort = () => dispose(new DOMException('VAD cancelled', 'AbortError'));
  signal.addEventListener('abort', abort, { once: true });
  worker.onerror = () => dispose(new Error('VAD worker execution failed'));
  worker.onmessageerror = () => dispose(new Error('VAD worker message failed'));
  worker.onmessage = (
    event: MessageEvent<{ type: string; isSpeech?: number; message?: string }>,
  ) => {
    if (!pending || disposed) return;
    if (event.data.type === 'error') {
      dispose(new Error(event.data.message ?? 'VAD failed'));
      return;
    }
    const value = event.data.isSpeech;
    if (
      event.data.type !== pending.type ||
      (pending.type === 'result' &&
        (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1))
    ) {
      dispose(new Error('Invalid VAD worker response'));
      return;
    }
    clearTimeout(deadline);
    const current = pending;
    pending = null;
    current.resolve(value ?? 0);
  };
  const request = (frame?: Float32Array): Promise<number> => {
    if (disposed) return Promise.reject(new Error('VAD worker disposed'));
    if (pending) return Promise.reject(new Error('Concurrent VAD inference is unsupported'));
    return new Promise((resolve, reject) => {
      pending = { type: frame ? 'result' : 'ready', resolve, reject };
      deadline = setTimeout(
        () => dispose(new Error('VAD worker timed out; audio gap')),
        frame ? 2000 : 15000,
      );
      try {
        if (frame) {
          // The original samples still belong to the caption/PCM path after inference.
          const copy = frame.slice();
          worker.postMessage({ type: 'process', frame: copy }, [copy.buffer]);
        } else worker.postMessage({ type: 'initialize' });
      } catch (error) {
        dispose(error instanceof Error ? error : new Error('VAD worker send failed'));
      }
    });
  };
  await request();
  return {
    async process(frame: Float32Array) {
      return { isSpeech: await request(frame) };
    },
    async release() {
      dispose();
    },
  };
}
