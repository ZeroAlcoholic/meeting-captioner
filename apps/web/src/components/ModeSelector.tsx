import { MODE_OPTIONS, type ModeId } from '../settings/settings-store.js';
import { useSettingsStore } from '../settings/use-settings-store.js';
import styles from './ScenarioPicker.module.css';

export function ModeSelector({ sessionActive = false }: { sessionActive?: boolean }) {
  const modeId = useSettingsStore((s) => s.modeId);
  const setMode = useSettingsStore((s) => s.setMode);

  return (
    <fieldset className={styles.fieldset} data-testid="mode-selector">
      <legend className={styles.legend}>Mode</legend>
      <div className={styles.options}>
        {MODE_OPTIONS.map((opt) => {
          const disabled = sessionActive || !opt.enabled;
          return (
            <label
              key={opt.id}
              className={styles.option}
              data-selected={modeId === opt.id}
              data-disabled={disabled}
              title={sessionActive ? '會議進行中 — 請先 Stop' : opt.hint}
            >
              <input
                type="radio"
                name="mode"
                value={opt.id}
                checked={modeId === opt.id}
                disabled={disabled}
                onChange={() => setMode(opt.id as ModeId)}
                data-testid={`mode-${opt.id}`}
                className={styles.radio}
              />
              <span className={styles.label}>
                {opt.label}
                <span className={styles.labelZh}> {opt.labelZh}</span>
                {opt.hint && <span className={styles.hint}> · {opt.hint}</span>}
              </span>
              <span className={styles.desc}>{opt.descriptionZh}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
