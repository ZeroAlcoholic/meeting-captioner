import { createRecoveryAttempt } from './recovery-attempt.js';
import { serviceFetch } from './service-fetch.js';

export interface SessionInfo {
  hasApiKey?: boolean;
  hasGeminiKey?: boolean;
  availableProviders?: string[];
  taskCapabilities?: Array<{ provider: string; purpose: string; configured: boolean }>;
}

/** Availability checks must recover even when fetch or its response body hangs. */
export function startSessionInfoPolling(
  url: string,
  onInfo: (info: SessionInfo) => void,
  onUnavailable: () => void,
): () => void {
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  const poll = async (): Promise<void> => {
    const attempt = createRecoveryAttempt({
      parentSignal: lifetime.signal,
      generation: ++generation,
      isCurrent: (id) => !lifetime.signal.aborted && id === generation,
      timeoutMs: 12_000,
      label: 'Session availability',
    });
    let delay = 10_000;
    try {
      const info = await attempt.run(async (signal) => {
        const response = await serviceFetch(url, { signal });
        if (!response.ok) throw new Error('Session availability request failed');
        return (await response.json()) as SessionInfo;
      });
      if (lifetime.signal.aborted) return;
      onInfo(info);
    } catch {
      if (lifetime.signal.aborted) return;
      onUnavailable();
      delay = 3_000;
    } finally {
      attempt.dispose();
    }
    if (!lifetime.signal.aborted) timer = setTimeout(() => void poll(), delay);
  };
  void poll();
  return () => {
    lifetime.abort();
    if (timer !== null) clearTimeout(timer);
  };
}
