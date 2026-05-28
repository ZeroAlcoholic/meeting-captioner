/**
 * AudioWorklet processor: accumulates 128-sample frames from the audio engine
 * into 4096-sample (256ms @ 16kHz) chunks, then transfers them to the main
 * thread as Float32 ArrayBuffers for WebSocket transmission to services/offline.
 *
 * Runs in the AudioWorkletGlobalScope (dedicated audio thread), not the main thread.
 * This replaces ScriptProcessorNode which ran on the main thread and could drop
 * audio frames during React re-renders or garbage collection.
 *
 * Ring-buffer design: _buf is pre-allocated and reused across frames. One new
 * Float32Array is allocated per emitted chunk (every 32 frames / 256 ms) rather
 * than on every 128-sample process() call (~125 Hz). This cuts GC pressure on the
 * audio thread by ~32× compared to the previous append-and-slice approach.
 */
class PcmWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunkSize = 4096;
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
        // This is the only allocation in the hot path: once per 256ms, not per frame.
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
