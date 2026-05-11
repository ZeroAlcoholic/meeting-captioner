import type { TranscriptEvent, TranslationEvent } from '@meeting-audio/contracts';

export type ProviderStatus = 'idle' | 'running' | 'stopped';

export interface CaptionProviderHandlers {
  onTranscript: (event: TranscriptEvent) => void;
  onTranslation: (event: TranslationEvent) => void;
}

export interface CaptionProvider {
  readonly name: string;
  readonly status: ProviderStatus;
  start(): void;
  stop(): void;
}
