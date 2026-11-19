import type { HealthEvent } from '@meeting-audio/contracts';
import { ensureCaptureWorklet, getCaptureContext, resumeCaptureContext } from './audio-engine.js';

export interface CaptureHealthOptions {
  context: AudioContext;
  stream: MediaStream;
  onHealth(event: HealthEvent): void;
}

/** WebRTC does not expose PCM callbacks. This probes capture only, never RTP delivery. */
export async function monitorWebRtcCapture(
  stream: MediaStream,
  onHealth: (event: HealthEvent) => void,
  signal: AbortSignal,
) {
  const context = getCaptureContext();
  if (!context) throw new Error('AudioContext unavailable for capture monitoring');
  await ensureCaptureWorklet(context, signal);
  signal.throwIfAborted();
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'pcm-worklet', {
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { progressOnly: true, chunkSize: Math.round(context.sampleRate / 4) },
  });
  const health = monitorCaptureHealth({ context, stream, onHealth });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    health.dispose();
    node.port.onmessage = null;
    node.port.close();
    node.disconnect();
    source.disconnect();
    signal.removeEventListener('abort', dispose);
  };
  signal.addEventListener('abort', dispose, { once: true });
  node.port.onmessage = (event: MessageEvent<{ type: string; samples: number }>) => {
    if (!disposed && event.data?.type === 'capture_progress') health.frame(event.data.samples);
  };
  try {
    source.connect(node);
    node.connect(context.destination);
    await resumeCaptureContext(signal);
    signal.throwIfAborted();
    return {
      get healthy() {
        return health.healthy;
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

type Reason = NonNullable<HealthEvent['reason']>;
const captureEpochs = new WeakMap<MediaStream, string>();
export function captureEpochFor(stream: MediaStream): string {
  let epoch = captureEpochs.get(stream);
  if (!epoch) {
    epoch = crypto.randomUUID();
    captureEpochs.set(stream, epoch);
  }
  return epoch;
}
const MESSAGE: Record<Reason, string> = {
  capture_stalled: '收音資料已停止前進，請檢查音源或重新開始收音。',
  track_muted: '音源暫時無法提供音訊，請檢查裝置或分享來源。',
  context_suspended: '音訊處理已暫停，請返回此頁或重新開始收音。',
  context_closed: '音訊處理已關閉，請重新開始收音。',
  track_ended: '音源已結束，請重新選取音源開始收音。',
  capture_resumed: '收音資料已恢復。',
};

/** Owned by the existing PCM consumer, never by a cloud retry or a second capture. */
export function monitorCaptureHealth({ context, stream, onHealth }: CaptureHealthOptions) {
  const tracks = stream.getAudioTracks();
  let stopped = false;
  let reason: Reason | undefined;
  let lastFrameAt = performance.now();
  let lastObservedAt = Date.now();
  const captureEpoch = captureEpochFor(stream);
  const checkWallClock = () => {
    if (stopped || reason === 'track_ended' || reason === 'context_closed') return;
    const now = Date.now();
    // Covers suspended JS timers and fresh frames delivered before the first
    // resumed timer. Clock corrections are also possible: this is an estimate.
    if (now - lastObservedAt > 5_000) {
      onHealth({
        kind: 'health',
        component: 'audio',
        state: 'degraded',
        reason: 'capture_stalled',
        message: '疑似休眠或排程中斷；此期間收音完整性未確認。',
        timestamp: new Date(now).toISOString(),
        captureGap: {
          captureEpoch,
          wallClock: {
            startAt: new Date(lastObservedAt).toISOString(),
            endAt: new Date(now).toISOString(),
          },
        },
      });
      reason = 'capture_stalled';
    }
    lastObservedAt = now;
  };
  const emit = (next: Reason) => {
    if (stopped || reason === next) return;
    reason = next;
    onHealth({
      kind: 'health',
      component: 'audio',
      reason: next,
      state:
        next === 'capture_resumed'
          ? 'connected'
          : next === 'track_ended' || next === 'context_closed'
            ? 'failed'
            : 'degraded',
      message: MESSAGE[next],
      timestamp: new Date().toISOString(),
    });
  };
  const check = (freshFrame = false) => {
    if (stopped) return;
    checkWallClock();
    if (tracks.some((track) => track.readyState === 'ended')) {
      emit('track_ended');
      return;
    }
    if (reason === 'track_ended' || reason === 'context_closed') return;
    if (context.state === 'closed') {
      emit('context_closed');
      return;
    }
    if (context.state !== 'running') {
      emit('context_suspended');
      return;
    }
    if (tracks.some((track) => track.muted)) {
      emit('track_muted');
      return;
    }
    if (freshFrame) {
      if (reason !== 'capture_resumed') emit('capture_resumed');
    } else if (performance.now() - lastFrameAt >= 1750) emit('capture_stalled');
  };
  const onState = () => {
    // Give a resumed graph a bounded fresh-frame window; state alone is not recovery.
    if (context.state === 'running' && tracks.every((track) => !track.muted)) {
      lastFrameAt = performance.now();
    }
    check();
  };
  // 1750ms + at most one 250ms timer tick: <=2s while the main thread runs.
  const timer = setInterval(() => check(), 250);
  context.addEventListener?.('statechange', onState);
  const onVisibility = () => {
    if (!document.hidden) check();
  };
  if (typeof document !== 'undefined')
    document.addEventListener?.('visibilitychange', onVisibility);
  if (typeof window !== 'undefined') window.addEventListener?.('pageshow', onVisibility);
  for (const track of tracks) {
    for (const name of ['mute', 'unmute', 'ended']) track.addEventListener?.(name, onState);
  }
  return {
    get healthy() {
      return !stopped && (!reason || reason === 'capture_resumed');
    },
    frame(samples: number) {
      if (stopped || samples <= 0 || !Number.isFinite(samples)) return;
      lastFrameAt = performance.now();
      check(true);
    },
    dispose() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      context.removeEventListener?.('statechange', onState);
      if (typeof document !== 'undefined')
        document.removeEventListener?.('visibilitychange', onVisibility);
      if (typeof window !== 'undefined') window.removeEventListener?.('pageshow', onVisibility);
      for (const track of tracks) {
        for (const name of ['mute', 'unmute', 'ended']) track.removeEventListener?.(name, onState);
      }
    },
  };
}
