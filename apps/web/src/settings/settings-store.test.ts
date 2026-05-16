import type { AudioLevelEvent, HealthEvent } from '@meeting-audio/contracts';
import { describe, expect, it } from 'vitest';
import { createSettingsStore, MODE_OPTIONS, SCENARIO_OPTIONS } from './settings-store.js';

const ts = '2026-05-11T10:00:00.000Z';

function health(component: HealthEvent['component'], state: HealthEvent['state'], message?: string): HealthEvent {
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
    for (const component of ['audio', 'stt', 'translation', 'summary', 'transport', 'ui'] as const) {
      expect(s.health[component]?.state).toBe('idle');
    }
  });

  it('starts with audioLevel null', () => {
    expect(createSettingsStore().getState().audioLevel).toBeNull();
  });
});

describe('settingsStore — setters', () => {
  it('setScenario updates scenarioId', () => {
    const store = createSettingsStore();
    store.getState().setScenario('hybrid');
    expect(store.getState().scenarioId).toBe('hybrid');
  });

  it('setMode updates modeId', () => {
    const store = createSettingsStore();
    store.getState().setMode('full_offline');
    expect(store.getState().modeId).toBe('full_offline');
  });
});

describe('settingsStore — applyHealth', () => {
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
    api.setScenario('hybrid');
    api.setMode('full_offline');
    api.applyAudioLevel(level(-30, -10));
    api.reset();
    const s = store.getState();
    expect(s.scenarioId).toBe('physical');
    expect(s.modeId).toBe('online_full');
    expect(s.audioLevel).toBeNull();
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

  it('exposes the three modes from CLAUDE.md', () => {
    expect(MODE_OPTIONS.map((m) => m.id)).toEqual(['online_full', 'hybrid_privacy', 'full_offline']);
  });
});
