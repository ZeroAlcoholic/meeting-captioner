import type {
  AudioLevelEvent,
  AudioSourceKind,
  HealthComponent,
  HealthEvent,
  HealthState,
} from '@meeting-audio/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type ScenarioId = 'physical' | 'online_meeting_box' | 'hybrid' | 'advanced';
export type ModeId = 'online_full' | 'hybrid_privacy' | 'full_offline';
export type LangPair = 'en→zh-TW' | 'zh-TW→en';
export type OfflineAudioSource = 'mic' | 'system';

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

export const SCENARIO_OPTIONS: ScenarioOption[] = [
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

export const MODE_OPTIONS: ModeOption[] = [
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
  health: Record<HealthComponent, HealthSnapshot>;
  audioLevel: AudioLevelSnapshot | null;
  /** epoch ms when the current realtime session started; null when not running */
  sessionStartAt: number | null;
  /** accumulated ms from all completed sessions (not including the current running one) */
  sessionElapsedMs: number;
  setScenario: (id: ScenarioId) => void;
  setMode: (id: ModeId) => void;
  setLangPair: (id: LangPair) => void;
  setAudioSource: (s: OfflineAudioSource) => void;
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

export type SettingsStore = StoreApi<SettingsState>;

export function createSettingsStore(): SettingsStore {
  const initialTimestamp = new Date().toISOString();
  return createStore<SettingsState>((set) => ({
    scenarioId: DEFAULT_SCENARIO,
    modeId: DEFAULT_MODE,
    langPair: DEFAULT_LANG_PAIR,
    audioSource: 'mic',
    health: defaultHealth(initialTimestamp),
    audioLevel: null,
    sessionStartAt: null,
    sessionElapsedMs: 0,

    setScenario: (id) =>
      set({
        scenarioId: id,
        audioSource: id === 'online_meeting_box' ? 'system' : 'mic',
      }),
    setMode: (id) => set({ modeId: id }),
    setLangPair: (id) => set({ langPair: id }),
    setAudioSource: (audioSource) => set({ audioSource }),

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

    startSession: () => set({ sessionStartAt: Date.now() }),

    stopSession: () =>
      set((state) => ({
        sessionElapsedMs:
          state.sessionElapsedMs +
          (state.sessionStartAt ? Date.now() - state.sessionStartAt : 0),
        sessionStartAt: null,
      })),

    resetSession: () => set({ sessionStartAt: null, sessionElapsedMs: 0 }),

    reset: () =>
      set({
        scenarioId: DEFAULT_SCENARIO,
        modeId: DEFAULT_MODE,
        langPair: DEFAULT_LANG_PAIR,
        audioSource: 'mic',
        health: defaultHealth(new Date().toISOString()),
        audioLevel: null,
        sessionStartAt: null,
        sessionElapsedMs: 0,
      }),
  }));
}
