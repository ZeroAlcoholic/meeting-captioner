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
  if (!visible) return null;
  return (
    <div className="mic-level" data-state={audioState} title={`Mic: ${audioState}`}>
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
    </div>
  );
});
