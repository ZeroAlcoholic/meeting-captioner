import type { HealthComponent, HealthState } from '@meeting-audio/contracts';
import { useSettingsStore } from '../settings/use-settings-store.js';
import type { ModeId } from '../settings/settings-store.js';
import styles from './HealthRow.module.css';

const COMPONENTS_BY_MODE: Record<ModeId, readonly HealthComponent[]> = {
  online_full:     ['audio', 'transport', 'translation'],
  hybrid_privacy:  ['audio', 'stt', 'transport', 'translation'],
  full_offline:    ['audio', 'stt', 'translation'],
};

const LABEL: Record<HealthComponent, string> = {
  audio: 'Audio',
  stt: 'STT',
  translation: 'Translation',
  summary: 'Summary',
  transport: 'Transport',
  ui: 'UI',
};

export type HealthBucket = 'idle' | 'loading' | 'ok' | 'warn' | 'degraded' | 'error';

export function bucketOf(state: HealthState): HealthBucket {
  switch (state) {
    case 'idle':
    case 'stopped':
      return 'idle';
    case 'connecting':
    case 'model_loading':
      return 'loading';
    case 'connected':
      return 'ok';
    case 'requesting_permission':
    case 'reconnecting':
    case 'silence_detected':
      return 'warn';
    case 'degraded':
      return 'degraded';
    case 'failed':
    case 'no_audio_track':
    case 'offline_engine_unavailable':
    case 'api_error':
      return 'error';
  }
}

export function HealthRow() {
  const health = useSettingsStore((s) => s.health);
  const modeId = useSettingsStore((s) => s.modeId);
  const components = COMPONENTS_BY_MODE[modeId];

  return (
    <div className={styles.row} data-testid="health-row">
      <span className={styles.title}>Health</span>
      <div className={styles.items}>
        {components.map((component) => {
          const snap = health[component];
          const bucket = bucketOf(snap.state);
          const tooltip = `${LABEL[component]} — ${snap.state}${snap.message ? `: ${snap.message}` : ''}`;
          return (
            <div
              key={component}
              className={styles.item}
              data-bucket={bucket}
              data-state={snap.state}
              data-testid={`health-${component}`}
              title={tooltip}
            >
              <span className={styles.dot} aria-hidden="true" />
              <span className={styles.label}>{LABEL[component]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
