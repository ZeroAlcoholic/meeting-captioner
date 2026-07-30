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
 * Online realtime backend selector (mode 'online_full' only). Both are
 * cloud realtime translation paths behind the same normalized event
 * contracts; the user picks which provider brokers the session.
 *   'openai' — OpenAI Realtime Translate (WebRTC). Default.
 *   'gemini' — Google Gemini Live API (WebSocket, ephemeral token).
 */
export type OnlineProvider = 'openai' | 'gemini';
/**
 * Acoustic environment selector. Drives BOTH:
 *   - browser-side getUserMedia AGC (auto-gain control)
 *   - server-side OpenAI `audio.input.noise_reduction.type`
 *
 *   'meeting' — DEFAULT. Room with multiple people sharing one laptop mic.
 *               ALL browser DSP off (AGC + NS + EC), noise_reduction=far_field.
 *               Browser DSP is tuned for a single 1-on-1 caller: AGC locks
 *               gain to the dominant speaker and near_field NS gates softer /
 *               different-voiced participants as "noise", so when the speaker
 *               changes the new voice is dropped. Feeding OpenAI the raw
 *               multi-speaker signal and letting its far_field profile do the
 *               work keeps every speaker around the table recognisable.
 *   'close'   — desktop / headset mic ≤ 1 m, single speaker: AGC on,
 *               noise_reduction=near_field.
 *   'far'     — conference-room / ceiling / table-far mic: AGC OFF (so soft
 *               speakers across the room aren't over-compressed), NS on, and
 *               noise_reduction=far_field (OpenAI's tuned profile for
 *               reverberant acoustic spaces).
 *   'off'     — raw signal: AGC off, no noise_reduction. For users who
 *               want OpenAI to see the unprocessed mic.
 */
export type MicDistance = 'meeting' | 'close' | 'far' | 'off';

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
  /**
   * False when this build cannot satisfy the mode (e.g. online-slim has no
   * offline STT). The UI still SHOWS the option so users understand the
   * feature exists, but renders it greyed-out + non-selectable instead of
   * hiding it entirely (which made earlier testers think we'd dropped the
   * feature).
   */
  enabled: boolean;
  hint?: string;
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
    description: 'Capture Teams / Zoom / Meet audio via screen share — no extra software needed.',
    descriptionZh: '透過螢幕分享擷取 Teams / Zoom / Meet 音訊，無需額外安裝。',
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
    enabled: true,
  },
  {
    id: 'hybrid_privacy',
    label: 'Hybrid Privacy',
    labelZh: '混合隱私',
    description: 'Audio → local STT → online translation/summary.',
    descriptionZh: '音訊 → 本地語音辨識 → 雲端翻譯/摘要。',
    enabled: true,
  },
  {
    id: 'full_offline',
    label: 'Full Offline',
    labelZh: '完全離線',
    description: 'Audio → local STT → local translation. No cloud.',
    descriptionZh: '音訊 → 本地語音辨識 → 本地翻譯。無雲端依賴。',
    enabled: true,
  },
];

// In the online-slim build, offline-dependent modes/scenarios stay in the
// list but are marked `enabled: false`. The UI greys them out so users see
// the feature exists ("you'd get this in the full build") but can't select
// it. Previous behaviour was to filter them out entirely, which made the
// online-slim UI feel like a stripped-down product instead of a deliberate
// distribution choice.
export const SCENARIO_OPTIONS: ScenarioOption[] = ALL_SCENARIO_OPTIONS.map((s) => {
  if (IS_ONLINE_ONLY && s.id === 'hybrid') {
    return { ...s, enabled: false, hint: 'Requires offline STT — full build only.' };
  }
  return s;
});

export const MODE_OPTIONS: ModeOption[] = ALL_MODE_OPTIONS.map((m) => {
  if (IS_ONLINE_ONLY && (m.id === 'hybrid_privacy' || m.id === 'full_offline')) {
    return { ...m, enabled: false, hint: 'Requires offline STT — full build only.' };
  }
  return m;
});

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
  /** Persist transcripts locally across reloads. Privacy-safe default: false. */
  transcriptRetentionEnabled: boolean;
  /** See MicDistance docstring. Default 'meeting' (multi-speaker room). */
  micDistance: MicDistance;
  /** Online realtime backend (mode 'online_full'). Default 'openai'. */
  onlineProvider: OnlineProvider;
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
  setTranscriptRetentionEnabled: (v: boolean) => void;
  setMicDistance: (v: MicDistance) => void;
  setOnlineProvider: (v: OnlineProvider) => void;
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
  transcriptRetentionEnabled?: boolean;
  micDistance: MicDistance;
  onlineProvider: OnlineProvider;
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
  // If a previous full-build session left an offline mode persisted but the
  // current build is online-only, fall back to defaults — otherwise the user
  // would land on a disabled (greyed-out) selection they couldn't easily fix.
  const isEnabled = (list: { id: string; enabled: boolean }[], id: string | undefined): boolean =>
    Boolean(id && list.find((o) => o.id === id)?.enabled);
  const safeScenario = isEnabled(SCENARIO_OPTIONS, hydrated?.scenarioId)
    ? hydrated!.scenarioId!
    : DEFAULT_SCENARIO;
  const safeMode = isEnabled(MODE_OPTIONS, hydrated?.modeId) ? hydrated!.modeId! : DEFAULT_MODE;
  const store = createStore<SettingsState>((set) => ({
    scenarioId: safeScenario,
    modeId: safeMode,
    langPair: hydrated?.langPair ?? DEFAULT_LANG_PAIR,
    audioSource: hydrated?.audioSource ?? 'mic',
    includeSourceTranscript: hydrated?.includeSourceTranscript ?? true,
    transcriptRetentionEnabled: hydrated?.transcriptRetentionEnabled ?? false,
    micDistance: hydrated?.micDistance ?? 'meeting',
    onlineProvider: hydrated?.onlineProvider ?? 'openai',
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
    setTranscriptRetentionEnabled: (v) => set({ transcriptRetentionEnabled: v }),
    setMicDistance: (v) => set({ micDistance: v }),
    setOnlineProvider: (v) => set({ onlineProvider: v }),

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
        const elapsedMin = state.sessionStartAt ? (Date.now() - state.sessionStartAt) / 60_000 : 0;
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
        transcriptRetentionEnabled: false,
        micDistance: 'meeting',
        onlineProvider: 'openai',
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
        transcriptRetentionEnabled: state.transcriptRetentionEnabled,
        micDistance: state.micDistance,
        onlineProvider: state.onlineProvider,
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
