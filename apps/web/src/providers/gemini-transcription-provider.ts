import type {
  AudioSourceKind,
  HealthState,
  HealthEvent,
  TranscriptEvent,
  RecoveryFailure,
} from '@meeting-audio/contracts';
import type { AudioSource, CaptionProviderHandlers, ProviderStatus } from './types.js';
import type { MicDistance } from './microphone-audio-provider.js';
import { leaseCapture } from './capture-lease.js';
import { arrayBufferToBase64, floatTo16BitPCM } from './gemini-live-provider.js';
import {
  createRecoveryAttempt,
  assertRecoveryAllowed,
  recoveryHttpError,
  RecoveryError,
  normalizeRecoveryError,
  recoveryError,
  protocolRecoveryKind,
} from './recovery-attempt.js';
import {
  createTranscriptionAudio,
  TranscriptionSpeechGate,
  type TranscriptionAudio,
  type TranscriptionAudioFactory,
  type TranscriptionGatePolicy,
} from './transcription-audio.js';
import { loadTranscriptNormalizer, normalizeTranscript } from './transcript-normalization.js';

const MODEL = 'gemini-3.5-transcribe-live';
const ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
export interface GeminiTranscriptionOptions {
  sessionUrl: string;
  handlers: CaptionProviderHandlers;
  task?: { inputLanguages?: readonly string[] };
  audioSource?: AudioSource;
  micDistance?: MicDistance;
  source?: AudioSourceKind;
  /** Endpointing thresholds; defaults ship unchanged. See TranscriptionGatePolicy. */
  gatePolicy?: Partial<TranscriptionGatePolicy>;
  dependencies?: {
    fetch?: typeof fetch;
    socket?: (url: string) => WebSocket;
    audio?: TranscriptionAudioFactory;
  };
}
interface Segment {
  id: string;
  start: number;
  end: number;
  continuationOf?: string;
}
interface Activity {
  segment: Segment | undefined;
  start: number;
  nextStart: number;
  end: number;
  closed: boolean;
  generationComplete: boolean;
}

/** Literal transcription only. No translation config, assistant response or audio playback. */
export class GeminiTranscriptionProvider {
  readonly name = 'gemini-transcription';
  private state: ProviderStatus = 'idle';
  private readonly listeners = new Set<(state: ProviderStatus) => void>();
  private readonly capture: AudioSource;
  private controller = new AbortController();
  private generation = 0;
  private starting = false;
  private preparation: Promise<void> | null = null;
  private prepared = false;
  private concurrentRenewalAllowed = false;
  private activated = false;
  private preparedStream: MediaStream | null = null;
  private pendingAudioHealth: HealthEvent | null = null;
  private socket: WebSocket | null = null;
  private audio: TranscriptionAudio | null = null;
  private gate: TranscriptionSpeechGate | null = null;
  private active: Activity | null = null;
  private activities: Activity[] = [];
  private serial = 0;
  private prefix = '';
  private previousSegment: string | undefined;
  private unassigned: Segment | undefined;
  private lastAudioEnd = 0;
  private lastFinalEnd = 0;
  private lastMeter = -Infinity;
  private lastSpeech = 0;
  private silent = false;
  private renewAt: number | null = null;
  private stopping: Promise<void> | null = null;
  private drain: (() => void) | null = null;
  private drainQuiet: ReturnType<typeof setTimeout> | undefined;
  private awaitingGeneration = false;
  private inputQueue: Array<{ realtimeInput: Record<string, unknown> }> = [];

