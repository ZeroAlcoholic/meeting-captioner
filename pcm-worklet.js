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
    this._chunkSize = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_CHUNK_SIZE;
    this._progressOnly = options?.processorOptions?.progressOnly === true;
    // Opt-in source positions use the shared AudioContext's native sample clock,
    // never main-thread delivery time or a provider-local counter.
    this._frameMetadata = options?.processorOptions?.frameMetadata === true;
    this._startFrame = 0;
    this._nextFrame = null;
    this._buf = this._progressOnly ? null : new Float32Array(this._chunkSize);
    this._writePos = 0;
    // Optional stop handshake. Existing consumers receive only ArrayBuffers
    // unless they request this protocol; residual audio precedes the ACK.
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'flush') return;
      if (this._progressOnly) return;
      if (this._writePos > 0) {
        const tail = this._buf.slice(0, this._writePos).buffer;
        this._writePos = 0;
        this._postPcm(tail);
      }
      this.port.postMessage({ type: 'flushed' });
    };
  }

  _postPcm(pcm) {
    this.port.postMessage(
      this._frameMetadata ? { type: 'pcm', startFrame: this._startFrame, pcm } : pcm,
      [pcm],
    );
  }

  process(inputs) {
    const channel = inputs[0]?.[0]; // mono channel, 128 samples per call
    if (!channel || channel.length === 0) return true;
    if (this._progressOnly) {
      this._writePos += channel.length;
      if (this._writePos >= this._chunkSize) {
        this.port.postMessage({ type: 'capture_progress', samples: this._writePos });
        this._writePos = 0;
      }
      return true;
    }

    if (this._frameMetadata) {
      // A disconnected input can resume on a later render quantum. Preserve
      // both real ranges rather than joining their PCM across the missing time.
      if (this._writePos > 0 && this._nextFrame !== currentFrame) {
        this._postPcm(this._buf.slice(0, this._writePos).buffer);
        this._writePos = 0;
      }
      this._nextFrame = currentFrame + channel.length;
    }
    let frameOff = 0;
    while (frameOff < channel.length) {
      if (this._frameMetadata && this._writePos === 0) this._startFrame = currentFrame + frameOff;
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
        this._postPcm(sendBuf);
      }
    }

    return true; // keep processor alive
  }
}

registerProcessor('pcm-worklet', PcmWorkletProcessor);
