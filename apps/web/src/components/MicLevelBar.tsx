import { memo } from 'react';
import { useSettingsStore } from '../settings/use-settings-store.js';
import { rmsToWidthPercent } from './AudioLevelMeter.js';

interface MicLevelBarProps {
  visible: boolean;
}

/**
 * Header mic-level bar. Subscribes ONLY to audioLevel + audio health state,
 * so the 10 Hz audio-level updates redraw this widget without re-rendering
 * the rest of the app (notably CaptionBoard's heavier subtree).
 */
export const MicLevelBar = memo(function MicLevelBar({ visible }: MicLevelBarProps) {
  const audioLevel = useSettingsStore((s) => s.audioLevel);
  const audioState = useSettingsStore((s) => s.health.audio.state);
  const audioReason = useSettingsStore((s) => s.health.audio.reason);
  const audioMessage = useSettingsStore((s) => s.health.audio.message);
  const captureGap = useSettingsStore((s) => s.captureGap);
  const retentionGap = useSettingsStore((s) => s.retentionGap);
  const fault = audioReason && audioReason !== 'capture_resumed';
  if (!visible && !fault && !retentionGap) return null;
  return (
    <div
      className="mic-level"
      data-testid="mic-level-bar"
      data-state={audioState}
      data-reason={audioReason}
      title={`Mic: ${audioState}`}
    >
      <span className="mic-icon">🎤</span>
      <div className="mic-bar-wrap">
        <div
          className="mic-bar-fill"
          style={{ width: `${audioLevel ? rmsToWidthPercent(audioLevel.rmsDb) : 0}%` }}
        />
        {audioLevel && (
          <div
            className="mic-bar-peak"
            style={{ left: `${rmsToWidthPercent(audioLevel.peakDb)}%` }}
          />
        )}
      </div>
      {audioState !== 'idle' && audioState !== 'stopped' && (
        <span className="mic-state">{audioState}</span>
      )}
      {fault && <span role="status">{audioMessage}</span>}
      {retentionGap && (
        <span role="status" data-testid="retention-gap-notice">
          約 {Math.ceil((retentionGap.to - retentionGap.from) / retentionGap.sampleRate)}{' '}
          秒暫存音訊已覆寫；字幕完整性未確認。
        </span>
      )}
      {captureGap && (
        <span role="status" data-testid="capture-gap-notice">
          疑似休眠或排程中斷約{' '}
          {Math.round(
            (Date.parse(captureGap.wallClock.endAt) - Date.parse(captureGap.wallClock.startAt)) /
              1000,
          )}{' '}
          秒；此期間收音完整性未確認。
        </span>
      )}
    </div>
  );
});
