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

export interface ScenarioOption {
  id: ScenarioId;
  label: string;
  description: string;
  enabled: boolean;
  hint?: string;
}

export interface ModeOption {
  id: ModeId;
  label: string;
  description: string;
}

export const SCENARIO_OPTIONS: ScenarioOption[] = [
  {
    id: 'physical',
    label: 'Physical Meeting',
    description: 'Microphone only, exclusive source.',
    enabled: true,
  },
  {
    id: 'online_meeting_box',
    label: 'Online Meeting Caption Box',
    description: 'Browser tab audio or Windows loopback. Microphone off by default.',
    enabled: true,
  },
  {
    id: 'hybrid',
    label: 'Hybrid Meeting',
    description: 'Remote audio + local mic, kept as separate tracks.',
    enabled: true,
  },
  {
    id: 'advanced',
    label: 'Advanced Manual',
    description: 'Pick sources and policy yourself.',
    enabled: false,
    hint: 'Available in P2/P3.',
  },
];

export const MODE_OPTIONS: ModeOption[] = [
  {
    id: 'online_full',
    label: 'Online Full',
    description: 'Audio → OpenAI Realtime → transcript & translation.',
  },
  {
    id: 'hybrid_privacy',
    label: 'Hybrid Privacy',
    description: 'Audio → local STT → online translation/summary.',
  },
  {
    id: 'full_offline',
    label: 'Full Offline',
    description: 'Audio → local STT → local translation. No cloud.',
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
  health: Record<HealthComponent, HealthSnapshot>;
  audioLevel: AudioLevelSnapshot | null;
  setScenario: (id: ScenarioId) => void;
  setMode: (id: ModeId) => void;
  applyHealth: (event: HealthEvent) => void;
  applyAudioLevel: (event: AudioLevelEvent) => void;
  reset: () => void;
}

const DEFAULT_SCENARIO: ScenarioId = 'physical';
const DEFAULT_MODE: ModeId = 'online_full';

export type SettingsStore = StoreApi<SettingsState>;

export function createSettingsStore(): SettingsStore {
  const initialTimestamp = new Date().toISOString();
  return createStore<SettingsState>((set) => ({
    scenarioId: DEFAULT_SCENARIO,
    modeId: DEFAULT_MODE,
    health: defaultHealth(initialTimestamp),
    audioLevel: null,

    setScenario: (id) => set({ scenarioId: id }),
    setMode: (id) => set({ modeId: id }),

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

    reset: () =>
      set({
        scenarioId: DEFAULT_SCENARIO,
        modeId: DEFAULT_MODE,
        health: defaultHealth(new Date().toISOString()),
        audioLevel: null,
      }),
  }));
}
