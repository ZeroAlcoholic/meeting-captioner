import type { LatencySample, ProviderSummary } from './latency-monitor.js';
import { latencyMonitor } from './latency-monitor.js';
import { settingsStore } from '../settings/use-settings-store.js';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface LatencySource {
  summary(): ProviderSummary[];
  export(): { sessionProvider: string | null; ttfcMs: number | null; samples: LatencySample[] };
}

export interface FieldTestSettingsSnapshot {
  scenarioId: string;
  modeId: string;
  onlineProvider: string;
  audioSource: string;
  langPair: string;
  includeSourceTranscript: boolean;
  micDistance: string;
}

export interface FieldTestMarker {
  label: string;
  atMs: number;
  at: string;
  note?: string;
}

export interface FieldTestRunSummary {
  provider: string;
  samples: number;
  lagP50: number | null;
  lagP95: number | null;
  durP50: number | null;
}

export interface ActiveFieldTestRun {
  id: string;
  label: string;
  startedAtMs: number;
  startedAt: string;
  settings: FieldTestSettingsSnapshot;
  markers: FieldTestMarker[];
  note?: string;
}

export interface CompletedFieldTestRun extends ActiveFieldTestRun {
  endedAtMs: number;
  endedAt: string;
  durationMs: number;
  finishNote?: string;
  latencySummaryAtFinish: ProviderSummary[];
  runSummary: FieldTestRunSummary[];
  samples: LatencySample[];
}

export interface FieldTestRecorderOptions {
  now?: () => number;
  latency?: LatencySource;
  storage?: StorageLike | null;
  settings?: () => FieldTestSettingsSnapshot;
  historyLimit?: number;
}

export interface FieldTestSnapshot {
  active: ActiveFieldTestRun | null;
  history: CompletedFieldTestRun[];
}

type FieldTestListener = () => void;

const STORAGE_KEY = 'meeting-audio:field-tests:v1';
const DEFAULT_HISTORY_LIMIT = 20;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? null;
}

function summarizeSamples(samples: LatencySample[]): FieldTestRunSummary[] {
  const byProvider = new Map<string, LatencySample[]>();
  for (const sample of samples) {
    const arr = byProvider.get(sample.provider) ?? [];
    arr.push(sample);
    byProvider.set(sample.provider, arr);
  }
  return Array.from(byProvider.entries()).map(([provider, arr]) => {
    const lags = arr.map((s) => s.lagMs).filter((x) => x >= 0).sort((a, b) => a - b);
    const durs = arr.map((s) => s.durMs).sort((a, b) => a - b);
    return {
      provider,
      samples: arr.length,
      lagP50: percentile(lags, 50),
      lagP95: percentile(lags, 95),
      durP50: percentile(durs, 50),
    };
  });
}

function defaultSettings(): FieldTestSettingsSnapshot {
  const s = settingsStore.getState();
  return {
    scenarioId: s.scenarioId,
    modeId: s.modeId,
    onlineProvider: s.onlineProvider,
    audioSource: s.audioSource,
    langPair: s.langPair,
    includeSourceTranscript: s.includeSourceTranscript,
    micDistance: s.micDistance,
  };
}

function defaultStorage(): StorageLike | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

function makeId(nowMs: number): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `field-${nowMs.toString(36)}-${rand}`;
}

export class FieldTestRecorder {
  private active: ActiveFieldTestRun | null = null;
  private readonly now: () => number;
  private readonly latency: LatencySource;
  private readonly storage: StorageLike | null;
  private readonly settings: () => FieldTestSettingsSnapshot;
  private readonly historyLimit: number;
  private readonly listeners = new Set<FieldTestListener>();
  private autoFinishTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: FieldTestRecorderOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.latency = opts.latency ?? latencyMonitor;
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.settings = opts.settings ?? defaultSettings;
    this.historyLimit = opts.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  }

  start(label = 'field-test', note?: string): ActiveFieldTestRun {
    if (this.active) {
      throw new Error('A field test run is already active; call finish() or cancel() first.');
    }
    const startedAtMs = this.now();
    const run: ActiveFieldTestRun = {
      id: makeId(startedAtMs),
      label,
      startedAtMs,
      startedAt: new Date(startedAtMs).toISOString(),
      settings: this.settings(),
      markers: [],
    };
    if (note !== undefined) run.note = note;
    this.active = run;
    this.emit();
    return this.current()!;
  }

  startTimed(label: string, durationMs: number, note?: string): ActiveFieldTestRun {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error('durationMs must be a positive number.');
    }
    const run = this.start(label, note);
    this.autoFinishTimer = setTimeout(() => {
      if (!this.active) return;
      this.finish(`auto-finished after ${Math.round(durationMs)} ms`);
    }, durationMs);
    return run;
  }

  mark(label: string, note?: string): FieldTestMarker {
    if (!this.active) throw new Error('No active field test run. Call start() first.');
    const atMs = this.now();
    const marker: FieldTestMarker = { label, atMs, at: new Date(atMs).toISOString() };
    if (note !== undefined) marker.note = note;
    this.active.markers.push(marker);
    this.emit();
    return marker;
  }

  finish(note?: string): CompletedFieldTestRun {
    if (!this.active) throw new Error('No active field test run. Call start() first.');
    this.clearAutoFinishTimer();
    const endedAtMs = this.now();
    const latencyExport = this.latency.export();
    const samples = latencyExport.samples.filter(
      (sample) => sample.atMs >= this.active!.startedAtMs && sample.atMs <= endedAtMs,
    );
    const completed: CompletedFieldTestRun = {
      ...this.active,
      markers: [...this.active.markers],
      endedAtMs,
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: endedAtMs - this.active.startedAtMs,
      latencySummaryAtFinish: this.latency.summary(),
      runSummary: summarizeSamples(samples),
      samples,
    };
    if (note !== undefined) completed.finishNote = note;
    this.active = null;
    this.appendHistory(completed);
    this.emit();
    return completed;
  }

  cancel(note?: string): ActiveFieldTestRun | null {
    this.clearAutoFinishTimer();
    const run = this.active;
    if (run && note !== undefined) run.note = run.note ? `${run.note}\n${note}` : note;
    this.active = null;
    this.emit();
    return run ? { ...run, markers: [...run.markers] } : null;
  }

  current(): ActiveFieldTestRun | null {
    return this.active ? { ...this.active, markers: [...this.active.markers] } : null;
  }

  history(): CompletedFieldTestRun[] {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as CompletedFieldTestRun[]) : [];
    } catch {
      return [];
    }
  }

  snapshot(): FieldTestSnapshot {
    return { active: this.current(), history: this.history() };
  }

  subscribe(listener: FieldTestListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.clearAutoFinishTimer();
    this.active = null;
    this.storage?.removeItem(STORAGE_KEY);
    this.emit();
  }

  private clearAutoFinishTimer(): void {
    if (this.autoFinishTimer !== null) {
      clearTimeout(this.autoFinishTimer);
      this.autoFinishTimer = null;
    }
  }

  private appendHistory(run: CompletedFieldTestRun): void {
    if (!this.storage) return;
    try {
      const next = [...this.history(), run].slice(-this.historyLimit);
      this.storage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Best-effort diagnostics only; never affect captioning.
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const fieldTestRecorder = new FieldTestRecorder();

export function __resetFieldTestRecorderForTests(): void {
  fieldTestRecorder.clear();
}

if (typeof window !== 'undefined') {
  (window as unknown as { __fieldTest: FieldTestRecorder }).__fieldTest = fieldTestRecorder;
}
