import type { HealthEvent } from '@meeting-audio/contracts';
import type { CaptionProviderHandlers, ProviderStatus } from './types.js';
import { MeetingRecovery, type RecoverySnapshot } from './meeting-recovery.js';
import type { OnlineBackend } from './failover.js';
import {
  recoveryFailureFor,
  permanentRecoveryFailure,
  clearRecoveryRefusal,
} from './recovery-attempt.js';

export interface SessionProvider {
  status: ProviderStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  dispose(): void;
  getRenewalEtaMs(): number | null;
  allowsConcurrentRenewal?(): boolean;
  prepare?(): Promise<void>;
  isPrepared?(): boolean;
  activate?(): void;
}
export interface TranscriptionSessionSnapshot {
  phase: 'idle' | 'starting' | 'running' | 'recovering' | 'failed' | 'stopping' | 'stopped';
  error: string | null;
  backend: OnlineBackend | null;
}
/** Owns pure-transcription providers; the existing scheduler chooses recovery targets. */
export class TranscriptionSession {
  private provider: SessionProvider | null = null;
  private candidate: SessionProvider | null = null;
  private retiring: SessionProvider | null = null;
  private readonly recovery = new MeetingRecovery();
  private generation = 0;
  private requested = false;
  private sourceBlocked = false;
  private awaitingContent = false;
  private snapshot: TranscriptionSessionSnapshot = { phase: 'idle', error: null, backend: null };
  private listeners = new Set<() => void>();
  private stopping: Promise<void> | null = null;
  private renewal: ReturnType<typeof setTimeout> | null = null;
  private clearRenewal() {
    if (this.renewal !== null) clearTimeout(this.renewal);
    this.renewal = null;
  }
  private armRenewal(provider: SessionProvider, generation: number, retryMs?: number) {
    this.clearRenewal();
    const failure = recoveryFailureFor(this.currentBackend(), 'transcription');
    if (permanentRecoveryFailure(failure)) return;
    const eta = retryMs ?? provider.getRenewalEtaMs();
    if (eta === null) return;
    this.renewal = setTimeout(
      () => {
        if (!this.requested || generation !== this.generation || this.provider !== provider) return;
        if (provider.allowsConcurrentRenewal?.() === true) {
          void this.renewWithCandidate(provider, generation);
          return;
        }
        this.update({ phase: 'recovering' });
        this.handlers.onHealth({
          kind: 'health',
          component: 'transport',
          state: 'reconnecting',
          message: '轉寫連線定期更新；更新期間將標記為待確認缺口',
          timestamp: new Date().toISOString(),
        });
        void (async () => {
          try {
            await provider.stop();
          } catch {
            /* reconnect records the interruption */
          }
          if (this.requested && generation === this.generation) await this.connect();
        })().catch(() => {
          if (this.requested && generation === this.generation) {
            this.update({ phase: 'recovering', error: '定期更新連線失敗' });
            this.schedule();
          }
        });
      },
      Math.min(
        2_147_483_647,
        Math.max(1000, eta, (failure?.retryNotBeforeMs ?? 0) - performance.now()),
      ),
    );
  }

  private currentBackend(): OnlineBackend {
    return this.snapshot.backend ?? this.backend();
  }
  private createProvider(generation: number, backend = this.currentBackend()): SessionProvider {
    const current = () => generation === this.generation;
    const provider = this.factory(
      {
        onTranscript: (event) => {
          if (
            (current() && this.provider === provider) ||
            (this.retiring === provider && event.status === 'final')
          ) {
            this.handlers.onTranscript(event);
            if (
              this.awaitingContent &&
              this.requested &&
              current() &&
              this.provider === provider &&
              event.text.trim()
            ) {
              this.awaitingContent = false;
              this.update({ phase: 'running', error: null });
              this.schedule();
            }
          }
        },
        onTranslation: () => {},
        onAudioLevel: (event) => {
          if (current() && this.provider === provider) this.handlers.onAudioLevel(event);
        },
        onHealth: (event) => {
          if (current() && this.provider === provider) {
            this.handlers.onHealth(event);
            this.onHealth(event);
          }
        },
      },
      backend,
    );
    return provider;
  }

