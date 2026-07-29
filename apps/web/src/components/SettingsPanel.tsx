import { useEffect, useRef, type RefObject } from 'react';
import { AudioLevelMeter } from './AudioLevelMeter.js';
import { HealthRow } from './HealthRow.js';
import { ModeSelector } from './ModeSelector.js';
import { ScenarioPicker } from './ScenarioPicker.js';
import { LANG_PAIR_OPTIONS, type LangPair, type MicDistance, type OnlineProvider } from '../settings/settings-store.js';
import { useSettingsStore } from '../settings/use-settings-store.js';
import styles from './SettingsPanel.module.css';

const ONLINE_PROVIDER_OPTIONS: Array<{ id: OnlineProvider; label: string; hint: string }> = [
  { id: 'openai', label: 'OpenAI', hint: 'OpenAI Realtime Translate (WebRTC). 預設。' },
  { id: 'gemini', label: 'Gemini', hint: 'Google Gemini 3.5 Live Translate（WebSocket）。專用即時翻譯模型，連續串流，繁體中文原生輸出；譯文約落後語音 2–3 秒（模型特性，官方無參數可調）。延遲敏感的會議建議用 OpenAI。需伺服器設定 GEMINI_API_KEY。' },
];

const MIC_DISTANCE_OPTIONS: Array<{ id: MicDistance; label: string; hint: string }> = [
  { id: 'meeting', label: 'Meeting', hint: '多人會議共用一支麥克風（建議）。關閉瀏覽器 AGC/雜訊抑制，改用 OpenAI far_field — 換語者時不會把新講者當雜訊濾掉。' },
  { id: 'close',   label: 'Close',   hint: 'Single speaker, desktop / headset mic ≤ 1 m. AGC on + near_field noise reduction.' },
  { id: 'far',     label: 'Far',     hint: 'Conference room, ceiling mic, far speakers. AGC off (NS on) + far_field noise reduction.' },
  { id: 'off',     label: 'Raw',     hint: 'No AGC, no noise reduction. For clean upstream (mixer / DSP).' },
];

export interface SettingsPanelProps {
  open: boolean;
  /**
   * Called when the user clicks anywhere outside the panel, or presses
   * Escape. Lets the parent collapse the panel so the caption board is
   * visible again — meeting operators don't want a settings panel pinned
   * over their captions after they're done tweaking.
   */
  onClose?: () => void;
  /**
   * Ref to the toggle button (the ⚙ in the header). Clicks on that button
   * must NOT count as "outside" — otherwise the close handler fires first,
   * then the button's onClick re-opens, looking like the toggle is broken.
   */
  triggerRef?: RefObject<HTMLElement>;
  /**
   * True while any caption provider is running. Locks the online-backend
   * picker: switching it mid-session would hide the running provider's
   * Start/cost UI while the session (and its billing) silently continued.
   */
  sessionActive?: boolean;
}

/**
 * Combined Language + Source-transcript control. The toggle used to sit in
 * its own column which forced the settings row to consume more horizontal
 * width than needed; nesting it under the Language buttons (slightly
 * dropped down) keeps the controls visually grouped — language pair on
 * top, capture mode beneath — and frees a column slot.
 */
