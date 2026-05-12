import {
  AudioLevelEvent,
  HealthEvent,
  TranscriptEvent,
  TranslationEvent,
} from '@meeting-audio/contracts';
import { z } from 'zod';
import type { CaptionProvider, CaptionProviderHandlers, ProviderStatus } from './types.js';

const TimedTranscript = TranscriptEvent.extend({ tMs: z.number().int().nonnegative() });
const TimedTranslation = TranslationEvent.extend({ tMs: z.number().int().nonnegative() });
const TimedHealth = HealthEvent.extend({ tMs: z.number().int().nonnegative() });
const TimedAudioLevel = AudioLevelEvent.extend({ tMs: z.number().int().nonnegative() });

export const FakeReplayEntry = z.discriminatedUnion('kind', [
  TimedTranscript,
  TimedTranslation,
  TimedHealth,
  TimedAudioLevel,
]);
export type FakeReplayEntry = z.infer<typeof FakeReplayEntry>;

export const FakeReplayScript = z.array(FakeReplayEntry);
export type FakeReplayScript = z.infer<typeof FakeReplayScript>;

export class FakeReplayProvider implements CaptionProvider {
  readonly name = 'fake-replay';
  status: ProviderStatus = 'idle';
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private readonly script: FakeReplayScript,
    private readonly handlers: CaptionProviderHandlers,
  ) {}

  start(): Promise<void> {
    if (this.status === 'running') return Promise.resolve();
    this.status = 'running';
    for (const entry of this.script) {
      const timer = setTimeout(() => this.dispatch(entry), entry.tMs);
      this.timers.push(timer);
    }
    return Promise.resolve();
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.status = 'stopped';
  }

  private dispatch(entry: FakeReplayEntry): void {
    switch (entry.kind) {
      case 'transcript': {
        const { tMs: _t, ...event } = entry;
        this.handlers.onTranscript(event);
        return;
      }
      case 'translation': {
        const { tMs: _t, ...event } = entry;
        this.handlers.onTranslation(event);
        return;
      }
      case 'health': {
        const { tMs: _t, ...event } = entry;
        this.handlers.onHealth(event);
        return;
      }
      case 'audio_level': {
        const { tMs: _t, ...event } = entry;
        this.handlers.onAudioLevel(event);
        return;
      }
    }
  }
}
