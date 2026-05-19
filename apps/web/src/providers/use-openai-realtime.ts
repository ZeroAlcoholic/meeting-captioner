import { useCallback, useEffect, useRef, useState } from 'react';
import { ONLINE_SERVICE_URL } from '../config.js';
import { settingsStore } from '../settings/use-settings-store.js';
import { OpenAIRealtimeProvider } from './openai-realtime-provider.js';
import { MicrophoneAudioProvider } from './microphone-audio-provider.js';
import { DisplayMediaAudioProvider } from './display-media-audio-provider.js';
import { createStoreBoundHandlers } from './coalesce-handlers.js';
import type { AudioSource, ProviderStatus } from './types.js';

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
  // Holds the current provider's onStatus unsubscribe so we can detach
  // before swapping providers (start-restart cycle) without leaking the
  // old subscription into the new provider's lifecycle.
  const statusUnsubRef = useRef<(() => void) | null>(null);
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
      statusUnsubRef.current?.();
      statusUnsubRef.current = null;
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
    // Drop the previous provider's status subscription before overwriting
    // its ref — otherwise the old instance's late callbacks (timer-driven
    // retry, in-flight cleanup) would still mutate React state and step on
    // the new provider's events.
    statusUnsubRef.current?.();
    statusUnsubRef.current = null;

    const { langPair, includeSourceTranscript, micDistance, audioSource } = settingsStore.getState();
    const handlers = createStoreBoundHandlers();
    handlersRef.current = handlers;
    // Branch on the user-chosen audio source. 'system' uses getDisplayMedia
    // for browser tab / system-audio capture (Teams/Zoom in another window);
    // 'mic' uses getUserMedia for an attached microphone. The OpenAI side of
    // the audio path doesn't care which one fed it — it just consumes the
    // MediaStream — so we keep the AudioSource interface symmetric.
    //
    // For system audio, micDistance is forced to 'off' so the upstream
    // noise_reduction profile doesn't fight pre-mixed clean signal. The
    // SettingsPanel mirrors this by greying out the mic-distance buttons
    // when audioSource === 'system', so the UI and the actual /session
    // payload stay in sync.
    let audio: AudioSource;
    let effectiveMicDistance: 'close' | 'far' | 'off';
    if (audioSource === 'system') {
      audio = new DisplayMediaAudioProvider();
      effectiveMicDistance = 'off';
    } else {
      audio = new MicrophoneAudioProvider(micDistance);
      effectiveMicDistance = micDistance;
    }
    const provider = new OpenAIRealtimeProvider(
      SESSION_URL,
      handlers,
      langPair,
      audio,
      includeSourceTranscript,
      effectiveMicDistance,
    );
    providerRef.current = provider;
    // Subscribe to internal status transitions — keeps React in sync when
    // the provider self-transitions during transparent renewal (running →
    // idle → running) or falls into retry backoff (running → stopped). The
    // optimistic setStatus('running') below stays so the button reflects
    // intent immediately; the subscription corrects later if start() failed
    // or a renewal mid-session changed state behind the consumer's back.
    statusUnsubRef.current = provider.onStatus((s) => {
      if (providerRef.current !== provider) return; // stale callback
      // Re-frame internal 'stopped' as 'idle' for the UI: the provider's
      // retry timer will spin a new start() up, so the consumer's "is the
      // button labelled running?" state matters more than the literal
      // internal transition. 'idle' makes the user see Start as available.
      setStatus(s === 'stopped' ? 'idle' : s);
    });
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
