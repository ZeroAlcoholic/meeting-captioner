import type { AudioLevelEvent, CaptionTask, HealthEvent } from '@meeting-audio/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSettingsStore, MODE_OPTIONS, SCENARIO_OPTIONS } from './settings-store.js';

const ts = '2026-05-11T10:00:00.000Z';

function health(
  component: HealthEvent['component'],
  state: HealthEvent['state'],
  message?: string,
): HealthEvent {
  const e: HealthEvent = { kind: 'health', component, state, timestamp: ts };
  if (message !== undefined) e.message = message;
  return e;
}

function level(rmsDb: number, peakDb: number): AudioLevelEvent {
  return {
    kind: 'audio_level',
    source: 'fake_replay',
    rmsDb,
    peakDb,
    timestamp: ts,
  };
}

describe('settingsStore — defaults', () => {
  it('starts on physical scenario and online_full mode', () => {
    const s = createSettingsStore().getState();
    expect(s.scenarioId).toBe('physical');
    expect(s.modeId).toBe('online_full');
  });

  it('starts with all health components in idle', () => {
    const s = createSettingsStore().getState();
    for (const component of [
      'audio',
      'stt',
      'translation',
      'summary',
      'transport',
      'ui',
    ] as const) {
      expect(s.health[component]?.state).toBe('idle');
    }
  });

  it('starts with audioLevel null', () => {
    expect(createSettingsStore().getState().audioLevel).toBeNull();
  });
});

describe('settingsStore — setters', () => {
  it('routes supported scenarios to their actual single capture source', () => {
    const store = createSettingsStore();
    store.getState().setScenario('online_meeting_box');
    expect(store.getState().scenarioId).toBe('online_meeting_box');
    expect(store.getState().audioSource).toBe('system');
    store.getState().setScenario('physical');
    expect(store.getState().audioSource).toBe('mic');
  });

  it.each(['hybrid', 'advanced'] as const)(
    'rejects unavailable %s without changing capture',
    (id) => {
      const store = createSettingsStore();
      store.getState().setScenario('online_meeting_box');
      store.getState().setScenario(id);
      expect(store.getState().scenarioId).toBe('online_meeting_box');
      expect(store.getState().audioSource).toBe('system');
      expect(store.getState().scenarioNotice).toBeTruthy();
      store.getState().setScenario('physical');
      expect(store.getState().scenarioNotice).toBeNull();
    },
  );

  it('setMode updates modeId', () => {
    const store = createSettingsStore();
    store.getState().setMode('full_offline');
    expect(store.getState().modeId).toBe('full_offline');
  });
});

describe('settingsStore — applyHealth', () => {
  it('keeps capture faults above stale silence or connected reports until fresh capture resumes', () => {
    const store = createSettingsStore();
    store
      .getState()
      .applyHealth({ ...health('audio', 'degraded', 'stalled'), reason: 'capture_stalled' });
    store.getState().applyHealth(health('transport', 'connected'));
    store.getState().applyHealth(health('audio', 'silence_detected'));
    store.getState().applyHealth(health('audio', 'connected'));
    expect(store.getState().health.audio.state).toBe('degraded');
    expect(store.getState().health.audio.reason).toBe('capture_stalled');
    store.getState().applyHealth({ ...health('audio', 'connected'), reason: 'capture_resumed' });
    expect(store.getState().health.audio.state).toBe('connected');
    store.getState().applyHealth(health('audio', 'stopped'));
    expect(store.getState().health.audio.reason).toBeUndefined();
  });
  it('updates a single component without touching the others', () => {
    const store = createSettingsStore();
    store.getState().applyHealth(health('audio', 'connecting'));
    const s = store.getState();
    expect(s.health.audio?.state).toBe('connecting');
    expect(s.health.stt?.state).toBe('idle');
  });

  it('preserves the optional message', () => {
    const store = createSettingsStore();
    store.getState().applyHealth(health('transport', 'reconnecting', 'lost connection, retrying'));
    expect(store.getState().health.transport?.message).toBe('lost connection, retrying');
  });

  it('replaces a previous snapshot for the same component', () => {
    const store = createSettingsStore();
    store.getState().applyHealth(health('stt', 'connecting'));
    store.getState().applyHealth(health('stt', 'connected'));
    expect(store.getState().health.stt?.state).toBe('connected');
  });
});

