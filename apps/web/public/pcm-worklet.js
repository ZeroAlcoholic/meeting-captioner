/**
 * AudioWorklet processor: accumulates 128-sample frames from the audio engine
 * into fixed-size chunks, then transfers them to the main thread as Float32
 * ArrayBuffers for WebSocket transmission (services/offline + Gemini Live).
 *
 * Runs in the AudioWorkletGlobalScope (dedicated audio thread), not the main thread.
 * This replaces ScriptProcessorNode which ran on the main thread and could drop
 * audio frames during React re-renders or garbage collection.
 *
 * Ring-buffer design: _buf is pre-allocated and reused across frames. One new
 * Float32Array is allocated per emitted chunk rather than on every 128-sample
 * process() call (~125 Hz). This cuts GC pressure on the audio thread.
 *
 * Chunk size is configurable via `processorOptions.chunkSize` (samples @ 16 kHz),
 * defaulting to 4096 (256 ms) for backward compatibility. The chunk size sets the
 * FRONT-OF-PIPE latency: every audio packet waits to fill before it leaves the
 * browser, so this delay is added to the realtime caption/translation path before
 * the network or model is even involved. The offline/WhisperLiveKit path keeps the
 * larger 4096 default (its streaming policy is tuned for it); the Gemini Live path
 * passes a smaller value (e.g. 1024 = 64 ms) to cut translation latency.
 */
const DEFAULT_CHUNK_SIZE = 4096;

class PcmWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requested = options && options.processorOptions && options.processorOptions.chunkSize;
    // Guard: must be a positive integer; fall back to the default otherwise so a
    // malformed option can never wedge the audio thread with a 0/NaN-size buffer.
    this._chunkSize =
      Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_CHUNK_SIZE;
    this._buf = new Float32Array(this._chunkSize);
    this._writePos = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0]; // mono channel, 128 samples per call
    if (!channel || channel.length === 0) return true;

    let frameOff = 0;
    while (frameOff < channel.length) {
      const space = this._chunkSize - this._writePos;
      const toCopy = Math.min(space, channel.length - frameOff);
      this._buf.set(channel.subarray(frameOff, frameOff + toCopy), this._writePos);
      this._writePos += toCopy;
      frameOff += toCopy;

      if (this._writePos >= this._chunkSize) {
        // Transfer filled buffer to main thread. ArrayBuffer is neutered after
        // postMessage transfer, so allocate a fresh one for the next chunk.
        // This is the only allocation in the hot path: once per chunk, not per frame.
        const sendBuf = this._buf.buffer;
        this._buf = new Float32Array(this._chunkSize);
        this._writePos = 0;
        this.port.postMessage(sendBuf, [sendBuf]);
      }
    }

    return true; // keep processor alive
  }
}

registerProcessor('pcm-worklet', PcmWorkletProcessor);
