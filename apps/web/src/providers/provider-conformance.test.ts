import {
  NormalizedEvent,
  type AudioLevelEvent,
  type HealthEvent,
  type TranscriptEvent,
  type TranslationEvent,
} from '@meeting-audio/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { AudioSource, CaptionProviderHandlers } from './types.js';
import { OpenAIRealtimeProvider } from './openai-realtime-provider.js';
import { GeminiLiveProvider } from './gemini-live-provider.js';
import { OfflineSTTProvider } from './offline-stt-provider.js';
import { FakeReplayProvider, type FakeReplayScript } from './fake-replay-provider.js';

/**
 * PROVIDER CONFORMANCE MATRIX.
 *
 * CLAUDE.md: "The UI must consume normalized events only … every provider must
 * adapt into these contracts." This suite enforces that mechanically — it drives
 * each provider through representative happy AND failure flows and asserts that
 * EVERY event it emits to the handlers validates against the shared
 * `NormalizedEvent` zod schema. A provider that leaks a backend-shaped or
 * malformed event (missing field, empty segmentId, wrong enum) fails here, at the
 * boundary, instead of corrupting the store/UI downstream.
 *
 * Providers are exercised through their event-adaptation layer (handleDCEvent /
 * handleServerObject / handleEvent / dispatch), which is exactly where backend
 * shapes become normalized events — so the test needs no live transport.
 */

interface Collected {
  handlers: CaptionProviderHandlers;
  events: Array<TranscriptEvent | TranslationEvent | HealthEvent | AudioLevelEvent>;
}

function collector(): Collected {
  const events: Collected['events'] = [];
  return {
    events,
    handlers: {
      onTranscript: (e) => events.push(e),
      onTranslation: (e) => events.push(e),
      onHealth: (e) => events.push(e),
      onAudioLevel: (e) => events.push(e),
    },
  };
}

// Minimal AudioSource stub — no provider flow under test acquires it (we never
// call start()), but the constructors accept one.
const stubMic: AudioSource = {
  analyser: null,
  acquire: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
  release: () => {},
};

/** Validate every collected event against the shared contract; report offenders. */
function expectAllConform(events: Collected['events']): void {
  const offenders = events.flatMap((e) => {
    const r = NormalizedEvent.safeParse(e);
    return r.success ? [] : [{ event: e, issues: r.error.issues }];
  });
  expect(offenders).toEqual([]);
}

function kinds(events: Collected['events']): Set<string> {
  return new Set(events.map((e) => e.kind));
}

