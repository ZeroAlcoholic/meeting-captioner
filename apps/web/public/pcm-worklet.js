/**
 * AudioWorklet processor: accumulates 128-sample frames from the audio engine
 * into 4096-sample (256ms @ 16kHz) chunks, then transfers them to the main
 * thread as Float32 ArrayBuffers for WebSocket transmission to services/offline.
 *
 * Runs in the AudioWorkletGlobalScope (dedicated audio thread), not the main thread.
 * This replaces ScriptProcessorNode which ran on the main thread and could drop
 * audio frames during React re-renders or garbage collection.
 */
class PcmWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._pending = new Float32Array(0);
    this._chunkSize = 4096;
  }

  process(inputs) {
    const channel = inputs[0]?.[0]; // mono channel, 128 samples per call
    if (!channel || channel.length === 0) return true;

    // Append incoming frame to pending buffer
    const merged = new Float32Array(this._pending.length + channel.length);
    merged.set(this._pending);
    merged.set(channel, this._pending.length);
    this._pending = merged;

    // Flush complete chunks to main thread via transferable ArrayBuffer
    while (this._pending.length >= this._chunkSize) {
      const chunk = this._pending.slice(0, this._chunkSize).buffer;
      this._pending = this._pending.slice(this._chunkSize);
      this.port.postMessage(chunk, [chunk]);
    }

    return true; // keep processor alive
  }
}

registerProcessor('pcm-worklet', PcmWorkletProcessor);
