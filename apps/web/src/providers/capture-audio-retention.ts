import {
  ensureCaptureWorklet,
  getCaptureContext,
  resumeCaptureContext,
  type CapturedPcmChunk,
} from './audio-engine.js';
import { captureEpochFor } from './capture-health.js';
import { MeetingAudioBuffer, type SampleRange } from './meeting-audio-buffer.js';
import { RecoveryTimeoutError } from './recovery-attempt.js';

/** Owned by the capture lease, independent of provider/VAD consumers. */
export async function createCaptureAudioRetention(
  stream: MediaStream,
  trackId: string,
  signal: AbortSignal,
  onOverwrite?: () => void,
  onInitializationRetry?: () => void,
) {
  signal.throwIfAborted();
  const context = getCaptureContext();
  if (!context || !Number.isFinite(context.sampleRate) || context.sampleRate < 16000)
    throw new Error('Unsupported capture sample rate for audio retention');
  try {
    await ensureCaptureWorklet(context, signal);
  } catch (error) {
    if (!(error instanceof RecoveryTimeoutError)) throw error;
    signal.throwIfAborted();
    const tracks = stream.getAudioTracks();
    if (!tracks.length || tracks.some((track) => track.readyState === 'ended')) throw error;
    onInitializationRetry?.();
    signal.throwIfAborted();
    // The native load is still shared/in flight. One new bounded wait keeps the
    // acquired device; it does not re-register the module or reopen permission.
    await ensureCaptureWorklet(context, signal);
  }
  const { Resampler } = await import('@ricky0123/vad-web/dist/resampler');
  signal.throwIfAborted();
  const resampler = new Resampler({
    nativeSampleRate: context.sampleRate,
    targetSampleRate: 16000,
    targetFrameSize: 512,
  });
  const buffer = new MeetingAudioBuffer();
  const captureEpoch = captureEpochFor(stream);
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'pcm-worklet', {
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { chunkSize: 512, frameMetadata: true },
  });
  let disposed = false;
  let samples = 0;
  let nativeOrigin: number | null = null;
  let nextNativeFrame: number | null = null;
  // The existing resampler rounds native consumption separately for each
  // 512-sample output. Non-integer ratios (e.g. 44.1kHz) cannot use this simple
  // affine mapping; keep their audio without claiming exact source positions.
  let clockAligned = Number.isInteger(context.sampleRate / 16000);
  function rangeForNativeFrames(clock: AudioContext, from: number, to: number): SampleRange | null {
    if (
      disposed ||
      clock !== context ||
      !clockAligned ||
      nativeOrigin === null ||
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < nativeOrigin ||
      to <= from
    )
      return null;
    const start = ((from - nativeOrigin) * 16000) / context.sampleRate;
    const end = ((to - nativeOrigin) * 16000) / context.sampleRate;
    // Different resampler phases cannot be rounded into an exact sample claim.
    // A future/unfinished output frame is not yet captured in the retained PCM.
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end > samples) return null;
    return { trackId, captureEpoch, from: start, to: end };
  }
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    node.port.onmessage = null;
    node.port.close();
    node.disconnect();
    source.disconnect();
    buffer.clear();
    resampler.inputBuffer.fill(0);
    resampler.inputBuffer.length = 0;
    signal.removeEventListener('abort', dispose);
  };
  signal.addEventListener('abort', dispose, { once: true });
  node.port.onmessage = (event: MessageEvent<ArrayBuffer | CapturedPcmChunk>) => {
    if (disposed) return;
    const chunk = event.data;
    const bytes = chunk instanceof ArrayBuffer ? chunk : chunk?.type === 'pcm' ? chunk.pcm : null;
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) return;
    if (
      chunk instanceof ArrayBuffer ||
      !Number.isSafeInteger(chunk.startFrame) ||
      chunk.startFrame < 0
    ) {
      // Cached older worklets can still retain PCM, but have no precise clock.
      clockAligned = false;
    } else {
      nativeOrigin ??= chunk.startFrame;
      if (nextNativeFrame !== null && chunk.startFrame !== nextNativeFrame) clockAligned = false;
      nextNativeFrame = chunk.startFrame + bytes.byteLength / 4;
    }
    for (const pcm of resampler.process(new Float32Array(bytes))) {
      const overwritten = buffer.append({
        trackId,
        captureEpoch,
        startSample: samples,
        sampleRate: 16000,
        pcm,
      });
      samples += pcm.length;
      if (overwritten.length) onOverwrite?.();
    }
  };
  try {
    source.connect(node);
    node.connect(context.destination);
    await resumeCaptureContext(signal);
    signal.throwIfAborted();
    return { buffer, dispose, rangeForNativeFrames };
  } catch (error) {
    dispose();
    throw error;
  }
}