describe('settingsStore — applyAudioLevel', () => {
  it('stores the latest audio level snapshot', () => {
    const store = createSettingsStore();
    store.getState().applyAudioLevel(level(-30, -10));
    expect(store.getState().audioLevel).toEqual({
      source: 'fake_replay',
      rmsDb: -30,
      peakDb: -10,
      timestamp: ts,
    });
  });

  it('overwrites with the latest level (no history kept)', () => {
    const store = createSettingsStore();
    store.getState().applyAudioLevel(level(-30, -10));
    store.getState().applyAudioLevel(level(-25, -5));
    expect(store.getState().audioLevel?.rmsDb).toBe(-25);
  });
});

describe('settingsStore — reset', () => {
  it('returns scenarioId, modeId and audioLevel to defaults', () => {
    const store = createSettingsStore();
    const api = store.getState();
    api.setScenario('online_meeting_box');
    expect(store.getState().scenarioId).toBe('online_meeting_box');
    api.setMode('full_offline');
    api.applyAudioLevel(level(-30, -10));
    api.reset();
    const s = store.getState();
    expect(s.scenarioId).toBe('physical');
    expect(s.modeId).toBe('online_full');
    expect(s.audioLevel).toBeNull();
  });
});

describe('settingsStore — session accounting (mode-aware)', () => {
  it('snapshots bilingual mode at startSession so mid-session toggle does not skew rate', () => {
    const store = createSettingsStore();
    const api = store.getState();
    api.setIncludeSourceTranscript(true);
    api.startSession();
    expect(store.getState().activeSessionBilingual).toBe(true);
    // Mid-session toggle must NOT change the active snapshot.
    api.setIncludeSourceTranscript(false);
    expect(store.getState().activeSessionBilingual).toBe(true);
  });

  it('stopSession accumulates translate-only minutes when bilingual snapshot was false', async () => {
    const store = createSettingsStore();
    const api = store.getState();
    api.setIncludeSourceTranscript(false);
    api.startSession();
    await new Promise((r) => setTimeout(r, 50));
    api.stopSession();
    const s = store.getState();
    expect(s.translateMinutesAccum).toBeGreaterThan(0);
    expect(s.whisperMinutesAccum).toBe(0);
    expect(s.activeSessionBilingual).toBeNull();
  });

  it('stopSession accumulates BOTH translate + whisper minutes when bilingual', async () => {
    const store = createSettingsStore();
    const api = store.getState();
    api.setIncludeSourceTranscript(true);
    api.startSession();
    await new Promise((r) => setTimeout(r, 50));
    api.stopSession();
    const s = store.getState();
    expect(s.translateMinutesAccum).toBeGreaterThan(0);
    // Whisper minutes track translate minutes 1:1 during bilingual sessions.
    expect(s.whisperMinutesAccum).toBeCloseTo(s.translateMinutesAccum, 6);
  });

  it('mixed-mode sessions accumulate per-mode minutes correctly (Codex P2)', async () => {
    // First session bilingual, then translation-only, then bilingual again.
    // translate accumulator should grow on every session; whisper only on
    // bilingual ones. This is what fixes the pricing-recalculates-wrong bug.
    const store = createSettingsStore();
    const api = store.getState();

    api.setIncludeSourceTranscript(true);
    api.startSession();
    await new Promise((r) => setTimeout(r, 30));
    api.stopSession();
    const after1 = store.getState();
    expect(after1.whisperMinutesAccum).toBeGreaterThan(0);
    const w1 = after1.whisperMinutesAccum;
    const t1 = after1.translateMinutesAccum;

    api.setIncludeSourceTranscript(false);
    api.startSession();
    await new Promise((r) => setTimeout(r, 30));
    api.stopSession();
    const after2 = store.getState();
    // Translate grew, whisper did NOT.
    expect(after2.translateMinutesAccum).toBeGreaterThan(t1);
    expect(after2.whisperMinutesAccum).toBe(w1);
  });

  it('resetSession clears all accumulators + snapshot', async () => {
    const store = createSettingsStore();
    const api = store.getState();
    api.setIncludeSourceTranscript(true);
    api.startSession();
    await new Promise((r) => setTimeout(r, 20));
    api.stopSession();
    api.resetSession();
    const s = store.getState();
    expect(s.translateMinutesAccum).toBe(0);
    expect(s.whisperMinutesAccum).toBe(0);
    expect(s.activeSessionBilingual).toBeNull();
    expect(s.sessionStartAt).toBeNull();
  });
});

