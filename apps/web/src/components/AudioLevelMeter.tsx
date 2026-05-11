import { useSettingsStore } from '../settings/use-settings-store.js';
import styles from './AudioLevelMeter.module.css';

const FLOOR_DB = -60;
const CEIL_DB = 0;

export function rmsToWidthPercent(rmsDb: number): number {
  const clamped = Math.max(FLOOR_DB, Math.min(CEIL_DB, rmsDb));
  return ((clamped - FLOOR_DB) / (CEIL_DB - FLOOR_DB)) * 100;
}

export function AudioLevelMeter() {
  const level = useSettingsStore((s) => s.audioLevel);
  const widthPct = level ? rmsToWidthPercent(level.rmsDb) : 0;
  const peakPct = level ? rmsToWidthPercent(level.peakDb) : 0;
  const display = level ? `${level.rmsDb.toFixed(0)} dB` : '—';

  return (
    <div className={styles.meter} data-testid="audio-level-meter" data-active={level !== null}>
      <span className={styles.label}>Audio level</span>
      <div className={styles.barWrap}>
        <div className={styles.bar} style={{ width: `${widthPct}%` }} />
        {level && <div className={styles.peak} style={{ left: `${peakPct}%` }} />}
      </div>
      <span className={styles.value}>{display}</span>
    </div>
  );
}
