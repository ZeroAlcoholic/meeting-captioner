import type {
  AudioLevelEvent,
  HealthEvent,
  TranscriptEvent,
  TranslationEvent,
} from '@meeting-audio/contracts';

export type ProviderStatus = 'idle' | 'running' | 'stopped';

export interface CaptionProviderHandlers {
  onTranscript: (event: TranscriptEvent) => void;
  onTranslation: (event: TranslationEvent) => void;
  onHealth: (event: HealthEvent) => void;
  onAudioLevel: (event: AudioLevelEvent) => void;
}

export interface CaptionProvider {
  readonly name: string;
  readonly status: ProviderStatus;
  start(): Promise<void>;
  stop(): void;
}

/** Audio capture source injected into caption providers. */
export interface AudioSource {
  readonly analyser: AnalyserNode | null;
  acquire(onHealth: (e: HealthEvent) => void): Promise<MediaStream>;
  release(): void;
}

/**
 * Offline translation step separate from STT.
 * Online providers (gpt-realtime-translate) do both in one step — they don't implement this.
 * Offline providers call STT first, then translate via TranslationPipeline.
 */
export interface TranslationPipeline {
  readonly name: string;
  translate(sourceText: string, sourceLang: string, targetLang: string): Promise<string>;
}