function LanguageBlock({ sessionActive = false }: { sessionActive?: boolean }) {
  const langPair = useSettingsStore((s) => s.langPair);
  const setLangPair = useSettingsStore((s) => s.setLangPair);
  const includeSource = useSettingsStore((s) => s.includeSourceTranscript);
  const setIncludeSource = useSettingsStore((s) => s.setIncludeSourceTranscript);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, opacity: 0.65, textTransform: 'uppercase', letterSpacing: 1 }}>
        Language
      </span>
      <div style={{ display: 'flex', gap: 6 }}>
        {LANG_PAIR_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            data-testid={`lang-${opt.id}`}
            // Translation DIRECTION is fixed at upstream session creation
            // (OpenAI audio.output.language / Gemini translationConfig). Unlike
            // the bilingual toggle below, there is no auto-restart wired for a
            // langPair change — and the dedicated translate models capture it at
            // construction — so allowing a mid-session change would silently
            // leave the stream translating to the OLD language while the UI
            // shows the new one (a "no silent failures" violation). Lock it
            // during a live session, mirroring the backend switcher: a
            // direction change is effectively a new meeting, so Stop → Start.
            disabled={sessionActive}
            title={sessionActive ? '會議進行中 — 請先 Stop 再切換翻譯方向' : opt.hint}
            onClick={() => setLangPair(opt.id as LangPair)}
            style={{
              padding: '5px 12px',
              borderRadius: 4,
              border: langPair === opt.id ? '2px solid #4a9eff' : '1px solid #555',
              background: langPair === opt.id ? '#1a3a5c' : 'transparent',
              color: '#e8e8e8',
              cursor: sessionActive ? 'not-allowed' : 'pointer',
              opacity: sessionActive && langPair !== opt.id ? 0.4 : 1,
              fontWeight: langPair === opt.id ? 700 : 400,
              fontSize: 14,
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
          fontSize: 13,
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
 *
 * Disabled when audioSource === 'system' — system audio (Teams/Zoom via
 * getDisplayMedia) is already mixed and free of room noise, so AGC /
 * noise_reduction would only add artifacts. use-openai-realtime forces
 * micDistance='off' in that path; greying out the buttons here makes the
 * UI reflect that fact instead of pretending the setting still applies.
 */
/**
 * Online realtime backend selector (mode 'online_full' only). Switches which
 * cloud provider brokers the realtime translation session. Both emit the same
 * normalized events; switching mid-session requires Stop → Start.
 */
function OnlineProviderBlock({ sessionActive = false }: { sessionActive?: boolean }) {
  const onlineProvider = useSettingsStore((s) => s.onlineProvider);
  const setOnlineProvider = useSettingsStore((s) => s.setOnlineProvider);
  const modeId = useSettingsStore((s) => s.modeId);
  if (modeId !== 'online_full') return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, opacity: 0.65, textTransform: 'uppercase', letterSpacing: 1 }}>
        Online backend
      </span>
      <div style={{ display: 'flex', gap: 6 }}>
        {ONLINE_PROVIDER_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            data-testid={`online-provider-${opt.id}`}
            disabled={sessionActive}
            title={sessionActive ? '會議進行中 — 請先 Stop 再切換後端' : opt.hint}
            onClick={() => setOnlineProvider(opt.id)}
            style={{
              padding: '5px 12px',
              borderRadius: 4,
              border: onlineProvider === opt.id ? '2px solid #4a9eff' : '1px solid #555',
              background: onlineProvider === opt.id ? '#1a3a5c' : 'transparent',
              color: '#e8e8e8',
              cursor: sessionActive ? 'not-allowed' : 'pointer',
              fontWeight: onlineProvider === opt.id ? 700 : 400,
              fontSize: 14,
              opacity: sessionActive ? 0.4 : 1,
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {sessionActive && (
        <span style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>
          會議進行中 — 切換後端前請先 Stop。
        </span>
      )}
    </div>
  );
}

function MicDistanceBlock() {
  const micDistance = useSettingsStore((s) => s.micDistance);
  const setMicDistance = useSettingsStore((s) => s.setMicDistance);
  const audioSource = useSettingsStore((s) => s.audioSource);
  const isSystem = audioSource === 'system';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, opacity: 0.65, textTransform: 'uppercase', letterSpacing: 1 }}>
        Mic distance
      </span>
      <div style={{ display: 'flex', gap: 6 }}>
        {MIC_DISTANCE_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            data-testid={`mic-distance-${opt.id}`}
            disabled={isSystem}
            title={
              isSystem
                ? '系統音源已預混乾淨，無需 AGC / 雜訊抑制 — 此選項不適用'
                : opt.hint
            }
            onClick={() => setMicDistance(opt.id)}
            style={{
              padding: '5px 12px',
              borderRadius: 4,
              border: micDistance === opt.id ? '2px solid #4a9eff' : '1px solid #555',
              background: micDistance === opt.id ? '#1a3a5c' : 'transparent',
              color: '#e8e8e8',
              cursor: isSystem ? 'not-allowed' : 'pointer',
              fontWeight: micDistance === opt.id ? 700 : 400,
              fontSize: 14,
              opacity: isSystem ? 0.4 : 1,
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {isSystem && (
        <span style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>
          System audio is pre-mixed — AGC / noise_reduction is forced off.
        </span>
      )}
    </div>
  );
}


function TranscriptRetentionBlock() {
  const enabled = useSettingsStore((state) => state.transcriptRetentionEnabled);
  const setEnabled = useSettingsStore((state) => state.setTranscriptRetentionEnabled);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 240 }}>
      <span style={{ fontSize: 12, opacity: 0.65, textTransform: 'uppercase', letterSpacing: 1 }}>
        Privacy
      </span>
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 10px',
          borderRadius: 4,
          border: '1px solid #555',
          color: '#e8e8e8',
          fontSize: 13,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          data-testid="toggle-transcript-retention"
        />
        本機保存逐字稿
      </label>
      <span style={{ fontSize: 11, opacity: 0.65 }}>
        預設關閉。關閉會立即刪除此瀏覽器已保存的逐字稿；目前畫面內容不會清除。
      </span>
    </div>
  );
}

export function SettingsPanel({ open, onClose, triggerRef, sessionActive }: SettingsPanelProps) {
  const hasAudioLevel = useSettingsStore((s) => s.audioLevel !== null);
  const panelRef = useRef<HTMLElement>(null);

  // Outside-click + Escape dismiss. Wired only when open AND onClose is
  // provided — calling parents that don't care about auto-close stay
  // backward-compatible. mousedown (not click) catches the dismiss before
  // any nested element's onClick handler runs, which matches how
  // popovers/menus generally behave.
  useEffect(() => {
    if (!open || !onClose) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef?.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, triggerRef]);

  if (!open) return null;
  return (
    <section ref={panelRef} className={styles.panel} data-testid="settings-panel">
      <div className={styles.row}>
        <ScenarioPicker sessionActive={sessionActive ?? false} />
        <ModeSelector sessionActive={sessionActive ?? false} />
        {/* Language + Mic distance share the "audio capture" theme — stack them
            in one column so the row has 4 slots instead of 5. Generous gap
            between them (22 px) gives the two sub-blocks visual breathing
            room without needing a divider line. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <LanguageBlock sessionActive={sessionActive ?? false} />
          <OnlineProviderBlock sessionActive={sessionActive ?? false} />
          <MicDistanceBlock />
        </div>
        <TranscriptRetentionBlock />
        <HealthRow />
      </div>
      {hasAudioLevel && <AudioLevelMeter />}
    </section>
  );
}
