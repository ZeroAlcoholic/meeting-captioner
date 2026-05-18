import { useCallback, useEffect, useRef, useState } from 'react';
import { ONLINE_SERVICE_URL } from '../config.js';
import { settingsStore } from '../settings/use-settings-store.js';
import { OpenAIRealtimeProvider } from './openai-realtime-provider.js';
import { MicrophoneAudioProvider } from './microphone-audio-provider.js';
import { createStoreBoundHandlers } from './coalesce-handlers.js';
import type { ProviderStatus } from './types.js';

const SESSION_URL = `${ONLINE_SERVICE_URL}/session`;
const SESSION_INFO_URL = `${ONLINE_SERVICE_URL}/session/info`;

// Polling backoff: tight when something is wrong, relaxed once stable.
const POLL_FAST_MS = 3_000;
const POLL_SLOW_MS = 10_000;

export type ApiKeyStatus = 'checking' | 'present' | 'no-key' | 'service-down';

export interface UseOpenAIRealtime {
  status: ProviderStatus;
  error: string | null;
  apiKeyStatus: ApiKeyStatus;
  /**
   * Resolves to `true` if the realtime provider reached the `running`
   * state, `false` if startup failed (mic denied, /session 5xx, SDP
   * exchange failed, etc.). Callers use this to gate side effects like
   * the session-cost timer that must not run for failed sessions.
   */
  start: () => Promise<boolean>;
  stop: () => void;
  retry: () => void;
  /**
   * Read the renewal ETA on demand. Returns null when no session is running.
   * Pulled from a ref so consumers can poll without forcing the hook owner to
   * re-render at 1 Hz — the previous design caused unnecessary App.tsx
   * re-renders that cascaded through the caption board's shell.
   */
  getRenewalEtaMs: () => number | null;
}

export function useOpenAIRealtime(): UseOpenAIRealtime {
  const providerRef = useRef<OpenAIRealtimeProvider | null>(null);
  const handlersRef = useRef<ReturnType<typeof createStoreBoundHandlers> | null>(null);
  const [status, setStatus] = useState<ProviderStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus>('checking');

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
          schedule(POLL_SLOW_MS);
        })
        .catch(() => {
          if (cancelled) return;
          setApiKeyStatus('service-down');
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

  const start = useCallback(async (): Promise<boolean> => {
    setError(null);
    // If a previous provider instance exists, stop it cleanly first.
    // Without this, a fast double-click on Start (or a renewal racing a
    // manual restart) would orphan the prior provider with its timers,
    // mic stream, and WebRTC pc still alive — a real memory + audio leak.
    //
    // Critically: we must call stop() even when previous.status is already
    // 'stopped', because the persistent renewal-retry path leaves the
    // instance in the stopped state with a pending renewalRetryTimer.
    // Without this cleanup the old timer fires later and spins up a
    // parallel session under the user's new manual session.
    const previous = providerRef.current;
    if (previous) {
      previous.stop();
      handlersRef.current?.flushPending();
    }

    const { langPair, includeSourceTranscript, micDistance } = settingsStore.getState();
    const handlers = createStoreBoundHandlers();
    handlersRef.current = handlers;
    // MicrophoneAudioProvider must be created with the same micDistance
    // value so its getUserMedia AGC matches the noise_reduction profile
    // we'll send to OpenAI — otherwise the two halves of the audio path
    // fight each other (see MicrophoneAudioProvider docstring).
    const mic = new MicrophoneAudioProvider(micDistance);
    const provider = new OpenAIRealtimeProvider(
      SESSION_URL,
      handlers,
      langPair,
      mic,
      includeSourceTranscript,
      micDistance,
    );
    providerRef.current = provider;
    setStatus('running');

    try {
      await provider.start();
      // If a newer start() raced and replaced providerRef while we were
      // awaiting, leave the newer one's state alone.
      if (providerRef.current !== provider) return false;
      if (provider.status === 'stopped') {
        // Internal error path (mic denied, /session non-2xx, SDP exchange
        // failed). The provider already cleaned up; surface as not-running
        // so callers don't start the cost timer.
        setStatus('idle');
        return false;
      }
      return true;
    } catch (err) {
      if (providerRef.current !== provider) return false;
      setError(err instanceof Error ? err.message : String(err));
      setStatus('idle');
      return false;
    }
  }, []);

  const stop = useCallback(() => {
    providerRef.current?.stop();
    handlersRef.current?.flushPending();
    setStatus('stopped');
  }, []);

  const retry = useCallback(() => {
    void start();
  }, [start]);

  // Stable getter — consumers can read it inside their own intervals without
  // bumping renders here. Returns null when no provider or not running.
  const getRenewalEtaMs = useCallback((): number | null => {
    return providerRef.current?.getRenewalEtaMs() ?? null;
  }, []);

  return { status, error, apiKeyStatus, start, stop, retry, getRenewalEtaMs };
}
