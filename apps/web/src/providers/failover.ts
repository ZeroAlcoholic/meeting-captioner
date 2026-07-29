/**
 * Pure decision logic for the cross-model one-click failover affordance (#21).
 *
 * Kept out of App.tsx so the "when do we offer a switch, and in which
 * direction?" rules are unit-testable without a React renderer. App wires the
 * actual provider start/stop calls around this verdict.
 */

export type OnlineBackend = 'openai' | 'gemini';

export interface FailoverDecision {
  /** Whether to show the failover banner. */
  show: boolean;
  /** Human label of the failing backend (empty when not shown). */
  fromLabel: string;
  /** Human label of the backend to switch to (empty when not shown). */
  toLabel: string;
  /** The backend id to switch TO (null when not shown). */
  target: OnlineBackend | null;
}

const LABEL: Record<OnlineBackend, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
};

const HIDDEN: FailoverDecision = { show: false, fromLabel: '', toLabel: '', target: null };

export interface FailoverInputs {
  /** True when the app is in an online realtime mode (OpenAI/Gemini selectable). */
  isOnlineMode: boolean;
  /** Which online backend is actually running right now, or null. */
  runningBackend: OnlineBackend | null;
  /** True when the session is paused (the manual Resume/switch path owns that case). */
  paused: boolean;
  /** Latest transport health state. */
  transportState: string;
  /** Backends that can be started right now. Missing means unavailable. */
  availableBackends: Partial<Record<OnlineBackend, boolean>>;
}

/**
 * Offer failover only for a MID-MEETING degradation: an online backend is live
 * (so this isn't an initial-connect failure — the launcher handles those) and
 * its transport has reached 'failed' (self-heal retries surfaced it, while still
 * retrying underneath). Never while paused.
 */
export function computeFailover(input: FailoverInputs): FailoverDecision {
  if (!input.isOnlineMode) return HIDDEN;
  if (input.runningBackend === null) return HIDDEN;
  if (input.paused) return HIDDEN;
  if (input.transportState !== 'failed') return HIDDEN;
  const target: OnlineBackend = input.runningBackend === 'gemini' ? 'openai' : 'gemini';
  if (input.availableBackends[target] !== true) return HIDDEN;
  return {
    show: true,
    fromLabel: LABEL[input.runningBackend],
    toLabel: LABEL[target],
    target,
  };
}
