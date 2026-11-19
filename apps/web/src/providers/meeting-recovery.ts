import type { HealthState, RecoveryFailure } from '@meeting-audio/contracts';
import { permanentRecoveryFailure } from './recovery-attempt.js';
import type { OnlineBackend } from './failover.js';

/**
 * Delay before the standby is started, by attempt. The first waits one second: the
 * running backend has already reported a failed attempt, and 數字①
 * (docs/GOAL_PHASE_2.md) budgets 3 s for captions to return to the room — a
 * wait measured in tens of seconds spends that budget before anything happens.
 * Starting the standby no longer stops the failing backend, so there is nothing
 * left for a grace period to protect. Later attempts back off, so a standby
 * that also refuses is not hammered.
 */
const HANDOFF_DELAYS_MS = [1_000, 4_000, 8_000, 15_000];
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000];

export interface RecoverySnapshot {
  online: boolean;
  sessionRunning: boolean;
  sourceBlocked: boolean;
  /** A retryable local setup failure cannot be repaired by changing cloud vendors. */
  sourceRetryOnly?: boolean;
  selectedBackend: OnlineBackend;
  runningBackend: OnlineBackend | null;
  anyProviderRunning: boolean;
  transportState: HealthState;
  available: Record<OnlineBackend, boolean>;
  failures?: Partial<Record<OnlineBackend, RecoveryFailure | undefined>>;
}

export type RecoveryAction =
  | { kind: 'handoff'; from: OnlineBackend; target: OnlineBackend }
  | { kind: 'retry'; target: OnlineBackend };

interface ScheduledRecovery {
  action: RecoveryAction;
  dueAt: number;
}

/**
 * Owns meeting-level retry timing only. Providers own their connection attempts;
 * the application owns capture, meeting history and executing the chosen action.
 * A fresh snapshot at dispatch prevents a queued timer from interrupting a new
 * handshake or reopening capture after Stop/source-ended, before React renders.
 */
export class MeetingRecovery {
  private active = false;
  private epoch = 0;
  private retryAttempt = 0;
  private retryDueAt: number | null = null;
  private handoffAttempt = 0;
  private handoffDueAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scheduled: ScheduledRecovery | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  get generation(): number {
    return this.epoch;
  }

  isCurrent(generation: number): boolean {
    return this.active && generation === this.epoch;
  }

  begin(newMeeting = false): void {
    this.clearTimer();
    if (!this.active || newMeeting) {
      this.epoch += 1;
      this.resetProgress();
    }
    this.active = true;
  }

  cancel(): void {
    this.active = false;
    this.epoch += 1;
    this.clearTimer();
    this.resetProgress();
  }

  update(
    snapshot: RecoverySnapshot,
    readCurrent: () => RecoverySnapshot,
    execute: (action: RecoveryAction) => void,
  ): void {
    this.clearTimer();
    const scheduled = this.plan(snapshot);
    if (!scheduled) return;
    this.scheduled = scheduled;
    const generation = this.epoch;
    this.timer = setTimeout(
      () => {
        if (!this.isCurrent(generation) || this.scheduled !== scheduled) return;
        this.timer = null;
        this.scheduled = null;
        const current = readCurrent();
        const confirmed = this.plan(current);
        if (!confirmed) return;
        if (
          confirmed.action.kind !== scheduled.action.kind ||
          confirmed.action.target !== scheduled.action.target ||
          confirmed.dueAt > this.now()
        ) {
          this.update(current, readCurrent, execute);
          return;
        }
        if (confirmed.action.kind === 'retry') {
          this.retryAttempt += 1;
          this.retryDueAt = null;
        } else {
          this.handoffAttempt += 1;
          this.handoffDueAt = null;
        }
        execute(confirmed.action);
      },
      Math.min(2_147_483_647, Math.max(0, scheduled.dueAt - this.now())),
    );
  }

  private plan(snapshot: RecoverySnapshot): ScheduledRecovery | null {
    if (!this.active || !snapshot.online || !snapshot.sessionRunning || snapshot.sourceBlocked) {
      this.handoffDueAt = null;
      this.retryDueAt = null;
      return null;
    }
    if (snapshot.transportState === 'connected') this.resetProgress();
    const available = (backend: OnlineBackend) =>
      snapshot.available[backend] && !permanentRecoveryFailure(snapshot.failures?.[backend]);
    const notBefore = (backend: OnlineBackend) =>
      snapshot.failures?.[backend]?.retryNotBeforeMs ?? 0;
    if (snapshot.runningBackend !== null) {
      this.retryDueAt = null;
      if (snapshot.selectedBackend !== snapshot.runningBackend) return null;
      const target = otherBackend(snapshot.runningBackend);
      // 'reconnecting' is an attempt still in flight and is left to finish; only
      // a reported failure brings the standby up. The failing backend keeps its
      // own retries either way — whichever connects first keeps the meeting.
      if (snapshot.sourceRetryOnly || snapshot.transportState !== 'failed' || !available(target)) {
        this.handoffDueAt = null;
        return null;
      }
      this.handoffDueAt ??=
        this.now() +
        HANDOFF_DELAYS_MS[Math.min(this.handoffAttempt, HANDOFF_DELAYS_MS.length - 1)]!;
      return {
        action: { kind: 'handoff', from: snapshot.runningBackend, target },
        dueAt: Math.max(this.handoffDueAt, notBefore(target)),
      };
    }
    if (snapshot.anyProviderRunning) {
      this.retryDueAt = null;
      return null;
    }
    const alternate = otherBackend(snapshot.selectedBackend);
    const target =
      !snapshot.sourceRetryOnly &&
      available(alternate) &&
      (!available(snapshot.selectedBackend) ||
        notBefore(alternate) <= Math.max(this.now(), notBefore(snapshot.selectedBackend)))
        ? alternate
        : snapshot.selectedBackend;
    if (!available(target)) return null;
    const delays = target === snapshot.selectedBackend ? RETRY_DELAYS_MS : HANDOFF_DELAYS_MS;
    this.retryDueAt ??= this.now() + delays[Math.min(this.retryAttempt, delays.length - 1)]!;
    return {
      action: { kind: 'retry', target },
      dueAt: Math.max(this.retryDueAt, notBefore(target)),
    };
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.scheduled = null;
  }

  private resetProgress(): void {
    this.retryAttempt = 0;
    this.retryDueAt = null;
    this.handoffAttempt = 0;
    this.handoffDueAt = null;
  }
}

function otherBackend(backend: OnlineBackend): OnlineBackend {
  return backend === 'gemini' ? 'openai' : 'gemini';
}
