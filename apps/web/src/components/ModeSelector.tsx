import { MODE_OPTIONS, type ModeId } from '../settings/settings-store.js';
import { useSettingsStore } from '../settings/use-settings-store.js';
import styles from './ScenarioPicker.module.css';

export function ModeSelector() {
  const modeId = useSettingsStore((s) => s.modeId);
  const setMode = useSettingsStore((s) => s.setMode);

  return (
    <fieldset className={styles.fieldset} data-testid="mode-selector">
      <legend className={styles.legend}>Mode</legend>
      <div className={styles.options}>
        {MODE_OPTIONS.map((opt) => (
          <label
            key={opt.id}
            className={styles.option}
            data-selected={modeId === opt.id}
            data-disabled="false"
          >
            <input
              type="radio"
              name="mode"
              value={opt.id}
              checked={modeId === opt.id}
              onChange={() => setMode(opt.id as ModeId)}
              data-testid={`mode-${opt.id}`}
              className={styles.radio}
            />
            <span className={styles.label}>
              {opt.label}
              <span className={styles.labelZh}> {opt.labelZh}</span>
            </span>
            <span className={styles.desc}>{opt.descriptionZh}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
