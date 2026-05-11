import { SCENARIO_OPTIONS, type ScenarioId } from '../settings/settings-store.js';
import { useSettingsStore } from '../settings/use-settings-store.js';
import styles from './ScenarioPicker.module.css';

export function ScenarioPicker() {
  const scenarioId = useSettingsStore((s) => s.scenarioId);
  const setScenario = useSettingsStore((s) => s.setScenario);

  return (
    <fieldset className={styles.fieldset} data-testid="scenario-picker">
      <legend className={styles.legend}>Scenario</legend>
      <div className={styles.options}>
        {SCENARIO_OPTIONS.map((opt) => (
          <label
            key={opt.id}
            className={styles.option}
            data-selected={scenarioId === opt.id}
            data-disabled={!opt.enabled}
          >
            <input
              type="radio"
              name="scenario"
              value={opt.id}
              checked={scenarioId === opt.id}
              disabled={!opt.enabled}
              onChange={() => setScenario(opt.id as ScenarioId)}
              data-testid={`scenario-${opt.id}`}
              className={styles.radio}
            />
            <span className={styles.label}>
              {opt.label}
              <span className={styles.labelZh}> {opt.labelZh}</span>
              {opt.hint && <span className={styles.hint}> · {opt.hint}</span>}
            </span>
            <span className={styles.desc}>{opt.descriptionZh}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