describe('provider conformance — every emitted event matches NormalizedEvent', () => {
  it('OpenAIRealtimeProvider (deltas, finalize, error) emits only normalized events', () => {
    const { handlers, events } = collector();
    const p = new OpenAIRealtimeProvider('http://x/session', handlers, 'en→zh-TW', stubMic, true, 'meeting');
    const pa = p as unknown as {
      _status: string;
      newSegment(): void;
      handleDCEvent(ev: Record<string, unknown>): void;
      cleanup(): void;
    };
    pa._status = 'running';
    pa.newSegment();

    pa.handleDCEvent({ type: 'session.created' });
    pa.handleDCEvent({ type: 'session.input_transcript.delta', delta: 'Quarterly revenue grew.' });
    pa.handleDCEvent({ type: 'session.output_transcript.delta', delta: '本季營收成長。' });
    pa.handleDCEvent({ type: 'response.done' }); // finalize → final transcript + translation
    pa.handleDCEvent({ type: 'error', error: { message: 'simulated upstream error' } });
    pa.cleanup(); // clear any pending segment timers

    expectAllConform(events);
    expect(kinds(events)).toEqual(new Set(['transcript', 'translation', 'health']));
    // Finalization produced at least one final transcript + final translation.
    expect(events.some((e) => e.kind === 'transcript' && e.status === 'final')).toBe(true);
    expect(events.some((e) => e.kind === 'translation' && e.status === 'final')).toBe(true);
    expect(events.some((e) => e.kind === 'health' && e.state === 'api_error')).toBe(true);
  });

  it('GeminiLiveProvider (setup, transcription, sentence-finalize, goAway) emits only normalized events', () => {
    const { handlers, events } = collector();
    const g = new GeminiLiveProvider('http://x/session/gemini', handlers, stubMic, 'en→zh-TW', 'meeting');
    const ga = g as unknown as { _status: string };
    ga._status = 'running';

    g.handleServerObject({ setupComplete: {} }); // health: connected
    g.handleServerObject({ serverContent: { inputTranscription: { text: 'Hello team.', languageCode: 'en-US' } } });
    g.handleServerObject({ serverContent: { outputTranscription: { text: '大家好。' } } }); // sentence end → finalize
    g.handleServerObject({ serverContent: { turnComplete: true } });
    g.handleServerObject({ sessionResumptionUpdate: { newHandle: 'handle-1', resumable: true } });
    g.handleServerObject({ goAway: { timeLeft: '5s' } }); // health: reconnecting + finalize

    expectAllConform(events);
    expect(kinds(events)).toEqual(new Set(['transcript', 'translation', 'health']));
    expect(events.some((e) => e.kind === 'transcript' && e.status === 'final')).toBe(true);
    expect(events.some((e) => e.kind === 'translation' && e.status === 'final')).toBe(true);
    expect(events.some((e) => e.kind === 'health' && e.state === 'connected')).toBe(true);
    expect(events.some((e) => e.kind === 'health' && e.state === 'reconnecting')).toBe(true);
  });

  it('OfflineSTTProvider (transcript/translation/health passthrough + rebase) emits only normalized events', () => {
    const { handlers, events } = collector();
    const o = new OfflineSTTProvider('ws://x/ws', handlers, stubMic, 'en→zh-TW', 'mic', true);
    const oa = o as unknown as {
      connectionAnchorMs: number;
      handleEvent(ev: Record<string, unknown>): void;
    };
    oa.connectionAnchorMs = 10_000; // simulate a connected-and-anchored session

    const baseT = { provider: 'offline-stt', mode: 'full_offline' as const, source: 'microphone' as const };
    oa.handleEvent({ kind: 'transcript', ...baseT, segmentId: 'o1', status: 'partial', text: 'partial line', startMs: 200 });
    oa.handleEvent({ kind: 'transcript', ...baseT, segmentId: 'o1', status: 'final', text: 'final line.', startMs: 200, endMs: 1200 });
    oa.handleEvent({
      kind: 'translation', provider: 'offline-stt', mode: 'full_offline',
      sourceSegmentId: 'o1', status: 'final', sourceText: 'final line.', targetText: '最終句。',
      sourceLanguage: 'en', targetLanguage: 'zh-Hant', updatedAt: '2026-06-12T00:00:00.000Z',
    });
    oa.handleEvent({ kind: 'health', component: 'stt', state: 'connected', timestamp: '2026-06-12T00:00:00.000Z' });

    expectAllConform(events);
    expect(kinds(events)).toEqual(new Set(['transcript', 'translation', 'health']));
    // The rebase shifted startMs onto the wall-clock anchor (still a valid, nonneg int).
    const finalT = events.find((e) => e.kind === 'transcript' && e.status === 'final') as TranscriptEvent;
    expect(finalT.startMs).toBe(10_200);
  });

  it('FakeReplayProvider (scripted replay incl. audio_level) emits only normalized events', () => {
    vi.useFakeTimers();
    const { handlers, events } = collector();
    const script: FakeReplayScript = [
      { kind: 'health', component: 'transport', state: 'connected', timestamp: '2026-06-12T00:00:00.000Z', tMs: 0 },
      { kind: 'transcript', provider: 'fake-replay', mode: 'full_offline', source: 'fake_replay', segmentId: 'f1', status: 'partial', text: 'Welcome.', startMs: 0, tMs: 10 },
      { kind: 'translation', provider: 'fake-replay', mode: 'full_offline', sourceSegmentId: 'f1', status: 'draft', sourceText: 'Welcome.', targetText: '歡迎。', sourceLanguage: 'en', targetLanguage: 'zh-Hant', updatedAt: '2026-06-12T00:00:00.000Z', tMs: 20 },
      { kind: 'transcript', provider: 'fake-replay', mode: 'full_offline', source: 'fake_replay', segmentId: 'f1', status: 'final', text: 'Welcome.', startMs: 0, endMs: 500, tMs: 30 },
      { kind: 'audio_level', source: 'fake_replay', rmsDb: -24, peakDb: -12, timestamp: '2026-06-12T00:00:00.000Z', tMs: 40 },
    ];
    const f = new FakeReplayProvider(script, handlers);
    void f.start();
    vi.runAllTimers();
    vi.useRealTimers();

    expectAllConform(events);
    expect(kinds(events)).toEqual(new Set(['health', 'transcript', 'translation', 'audio_level']));
    expect(events.length).toBe(script.length);
  });
});
