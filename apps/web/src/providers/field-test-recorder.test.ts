import type { LatencySample, ProviderSummary } from './latency-monitor.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldTestRecorder, type FieldTestSettingsSnapshot } from './field-test-recorder.js';

class MemoryStorage {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

function settings(provider = 'openai'): FieldTestSettingsSnapshot {
  return {
    scenarioId: 'online_meeting_box',
    modeId: 'online_full',
    onlineProvider: provider,
    audioSource: 'system',
    langPair: 'en→zh-TW',
    includeSourceTranscript: true,
    micDistance: 'off',
  };
}

function latency(
  samples: LatencySample[],
  summary: ProviderSummary[] = [],
): {
  summary(): ProviderSummary[];
  export(): { sessionProvider: string | null; ttfcMs: number | null; samples: LatencySample[] };
} {
  return {
    summary: () => summary,
    export: () => ({ sessionProvider: samples[0]?.provider ?? null, ttfcMs: null, samples }),
  };
}

function sample(provider: string, atMs: number, lagMs: number): LatencySample {
  return { provider, atMs, lagMs, durMs: lagMs + 100 };
}

describe('FieldTestRecorder', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records settings, markers, run-local samples, and persists history', () => {
    let now = 1_000;
    const storage = new MemoryStorage();
    const recorder = new FieldTestRecorder({
      now: () => now,
      storage,
      settings: () => settings('openai'),
      latency: latency([
        sample('openai-realtime', 900, 10),
        sample('openai-realtime', 1_100, 300),
        sample('openai-realtime', 1_300, 500),
        sample('gemini-live', 2_000, 900),
      ]),
    });

    const active = recorder.start('YT OpenAI', 'BBC clip 00:30');
    expect(active.settings.audioSource).toBe('system');
    expect(active.settings.onlineProvider).toBe('openai');

    now = 1_050;
    recorder.mark('press play');
    now = 1_400;
    const done = recorder.finish('60s sample');

    expect(done.label).toBe('YT OpenAI');
    expect(done.markers).toHaveLength(1);
    expect(done.samples.map((s) => s.atMs)).toEqual([1_100, 1_300]);
    expect(done.runSummary).toEqual([
      { provider: 'openai-realtime', samples: 2, lagP50: 500, lagP95: 500, durP50: 600 },
    ]);
    expect(recorder.history()).toHaveLength(1);
    expect(recorder.current()).toBeNull();
  });

  it('requires finish or cancel before starting another run', () => {
    const recorder = new FieldTestRecorder({
      now: () => 1,
      storage: new MemoryStorage(),
      settings,
      latency: latency([]),
    });
    recorder.start('one');
    expect(() => recorder.start('two')).toThrow(/already active/);
    expect(recorder.cancel('aborted')?.note).toContain('aborted');
    expect(() => recorder.start('two')).not.toThrow();
  });

  it('startTimed auto-finishes and persists the run', () => {
    vi.useFakeTimers();
    let now = 10_000;
    const storage = new MemoryStorage();
    const recorder = new FieldTestRecorder({
      now: () => now,
      storage,
      settings,
      latency: latency([sample('openai-realtime', 11_000, 250)]),
    });

    recorder.startTimed('YT OpenAI timed', 60_000, 'auto run');
    expect(recorder.current()?.label).toBe('YT OpenAI timed');
    expect(recorder.history()).toHaveLength(0);

    now = 70_000;
    vi.advanceTimersByTime(60_000);

    expect(recorder.current()).toBeNull();
    expect(recorder.history()).toHaveLength(1);
    expect(recorder.history()[0]!.finishNote).toContain('auto-finished');
    expect(recorder.history()[0]!.samples).toHaveLength(1);
  });

  it('notifies subscribers when recorder state changes', () => {
    let now = 1;
    const recorder = new FieldTestRecorder({
      now: () => now,
      storage: new MemoryStorage(),
      settings,
      latency: latency([sample('openai-realtime', 3, 100)]),
    });
    const listener = vi.fn();
    const unsubscribe = recorder.subscribe(listener);

    recorder.start('subscribed');
    recorder.mark('running');
    now = 4;
    recorder.finish('done');
    recorder.clear();

    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    recorder.start('not observed');
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('clear removes active run and persisted history', () => {
    let now = 1;
    const storage = new MemoryStorage();
    const recorder = new FieldTestRecorder({
      now: () => now,
      storage,
      settings,
      latency: latency([sample('gemini-live', 2, 100)]),
    });
    recorder.start('Gemini');
    now = 3;
    recorder.finish();
    expect(recorder.history()).toHaveLength(1);
    recorder.start('active');
    recorder.clear();
    expect(recorder.current()).toBeNull();
    expect(recorder.history()).toHaveLength(0);
  });
});
