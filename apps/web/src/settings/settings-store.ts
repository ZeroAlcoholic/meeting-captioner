import type {
  AudioLevelEvent,
  AudioSourceKind,
  HealthComponent,
  HealthEvent,
  HealthState,
} from '@meeting-audio/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { IS_ONLINE_ONLY } from '../deployment.js';

export type ScenarioId = 'physical' | 'online_meeting_box' | 'hybrid' | 'advanced';
export type ModeId = 'online_full' | 'hybrid_privacy' | 'full_offline';
export type LangPair = 'en→zh-TW' | 'zh-TW→en';
export type OfflineAudioSource = 'mic' | 'system';
/**
 * Acoustic environment selector. Drives BOTH:
 *   - browser-side getUserMedia AGC (auto-gain control)
 *   - server-side OpenAI `audio.input.noise_reduction.type`
 *
 *   'close' — desktop / headset mic: AGC on, noise_reduction=near_field.
 *             The default, fine for ~1 m mic distance.
 *   'far'   — conference-room / ceiling / table-far mic: AGC OFF (so soft
 *             speakers across the room aren't over-compressed) and
 *             noise_reduction=far_field (OpenAI's tuned profile for
 *             reverberant acoustic spaces).
 *   'off'   — raw signal: AGC off, no noise_reduction. For users who
 *             want OpenAI to see the unprocessed mic.
 */
export type MicDistance = 'close' | 'far' | 'off';

export const LANG_PAIR_OPTIONS: Array<{ id: LangPair; label: string; hint: string }> = [
  { id: 'en→zh-TW', label: 'EN → 繁中', hint: 'English speech → Traditional Chinese captions' },
  { id: 'zh-TW→en', label: '繁中 → EN', hint: 'Mandarin speech → English captions' },
];

export interface ScenarioOption {
  id: ScenarioId;
  label: string;
  labelZh: string;
  description: string;
  descriptionZh: string;
  enabled: boolean;
  hint?: string;
}

export interface ModeOption {
  id: ModeId;
  label: string;
  labelZh: string;
  description: string;
  descriptionZh: string;
}

// The full catalog. Deployment-aware variants are derived below so consumers
// import a single name and get the right list for the active build.
const ALL_SCENARIO_OPTIONS: ScenarioOption[] = [
  {
    id: 'physical',
    label: 'Physical Meeting',
    labelZh: '實體會議',
    description: 'Microphone only, exclusive source.',
    descriptionZh: '僅使用麥克風，獨佔音源。',
    enabled: true,
  },
  {
    id: 'online_meeting_box',
    label: 'Online Meeting Caption Box',
    labelZh: '線上會議旁聽',
    description: 'Browser tab audio or Windows loopback. Microphone off by default.',
    descriptionZh: '瀏覽器分頁音訊或 Windows 系統音效。預設關閉麥克風。',
    enabled: true,
  },
  {
    id: 'hybrid',
    label: 'Hybrid Meeting',
    labelZh: '混合會議',
    description: 'Remote audio + local mic, kept as separate tracks.',
    descriptionZh: '遠端音訊 + 本地麥克風，分軌處理。',
    enabled: true,
  },
  {
    id: 'advanced',
    label: 'Advanced Manual',
    labelZh: '進階手動',
    description: 'Pick sources and policy yourself.',
    descriptionZh: '自行選擇音源與混音策略。',
    enabled: false,
    hint: 'Coming soon.',
  },
];

const ALL_MODE_OPTIONS: ModeOption[] = [
  {
    id: 'online_full',
    label: 'Online Full',
    labelZh: '線上全功能',
    description: 'Audio → OpenAI Realtime → transcript & translation.',
    descriptionZh: '音訊 → OpenAI Realtime → 轉錄與翻譯。',
  },
  {
    id: 'hybrid_privacy',
    label: 'Hybrid Privacy',
    labelZh: '混合隱私',
    description: 'Audio → local STT → online translation/summary.',
    descriptionZh: '音訊 → 本地語音辨識 → 雲端翻譯/摘要。',
  },
  {
    id: 'full_offline',
    label: 'Full Offline',
    labelZh: '完全離線',
    description: 'Audio → local STT → local translation. No cloud.',
    descriptionZh: '音訊 → 本地語音辨識 → 本地翻譯。無雲端依賴。',
  },
];

// In the online-slim build, offline-dependent modes/scenarios are hidden so
// users never see options that the bundled provider stub cannot fulfil.
export const SCENARIO_OPTIONS: ScenarioOption[] = IS_ONLINE_ONLY
  ? ALL_SCENARIO_OPTIONS.filter((s) => s.id !== 'hybrid')
  : ALL_SCENARIO_OPTIONS;