describe('settingsStore — includeSourceTranscript', () => {
  it('defaults to true (bilingual)', () => {
    expect(createSettingsStore().getState().includeSourceTranscript).toBe(true);
  });

  it('setIncludeSourceTranscript toggles the flag', () => {
    const store = createSettingsStore();
    store.getState().setIncludeSourceTranscript(false);
    expect(store.getState().includeSourceTranscript).toBe(false);
    store.getState().setIncludeSourceTranscript(true);
    expect(store.getState().includeSourceTranscript).toBe(true);
  });

  it('reset restores the bilingual default', () => {
    const store = createSettingsStore();
    store.getState().setIncludeSourceTranscript(false);
    store.getState().reset();
    expect(store.getState().includeSourceTranscript).toBe(true);
  });
});

describe('settingsStore — micDistance + persistence', () => {
  // Use a real-ish localStorage shim per test so different stores don't
  // leak through the global.
  let store: ReturnType<typeof createSettingsStore>;
  const memLs = new Map<string, string>();
  const realLs = globalThis.localStorage;

  beforeEach(() => {
    memLs.clear();
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => memLs.get(k) ?? null,
      setItem: (k: string, v: string) => void memLs.set(k, v),
      removeItem: (k: string) => void memLs.delete(k),
      clear: () => memLs.clear(),
      key: () => null,
      length: 0,
    } as Storage;
    store = createSettingsStore();
  });

  afterEach(() => {
    if (realLs) (globalThis as { localStorage?: Storage }).localStorage = realLs;
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('defaults micDistance to "meeting" (multi-speaker room)', () => {
    expect(store.getState().micDistance).toBe('meeting');
  });

  it('persists selected mic identity, keeps default explicit and rejects changes while running', () => {
    expect(store.getState().micDeviceId).toBe('');
    store.getState().setMicDeviceId('usb-mic');
    expect(createSettingsStore().getState().micDeviceId).toBe('usb-mic');
    store.getState().startSession();
    store.getState().setMicDeviceId('another');
    expect(store.getState().micDeviceId).toBe('usb-mic');
    store.getState().stopSession();
    store.getState().setMicDeviceId('');
    expect(createSettingsStore().getState().micDeviceId).toBe('');
  });

  const transcription: CaptionTask = {
    purpose: 'transcription',
    inputLanguages: ['zh-tw', 'en'],
    textPolicy: 'zh-TW-preserve-original',
  };

  it('defaults to the existing translation purpose without a notice', () => {
    expect(store.getState().captionTask).toEqual({ purpose: 'translation', langPair: 'en→zh-TW' });
    expect(store.getState().captionTaskNotice).toBeNull();
  });

  it.each(['en→zh-TW', 'zh-TW→en'])('migrates legacy direction %s', (langPair) => {
    memLs.set('meeting-audio:settings:v1', JSON.stringify({ v: 1, langPair }));
    expect(createSettingsStore().getState().captionTask).toEqual({
      purpose: 'translation',
      langPair,
    });
  });

  it('persists and reloads pure captions without losing the previous translation direction', () => {
    store.getState().setLangPair('zh-TW→en');
    expect(store.getState().setCaptionTask(transcription)).toBe(true);
    const fresh = createSettingsStore().getState();
    expect(fresh.captionTask).toEqual(transcription);
    expect(fresh.langPair).toBe('zh-TW→en');
  });

  it('keeps translation task and legacy direction aligned in both setter directions', () => {
    store.getState().setLangPair('zh-TW→en');
    expect(store.getState().captionTask).toEqual({ purpose: 'translation', langPair: 'zh-TW→en' });
    store.getState().setCaptionTask({ purpose: 'translation', langPair: 'en→zh-TW' });
    expect(store.getState().langPair).toBe('en→zh-TW');
    store.getState().setCaptionTask(transcription);
    store.getState().setLangPair('zh-TW→en');
    expect(store.getState().captionTask).toEqual(transcription);
  });

  it.each([
    '{bad json',
    JSON.stringify({ v: 1, langPair: 'unsupported' }),
    JSON.stringify({
      v: 1,
      captionTask: {
        purpose: 'transcription',
        inputLanguages: ['ja'],
        textPolicy: 'zh-TW-preserve-original',
      },
    }),
    JSON.stringify({ v: 1, captionTask: null }),
  ])('uses a safe default with an explanation for malformed prefs %s', (raw) => {
    memLs.set('meeting-audio:settings:v1', raw);
    const fresh = createSettingsStore().getState();
    expect(fresh.captionTask).toEqual({ purpose: 'translation', langPair: 'en→zh-TW' });
    expect(fresh.captionTaskNotice).toBeTruthy();
  });

  it('rejects runtime-invalid tasks without replacing the selected purpose', () => {
    store.getState().setCaptionTask(transcription);
    expect(store.getState().setCaptionTask({ purpose: 'unknown' } as unknown as CaptionTask)).toBe(
      false,
    );
    expect(store.getState().captionTask).toEqual(transcription);
    expect(store.getState().captionTaskNotice).toBeTruthy();
  });

  it('locks task changes during a session and permits them after stopping', () => {
    store.getState().startSession();
    expect(store.getState().setCaptionTask(transcription)).toBe(false);
    expect(store.getState().captionTask.purpose).toBe('translation');
    expect(store.getState().captionTaskNotice).toBeTruthy();
    store.getState().stopSession();
    expect(store.getState().setCaptionTask(transcription)).toBe(true);
    expect(store.getState().captionTaskNotice).toBeNull();
  });

  it('reset restores default task and clears task notices', () => {
    store.getState().setCaptionTask(transcription);
    store.getState().reset();
    expect(store.getState().captionTask).toEqual({ purpose: 'translation', langPair: 'en→zh-TW' });
    expect(store.getState().captionTaskNotice).toBeNull();
  });

  it('defaults transcript retention to off and persists explicit opt-in', () => {
    expect(store.getState().transcriptRetentionEnabled).toBe(false);

    store.getState().setTranscriptRetentionEnabled(true);

    const persisted = JSON.parse(memLs.get('meeting-audio:settings:v1') ?? '{}');
    expect(persisted.transcriptRetentionEnabled).toBe(true);
  });

  it('setMicDistance accepts "meeting" and persists it', () => {
    store.getState().setMicDistance('meeting');
    expect(store.getState().micDistance).toBe('meeting');
    const persisted = JSON.parse(memLs.get('meeting-audio:settings:v1') ?? '{}');
    expect(persisted.micDistance).toBe('meeting');
  });

  it('defaults onlineProvider to "openai" and persists a switch to "gemini"', () => {
    expect(store.getState().onlineProvider).toBe('openai');
    store.getState().setOnlineProvider('gemini');
    expect(store.getState().onlineProvider).toBe('gemini');
    const persisted = JSON.parse(memLs.get('meeting-audio:settings:v1') ?? '{}');
    expect(persisted.onlineProvider).toBe('gemini');
  });

  it('setMicDistance updates and persists to localStorage', () => {
    store.getState().setMicDistance('far');
    expect(store.getState().micDistance).toBe('far');
    const persisted = JSON.parse(memLs.get('meeting-audio:settings:v1') ?? '{}');
    expect(persisted.micDistance).toBe('far');
  });

  it('persists langPair, includeSourceTranscript, micDistance — but NOT ephemeral state', async () => {
    const api = store.getState();
    api.setLangPair('zh-TW→en');
    api.setIncludeSourceTranscript(false);
    api.setMicDistance('off');
    api.startSession();
    api.applyAudioLevel(level(-30, -10));
    api.applyHealth(health('audio', 'connected'));

    const persisted = JSON.parse(memLs.get('meeting-audio:settings:v1') ?? '{}');
    expect(persisted.langPair).toBe('zh-TW→en');
    expect(persisted.includeSourceTranscript).toBe(false);
    expect(persisted.micDistance).toBe('off');
    // Ephemeral fields MUST NOT be persisted — they're session-scoped.
    expect(persisted.sessionStartAt).toBeUndefined();
    expect(persisted.activeSessionBilingual).toBeUndefined();
    expect(persisted.audioLevel).toBeUndefined();
    expect(persisted.health).toBeUndefined();
    expect(persisted.translateMinutesAccum).toBeUndefined();
    expect(persisted.whisperMinutesAccum).toBeUndefined();
  });

  it('hydrates from localStorage on construction', () => {
    memLs.set(
      'meeting-audio:settings:v1',
      JSON.stringify({
        v: 1,
        scenarioId: 'physical',
        modeId: 'online_full',
        langPair: 'zh-TW→en',
        audioSource: 'mic',
        includeSourceTranscript: false,
        micDistance: 'far',
        transcriptRetentionEnabled: true,
      }),
    );
    const fresh = createSettingsStore().getState();
    expect(fresh.langPair).toBe('zh-TW→en');
    expect(fresh.includeSourceTranscript).toBe(false);
    expect(fresh.micDistance).toBe('far');
    expect(fresh.transcriptRetentionEnabled).toBe(true);
    // Ephemeral defaults intact.
    expect(fresh.sessionStartAt).toBeNull();
    expect(fresh.translateMinutesAccum).toBe(0);
  });

  it.each(['mic', 'system'] as const)(
    'restores an unavailable hybrid preset honestly, retaining %s',
    (audioSource) => {
      memLs.set(
        'meeting-audio:settings:v1',
        JSON.stringify({ v: 1, scenarioId: 'hybrid', audioSource }),
      );
      const fresh = createSettingsStore().getState();
      expect(fresh.scenarioId).toBe(audioSource === 'system' ? 'online_meeting_box' : 'physical');
      expect(fresh.audioSource).toBe(audioSource);
      expect(fresh.scenarioNotice).toContain('雙軌');
      expect(fresh.sessionStartAt).toBeNull();
    },
  );

  it('ignores stored prefs with a stale version', () => {
    memLs.set('meeting-audio:settings:v1', JSON.stringify({ v: 999, langPair: 'zh-TW→en' }));
    const fresh = createSettingsStore().getState();
    expect(fresh.langPair).toBe('en→zh-TW'); // default, not the persisted v999 value
  });
});

describe('SCENARIO_OPTIONS / MODE_OPTIONS', () => {
  it('exposes the four scenarios from CLAUDE.md', () => {
    expect(SCENARIO_OPTIONS.map((s) => s.id)).toEqual([
      'physical',
      'online_meeting_box',
      'hybrid',
      'advanced',
    ]);
  });

  it('marks Advanced as disabled in P1', () => {
    const adv = SCENARIO_OPTIONS.find((s) => s.id === 'advanced');
    expect(adv?.enabled).toBe(false);
    expect(adv?.hint).toBeTruthy();
  });

  it('keeps hybrid meeting unavailable until dual capture exists, independently of Hybrid Privacy', () => {
    expect(SCENARIO_OPTIONS.find((s) => s.id === 'hybrid')?.enabled).toBe(false);
    expect(SCENARIO_OPTIONS.find((s) => s.id === 'hybrid')?.hint).toContain('雙軌');
    expect(MODE_OPTIONS.find((m) => m.id === 'hybrid_privacy')?.enabled).toBe(true);
  });

  it('exposes the three modes from CLAUDE.md', () => {
    expect(MODE_OPTIONS.map((m) => m.id)).toEqual([
      'online_full',
      'hybrid_privacy',
      'full_offline',
    ]);
  });
});
