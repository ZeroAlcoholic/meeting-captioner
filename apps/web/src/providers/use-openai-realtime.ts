import { useCallback, useEffect, useRef, useState } from 'react';
import { ONLINE_SERVICE_URL } from '../config.js';
import { settingsStore } from '../settings/use-settings-store.js';
import { captionStore } from '../store/use-caption-store.js';
import { OpenAIRealtimeProvider } from './openai-realtime-provider.js';
import type { ProviderStatus } from './types.js';

const SESSION_URL = `${ONLINE_SERVICE_URL}/session`;
const SESSION_INFO_URL = `${ONLINE_SERVICE_URL}/session/info`;

// Polling backoff: tight when something is wrong, relaxed once stable.
const POLL_FAST_MS = 3_000;
const POLL_SLOW_MS = 10_000;
// How often UI redraws the renewal countdown (cheap, no network).
const RENEWAL_TICK_MS = 1_000;

export type ApiKeyStatus = 'checking' | 'present' | 'no-key' | 'service-down';

export function useOpenAIRealtime() {
  const providerRef = useRef<OpenAIRealtimeProvider | null>(null);
  const [status, setStatus] = useState<ProviderStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus>('checking');
  const [renewalEtaMs, setRenewalEtaMs] = useState<number | null>(null);

  // ── /session/info polling with backoff ───────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delay: number) => {
      timer = setTimeout(poll, delay);
    };

    const poll = (): void => {
      fetch(SESSION_INFO_URL)
        .then((r) => r.json())
        .then((d: { hasApiKey: boolean }) => {
          if (cancelled) return;
          setApiKeyStatus(d.hasApiKey ? 'present' : 'no-key');
          // Stable signal — back off polling rate.
          schedule(POLL_SLOW_MS);
        })
        .catch(() => {
          if (cancelled) return;
          setApiKeyStatus('service-down');
          // Service unreachable — keep polling tight to recover quickly.
          schedule(POLL_FAST_MS);
        });
    };

    poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      providerRef.current?.stop();
    };
  }, []);

  // ── Renewal ETA tick — only runs while a session is active ───────────────────
  useEffect(() => {
    if (status !== 'running') {
      setRenewalEtaMs(null);
      return undefined;
    }
    const tick = () => {
      const eta = providerRef.current?.getRenewalEtaMs() ?? null;
      setRenewalEtaMs(eta);
    };
    tick();
    const id = setInterval(tick, RENEWAL_TICK_MS);
    return () => clearInterval(id);
  }, [status]);

  const start = useCallback(async () => {
    setError(null);
    // Do NOT clear captionStore here — pause/resume must preserve scrollback.
    // Use the explicit Clear button in CaptionBoard to wipe.
    const { langPair } = settingsStore.getState();
    const provider = new OpenAIRealtimeProvider(
      SESSION_URL,
      {
        onTranscript: (e) => captionStore.getState().applyTranscript(e),
        onTranslation: (e) => captionStore.getState().applyTranslation(e),
        onHealth: (e) => settingsStore.getState().applyHealth(e),
        onAudioLevel: (e) => settingsStore.getState().applyAudioLevel(e),
      },
      langPair,
    );
    providerRef.current = provider;
    setStatus('running');

    try {
      await provider.start();
      // If provider stopped itself due to error (api_error, ICE failed), reflect that
      if (provider.status === 'stopped') {
        setStatus('idle');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('idle');
    }
  }, []);

  const stop = useCallback(() => {
    providerRef.current?.stop();
    setStatus('stopped');
  }, []);

  // F2 — manual retry binding for the UI when start() failed.
  const retry = useCallback(() => {
    void start();
  }, [start]);

  return { status, error, apiKeyStatus, renewalEtaMs, start, stop, retry };
}