export const MODE_OPTIONS: ModeOption[] = IS_ONLINE_ONLY
  ? ALL_MODE_OPTIONS.filter((m) => m.id === 'online_full')
  : ALL_MODE_OPTIONS;

export interface HealthSnapshot {
  state: HealthState;
  message?: string;
  timestamp: string;
}

export interface AudioLevelSnapshot {
  source: AudioSourceKind;
  rmsDb: number;
  peakDb: number;
  timestamp: string;
}

const HEALTH_COMPONENTS = [
  'audio',
  'stt',
  'translation',
  'summary',
  'transport',
  'ui',
] as const satisfies readonly HealthComponent[];

function defaultHealth(timestamp: string): Record<HealthComponent, HealthSnapshot> {
  const out = {} as Record<HealthComponent, HealthSnapshot>;
  for (const c of HEALTH_COMPONENTS) {
    out[c] = { state: 'idle', timestamp };
  }
  return out;
}

export interface SettingsState {
  scenarioId: ScenarioId;
  modeId: ModeId;
  langPair: LangPair;
  audioSource: OfflineAudioSource;
  /**
   * When true (default), the server-side /session route adds
   *   `audio.input.transcription: { model: 'gpt-realtime-whisper' }`
   * to the upstream session payload, which makes OpenAI emit
   * `session.input_transcript.delta` events carrying the source-language
   * transcript. When false, only translation events arrive and the UI
   * collapses to a single-column (translation-only) layout, saving the
   * incremental `gpt-realtime-whisper` minutes on the bill at the cost of
   * cross-checking the speaker's original words.
   */
  includeSourceTranscript: boolean;
  /** See MicDistance docstring. Default 'close'. */
  micDistance: MicDistance;
  health: Record<HealthComponent, HealthSnapshot>;
  audioLevel: AudioLevelSnapshot | null;
  /** epoch ms when the current realtime session started; null when not running */
  sessionStartAt: number | null;
  /**
   * Translate minutes accumulated across all completed sessions in the
   * current accounting period (does NOT include the running session;
   * derive that separately from sessionStartAt). Always grows while a
   * session is live.
   */
  translateMinutesAccum: number;
  /**
   * Whisper minutes accumulated across all completed sessions that were
   * configured as bilingual. Only grows during bilingual sessions; lets
   * the pricing panel show the correct historical total even after the
   * user later toggles to translation-only.
   */
  whisperMinutesAccum: number;
  /**
   * Snapshot of `includeSourceTranscript` taken at startSession(). Null
   * when no session is running. The pricing panel reads this so the live
   * cost rate reflects what the running session is actually being charged
   * for, NOT a mid-session toggle change (which doesn't take effect until
   * the next Start anyway).
   */
  activeSessionBilingual: boolean | null;
  setScenario: (id: ScenarioId) => void;
  setMode: (id: ModeId) => void;
  setLangPair: (id: LangPair) => void;
  setAudioSource: (s: OfflineAudioSource) => void;
  setIncludeSourceTranscript: (v: boolean) => void;
  setMicDistance: (v: MicDistance) => void;
  applyHealth: (event: HealthEvent) => void;
  applyAudioLevel: (event: AudioLevelEvent) => void;
  startSession: () => void;
  stopSession: () => void;
  resetSession: () => void;
  reset: () => void;
}

const DEFAULT_SCENARIO: ScenarioId = 'physical';
const DEFAULT_MODE: ModeId = 'online_full';
const DEFAULT_LANG_PAIR: LangPair = 'en→zh-TW';

// User-preference subset of SettingsState that survives a page reload.
// Deliberately EXCLUDES ephemeral runtime state (sessionStartAt,
// activeSessionBilingual, audioLevel, health, the accumulators) — those
// are session-scoped and must not bleed across reloads, otherwise the
// pricing panel and cost timer would report stale data on the next visit.
interface PersistedPrefs {
  v: number;
  scenarioId: ScenarioId;
  modeId: ModeId;
  langPair: LangPair;
  audioSource: OfflineAudioSource;
  includeSourceTranscript: boolean;
  micDistance: MicDistance;
}
const PREFS_KEY = 'meeting-audio:settings:v1';
const PREFS_VERSION = 1;

