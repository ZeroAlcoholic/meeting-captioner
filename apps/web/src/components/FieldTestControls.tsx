import { useCallback, useEffect, useState } from 'react';
import { triggerDownload } from '../export/download.js';
import {
  fieldTestRecorder,
  type CompletedFieldTestRun,
  type FieldTestSnapshot,
} from '../providers/field-test-recorder.js';
import { useSettingsStore } from '../settings/use-settings-store.js';
import styles from './FieldTestControls.module.css';

export interface FieldTestControlsProps {
  sessionActive: boolean;
}

function snapshot(): FieldTestSnapshot {
  return fieldTestRecorder.snapshot();
}

function fieldTestFilename(runs: CompletedFieldTestRun[]): string {
  const last = runs.at(-1);
  const stamp = (last?.endedAt ?? new Date().toISOString()).replace(/[:.]/g, '-');
  return `field-test-${stamp}.json`;
}

export function FieldTestControls({ sessionActive }: FieldTestControlsProps) {
  const [state, setState] = useState<FieldTestSnapshot>(() => snapshot());

  useEffect(() => fieldTestRecorder.subscribe(() => setState(snapshot())), []);
  const modeId = useSettingsStore((s) => s.modeId);
  const audioSource = useSettingsStore((s) => s.audioSource);
  const onlineProvider = useSettingsStore((s) => s.onlineProvider);
  const active = state.active;
  const canRecord = modeId === 'online_full' && audioSource === 'system';
  const hasHistory = state.history.length > 0;

  const start = useCallback(() => {
    const label = `YT ${onlineProvider === 'gemini' ? 'Gemini' : 'OpenAI'} manual`;
    fieldTestRecorder.start(label, 'started from FieldTestControls');
  }, [onlineProvider]);

  const finish = useCallback(() => {
    fieldTestRecorder.finish('finished from FieldTestControls');
  }, []);

  const exportHistory = useCallback(() => {
    const history = fieldTestRecorder.history();
    triggerDownload(
      JSON.stringify(history, null, 2),
      fieldTestFilename(history),
      'application/json;charset=utf-8',
    );
  }, []);

  const clearHistory = useCallback(() => {
    fieldTestRecorder.clear();
  }, []);

  return (
    <div className={styles.wrapper} data-testid="field-test-controls">
      <button
        type="button"
        className={active ? styles.recording : undefined}
        onClick={active ? finish : start}
        disabled={!active && !canRecord}
        title={
          active
            ? sessionActive
              ? 'Finish the current field-test recording; app Stop also finishes it'
              : 'Finish the current field-test recording'
            : canRecord
              ? 'Start recording diagnostic field-test data for the next Online system-audio run'
              : 'Field-test recording is available in Online Meeting Caption Box / system audio mode'
        }
        data-testid="field-test-toggle"
      >
        {active ? '■ Test' : '● Test'}
      </button>
      <button
        type="button"
        className={styles.export}
        onClick={exportHistory}
        disabled={!hasHistory}
        title={hasHistory ? `Export ${state.history.length} field-test run(s)` : 'No field-test runs recorded yet'}
        data-testid="field-test-export"
      >
        ⬇ Test
      </button>
      <button
        type="button"
        className={styles.export}
        onClick={clearHistory}
        disabled={!active && !hasHistory}
        title="Clear field-test recording state and history"
        data-testid="field-test-clear"
      >
        Clear Test
      </button>
    </div>
  );
}
