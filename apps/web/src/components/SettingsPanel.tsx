import { AudioLevelMeter } from './AudioLevelMeter.js';
import { HealthRow } from './HealthRow.js';
import { ModeSelector } from './ModeSelector.js';
import { ScenarioPicker } from './ScenarioPicker.js';
import { LANG_PAIR_OPTIONS, type LangPair, type MicDistance } from '../settings/settings-store.js';
import { useSettingsStore } from '../settings/use-settings-store.js';
import styles from './SettingsPanel.module.css';

const MIC_DISTANCE_OPTIONS: Array<{ id: MicDistance; label: string; hint: string }> = [
  { id: 'close', label: 'Close', hint: 'Desktop / headset mic ≤ 1 m. AGC on + near_field noise reduction.' },
  { id: 'far',   label: 'Far',   hint: 'Conference room, ceiling mic, far speakers. AGC off + far_field noise reduction.' },
  { id: 'off',   label: 'Raw',   hint: 'No AGC, no noise reduction. For clean upstream (mixer / DSP).' },
];

export interface SettingsPanelProps {
  open: boolean;
}

/**
 * Combined Language + Source-transcript control. The toggle used to sit in
 * its own column which forced the settings row to consume more horizontal
 * width than needed; nesting it under the Language buttons (slightly
 * dropped down) keeps the controls visually grouped — language pair on
 * top, capture mode beneath — and frees a column slot.
 */
function LanguageBlock() {
  const langPair = useSettingsStore((s) => s.langPair);
  const setLangPair = useSettingsStore((s) => s.setLangPair);
  const includeSource = useSettingsStore((s) => s.includeSourceTranscript);
  const setIncludeSource = useSettingsStore((s) => s.setIncludeSourceTranscript);
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
      {/* Source transcript toggle nested below — sub-label "TRANSCRIPT" so
          users read it as a sub-option of Language, not a peer block. */}
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 6,
          padding: '4px 10px',
          borderRadius: 4,
          border: '1px solid #555',
          color: '#e8e8e8',
          fontSize: 12,
          cursor: 'pointer',
          userSelect: 'none',
        }}
        title="When ON, the server requests gpt-realtime-whisper to also stream the speaker's original-language transcript. OFF saves the incremental whisper minutes but hides the source row. Toggling mid-session automatically restarts the OpenAI connection (~1-2 s gap, captions preserved)."
      >
        <input
          type="checkbox"
          checked={includeSource}
          onChange={(e) => setIncludeSource(e.target.checked)}
          data-testid="toggle-source-transcript"
        />
        <span>
          <span style={{ opacity: 0.55, marginRight: 6, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' }}>
            Transcript
          </span>
          {includeSource ? 'Bilingual' : 'Translation only'}
        </span>
      </label>
    </div>
  );
}


/**
 * Acoustic environment selector. Pairs browser-side AGC with server-side
 * noise_reduction profile in lockstep. Mid-session change auto-restarts.
 */
function MicDistanceBlock() {
  const micDistance = useSettingsStore((s) => s.micDistance);
  const setMicDistance = useSettingsStore((s) => s.setMicDistance);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 1 }}>
        Mic distance
      </span>
      <div style={{ display: 'flex', gap: 6 }}>
        {MIC_DISTANCE_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            data-testid={`mic-distance-${opt.id}`}
            title={opt.hint}
            onClick={() => setMicDistance(opt.id)}
            style={{
              padding: '4px 10px',
              borderRadius: 4,
              border: micDistance === opt.id ? '2px solid #4a9eff' : '1px solid #555',
              background: micDistance === opt.id ? '#1a3a5c' : 'transparent',
              color: '#e8e8e8',
              cursor: 'pointer',
              fontWeight: micDistance === opt.id ? 700 : 400,
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


export function SettingsPanel({ open }: SettingsPanelProps) {
  const hasAudioLevel = useSettingsStore((s) => s.audioLevel !== null);
  if (!open) return null;
  return (
    <section className={styles.panel} data-testid="settings-panel">
      <div className={styles.row}>
        <ScenarioPicker />
        <ModeSelector />
        <LanguageBlock />
        <MicDistanceBlock />
        <HealthRow />
      </div>
      {hasAudioLevel && <AudioLevelMeter />}
    </section>
  );
}
