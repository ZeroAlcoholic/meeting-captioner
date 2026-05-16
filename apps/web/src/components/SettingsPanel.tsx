import { AudioLevelMeter } from './AudioLevelMeter.js';
import { HealthRow } from './HealthRow.js';
import { ModeSelector } from './ModeSelector.js';
import { ScenarioPicker } from './ScenarioPicker.js';
import { LANG_PAIR_OPTIONS, type LangPair } from '../settings/settings-store.js';
import { useSettingsStore } from '../settings/use-settings-store.js';
import styles from './SettingsPanel.module.css';

export interface SettingsPanelProps {
  open: boolean;
}

function LangPairSelector() {
  const langPair = useSettingsStore((s) => s.langPair);
  const setLangPair = useSettingsStore((s) => s.setLangPair);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 1 }}>
        Language
      </span>
      <div style={{ display: 'flex', gap: 6 }}>
        {LANG_PAIR_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            data-testid={`lang-${opt.id}`}
            title={opt.hint}
            onClick={() => setLangPair(opt.id as LangPair)}
            style={{
              padding: '4px 10px',
              borderRadius: 4,
              border: langPair === opt.id ? '2px solid #4a9eff' : '1px solid #555',
              background: langPair === opt.id ? '#1a3a5c' : 'transparent',
              color: '#e8e8e8',
              cursor: 'pointer',
              fontWeight: langPair === opt.id ? 700 : 400,
              fontSize: 13,
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Toggle that drives the upstream `audio.input.transcription` config.
 * Default ON (bilingual). Change takes effect on the next Start — we don't
 * mid-flight `session.update` here because the existing renewal path
 * already covers session rebuild and keeps things simple.
 */
function SourceTranscriptToggle() {
  const includeSource = useSettingsStore((s) => s.includeSourceTranscript);
  const setIncludeSource = useSettingsStore((s) => s.setIncludeSourceTranscript);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 1 }}>
        Source transcript
      </span>
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 10px',
          borderRadius: 4,
          border: '1px solid #555',
          color: '#e8e8e8',
          fontSize: 13,
          cursor: 'pointer',
          userSelect: 'none',
        }}
        title="When ON, the server requests gpt-realtime-whisper to also stream the speaker's original-language transcript. OFF saves the incremental whisper minutes but hides the source row. Applies on next Start."
      >
        <input
          type="checkbox"
          checked={includeSource}
          onChange={(e) => setIncludeSource(e.target.checked)}
          data-testid="toggle-source-transcript"
        />
        <span>{includeSource ? 'Bilingual (default)' : 'Translation only'}</span>
      </label>
    </div>
  );
}


export function SettingsPanel({ open }: SettingsPanelProps) {
  const hasAudioLevel = useSettingsStore((s) => s.audioLevel !== null);
  if (!open) return null;
  return (
    <section className={styles.panel} data-testid="settings-panel">
      <div className={styles.row}>
        <ScenarioPicker />
        <ModeSelector />
        <LangPairSelector />
        <SourceTranscriptToggle />
        <HealthRow />
      </div>
      {hasAudioLevel && <AudioLevelMeter />}
    </section>
  );
}