  constructor(private readonly options: GeminiTranscriptionOptions) {
    this.capture =
      options.audioSource ??
      leaseCapture({ kind: 'mic', micDistance: options.micDistance ?? 'meeting' });
  }
  get status(): ProviderStatus {
    return this.state;
  }
  onStatus(listener: (state: ProviderStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getRenewalEtaMs(): number | null {
    return this.renewAt === null ? null : Math.max(0, this.renewAt - Date.now());
  }
  allowsConcurrentRenewal(): boolean {
    return this.concurrentRenewalAllowed;
  }

  async start(): Promise<void> {
    if (this.state === 'running') return;
    if (this.stopping) await this.stopping;
    const pending = this.prepare();
    const generation = this.generation;
    try {
      await pending;
      if (generation === this.generation) this.activate();
    } catch {
      // Preparation publishes its normalized failure; start historically resolves.
    }
  }

  prepare(): Promise<void> {
    if (this.stopping) return this.stopping.then(() => this.prepare());
    if (this.prepared || this.activated) return Promise.resolve();
    if (this.preparation) return this.preparation;
    const generation = this.generation + 1;
    const pending = this.prepareCandidate()
      .then(() => {
        if (!this.prepared || generation !== this.generation)
          throw new Error('Gemini transcription preparation cancelled or failed');
      })
      .finally(() => {
        if (this.preparation === pending) this.preparation = null;
      });
    this.preparation = pending;
    return pending;
  }

  activate(): void {
    if (this.activated) return;
    if (!this.isPrepared()) {
      this.dispose();
      throw new Error('Gemini transcription candidate is no longer ready');
    }
    this.activated = true;
    const generation = this.generation;
    const assertActive = () => {
      if (generation !== this.generation || this.stopping || !this.isPrepared())
        throw new DOMException('Transcription activation cancelled', 'AbortError');
    };
    this.setStatus('running');
    assertActive();
    if (this.pendingAudioHealth) this.options.handlers.onHealth(this.pendingAudioHealth);
    this.pendingAudioHealth = null;
    assertActive();
    this.health('connected');
  }

  isPrepared(): boolean {
    const tracks = this.preparedStream?.getAudioTracks() ?? [];
    return (
      this.prepared &&
      !this.controller.signal.aborted &&
      this.audio !== null &&
      this.socket?.readyState === 1 &&
      tracks.length > 0 &&
      tracks.every((track) => track.readyState !== 'ended')
    );
  }

  private audioHealth(event: HealthEvent): void {
    if (this.activated || event.state === 'failed' || event.state === 'no_audio_track')
      this.options.handlers.onHealth(event);
    else this.pendingAudioHealth = event;
  }

  private async prepareCandidate(): Promise<void> {
    if (this.starting || this.state === 'running') return;
    if (this.stopping) await this.stopping;
    this.starting = true;
    const generation = ++this.generation;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const current = () => generation === this.generation && !signal.aborted;
    this.activities = [];
    this.awaitingGeneration = false;
    this.inputQueue = [];
    this.active = null;
    this.serial = 0;
    this.prefix = crypto.randomUUID();
    this.previousSegment = undefined;
    this.unassigned = undefined;
    this.lastAudioEnd = 0;
    this.lastFinalEnd = 0;
    this.lastMeter = -Infinity;
    this.lastSpeech = 0;
    this.silent = false;
    this.health('connecting');
    // Runs alongside the capture permission, the mint and the VAD model; awaited
    // before captions start so none is ever published unconverted.
    const normalizer = loadTranscriptNormalizer();
    normalizer.catch(() => {});
    let phase: 'audio' | 'network' = 'audio';
    try {
      assertRecoveryAllowed('gemini', 'transcription');
      const stream = await this.capture.acquire((event) => {
        if (!current()) return;
        this.audioHealth(event);
        if (event.state === 'failed' || event.state === 'no_audio_track') this.dispose();
      });
      if (!current()) {
        if (!this.starting && this.status !== 'running') this.capture.release();
        return;
      }
      if (
        !stream.getAudioTracks().length ||
        stream.getAudioTracks().some((track) => track.readyState === 'ended')
      )
        throw new Error('No live audio track');
      phase = 'network';
      const setupDeadline = performance.now() + 15_000;
      const mint = createRecoveryAttempt({
        parentSignal: signal,
        generation,
        isCurrent: current,
        timeoutMs: 15000,
        label: 'Gemini transcription token',
      });
      let token: {
        token?: string;
        model?: string;
        expiresAt?: number;
        concurrent_renewal_allowed?: boolean;
        session_renewal_recommended_ms?: unknown;
      };
      try {
        token = await mint.run(async (mintSignal) => {
          const response = await (this.options.dependencies?.fetch ?? fetch)(
            this.options.sessionUrl,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: mintSignal,
              body: JSON.stringify({
                inputLanguages: this.options.task?.inputLanguages ?? ['zh-tw', 'en'],
                micDistance: this.options.micDistance ?? 'meeting',
              }),
            },
          );
          mintSignal.throwIfAborted();
          if (!current()) throw new DOMException('Superseded', 'AbortError');
          if (!response.ok) throw recoveryHttpError(response, 'gemini', 'transcription');
          return response.json();
        });
      } finally {
        mint.dispose();
      }
      if (!current()) return;
      if (token?.model && token.model !== MODEL && token.model !== `models/${MODEL}`)
        throw recoveryError(
          'unsupported',
          'gemini',
          'transcription',
          'Unsupported Gemini transcription model',
        );
      if (
        (token?.model !== MODEL && token?.model !== `models/${MODEL}`) ||
        typeof token.token !== 'string' ||
        !token.token ||
        !Number.isFinite(token.expiresAt) ||
        token.expiresAt! <= Date.now()
      )
        throw new Error('Invalid Gemini transcription credential');
      let socket: WebSocket;
      try {
        socket = (this.options.dependencies?.socket ?? ((url) => new WebSocket(url)))(
          `${ENDPOINT}?access_token=${encodeURIComponent(token.token)}`,
        );
      } catch {
        throw new Error('Gemini transcription socket could not be created');
      }
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      const connect = createRecoveryAttempt({
        parentSignal: signal,
        generation,
        isCurrent: current,
        timeoutMs: Math.max(1, setupDeadline - performance.now()),
        label: 'Gemini transcription readiness',
      });
      let ready = false;
      try {
        await connect.run(
          () =>
            new Promise<void>((resolve, reject) => {
              socket.onopen = () => {
                if (!current()) return;
                try {
                  this.send({
                    setup: {
                      model: `models/${MODEL}`,
                      generationConfig: { responseModalities: ['TEXT'] },
                      inputAudioTranscription: { languageCodes: [], mode: 'VERBATIM' },
                      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
                    },
                  });
                } catch {
                  reject(new Error('Gemini transcription setup could not be sent'));
                }
              };
              socket.onmessage = (message) => {
                if (!current()) return;
                try {
                  const raw =
                    typeof message.data === 'string'
                      ? message.data
                      : message.data instanceof ArrayBuffer
                        ? new TextDecoder().decode(message.data)
                        : null;
                  if (raw === null || raw.length > 200000)
                    throw new Error('Malformed Gemini transcription frame');
                  const event = JSON.parse(raw);
                  if (!event || typeof event !== 'object')
                    throw new Error('Malformed Gemini transcription event');
                  if (event.error) {
                    const kind = protocolRecoveryKind(event.error);
                    throw recoveryError(
                      kind,
                      'gemini',
                      'transcription',
                      'Gemini transcription API failed; unfinished audio gap',
                      kind === 'rate-limit' ? performance.now() + 15_000 : undefined,
                    );
                  }
                  if (event.goAway)
                    throw new Error(
                      'Gemini transcription session ending; retry required, possible audio gap',
                    );
                  if (event.setupComplete) {
                    ready = true;
                    resolve();
                  }
                  if (event.serverContent) {
                    if (!ready) throw new Error('Gemini transcript arrived before setupComplete');
                    if (!this.activated) return;
                    this.receive(event.serverContent);
                    if (event.serverContent.generationComplete) this.completeGeneration();
                  }
                } catch (error) {
                  const safe =
                    error instanceof SyntaxError
                      ? new Error('Malformed Gemini transcription event')
                      : error instanceof Error
                        ? error
                        : new Error('Gemini transcription event failed');
                  if (!ready) reject(safe);
                  else {
                    const failure = normalizeRecoveryError(safe, 'gemini', 'transcription');
                    this.fail(failure.message, failure.failure);
                  }
                }
              };
              socket.onclose = () => {
                if (!current()) return;
                if (!ready) reject(new Error('Gemini transcription closed before readiness'));
                else this.fail('Gemini transcription disconnected; unfinished audio gap');
              };
              socket.onerror = () => {};
            }),
        );
      } finally {
        connect.dispose();
      }
      if (!current()) return;
      const recommended = token.session_renewal_recommended_ms;
      this.renewAt =
        Date.now() +
        (typeof recommended === 'number' && Number.isFinite(recommended) && recommended > 0
          ? Math.min(recommended, 8 * 60000)
          : 8 * 60000);
      this.concurrentRenewalAllowed = token.concurrent_renewal_allowed === true;
      // Before any audio can be sent: the first transcript may come back at
      // once, and normalizing it without the dictionary would fail the session.
      phase = 'audio';
      await normalizer;
      if (!current()) return;
      this.gate = new TranscriptionSpeechGate(
        (frame, start, continuation) => {
          if (!this.active) {
            if (this.activities.length >= 64)
              throw new Error('Gemini pending transcript limit; audio gap');
            const activity: Activity = {
              segment: this.segment(start, start, continuation),
              start,
              nextStart: start,
              end: start,
              closed: false,
              generationComplete: false,
            };
            this.activities.push(activity);
            this.active = activity;
            this.sendInput({ realtimeInput: { activityStart: {} } });
          }
          const activity = this.active;
          activity.generationComplete = false;
          activity.end = start + frame.length / 16;
          if (activity.segment) activity.segment.end = activity.end;
          this.lastAudioEnd = activity.end;
          this.sendInput({
            realtimeInput: {
              audio: {
                data: arrayBufferToBase64(floatTo16BitPCM(frame)),
                mimeType: 'audio/pcm;rate=16000',
              },
            },
          });
        },
        (_start, end) => {
          if (!this.active) return;
          const activity = this.active;
          activity.end = end;
          activity.closed = true;
          if (activity.segment) activity.segment.end = end;
          this.active = null;
          this.sendInput({ realtimeInput: { activityEnd: {} } });
          if (activity.generationComplete) this.completeGeneration();
        },
        this.options.gatePolicy,
      );
      const prepare = createRecoveryAttempt({
        parentSignal: signal,
        generation,
        isCurrent: current,
        timeoutMs: 15000,
        label: 'Gemini local VAD setup',
      });
      try {
        const operation = (this.options.dependencies?.audio ?? createTranscriptionAudio)(
          stream,
          {
            onHealth: (event) => {
              if (current()) this.audioHealth(event);
            },
            onFrame: (frame, probability, start) => {
              if (!current() || !this.activated) return;
              try {
                if (start - this.lastMeter >= 128) {
                  this.lastMeter = start;
                  let sum = 0;
                  let peak = 0;
                  for (const sample of frame) {
                    sum += sample * sample;
                    peak = Math.max(peak, Math.abs(sample));
                  }
                  this.options.handlers.onAudioLevel({
                    kind: 'audio_level',
                    source: this.options.source ?? 'microphone',
                    rmsDb: 20 * Math.log10(Math.max(1e-10, Math.sqrt(sum / frame.length))),
                    peakDb: 20 * Math.log10(Math.max(1e-10, peak)),
                    timestamp: new Date().toISOString(),
                  });
                }
                this.gate?.push(frame, probability, start);
                if (!this.lastSpeech) this.lastSpeech = start;
                if (probability >= 0.5) {
                  this.lastSpeech = start;
                  if (this.silent) {
                    this.silent = false;
                    this.health('connected');
                  }
                } else if (!this.silent && start - this.lastSpeech > 30000) {
                  this.silent = true;
                  this.health('silence_detected');
                }
              } catch {
                this.fail('Gemini audio delivery failed; unfinished audio gap');
              }
            },
            onError: () => {
              if (current()) this.fail('Gemini VAD failed; unfinished audio gap');
            },
          },
          signal,
        ).then((audio) => {
          if (!current()) audio.dispose();
          return audio;
        });
        const audio = await prepare.run(() => operation);
        if (!current()) {
          audio.dispose();
          return;
        }
        this.audio = audio;
      } finally {
        prepare.dispose();
      }
      this.preparedStream = stream;
      this.prepared = true;
    } catch (error) {
      if (!current()) return;
      if (phase === 'audio' && !(error instanceof RecoveryError)) {
        this.options.handlers.onHealth({
          kind: 'health',
          component: 'audio',
          state: 'failed',
          message: '收音或本機音訊處理無法啟動，請檢查音源。',
          timestamp: new Date().toISOString(),
        });
        this.dispose();
      } else {
        const failure = normalizeRecoveryError(error, 'gemini', 'transcription');
        this.fail(failure.message, failure.failure);
      }
    } finally {
      if (generation === this.generation) this.starting = false;
    }
  }

  private segment(start: number, end: number, continuation: boolean): Segment {
    const previous = this.previousSegment;
    const segment: Segment = {
      id: `${this.prefix}:${++this.serial}`,
      start,
      end,
      ...(continuation && previous ? { continuationOf: previous } : {}),
    };
    this.previousSegment = segment.id;
    return segment;
  }
  private receive(content: {
    interimInputTranscription?: { text?: unknown };
    inputTranscription?: { text?: unknown };
  }): void {
    for (const [field, status] of [
      ['interimInputTranscription', 'partial'],
      ['inputTranscription', 'final'],
    ] as const) {
      if (!content[field]) continue;
      const raw = content[field].text;
      if (typeof raw !== 'string' || raw.length > 100000)
        throw new Error('Malformed Gemini transcription text');
      const activity = this.unassigned ? undefined : this.activities[0];
      if (!activity && !this.lastAudioEnd)
        throw new Error('Gemini transcript has no captured audio');
      // Gemini supplies no stable item ID. Each final remains a distinct local
      // segment; text equality cannot distinguish repetition from retransmission.
      const segment = activity
        ? (activity.segment ??= this.segment(
            // No provider word timestamps: use new captured audio when present;
            // otherwise retain this activity's bounds (possibly overlapping),
            // rather than inventing a zero-length or next-activity subtitle.
            activity.nextStart < activity.end ? activity.nextStart : activity.start,
            activity.end,
            false,
          ))
        : (this.unassigned ??= this.segment(
            this.lastFinalEnd || this.lastAudioEnd,
            this.lastAudioEnd,
            false,
          ));
      const event: TranscriptEvent = {
        kind: 'transcript',
        provider: this.name,
        mode: 'online_full',
        source: this.options.source ?? 'microphone',
        segmentId: segment.id,
        status,
        ...normalizeTranscript(raw),
        timingBasis: 'capture-estimated',
        startMs: Math.round(segment.start),
        ...(status === 'final' ? { endMs: Math.round(segment.end) } : {}),
        ...(segment.continuationOf ? { continuationOf: segment.continuationOf } : {}),
      };
      this.options.handlers.onTranscript(event);
      if (status === 'final') {
        this.lastFinalEnd = segment.end;
        if (activity) {
          activity.segment = undefined;
          activity.nextStart = segment.end;
        } else this.unassigned = undefined;
      }
      this.maybeDrain();
    }
  }
  private completeGeneration(): void {
    const activity = this.activities[0];
    if (!activity) return;
    activity.generationComplete = true;
    // Final fragments are not activity acknowledgements. Keep their owner until
    // the server finishes the generation, even when the next audio is queued.
    if (!activity.closed) return;
    if (activity.segment)
      this.health('degraded', 'Gemini generation ended without a final transcript; audio gap');
    this.activities.shift();
    this.awaitingGeneration = false;
    while (!this.awaitingGeneration && this.inputQueue.length)
      this.sendInput(this.inputQueue.shift()!);
    this.maybeDrain();
  }
  private hasPendingGeneration(): boolean {
    return (
      this.activities.length > 0 ||
      !!this.unassigned ||
      this.awaitingGeneration ||
      this.inputQueue.length > 0
    );
  }
  private maybeDrain(): void {
    clearTimeout(this.drainQuiet);
    if (this.drain && !this.hasPendingGeneration())
      this.drainQuiet = setTimeout(() => this.drain?.(), 250);
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.state !== 'running') {
      this.dispose();
      return Promise.resolve();
    }
    this.stopping = this.stopAndDrain().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }
  private async stopAndDrain(): Promise<void> {
    const generation = this.generation;
    const paused = this.audio?.pause();
    this.capture.release();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve(paused).then(async () => {
          if (generation !== this.generation) return;
          this.gate?.flush();
          if (this.hasPendingGeneration())
            await new Promise<void>((resolve) => {
              this.drain = resolve;
              this.maybeDrain();
            });
        }),
        new Promise<'timeout'>((resolve) => {
          deadline = setTimeout(() => resolve('timeout'), 5000);
        }),
      ]);
      if (generation !== this.generation) return;
      if (result === 'timeout')
        this.health(
          'degraded',
          `Gemini stopped with ${this.activities.length + (this.unassigned ? 1 : 0)} unfinished turns; captured tail may be incomplete`,
        );
      this.dispose();
    } catch {
      if (generation === this.generation) this.fail('Gemini stop failed; unfinished audio gap');
    } finally {
      clearTimeout(deadline);
    }
  }
  dispose(): void {
    this.concurrentRenewalAllowed = false;
    this.prepared = false;
    this.activated = false;
    this.preparedStream = null;
    this.pendingAudioHealth = null;
    this.preparation = null;
    ++this.generation;
    this.controller.abort();
    this.audio?.dispose();
    this.audio = null;
    this.capture.release();
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
    }
    this.socket = null;
    this.inputQueue = [];
    this.awaitingGeneration = false;
    this.gate = null;
    this.active = null;
    this.renewAt = null;
    this.starting = false;
    clearTimeout(this.drainQuiet);
    this.drain?.();
    this.drain = null;
    this.setStatus('stopped');
  }
  private sendInput(value: { realtimeInput: Record<string, unknown> }): void {
    // Real Live Transcribe can drop a new manual activity started while the
    // previous generation is finalizing. Keep capture running and serialize
    // the wire activities; never silently discard queued audio on overflow.
    if (this.awaitingGeneration) {
      if (this.inputQueue.length >= 256)
        throw new Error('Gemini pending audio limit; unfinished audio gap');
      this.inputQueue.push(value);
      return;
    }
    this.send(value);
    if (value.realtimeInput.activityEnd) this.awaitingGeneration = true;
  }
  private send(value: object): void {
    if (!this.socket || this.socket.readyState !== 1 || this.socket.bufferedAmount > 1000000)
      throw new Error('Gemini backpressure; audio gap');
    this.socket.send(JSON.stringify(value));
  }
  private fail(message: string, recoveryFailure?: RecoveryFailure): void {
    this.health('failed', message, recoveryFailure);
    this.dispose();
  }
  private health(state: HealthState, message?: string, recoveryFailure?: RecoveryFailure): void {
    this.options.handlers.onHealth({
      kind: 'health',
      component: 'transport',
      state,
      timestamp: new Date().toISOString(),
      ...(message ? { message } : {}),
      ...(recoveryFailure ? { recoveryFailure } : {}),
    });
  }
  private setStatus(state: ProviderStatus): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
