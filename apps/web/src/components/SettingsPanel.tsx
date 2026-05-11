import { AudioLevelMeter } from './AudioLevelMeter.js';
import { HealthRow } from './HealthRow.js';
import { ModeSelector } from './ModeSelector.js';
import { ScenarioPicker } from './ScenarioPicker.js';
import styles from './SettingsPanel.module.css';

export interface SettingsPanelProps {
  open: boolean;
}

export function SettingsPanel({ open }: SettingsPanelProps) {
  if (!open) return null;
  return (
    <section className={styles.panel} data-testid="settings-panel">
      <div className={styles.row}>
        <ScenarioPicker />
        <ModeSelector />
        <HealthRow />
      </div>
      <AudioLevelMeter />
    </section>
  );
}