function loadPrefs(): Partial<PersistedPrefs> | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedPrefs;
    if (parsed.v !== PREFS_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function savePrefs(prefs: Omit<PersistedPrefs, 'v'>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const payload: PersistedPrefs = { v: PREFS_VERSION, ...prefs };
    localStorage.setItem(PREFS_KEY, JSON.stringify(payload));
  } catch {
    // QuotaExceeded or unavailable — silently keep in-memory only.
  }
}

export type SettingsStore = StoreApi<SettingsState>;

export function createSettingsStore(): SettingsStore {
  const initialTimestamp = new Date().toISOString();
  const hydrated = loadPrefs();
  const store = createStore<SettingsState>((set) => ({
    scenarioId: hydrated?.scenarioId ?? DEFAULT_SCENARIO,
    modeId: hydrated?.modeId ?? DEFAULT_MODE,
    langPair: hydrated?.langPair ?? DEFAULT_LANG_PAIR,
    audioSource: hydrated?.audioSource ?? 'mic',
    includeSourceTranscript: hydrated?.includeSourceTranscript ?? true,
    micDistance: hydrated?.micDistance ?? 'close',
    health: defaultHealth(initialTimestamp),
    audioLevel: null,
    sessionStartAt: null,
    translateMinutesAccum: 0,
    whisperMinutesAccum: 0,
    activeSessionBilingual: null,

    setScenario: (id) =>
      set({
        scenarioId: id,
        audioSource: id === 'online_meeting_box' ? 'system' : 'mic',
      }),
    setMode: (id) => set({ modeId: id }),
    setLangPair: (id) => set({ langPair: id }),
    setAudioSource: (audioSource) => set({ audioSource }),
    setIncludeSourceTranscript: (v) => set({ includeSourceTranscript: v }),
    setMicDistance: (v) => set({ micDistance: v }),

    applyHealth: (event) =>
      set((state) => {
        const snapshot: HealthSnapshot = { state: event.state, timestamp: event.timestamp };
        if (event.message !== undefined) snapshot.message = event.message;
        return { health: { ...state.health, [event.component]: snapshot } };
      }),

    applyAudioLevel: (event) =>
      set({
        audioLevel: {
          source: event.source,
          rmsDb: event.rmsDb,
          peakDb: event.peakDb,
          timestamp: event.timestamp,
        },
      }),

    startSession: () =>
      set((state) => ({
        sessionStartAt: Date.now(),
        // Snapshot the bilingual mode at session start so the pricing
        // panel uses the rate the session is actually billed at, even if
        // the user toggles the setting mid-session (the toggle is
        // documented as "applies on next Start" anyway).
        activeSessionBilingual: state.includeSourceTranscript,
      })),

    stopSession: () =>
      set((state) => {
        const elapsedMin = state.sessionStartAt
          ? (Date.now() - state.sessionStartAt) / 60_000
          : 0;
        const wasBilingual = state.activeSessionBilingual === true;
        return {
          translateMinutesAccum: state.translateMinutesAccum + elapsedMin,
          whisperMinutesAccum: state.whisperMinutesAccum + (wasBilingual ? elapsedMin : 0),
          sessionStartAt: null,
          activeSessionBilingual: null,
        };
      }),

    resetSession: () =>
      set({
        sessionStartAt: null,
        translateMinutesAccum: 0,
        whisperMinutesAccum: 0,
        activeSessionBilingual: null,
      }),

    reset: () =>
      set({
        scenarioId: DEFAULT_SCENARIO,
        modeId: DEFAULT_MODE,
        langPair: DEFAULT_LANG_PAIR,
        audioSource: 'mic',
        includeSourceTranscript: true,
        micDistance: 'close',
        health: defaultHealth(new Date().toISOString()),
        audioLevel: null,
        sessionStartAt: null,
        translateMinutesAccum: 0,
        whisperMinutesAccum: 0,
        activeSessionBilingual: null,
      }),
  }));

  // Persist the user-preference subset on any change. We deliberately
  // skip subscribing inside test environments (no localStorage) and
  // re-emit prefs only when an actually-persisted field changed.
  if (typeof localStorage !== 'undefined') {
    let lastSnapshot: string | null = null;
    store.subscribe((state) => {
      const prefs: Omit<PersistedPrefs, 'v'> = {
        scenarioId: state.scenarioId,
        modeId: state.modeId,
        langPair: state.langPair,
        audioSource: state.audioSource,
        includeSourceTranscript: state.includeSourceTranscript,
        micDistance: state.micDistance,
      };
      const snap = JSON.stringify(prefs);
      if (snap !== lastSnapshot) {
        lastSnapshot = snap;
        savePrefs(prefs);
      }
    });
  }

  return store;
}
