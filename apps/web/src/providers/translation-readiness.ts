import type { HealthEvent } from '@meeting-audio/contracts';

/** Content readiness for one provider owner; connection attempts and timers stay in the provider. */
export function translationReadiness(waiting: boolean) {
  let connected: HealthEvent | null = null;
  let stalls = 0;
  let lastStall: HealthEvent['recoveryFailure'];
  return {
    health(event: HealthEvent): HealthEvent {
      if (event.component !== 'transport') return event;
      const failure = event.recoveryFailure;
      if (
        failure?.layer === 'provider' &&
        failure.kind === 'stalled' &&
        failure.attemptId !== lastStall?.attemptId
      ) {
        stalls = Math.min(2, stalls + 1);
        lastStall = failure;
      }
      if (['failed', 'api_error', 'degraded', 'reconnecting'].includes(event.state)) waiting = true;
      connected = event.state === 'connected' ? event : null;
      // Give the existing same-provider recovery one chance. Only a second
      // watchdog observation, not the handshake, proves content is still stuck.
      if (waiting && connected && stalls >= 2)
        return {
          ...event,
          state: 'failed',
          message: '重新連線後仍持續收音但沒有字幕，將嘗試可用的備援服務。',
          recoveryFailure: lastStall,
        };
      return waiting && connected
        ? { ...event, state: 'reconnecting', message: '連線已建立，等待新的字幕內容。' }
        : event;
    },
    content(text: string): HealthEvent | null {
      if (!waiting || !connected || !text.trim()) return null;
      waiting = false;
      stalls = 0;
      lastStall = undefined;
      return { ...connected, timestamp: new Date().toISOString() };
    },
  };
}
