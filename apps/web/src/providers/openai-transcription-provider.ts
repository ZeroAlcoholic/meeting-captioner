import type {
  AudioSourceKind,
  HealthState,
  RecoveryFailure,
  HealthEvent,
} from '@meeting-audio/contracts';
import type { AudioSource, CaptionProviderHandlers, ProviderStatus } from './types.js';
import type { MicDistance } from './microphone-audio-provider.js';
import { leaseCapture } from './capture-lease.js';
import { resampleTo24kHz } from './openai-ws-transport.js';
import { arrayBufferToBase64, floatTo16BitPCM } from './gemini-live-provider.js';
import {
  createTranscriptionAudio,
  TranscriptionSpeechGate,
  type TranscriptionAudio,
  type TranscriptionAudioFactory,
  type TranscriptionGatePolicy,
} from './transcription-audio.js';
import { TranscriptionTurns } from './transcription-turns.js';
import { loadTranscriptNormalizer } from './transcript-normalization.js';
import {
  createRecoveryAttempt,
  assertRecoveryAllowed,
  recoveryHttpError,
  RecoveryError,
  normalizeRecoveryError,
  recoveryError,
  protocolRecoveryKind,
} from './recovery-attempt.js';

export interface OpenAITranscriptionOptions {
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
    socket?: (url: string, protocols: string[]) => WebSocket;
    audio?: TranscriptionAudioFactory;
  };
}

type KeySlot = 'primary' | 'audio';
type RetryKind = 'opaque' | 'auth';
interface RetrySelection {
  retryKeySlot: KeySlot;
  failedSlot: KeySlot;
  failureKind: RetryKind;
}
interface MintedSession {
  concurrent_renewal_allowed?: boolean;
  client_secret?: { value?: string; expires_at?: number };
  model?: string;
  key_slot?: KeySlot;
  alternate_key_slot?: KeySlot;
  session_renewal_recommended_ms?: number;
}
class HandshakeFailure extends Error {
  constructor(
    message: string,
    readonly retryKind?: RetryKind,
    readonly failureKind: RecoveryFailure['kind'] = 'network',
  ) {
    super(message);
  }
}
const keySlot = (value: unknown): value is KeySlot => value === 'primary' || value === 'audio';

