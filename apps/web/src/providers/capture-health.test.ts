import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { captureEpochFor, monitorCaptureHealth } from './capture-health.js';
import { createSettingsStore } from '../settings/settings-store.js';

function setup() {
  const context = Object.assign(new EventTarget(), { state: 'running', sampleRate: 16000 });
  const track = Object.assign(new EventTarget(), { readyState: 'live', muted: false });
  const onHealth = vi.fn();
  const monitor = monitorCaptureHealth({
    context: context as unknown as AudioContext,
    stream: { getAudioTracks: () => [track] } as unknown as MediaStream,
    onHealth,
  });
  return { context, track, onHealth, monitor };
}
beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] }));
afterEach(() => vi.useRealTimers());

it('keeps the epoch for the same grant, changes it for a new stream, and ignores backward clock jumps', () => {
  const first = {} as MediaStream,
    second = {} as MediaStream;
  expect(captureEpochFor(first)).toBe(captureEpochFor(first));
  expect(captureEpochFor(second)).not.toBe(captureEpochFor(first));
  let wallTime = Date.parse('2026-10-15T00:00:00.000Z');
  const now = vi.spyOn(Date, 'now').mockImplementation(() => wallTime);
  const { monitor, onHealth } = setup();
  monitor.frame(512);
  wallTime -= 60_000;
  monitor.frame(512);
  expect(onHealth.mock.calls.some((c) => c[0].captureGap)).toBe(false);
  monitor.dispose();
  wallTime += 120_000;
  monitor.frame(512);
  expect(onHealth.mock.calls.some((c) => c[0].captureGap)).toBe(false);
  now.mockRestore();
});

it('reports an estimated scheduling gap after a wall-clock jump without sample claims', () => {
  let wallTime = Date.parse('2026-10-15T00:00:00.000Z');
  const now = vi.spyOn(Date, 'now').mockImplementation(() => wallTime);
  const { monitor, onHealth } = setup();
  monitor.frame(512);
  wallTime += 60_000;
  monitor.frame(512);
  const gapEvent = onHealth.mock.calls.map((c) => c[0]).find((e) => e.captureGap);
  expect(gapEvent?.captureGap).toMatchObject({
    captureEpoch: expect.any(String),
    wallClock: { startAt: '2026-10-15T00:00:00.000Z', endAt: '2026-10-15T00:01:00.000Z' },
  });
  expect(gapEvent?.captureGap).not.toHaveProperty('startSample');
  monitor.dispose();
  now.mockRestore();
});

it('reports no PCM within two seconds without waiting for a later frame', () => {
  const { monitor, onHealth } = setup();
  monitor.frame(512);
  vi.advanceTimersByTime(2000);
  expect(onHealth).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: 'degraded', reason: 'capture_stalled' }),
  );
  monitor.dispose();
});

it('does not mistake continuously arriving silent PCM for a stall', () => {
  const { monitor, onHealth } = setup();
  for (let i = 0; i < 200; i++) {
    vi.advanceTimersByTime(100);
    monitor.frame(1600);
  }
  expect(onHealth).toHaveBeenCalledTimes(1);
  expect(onHealth).toHaveBeenCalledWith(
    expect.objectContaining({ state: 'connected', reason: 'capture_resumed' }),
  );
  monitor.dispose();
});

it('a replacement consumer clears a parked capture fault only on its first actual frame', () => {
  const store = createSettingsStore();
  const context = Object.assign(new EventTarget(), { state: 'running', sampleRate: 16000 });
  const options = {
    context: context as unknown as AudioContext,
    stream: { getAudioTracks: () => [] } as unknown as MediaStream,
    onHealth: store.getState().applyHealth,
  };
  const old = monitorCaptureHealth(options);
  vi.advanceTimersByTime(2000);
  expect(store.getState().health.audio.reason).toBe('capture_stalled');
  old.dispose();
  const replacement = monitorCaptureHealth(options);
  store.getState().applyHealth({
    kind: 'health',
    component: 'audio',
    state: 'connected',
    timestamp: new Date().toISOString(),
  });
  expect(store.getState().health.audio.reason).toBe('capture_stalled');
  replacement.frame(512);
  expect(store.getState().health.audio.state).toBe('connected');
  expect(store.getState().health.audio.reason).toBe('capture_resumed');
  replacement.dispose();
});

it('reports initial missing frames and resumes only after real samples', () => {
  const { monitor, onHealth } = setup();
  vi.advanceTimersByTime(2000);
  expect(onHealth).toHaveBeenCalledTimes(1);
  monitor.frame(0);
  expect(onHealth).toHaveBeenCalledTimes(1);
  monitor.frame(512);
  expect(onHealth).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: 'connected', reason: 'capture_resumed' }),
  );
  monitor.dispose();
});

it('mute outranks frame presence; unmute alone cannot claim recovered capture', () => {
  const { monitor, track, onHealth } = setup();
  track.muted = true;
  track.dispatchEvent(new Event('mute'));
  monitor.frame(512);
  expect(onHealth).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'track_muted' }));
  track.muted = false;
  track.dispatchEvent(new Event('unmute'));
  expect(onHealth).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'track_muted' }));
  monitor.frame(512);
  expect(onHealth).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'capture_resumed' }));
  monitor.dispose();
});

it('context suspension is distinct from stall; running requires fresh PCM before recovery', () => {
  const { monitor, context, onHealth } = setup();
  context.state = 'suspended';
  context.dispatchEvent(new Event('statechange'));
  vi.advanceTimersByTime(2000);
  expect(onHealth).toHaveBeenLastCalledWith(
    expect.objectContaining({ reason: 'context_suspended' }),
  );
  context.state = 'running';
  context.dispatchEvent(new Event('statechange'));
  expect(onHealth).toHaveBeenLastCalledWith(
    expect.objectContaining({ reason: 'context_suspended' }),
  );
  monitor.frame(512);
  expect(onHealth).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'capture_resumed' }));
  monitor.dispose();
});

it('ended is terminal even if queued PCM arrives afterwards', () => {
  const { monitor, track, onHealth } = setup();
  track.readyState = 'ended';
  track.dispatchEvent(new Event('ended'));
  monitor.frame(512);
  vi.advanceTimersByTime(3000);
  expect(onHealth).toHaveBeenCalledTimes(1);
  expect(onHealth).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: 'failed', reason: 'track_ended' }),
  );
  monitor.dispose();
});

it('dispose cancels timers and events; old frame callbacks cannot revive health', () => {
  const { monitor, context, track, onHealth } = setup();
  monitor.dispose();
  context.state = 'suspended';
  context.dispatchEvent(new Event('statechange'));
  track.muted = true;
  track.dispatchEvent(new Event('mute'));
  monitor.frame(512);
  vi.advanceTimersByTime(5000);
  expect(onHealth).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
