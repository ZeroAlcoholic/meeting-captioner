import {
  ensureCaptureWorklet,
  getCaptureContext,
  resumeCaptureContext,
  type CapturedPcmChunk,
} from './audio-engine.js';
import type { HealthEvent } from '@meeting-audio/contracts';
import { monitorCaptureHealth } from './capture-health.js';
import { createTranscriptionVad } from './transcription-vad.js';
import type { AudioSource } from './types.js';
import type { SampleRange } from './meeting-audio-buffer.js';

export interface TranscriptionAudio {
  /** Disconnect synchronously, then drain already captured frames. */
  pause(): Promise<void>;
  dispose(): void;
}
export interface TranscriptionAudioCallbacks {
  onFrame(
    frame: Float32Array,
    probability: number,
    startMs: number,
    range?: SampleRange | null,
  ): void;
  onError(error: Error): void;
  onHealth?(event: HealthEvent): void;
}
export type TranscriptionAudioFactory = (
  stream: MediaStream,
  callbacks: TranscriptionAudioCallbacks,
  signal: AbortSignal,
  mapCaptureRange?: AudioSource['captureRangeForNativeFrames'],
) => Promise<TranscriptionAudio>;

/** Silero state survives frames; unlike MicVAD we never accumulate whole speech audio. */
export const createTranscriptionAudio: TranscriptionAudioFactory = async (
  stream,
  callbacks,
  signal,
  mapCaptureRange,
) => {
  const ctx = getCaptureContext();
  if (!ctx) throw new Error('AudioContext unavailable');
  if (!Number.isFinite(ctx.sampleRate) || ctx.sampleRate < 16000)
    throw new Error('Unsupported capture sample rate for transcription VAD');
  const { Resampler } = await import('@ricky0123/vad-web/dist/resampler');
  const model = await createTranscriptionVad(signal);
  let disposed = false;
  let paused = false;
  let processing: Promise<void> = Promise.resolve();
  let outstanding = 0;
  let samples = 0;
  let origin = 0;
  let nativeOrigin: number | null = null;
  let nextNativeFrame: number | null = null;
  let clockAligned = Number.isInteger(ctx.sampleRate / 16000);
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let captureHealth: ReturnType<typeof monitorCaptureHealth> | undefined;
  let acknowledgeFlush: (() => void) | undefined;
  let rejectFlush: ((error: Error) => void) | undefined;
  let pausing: Promise<void> | undefined;
  const disconnect = () => {
    captureHealth?.dispose();
    paused = true;
    if (node) {
      node.port.onmessage = null;
      node.disconnect();
      node.port.close();
    }
    source?.disconnect();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    rejectFlush?.(new Error('Transcription audio flush cancelled'));
    disconnect();
    signal.removeEventListener('abort', dispose);
    void processing.then(() => model.release()).catch(() => {});
  };
  if (signal.aborted) {
    dispose();
    throw new Error('Transcription audio cancelled');
  }
  signal.addEventListener('abort', dispose, { once: true });
  try {
    await ensureCaptureWorklet(ctx, signal);
    await resumeCaptureContext(signal);
    if (disposed) throw new Error('Transcription audio cancelled');
    const resampler = new Resampler({
      nativeSampleRate: ctx.sampleRate,
      targetSampleRate: 16000,
      targetFrameSize: 512,
    });
    source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'pcm-worklet', {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { chunkSize: 512, frameMetadata: !!mapCaptureRange },
    });
    if (callbacks.onHealth)
      captureHealth = monitorCaptureHealth({
        context: ctx,
        stream,
        onHealth: callbacks.onHealth,
      });
    const enqueue = (frame: Float32Array, actualSamples = frame.length) => {
      if (disposed) return;
      const startMs = origin + samples / 16;
      const nativeFrom =
        nativeOrigin === null ? null : nativeOrigin + (samples * ctx.sampleRate) / 16000;
      const rangeEligible = clockAligned && actualSamples === frame.length;
      const range =
        rangeEligible && nativeFrom !== null
          ? (mapCaptureRange?.(
              ctx,
              nativeFrom,
              nativeFrom + (actualSamples * ctx.sampleRate) / 16000,
            ) ?? null)
          : null;
      samples += actualSamples;
      if (outstanding >= 64) {
        dispose();
        callbacks.onError(new Error('VAD inference backlog exceeded 2 seconds; audio gap'));
        return;
      }
      outstanding++;
      processing = processing
        .then(async () => {
          if (disposed) return;
          const probability = await model.process(frame);
          if (!disposed) {
            // Independent ports can arrive in either order. Retry this same
            // immutable source interval after VAD, never the current buffer end.
            const resolved =
              range ??
              (rangeEligible && nativeFrom !== null
                ? (mapCaptureRange?.(
                    ctx,
                    nativeFrom,
                    nativeFrom + (actualSamples * ctx.sampleRate) / 16000,
                  ) ?? null)
                : null);
            callbacks.onFrame(
              frame.subarray(0, actualSamples),
              probability.isSpeech,
              startMs,
              resolved,
            );
          }
        })
        .catch((error: unknown) => {
          if (!disposed) {
            dispose();
            callbacks.onError(error instanceof Error ? error : new Error('VAD inference failed'));
          }
        })
        .finally(() => {
          outstanding--;
        });
    };
    node.port.onmessage = (
      event: MessageEvent<ArrayBuffer | CapturedPcmChunk | { type: 'flushed' }>,
    ) => {
      if (paused || disposed) return;
      const chunk = event.data;
      if (!(chunk instanceof ArrayBuffer) && chunk?.type === 'flushed') {
        acknowledgeFlush?.();
        return;
      }
      const bytes = chunk instanceof ArrayBuffer ? chunk : chunk?.type === 'pcm' ? chunk.pcm : null;
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) return;
      if (
        chunk instanceof ArrayBuffer ||
        !Number.isSafeInteger(chunk.startFrame) ||
        chunk.startFrame < 0
      )
        clockAligned = false;
      else {
        nativeOrigin ??= chunk.startFrame;
        if (nextNativeFrame !== null && nextNativeFrame !== chunk.startFrame) clockAligned = false;
        nextNativeFrame = chunk.startFrame + bytes.byteLength / 4;
      }
      captureHealth?.frame(bytes.byteLength / 4);
      for (const frame of resampler.process(new Float32Array(bytes))) enqueue(frame);
    };
    origin = Date.now();
    source.connect(node);
    node.connect(ctx.destination);
    return {
      pause() {
        captureHealth?.dispose();
        if (pausing) return pausing;
        if (disposed) return Promise.resolve();
        // Freeze input first. Port ordering guarantees every queued PCM frame and
        // the worklet's residual samples arrive before the flush acknowledgement.
        source?.disconnect();
        pausing = (async () => {
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try {
            await new Promise<void>((resolve, reject) => {
              acknowledgeFlush = resolve;
              rejectFlush = reject;
              deadline = setTimeout(
                () => reject(new Error('Audio tail flush timed out; unfinished audio gap')),
                1000,
              );
              node!.port.postMessage({ type: 'flush' });
            });
            const remaining = resampler.inputBuffer.length;
            if (remaining > 0) {
              const actualSamples = Math.ceil((remaining * 16000) / ctx.sampleRate);
              const padding = Math.ceil((512 * ctx.sampleRate) / 16000) - remaining;
              for (const frame of resampler.process(new Float32Array(padding)))
                enqueue(frame, actualSamples);
            }
            disconnect();
            await processing;
          } finally {
            clearTimeout(deadline);
            acknowledgeFlush = undefined;
            rejectFlush = undefined;
          }
        })();
        return pausing;
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
};

/**
 * Endpointing thresholds. These dominate how late a final caption lands — the
 * silence tail alone is most of it — so they are injectable and measurable.
 * The values are not tuned here: shortening the tail also chops sentences in
 * half, and the trade-off can only be settled on real meeting audio.
 */
export interface TranscriptionGatePolicy {
  /** Speech buffered before the gate opens, so a turn does not start clipped. */
  lookBehindMs: number;
  /** Quiet needed to end a turn. */
  silenceTailMs: number;
  /** Hard bound on one turn, so an unbroken monologue still produces finals. */
  maxUtteranceMs: number;
}
export const DEFAULT_TRANSCRIPTION_GATE_POLICY: TranscriptionGatePolicy = {
  lookBehindMs: 800,
  silenceTailMs: 700,
  maxUtteranceMs: 30_000,
};

/** Sample-clock speech policy; see {@link DEFAULT_TRANSCRIPTION_GATE_POLICY}. */
export class TranscriptionSpeechGate {
  private preRoll: { frame: Float32Array; start: number; range: SampleRange | null }[] = [];
  private preRollMs = 0;
  private active = false;
  private start = 0;
  private end = 0;
  private quiet = 0;
  private continuation = false;
  private readonly policy: TranscriptionGatePolicy;
  constructor(
    private readonly append: (
      frame: Float32Array,
      startMs: number,
      continuation: boolean,
      range?: SampleRange | null,
    ) => void,
    private readonly commit: (start: number, end: number, continuation: boolean) => void,
    policy: Partial<TranscriptionGatePolicy> = {},
  ) {
    this.policy = { ...DEFAULT_TRANSCRIPTION_GATE_POLICY, ...policy };
  }
  push(
    frame: Float32Array,
    probability: number,
    startMs: number,
    range?: SampleRange | null,
  ): void {
    const duration = frame.length / 16;
    if (!this.active) {
      this.preRoll.push({ frame, start: startMs, range: range ?? null });
      this.preRollMs += duration;
      // Never trim the frame that just arrived: a look-behind shorter than one
      // frame would otherwise leave no frame to anchor the utterance start on.
      while (this.preRoll.length > 1 && this.preRollMs > this.policy.lookBehindMs)
        this.preRollMs -= this.preRoll.shift()!.frame.length / 16;
      if (probability < 0.5) return;
      this.active = true;
      this.continuation = false;
      this.start = this.preRoll[0]!.start;
      for (const entry of this.preRoll)
        this.append(entry.frame, entry.start, this.continuation, entry.range);
      this.preRoll = [];
      this.preRollMs = 0;
    } else this.append(frame, startMs, this.continuation, range);
    this.end = startMs + duration;
    this.quiet = probability >= 0.35 ? 0 : this.quiet + duration;
    if (this.quiet >= this.policy.silenceTailMs) this.finish(false);
    else if (this.end - this.start >= this.policy.maxUtteranceMs) this.finish(true);
  }
  flush(): void {
    if (this.active && this.end > this.start) this.finish(false);
  }
  private finish(continuing: boolean): void {
    this.commit(this.start, this.end, this.continuation);
    this.active = continuing;
    this.start = this.end;
    this.continuation = continuing;
    this.quiet = 0;
  }
}
