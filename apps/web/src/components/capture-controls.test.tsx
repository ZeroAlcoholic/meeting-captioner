import { afterEach, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { settingsStore } from '../settings/use-settings-store.js';
import { MicDevicePicker } from './MicDevicePicker.js';
import { MicLevelBar } from './MicLevelBar.js';

afterEach(() => settingsStore.getState().reset());

it('keeps retention loss visible after recovery without clearing a real capture fault', () => {
  const base = {
    kind: 'health' as const,
    component: 'audio' as const,
    timestamp: '2026-10-16T00:00:00.000Z',
  };
  settingsStore.getState().applyHealth({ ...base, state: 'failed', reason: 'track_ended' });
  settingsStore.getState().applyHealth({
    ...base,
    state: 'connected',
    retentionGap: {
      gapId: 'f2b1e579-4e45-4bd2-8a17-3cb5e6e56c91',
      trackId: 'mic',
      captureEpoch: 'e1',
      from: 16000,
      to: 496000,
      sampleRate: 16000,
    },
  });
  expect(settingsStore.getState().health.audio.reason).toBe('track_ended');
  settingsStore.getState().applyHealth({ ...base, state: 'connected', reason: 'capture_resumed' });
  const html = renderToStaticMarkup(<MicLevelBar visible={false} />);
  expect(html).toContain('retention-gap-notice');
  expect(html).toContain('30');
  expect(html).toContain('字幕完整性未確認');
  settingsStore.getState().reset();
  expect(renderToStaticMarkup(<MicLevelBar visible={false} />)).not.toContain(
    'retention-gap-notice',
  );
});

it('keeps an unavailable selected microphone visible and locks the picker for an active session', () => {
  settingsStore.getState().setMicDeviceId('missing-device');
  const html = renderToStaticMarkup(<MicDevicePicker disabled />);
  expect(html).toContain('value="missing-device" selected');
  expect(html).toContain('disabled');
  expect(html).toContain('不會改用其他麥克風');
  expect(html).toContain('作業系統預設麥克風');
});

it('retains a visible estimated interruption notice after real capture resumes', () => {
  settingsStore.getState().applyHealth({
    kind: 'health',
    component: 'audio',
    state: 'degraded',
    reason: 'capture_stalled',
    timestamp: '2026-10-15T00:01:00.000Z',
    captureGap: {
      captureEpoch: 'grant-1',
      wallClock: {
        startAt: '2026-10-15T00:00:00.000Z',
        endAt: '2026-10-15T00:01:00.000Z',
      },
    },
  });
  settingsStore.getState().applyHealth({
    kind: 'health',
    component: 'audio',
    state: 'connected',
    reason: 'capture_resumed',
    timestamp: '2026-10-15T00:01:00.100Z',
  });
  const html = renderToStaticMarkup(<MicLevelBar visible />);
  expect(html).toContain('capture-gap-notice');
  expect(html).toContain('60');
  expect(html).toContain('收音完整性未確認');
  expect(html).toContain('data-state="connected"');
});