/** Dedicated transcription transport; never creates translation or model audio. */
export class OpenAITranscriptionProvider {
  readonly name = 'openai-transcription';
  private currentStatus: ProviderStatus = 'idle';
  private listeners = new Set<(status: ProviderStatus) => void>();
  private readonly capture: AudioSource;
  private abort = new AbortController();
  private socket: WebSocket | null = null;
  private audio: TranscriptionAudio | null = null;
  private gate: TranscriptionSpeechGate | null = null;
  private turns: TranscriptionTurns | null = null;
  private generation = 0;
  private starting = false;
  private preparation: Promise<void> | null = null;
  private prepared = false;
  private concurrentRenewalAllowed = false;
  private activated = false;
  private preparedStream: MediaStream | null = null;
  private pendingAudioHealth: HealthEvent | null = null;
  private stopping: Promise<void> | null = null;
  private drain: (() => void) | null = null;
  private renewAt: number | null = null;
  private lastVoice = 0;
  private silence = false;
  private lastMeter = -Infinity;
  constructor(private readonly options: OpenAITranscriptionOptions) {
    this.capture =
      options.audioSource ??
      leaseCapture({ kind: 'mic', micDistance: options.micDistance ?? 'meeting' });
  }
  get status(): ProviderStatus {
    return this.currentStatus;
  }
  onStatus(fn: (status: ProviderStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  getRenewalEtaMs(): number | null {
    return this.renewAt === null ? null : Math.max(0, this.renewAt - Date.now());
  }
  allowsConcurrentRenewal(): boolean {
    return this.concurrentRenewalAllowed;
  }

  async start(): Promise<void> {
    if (this.currentStatus === 'running') return;
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
          throw new Error('Transcription preparation cancelled or failed');
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
      throw new Error('Transcription candidate is no longer ready');
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
      !this.abort.signal.aborted &&
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
    if (this.starting || this.currentStatus === 'running') return;
    if (this.stopping) await this.stopping;
    this.starting = true;
    this.lastVoice = 0;
    this.silence = false;
    this.lastMeter = -Infinity;
    const generation = ++this.generation;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const current = () => generation === this.generation && !signal.aborted;
    this.health('connecting');
    // Runs alongside the capture permission, the mint and the VAD model; awaited
    // before captions start so none is ever published unconverted.
    const normalizer = loadTranscriptNormalizer();
    normalizer.catch(() => {});
    let phase: 'audio' | 'network' = 'audio';
    try {
      assertRecoveryAllowed('openai', 'transcription');
      const stream = await this.capture.acquire((event) => {
        if (!current()) return;
        this.audioHealth(event);
        if (event.state === 'failed' || event.state === 'no_audio_track') this.dispose();
      });
      if (!current()) {
        // A stale acquire can resolve after the same provider has restarted.
        // That lease is now wanted by its new generation, so only release when
        // no active/new acquisition is retaining this owner's capture.
        if (!this.starting && this.status !== 'running') this.capture.release();
        return;
      }
      if (
        !stream.getAudioTracks().length ||
        stream.getAudioTracks().some((t) => t.readyState === 'ended')
      )
        throw new Error('No live audio track');
      // One budget covers both mint/handshake probes. User capture permission
      // and local model initialization are separate phases.
      phase = 'network';
      const setupDeadline = performance.now() + 30_000;
      let retrySelection: RetrySelection | undefined;
      for (let probe = 0; probe < 2; probe++) {
        const remaining = () => {
          const ms = Math.min(15_000, setupDeadline - performance.now());
          if (ms <= 0) throw new Error('Transcription connection setup timed out');
          return ms;
        };
        const mint = createRecoveryAttempt({
          parentSignal: signal,
          generation,
          isCurrent: () => current(),
          timeoutMs: remaining(),
          label: 'Transcription credential request',
        });
        let minted: MintedSession;
        try {
          minted = await mint.run(async (mintSignal) => {
            try {
              const response = await (this.options.dependencies?.fetch ?? fetch)(
                this.options.sessionUrl,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  signal: mintSignal,
                  body: JSON.stringify({
                    inputLanguages: this.options.task?.inputLanguages ?? ['zh-tw', 'en'],
                    micDistance: this.options.micDistance ?? 'meeting',
                    ...retrySelection,
                  }),
                },
              );
              mintSignal.throwIfAborted();
              if (!current()) throw new DOMException('Superseded', 'AbortError');
              if (!response.ok) throw recoveryHttpError(response, 'openai', 'transcription');
              // Neither malformed JSON nor rejected fetch errors may echo credentials.
              try {
                return await response.json();
              } catch {
                throw new Error('Invalid transcription credential response');
              }
            } catch (error) {
              if (error instanceof RecoveryError || mintSignal.aborted || !current()) throw error;
              if (
                error instanceof Error &&
                /^Transcription session unavailable \(\d{3}\)$/.test(error.message)
              )
                throw error;
              throw new Error('Transcription credential request failed');
            }
          });
        } finally {
          mint.dispose();
        }
        if (!current()) return;
        if (minted?.model && minted.model !== 'gpt-live-transcribe')
          throw recoveryError(
            'unsupported',
            'openai',
            'transcription',
            'Unsupported transcription model',
          );
        if (
          !minted ||
          minted.model !== 'gpt-live-transcribe' ||
          !minted.client_secret?.value ||
          !minted.client_secret.expires_at ||
          minted.client_secret.expires_at * 1000 <= Date.now()
        )
          throw new Error('Invalid transcription session credential');
        this.renewAt = Date.now() + (minted.session_renewal_recommended_ms ?? 50 * 60_000);
        this.concurrentRenewalAllowed = minted.concurrent_renewal_allowed === true;
        let socket: WebSocket;
        try {
          socket = (
            this.options.dependencies?.socket ?? ((url, protocols) => new WebSocket(url, protocols))
          )('wss://api.openai.com/v1/realtime?intent=transcription', [
            'realtime',
            'openai-insecure-api-key.' + minted.client_secret.value,
          ]);
        } catch {
          throw new Error('Transcription WebSocket could not be created');
        }
        this.socket = socket;
        this.turns = new TranscriptionTurns(
          crypto.randomUUID(),
          this.options.source ?? 'microphone',
          (event) => {
            if (current() && this.activated) this.options.handlers.onTranscript(event);
          },
        );
        let attemptActive = true;
        try {
          await new Promise<void>((resolve, reject) => {
            let ready = false;
            let settled = false;
            const timeout = setTimeout(
              () => finish(new Error('Transcription readiness timed out')),
              remaining(),
            );
            const cancelled = () => finish(new Error('Transcription setup cancelled'));
            const finish = (error?: Error) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              signal.removeEventListener('abort', cancelled);
              if (error) {
                attemptActive = false;
                reject(error);
              } else resolve();
            };
            signal.addEventListener('abort', cancelled, { once: true });
            socket.onmessage = (message) => {
              if (!current() || !attemptActive) return;
              try {
                const event = JSON.parse(String(message.data));
                if (!event || typeof event.type !== 'string')
                  throw new Error('Malformed transcription event');
                if (event.type === 'error') {
                  const failureKind = protocolRecoveryKind(event.error);
                  const code = event.error?.code;
                  const status = event.error?.status ?? event.error?.status_code;
                  const limited =
                    status === 429 ||
                    code === 'rate_limit_exceeded' ||
                    code === 'insufficient_quota';
                  const auth =
                    !limited &&
                    (status === 401 ||
                      status === 403 ||
                      code === 'ip_not_authorized' ||
                      code === 'invalid_api_key');
                  throw new HandshakeFailure(
                    limited
                      ? 'Transcription service rate limited the session (429)'
                      : 'Transcription API session failed; unfinished audio may remain',
                    auth ? 'auth' : undefined,
                    failureKind,
                  );
                }
                if (event.type === 'session.closed')
                  throw new Error('Transcription API session closed; unfinished audio may remain');
                if (
                  event.type === 'session.created' ||
                  event.type === 'transcription_session.created'
                ) {
                  const input = event.session?.audio?.input;
                  if (
                    event.session?.type !== 'transcription' ||
                    input?.transcription?.model !== 'gpt-live-transcribe' ||
                    input?.turn_detection !== null
                  )
                    throw recoveryError(
                      'unsupported',
                      'openai',
                      'transcription',
                      'Unsupported transcription session configuration',
                    );
                  ready = true;
                  finish();
                  return;
                }
                if (!ready) throw new Error('Transcription event arrived before readiness');
                if (!this.activated) return;
                this.turns?.receive(event);
                if (this.turns?.pending === 0) this.drain?.();
              } catch (error) {
                const safe =
                  error instanceof Error && !(error instanceof SyntaxError)
                    ? error
                    : new Error('Malformed transcription event');
                if (!ready) finish(safe);
                else {
                  const failure =
                    safe instanceof HandshakeFailure
                      ? recoveryError(
                          safe.failureKind,
                          'openai',
                          'transcription',
                          safe.message,
                          safe.failureKind === 'rate-limit'
                            ? performance.now() + 15_000
                            : undefined,
                        )
                      : normalizeRecoveryError(safe, 'openai', 'transcription');
                  this.fail(failure.message, failure.failure);
                }
              }
            };
            socket.onclose = (event) => {
              if (!current() || !attemptActive) return;
              if (!ready)
                finish(
                  new HandshakeFailure(
                    'Transcription connection closed before readiness',
                    event?.code === 1006 ? 'opaque' : undefined,
                  ),
                );
              else this.fail('Transcription connection closed; unfinished audio gap');
            };
            socket.onerror = () => {};
          });
          break;
        } catch (error) {
          attemptActive = false;
          socket.onmessage = null;
          socket.onclose = null;
          socket.onerror = null;
          socket.close();
          if (this.socket === socket) this.socket = null;
          if (!current()) return;
          if (
            probe !== 0 ||
            !(error instanceof HandshakeFailure) ||
            !error.retryKind ||
            !keySlot(minted.key_slot) ||
            !keySlot(minted.alternate_key_slot) ||
            minted.key_slot === minted.alternate_key_slot
          )
            throw error;
          retrySelection = {
            retryKeySlot: minted.alternate_key_slot,
            failedSlot: minted.key_slot,
            failureKind: error.retryKind,
          };
          this.health(
            'connecting',
            error.retryKind === 'opaque'
              ? 'Connection failed without a visible HTTP status; trying the configured alternate once'
              : 'Authentication rejected the session; trying the configured alternate once',
          );
        }
      }
      if (!current()) return;
      // Before any audio can be sent: the first transcript may come back at
      // once, and normalizing it without the dictionary would fail the session.
      phase = 'audio';
      await normalizer;
      if (!current()) return;
      const resample = { pos: 0, last: 0 };
      let appendedSamples = 0;
      this.gate = new TranscriptionSpeechGate(
        (frame, startMs, continuation, range) => {
          const pcm = resampleTo24kHz(frame, 16000, resample);
          this.send({
            type: 'input_audio_buffer.append',
            audio: arrayBufferToBase64(floatTo16BitPCM(pcm)),
          });
          this.turns!.acceptAudio(startMs, startMs + frame.length / 16, continuation, range);
          appendedSamples += pcm.length;
        },
        (start, end, continuation) => {
          // Realtime commit requires >=100 ms. Preserve very short initial speech
          // by padding only the wire payload, never extending captured timecodes.
          if (appendedSamples < 2400)
            this.send({
              type: 'input_audio_buffer.append',
              audio: arrayBufferToBase64(new Int16Array(2400 - appendedSamples).buffer),
            });
          this.turns!.submit(start, end, continuation);
          this.send({ type: 'input_audio_buffer.commit' });
          appendedSamples = 0;
        },
        this.options.gatePolicy,
      );
      const audioOperation = (this.options.dependencies?.audio ?? createTranscriptionAudio)(
        stream,
        {
          onHealth: (event) => {
            if (current()) this.audioHealth(event);
          },
          onFrame: (frame, probability, startMs, range) => {
            if (!current() || !this.activated) return;
            try {
              if (startMs - this.lastMeter >= 128) {
                this.lastMeter = startMs;
                let sum = 0;
                let peak = 0;
                for (const value of frame) {
                  sum += value * value;
                  peak = Math.max(peak, Math.abs(value));
                }
                this.options.handlers.onAudioLevel({
                  kind: 'audio_level',
                  source: this.options.source ?? 'microphone',
                  rmsDb: 20 * Math.log10(Math.max(1e-10, Math.sqrt(sum / frame.length))),
                  peakDb: 20 * Math.log10(Math.max(1e-10, peak)),
                  timestamp: new Date().toISOString(),
                });
              }
              this.gate?.push(frame, probability, startMs, range);
              if (!this.lastVoice) this.lastVoice = startMs;
              if (probability >= 0.5) {
                this.lastVoice = startMs;
                if (this.silence) {
                  this.silence = false;
                  this.health('connected');
                }
              } else if (!this.silence && startMs - this.lastVoice > 30_000) {
                this.silence = true;
                this.health('silence_detected');
              }
            } catch {
              this.fail('Transcription audio delivery failed; audio gap / unfinished turn');
            }
          },
          onError: () => {
            if (current()) this.fail('Transcription VAD processing failed; audio gap');
          },
        },
        signal,
        this.capture.captureRangeForNativeFrames?.bind(this.capture),
      ).then((audio) => {
        if (!current()) audio.dispose();
        return audio;
      });
      let audioTimer: ReturnType<typeof setTimeout> | undefined;
      let abortAudio: (() => void) | undefined;
      const audioDeadline = new Promise<never>((_resolve, reject) => {
        audioTimer = setTimeout(
          () => reject(new Error('Transcription local model setup timed out')),
          15_000,
        );
        abortAudio = () => reject(new Error('Transcription audio setup cancelled'));
        signal.addEventListener('abort', abortAudio, { once: true });
      });
      let audio: TranscriptionAudio;
      try {
        audio = await Promise.race([audioOperation, audioDeadline]);
      } finally {
        clearTimeout(audioTimer);
        if (abortAudio) signal.removeEventListener('abort', abortAudio);
      }
      if (!current()) {
        audio.dispose();
        return;
      }
      this.audio = audio;
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
        const failure =
          error instanceof HandshakeFailure
            ? recoveryError(
                error.failureKind,
                'openai',
                'transcription',
                error.message,
                error.failureKind === 'rate-limit' ? performance.now() + 15_000 : undefined,
              )
            : normalizeRecoveryError(error, 'openai', 'transcription');
        this.fail(failure.message, failure.failure);
      }
    } finally {
      if (generation === this.generation) this.starting = false;
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.currentStatus !== 'running') {
      this.dispose();
      return Promise.resolve();
    }
    this.stopping = this.drainStop().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }
  private async drainStop(): Promise<void> {
    const generation = this.generation;
    const paused = this.audio?.pause();
    this.capture.release();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'timeout'>((resolve) => {
      deadline = setTimeout(() => resolve('timeout'), 5000);
    });
    try {
      const outcome = await Promise.race([
        Promise.resolve(paused).then(async () => {
          if (generation !== this.generation) return;
          this.gate?.flush();
          if (this.turns?.pending)
            await new Promise<void>((resolve) => {
              this.drain = resolve;
            });
        }),
        expired,
      ]);
      if (generation !== this.generation) return;
      if (outcome === 'timeout')
        this.health(
          'degraded',
          `Transcription stopped with ${this.turns?.pending ?? 0} unfinished turns; captured tail may be incomplete`,
        );
      this.dispose();
    } catch {
      if (generation === this.generation)
        this.fail('Transcription stop failed; unfinished audio gap');
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }
  /** Immediate stale-owner teardown: late events never enter a newer meeting. */
  dispose(): void {
    this.concurrentRenewalAllowed = false;
    this.prepared = false;
    this.activated = false;
    this.preparedStream = null;
    this.pendingAudioHealth = null;
    this.preparation = null;
    ++this.generation;
    this.abort.abort();
    this.audio?.dispose();
    this.audio = null;
    this.capture.release();
    if (this.socket) {
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.close();
    }
    this.socket = null;
    this.gate = null;
    this.renewAt = null;
    this.starting = false;
    this.drain?.();
    this.drain = null;
    this.setStatus('stopped');
  }
  private send(event: object): void {
    if (!this.socket || this.socket.readyState !== 1 || this.socket.bufferedAmount > 1_000_000)
      throw new Error('Transcription backpressure; audio gap');
    this.socket.send(JSON.stringify(event));
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
  private setStatus(status: ProviderStatus): void {
    this.currentStatus = status;
    for (const listener of this.listeners) listener(status);
  }
}