  private async renewWithCandidate(incumbent: SessionProvider, generation: number): Promise<void> {
    if (this.candidate || this.retiring) {
      this.armRenewal(incumbent, generation, 15_000);
      return;
    }
    const current = () =>
      this.requested && generation === this.generation && this.provider === incumbent;
    const candidate = this.createProvider(generation);
    this.candidate = candidate;
    try {
      if (!candidate.prepare || !candidate.activate || !candidate.isPrepared)
        throw new Error('This provider cannot prepare a renewal candidate');
      await candidate.prepare();
      if (!current() || this.candidate !== candidate) return;
      // No await between readiness check, old PCM shutdown and new activation.
      if (!candidate.isPrepared()) throw new Error('Renewal candidate lost readiness');
      this.retiring = incumbent;
      this.provider = candidate;
      this.candidate = null;
      const drained = incumbent.stop();
      void drained
        .catch(() => {})
        .finally(() => {
          incumbent.dispose();
          if (this.retiring === incumbent) this.retiring = null;
        });
      this.handlers.onHealth({
        kind: 'health',
        component: 'transport',
        state: 'reconnecting',
        message: '轉寫續期切換送音；切換期間音訊完整性待確認，尚未補送。',
        timestamp: new Date().toISOString(),
      });
      if (!this.requested || generation !== this.generation || this.provider !== candidate) return;
      candidate.activate();
      if (!this.requested || generation !== this.generation || this.provider !== candidate) return;
      this.update({ phase: this.awaitingContent ? 'recovering' : 'running', error: null });
      this.schedule();
      this.armRenewal(candidate, generation);
    } catch {
      if (this.candidate !== candidate) candidate.dispose();
      if (current()) {
        // Candidate failure is not an outage of the healthy incumbent.
        this.armRenewal(incumbent, generation, 15_000);
      } else if (this.requested && generation === this.generation && this.provider === candidate) {
        this.awaitingContent = false;
        this.update({ phase: 'recovering', error: '續期接管失敗，將依可用服務重試。' });
        this.schedule();
      }
    } finally {
      if (this.candidate === candidate) {
        this.candidate = null;
        candidate.dispose();
      }
    }
  }
  constructor(
    private readonly factory: (
      handlers: CaptionProviderHandlers,
      backend: OnlineBackend,
    ) => SessionProvider,
    private readonly handlers: CaptionProviderHandlers,
    private readonly backend: () => 'openai' | 'gemini' = () => 'openai',
    private readonly available: () => Record<OnlineBackend, boolean> = () => ({
      openai: this.backend() === 'openai',
      gemini: this.backend() === 'gemini',
    }),
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private update(patch: Partial<TranscriptionSessionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((f) => f());
  }
  private recoverySnapshot = (): RecoverySnapshot => ({
    online: true,
    sessionRunning: this.requested,
    sourceBlocked: this.sourceBlocked,
    selectedBackend: this.currentBackend(),
    runningBackend: null,
    anyProviderRunning:
      this.awaitingContent ||
      this.snapshot.phase === 'starting' ||
      this.snapshot.phase === 'running',
    transportState: this.snapshot.phase === 'running' ? 'connected' : 'failed',
    available: this.available(),
    failures: {
      openai: recoveryFailureFor('openai', 'transcription'),
      gemini: recoveryFailureFor('gemini', 'transcription'),
    },
  });
  private schedule() {
    this.recovery.update(this.recoverySnapshot(), this.recoverySnapshot, (action) => {
      void this.connect(action.target);
    });
  }
  /** Reconsider newly configured services without restarting a healthy session. */
  refreshAvailability(): void {
    this.schedule();
  }
  async start(manual = true): Promise<void> {
    if (this.stopping) await this.stopping;
    if (manual) clearRecoveryRefusal(this.backend(), 'transcription');
    this.requested = true;
    this.sourceBlocked = false;
    this.recovery.begin();
    await this.connect(manual ? this.backend() : this.currentBackend());
  }
  private async connect(target = this.currentBackend()): Promise<void> {
    if (!this.requested) return;
    const failure = recoveryFailureFor(target, 'transcription');
    if (permanentRecoveryFailure(failure) || (failure?.retryNotBeforeMs ?? 0) > performance.now()) {
      this.update({
        phase: permanentRecoveryFailure(failure) ? 'failed' : 'recovering',
        error: permanentRecoveryFailure(failure)
          ? '服務拒絕此連線，請修正設定後手動重試。'
          : '服務限流，等待冷卻期限後重試。',
      });
      this.schedule();
      return;
    }
    const generation = ++this.generation;
    this.clearRenewal();
    this.candidate?.dispose();
    this.candidate = null;
    this.provider?.dispose();
    this.awaitingContent =
      this.awaitingContent ||
      (target !== this.currentBackend() &&
        (this.snapshot.phase === 'recovering' || this.snapshot.phase === 'failed'));
    this.update({ phase: 'starting', error: null, backend: target });
    const current = () => generation === this.generation && this.provider === provider;
    const provider = this.createProvider(generation, target);
    this.provider = provider;
    try {
      await provider.start();
      if (!current() || !this.requested) return;
      if (provider.status === 'running') {
        this.update({ phase: this.awaitingContent ? 'recovering' : 'running', error: null });
        this.schedule();
        this.armRenewal(provider, generation);
      } else {
        this.awaitingContent = false;
        this.update({ phase: this.sourceBlocked ? 'failed' : 'recovering' });
        this.schedule();
      }
    } catch {
      if (current() && this.requested) {
        this.awaitingContent = false;
        this.update({
          phase: this.sourceBlocked ? 'failed' : 'recovering',
          error: this.snapshot.error ?? '字幕連線失敗，將依可用服務重試。',
        });
        this.schedule();
      }
    }
  }
  private onHealth(e: HealthEvent) {
    if (!this.requested) return;
    if (['failed', 'api_error', 'no_audio_track'].includes(e.state)) {
      this.awaitingContent = false;
      this.clearRenewal();
      this.sourceBlocked = e.component === 'audio';
      this.update({
        phase:
          this.sourceBlocked || permanentRecoveryFailure(e.recoveryFailure)
            ? 'failed'
            : 'recovering',
        error: e.message ?? '字幕服務暫時中斷',
      });
      ++this.generation;
      this.candidate?.dispose();
      this.candidate = null;
      this.provider?.dispose();
      this.schedule();
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.requested = false;
    this.awaitingContent = false;
    this.recovery.cancel();
    this.clearRenewal();
    this.candidate?.dispose();
    this.candidate = null;
    this.update({ phase: 'stopping' });
    const provider = this.provider;
    const retiring = this.retiring;
    this.stopping = (async () => {
      try {
        await Promise.all([provider?.stop(), retiring?.stop()]);
      } finally {
        ++this.generation;
        provider?.dispose();
        retiring?.dispose();
        this.retiring = null;
        this.provider = null;
        this.update({ phase: 'stopped' });
        this.stopping = null;
      }
    })();
    return this.stopping;
  }
  dispose() {
    this.requested = false;
    this.awaitingContent = false;
    ++this.generation;
    this.recovery.cancel();
    this.clearRenewal();
    this.candidate?.dispose();
    this.candidate = null;
    this.retiring?.dispose();
    this.retiring = null;
    this.provider?.dispose();
    this.provider = null;
    this.listeners.clear();
  }
}
